import { resolve4 } from 'node:dns/promises';

export type PolymarketConnectivityState = 'AVAILABLE' | 'BLOCKED_BY_NETWORK' | 'UNAVAILABLE';

export interface PolymarketConnectivityResult {
  state: PolymarketConnectivityState;
  hostname: string;
  resolvedAddresses: string[];
  reason: string;
  errorCode?: string;
}

export interface PolymarketConnectivityOptions {
  fetchImpl?: typeof fetch;
  resolve4Impl?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  url?: string;
}

const DEFAULT_URL = 'https://gamma-api.polymarket.com/markets?limit=1&active=true&closed=false';
const OBSERVED_BLOCK_ADDRESSES = new Set(['195.175.254.2']);
const TLS_INTERCEPT_CODES = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function collectErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const obj = current as { code?: unknown; cause?: unknown };
    if (typeof obj.code === 'string') codes.push(obj.code);
    current = obj.cause;
  }
  return codes;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyPolymarketConnectivityFailure(
  error: unknown,
  resolvedAddresses: readonly string[] = [],
): PolymarketConnectivityResult {
  const codes = collectErrorCodes(error);
  const tlsCode = codes.find((code) => TLS_INTERCEPT_CODES.has(code));
  const blockAddress = resolvedAddresses.find((address) => OBSERVED_BLOCK_ADDRESSES.has(address));
  if (tlsCode || blockAddress) {
    return {
      state: 'BLOCKED_BY_NETWORK',
      hostname: 'gamma-api.polymarket.com',
      resolvedAddresses: [...resolvedAddresses],
      reason: tlsCode
        ? `TLS interception/certificate mismatch detected (${tlsCode}); FluxQuant will not disable certificate verification or bypass the network block.`
        : `DNS resolved to an observed access-block address (${blockAddress}); FluxQuant will not bypass the restriction.`,
      errorCode: tlsCode,
    };
  }
  return {
    state: 'UNAVAILABLE',
    hostname: 'gamma-api.polymarket.com',
    resolvedAddresses: [...resolvedAddresses],
    reason: `Polymarket public API unavailable: ${messageOf(error)}`,
    errorCode: codes[0],
  };
}

export async function probePolymarketConnectivity(
  options: PolymarketConnectivityOptions = {},
): Promise<PolymarketConnectivityResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolve4Impl = options.resolve4Impl ?? resolve4;
  const url = new URL(options.url ?? DEFAULT_URL);
  const timeoutMs = options.timeoutMs ?? 8_000;
  let resolvedAddresses: string[] = [];
  try {
    const dnsTimeoutMs = Math.min(timeoutMs, 3_000);
    resolvedAddresses = await Promise.race([
      resolve4Impl(url.hostname),
      new Promise<string[]>((_, reject) => {
        setTimeout(() => reject(new Error('DNS_PROBE_TIMEOUT')), dnsTimeoutMs);
      }),
    ]);
  } catch {
    // Fetch below remains authoritative for availability; DNS diagnostics are best-effort and bounded.
  }

  if (resolvedAddresses.some((address) => OBSERVED_BLOCK_ADDRESSES.has(address))) {
    return {
      state: 'BLOCKED_BY_NETWORK',
      hostname: url.hostname,
      resolvedAddresses,
      reason: `DNS resolved to an observed access-block address; FluxQuant will not bypass the restriction.`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'FluxQuant/1.5 research-only' },
    });
    if (!response.ok) {
      return {
        state: 'UNAVAILABLE',
        hostname: url.hostname,
        resolvedAddresses,
        reason: `Polymarket public API returned HTTP ${response.status}.`,
      };
    }
    return {
      state: 'AVAILABLE',
      hostname: url.hostname,
      resolvedAddresses,
      reason: 'Public API reachable with normal TLS verification.',
    };
  } catch (error) {
    const classified = classifyPolymarketConnectivityFailure(error, resolvedAddresses);
    return { ...classified, hostname: url.hostname };
  } finally {
    clearTimeout(timer);
  }
}
