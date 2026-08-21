import { resolve } from 'node:path';
import { loadCatalystSignals } from '../scout/catalysts.js';
import { appendScoutAssessments, runScoutCycle } from '../scout/scanner.js';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const once = hasArg('--once');
  const intervalSeconds = Number(argValue('--interval') ?? process.env.SCOUT_INTERVAL_SEC ?? '60');
  const chains = (argValue('--chains') ?? process.env.SCOUT_CHAINS ?? 'solana,base').split(',').map((x) => x.trim()).filter(Boolean);
  const maxCandidatesPerChain = Number(process.env.SCOUT_MAX_CANDIDATES_PER_CHAIN ?? '20');
  const minLiquidityUsd = Number(process.env.SCOUT_MIN_LIQUIDITY_USD ?? '5000');
  const dataDir = resolve(process.env.DATA_DIR ?? './data');
  const output = resolve(dataDir, `emerging-assets-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const catalystPath = process.env.SCOUT_CATALYSTS_FILE;
  const catalysts = catalystPath ? await loadCatalystSignals(resolve(catalystPath)) : [];

  console.log(`[scout] chains=${chains.join(',')} mode=READ_ONLY output=${output}`);
  console.log('[scout] automatic buying: DISABLED');
  if (!process.env.GOPLUS_ACCESS_TOKEN) console.log('[scout] GoPlus not configured: candidates will remain SECURITY_PENDING unless rejected by market-data rules.');

  const cycle = async () => {
    const result = await runScoutCycle({
      chains,
      maxCandidatesPerChain,
      minLiquidityUsd,
      goPlusAccessToken: process.env.GOPLUS_ACCESS_TOKEN,
      catalysts,
      includePaidOrders: true,
    });
    await appendScoutAssessments(output, result.assessed);
    const high = result.assessed.filter((x) => x.status === 'HIGH_INTEREST');
    const pending = result.assessed.filter((x) => x.status === 'SECURITY_PENDING');
    const rejected = result.assessed.filter((x) => x.status === 'REJECT');
    console.log(`[scout] discovered=${result.discovered} high=${high.length} security_pending=${pending.length} rejected=${rejected.length} errors=${result.errors.length}`);
    for (const row of result.assessed.slice(0, 8)) {
      console.log(`[scout] ${row.status.padEnd(16)} ${row.candidate.chain}:${row.candidate.tokenSymbol ?? '?'} opp=${row.scores.opportunity.toFixed(1)} risk=${row.scores.risk.toFixed(1)} liq=$${(row.candidate.liquidityUsd ?? 0).toFixed(0)} ${row.candidate.tokenAddress}`);
    }
    for (const error of result.errors.slice(0, 5)) console.error(`[scout] warning ${error}`);
  };

  await cycle();
  if (once) return;
  const delay = Number.isFinite(intervalSeconds) && intervalSeconds >= 30 ? intervalSeconds * 1000 : 60_000;
  const timer = setInterval(() => void cycle().catch((error) => console.error('[scout] cycle failed', error)), delay);
  process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
}

void main().catch((error) => {
  console.error('[scout] fatal', error);
  process.exitCode = 1;
});
