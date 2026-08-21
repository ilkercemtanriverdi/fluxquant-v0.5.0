import { probePolymarketConnectivity } from '../network/polymarket-connectivity.js';

async function main(): Promise<void> {
  const result = await probePolymarketConnectivity();
  console.log(JSON.stringify(result, null, 2));
  if (result.state !== 'AVAILABLE') process.exitCode = 2;
}

void main().catch((error) => {
  console.error('[network] probe failed', error);
  process.exitCode = 1;
});
