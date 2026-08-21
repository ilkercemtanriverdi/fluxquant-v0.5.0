import { resolve } from 'node:path';
import { profilePolymarketWallet, DEFAULT_BENCHMARK_WALLET } from './benchmark/polymarket-wallet.js';
import { MarketBus } from './core/market-bus.js';
import type { PolymarketTokenMetadata } from './domain/types.js';
import {
  buildTokenMetadataMap,
  discoverShortHorizonCryptoMarkets,
} from './discovery/polymarket-gamma.js';
import { BinanceFeed } from './feeds/binance.js';
import { PolymarketFeed } from './feeds/polymarket.js';
import { writeJsonSnapshot } from './metadata/json-snapshot.js';
import { probePolymarketConnectivity } from './network/polymarket-connectivity.js';
import { JsonlRecorder } from './recording/jsonl-recorder.js';
import { validateMode } from './security/live-gate.js';

async function main(): Promise<void> {
  const mode = validateMode(process.env.FLUXQUANT_MODE);
  const legacySymbol = process.env.BINANCE_SYMBOL?.trim();
  const binanceSymbols = (process.env.BINANCE_SYMBOLS ?? legacySymbol ?? 'btcusdt,ethusdt')
    .split(',')
    .map((x: string) => x.trim().toLowerCase())
    .filter(Boolean);
  const manualAssetIds = (process.env.POLYMARKET_ASSET_IDS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const discoveryEnabled = process.env.POLYMARKET_AUTO_DISCOVERY !== 'false';
  const networkProbeEnabled = process.env.POLYMARKET_NETWORK_PROBE !== 'false';
  const benchmarkEnabled = process.env.BENCHMARK_ENABLED !== 'false';
  const benchmarkWallet = (process.env.BENCHMARK_WALLET ?? DEFAULT_BENCHMARK_WALLET).toLowerCase();
  const benchmarkActivityPages = Number(process.env.BENCHMARK_ACTIVITY_PAGES ?? '4');
  const discoveryHorizonMinutes = Number(process.env.POLYMARKET_DISCOVERY_HORIZON_MIN ?? '360');
  const dataDir = resolve(process.env.DATA_DIR ?? './data');
  const date = new Date().toISOString().slice(0, 10);
  const output = resolve(dataDir, `market-events-${date}.jsonl`);
  const metadataOutput = resolve(dataDir, `polymarket-markets-${date}.json`);
  const benchmarkOutput = resolve(dataDir, `benchmark-wallet-${date}.json`);

  console.log(`[fluxquant] mode=${mode}`);
  console.log(`[fluxquant] recorder=${output}`);
  console.log('[fluxquant] live execution: DISABLED');

  let assetIds = manualAssetIds;
  let metadataByToken = new Map<string, PolymarketTokenMetadata>();
  let polymarketNetworkAvailable = true;

  if (networkProbeEnabled && (discoveryEnabled || benchmarkEnabled || manualAssetIds.length > 0)) {
    const connectivity = await probePolymarketConnectivity();
    const addressText = connectivity.resolvedAddresses.length > 0
      ? ` addresses=${connectivity.resolvedAddresses.join(',')}`
      : '';
    console.log(`[polymarket] connectivity=${connectivity.state}${addressText}`);
    if (connectivity.state !== 'AVAILABLE') {
      polymarketNetworkAvailable = false;
      console.warn(`[polymarket] ${connectivity.reason}`);
      console.warn('[polymarket] public live-data path disabled; Binance/Scout research continues.');
    }
  }

  if (!polymarketNetworkAvailable) {
    assetIds = [];
  } else if (manualAssetIds.length > 0) {
    console.log(`[polymarket] using ${manualAssetIds.length} manually configured asset IDs`);
  } else if (discoveryEnabled) {
    try {
      const discoverySymbols = [...new Set(binanceSymbols.flatMap((symbol) =>
        symbol.startsWith('btc') ? ['BTC' as const] : symbol.startsWith('eth') ? ['ETH' as const] : [],
      ))];
      const markets = await discoverShortHorizonCryptoMarkets({
        horizonMinutes: discoveryHorizonMinutes,
        symbols: discoverySymbols.length > 0 ? discoverySymbols : ['BTC', 'ETH'],
      });
      metadataByToken = buildTokenMetadataMap(markets);
      assetIds = [...metadataByToken.keys()];
      await writeJsonSnapshot(metadataOutput, {
        discoveredAt: new Date().toISOString(),
        horizonMinutes: discoveryHorizonMinutes,
        markets,
      });
      console.log(`[polymarket] discovered ${markets.length} BTC/ETH short-horizon markets / ${assetIds.length} tokens`);
      console.log(`[polymarket] metadata=${metadataOutput}`);
      for (const market of markets.slice(0, 8)) {
        console.log(`[polymarket] ${market.underlying} ${market.slug} expires=${new Date(market.expiryTimeMs).toISOString()}`);
      }
    } catch (error) {
      console.error('[polymarket] auto-discovery failed; continuing Binance-only unless manual IDs are configured.', error);
    }
  }

  const bus = new MarketBus();
  const recorder = new JsonlRecorder(output);
  let count = 0;
  let binanceCount = 0;
  let polymarketCount = 0;

  bus.subscribe((event) => {
    count += 1;
    if (event.venue === 'binance') binanceCount += 1;
    if (event.venue === 'polymarket') polymarketCount += 1;
    void recorder.record(event).catch((error) => console.error('[recorder] write error', error));
    if (count % 100 === 0) {
      const outcome = event.polymarket?.outcome ? `:${event.polymarket.outcome}` : '';
      console.log(`[fluxquant] recorded ${count} events; last=${event.venue}:${event.kind}:${event.instrument}${outcome}`);
    }
    if (count % 1000 === 0) {
      console.log(`[fluxquant] venue-counts binance=${binanceCount} polymarket=${polymarketCount}`);
    }
  });

  const binanceFeeds = binanceSymbols.map((symbol) => new BinanceFeed(bus, symbol));
  const polymarket = new PolymarketFeed(bus, assetIds, metadataByToken);

  console.log(`[binance] symbols=${binanceSymbols.join(',')}`);
  for (const feed of binanceFeeds) feed.start();
  polymarket.start();

  if (benchmarkEnabled && polymarketNetworkAvailable) {
    void profilePolymarketWallet({
      wallet: benchmarkWallet,
      activityPages: benchmarkActivityPages,
      activityPageSize: 500,
    }).then(async (snapshot) => {
      await writeJsonSnapshot(benchmarkOutput, snapshot);
      const s = snapshot.activitySummary;
      console.log(`[benchmark] wallet=${snapshot.wallet} trades=${s.tradeCount} buys=${s.buyCount} sells=${s.sellCount} two-sided=${(s.twoSidedBuyMarketShare * 100).toFixed(1)}%`);
      console.log(`[benchmark] snapshot=${benchmarkOutput}`);
    }).catch((error) => {
      console.error('[benchmark] profiler unavailable; recorder continues.', error);
    });
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[fluxquant] stopping feeds');
    for (const feed of binanceFeeds) feed.stop();
    polymarket.stop();
    try {
      await recorder.close();
    } catch (error) {
      console.error('[recorder] close error', error);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((error) => {
  console.error('[fluxquant] fatal startup error', error);
  process.exitCode = 1;
});
