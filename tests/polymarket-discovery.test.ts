import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverShortHorizonCryptoMarkets, parseGammaMarket } from '../src/discovery/polymarket-gamma.js';

const now = Date.parse('2026-08-14T20:00:00Z');
const horizon = 6 * 60 * 60 * 1000;
const symbols = new Set(['BTC', 'ETH'] as const);

test('parses active short-horizon BTC Up/Down market and maps outcomes to token IDs', () => {
  const market = parseGammaMarket({
    id: '123',
    conditionId: '0xabc',
    slug: 'bitcoin-up-or-down-august-14-5pm-et',
    question: 'Bitcoin Up or Down - August 14, 5PM ET',
    startDate: '2026-08-14T20:00:00Z',
    endDate: '2026-08-14T20:15:00Z',
    closed: false,
    acceptingOrders: true,
    enableOrderBook: true,
    outcomes: '["Up", "Down"]',
    clobTokenIds: '["token-up", "token-down"]',
    orderPriceMinTickSize: 0.01,
    orderMinSize: 5,
    makerBaseFee: 0,
    takerBaseFee: 30,
  }, now, horizon, symbols);

  assert.ok(market);
  if (!market) throw new Error('expected market');
  assert.equal(market.underlying, 'BTC');
  assert.equal(market.tokens.length, 2);
  assert.equal(market.tokens[0]?.tokenId, 'token-up');
  assert.equal(market.tokens[0]?.outcome, 'Up');
  assert.equal(market.tokens[1]?.tokenId, 'token-down');
  assert.equal(market.tokens[1]?.outcome, 'Down');
  assert.equal(market.minOrderSize, 5);
});

test('rejects closed, unrelated, and too-distant markets', () => {
  const base = {
    id: '123',
    conditionId: '0xabc',
    slug: 'bitcoin-up-or-down',
    question: 'Bitcoin Up or Down?',
    endDate: '2026-08-14T20:15:00Z',
    outcomes: '["Up", "Down"]',
    clobTokenIds: '["a", "b"]',
  };

  assert.equal(parseGammaMarket({ ...base, closed: true }, now, horizon, symbols), null);
  assert.equal(parseGammaMarket({ ...base, question: 'Will Bitcoin hit $200k?', slug: 'bitcoin-200k' }, now, horizon, symbols), null);
  assert.equal(parseGammaMarket({ ...base, endDate: '2026-08-15T12:00:00Z' }, now, horizon, symbols), null);
});


test('CLOB V2 enrichment attaches dynamic market fee parameters to both outcomes', async () => {
  const gamma = [{
    id: '123', conditionId: '0xabc', slug: 'bitcoin-up-or-down-15m',
    question: 'Bitcoin Up or Down?', startDate: '2026-08-14T20:00:00Z', endDate: '2026-08-14T20:15:00Z',
    closed: false, acceptingOrders: true, enableOrderBook: true,
    outcomes: '["Up","Down"]', clobTokenIds: '["token-up","token-down"]',
  }];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/clob-markets/')) {
      return new Response(JSON.stringify({
        t: [{ t: 'token-up', o: 'Up' }, { t: 'token-down', o: 'Down' }],
        mos: 5, mts: 0.01, mbf: 0, tbf: 0,
        fd: { r: 0.07, e: 2, to: true }, oas: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(gamma), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const markets = await discoverShortHorizonCryptoMarkets({
    nowMs: now, horizonMinutes: 360, symbols: ['BTC'], fetchImpl,
  });
  assert.equal(markets.length, 1);
  assert.equal(markets[0]?.tokens[0]?.platformFeeRate, 0.07);
  assert.equal(markets[0]?.tokens[1]?.platformFeeExponent, 2);
  assert.equal(markets[0]?.tokens[0]?.platformFeeTakerOnly, true);
});
