import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichWithDexScreener, normalizePaidOrders } from '../src/scout/dexscreener.js';
import { parseGeckoTerminalNewPools } from '../src/scout/geckoterminal.js';
import { parseGoPlusSecurity } from '../src/scout/goplus.js';
import { labelScoutPerformance } from '../src/scout/performance.js';
import { assessEmergingAsset } from '../src/scout/scoring.js';
import { runScoutCycle } from '../src/scout/scanner.js';
import type { AssetSecuritySnapshot, EmergingAssetCandidate } from '../src/scout/types.js';

const now = Date.parse('2026-08-15T00:00:00Z');

function baseCandidate(): EmergingAssetCandidate {
  return {
    source: 'geckoterminal',
    chain: 'solana',
    tokenAddress: 'TOKEN123',
    tokenName: 'Test Token',
    tokenSymbol: 'TEST',
    pairAddress: 'PAIR1',
    discoveredAtMs: now,
    pairCreatedAtMs: now - 30 * 60_000,
    priceUsd: 0.01,
    liquidityUsd: 55_000,
    activity: {
      m5: { buys: 80, sells: 20, buyers: 70, sellers: 18, volumeUsd: 18_000, priceChangePct: 15 },
      h1: { buys: 300, sells: 150, buyers: 220, sellers: 110, volumeUsd: 95_000, priceChangePct: 30 },
    },
  };
}

test('GeckoTerminal parser normalizes new pool metrics without substituting FDV as market cap', () => {
  const rows = parseGeckoTerminalNewPools({
    data: [{
      id: 'solana_PAIR1',
      attributes: {
        address: 'PAIR1',
        base_token_price_usd: '0.01',
        pool_created_at: '2026-08-14T23:30:00Z',
        fdv_usd: '1000000',
        market_cap_usd: null,
        reserve_in_usd: '55000',
        price_change_percentage: { m5: '12.5', h1: '30' },
        transactions: { m5: { buys: 80, sells: 20, buyers: 70, sellers: 18 } },
        volume_usd: { m5: '18000' },
      },
      relationships: {
        base_token: { data: { id: 'solana_TOKEN123', type: 'token' } },
        quote_token: { data: { id: 'solana_USDC', type: 'token' } },
        dex: { data: { id: 'raydium', type: 'dex' } },
      },
    }],
    included: [
      { id: 'solana_TOKEN123', type: 'token', attributes: { address: 'TOKEN123', name: 'Test Token', symbol: 'TEST' } },
      { id: 'solana_USDC', type: 'token', attributes: { address: 'USDC', name: 'USD Coin', symbol: 'USDC' } },
    ],
  }, 'solana', now);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.tokenAddress, 'TOKEN123');
  assert.equal(rows[0]?.liquidityUsd, 55_000);
  assert.equal(rows[0]?.activity.m5?.buyers, 70);
  assert.equal(rows[0]?.fdvUsd, 1_000_000);
  assert.equal(rows[0]?.marketCapUsd, undefined);
});

test('DEX Screener enrichment chooses the deepest pool and marks paid promotion as risk metadata', () => {
  const enriched = enrichWithDexScreener(baseCandidate(), [
    {
      chainId: 'solana', dexId: 'dex-small', pairAddress: 'SMALL',
      baseToken: { address: 'TOKEN123', name: 'Test Token', symbol: 'TEST' },
      quoteToken: { address: 'USDC', symbol: 'USDC' },
      liquidity: { usd: 5_000 }, priceUsd: '0.009', boosts: { active: 0 },
    },
    {
      chainId: 'solana', dexId: 'dex-big', pairAddress: 'BIG',
      baseToken: { address: 'TOKEN123', name: 'Test Token', symbol: 'TEST' },
      quoteToken: { address: 'USDC', symbol: 'USDC' },
      liquidity: { usd: 80_000 }, priceUsd: '0.011', boosts: { active: 2 },
      txns: { m5: { buys: 100, sells: 25 } }, volume: { m5: 22_000 }, priceChange: { m5: 18 },
      info: { websites: [{ url: 'https://example.test' }], socials: [{ platform: 'x', handle: 'test' }] },
    },
  ], [{ type: 'tokenAd', status: 'approved' }]);

  assert.equal(enriched.pairAddress, 'BIG');
  assert.equal(enriched.liquidityUsd, 80_000);
  assert.equal(enriched.activeBoosts, 2);
  assert.equal(enriched.paidPromotion, true);
  assert.equal(enriched.activity.m5?.buys, 100);
});



test('DEX Screener paid-order parser fails closed on non-array payloads', () => {
  assert.deepEqual(normalizePaidOrders({ message: 'rate limited' }), []);
  assert.deepEqual(normalizePaidOrders(null), []);
  assert.equal(normalizePaidOrders({ orders: [{ type: 'tokenAd', status: 'approved' }] }).length, 1);
});

test('GoPlus parser rejects dangerous Solana authority/concentration signals', () => {
  const security = parseGoPlusSecurity({
    code: 1,
    result: {
      TOKEN123: {
        mintable: { status: '1', authority: { malicious_address: '0' } },
        freezable: { status: '1', authority: { malicious_address: '1' } },
        closable: { status: '0' },
        holder_count: '120',
        creator_percent: '0.55',
        holders: [
          { token_account: 'A', percent: '0.60', is_locked: 0 },
          { token_account: 'B', percent: '0.36', is_locked: 0 },
        ],
      },
    },
  }, 'TOKEN123', now);

  assert.equal(security.available, true);
  assert.equal(security.freezable, true);
  assert.equal(security.maliciousAuthority, true);
  assert.ok(Math.abs((security.creatorPercent ?? 0) - 55) < 1e-9);
  assert.equal(security.top10ConcentrationPct, 96);
  assert.equal(security.critical, true);
});

test('scoring never promotes a candidate to HIGH_INTEREST while security is unavailable', () => {
  const unknown: AssetSecuritySnapshot = {
    source: 'unknown', checkedAtMs: now, available: false, warnings: ['not configured'],
  };
  const result = assessEmergingAsset(baseCandidate(), unknown, [{
    chain: 'solana', tokenAddress: 'TOKEN123', kind: 'known_backer', strength: 'high', occurredAtMs: now,
    sourceName: 'official-project-post', verified: true,
  }]);
  assert.equal(result.status, 'SECURITY_PENDING');
  assert.ok(result.scores.opportunity > 50);
});

test('scoring can mark a liquid high-flow candidate HIGH_INTEREST only after a clean security result', () => {
  const clean: AssetSecuritySnapshot = {
    source: 'goplus', checkedAtMs: now, available: true, critical: false,
    mintable: false, freezable: false, closable: false, maliciousAuthority: false,
    holderCount: 1200, top10ConcentrationPct: 35, creatorPercent: 2, warnings: [],
  };
  const result = assessEmergingAsset(baseCandidate(), clean, [{
    chain: 'solana', tokenAddress: 'TOKEN123', kind: 'funding', strength: 'high', occurredAtMs: now,
    sourceName: 'official-announcement', verified: true,
  }], { highInterestOpportunity: 60 });
  assert.equal(result.status, 'HIGH_INTEREST');
  assert.ok(result.scores.risk < 35);
});

test('performance label computes forward return and drawdown from later observations only', () => {
  const result = labelScoutPerformance([
    { observedAtMs: now, chain: 'solana', tokenAddress: 'TOKEN123', priceUsd: 1, liquidityUsd: 10_000 },
    { observedAtMs: now + 2 * 60_000, chain: 'solana', tokenAddress: 'TOKEN123', priceUsd: 1.2, liquidityUsd: 11_000 },
    { observedAtMs: now + 5 * 60_000, chain: 'solana', tokenAddress: 'TOKEN123', priceUsd: 0.9, liquidityUsd: 9_000 },
    { observedAtMs: now + 60 * 60_000, chain: 'solana', tokenAddress: 'TOKEN123', priceUsd: 1.5, liquidityUsd: 15_000 },
  ], [5 * 60_000, 60 * 60_000], 0.05);

  assert.ok(result);
  assert.ok(Math.abs((result?.horizons[0]?.returnPct ?? 0) - (-10)) < 1e-9);
  assert.ok((result?.horizons[0]?.maxDrawdownPct ?? 0) < -20);
  assert.ok(Math.abs((result?.horizons[1]?.returnPct ?? 0) - 50) < 1e-9);
});


test('end-to-end scout cycle discovers, enriches and keeps unscanned candidates security-pending', async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = input instanceof URL ? input : new URL(String(input));
    if (url.hostname === 'api.geckoterminal.com') {
      return new Response(JSON.stringify({
        data: [{
          id: 'solana_PAIR1',
          attributes: {
            address: 'PAIR1', base_token_price_usd: '0.01', pool_created_at: '2026-08-14T23:30:00Z',
            reserve_in_usd: '55000', volume_usd: { m5: '18000', h1: '95000' },
            price_change_percentage: { m5: '15', h1: '30' },
            transactions: { m5: { buys: 80, sells: 20, buyers: 70, sellers: 18 } },
          },
          relationships: {
            base_token: { data: { id: 'solana_TOKEN123', type: 'token' } },
            quote_token: { data: { id: 'solana_USDC', type: 'token' } },
            dex: { data: { id: 'raydium', type: 'dex' } },
          },
        }],
        included: [
          { id: 'solana_TOKEN123', type: 'token', attributes: { address: 'TOKEN123', name: 'Test Token', symbol: 'TEST' } },
          { id: 'solana_USDC', type: 'token', attributes: { address: 'USDC', symbol: 'USDC' } },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname.startsWith('/token-pairs/')) {
      return new Response(JSON.stringify([{
        chainId: 'solana', dexId: 'raydium', pairAddress: 'PAIR1',
        baseToken: { address: 'TOKEN123', name: 'Test Token', symbol: 'TEST' },
        quoteToken: { address: 'USDC', symbol: 'USDC' },
        priceUsd: '0.011', liquidity: { usd: 60000 }, txns: { m5: { buys: 90, sells: 25 } },
        volume: { m5: 20000 }, priceChange: { m5: 17 }, boosts: { active: 0 },
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname.startsWith('/orders/')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };

  const result = await runScoutCycle({ chains: ['solana'], fetchImpl: fakeFetch, goPlusAccessToken: undefined });
  assert.equal(result.discovered, 1);
  assert.equal(result.assessed.length, 1);
  assert.equal(result.assessed[0]?.status, 'SECURITY_PENDING');
  assert.equal(result.assessed[0]?.candidate.liquidityUsd, 60_000);
  assert.equal(result.errors.length, 0);
});
