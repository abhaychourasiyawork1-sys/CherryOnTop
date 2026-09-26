#!/usr/bin/env python3
"""Harness-vs-harness token/cost comparison: Claude Code CLI (direct) vs
CherryOnTop, both pinned to claude-sonnet-5, same 6 SWE-bench Verified
instances, 2 repetitions each, averaged per instance then across instances.
No SWE-bench grading is run here -- 'state' is the CLI/org-reported terminal
state (COMPLETE/FAILED/CANCELLED), not a hidden-test pass/fail verdict."""
import json
from pathlib import Path
from statistics import mean

RESULTS = Path("bench/swebench/results")

# A mid-run subscription quota exhaustion (turns<=1, cost=$0, patchBytes=0 on
# BOTH arms simultaneously starting at xarray-6744) invalidated the original
# rep 0/1 rows for 4 of 6 instances -- INVALID_ENV, not a product result. One
# cherryontop row (xarray-6744 rep 2/3) was separately invalidated by a stale
# result-cache hit (a read-only child's old answer served instead of a fresh
# run) and recovered with a cache-busted rerun (reps 4/5). This maps each
# instance+arm to the exactly-2 valid repetitions actually used.
VALID_REPS = {
    "direct": {
        "pallets__flask-5014": [0, 1],
        "psf__requests-1142": [0, 1],
        "pydata__xarray-6744": [0, 2],
        "mwaskom__seaborn-3187": [2, 3],
        "scikit-learn__scikit-learn-14710": [2, 3],
        "sympy__sympy-17139": [2, 3],
    },
    "cherryontop": {
        "pallets__flask-5014": [0, 1],
        "psf__requests-1142": [0, 1],
        "pydata__xarray-6744": [4, 5],
        "mwaskom__seaborn-3187": [2, 3],
        "scikit-learn__scikit-learn-14710": [2, 3],
        "sympy__sympy-17139": [2, 3],
    },
}


def load_jsonl(path):
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def total_tokens(r):
    return r["inputTokens"] + r["outputTokens"] + r.get("cacheReadTokens", 0) + r.get("cacheCreationTokens", 0)


def per_instance_avg(rows, arm):
    by_instance = {}
    for r in rows:
        if r["repetition"] not in VALID_REPS[arm].get(r["instance_id"], []):
            continue
        by_instance.setdefault(r["instance_id"], []).append(r)
    for iid, reps in by_instance.items():
        assert len(reps) == 2, f"{arm}:{iid} expected 2 valid reps, got {len(reps)}"
    out = {}
    for iid, reps in by_instance.items():
        out[iid] = {
            "n_reps": len(reps),
            "mean_cost_usd": mean(r["costUsd"] for r in reps),
            "mean_tokens": mean(total_tokens(r) for r in reps),
            "mean_input_tokens": mean(r["inputTokens"] for r in reps),
            "mean_output_tokens": mean(r["outputTokens"] for r in reps),
            "mean_cache_read_tokens": mean(r.get("cacheReadTokens", 0) for r in reps),
            "mean_turns": mean(r["turns"] for r in reps),
            "mean_wall_seconds": mean(r["wallSeconds"] for r in reps),
            "states": [r["state"] for r in reps],
            "complete_rate": sum(r["state"] == "COMPLETE" for r in reps) / len(reps),
        }
    return out


def overall(per_instance):
    vals = list(per_instance.values())
    return {
        "n_instances": len(vals),
        "mean_cost_usd": mean(v["mean_cost_usd"] for v in vals),
        "mean_tokens": mean(v["mean_tokens"] for v in vals),
        "mean_input_tokens": mean(v["mean_input_tokens"] for v in vals),
        "mean_output_tokens": mean(v["mean_output_tokens"] for v in vals),
        "mean_cache_read_tokens": mean(v["mean_cache_read_tokens"] for v in vals),
        "mean_turns": mean(v["mean_turns"] for v in vals),
        "mean_wall_seconds": mean(v["mean_wall_seconds"] for v in vals),
        "complete_rate": mean(v["complete_rate"] for v in vals),
    }


def per_success_stats(rows, arm):
    valid = [r for r in rows if r["repetition"] in VALID_REPS[arm].get(r["instance_id"], [])]
    successes = [r for r in valid if r["state"] == "COMPLETE"]
    return {
        "n_valid_rows": len(valid),
        "n_successes": len(successes),
        "success_rate": len(successes) / len(valid) if valid else 0,
        "cost_per_success": mean(r["costUsd"] for r in successes) if successes else None,
        "tokens_per_success": mean(total_tokens(r) for r in successes) if successes else None,
        "turns_per_success": mean(r["turns"] for r in successes) if successes else None,
    }


def main():
    direct_rows = load_jsonl(RESULTS / "harness-compare-direct.jsonl")
    ct_rows = load_jsonl(RESULTS / "harness-compare-cherryontop.jsonl")

    direct_by_instance = per_instance_avg(direct_rows, "direct")
    ct_by_instance = per_instance_avg(ct_rows, "cherryontop")

    output = {
        "model_both_arms": "claude-sonnet-5",
        "n_instances": len(ct_by_instance),
        "reps_per_instance": 2,
        "direct": {"per_instance": direct_by_instance, "overall": overall(direct_by_instance), "per_success": per_success_stats(direct_rows, "direct")},
        "cherryontop": {"per_instance": ct_by_instance, "overall": overall(ct_by_instance), "per_success": per_success_stats(ct_rows, "cherryontop")},
    }
    out_path = RESULTS / "harness-compare-analysis.json"
    out_path.write_text(json.dumps(output, indent=2))
    print(json.dumps({k: v for k, v in output.items() if k in ("model_both_arms", "n_instances")}, indent=2))
    print("direct overall:", json.dumps(output["direct"]["overall"], indent=2))
    print("direct per_success:", json.dumps(output["direct"]["per_success"], indent=2))
    print("cherryontop overall:", json.dumps(output["cherryontop"]["overall"], indent=2))
    print("cherryontop per_success:", json.dumps(output["cherryontop"]["per_success"], indent=2))


if __name__ == "__main__":
    main()
