import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { DiscoveredPolymarketMarket, MarketEvent } from '../domain/types.js';
import { PairExecutionValidator } from '../scan/pair-execution-validator.js';

interface MetadataSnapshot {
  provenance?: Record<string, unknown>;
  markets?: DiscoveredPolymarketMarket[];
}

function numberFlag(args: string[], name: string): number | undefined {
  const prefix = `--${name}=`;
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid --${name}: ${raw}`);
  return value;
}

function listNumberFlag(args: string[], name: string): number[] | undefined {
  const prefix = `--${name}=`;
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) return undefined;
  const values = raw.split(',').map(Number);
  if (values.length === 0 || values.some((v) => !Number.isFinite(v))) throw new Error(`Invalid --${name}: ${raw}`);
  return values;
}

function boolFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function isMarketEvent(value: unknown): value is MarketEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<MarketEvent>;
  return (e.venue === 'polymarket' || e.venue === 'binance') && typeof e.instrument === 'string' &&
    typeof e.eventTimeMs === 'number' && typeof e.receivedTimeMs === 'number' && typeof e.kind === 'string';
}

function pct(value: number): string { return `${(value * 100).toFixed(2)}%`; }
function money(value: number): string { return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(4)}`; }

function usage(): never {
  throw new Error(
    'Usage: npm run pairvalidate -- <events.jsonl> <markets.json> [output.json] ' +
    '[--fee-rate=<explicit-research-assumption>] [--shares=5] [--min-edge=0.015] [--freshness-ms=500] ' +
    '[--latency-ms=100,250] [--slippage=0.01,0.02] ' +
    '[--assume-min-order-size=5] [--assume-tick-size=0.01] [--require-market-rules] [--allow-top-only]',
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const [eventArg, metadataArg, outputArg] = positional;
  if (!eventArg || !metadataArg) usage();

  const eventPath = resolve(eventArg);
  const metadataPath = resolve(metadataArg);
  const outputPath = resolve(outputArg ?? './data/pair-execution-validation.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as MetadataSnapshot;
  const markets = metadata.markets ?? [];
  if (markets.length === 0) throw new Error('Metadata snapshot contains no markets.');

  const tokenIds = new Set(markets.flatMap((m) => m.tokens.map((t) => t.tokenId)));
  const validator = new PairExecutionValidator(markets, {
    fallbackPlatformFeeRate: numberFlag(args, 'fee-rate'),
    shares: numberFlag(args, 'shares') ?? 5,
    minLockedReturnOnCost: numberFlag(args, 'min-edge') ?? 0.015,
    freshnessMs: numberFlag(args, 'freshness-ms') ?? 500,
    latenciesMs: listNumberFlag(args, 'latency-ms'),
    slippagePerLeg: listNumberFlag(args, 'slippage'),
    oneFillPerMarket: true,
    allowTopOnlyHistorical: boolFlag(args, 'allow-top-only'),
    assumedMinOrderSize: numberFlag(args, 'assume-min-order-size'),
    assumedTickSize: numberFlag(args, 'assume-tick-size'),
    requireMarketRules: boolFlag(args, 'require-market-rules'),
  });

  let linesSeen = 0;
  let invalidLines = 0;
  let relevantEvents = 0;
  let currentReceivedTimeMs: number | undefined;
  let batch: MarketEvent[] = [];

  const flushBatch = () => {
    if (currentReceivedTimeMs === undefined || batch.length === 0) return;
    validator.applyReceivedBatch(currentReceivedTimeMs, batch);
    batch = [];
  };

  const input = createReadStream(eventPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    linesSeen += 1;
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isMarketEvent(parsed)) {
        invalidLines += 1;
        continue;
      }
      if (parsed.venue !== 'polymarket' || !tokenIds.has(parsed.instrument)) continue;

      relevantEvents += 1;
      const ts = parsed.receivedTimeMs;
      if (currentReceivedTimeMs === undefined) {
        currentReceivedTimeMs = ts;
      } else if (ts < currentReceivedTimeMs) {
        throw new Error(
          `NON_MONOTONIC_RECEIVED_TIME: ${ts} < ${currentReceivedTimeMs}. ` +
          'Pair-validation input must be exported in received-time order.',
        );
      } else if (ts !== currentReceivedTimeMs) {
        flushBatch();
        currentReceivedTimeMs = ts;
      }
      batch.push(parsed);
    } catch (error) {
      if (error instanceof SyntaxError) {
        invalidLines += 1;
        continue;
      }
      throw error;
    }
  }
  flushBatch();

  const report = validator.finish();
  const payload = {
    generatedAt: new Date().toISOString(),
    source: { eventPath, metadataPath, linesSeen, invalidLines, relevantEvents, provenance: metadata.provenance },
    report,
  };
  await writeFile(outputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`[pairvalidate] mode=${report.mode}`);
  console.log(`[pairvalidate] evidence=${report.evidenceClass} markets=${report.marketsEligible} relevant_events=${relevantEvents} accepted=${report.eventsAccepted} stale_arrivals=${report.staleArrivalDrops}`);
  console.log(`[pairvalidate] l2 reconstructed=${report.reconstructedL2Events} live=${report.liveL2Events} top_only=${report.topOnlyHistoricalEvents}`);
  console.log(`[pairvalidate] freshness=${report.freshnessMs}ms shares=${report.shares} min_edge=${pct(report.minLockedReturnOnCost)} detection_attempts=${report.detectionAttempts.length}`);
  console.log(`[pairvalidate] market_rules require=${report.requireMarketRules} assumed_mos=${report.assumedMinOrderSize ?? 'none'} assumed_tick=${report.assumedTickSize ?? 'none'}`);
  console.log('[pairvalidate] clock=RECEIVED_TIME same_timestamp=BATCHED one_fill_per_market=YES fee_precision=5dp');
  for (const row of report.scenarios) {
    console.log(
      `[pairvalidate] latency=${String(row.latencyMs).padStart(3)}ms slip_leg=${row.slippagePerLeg.toFixed(3)} ` +
      `exec=${String(row.executed).padStart(3)} markets=${String(row.uniqueMarketsExecuted).padStart(3)} ` +
      `pnl=${money(row.lockedPnlUsd)} roi=${pct(row.roi)} median=${pct(row.medianLockedReturnOnCost)} ` +
      `reject_stale=${row.rejected.STALE_QUOTE} reject_depth=${row.rejected.INSUFFICIENT_DEPTH + row.rejected.UNTRUSTED_DEPTH} ` +
      `reject_rules=${row.rejected.MARKET_RULES_UNKNOWN + row.rejected.BELOW_MIN_ORDER} reject_edge=${row.rejected.EDGE_DECAYED}`,
    );
  }

  const key = report.scenarios.find((row) => row.latencyMs === 100 && Math.abs(row.slippagePerLeg - 0.01) < 1e-12);
  let verdict = 'REFERENCE_SCENARIO_NOT_RUN';
  if (report.evidenceClass === 'TOP_ONLY_UNTRUSTED') verdict = 'INVALID_FOR_EXECUTABLE_PNL_TOP_ONLY_DEPTH';
  else if (key) {
    verdict = key.executed === 0
      ? 'NO_SURVIVING_EDGE_AT_100MS_PLUS_1C_PER_LEG'
      : key.roi > 0
        ? report.evidenceClass === 'LIVE_L2'
          ? 'LIVE_PAPER_EDGE_CANDIDATE_NOT_REAL_MONEY_APPROVAL'
          : 'HISTORICAL_RECONSTRUCTED_L2_CANDIDATE_NOT_LIVE_PROOF'
        : 'NON_POSITIVE_AFTER_EXECUTION_STRESS';
  }
  console.log(`[pairvalidate] reference_100ms_1c_verdict=${verdict}`);
  console.log('[pairvalidate] real_money_gate=NO_GO (historical validation alone can never open live execution)');
  console.log(`[pairvalidate] report=${outputPath}`);
}

void main().catch((error) => {
  console.error('[pairvalidate] failed', error);
  process.exitCode = 1;
});
