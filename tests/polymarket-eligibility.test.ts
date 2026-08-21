import test from 'node:test';
import assert from 'node:assert/strict';
import { probePolymarketGeoblock } from '../src/network/polymarket-eligibility.js';

test('geoblock probe fails closed when official endpoint says blocked', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ blocked: true, country: 'XX', region: 'YY' }), { status: 200 });
  const result = await probePolymarketGeoblock({ fetchImpl: fetchImpl as typeof fetch });
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.blocked, true);
});

test('geoblock probe accepts explicit unblocked response', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ blocked: false, country: 'TR', region: '' }), { status: 200 });
  const result = await probePolymarketGeoblock({ fetchImpl: fetchImpl as typeof fetch });
  assert.equal(result.state, 'ELIGIBLE');
});

test('geoblock probe treats malformed response as unavailable', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ country: 'TR' }), { status: 200 });
  const result = await probePolymarketGeoblock({ fetchImpl: fetchImpl as typeof fetch });
  assert.equal(result.state, 'UNAVAILABLE');
});
