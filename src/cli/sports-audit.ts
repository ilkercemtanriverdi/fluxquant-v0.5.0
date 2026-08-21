import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runSportsResearch, type SportsResearchConfig, type SportsVenueSnapshot } from '../sports/research-engine.js';

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

function numberArg(name: string, fallback: number): number {
  const value = argValue(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`INVALID_ARGUMENT:${name}`);
  return parsed;
}

function pct(value: number | undefined, digits = 2): string {
  return value === undefined ? 'N/A' : `${(value * 100).toFixed(digits)}%`;
}

function paperVerdict(report: ReturnType<typeof runSportsResearch>): string {
  const hardBlockers = new Set([
    'UNVERIFIED_DATA_PROVENANCE',
    'RECEIVED_TIME_UNKNOWN',
    'MANUAL_REFERENCE_DATA',
    'MANUAL_SETTLEMENT_DATA',
    'COMMISSION_UNKNOWN',
    'CONSENSUS_BUILD_FAILED',
    'CLOSING_CONSENSUS_BUILD_FAILED',
    'INPLAY_OR_POSTSTART_SNAPSHOT_REJECTED',
    'EVENT_START_UNKNOWN',
    'CONFLICTING_SETTLEMENT',
  ]);
  const hasHardBlocker = report.blockers.some((blocker) => hardBlockers.has(blocker));
  const strong =
    !hasHardBlocker &&
    report.uniqueSettledEvents >= 200 &&
    report.settledCandidates >= 200 &&
    report.clvCoveragePct >= 0.8 &&
    (report.clvLower95Pct ?? Number.NEGATIVE_INFINITY) > 0 &&
    (report.eventRoiLower95 ?? Number.NEGATIVE_INFINITY) > 0 &&
    report.roi > 0 &&
    report.maxDrawdownPct <= 0.2 &&
    report.maxEventTurnoverConcentrationPct <= 0.1;
  return strong
    ? 'PROMISING_UNTOUCHED_PAPER_EVIDENCE_ONLY — independent review required; this is not live-money authorization.'
    : 'INSUFFICIENT_OR_NEGATIVE_PAPER_EVIDENCE — continue research; no live-money authorization.';
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const inputPath = resolve(positional[0] ?? 'data/sports-research.jsonl');
  const outputPath = resolve(positional[1] ?? 'data/sports-audit/report.json');
  const markdownPath = outputPath.replace(/\.json$/i, '.md');
  const text = await readFile(inputPath, 'utf8');
  const snapshots: SportsVenueSnapshot[] = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try { return JSON.parse(line) as SportsVenueSnapshot; }
      catch { throw new Error(`SPORTS_INVALID_JSONL_LINE:${index + 1}`); }
    });

  const config: Partial<SportsResearchConfig> = {
    maxAgeMs: numberArg('--max-age-ms', 300_000),
    minConsensusVenues: numberArg('--min-consensus-venues', 2),
    minEdge: numberArg('--min-edge', 0.02),
    bankrollUsd: numberArg('--bankroll-usd', 100),
    stakePct: numberArg('--stake-pct', 0.02),
    minStakeUsd: numberArg('--min-stake-usd', 1),
    maxStakeUsd: numberArg('--max-stake-usd', 5),
    maxOpenRiskPct: numberArg('--max-open-risk-pct', 0.1),
    closeGraceMs: numberArg('--close-grace-ms', 0),
  };

  const report = runSportsResearch(snapshots, config);
  const decision = paperVerdict(report);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), inputPath, config, decision, ...report }, null, 2)}\n`);

  const md = [
    '# FluxQuant Sports Research Audit',
    '',
    `- mode: \`${report.mode}\``,
    `- execution evidence: \`${report.executionEvidence}\``,
    `- selection: \`${report.selectionPolicy}\``,
    '- live betting: `DISABLED`',
    `- snapshots: ${report.snapshots}`,
    `- qualifying raw signals: ${report.qualifyingSignals}`,
    `- placed paper candidates: ${report.candidateCount}`,
    `- settled candidates: ${report.settledCandidates}`,
    `- unique settled events: ${report.uniqueSettledEvents}`,
    `- unique settled markets: ${report.uniqueSettledMarkets}`,
    `- W/L/V: ${report.wins}/${report.losses}/${report.voids}`,
    `- realized PnL: $${report.realizedPnlUsd.toFixed(4)}`,
    `- turnover: $${report.turnoverUsd.toFixed(4)}`,
    `- ROI: ${pct(report.roi)}`,
    `- ending bankroll: $${report.endingBankrollUsd.toFixed(4)}`,
    `- max drawdown: ${pct(report.maxDrawdownPct)}`,
    `- mean entry net EV: ${pct(report.meanNetEvAtEntry)}`,
    `- median entry net EV: ${pct(report.medianNetEvAtEntry)}`,
    `- mean CLV: ${pct(report.meanClvPct)}`,
    `- CLV coverage: ${pct(report.clvCoveragePct, 1)}`,
    `- positive CLV rate: ${pct(report.positiveClvRate, 1)}`,
    `- event-level CLV lower 95% bound: ${pct(report.clvLower95Pct)}`,
    `- mean event ROI: ${pct(report.meanEventRoi)}`,
    `- event ROI lower 95% bound: ${pct(report.eventRoiLower95)}`,
    `- max event turnover concentration: ${pct(report.maxEventTurnoverConcentrationPct, 1)}`,
    `- max event absolute-PnL concentration: ${pct(report.maxEventPnlConcentrationPct, 1)}`,
    `- blockers: ${report.blockers.length ? report.blockers.join(', ') : 'NONE'}`,
    '',
    '## Decision',
    '',
    decision,
    '',
    'Promotion threshold is intentionally strict: at least 200 unique settled events, >=80% CLV coverage, positive lower-95% bounds for event ROI and CLV, <=20% max drawdown, and <=10% max event turnover concentration.',
    '',
    'Bet365 remains reference-only. FluxQuant does not scrape or execute automated Bet365 bets. Betfair paper research accepts delayed/historical/licensed data; Smarkets requires a source contract that explicitly permits research/benchmarking. All sports candidates are price-only paper evidence, not fill proof.',
    '',
  ].join('\n');
  await writeFile(markdownPath, md);

  console.log('[sports-audit] COMPLETE');
  console.log(`[sports-audit] candidates=${report.candidateCount} settled=${report.settledCandidates} events=${report.uniqueSettledEvents} pnl=$${report.realizedPnlUsd.toFixed(4)} roi=${pct(report.roi)}`);
  console.log(`[sports-audit] mean_clv=${pct(report.meanClvPct)} clv_lower95=${pct(report.clvLower95Pct)} event_roi_lower95=${pct(report.eventRoiLower95)}`);
  console.log(`[sports-audit] max_drawdown=${pct(report.maxDrawdownPct)} event_turnover_concentration=${pct(report.maxEventTurnoverConcentrationPct, 1)}`);
  console.log(`[sports-audit] blockers=${report.blockers.length ? report.blockers.join(',') : 'NONE'}`);
  console.log(`[sports-audit] decision=${decision}`);
  console.log(`[sports-audit] report=${outputPath}`);
  console.log(`[sports-audit] markdown=${markdownPath}`);
  console.log('[sports-audit] LIVE_BETTING=DISABLED');
}

main().catch((error) => {
  console.error(`[sports-audit] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
