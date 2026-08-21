import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DiscoveredPolymarketMarket } from '../domain/types.js';
import { loadMarketEventsJsonl } from '../replay/jsonl-loader.js';
import { getQuotePreset, strategyDataDependencies } from '../policy/quote-policy.js';
import { runShadowReplay, type ShadowProbabilityArtifact, type ShadowStrategy } from '../shadow/replay-trader.js';

interface MetadataSnapshot {
  markets?: DiscoveredPolymarketMarket[];
  provenance?: unknown;
}

interface TrainingReport {
  baseline?: ShadowProbabilityArtifact;
  split?: {
    testConditions?: string[];
  };
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
  const values = raw.split(',').map(Number).filter(Number.isFinite);
  if (values.length === 0) throw new Error(`Invalid --${name}: ${raw}`);
  return values;
}

function stringFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function strategyFlag(args: string[]): ShadowStrategy {
  const value = stringFlag(args, 'strategy') ?? 'model';
  if (value === 'model' || value === 'market-control' || value === 'pair-arb') return value;
  throw new Error(`Invalid --strategy: ${value}`);
}

function quotePreset(args: string[]) {
  return getQuotePreset(stringFlag(args, 'quote-preset'));
}

function usage(): never {
  throw new Error(
    'Usage: npm run shadow -- <events.jsonl> <markets.json> <probability-report.json> [output.json] ' +
    '[--fee-rate=<explicit-research-assumption>] [--min-edge=0.015] [--target-shares=1] [--max-adjustment=1] ' +
    '[--decision-seconds=120,60,30,15] [--strategy=model|market-control|pair-arb] ' +
    '[--quote-preset=strict|legacy] [--max-binance-age-ms=500] [--max-pm-age-ms=500] ' +
    '[--max-pm-skew-ms=500] [--all-markets]',
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const [eventPath, metadataPath, reportPath, outputArg] = positional;
  if (!eventPath || !metadataPath || !reportPath) usage();
  const outputPath = resolve(outputArg ?? './data/shadow-report.json');

  const [{ events, stats }, metadataText, reportText] = await Promise.all([
    loadMarketEventsJsonl(resolve(eventPath)),
    readFile(resolve(metadataPath), 'utf8'),
    readFile(resolve(reportPath), 'utf8'),
  ]);
  const metadata = JSON.parse(metadataText) as MetadataSnapshot;
  const training = JSON.parse(reportText) as TrainingReport;
  const markets = metadata.markets ?? [];
  if (markets.length === 0) throw new Error('Metadata snapshot contains no markets.');
  if (!training.baseline?.model || !training.baseline?.calibrator) {
    throw new Error('Probability report does not contain baseline.model + baseline.calibrator.');
  }

  const allMarkets = args.includes('--all-markets');
  const testConditions = training.split?.testConditions ?? [];
  if (!allMarkets && testConditions.length === 0) {
    throw new Error('Probability report has no testConditions. Re-run npm run train with FluxQuant >=0.5 or use --all-markets explicitly.');
  }

  const fallbackPlatformFeeRate = numberFlag(args, 'fee-rate');
  if (fallbackPlatformFeeRate !== undefined && fallbackPlatformFeeRate < 0) {
    throw new Error('--fee-rate must be >= 0');
  }

  const strategy = strategyFlag(args);
  const preset = quotePreset(args);
  const dependencies = strategyDataDependencies(strategy);
  const maxBinanceBookAgeMs = numberFlag(args, 'max-binance-age-ms') ?? preset.maxBinanceBookAgeMs;
  const maxPolymarketBookAgeMs = numberFlag(args, 'max-pm-age-ms') ?? preset.maxPolymarketBookAgeMs;
  const maxCrossOutcomeQuoteSkewMs = numberFlag(args, 'max-pm-skew-ms') ?? preset.maxCrossOutcomeQuoteSkewMs;

  const report = runShadowReplay(events, markets, training.baseline, {
    conditionAllowlist: allMarkets ? undefined : new Set(testConditions),
    fallbackPlatformFeeRate,
    minExpectedReturn: numberFlag(args, 'min-edge'),
    targetExposureShares: numberFlag(args, 'target-shares'),
    maxAdjustmentShares: numberFlag(args, 'max-adjustment'),
    decisionSecondsToExpiry: listNumberFlag(args, 'decision-seconds'),
    strategy,
    maxBinanceBookAgeMs,
    maxPolymarketBookAgeMs,
    maxCrossOutcomeQuoteSkewMs,
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    mode: 'SHADOW_ONLY',
    source: {
      eventPath: resolve(eventPath),
      metadataPath: resolve(metadataPath),
      probabilityReportPath: resolve(reportPath),
      eventLoadStats: stats,
      marketScope: allMarkets ? 'all-markets-explicit' : 'out-of-sample-test-conditions',
      fallbackPlatformFeeRate: fallbackPlatformFeeRate ?? null,
      strategy,
      strategyDataDependencies: dependencies,
      quotePreset: preset.name,
      quotePolicy: { maxBinanceBookAgeMs, maxPolymarketBookAgeMs, maxCrossOutcomeQuoteSkewMs },
      warning: fallbackPlatformFeeRate === undefined
        ? 'No fallback fee assumption supplied; markets without fee metadata fail closed.'
        : 'Explicit research-only fee-rate assumption supplied by CLI; it is not silently inferred.',
    },
    report,
  };
  await writeFile(outputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`[shadow] strategy=${strategy} quote=${preset.name} max_age=${maxPolymarketBookAgeMs}ms max_skew=${maxCrossOutcomeQuoteSkewMs}ms`);
  console.log(`[shadow] settled=${report.summary.marketsSettled}/${report.summary.marketsEligible} trades=${report.summary.trades}`);
  console.log(`[shadow] pnl=$${report.summary.netPnlUsd.toFixed(4)} fees=$${report.summary.feesUsd.toFixed(4)} roi=${(report.summary.roiOnCost * 100).toFixed(2)}%`);
  console.log(`[shadow] max cumulative drawdown=$${report.summary.maxCumulativeDrawdownUsd.toFixed(4)}`);
  console.log(`[shadow] roles entry=${report.summary.directionalEntryTrades} sequential_hedge=${report.summary.sequentialHedgeTrades} pair_legs=${report.summary.pairArbLegTrades}`);
  console.log(`[shadow] quote_skips missing_binance=${report.summary.skippedMissingBinanceFrame} missing_pm=${report.summary.skippedMissingPolymarketFrame} stale_binance=${report.summary.skippedStaleBinance} stale_pm=${report.summary.skippedStalePolymarket} skew=${report.summary.skippedCrossOutcomeSkew}`);
  console.log(`[shadow] report=${outputPath}`);
}

void main().catch((error) => {
  console.error('[shadow] failed', error);
  process.exitCode = 1;
});
