import type {
  CryptoUnderlying,
  DiscoveredPolymarketMarket,
  PolymarketTokenMetadata,
} from '../domain/types.js';

const GAMMA_MARKETS_URL = 'https://gamma-api.polymarket.com/markets';
const CLOB_MARKET_INFO_URL = 'https://clob.polymarket.com/clob-markets';

interface GammaMarket {
  id?: string | number;
  question?: string;
  conditionId?: string;
  slug?: string;
  startDate?: string;
  endDate?: string;
  endDateIso?: string;
  closed?: boolean;
  archived?: boolean;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  outcomes?: string | string[];
  clobTokenIds?: string | string[];
  orderPriceMinTickSize?: string | number;
  orderMinSize?: string | number;
  makerBaseFee?: string | number;
  takerBaseFee?: string | number;
}

interface ClobMarketInfo {
  t?: Array<{ t?: unknown; o?: unknown }>;
  mos?: unknown;
  mts?: unknown;
  mbf?: unknown;
  tbf?: unknown;
  fd?: { r?: unknown; e?: unknown; to?: unknown };
  oas?: unknown;
}

export interface PolymarketDiscoveryOptions {
  nowMs?: number;
  horizonMinutes?: number;
  symbols?: CryptoUnderlying[];
  limit?: number;
  fetchImpl?: typeof fetch;
  /** Set false in deterministic/unit tests to skip CLOB V2 enrichment. */
  includeFees?: boolean;
}

function parseArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || value.trim() === '') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Some legacy Gamma payloads are simple comma-separated strings.
  }
  return value.split(',').map((x) => x.trim()).filter(Boolean);
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function timeMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : undefined;
}

function detectUnderlying(text: string): CryptoUnderlying | null {
  const normalized = text.toLowerCase();
  if (/\b(bitcoin|btc)\b/.test(normalized)) return 'BTC';
  if (/\b(ethereum|ether|eth)\b/.test(normalized)) return 'ETH';
  return null;
}

function looksLikeShortHorizonUpDown(question: string, slug: string): boolean {
  const text = `${question} ${slug}`.toLowerCase();
  return (
    (text.includes('up') && text.includes('down')) ||
    (text.includes('higher') && text.includes('lower')) ||
    text.includes('up-or-down') ||
    text.includes('higher-or-lower')
  );
}

export function parseGammaMarket(
  raw: GammaMarket,
  nowMs: number,
  horizonMs: number,
  symbols: ReadonlySet<CryptoUnderlying>,
): DiscoveredPolymarketMarket | null {
  if (raw.closed === true || raw.archived === true) return null;
  if (raw.acceptingOrders === false || raw.enableOrderBook === false) return null;

  const question = String(raw.question ?? '');
  const slug = String(raw.slug ?? '');
  const underlying = detectUnderlying(`${question} ${slug}`);
  if (!underlying || !symbols.has(underlying)) return null;
  if (!looksLikeShortHorizonUpDown(question, slug)) return null;

  const expiryTimeMs = timeMs(raw.endDateIso ?? raw.endDate);
  if (!expiryTimeMs || expiryTimeMs <= nowMs || expiryTimeMs > nowMs + horizonMs) return null;

  const outcomes = parseArray(raw.outcomes);
  const tokenIds = parseArray(raw.clobTokenIds);
  if (outcomes.length < 2 || outcomes.length !== tokenIds.length) return null;

  const marketId = String(raw.id ?? '');
  const conditionId = String(raw.conditionId ?? '');
  if (!marketId || !conditionId || !slug) return null;

  const startTimeMs = timeMs(raw.startDate);
  const tickSize = finiteNumber(raw.orderPriceMinTickSize);
  const minOrderSize = finiteNumber(raw.orderMinSize);
  const gammaMakerBaseFeeBps = finiteNumber(raw.makerBaseFee);
  const gammaTakerBaseFeeBps = finiteNumber(raw.takerBaseFee);

  const tokens: PolymarketTokenMetadata[] = tokenIds.map((tokenId, index) => ({
    tokenId,
    outcome: outcomes[index] ?? `outcome-${index}`,
    marketId,
    conditionId,
    slug,
    question,
    underlying,
    startTimeMs,
    expiryTimeMs,
    tickSize,
    minOrderSize,
    gammaMakerBaseFeeBps,
    gammaTakerBaseFeeBps,
  }));

  return {
    marketId,
    conditionId,
    slug,
    question,
    underlying,
    startTimeMs,
    expiryTimeMs,
    tickSize,
    minOrderSize,
    tokens,
  };
}

async function enrichWithClobV2(
  market: DiscoveredPolymarketMarket,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    const response = await fetchImpl(
      `${CLOB_MARKET_INFO_URL}/${encodeURIComponent(market.conditionId)}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) return;
    const info = await response.json() as ClobMarketInfo;

    const tickSize = finiteNumber(info.mts);
    const minOrderSize = finiteNumber(info.mos);
    const makerBaseFeeBps = finiteNumber(info.mbf);
    const takerBaseFeeBps = finiteNumber(info.tbf);
    const platformFeeRate = finiteNumber(info.fd?.r);
    const platformFeeExponent = finiteNumber(info.fd?.e);
    const platformFeeTakerOnly = typeof info.fd?.to === 'boolean' ? info.fd.to : undefined;
    const minOrderAgeSeconds = finiteNumber(info.oas);

    if (tickSize !== undefined) market.tickSize = tickSize;
    if (minOrderSize !== undefined) market.minOrderSize = minOrderSize;

    const clobOutcomes = new Map<string, string>();
    for (const token of info.t ?? []) {
      const tokenId = token.t == null ? '' : String(token.t);
      const outcome = token.o == null ? '' : String(token.o);
      if (tokenId && outcome) clobOutcomes.set(tokenId, outcome);
    }

    for (const token of market.tokens) {
      token.tickSize = tickSize ?? token.tickSize;
      token.minOrderSize = minOrderSize ?? token.minOrderSize;
      token.clobMakerBaseFeeBps = makerBaseFeeBps;
      token.clobTakerBaseFeeBps = takerBaseFeeBps;
      token.platformFeeRate = platformFeeRate;
      token.platformFeeExponent = platformFeeExponent;
      token.platformFeeTakerOnly = platformFeeTakerOnly;
      token.minOrderAgeSeconds = minOrderAgeSeconds;
      token.outcome = clobOutcomes.get(token.tokenId) ?? token.outcome;
    }
  } catch {
    // Discovery remains useful if CLOB metadata enrichment is temporarily unavailable.
  }
}

export async function discoverShortHorizonCryptoMarkets(
  options: PolymarketDiscoveryOptions = {},
): Promise<DiscoveredPolymarketMarket[]> {
  const nowMs = options.nowMs ?? Date.now();
  const horizonMinutes = options.horizonMinutes ?? 360;
  const horizonMs = horizonMinutes * 60_000;
  const symbols = new Set<CryptoUnderlying>(options.symbols ?? ['BTC', 'ETH']);
  const limit = options.limit ?? 500;
  const fetchImpl = options.fetchImpl ?? fetch;

  const url = new URL(GAMMA_MARKETS_URL);
  url.searchParams.set('closed', 'false');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('order', 'endDate');
  url.searchParams.set('ascending', 'true');
  url.searchParams.set('end_date_min', new Date(nowMs).toISOString());
  url.searchParams.set('end_date_max', new Date(nowMs + horizonMs).toISOString());

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Polymarket Gamma discovery failed: HTTP ${response.status}`);
  }

  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new Error('Polymarket Gamma discovery returned a non-array payload.');

  const markets = payload
    .map((raw) => parseGammaMarket(raw as GammaMarket, nowMs, horizonMs, symbols))
    .filter((market): market is DiscoveredPolymarketMarket => market !== null)
    .sort((a, b) => a.expiryTimeMs - b.expiryTimeMs);

  if (options.includeFees !== false) {
    // CLOB V2 metadata is fetched per condition. Keep concurrency bounded.
    for (let i = 0; i < markets.length; i += 8) {
      await Promise.all(markets.slice(i, i + 8).map((market) => enrichWithClobV2(market, fetchImpl)));
    }
  }

  return markets;
}

export function buildTokenMetadataMap(
  markets: DiscoveredPolymarketMarket[],
): Map<string, PolymarketTokenMetadata> {
  const map = new Map<string, PolymarketTokenMetadata>();
  for (const market of markets) {
    for (const token of market.tokens) map.set(token.tokenId, token);
  }
  return map;
}
