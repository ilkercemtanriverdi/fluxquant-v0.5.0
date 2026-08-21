import type { ShadowStrategy } from '../shadow/replay-trader.js';

export type QuotePresetName = 'legacy' | 'strict';

export interface QuotePolicy {
  name: QuotePresetName;
  maxBinanceBookAgeMs: number;
  maxPolymarketBookAgeMs: number;
  maxCrossOutcomeQuoteSkewMs: number;
}

export const QUOTE_PRESETS: Readonly<Record<QuotePresetName, QuotePolicy>> = {
  legacy: {
    name: 'legacy',
    maxBinanceBookAgeMs: 2_000,
    maxPolymarketBookAgeMs: 5_000,
    maxCrossOutcomeQuoteSkewMs: 5_000,
  },
  strict: {
    name: 'strict',
    maxBinanceBookAgeMs: 500,
    maxPolymarketBookAgeMs: 500,
    maxCrossOutcomeQuoteSkewMs: 500,
  },
};

export interface StrategyDataDependencies {
  requiresBinance: boolean;
  requiresPolymarketUp: boolean;
  requiresPolymarketDown: boolean;
  requiresCrossOutcomeSynchronization: boolean;
}

export function strategyDataDependencies(strategy: ShadowStrategy): StrategyDataDependencies {
  if (strategy === 'model') {
    return {
      requiresBinance: true,
      requiresPolymarketUp: true,
      requiresPolymarketDown: true,
      requiresCrossOutcomeSynchronization: true,
    };
  }
  return {
    requiresBinance: false,
    requiresPolymarketUp: true,
    requiresPolymarketDown: true,
    requiresCrossOutcomeSynchronization: true,
  };
}

export function getQuotePreset(name: string | undefined): QuotePolicy {
  const key = (name ?? 'strict') as QuotePresetName;
  const policy = QUOTE_PRESETS[key];
  if (!policy) throw new Error(`Invalid quote preset: ${name}. Allowed: legacy, strict.`);
  return policy;
}
