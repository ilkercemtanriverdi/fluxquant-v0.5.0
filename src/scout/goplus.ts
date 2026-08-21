import type { AssetSecuritySnapshot, EmergingAssetCandidate, SecurityHolder } from './types.js';

const BASE = 'https://api.gopluslabs.io/api/v1';

function flag(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return undefined;
}

function finite(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function statusFlag(value: unknown): boolean | undefined {
  if (value && typeof value === 'object') return flag((value as Record<string, unknown>).status);
  return flag(value);
}

function maliciousFrom(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  const direct = flag(obj.malicious_address);
  if (direct) return true;
  return Object.values(obj).some((child) => child && typeof child === 'object' && flag((child as Record<string, unknown>).malicious_address) === true);
}

function parseHolders(value: unknown): SecurityHolder[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const h = row as Record<string, unknown>;
    return {
      address: typeof h.address === 'string' ? h.address : typeof h.token_account === 'string' ? h.token_account : undefined,
      percent: finite(h.percent),
      locked: flag(h.is_locked),
      tag: typeof h.tag === 'string' ? h.tag : undefined,
    };
  });
}

function unwrapResult(payload: unknown, tokenAddress: string): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const root = payload as Record<string, unknown>;
  const result = root.result;
  if (!result || typeof result !== 'object') return undefined;
  const obj = result as Record<string, unknown>;
  const byAddress = obj[tokenAddress] ?? obj[tokenAddress.toLowerCase()] ?? obj[tokenAddress.toUpperCase()];
  if (byAddress && typeof byAddress === 'object') return byAddress as Record<string, unknown>;
  if ('metadata' in obj || 'holders' in obj || 'mintable' in obj) return obj;
  const first = Object.values(obj).find((x) => x && typeof x === 'object');
  return first as Record<string, unknown> | undefined;
}

export function parseGoPlusSecurity(payload: unknown, tokenAddress: string, nowMs = Date.now()): AssetSecuritySnapshot {
  const data = unwrapResult(payload, tokenAddress);
  if (!data) {
    return { source: 'goplus', checkedAtMs: nowMs, available: false, warnings: ['GoPlus returned no token security record.'], raw: payload };
  }

  const mintable = statusFlag(data.mintable ?? data.is_mintable);
  const freezable = statusFlag(data.freezable);
  const closable = statusFlag(data.closable);
  const metadataMutable = statusFlag(data.metadata_mutable);
  const transferHookUpgradable = statusFlag(data.transfer_hook_upgradable);
  const maliciousAuthority = [
    data.mintable,
    data.freezable,
    data.closable,
    data.metadata_mutable,
    data.transfer_hook_upgradable,
  ].some(maliciousFrom);
  const holders = parseHolders(data.holders);
  const top10ConcentrationPct = holders.length > 0
    ? holders.reduce((sum, h) => sum + (h.percent ?? 0), 0) * 100
    : undefined;
  const creatorPercentRaw = finite(data.creator_percent ?? data.owner_percent);
  const creatorPercent = creatorPercentRaw === undefined ? undefined : creatorPercentRaw <= 1 ? creatorPercentRaw * 100 : creatorPercentRaw;
  const holderCount = finite(data.holder_count);

  const warnings: string[] = [];
  if (mintable) warnings.push('Token remains mintable.');
  if (freezable) warnings.push('Token can freeze accounts/transfers.');
  if (closable) warnings.push('Token program/asset may be closable.');
  if (metadataMutable) warnings.push('Token metadata remains mutable.');
  if (transferHookUpgradable) warnings.push('Transfer hook is upgradable.');
  if (maliciousAuthority) warnings.push('A token authority is flagged malicious.');
  if (creatorPercent !== undefined && creatorPercent >= 20) warnings.push(`Creator concentration is high (${creatorPercent.toFixed(1)}%).`);
  if (top10ConcentrationPct !== undefined && top10ConcentrationPct >= 80) warnings.push(`Top-holder concentration is high (${top10ConcentrationPct.toFixed(1)}%).`);

  const critical = maliciousAuthority || freezable === true || closable === true || (creatorPercent ?? 0) >= 50 || (top10ConcentrationPct ?? 0) >= 95;
  return {
    source: 'goplus',
    checkedAtMs: nowMs,
    available: true,
    critical,
    mintable,
    freezable,
    closable,
    metadataMutable,
    transferHookUpgradable,
    maliciousAuthority,
    holderCount,
    topHolders: holders,
    top10ConcentrationPct,
    creatorPercent,
    warnings,
    raw: payload,
  };
}

export interface GoPlusOptions {
  accessToken?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export async function fetchGoPlusSecurity(
  candidate: EmergingAssetCandidate,
  options: GoPlusOptions = {},
): Promise<AssetSecuritySnapshot> {
  if (!options.accessToken) {
    return { source: 'unknown', checkedAtMs: Date.now(), available: false, warnings: ['Security provider credential not configured.'] };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? BASE;
  if (candidate.chain !== 'solana') {
    return { source: 'unknown', checkedAtMs: Date.now(), available: false, warnings: [`GoPlus v0.4 adapter currently enables Solana only; chain=${candidate.chain}.`] };
  }
  const url = new URL(`${base}/solana/token_security`);
  url.searchParams.set('contract_addresses', candidate.tokenAddress);
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${options.accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GoPlus HTTP ${response.status}`);
  return parseGoPlusSecurity(await response.json(), candidate.tokenAddress);
}
