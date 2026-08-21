import type { EmergingAssetCandidate, ScoutChain, TimeBucketActivity } from './types.js';

const DEFAULT_BASE = 'https://api.geckoterminal.com/api/v2';

type JsonApiResource = {
  id?: string;
  type?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id?: string; type?: string } }>;
};

type GeckoResponse = {
  data?: JsonApiResource[];
  included?: JsonApiResource[];
};

function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function epochMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function bucket(
  tx: Record<string, unknown> | undefined,
  volumes: Record<string, unknown> | undefined,
  changes: Record<string, unknown> | undefined,
  key: string,
): TimeBucketActivity | undefined {
  const row = tx?.[key] as Record<string, unknown> | undefined;
  const result: TimeBucketActivity = {
    buys: finite(row?.buys),
    sells: finite(row?.sells),
    buyers: finite(row?.buyers),
    sellers: finite(row?.sellers),
    volumeUsd: finite(volumes?.[key]),
    priceChangePct: finite(changes?.[key]),
  };
  return Object.values(result).some((x) => x !== undefined) ? result : undefined;
}

export function parseGeckoTerminalNewPools(
  payload: GeckoResponse,
  chain: ScoutChain,
  nowMs = Date.now(),
): EmergingAssetCandidate[] {
  const included = new Map<string, JsonApiResource>();
  for (const item of payload.included ?? []) {
    if (item.id) included.set(item.id, item);
  }

  const output: EmergingAssetCandidate[] = [];
  for (const pool of payload.data ?? []) {
    const a = pool.attributes ?? {};
    const rel = pool.relationships ?? {};
    const baseId = rel.base_token?.data?.id;
    const quoteId = rel.quote_token?.data?.id;
    const dexId = rel.dex?.data?.id;
    const base = baseId ? included.get(baseId)?.attributes ?? {} : {};
    const quote = quoteId ? included.get(quoteId)?.attributes ?? {} : {};
    const tokenAddress = String(base.address ?? baseId?.split('_').slice(1).join('_') ?? '').trim();
    if (!tokenAddress) continue;

    const tx = a.transactions as Record<string, unknown> | undefined;
    const volumes = a.volume_usd as Record<string, unknown> | undefined;
    const changes = a.price_change_percentage as Record<string, unknown> | undefined;

    output.push({
      source: 'geckoterminal',
      chain,
      tokenAddress,
      tokenName: typeof base.name === 'string' ? base.name : undefined,
      tokenSymbol: typeof base.symbol === 'string' ? base.symbol : undefined,
      pairAddress: typeof a.address === 'string' ? a.address : pool.id?.split('_').slice(1).join('_'),
      dexId,
      quoteTokenAddress: typeof quote.address === 'string' ? quote.address : undefined,
      quoteTokenSymbol: typeof quote.symbol === 'string' ? quote.symbol : undefined,
      discoveredAtMs: nowMs,
      pairCreatedAtMs: epochMs(a.pool_created_at),
      priceUsd: finite(a.base_token_price_usd),
      liquidityUsd: finite(a.reserve_in_usd),
      fdvUsd: finite(a.fdv_usd),
      marketCapUsd: finite(a.market_cap_usd),
      activity: {
        m5: bucket(tx, volumes, changes, 'm5'),
        h1: bucket(tx, volumes, changes, 'h1'),
        h6: bucket(tx, volumes, changes, 'h6'),
        h24: bucket(tx, volumes, changes, 'h24'),
      },
      communitySuspiciousReports: finite(a.community_sus_report),
      raw: pool,
    });
  }
  return output;
}

export interface GeckoTerminalScannerOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  page?: number;
  includeCommunityData?: boolean;
}

export async function fetchGeckoTerminalNewPools(
  chain: ScoutChain,
  options: GeckoTerminalScannerOptions = {},
): Promise<EmergingAssetCandidate[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? DEFAULT_BASE;
  const url = new URL(`${base}/networks/${encodeURIComponent(chain)}/new_pools`);
  url.searchParams.set('include', 'base_token,quote_token,dex');
  url.searchParams.set('page', String(options.page ?? 1));
  if (options.includeCommunityData) url.searchParams.set('include_gt_community_data', 'true');
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GeckoTerminal HTTP ${response.status}`);
  const payload = await response.json() as GeckoResponse;
  return parseGeckoTerminalNewPools(payload, chain);
}
