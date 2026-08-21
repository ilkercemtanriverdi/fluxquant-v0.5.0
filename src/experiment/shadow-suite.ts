import type { ShadowReplayReport, ShadowStrategy } from '../shadow/replay-trader.js';

export interface ShadowSuiteRunResult {
  id: string;
  date: string;
  strategy: ShadowStrategy;
  report: ShadowReplayReport;
  eventPath: string;
  metadataPath: string;
}

export type ResearchVerdict =
  | 'NO_ACTIVITY'
  | 'NEGATIVE_OR_ZERO'
  | 'POSITIVE_BUT_CONCENTRATED'
  | 'POSITIVE_SMALL_SAMPLE'
  | 'POSITIVE_SAMPLE_NOT_PROOF_OF_ALPHA';

export interface StrategyAggregate {
  strategy: ShadowStrategy;
  runs: number;
  marketsEligible: number;
  marketsSettled: number;
  activeSettledMarkets: number;
  trades: number;
  feesUsd: number;
  cashCostUsd: number;
  netPnlUsd: number;
  roiOnCost: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number;
  meanMarketPnlUsd: number;
  medianMarketPnlUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  profitFactor: number | null;
  bestMarketPnlUsd: number;
  worstMarketPnlUsd: number;
  pnlWithoutTop1Usd: number;
  pnlWithoutTop5Usd: number;
  top5ShareOfGrossProfit: number;
  maxRunDrawdownUsd: number;
  directionalEntryTrades: number;
  sequentialHedgeTrades: number;
  pairArbLegTrades: number;
  skippedMissingBinanceFrame: number;
  skippedMissingPolymarketFrame: number;
  skippedStaleBinance: number;
  skippedStalePolymarket: number;
  skippedCrossOutcomeSkew: number;
  verdict: ResearchVerdict;
}

export interface ShadowSuiteAggregate {
  generatedAt: string;
  mode: 'RESEARCH_SHADOW_ONLY';
  strategies: StrategyAggregate[];
  runs: Array<{
    id: string;
    date: string;
    strategy: ShadowStrategy;
    marketsSettled: number;
    marketsEligible: number;
    trades: number;
    feesUsd: number;
    cashCostUsd: number;
    netPnlUsd: number;
    roiOnCost: number;
    maxCumulativeDrawdownUsd: number;
  }>;
  warnings: string[];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function verdictFor(netPnlUsd: number, trades: number, activeMarkets: number, pnlWithoutTop5Usd: number): ResearchVerdict {
  if (trades === 0) return 'NO_ACTIVITY';
  if (netPnlUsd <= 0) return 'NEGATIVE_OR_ZERO';
  if (pnlWithoutTop5Usd <= 0) return 'POSITIVE_BUT_CONCENTRATED';
  if (activeMarkets < 30) return 'POSITIVE_SMALL_SAMPLE';
  return 'POSITIVE_SAMPLE_NOT_PROOF_OF_ALPHA';
}

export function aggregateShadowSuite(runs: readonly ShadowSuiteRunResult[]): ShadowSuiteAggregate {
  const strategyOrder: ShadowStrategy[] = ['model', 'market-control', 'pair-arb'];
  const strategies: StrategyAggregate[] = [];

  for (const strategy of strategyOrder) {
    const selected = runs.filter((run) => run.strategy === strategy);
    if (selected.length === 0) continue;

    const activePnl = selected.flatMap((run) => run.report.markets)
      .filter((market) => market.trades > 0 && market.pnlUsd !== undefined)
      .map((market) => market.pnlUsd ?? 0);
    const positives = activePnl.filter((pnl) => pnl > 0).sort((a, b) => b - a);
    const negatives = activePnl.filter((pnl) => pnl < 0);
    const grossProfitUsd = positives.reduce((sum, value) => sum + value, 0);
    const grossLossUsd = negatives.reduce((sum, value) => sum + Math.abs(value), 0);
    const netPnlUsd = selected.reduce((sum, run) => sum + run.report.summary.netPnlUsd, 0);
    const cashCostUsd = selected.reduce((sum, run) => sum + run.report.summary.cashCostUsd, 0);
    const top1 = positives[0] ?? 0;
    const top5 = positives.slice(0, 5).reduce((sum, value) => sum + value, 0);
    const pnlWithoutTop1Usd = netPnlUsd - top1;
    const pnlWithoutTop5Usd = netPnlUsd - top5;
    const wins = activePnl.filter((pnl) => pnl > 1e-12).length;
    const losses = activePnl.filter((pnl) => pnl < -1e-12).length;
    const flats = activePnl.length - wins - losses;

    strategies.push({
      strategy,
      runs: selected.length,
      marketsEligible: selected.reduce((sum, run) => sum + run.report.summary.marketsEligible, 0),
      marketsSettled: selected.reduce((sum, run) => sum + run.report.summary.marketsSettled, 0),
      activeSettledMarkets: activePnl.length,
      trades: selected.reduce((sum, run) => sum + run.report.summary.trades, 0),
      feesUsd: selected.reduce((sum, run) => sum + run.report.summary.feesUsd, 0),
      cashCostUsd,
      netPnlUsd,
      roiOnCost: cashCostUsd > 0 ? netPnlUsd / cashCostUsd : 0,
      wins,
      losses,
      flats,
      winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
      meanMarketPnlUsd: activePnl.length > 0 ? activePnl.reduce((sum, value) => sum + value, 0) / activePnl.length : 0,
      medianMarketPnlUsd: median(activePnl),
      grossProfitUsd,
      grossLossUsd,
      profitFactor: grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : grossProfitUsd > 0 ? null : 0,
      bestMarketPnlUsd: activePnl.length > 0 ? Math.max(...activePnl) : 0,
      worstMarketPnlUsd: activePnl.length > 0 ? Math.min(...activePnl) : 0,
      pnlWithoutTop1Usd,
      pnlWithoutTop5Usd,
      top5ShareOfGrossProfit: grossProfitUsd > 0 ? top5 / grossProfitUsd : 0,
      maxRunDrawdownUsd: selected.reduce((max, run) => Math.max(max, run.report.summary.maxCumulativeDrawdownUsd), 0),
      directionalEntryTrades: selected.reduce((sum, run) => sum + run.report.summary.directionalEntryTrades, 0),
      sequentialHedgeTrades: selected.reduce((sum, run) => sum + run.report.summary.sequentialHedgeTrades, 0),
      pairArbLegTrades: selected.reduce((sum, run) => sum + run.report.summary.pairArbLegTrades, 0),
      skippedMissingBinanceFrame: selected.reduce((sum, run) => sum + run.report.summary.skippedMissingBinanceFrame, 0),
      skippedMissingPolymarketFrame: selected.reduce((sum, run) => sum + run.report.summary.skippedMissingPolymarketFrame, 0),
      skippedStaleBinance: selected.reduce((sum, run) => sum + run.report.summary.skippedStaleBinance, 0),
      skippedStalePolymarket: selected.reduce((sum, run) => sum + run.report.summary.skippedStalePolymarket, 0),
      skippedCrossOutcomeSkew: selected.reduce((sum, run) => sum + run.report.summary.skippedCrossOutcomeSkew, 0),
      verdict: verdictFor(netPnlUsd, selected.reduce((sum, run) => sum + run.report.summary.trades, 0), activePnl.length, pnlWithoutTop5Usd),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: 'RESEARCH_SHADOW_ONLY',
    strategies,
    runs: runs.map((run) => ({
      id: run.id,
      date: run.date,
      strategy: run.strategy,
      marketsSettled: run.report.summary.marketsSettled,
      marketsEligible: run.report.summary.marketsEligible,
      trades: run.report.summary.trades,
      feesUsd: run.report.summary.feesUsd,
      cashCostUsd: run.report.summary.cashCostUsd,
      netPnlUsd: run.report.summary.netPnlUsd,
      roiOnCost: run.report.summary.roiOnCost,
      maxCumulativeDrawdownUsd: run.report.summary.maxCumulativeDrawdownUsd,
    })),
    warnings: [
      'Research/shadow output only. No result is evidence of live profitability or stable alpha.',
      'Historical OpenMarket top-of-book exports are not full L2 and cannot validate real latency, queue position, or scalable depth.',
      'Proxy-resolved historical markets must remain clearly distinguished from authoritative Polymarket resolution.',
      'Positive results must survive untouched forward data, latency/slippage stress, fee verification, and concentration checks before any further gate.',
    ],
  };
}
