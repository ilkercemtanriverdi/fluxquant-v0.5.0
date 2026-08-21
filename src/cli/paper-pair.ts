import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MarketBus } from '../core/market-bus.js';
import type { MarketEvent } from '../domain/types.js';
import { buildTokenMetadataMap, discoverShortHorizonCryptoMarkets } from '../discovery/polymarket-gamma.js';
import { PolymarketFeed } from '../feeds/polymarket.js';
import { probePolymarketConnectivity } from '../network/polymarket-connectivity.js';
import { probePolymarketGeoblock } from '../network/polymarket-eligibility.js';
import { JsonlRecorder } from '../recording/jsonl-recorder.js';
import { PairExecutionValidator } from '../scan/pair-execution-validator.js';

function numberFlag(args: string[], name: string): number | undefined {
  const prefix = `--${name}=`;
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid --${name}: ${raw}`);
  return value;
}

function stringFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function scenario(report: ReturnType<PairExecutionValidator['finish']>, latencyMs: number, slippage: number) {
  return report.scenarios.find((x) => x.latencyMs === latencyMs && Math.abs(x.slippagePerLeg - slippage) < 1e-12);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const seconds = Math.max(5, Math.round(numberFlag(args, 'seconds') ?? 600));
  const shares = numberFlag(args, 'shares') ?? 5;
  const minEdge = numberFlag(args, 'min-edge') ?? 0.015;
  const freshnessMs = numberFlag(args, 'freshness-ms') ?? 500;
  const outputDir = resolve(stringFlag(args, 'output-dir') ?? './data/live-paper-pair');
  await mkdir(outputDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const connectivity = await probePolymarketConnectivity();
  const geoblock = await probePolymarketGeoblock();

  if (connectivity.state !== 'AVAILABLE' || geoblock.state !== 'ELIGIBLE') {
    const blocked = {
      mode: 'READ_ONLY_LIVE_PAPER',
      startedAt,
      durationRequestedSeconds: seconds,
      connectivity,
      geoblock,
      livePaperGate: 'NO_GO_NETWORK_OR_GEO',
      realMoneyGate: 'NO_GO',
      reason: 'FluxQuant will not bypass a network block, unavailable official endpoint, or geographic restriction.',
    };
    await writeFile(resolve(outputDir, 'paper-gate.json'), JSON.stringify(blocked, null, 2) + '\n', 'utf8');
    console.log('[paper] livePaperGate=NO_GO_NETWORK_OR_GEO');
    console.log(`[paper] connectivity=${connectivity.state} geoblock=${geoblock.state}`);
    console.log('[paper] real_money_gate=NO_GO');
    process.exitCode = 2;
    return;
  }

  const discovered = await discoverShortHorizonCryptoMarkets({
    symbols: ['BTC'],
    horizonMinutes: 180,
    includeFees: true,
  });
  const markets = discovered.filter((market) => {
    const slug15m = /btc-updown-15m-/i.test(market.slug);
    const rules = market.minOrderSize !== undefined && market.tickSize !== undefined;
    const fees = market.tokens.every((token) => token.platformFeeRate !== undefined);
    return slug15m && rules && fees;
  });

  if (markets.length === 0) {
    const blocked = {
      mode: 'READ_ONLY_LIVE_PAPER', startedAt, connectivity, geoblock,
      discoveredMarkets: discovered.length, eligibleMarkets: 0,
      livePaperGate: 'NO_GO_NO_ELIGIBLE_V2_MARKETS', realMoneyGate: 'NO_GO',
      reason: 'No BTC 15m Up/Down market had complete current CLOB fee/tick/min-size metadata.',
    };
    await writeFile(resolve(outputDir, 'paper-gate.json'), JSON.stringify(blocked, null, 2) + '\n', 'utf8');
    console.log('[paper] livePaperGate=NO_GO_NO_ELIGIBLE_V2_MARKETS');
    console.log('[paper] real_money_gate=NO_GO');
    process.exitCode = 2;
    return;
  }

  const metadataPath = resolve(outputDir, `markets-${Date.now()}.json`);
  const eventPath = resolve(outputDir, `events-${Date.now()}.jsonl`);
  const reportPath = resolve(outputDir, `report-${Date.now()}.json`);
  await writeFile(metadataPath, JSON.stringify({ generatedAt: new Date().toISOString(), regime: 'CLOB_V2_LIVE', markets }, null, 2) + '\n', 'utf8');

  const validator = new PairExecutionValidator(markets, {
    shares,
    minLockedReturnOnCost: minEdge,
    freshnessMs,
    latenciesMs: [100, 250],
    slippagePerLeg: [0.01, 0.02],
    oneFillPerMarket: true,
    allowTopOnlyHistorical: false,
    requireMarketRules: true,
  });
  const recorder = new JsonlRecorder(eventPath);
  const bus = new MarketBus();
  const metadataByToken = buildTokenMetadataMap(markets);
  const feed = new PolymarketFeed(bus, [...metadataByToken.keys()], metadataByToken);

  let currentReceivedTimeMs: number | undefined;
  let batch: MarketEvent[] = [];
  let eventCount = 0;
  let recorderError: Error | undefined;

  const flush = () => {
    if (currentReceivedTimeMs === undefined || batch.length === 0) return;
    validator.applyReceivedBatch(currentReceivedTimeMs, batch);
    batch = [];
  };

  const unsubscribe = bus.subscribe((event) => {
    eventCount += 1;
    void recorder.record(event).catch((error) => {
      if (!recorderError) recorderError = error instanceof Error ? error : new Error(String(error));
    });
    const ts = event.receivedTimeMs;
    if (currentReceivedTimeMs === undefined) currentReceivedTimeMs = ts;
    else if (ts < currentReceivedTimeMs) throw new Error('LIVE_RECEIVED_TIME_ORDER_VIOLATION');
    else if (ts !== currentReceivedTimeMs) {
      flush();
      currentReceivedTimeMs = ts;
    }
    batch.push(event);
  });

  console.log(`[paper] mode=READ_ONLY_LIVE_CLOB_V2 duration=${seconds}s markets=${markets.length} shares=${shares}`);
  console.log(`[paper] recording=${eventPath}`);
  feed.start();
  await new Promise<void>((resolveTimer) => setTimeout(resolveTimer, seconds * 1000));
  feed.stop();
  unsubscribe();
  flush();
  await recorder.close();
  if (recorderError) throw recorderError;

  const report = validator.finish();
  const reference = scenario(report, 100, 0.01);
  const harsh = scenario(report, 250, 0.02);
  const livePaperGate =
    report.evidenceClass === 'LIVE_L2' &&
    (reference?.executed ?? 0) > 0 && (reference?.lockedPnlUsd ?? 0) > 0 &&
    (harsh?.executed ?? 0) > 0 && (harsh?.lockedPnlUsd ?? 0) > 0
      ? 'SURVIVING_EDGE_LIVE_PAPER_CANDIDATE'
      : 'NO_SURVIVING_EDGE_OR_INSUFFICIENT_PAPER';

  const payload = {
    generatedAt: new Date().toISOString(),
    startedAt,
    durationSeconds: seconds,
    connectivity,
    geoblock,
    eventCount,
    metadataPath,
    eventPath,
    report,
    reference100ms1c: reference,
    harsh250ms2c: harsh,
    livePaperGate,
    realMoneyGate: 'NO_GO',
    realMoneyBlockers: [
      'A short live-paper capture is not enough statistical evidence.',
      'Two FOK orders are independent order responses; cross-leg atomic fill is not assumed.',
      'Order-ack/fill/orphan-leg risk must be measured with a dedicated non-money execution harness before live approval.',
      'Multi-session/day stability and concentration gates must pass before any capital is authorized.',
    ],
  };
  await writeFile(reportPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`[paper] events=${eventCount} evidence=${report.evidenceClass} attempts=${report.detectionAttempts.length}`);
  if (reference) console.log(`[paper] ref_100ms_1c exec=${reference.executed} pnl=$${reference.lockedPnlUsd.toFixed(4)} roi=${(reference.roi * 100).toFixed(2)}%`);
  if (harsh) console.log(`[paper] harsh_250ms_2c exec=${harsh.executed} pnl=$${harsh.lockedPnlUsd.toFixed(4)} roi=${(harsh.roi * 100).toFixed(2)}%`);
  console.log(`[paper] live_paper_gate=${livePaperGate}`);
  console.log('[paper] real_money_gate=NO_GO');
  console.log(`[paper] report=${reportPath}`);
}

void main().catch((error) => {
  console.error('[paper] failed', error);
  process.exitCode = 1;
});
