#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATES = ["2026-05-13", "2026-05-14", "2026-05-15"]
FROZEN_HISTORICAL_FEE_RATE = 0.07
REFERENCE_LATENCY_MS = 100
REFERENCE_SLIPPAGE_PER_LEG = 0.01


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def run(
    cmd: list[str],
    log,
    *,
    allow_nonzero: bool = False,
    timeout_seconds: int | None = None,
) -> dict[str, Any]:
    started = time.time()
    log.write(f"\n$ {' '.join(cmd)}\n")
    log.flush()
    proc = subprocess.Popen(
        cmd,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    timed_out = False
    try:
        output, _ = proc.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        output, _ = proc.communicate()
        output = (output or "") + f"\n[full-audit] command timed out after {timeout_seconds}s; process group terminated\n"
    output = output or ""
    returncode = 124 if timed_out else proc.returncode
    log.write(output)
    log.flush()
    result = {
        "command": cmd,
        "returncode": returncode,
        "seconds": round(time.time() - started, 3),
        "timedOut": timed_out,
        "tail": "\n".join(output.splitlines()[-16:]),
    }
    if returncode != 0 and not allow_nonzero:
        raise RuntimeError(f"Command failed ({returncode}): {' '.join(cmd)}\n{result['tail']}")
    return result


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def pick_reference_scenario(vr: dict[str, Any]) -> dict[str, Any] | None:
    for row in vr.get("scenarios", []):
        if int(row.get("latencyMs", -1)) == REFERENCE_LATENCY_MS and abs(float(row.get("slippagePerLeg", -1)) - REFERENCE_SLIPPAGE_PER_LEG) < 1e-12:
            return row
    return None


def historical_research_verdict(evidence: str, reference: dict[str, Any] | None) -> str:
    if evidence not in {"HISTORICAL_RECONSTRUCTED_L2", "LIVE_L2"}:
        return "NO_EXECUTABLE_DEPTH_PROOF"
    if reference is None:
        return "REFERENCE_SCENARIO_MISSING"
    executed = int(reference.get("executed", 0))
    roi = float(reference.get("roi", 0.0))
    if executed <= 0:
        return "NO_SURVIVING_EDGE_REFERENCE"
    if roi <= 0:
        return "NON_POSITIVE_AFTER_REFERENCE_STRESS"
    return "HISTORICAL_EDGE_CANDIDATE_ONLY_NOT_LIVE_PROOF"


def compact_scenario(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "latencyMs": row.get("latencyMs"),
        "slippagePerLeg": row.get("slippagePerLeg"),
        "candidateAttempts": row.get("candidateAttempts", 0),
        "executionChecks": row.get("executionChecks", 0),
        "executed": row.get("executed", 0),
        "uniqueMarketsExecuted": row.get("uniqueMarketsExecuted", 0),
        "cashCostUsd": row.get("cashCostUsd", 0),
        "lockedPnlUsd": row.get("lockedPnlUsd", 0),
        "roi": row.get("roi", 0),
        "medianLockedReturnOnCost": row.get("medianLockedReturnOnCost", 0),
        "worstLockedReturnOnCost": row.get("worstLockedReturnOnCost", 0),
        "bestLockedReturnOnCost": row.get("bestLockedReturnOnCost", 0),
        "rejected": row.get("rejected", {}),
    }


def markdown(report: dict[str, Any]) -> str:
    lines = [
        "# FluxQuant Full Audit",
        "",
        f"Generated: `{report['generatedAt']}`",
        "",
        f"**REAL MONEY GATE: {report['realMoneyGate']}**",
        f"**LIVE PAPER GATE: {report['livePaperGate']}**",
        "",
        "## Static validation",
    ]
    for item in report["staticValidation"]:
        lines.append(f"- `{item['name']}`: **{item['status']}**")
    lines += ["", "## Historical V2 archive audit"]
    for item in report["historical"]:
        ref = item.get("referenceScenario") or {}
        lines.append(
            f"- {item['date']}: evidence=`{item.get('evidenceClass','UNKNOWN')}`, "
            f"markets={item.get('marketsEligible',0)}, attempts={item.get('detectionAttempts',0)}, "
            f"execution_gate=`{item.get('executionGate','UNKNOWN')}`, research_verdict=`{item.get('researchVerdict','UNKNOWN')}`"
        )
        lines.append(
            f"  - frozen reference: fee_rate={item.get('historicalFeeRateAssumption','n/a')}, "
            f"latency={ref.get('latencyMs','n/a')}ms, slippage/leg={ref.get('slippagePerLeg','n/a')}, "
            f"executed={ref.get('executed',0)}, pnl=${float(ref.get('lockedPnlUsd',0)):.4f}, roi={float(ref.get('roi',0))*100:.2f}%"
        )
        rejected = ref.get("rejected") or {}
        if rejected:
            lines.append(
                "  - rejects: " + ", ".join(f"{k}={v}" for k, v in rejected.items() if v)
                if any(rejected.values()) else "  - rejects: none"
            )
    lines += ["", "## Connectivity / compliance"]
    elig = report.get("eligibility") or {}
    lines.append(f"- eligibility probe return code: `{elig.get('returncode')}`")
    if elig.get("tail"):
        lines.append("```text")
        lines.append(elig["tail"])
        lines.append("```")
    lines += ["", "## Live paper"]
    lp = report.get("livePaper")
    if lp:
        lines.append(f"- gate: `{lp.get('gate')}`")
        lines.append(f"- report: `{lp.get('reportPath','')}`")
    else:
        lines.append("- Not collected in this run.")
    sports = report.get("sportsResearch") or {}
    lines += ["", "## Sports / betting research"]
    lines.append(f"- status: `{sports.get('status','UNKNOWN')}`")
    lines.append(f"- live betting: `{sports.get('liveBetting','UNKNOWN')}`")
    lines.append(f"- fee policy: `{sports.get('feePolicy','UNKNOWN')}`")
    lines += ["", "## Real-money blockers"]
    for blocker in report["realMoneyBlockers"]:
        lines.append(f"- {blocker}")
    lines += ["", "## Decision", "", report["decision"], ""]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dates", default=",".join(DEFAULT_DATES))
    ap.add_argument("--paper-seconds", type=int, default=30, help="Read-only CLOB V2 paper capture; 0 disables")
    ap.add_argument("--skip-download", action="store_true")
    ap.add_argument("--output-dir", default="data/full-audit-v1.5.0")
    args = ap.parse_args()

    dates = [d.strip() for d in args.dates.split(",") if d.strip()]
    out_dir = (ROOT / args.output_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = out_dir / "audit.log"

    report: dict[str, Any] = {
        "mode": "RESEARCH_AND_READ_ONLY_PAPER_ONLY",
        "generatedAt": now_iso(),
        "version": "1.5.0",
        "dates": dates,
        "staticValidation": [],
        "historical": [],
        "realMoneyGate": "NO_GO",
        "livePaperGate": "NOT_RUN",
        "sportsResearch": {
            "status": "ACTIVE_RESEARCH_PAPER_ONLY",
            "liveBetting": "DISABLED",
            "contract": "authorized provenance -> causal leave-one-out no-vig consensus -> one-position-per-venue-market -> commission/risk paper ledger -> independent CLV -> untouched forward evidence",
            "feePolicy": "QUERY_CURRENT_PER_MARKET_SCHEDULE_NEVER_HARDCODE_SPORTS",
            "bet365": "REFERENCE_ONLY_NO_SCRAPING_NO_AUTOMATED_EXECUTION",
            "exchangeCandidates": ["BETFAIR_DELAYED_OR_HISTORICAL", "SMARKETS_EXPLICIT_RESEARCH_LICENSE_ONLY"],
            "polymarketSports": "REFERENCE_ONLY_UNTIL_DEDICATED_BINARY_FEE_DEPTH_EXECUTION_MODEL",
            "executionEvidence": "PRICE_ONLY_NOT_FILL_PROOF",
        },
        "architectureWatch": {
            "ritmexBot": "ARCHITECTURE_REFERENCE_ONLY_NO_CODE_COPY",
            "candidates": ["capability contracts", "dry-run JSON CLI", "Guardian risk sentinel", "restart reconciliation", "depth health"],
        },
        "realMoneyBlockers": [],
    }

    with log_path.open("w", encoding="utf-8") as log:
        # Hard static gates.
        for name, cmd in [
            ("node-tests", ["npm", "test"]),
            ("typescript", ["npm", "run", "typecheck"]),
            ("doctor", ["npm", "run", "doctor"]),
            ("full-audit-summary-tests", [sys.executable, "tools/test_full_audit.py"]),
        ]:
            try:
                result = run(cmd, log, timeout_seconds=180)
                report["staticValidation"].append({"name": name, "status": "PASS", **result})
            except Exception as exc:
                report["staticValidation"].append({"name": name, "status": "FAIL", "error": str(exc)})
                report["realMoneyBlockers"].append(f"Static validation failed: {name}")

        # Sports CLI smoke validates the complete offline paper path on synthetic data.
        try:
            sports_smoke_dir = out_dir / "sports-smoke"
            sports_smoke_dir.mkdir(parents=True, exist_ok=True)
            result = run([
                "npm", "run", "sports:audit", "--",
                "config/sports-research.example.jsonl", str(sports_smoke_dir / "report.json"),
                "--min-edge=0.01",
            ], log, timeout_seconds=90)
            report["staticValidation"].append({"name": "sports-audit-smoke", "status": "PASS", **result})
        except Exception as exc:
            report["staticValidation"].append({"name": "sports-audit-smoke", "status": "FAIL", "error": str(exc)})
            report["realMoneyBlockers"].append("Sports research audit smoke failed")

        # Python exporter unit test is mandatory when pyarrow is available (it is required for archive export anyway).
        py_test = run([sys.executable, "-c", "import pyarrow"], log, allow_nonzero=True)
        if py_test["returncode"] == 0:
            try:
                result = run([sys.executable, "tools/test_openmarket_export.py"], log)
                report["staticValidation"].append({"name": "python-exporter-tests", "status": "PASS", **result})
            except Exception as exc:
                report["staticValidation"].append({"name": "python-exporter-tests", "status": "FAIL", "error": str(exc)})
                report["realMoneyBlockers"].append("Python exporter semantics test failed")
        else:
            report["staticValidation"].append({"name": "python-exporter-tests", "status": "WARN", "detail": "pyarrow unavailable"})
            report["realMoneyBlockers"].append("pyarrow unavailable; historical archive audit incomplete")

        # Untouched post-CLOB-V2 dates. Public Parquet is expected to be top-only/untrusted for execution.
        if py_test["returncode"] == 0:
            for date in dates:
                date_dir = out_dir / date
                date_dir.mkdir(parents=True, exist_ok=True)
                events = date_dir / "pair-events.jsonl"
                markets = date_dir / "pair-markets.json"
                validation = date_dir / "pair-validation.json"
                try:
                    if not args.skip_download:
                        run(["npm", "run", "openmarket:prepare", "--", "--date", date], log)
                    run([
                        "npm", "run", "openmarket:export", "--",
                        "data/openmarket-unified/unified", "--date", date, "--profile", "pair",
                        "--events", str(events), "--markets", str(markets),
                        "--max-markets", "120", "--top-depth-cap", "1", "--sample-ms", "0",
                    ], log)
                    run([
                        "npm", "run", "pairvalidate", "--", str(events), str(markets), str(validation),
                        f"--fee-rate={FROZEN_HISTORICAL_FEE_RATE}",
                        "--shares=5", "--min-edge=0.015", "--freshness-ms=500",
                        "--latency-ms=0,50,100,150,250", "--slippage=0,0.005,0.01,0.02",
                        "--assume-min-order-size=5", "--assume-tick-size=0.01", "--require-market-rules",
                    ], log)
                    payload = read_json(validation)
                    vr = payload.get("report", {})
                    evidence = vr.get("evidenceClass", "UNKNOWN")
                    execution_gate = "HISTORICAL_EXECUTION_EVIDENCE_AVAILABLE" if evidence in {"HISTORICAL_RECONSTRUCTED_L2", "LIVE_L2"} else "NO_EXECUTABLE_DEPTH_PROOF"
                    reference = pick_reference_scenario(vr)
                    report["historical"].append({
                        "date": date,
                        "regime": "CLOB_V2_POST_CUTOVER",
                        "evidenceClass": evidence,
                        "marketsEligible": vr.get("marketsEligible", 0),
                        "eventsAccepted": vr.get("eventsAccepted", 0),
                        "detectionAttempts": len(vr.get("detectionAttempts", [])),
                        "executionGate": execution_gate,
                        "historicalFeeRateAssumption": FROZEN_HISTORICAL_FEE_RATE,
                        "historicalFeePolicy": "FROZEN_RESEARCH_ASSUMPTION_ONLY_NOT_LIVE_FEE_PROOF",
                        "referenceScenario": compact_scenario(reference),
                        "stressScenarios": [compact_scenario(x) for x in vr.get("scenarios", [])],
                        "researchVerdict": historical_research_verdict(evidence, reference),
                        "validationPath": str(validation),
                    })
                except Exception as exc:
                    report["historical"].append({"date": date, "status": "ERROR", "error": str(exc), "executionGate": "INCOMPLETE"})
                    report["realMoneyBlockers"].append(f"Historical audit failed for {date}")

        # Official network + geoblock gate. Nonzero is expected on blocked networks and is not bypassed.
        eligibility = run(["npm", "run", "eligibility"], log, allow_nonzero=True, timeout_seconds=30)
        report["eligibility"] = eligibility

        # Optional read-only live paper capture. It itself fails closed on network/geoblock.
        live_paper = None
        if args.paper_seconds > 0:
            paper_dir = out_dir / "live-paper"
            result = run([
                "npm", "run", "paper:pair", "--",
                f"--seconds={max(5, args.paper_seconds)}", f"--output-dir={paper_dir}",
                "--shares=5", "--min-edge=0.015", "--freshness-ms=500",
            ], log, allow_nonzero=True, timeout_seconds=max(60, args.paper_seconds + 45))
            reports = sorted(paper_dir.glob("report-*.json"), key=lambda p: p.stat().st_mtime) if paper_dir.exists() else []
            gates = sorted(paper_dir.glob("paper-gate.json"), key=lambda p: p.stat().st_mtime) if paper_dir.exists() else []
            if reports:
                data = read_json(reports[-1])
                live_paper = {"gate": data.get("livePaperGate"), "realMoneyGate": data.get("realMoneyGate"), "reportPath": str(reports[-1]), "result": result}
            elif gates:
                data = read_json(gates[-1])
                live_paper = {"gate": data.get("livePaperGate"), "realMoneyGate": data.get("realMoneyGate"), "reportPath": str(gates[-1]), "result": result}
            else:
                live_paper = {"gate": "PAPER_RUN_FAILED", "result": result}
            report["livePaper"] = live_paper
            report["livePaperGate"] = live_paper.get("gate", "UNKNOWN")

    # Deterministic real-money gate: v1.5 never authorizes capital based on historical or short paper evidence.
    if any(x.get("status") == "FAIL" for x in report["staticValidation"]):
        report["realMoneyBlockers"].append("Core tests/typecheck not clean")
    if any(x.get("executionGate") != "HISTORICAL_EXECUTION_EVIDENCE_AVAILABLE" for x in report["historical"]):
        report["realMoneyBlockers"].append("Part of the public historical archive lacks trustworthy executable L2 depth; top-only dates cannot prove fillability")
    if not any(x.get("researchVerdict") == "HISTORICAL_EDGE_CANDIDATE_ONLY_NOT_LIVE_PROOF" for x in report["historical"]):
        report["realMoneyBlockers"].append("No positive historical reconstructed-L2 edge survived the frozen 100ms + 1c/leg reference stress")
    if report.get("livePaperGate") != "SURVIVING_EDGE_LIVE_PAPER_CANDIDATE":
        report["realMoneyBlockers"].append("No qualifying live CLOB V2 paper edge has been demonstrated in this audit")
    report["realMoneyBlockers"].extend([
        "Sports paper candidates are price-only research evidence; fillability, liquidity/limits and order acceptance are not yet proven",
        "Betfair research must use delayed/historical/licensed data; generic live read-only API collection is not accepted by the provider policy",
        "Smarkets paper research requires an explicit research/benchmarking data license; generic API access is not treated as permission",
        "Two-leg FOK batch execution is not treated as cross-order atomic; orphan-leg/acknowledgement risk still requires dedicated validation",
        "A short paper session cannot establish multi-day stability, capacity, or concentration robustness",
        "Live execution and live betting are hard-disabled in FluxQuant v1.5 regardless of research output",
    ])
    # Deduplicate while preserving order.
    report["realMoneyBlockers"] = list(dict.fromkeys(report["realMoneyBlockers"]))
    report["decision"] = (
        "NO-GO for real money. The audit may authorize continued read-only paper research only. "
        "Any future capital review remains separate and venue-specific. Polymarket would require live V2 L2 paper evidence and non-atomic leg-risk validation; sports would require licensed/authorized data plus execution-grade fill/limit evidence. "
        "All lanes still require multi-day robustness, current market-rule/fee checks, and network/geographic eligibility."
    )

    json_path = out_dir / "audit-report.json"
    md_path = out_dir / "audit-report.md"
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(markdown(report), encoding="utf-8")

    print("\n[full-audit] COMPLETE")
    print(f"[full-audit] static_pass={sum(x.get('status') == 'PASS' for x in report['staticValidation'])}/{len(report['staticValidation'])}")
    for item in report["historical"]:
        print(f"[full-audit] historical {item['date']} evidence={item.get('evidenceClass','UNKNOWN')} gate={item.get('executionGate')}")
    print(f"[full-audit] live_paper_gate={report['livePaperGate']}")
    print("[full-audit] REAL_MONEY_GATE=NO_GO")
    print(f"[full-audit] report={json_path}")
    print(f"[full-audit] markdown={md_path}")
    print(f"[full-audit] log={log_path}")


if __name__ == "__main__":
    main()
