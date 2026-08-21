import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { DiscoveredPolymarketMarket, MarketEvent } from '../domain/types.js';
import { PairOpportunityScanner } from '../scan/pair-opportunity.js';

interface MetadataSnapshot {
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
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid --${name}: ${raw}`);
  }
  return values;
}

function isMarketEvent(value: unknown): value is MarketEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<MarketEvent>;
  return (
    (event.venue === 'binance' || event.venue === 'polymarket') &&
    typeof event.kind === 'string' &&
    typeof event.instrument === 'string' &&
    typeof event.eventTimeMs === 'number' &&
    typeof event.receivedTimeMs === 'number'
  );
}

function usage(): never {
  throw new Error(
    'Usage: npm run pairscan -- <events.jsonl> <markets.json> [output.json] ' +
    '[--fee-rate=<explicit-research-assumption>] [--shares=1] [--min-edge=0.015] ' +
    '[--thresholds-ms=100,250,500,1000,2000] [--latency-ms=100,250,500,1000]',
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const [eventArg, metadataArg, outputArg] = positional;
  if (!eventArg || !metadataArg) usage();

  const eventPath = resolve(eventArg);
  const metadataPath = resolve(metadataArg);
  const outputPath = resolve(outputArg ?? './data/pair-opportunity-scan.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as MetadataSnapshot;
  const markets = metadata.markets ?? [];
  if (markets.length === 0) throw new Error('Metadata snapshot contains no markets.');

  const feeRate = numberFlag(args, 'fee-rate');
  const shares = numberFlag(args, 'shares') ?? 1;
  const minEdge = numberFlag(args, 'min-edge') ?? 0.015;
  const thresholds = listNumberFlag(args, 'thresholds-ms');
  const latencyMilestones = listNumberFlag(args, 'latency-ms');

  const scanner = new PairOpportunityScanner(markets, {
    fallbackPlatformFeeRate: feeRate,
    shares,
    minLockedReturnOnCost: minEdge,
    freshnessThresholdsMs: thresholds,
    latencyMilestonesMs: latencyMilestones,
  });

  const input = createReadStream(eventPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let linesSeen = 0;
  let invalidLines = 0;
  for await (const line of lines) {
    linesSeen += 1;
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isMarketEvent(parsed)) {
        invalidLines += 1;
        continue;
      }
      scanner.apply(parsed);
    } catch (error) {
      if (error instanceof SyntaxError) {
        invalidLines += 1;
        continue;
      }
      throw error;
    }
  }

  const report = scanner.finish();
  const payload = {
    generatedAt: new Date().toISOString(),
    mode: report.mode,
    source: {
      eventPath,
      metadataPath,
      linesSeen,
      invalidLines,
      warning: 'Historical top-only data can show quote persistence, not guaranteed live fill. No live execution is performed.',
    },
    report,
  };
  await writeFile(outputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log(`[pairscan] mode=${report.mode}`);
  console.log(`[pairscan] markets=${report.marketsEligible} events=${report.eventsSeen} polymarket=${report.polymarketEventsSeen} relevant_pm=${report.relevantPolymarketEvents}`);
  console.log(`[pairscan] shares=${report.shares} min_edge=${(report.minLockedReturnOnCost * 100).toFixed(2)}% fee_rate=${report.fallbackPlatformFeeRate ?? 'metadata-only'}`);
  if (report.topOnlyHistoricalEvents > 0) {
    console.log(`[pairscan] historical_top_only_events=${report.topOnlyHistoricalEvents} depth_claim=TOP_ONLY_BOUNDED`);
  }
  for (const row of report.thresholds) {
    const persistence = report.latencyMilestonesMs.map((ms) => `${ms}ms:${row.survivesLatencyMs[String(ms)] ?? 0}`).join(' ');
    console.log(
      `[pairscan] freshness=${String(row.thresholdMs).padStart(4)}ms snapshots=${String(row.qualifyingSnapshots).padStart(5)} ` +
      `episodes=${String(row.episodes).padStart(4)} markets=${String(row.uniqueMarkets).padStart(3)} ` +
      `total_ms=${String(row.totalOpportunityMs).padStart(7)} longest_ms=${String(row.longestEpisodeMs).padStart(5)} ` +
      `best_roi=${(row.bestLockedReturnOnCost * 100).toFixed(2)}% survives=[${persistence}]`,
    );
  }
  const strict = report.thresholds.find((row) => row.thresholdMs === 500);
  if (strict) {
    const verdict = strict.episodes === 0 ? 'NO_EVENT_DRIVEN_PAIR_EDGE_AT_500MS' : 'PAIR_EDGE_EXISTS_REQUIRES_LATENCY_SLIPPAGE_VALIDATION';
    console.log(`[pairscan] strict500_verdict=${verdict}`);
  }
  console.log(`[pairscan] report=${outputPath}`);
}

void main().catch((error) => {
  console.error('[pairscan] failed', error);
  process.exitCode = 1;
});
