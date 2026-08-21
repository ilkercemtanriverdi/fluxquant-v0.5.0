import type { EmergingAssetCandidate } from './types.js';

const BASE = 'https://api.dexscreener.com';

type DexPair = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string | null;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number> | null;
  liquidity?: { usd?: number; base?: number; quote?: number } | null;
  fdv?: number | null;
  marketCap?: number | null;
  pairCreatedAt?: number | null;
  info?: {
    websites?: Array<{ url?: string }>;
    socials?: Array<{ platform?: string; handle?: string }>;
  };
  boosts?: { active?: number };
};

type PaidOrder = { type?: string; status?: string; paymentTimestamp?: number };

export function normalizePaidOrders(payload: unknown): PaidOrder[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is PaidOrder => Boolean(item) && typeof item === 'object');
  }

  // DEX Screener documents an array response, but intermediary/rate-limit/error
  // payloads may occasionally arrive as objects. Treat those as no usable
  // paid-order metadata instead of crashing the entire scout cycle.
  if (payload && typeof payload === 'object') {
    const maybeOrders = (payload as { orders?: unknown }).orders;
    if (Array.isArray(maybeOrders)) {
      return maybeOrders.filter((item): item is PaidOrder => Boolean(item) && typeof item === 'object');
    }
  }
  return [];
}

function finite(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function mergeBucket(
  current: EmergingAssetCandidate['activity']['m5'],
  pair: DexPair,
  key: string,
) {
  const txn = pair.txns?.[key];
  return {
    buys: finite(txn?.buys) ?? current?.buys,
    sells: finite(txn?.sells) ?? current?.sells,
    buyers: current?.buyers,
    sellers: current?.sellers,
    volumeUsd: finite(pair.volume?.[key]) ?? current?.volumeUsd,
    priceChangePct: finite(pair.priceChange?.[key]) ?? current?.priceChangePct,
  };
}

export function chooseBestDexPair(pairs: readonly DexPair[], tokenAddress: string): DexPair | undefined {
  const normalized = tokenAddress.toLowerCase();
  const matching = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === normalized || p.quoteToken?.address?.toLowerCase() === normalized);
  return matching.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

export function enrichWithDexScreener(
  candidate: EmergingAssetCandidate,
  pairs: readonly DexPair[],
  paidOrders: readonly PaidOrder[] = [],
): EmergingAssetCandidate {
  const pair = chooseBestDexPair(pairs, candidate.tokenAddress);
  const approvedPaidOrder = paidOrders.some((x) => x.status === 'approved' || x.status === 'processing');
  if (!pair) {
    return { ...candidate, paidPromotion: approvedPaidOrder || candidate.paidPromotion };
  }

  const isBase = pair.baseToken?.address?.toLowerCase() === candidate.tokenAddress.toLowerCase();
  const token = isBase ? pair.baseToken : pair.quoteToken;
  const quote = isBase ? pair.quoteToken : pair.baseToken;
  const activeBoosts = finite(pair.boosts?.active);
  return {
    ...candidate,
    tokenName: token?.name ?? candidate.tokenName,
    tokenSymbol: token?.symbol ?? candidate.tokenSymbol,
    pairAddress: pair.pairAddress ?? candidate.pairAddress,
    dexId: pair.dexId ?? candidate.dexId,
    quoteTokenAddress: quote?.address ?? candidate.quoteTokenAddress,
    quoteTokenSymbol: quote?.symbol ?? candidate.quoteTokenSymbol,
    pairCreatedAtMs: finite(pair.pairCreatedAt) ?? candidate.pairCreatedAtMs,
    priceUsd: finite(pair.priceUsd) ?? candidate.priceUsd,
    liquidityUsd: finite(pair.liquidity?.usd) ?? candidate.liquidityUsd,
    fdvUsd: finite(pair.fdv) ?? candidate.fdvUsd,
    marketCapUsd: finite(pair.marketCap) ?? candidate.marketCapUsd,
    activity: {
      m5: mergeBucket(candidate.activity.m5, pair, 'm5'),
      h1: mergeBucket(candidate.activity.h1, pair, 'h1'),
      h6: mergeBucket(candidate.activity.h6, pair, 'h6'),
      h24: mergeBucket(candidate.activity.h24, pair, 'h24'),
    },
    activeBoosts,
    paidPromotion: approvedPaidOrder || (activeBoosts ?? 0) > 0,
    profilePresent: Boolean(pair.info),
    websites: pair.info?.websites?.map((x) => x.url).filter((x): x is string => Boolean(x)) ?? candidate.websites,
    socials: pair.info?.socials ?? candidate.socials,
  };
}

export interface DexScreenerOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  includePaidOrders?: boolean;
}

export async function fetchDexScreenerEnrichment(
  candidate: EmergingAssetCandidate,
  options: DexScreenerOptions = {},
): Promise<EmergingAssetCandidate> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? BASE;
  const tokenUrl = new URL(`${base}/token-pairs/v1/${encodeURIComponent(candidate.chain)}/${encodeURIComponent(candidate.tokenAddress)}`);
  const tokenResponse = await fetchImpl(tokenUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!tokenResponse.ok) throw new Error(`DEX Screener token-pairs HTTP ${tokenResponse.status}`);
  const pairPayload = await tokenResponse.json() as unknown;
  const pairs = Array.isArray(pairPayload) ? pairPayload as DexPair[] : [];

  let orders: PaidOrder[] = [];
  if (options.includePaidOrders !== false) {
    const orderUrl = new URL(`${base}/orders/v1/${encodeURIComponent(candidate.chain)}/${encodeURIComponent(candidate.tokenAddress)}`);
    const orderResponse = await fetchImpl(orderUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (orderResponse.ok) orders = normalizePaidOrders(await orderResponse.json() as unknown);
  }
  return enrichWithDexScreener(candidate, pairs, orders);
}
