import type { ShadowSuiteAggregate } from '../experiment/shadow-suite.js';

function esc(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function money(value: number): string {
  return `$${value.toFixed(4)}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function renderShadowSuiteHtml(title: string, aggregate: ShadowSuiteAggregate): string {
  const strategyRows = aggregate.strategies.map((row) => `
    <tr>
      <td><strong>${esc(row.strategy)}</strong></td>
      <td>${row.trades}</td>
      <td>${row.activeSettledMarkets}</td>
      <td>${money(row.netPnlUsd)}</td>
      <td>${money(row.feesUsd)}</td>
      <td>${pct(row.roiOnCost)}</td>
      <td>${pct(row.winRate)}</td>
      <td>${money(row.medianMarketPnlUsd)}</td>
      <td>${money(row.pnlWithoutTop5Usd)}</td>
      <td>${esc(row.verdict)}</td>
    </tr>`).join('');

  const runRows = aggregate.runs.map((row) => `
    <tr>
      <td>${esc(row.date)}</td>
      <td>${esc(row.strategy)}</td>
      <td>${row.marketsSettled}/${row.marketsEligible}</td>
      <td>${row.trades}</td>
      <td>${money(row.netPnlUsd)}</td>
      <td>${money(row.feesUsd)}</td>
      <td>${pct(row.roiOnCost)}</td>
      <td>${money(row.maxCumulativeDrawdownUsd)}</td>
    </tr>`).join('');

  const warnings = aggregate.warnings.map((warning) => `<li>${esc(warning)}</li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — FluxQuant</title>
<style>
  :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; background: #0b0e14; color: #e8edf4; }
  main { max-width: 1180px; margin: 0 auto; padding: 36px 20px 64px; }
  h1 { margin: 0 0 6px; font-size: 34px; }
  h2 { margin-top: 34px; }
  .muted { color: #9aa6b5; }
  .badge { display: inline-block; margin-top: 12px; padding: 6px 10px; border: 1px solid #394454; border-radius: 999px; color: #b9c5d4; }
  .panel { background: #121722; border: 1px solid #283142; border-radius: 14px; padding: 18px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; min-width: 860px; }
  th, td { padding: 10px 12px; text-align: right; border-bottom: 1px solid #283142; white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  th { color: #9fb0c3; font-weight: 600; }
  ul { line-height: 1.6; }
  code { background: #1b2230; padding: 2px 5px; border-radius: 5px; }
</style>
</head>
<body>
<main>
  <h1>${esc(title)}</h1>
  <div class="muted">Generated ${esc(aggregate.generatedAt)}</div>
  <div class="badge">RESEARCH / SHADOW ONLY · LIVE EXECUTION DISABLED</div>

  <h2>Strategy summary</h2>
  <div class="panel">
    <table>
      <thead><tr><th>Strategy</th><th>Trades</th><th>Active markets</th><th>Net PnL</th><th>Fees</th><th>ROI</th><th>Win rate</th><th>Median market PnL</th><th>PnL ex top 5</th><th>Verdict</th></tr></thead>
      <tbody>${strategyRows}</tbody>
    </table>
  </div>

  <h2>Run detail</h2>
  <div class="panel">
    <table>
      <thead><tr><th>Date</th><th>Strategy</th><th>Settled</th><th>Trades</th><th>Net PnL</th><th>Fees</th><th>ROI</th><th>Max drawdown</th></tr></thead>
      <tbody>${runRows}</tbody>
    </table>
  </div>

  <h2>Research warnings</h2>
  <div class="panel"><ul>${warnings}</ul></div>
</main>
</body>
</html>`;
}
