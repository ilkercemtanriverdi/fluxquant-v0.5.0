import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLiveExecutionUnavailable, validateMode } from '../src/security/live-gate.js';

test('research is default mode', () => {
  assert.equal(validateMode(undefined), 'research');
});

test('shadow mode is allowed', () => {
  assert.equal(validateMode('shadow'), 'shadow');
});

test('live-like modes are rejected', () => {
  assert.throws(() => validateMode('live'), /Unsupported mode/);
  assert.throws(() => validateMode('paper-live'), /Unsupported mode/);
});

test('live execution entry point always throws', () => {
  assert.throws(() => assertLiveExecutionUnavailable(), /LIVE_EXECUTION_DISABLED/);
});
