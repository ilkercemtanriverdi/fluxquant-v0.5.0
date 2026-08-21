import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWalletActivity } from '../src/benchmark/polymarket-wallet.js';

test('benchmark summary detects two-sided BUY rotation within a market', () => {
  const summary = summarizeWalletActivity([
    { timestamp: 1_786_737_600, conditionId: '0x1', type: 'TRADE', usdcSize: 4.8, asset: 'up', side: 'BUY', title: 'Bitcoin Up or Down?' },
    { timestamp: 1_786_737_660, conditionId: '0x1', type: 'TRADE', usdcSize: 4.1, asset: 'down', side: 'BUY', title: 'Bitcoin Up or Down?' },
    { timestamp: 1_786_737_720, conditionId: '0x1', type: 'REDEEM' },
  ]);

  assert.equal(summary.tradeCount, 2);
  assert.equal(summary.buyCount, 2);
  assert.equal(summary.sellCount, 0);
  assert.equal(summary.redeemCount, 1);
  assert.equal(summary.marketsWithBothOutcomesBought, 1);
  assert.equal(summary.twoSidedBuyMarketShare, 1);
});
