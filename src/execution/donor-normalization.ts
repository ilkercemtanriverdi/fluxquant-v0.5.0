import type { ExecutionOrderStatus } from './types.js';

/**
 * Normalize only Hummingbot states that participate in the standard in-flight
 * order lifecycle. Approval/creation/completion states are used by other flows
 * and must not be guessed into fill semantics.
 */
export function normalizeHummingbotOrderState(raw: string): ExecutionOrderStatus {
  switch (raw.trim().toUpperCase()) {
    case 'PENDING_CREATE':
      return 'PENDING';
    case 'OPEN':
      return 'OPEN';
    case 'PENDING_CANCEL':
      return 'CANCELLING';
    case 'CANCELED':
    case 'CANCELLED':
      return 'CANCELLED';
    case 'PARTIALLY_FILLED':
      return 'PARTIALLY_FILLED';
    case 'FILLED':
      return 'FILLED';
    case 'FAILED':
      return 'FAILED';
    default:
      throw new Error(`EXECUTION_UNKNOWN_HUMMINGBOT_STATE:${raw}`);
  }
}

/**
 * Normalize flumine OrderStatus names. `EXECUTABLE` means unmatched remainder
 * still exists. `EXECUTION_COMPLETE` only guarantees that no unmatched portion
 * remains, so it maps to generic terminal CLOSED rather than pretending a fill.
 * Fill quantity must be carried separately by the adapter/order record.
 */
export function normalizeFlumineOrderStatus(raw: string, matchedQuantity = 0): ExecutionOrderStatus {
  if (!Number.isFinite(matchedQuantity) || matchedQuantity < 0) {
    throw new Error(`EXECUTION_FLUMINE_MATCHED_QUANTITY_INVALID:${matchedQuantity}`);
  }
  const state = raw.trim().toUpperCase().replaceAll(' ', '_');
  switch (state) {
    case 'PENDING':
    case 'UPDATING':
      return 'PENDING';
    case 'EXECUTABLE':
      return matchedQuantity > 0 ? 'PARTIALLY_FILLED' : 'OPEN';
    case 'CANCELLING':
      return 'CANCELLING';
    case 'REPLACING':
      return 'REPLACING';
    case 'EXECUTION_COMPLETE':
      return 'CLOSED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'VIOLATION':
      return 'REJECTED';
    default:
      throw new Error(`EXECUTION_UNKNOWN_FLUMINE_STATE:${raw}`);
  }
}
