#!/usr/bin/env python3
from __future__ import annotations
import importlib.util
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('full_audit', ROOT / 'tools' / 'full_audit.py')
assert spec and spec.loader
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

vr = {
    'scenarios': [
        {'latencyMs': 50, 'slippagePerLeg': 0.01, 'executed': 2, 'roi': 0.03},
        {'latencyMs': 100, 'slippagePerLeg': 0.01, 'executed': 1, 'roi': 0.02, 'lockedPnlUsd': 0.1, 'cashCostUsd': 4.9, 'rejected': {}},
    ]
}
ref = m.pick_reference_scenario(vr)
assert ref is not None and ref['latencyMs'] == 100
assert m.historical_research_verdict('TOP_ONLY_UNTRUSTED', ref) == 'NO_EXECUTABLE_DEPTH_PROOF'
assert m.historical_research_verdict('HISTORICAL_RECONSTRUCTED_L2', None) == 'REFERENCE_SCENARIO_MISSING'
assert m.historical_research_verdict('HISTORICAL_RECONSTRUCTED_L2', {'executed': 0, 'roi': 0}) == 'NO_SURVIVING_EDGE_REFERENCE'
assert m.historical_research_verdict('HISTORICAL_RECONSTRUCTED_L2', {'executed': 1, 'roi': 0}) == 'NON_POSITIVE_AFTER_REFERENCE_STRESS'
assert m.historical_research_verdict('HISTORICAL_RECONSTRUCTED_L2', {'executed': 1, 'roi': 0.01}) == 'HISTORICAL_EDGE_CANDIDATE_ONLY_NOT_LIVE_PROOF'
compact = m.compact_scenario(ref)
assert compact and compact['executed'] == 1 and compact['lockedPnlUsd'] == 0.1

with tempfile.TemporaryFile(mode='w+', encoding='utf-8') as log:
    started = time.time()
    timed = m.run(
        [sys.executable, '-c', 'import time; time.sleep(30)'],
        log,
        allow_nonzero=True,
        timeout_seconds=1,
    )
    assert timed['returncode'] == 124 and timed['timedOut'] is True
    assert time.time() - started < 5

print('[test_full_audit] PASS')
