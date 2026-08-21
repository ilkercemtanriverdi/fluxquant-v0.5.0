import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DiscoveredPolymarketMarket, PolymarketTokenMetadata } from '../domain/types.js';
import { buildUpDownDataset, splitDatasetChronologicallyByMarket } from '../dataset/updown-dataset.js';
import { loadMarketEventsJsonl } from '../replay/jsonl-loader.js';
import { buildProbabilityBaselineReport } from '../model/research-report.js';

interface MetadataSnapshot {
  markets?: DiscoveredPolymarketMarket[];
  provenance?: { source?: string };
}

const OPENMARKET_SOURCE = 'gregyoung14/openmarket-btc-polymarket';

const OPENMARKET_ARCHIVE_PROFILE = {
  // Unified Parquet is event-driven. A quote remains the last known top until the next update;
  // strict live-feed freshness limits (2s/5s) discard almost the entire sparse archive.
  sampleSecondsToExpiry: [300, 240, 180, 120, 90, 60, 45, 30, 15],
  maxBinanceBookAgeMs: 30_000,
  maxPolymarketBookAgeMs: 60_000,
  maxCrossOutcomeQuoteSkewMs: 60_000,
  labelPriceToleranceMs: 30_000,
};

function usage(): never {
  throw new Error('Usage: npm run train -- <events.jsonl> <polymarket-markets.json> [report.json]');
}

async function main(): Promise<void> {
  const eventPath = process.argv[2];
  const metadataPath = process.argv[3];
  if (!eventPath || !metadataPath) usage();
  const outputPath = resolve(process.argv[4] ?? './data/probability-baseline-report.json');

  const [{ events, stats }, metadataText] = await Promise.all([
    loadMarketEventsJsonl(resolve(eventPath)),
    readFile(resolve(metadataPath), 'utf8'),
  ]);
  const snapshot = JSON.parse(metadataText) as MetadataSnapshot;
  const tokens: PolymarketTokenMetadata[] = (snapshot.markets ?? []).flatMap((market) => market.tokens ?? []);
  if (tokens.length === 0) throw new Error('Metadata snapshot contains no Polymarket token metadata.');

  const resolvedOutcomeByCondition = new Map<string, 'UP' | 'DOWN'>();
  for (const market of snapshot.markets ?? []) {
    if (market.resolvedOutcome) resolvedOutcomeByCondition.set(market.conditionId, market.resolvedOutcome);
  }

  const isOpenMarketArchive = snapshot.provenance?.source === OPENMARKET_SOURCE;
  const dataset = buildUpDownDataset(events, tokens, {
    resolvedOutcomeByCondition,
    ...(isOpenMarketArchive ? OPENMARKET_ARCHIVE_PROFILE : {}),
  });
  const distinctMarkets = new Set(dataset.rows.map((row) => row.frame.conditionId)).size;
  const profile = isOpenMarketArchive ? 'openmarket_archive' : 'default_live_freshness';
  console.log(`[train] dataset rows=${dataset.rows.length} distinct_markets=${distinctMarkets} profile=${profile} stats=${JSON.stringify(dataset.stats)}`);
  if (dataset.rows.length === 0) {
    throw new Error(`No training rows produced. Dataset stats: ${JSON.stringify(dataset.stats)}`);
  }
  if (distinctMarkets < 3) {
    throw new Error(`Only ${distinctMarkets} distinct markets produced usable frames. Dataset stats: ${JSON.stringify(dataset.stats)}`);
  }
  const split = splitDatasetChronologicallyByMarket(dataset.rows);
  const baseline = buildProbabilityBaselineReport(split);

  const report = {
    generatedAt: new Date().toISOString(),
    source: {
      eventPath: resolve(eventPath),
      metadataPath: resolve(metadataPath),
      eventLoadStats: stats,
      labelSources: [...new Set(dataset.rows.map((row) => row.labelSource))],
      warning: resolvedOutcomeByCondition.size > 0
        ? 'Authoritative Polymarket resolved_outcome is preferred when available; Binance start/end labels are only a fallback.'
        : 'Binance start/end prices are a research proxy, not authoritative Polymarket resolution labels.',
    },
    dataset: {
      stats: dataset.stats,
      rows: dataset.rows.length,
      trainRows: split.train.length,
      validationRows: split.validation.length,
      testRows: split.test.length,
      trainMarkets: split.trainConditions.length,
      validationMarkets: split.validationConditions.length,
      testMarkets: split.testConditions.length,
    },
    split: {
      trainConditions: split.trainConditions,
      validationConditions: split.validationConditions,
      testConditions: split.testConditions,
    },
    baseline,
  };

  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`[train] rows=${dataset.rows.length} markets=${dataset.stats.marketsLabeled}`);
  console.log(`[train] test calibrated brier=${baseline.test.calibratedModel.brierScore.toFixed(6)} logloss=${baseline.test.calibratedModel.logLoss.toFixed(6)}`);
  console.log(`[train] test market brier=${baseline.test.marketBaseline.brierScore.toFixed(6)} logloss=${baseline.test.marketBaseline.logLoss.toFixed(6)}`);
  console.log(`[train] report=${outputPath}`);
}

void main().catch((error) => {
  console.error('[train] failed', error);
  process.exitCode = 1;
});
