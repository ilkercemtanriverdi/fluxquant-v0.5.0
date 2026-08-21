import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiscoveredPolymarketMarket, MarketEvent, PolymarketTokenMetadata } from '../src/domain/types.js';
import { PairExecutionValidator } from '../src/scan/pair-execution-validator.js';

function token(id: string, outcome: 'UP'|'DOWN', start: number, expiry: number): PolymarketTokenMetadata {
  return { tokenId:id, outcome, marketId:'m1', conditionId:'c1', slug:'s', question:'q', underlying:'BTC', startTimeMs:start, expiryTimeMs:expiry };
}
function market(start:number, expiry:number): DiscoveredPolymarketMarket {
  return { marketId:'m1', conditionId:'c1', slug:'s', question:'q', underlying:'BTC', startTimeMs:start, expiryTimeMs:expiry,
    tokens:[token('up','UP',start,expiry),token('down','DOWN',start,expiry)] };
}
function book(meta: PolymarketTokenMetadata, eventTime:number, receivedTime:number, ask:number): MarketEvent {
  return { venue:'polymarket', kind:'book', instrument:meta.tokenId, eventTimeMs:eventTime, receivedTimeMs:receivedTime,
    polymarket:meta, rawType:'fixture', raw:{ bids:[{price:Math.max(0,ask-0.01),size:1}], asks:[{price:ask,size:1}], historical_l2_reconstructed:true } };
}

test('received-time validator keeps edge that survives 100ms and 1c/leg stress', () => {
  const start=1_900_000_000_000, expiry=start+60_000, m=market(start,expiry); const [up,down]=m.tokens; assert.ok(up&&down);
  const v=new PairExecutionValidator([m], { fallbackPlatformFeeRate:0.07, freshnessMs:500, minLockedReturnOnCost:0.015,
    latenciesMs:[100], slippagePerLeg:[0.01] });
  v.applyReceivedBatch(start+1010,[book(up,start+1000,start+1010,0.40)]);
  v.applyReceivedBatch(start+1020,[book(down,start+1005,start+1020,0.40)]);
  // Next market update arrives after the 100ms target, so quotes known at target persist.
  v.applyReceivedBatch(start+1200,[book(up,start+1190,start+1200,0.45)]);
  const r=v.finish(); const s=r.scenarios[0];
  assert.equal(r.detectionAttempts.length,1); assert.equal(s?.executed,1); assert.ok((s?.lockedPnlUsd??0)>0);
});

test('validator rejects edge that decays before latency target', () => {
  const start=1_900_100_000_000, expiry=start+60_000, m=market(start,expiry); const [up,down]=m.tokens; assert.ok(up&&down);
  const v=new PairExecutionValidator([m], { fallbackPlatformFeeRate:0.07, freshnessMs:500, minLockedReturnOnCost:0.015,
    latenciesMs:[100], slippagePerLeg:[0] });
  v.applyReceivedBatch(start+1010,[book(up,start+1000,start+1010,0.40)]);
  v.applyReceivedBatch(start+1020,[book(down,start+1005,start+1020,0.40)]);
  v.applyReceivedBatch(start+1070,[book(up,start+1065,start+1070,0.58)]);
  const r=v.finish(); const s=r.scenarios[0];
  assert.equal(s?.executed,0); assert.equal(s?.rejected.EDGE_DECAYED,1);
});

test('same received-time batch cannot create line-order phantom opportunity', () => {
  const start=1_900_200_000_000, expiry=start+60_000, m=market(start,expiry); const [up,down]=m.tokens; assert.ok(up&&down);
  const v=new PairExecutionValidator([m], { fallbackPlatformFeeRate:0.07, freshnessMs:500, minLockedReturnOnCost:0.015,
    latenciesMs:[0], slippagePerLeg:[0] });
  v.applyReceivedBatch(start+1000,[
    book(up,start+990,start+1000,0.40),
    book(down,start+990,start+1000,0.70),
  ]);
  const r=v.finish();
  assert.equal(r.detectionAttempts.length,0); assert.equal(r.scenarios[0]?.executed,0);
});

test('received-time age includes transport delay and rejects stale source quote', () => {
  const start=1_900_300_000_000, expiry=start+60_000, m=market(start,expiry); const [up,down]=m.tokens; assert.ok(up&&down);
  const v=new PairExecutionValidator([m], { fallbackPlatformFeeRate:0.07, freshnessMs:500, minLockedReturnOnCost:0.015,
    latenciesMs:[0], slippagePerLeg:[0] });
  v.applyReceivedBatch(start+1700,[book(up,start+1000,start+1700,0.40),book(down,start+1000,start+1700,0.40)]);
  const r=v.finish();
  assert.equal(r.detectionAttempts.length,0);
});

test('one fill per market prevents repeated historical top quote scaling', () => {
  const start=1_900_400_000_000, expiry=start+60_000, m=market(start,expiry); const [up,down]=m.tokens; assert.ok(up&&down);
  const v=new PairExecutionValidator([m], { fallbackPlatformFeeRate:0.07, freshnessMs:500, minLockedReturnOnCost:0.015,
    latenciesMs:[0], slippagePerLeg:[0], oneFillPerMarket:true });
  v.applyReceivedBatch(start+1000,[book(up,start+995,start+1000,0.40),book(down,start+995,start+1000,0.40)]);
  v.applyReceivedBatch(start+1100,[book(up,start+1095,start+1100,0.60),book(down,start+1095,start+1100,0.60)]);
  v.applyReceivedBatch(start+1200,[book(up,start+1195,start+1200,0.40),book(down,start+1195,start+1200,0.40)]);
  const r=v.finish(); const s=r.scenarios[0];
  assert.equal(r.detectionAttempts.length,2); assert.equal(s?.executed,1); assert.equal(s?.rejected.ALREADY_FILLED_MARKET,1);
});

test('top-only synthetic historical depth is rejected by default', () => {
  const start=1_900_500_000_000, expiry=start+60_000, m=market(start,expiry); const [up,down]=m.tokens; assert.ok(up&&down);
  const v=new PairExecutionValidator([m], { fallbackPlatformFeeRate:0.07, freshnessMs:500, minLockedReturnOnCost:0.015,
    latenciesMs:[0], slippagePerLeg:[0] });
  const topOnly=(meta:PolymarketTokenMetadata):MarketEvent=>({ venue:'polymarket', kind:'book', instrument:meta.tokenId,
    eventTimeMs:start+995, receivedTimeMs:start+1000, polymarket:meta,
    raw:{bids:[{price:0.39,size:10}],asks:[{price:0.40,size:10}],historical_top_only:true}});
  v.applyReceivedBatch(start+1000,[topOnly(up),topOnly(down)]);
  const r=v.finish();
  assert.equal(r.evidenceClass,'TOP_ONLY_UNTRUSTED');
  assert.equal(r.detectionAttempts.length,0);
});

test('market-rule stress can enforce minimum order size and tick rounding', () => {
  const start=1_900_600_000_000, expiry=start+60_000, m=market(start,expiry); const [up,down]=m.tokens; assert.ok(up&&down);
  const v=new PairExecutionValidator([m], { fallbackPlatformFeeRate:0.07, freshnessMs:500, minLockedReturnOnCost:0.015,
    shares:5, latenciesMs:[0], slippagePerLeg:[0.003], assumedMinOrderSize:5, assumedTickSize:0.01, requireMarketRules:true });
  const deep=(meta:PolymarketTokenMetadata,ask:number):MarketEvent=>({ venue:'polymarket', kind:'book', instrument:meta.tokenId,
    eventTimeMs:start+995, receivedTimeMs:start+1000, polymarket:meta,
    raw:{bids:[{price:ask-0.01,size:10}],asks:[{price:ask,size:10}],historical_l2_reconstructed:true}});
  v.applyReceivedBatch(start+1000,[deep(up,0.40),deep(down,0.40)]);
  const r=v.finish();
  assert.equal(r.scenarios[0]?.executed,1);
  assert.equal(r.assumedMinOrderSize,5);
  assert.equal(r.assumedTickSize,0.01);
  const check=r.checks.find(c=>c.executed);
  assert.equal(check?.stressedUpPrice,0.41);
});

test('best-bid-ask telemetry cannot refresh executable L2 freshness', () => {
  const start=1_900_700_000_000, expiry=start+60_000, m=market(start,expiry); const [up,down]=m.tokens; assert.ok(up&&down);
  const v=new PairExecutionValidator([m], { fallbackPlatformFeeRate:0.07, freshnessMs:100, minLockedReturnOnCost:0.015,
    latenciesMs:[0], slippagePerLeg:[0] });
  const deep=(meta:PolymarketTokenMetadata):MarketEvent=>({ venue:'polymarket', kind:'book', instrument:meta.tokenId,
    eventTimeMs:start+1000, receivedTimeMs:start+1000, polymarket:meta, raw:{bids:[{price:0.39,size:10}],asks:[{price:0.40,size:10}],historical_l2_reconstructed:true}});
  v.applyReceivedBatch(start+1000,[deep(up),deep(down)]);
  const bba=(meta:PolymarketTokenMetadata):MarketEvent=>({ venue:'polymarket', kind:'best_bid_ask', instrument:meta.tokenId,
    eventTimeMs:start+1200, receivedTimeMs:start+1200, polymarket:meta, bid:0.39, ask:0.40, rawType:'best_bid_ask', raw:{best_bid:'0.39',best_ask:'0.40'}});
  v.applyReceivedBatch(start+1200,[bba(up),bba(down)]);
  const r=v.finish();
  assert.equal(r.detectionAttempts.length,1);
  assert.equal(r.scenarios[0]?.executed,1);
});
