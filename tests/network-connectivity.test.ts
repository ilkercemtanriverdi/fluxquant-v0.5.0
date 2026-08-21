import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPolymarketConnectivityFailure,
  probePolymarketConnectivity,
} from '../src/network/polymarket-connectivity.js';

test('network probe fails closed on observed access-block DNS address', async () => {
  let fetched = false;
  const result = await probePolymarketConnectivity({
    resolve4Impl: async () => ['195.175.254.2'],
    fetchImpl: (async () => {
      fetched = true;
      return new Response('ok');
    }) as typeof fetch,
  });
  assert.equal(result.state, 'BLOCKED_BY_NETWORK');
  assert.equal(fetched, false);
});

test('TLS certificate interception is classified as blocked-by-network', () => {
  const cause = Object.assign(new Error('hostname mismatch'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  const wrapped = Object.assign(new Error('fetch failed'), { cause });
  const result = classifyPolymarketConnectivityFailure(wrapped, ['1.2.3.4']);
  assert.equal(result.state, 'BLOCKED_BY_NETWORK');
  assert.equal(result.errorCode, 'ERR_TLS_CERT_ALTNAME_INVALID');
});

test('normal public API response is AVAILABLE', async () => {
  const result = await probePolymarketConnectivity({
    resolve4Impl: async () => ['104.18.1.1'],
    fetchImpl: (async () => new Response('[]', { status: 200 })) as typeof fetch,
  });
  assert.equal(result.state, 'AVAILABLE');
});

test('DNS diagnostics are bounded so an unresponsive resolver cannot hang eligibility', async () => {
  const never = new Promise<string[]>(() => {});
  const fetchImpl = async () => new Response('[]', { status: 200 }) as Response;
  const started = Date.now();
  const result = await probePolymarketConnectivity({
    resolve4Impl: async () => never,
    fetchImpl: fetchImpl as typeof fetch,
    timeoutMs: 25,
  });
  assert.equal(result.state, 'AVAILABLE');
  assert.ok(Date.now() - started < 500, 'DNS timeout should be bounded');
});
