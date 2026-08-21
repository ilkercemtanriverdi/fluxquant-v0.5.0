import { probePolymarketConnectivity } from '../network/polymarket-connectivity.js';
import { probePolymarketGeoblock } from '../network/polymarket-eligibility.js';

async function main(): Promise<number> {
  const [connectivity, geoblock] = await Promise.all([
    probePolymarketConnectivity(),
    probePolymarketGeoblock(),
  ]);
  const eligibleForPaper = connectivity.state === 'AVAILABLE' && geoblock.state === 'ELIGIBLE';
  const result = {
    mode: 'READ_ONLY_ELIGIBILITY_CHECK',
    connectivity,
    geoblock,
    eligibleForPaper,
    eligibleForLiveOrders: false,
    reason: eligibleForPaper
      ? 'Public data access and official geoblock check permit read-only paper collection. Real order execution remains disabled by FluxQuant.'
      : 'Read-only live paper collection is blocked or unavailable; FluxQuant will not bypass network or geographic restrictions.',
  };
  console.log(JSON.stringify(result, null, 2));
  return eligibleForPaper ? 0 : 2;
}

void main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[eligibility] failed', error);
    process.exit(1);
  });
