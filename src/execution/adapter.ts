import {
  assertIntentCompatible,
  assertExecutionMode,
  validateAdapterCapabilities,
} from './lifecycle.js';
import type {
  ExecutionAdapter,
  ExecutionAdapterCapabilities,
  ExecutionIntent,
} from './types.js';

/**
 * Shared runtime contract check for donor-backed adapters. This intentionally
 * does not implement venue I/O. v1.5 remains shadow/paper only.
 */
export function validateExecutionAdapter(adapter: ExecutionAdapter): ExecutionAdapterCapabilities {
  assertExecutionMode(adapter.mode);
  const capabilities = adapter.capabilities();
  validateAdapterCapabilities(capabilities);
  if (!capabilities.modes.includes(adapter.mode)) {
    throw new Error(`EXECUTION_ADAPTER_MODE_UNSUPPORTED:${adapter.mode}`);
  }
  return capabilities;
}

export function validateIntentForAdapter(adapter: ExecutionAdapter, intent: ExecutionIntent): void {
  const capabilities = validateExecutionAdapter(adapter);
  assertIntentCompatible(capabilities, intent);
}
