const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

export const DEFAULT_BENCHMARK_WALLET = '0xb55fa1296e6ec55d0ce53d93b9237389f11764d4';

export interface WalletActivity {
  proxyWallet?: string;
  timestamp?: number;
  conditionId?: string;
  type?: string;
  size?: number;
  usdcSize?: number;
  transactionHash?: string;
  price?: number;
  asset?: string;
  side?: string;
  outcomeIndex?: number;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
}

export interface LeaderboardRow {
  rank?: string;
  proxyWallet?: string;
  userName?: string;
  vol?: number;
  pnl?: number;
  xUsername?: string;
  verifiedBadge?: boolean;
}

export interface ClosedPosition {
  asset?: string;
  conditionId?: string;
  avgPrice?: number;
  totalBought?: number;
  realizedPnl?: number;
  curPrice?: number;
  timestamp?: number;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  outcomeIndex?: number;
  oppositeOutcome?: string;
  oppositeAsset?: string;
  endDate?: string;
}

export interface WalletProfile {
  proxyWallet?: string | null;
  name?: string | null;
  pseudonym?: string | null;
  xUsername?: string | null;
  verifiedBadge?: boolean | null;
  createdAt?: string | null;
}

export interface WalletProfilerOptions {
  wallet?: string;
  activityPages?: number;
  activityPageSize?: number;
  fetchImpl?: typeof fetch;
}

export interface WalletActivitySummary {
  observedActivityCount: number;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  redeemCount: number;
  mergeCount: number;
  splitCount: number;
  makerRebateCount: number;
  observedTradeUsd: number;
  uniqueMarkets: number;
  shortHorizonCryptoTrades: number;
  marketsWithBothOutcomesBought: number;
  twoSidedBuyMarketShare: number;
  firstObservedTimeMs?: number;
  lastObservedTimeMs?: number;
  observedTradesPerHour?: number;
}

export interface WalletBenchmarkSnapshot {
  wallet: string;
  capturedAt: string;
  profile?: WalletProfile;
  cryptoAllLeaderboard?: LeaderboardRow;
  overallAllLeaderboard?: LeaderboardRow;
  activitySummary: WalletActivitySummary;
  topClosedPositions: ClosedPosition[];
  recentActivity: WalletActivity[];
}

function assertWallet(wallet: string): void {
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) throw new Error(`Invalid wallet address: ${wallet}`);
}

function normalizeTimestampMs(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

function shortHorizonCrypto(activity: WalletActivity): boolean {
  const text = `${activity.title ?? ''} ${activity.slug ?? ''} ${activity.eventSlug ?? ''}`.toLowerCase();
  const crypto = /\b(bitcoin|btc|ethereum|ether|eth|solana|sol|xrp)\b/.test(text);
  const directional = (text.includes('up') && text.includes('down')) || text.includes('up-or-down');
  return crypto && directional;
}

export function summarizeWalletActivity(activity: readonly WalletActivity[]): WalletActivitySummary {
  let tradeCount = 0;
  let buyCount = 0;
  let sellCount = 0;
  let redeemCount = 0;
  let mergeCount = 0;
  let splitCount = 0;
  let makerRebateCount = 0;
  let observedTradeUsd = 0;
  let shortHorizonCryptoTrades = 0;
  const markets = new Set<string>();
  const boughtOutcomes = new Map<string, Set<string>>();
  const tradeTimes: number[] = [];

  for (const item of activity) {
    const type = String(item.type ?? '').toUpperCase();
    const conditionId = item.conditionId ? String(item.conditionId) : '';
    if (conditionId) markets.add(conditionId);

    if (type === 'TRADE') {
      tradeCount += 1;
      const side = String(item.side ?? '').toUpperCase();
      if (side === 'BUY') {
        buyCount += 1;
        if (conditionId) {
          const key = String(item.asset ?? item.outcome ?? item.outcomeIndex ?? 'unknown');
          const set = boughtOutcomes.get(conditionId) ?? new Set<string>();
          set.add(key);
          boughtOutcomes.set(conditionId, set);
        }
      } else if (side === 'SELL') sellCount += 1;
      const cash = Number(item.usdcSize);
      if (Number.isFinite(cash)) observedTradeUsd += Math.abs(cash);
      if (shortHorizonCrypto(item)) shortHorizonCryptoTrades += 1;
      const timeMs = normalizeTimestampMs(item.timestamp);
      if (timeMs !== undefined) tradeTimes.push(timeMs);
    } else if (type === 'REDEEM') redeemCount += 1;
    else if (type === 'MERGE') mergeCount += 1;
    else if (type === 'SPLIT') splitCount += 1;
    else if (type === 'MAKER_REBATE') makerRebateCount += 1;
  }

  const marketsWithBothOutcomesBought = [...boughtOutcomes.values()].filter((x) => x.size >= 2).length;
  tradeTimes.sort((a, b) => a - b);
  const firstObservedTimeMs = tradeTimes[0];
  const lastObservedTimeMs = tradeTimes.at(-1);
  const observedHours = firstObservedTimeMs !== undefined && lastObservedTimeMs !== undefined
    ? (lastObservedTimeMs - firstObservedTimeMs) / 3_600_000
    : 0;

  return {
    observedActivityCount: activity.length,
    tradeCount,
    buyCount,
    sellCount,
    redeemCount,
    mergeCount,
    splitCount,
    makerRebateCount,
    observedTradeUsd,
    uniqueMarkets: markets.size,
    shortHorizonCryptoTrades,
    marketsWithBothOutcomesBought,
    twoSidedBuyMarketShare: boughtOutcomes.size > 0 ? marketsWithBothOutcomesBought / boughtOutcomes.size : 0,
    firstObservedTimeMs,
    lastObservedTimeMs,
    observedTradesPerHour: observedHours > 0 ? tradeCount / observedHours : undefined,
  };
}

async function getJson<T>(url: URL, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.origin}${url.pathname}`);
  return response.json() as Promise<T>;
}

async function fetchLeaderboard(
  wallet: string,
  category: 'CRYPTO' | 'OVERALL',
  fetchImpl: typeof fetch,
): Promise<LeaderboardRow | undefined> {
  const url = new URL(`${DATA_API}/v1/leaderboard`);
  url.searchParams.set('category', category);
  url.searchParams.set('timePeriod', 'ALL');
  url.searchParams.set('orderBy', 'PNL');
  url.searchParams.set('limit', '1');
  url.searchParams.set('user', wallet);
  const rows = await getJson<LeaderboardRow[]>(url, fetchImpl);
  return rows[0];
}

async function fetchActivity(
  wallet: string,
  pages: number,
  pageSize: number,
  fetchImpl: typeof fetch,
): Promise<WalletActivity[]> {
  const all: WalletActivity[] = [];
  for (let page = 0; page < pages; page += 1) {
    const url = new URL(`${DATA_API}/activity`);
    url.searchParams.set('user', wallet);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(page * pageSize));
    url.searchParams.set('sortBy', 'TIMESTAMP');
    url.searchParams.set('sortDirection', 'DESC');
    const rows = await getJson<WalletActivity[]>(url, fetchImpl);
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

async function fetchTopClosedPositions(wallet: string, fetchImpl: typeof fetch): Promise<ClosedPosition[]> {
  const url = new URL(`${DATA_API}/closed-positions`);
  url.searchParams.set('user', wallet);
  url.searchParams.set('limit', '50');
  url.searchParams.set('offset', '0');
  url.searchParams.set('sortBy', 'REALIZEDPNL');
  url.searchParams.set('sortDirection', 'DESC');
  return getJson<ClosedPosition[]>(url, fetchImpl);
}

async function fetchProfile(wallet: string, fetchImpl: typeof fetch): Promise<WalletProfile | undefined> {
  const url = new URL(`${GAMMA_API}/public-profile`);
  url.searchParams.set('address', wallet);
  try {
    return await getJson<WalletProfile>(url, fetchImpl);
  } catch {
    return undefined;
  }
}

export async function profilePolymarketWallet(
  options: WalletProfilerOptions = {},
): Promise<WalletBenchmarkSnapshot> {
  const wallet = (options.wallet ?? DEFAULT_BENCHMARK_WALLET).toLowerCase();
  assertWallet(wallet);
  const fetchImpl = options.fetchImpl ?? fetch;
  const activityPages = Math.max(1, Math.min(20, options.activityPages ?? 4));
  const activityPageSize = Math.max(1, Math.min(500, options.activityPageSize ?? 500));

  const [profile, cryptoAllLeaderboard, overallAllLeaderboard, activity, topClosedPositions] = await Promise.all([
    fetchProfile(wallet, fetchImpl),
    fetchLeaderboard(wallet, 'CRYPTO', fetchImpl).catch(() => undefined),
    fetchLeaderboard(wallet, 'OVERALL', fetchImpl).catch(() => undefined),
    fetchActivity(wallet, activityPages, activityPageSize, fetchImpl),
    fetchTopClosedPositions(wallet, fetchImpl).catch(() => []),
  ]);

  return {
    wallet,
    capturedAt: new Date().toISOString(),
    profile,
    cryptoAllLeaderboard,
    overallAllLeaderboard,
    activitySummary: summarizeWalletActivity(activity),
    topClosedPositions,
    recentActivity: activity,
  };
}
