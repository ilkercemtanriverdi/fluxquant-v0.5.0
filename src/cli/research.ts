import { spawn } from 'node:child_process';
import { loadResearchRegistry, filterResearchStrategies, researchStatusCounts } from '../research/registry.js';
import { RESEARCH_MARKETS, type ResearchMarket } from '../research/types.js';

function args(): string[] {
  return process.argv.slice(2);
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return args().find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function flag(name: string): boolean {
  return args().includes(name);
}

function parseMarket(): ResearchMarket | undefined {
  const raw = argValue('--market');
  if (raw === undefined) return undefined;
  if (!RESEARCH_MARKETS.includes(raw as ResearchMarket)) throw new Error(`RESEARCH_INVALID_MARKET:${raw}`);
  return raw as ResearchMarket;
}

async function runProcess(command: string, processArgs: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, processArgs, { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal) {
        reject(new Error(`RESEARCH_CHILD_SIGNAL:${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function runResearchCapability(): Promise<boolean> {
  const positional = args().filter((arg) => !arg.startsWith('--'));
  if (positional[0] !== 'run') return false;

  const capability = positional[1];
  const python = process.env.PYTHON ?? 'python3';

  if (capability === 'crypto-c1') {
    const command = flag('--selftest') ? 'selftest' : 'analyze';
    const processArgs = [
      'tools/research/crypto_c1.py',
      command,
      '--contract', 'research/experiments/crypto-c1/contract.json',
      '--cache-dir', 'cache/binance/klines/crypto-c1',
      '--report', 'reports/research/crypto-c1.json',
    ];
    if (flag('--json')) processArgs.push('--json');
    console.log(`[research] capability=crypto-c1 mode=${command} real_money=NO_GO`);
    const code = await runProcess(python, processArgs);
    if (code !== 0) throw new Error(`RESEARCH_RUN_FAILED:crypto-c1:exit=${code}`);
    return true;
  }

  if (capability === 'crypto-carry') {
    const command = flag('--selftest') ? 'self-test' : flag('--economic-pnl') ? 'economic-pnl' : 'auto';
    console.log(`[research] capability=crypto-carry mode=${command} venue=bybit real_money=NO_GO`);
    if (flag('--selftest')) {
      const scanCode = await runProcess(python, ['tools/research/crypto_carry_snapshot.py', 'self-test']);
      if (scanCode !== 0) throw new Error(`RESEARCH_RUN_FAILED:crypto-carry-snapshot:exit=${scanCode}`);
    }
    const code = await runProcess(python, ['tools/research/crypto_carry.py', command]);
    if (code !== 0) throw new Error(`RESEARCH_RUN_FAILED:crypto-carry:exit=${code}`);
    return true;
  }

  if (capability === 'crypto-expiry-carry') {
    const command = flag('--selftest') ? 'self-test' : flag('--matured-audit') ? 'matured-audit' : flag('--snapshot') ? 'snapshot' : 'auto';
    console.log(`[research] capability=crypto-expiry-carry mode=${command} venue=bybit real_money=NO_GO`);
    const processArgs = ['tools/research/crypto_expiry_carry.py', command];
    const code = await runProcess(python, processArgs);
    if (code !== 0) throw new Error(`RESEARCH_RUN_FAILED:crypto-expiry-carry:exit=${code}`);
    return true;
  }

  if (capability === 'crypto-altcoin-flow') {
    const command = flag('--selftest')
      ? 'self-test'
      : flag('--watch-horizons') ? 'watch-horizons' : 'auto';
    console.log(`[research] capability=crypto-altcoin-flow mode=${command} venue=dexscreener real_money=NO_GO`);
    const code = await runProcess(python, ['tools/research/crypto_altcoin_flow.py', command]);
    if (code !== 0) throw new Error(`RESEARCH_RUN_FAILED:crypto-altcoin-flow:exit=${code}`);
    return true;
  }

  if (capability === 'poly-inventory-rotation') {
    const command = flag('--selftest') ? 'self-test' : 'run';
    console.log(`[research] capability=poly-inventory-rotation mode=${command} wallet=0xce25e214d5cfe4f459cf67f08df581885aae7fdc real_money=NO_GO`);
    const code = await runProcess(python, ['tools/research/poly_inventory_rotation.py', command]);
    if (code !== 0) throw new Error(`RESEARCH_RUN_FAILED:poly-inventory-rotation:exit=${code}`);
    return true;
  }

  throw new Error(`RESEARCH_RUN_UNKNOWN_CAPABILITY:${capability ?? 'MISSING'}`);
}

async function printStatus(): Promise<void> {
  const registry = await loadResearchRegistry(argValue('--registry') ?? 'research/registry.json');
  const market = parseMarket();
  const strategies = filterResearchStrategies(registry, market);

  if (flag('--json')) {
    console.log(JSON.stringify({
      schemaVersion: registry.schemaVersion,
      checkpointDate: registry.checkpointDate,
      mission: registry.mission,
      governance: registry.governance,
      market: market ?? 'all',
      counts: researchStatusCounts(strategies),
      strategies,
    }, null, 2));
    return;
  }

  console.log('[research] FluxQuant Unified Research Registry');
  console.log(`[research] checkpoint=${registry.checkpointDate} production=${registry.governance.productionVersion} real_money=${registry.governance.realMoneyGate}`);
  console.log(`[research] scope=${market ?? 'all'} strategies=${strategies.length} counts=${JSON.stringify(researchStatusCounts(strategies))}`);
  for (const strategy of strategies) {
    console.log(`[research] ${strategy.id} market=${strategy.market} status=${strategy.status} mode=${strategy.mode} blockers=${strategy.blockers.length ? strategy.blockers.join(',') : 'NONE'}`);
    console.log(`[research]   next=${strategy.nextTest ?? 'NONE'}`);
  }
  console.log('[research] USER_QUESTION_IS_NOT_PIVOT=true');
  console.log('[research] SILENT_PIVOT_FORBIDDEN=true');
  console.log('[research] REAL_MONEY_GATE=NO_GO');
}

async function main(): Promise<void> {
  if (await runResearchCapability()) return;
  await printStatus();
}

main().catch((error) => {
  console.error(`[research] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
