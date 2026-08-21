export type TradingMode = 'research' | 'shadow';

/**
 * FluxQuant safety invariant: real-money execution does not exist.
 * Do not weaken this guard by introducing an env toggle.
 */
export function assertLiveExecutionUnavailable(): never {
  throw new Error('LIVE_EXECUTION_DISABLED: FluxQuant v1.5 supports research/shadow mode only; sports remains paper-research only.');
}

export function validateMode(mode: string | undefined): TradingMode {
  if (!mode || mode === 'research') return 'research';
  if (mode === 'shadow') return 'shadow';
  throw new Error(`Unsupported mode: ${mode}. Allowed: research, shadow.`);
}
