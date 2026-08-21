import { spawnSync } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { resolve } from 'node:path';
import { probePolymarketConnectivity } from '../network/polymarket-connectivity.js';
import { assertLiveExecutionUnavailable, validateMode } from '../security/live-gate.js';

interface Check {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
}

function nodeMajor(): number {
  return Number(process.versions.node.split('.')[0] ?? 0);
}

function pythonCommand(): string {
  return process.env.VIRTUAL_ENV ? resolve(process.env.VIRTUAL_ENV, 'bin/python3') : 'python3';
}

async function main(): Promise<void> {
  const checks: Check[] = [];
  const major = nodeMajor();
  checks.push({
    name: 'Node.js',
    status: major >= 22 ? 'PASS' : 'FAIL',
    detail: `v${process.versions.node}; required >=22`,
  });

  try {
    const mode = validateMode(process.env.FLUXQUANT_MODE);
    checks.push({ name: 'Mode', status: 'PASS', detail: `${mode}; research/shadow only` });
  } catch (error) {
    checks.push({ name: 'Mode', status: 'FAIL', detail: error instanceof Error ? error.message : String(error) });
  }

  try {
    assertLiveExecutionUnavailable();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({
      name: 'Live execution guard',
      status: detail.includes('LIVE_EXECUTION_DISABLED') ? 'PASS' : 'FAIL',
      detail,
    });
  }

  const dataDir = resolve(process.env.DATA_DIR ?? './data');
  try {
    await access(dataDir, constants.R_OK | constants.W_OK);
    checks.push({ name: 'Data directory', status: 'PASS', detail: dataDir });
  } catch {
    checks.push({ name: 'Data directory', status: 'WARN', detail: `${dataDir} does not exist or is not writable yet` });
  }

  const python = pythonCommand();
  const py = spawnSync(python, ['-c', 'import sys, pyarrow; print(sys.version.split()[0]); print(pyarrow.__version__)'], { encoding: 'utf8' });
  if (py.status === 0) {
    const [version = 'unknown', pyarrow = 'unknown'] = (py.stdout ?? '').trim().split(/\r?\n/);
    checks.push({ name: 'Python archive runtime', status: 'PASS', detail: `${python}; Python ${version}; pyarrow ${pyarrow}` });
  } else {
    checks.push({
      name: 'Python archive runtime',
      status: 'WARN',
      detail: `${python}; pyarrow unavailable — historical OpenMarket export/full archive audit will be incomplete`,
    });
  }

  if (process.argv.includes('--network')) {
    const result = await probePolymarketConnectivity();
    checks.push({
      name: 'Polymarket public network',
      status: result.state === 'AVAILABLE' ? 'PASS' : 'WARN',
      detail: `${result.state}: ${result.reason}`,
    });
  }

  console.log('FluxQuant Doctor');
  for (const check of checks) console.log(`[${check.status}] ${check.name}: ${check.detail}`);
  const failures = checks.filter((check) => check.status === 'FAIL').length;
  if (failures > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error('[doctor] failed', error);
  process.exitCode = 1;
});
