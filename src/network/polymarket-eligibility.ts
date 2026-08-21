export interface PolymarketGeoblockResult {
  state: 'ELIGIBLE' | 'BLOCKED' | 'UNAVAILABLE';
  blocked?: boolean;
  country?: string;
  region?: string;
  reason: string;
}

export interface PolymarketGeoblockOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const GEO_URL = 'https://polymarket.com/api/geoblock';

export async function probePolymarketGeoblock(
  options: PolymarketGeoblockOptions = {},
): Promise<PolymarketGeoblockResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    const response = await fetchImpl(GEO_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'FluxQuant/1.5 research-paper-only' },
    });
    if (!response.ok) {
      return { state: 'UNAVAILABLE', reason: `Geoblock endpoint returned HTTP ${response.status}.` };
    }
    const payload = await response.json() as Record<string, unknown>;
    if (typeof payload.blocked !== 'boolean') {
      return { state: 'UNAVAILABLE', reason: 'Geoblock endpoint response did not contain a boolean blocked field.' };
    }
    const country = typeof payload.country === 'string' ? payload.country : undefined;
    const region = typeof payload.region === 'string' ? payload.region : undefined;
    if (payload.blocked) {
      return {
        state: 'BLOCKED', blocked: true, country, region,
        reason: 'Official Polymarket geoblock endpoint reports this IP as blocked; FluxQuant will not submit orders or bypass the restriction.',
      };
    }
    return {
      state: 'ELIGIBLE', blocked: false, country, region,
      reason: 'Official Polymarket geoblock endpoint reports this IP as not blocked.',
    };
  } catch (error) {
    return {
      state: 'UNAVAILABLE',
      reason: `Geoblock endpoint unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
