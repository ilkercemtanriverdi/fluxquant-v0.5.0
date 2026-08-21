import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { DiscoveredPolymarketMarket } from '../domain/types.js';
import { aggregateShadowSuite, type ShadowSuiteRunResult } from '../experiment/shadow-suite.js';
import { getQuotePreset, strategyDataDependencies, type QuotePresetName } from '../policy/quote-policy.js';
import { loadMarketEventsJsonl } from '../replay/jsonl-loader.js';
import { renderShadowSuiteHtml } from '../report/shadow-suite-html.js';
import { runShadowReplay, type ShadowProbabilityArtifact, type ShadowStrategy } from '../shadow/replay-trader.js';

interface TrainingReport {
  baseline?: ShadowProbabilityArtifact;
  split?: { testConditions?: string[] };
}

interface MetadataSnapshot {
  markets?: DiscoveredPolymarketMarket[];
  provenance?: unknown;
}

interface SuiteDataRun {
  id?: string;
  date: string;
  events: string;
  markets: string;
}

interface SuiteConfig {
  name?: string;
  probabilityReport: string;
  outputDir?: string;
  quotePreset?: QuotePresetName;
  feeRate?: number;
  minEdge?: number;
  targetShares?: number;
  maxAdjustment?: number;
  probeShares?: number;
  decisionSeconds?: number[];
  allMarkets?: boolean;
  strategies?: ShadowStrategy[];
  runs: SuiteDataRun[];
}

function usage(): never {
  throw new Error('Usage: npm run suite -- <suite-config.json>');
}

function validateStrategy(value: unknown): value is ShadowStrategy {
  return value === 'model' || value === 'market-control' || value === 'pair-arb';
}

function validateConfig(value: unknown): SuiteConfig {
  if (!value || typeof value !== 'object') throw new Error('Suite config must be a JSON object.');
  const config = value as Partial<SuiteConfig>;
  if (!config.probabilityReport || typeof config.probabilityReport !== 'string') {
    throw new Error('Suite config requires probabilityReport.');
  }
  if (!Array.isArray(config.runs) || config.runs.length === 0) throw new Error('Suite config requires at least one run.');
  for (const [index, run] of config.runs.entries()) {
    if (!run || typeof run.date !== 'string' || typeof run.events !== 'string' || typeof run.markets !== 'string') {
      throw new Error(`Invalid runs[${index}]. Expected date/events/markets strings.`);
    }
  }
  if (config.strategies && (!Array.isArray(config.strategies) || config.strategies.some((item) => !validateStrategy(item)))) {
    throw new Error('strategies must contain only model, market-control, pair-arb.');
  }
  for (const [name, number] of [
    ['feeRate', config.feeRate],
    ['minEdge', config.minEdge],
    ['targetShares', config.targetShares],
    ['maxAdjustment', config.maxAdjustment],
    ['probeShares', config.probeShares],
  ] as const) {
    if (number !== undefined && (!Number.isFinite(number) || number < 0)) throw new Error(`${name} must be a non-negative finite number.`);
  }
  return config as SuiteConfig;
}

async function main(): Promise<void> {
  const configArg = process.argv[2];
  if (!configArg) usage();
  const configPath = resolve(configArg);
  const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')) as unknown);
  const title = config.name ?? 'FluxQuant Shadow Suite';
  const outputDir = resolve(config.outputDir ?? './data/fluxquant-suite');
  const probabilityReportPath = resolve(config.probabilityReport);
  const training = JSON.parse(await readFile(probabilityReportPath, 'utf8')) as TrainingReport;
  if (!training.baseline?.model || !training.baseline?.calibrator) {
    throw new Error('probabilityReport does not contain baseline.model + baseline.calibrator.');
  }

  const strategies = config.strategies ?? ['model', 'market-control', 'pair-arb'];
  const quote = getQuotePreset(config.quotePreset);
  const allMarkets = config.allMarkets ?? false;
  const testConditions = training.split?.testConditions ?? [];
  if (!allMarkets && testConditions.length === 0) throw new Error('No testConditions in probability report; set allMarkets=true explicitly if intended.');
  if (config.feeRate === undefined) throw new Error('Suite config requires explicit feeRate for historical research; FluxQuant never invents one.');

  await mkdir(outputDir, { recursive: true });
  const results: ShadowSuiteRunResult[] = [];

  console.log(`[suite] ${title}`);
  console.log(`[suite] mode=RESEARCH_SHADOW_ONLY quote=${quote.name} fee_rate=${config.feeRate}`);

  for (const run of config.runs) {
    const eventPath = resolve(run.events);
    const metadataPath = resolve(run.markets);
    const [{ events, stats }, metadataText] = await Promise.all([
      loadMarketEventsJsonl(eventPath),
      readFile(metadataPath, 'utf8'),
    ]);
    const metadata = JSON.parse(metadataText) as MetadataSnapshot;
    const markets = metadata.markets ?? [];
    if (markets.length === 0) throw new Error(`${run.date}: metadata contains no markets.`);
    if (stats.invalidLines > 0) console.warn(`[suite] ${run.date}: ignored ${stats.invalidLines} invalid JSONL lines.`);

    for (const strategy of strategies) {
      const report = runShadowReplay(events, markets, training.baseline, {
        conditionAllowlist: allMarkets ? undefined : new Set(testConditions),
        fallbackPlatformFeeRate: config.feeRate,
        minExpectedReturn: config.minEdge ?? 0.015,
        targetExposureShares: config.targetShares ?? 1,
        maxAdjustmentShares: config.maxAdjustment ?? 1,
        probeShares: config.probeShares,
        decisionSecondsToExpiry: config.decisionSeconds,
        strategy,
        maxBinanceBookAgeMs: quote.maxBinanceBookAgeMs,
        maxPolymarketBookAgeMs: quote.maxPolymarketBookAgeMs,
        maxCrossOutcomeQuoteSkewMs: quote.maxCrossOutcomeQuoteSkewMs,
      });
      const id = run.id ?? run.date;
      const detailPath = resolve(outputDir, `${id}-${strategy}.json`);
      await writeFile(detailPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        mode: 'RESEARCH_SHADOW_ONLY',
        source: {
          date: run.date,
          eventPath,
          metadataPath,
          probabilityReportPath,
          strategy,
          strategyDataDependencies: strategyDataDependencies(strategy),
          quotePolicy: quote,
          explicitHistoricalFeeRate: config.feeRate,
          marketScope: allMarkets ? 'all-markets-explicit' : 'training-report-test-conditions',
        },
        report,
      }, null, 2) + '\n', 'utf8');

      results.push({ id, date: run.date, strategy, report, eventPath, metadataPath });
      console.log(
        `[suite] ${run.date} ${strategy.padEnd(14)} trades=${String(report.summary.trades).padStart(3)} ` +
        `pnl=$${report.summary.netPnlUsd.toFixed(4)} fees=$${report.summary.feesUsd.toFixed(4)} ` +
        `roi=${(report.summary.roiOnCost * 100).toFixed(2)}%`,
      );
    }
  }

  const aggregate = aggregateShadowSuite(results);
  const payload = {
    title,
    config: {
      ...config,
      probabilityReport: probabilityReportPath,
      outputDir,
      quotePolicy: quote,
      mode: 'RESEARCH_SHADOW_ONLY',
      liveExecution: false,
    },
    aggregate,
  };
  const jsonPath = resolve(outputDir, 'suite-report.json');
  const htmlPath = resolve(outputDir, 'suite-report.html');
  await writeFile(jsonPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await writeFile(htmlPath, renderShadowSuiteHtml(title, aggregate), 'utf8');

  console.log('\n[suite] aggregate');
  for (const row of aggregate.strategies) {
    console.log(
      `[suite] ${row.strategy.padEnd(14)} trades=${String(row.trades).padStart(3)} active=${String(row.activeSettledMarkets).padStart(3)} ` +
      `pnl=$${row.netPnlUsd.toFixed(4)} roi=${(row.roiOnCost * 100).toFixed(2)}% ` +
      `ex_top5=$${row.pnlWithoutTop5Usd.toFixed(4)} verdict=${row.verdict}`,
    );
  }
  console.log(`[suite] json=${jsonPath}`);
  console.log(`[suite] html=${htmlPath}`);
}

void main().catch((error) => {
  console.error('[suite] failed', error);
  process.exitCode = 1;
});
