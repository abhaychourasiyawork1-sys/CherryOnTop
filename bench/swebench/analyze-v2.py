#!/usr/bin/env python3
"""v2 analysis: single-arm (cherryontop only) descriptive stats per tier,
per docs/benchmarks/2026-09-21-v2-design-change-addendum.md. No pairing, no
McNemar, no paired Wilcoxon -- there is no self-run direct arm to pair
against. Compares against published Sonnet 5 baselines as context only.

Usage: python3 analyze-v2.py
Reads bench/swebench/results/{smoke,main}-v2.jsonl, the SWE-bench harness
report JSON, and bench/tier-b/results/{main,grading}.jsonl. Writes
bench/swebench/analysis-v2.json.
"""
import json
import sys
from pathlib import Path


def load_jsonl(path):
    p = Path(path)
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]


def wilson_ci(k, n, z=1.96):
    if n == 0:
        return (0, 0)
    phat = k / n
    denom = 1 + z**2 / n
    center = phat + z**2 / (2 * n)
    margin = z * ((phat * (1 - phat) / n + z**2 / (4 * n**2)) ** 0.5)
    return (round((center - margin) / denom, 4), round((center + margin) / denom, 4))


def tokens_of(row):
    return (row.get("inputTokens", 0) or 0) + (row.get("outputTokens", 0) or 0) \
        + (row.get("cacheReadTokens", 0) or 0) + (row.get("cacheCreationTokens", 0) or 0)


# ---------------- Tier A ----------------
swebench_report_path = sys.argv[1] if len(sys.argv) > 1 else None
grading = {"resolved": set(), "unresolved": set(), "empty_patch": set()}
if swebench_report_path and Path(swebench_report_path).exists():
    d = json.loads(Path(swebench_report_path).read_text())
    resolved_ids = set(d.get("resolved_ids", []))
    completed_ids = set(d.get("completed_ids", []))
    empty_patch_ids = set(d.get("empty_patch_ids", []))
    grading["resolved"] = resolved_ids
    grading["unresolved"] = (completed_ids - resolved_ids) | set(d.get("error_ids", [])) | set(d.get("incomplete_ids", []))
    grading["empty_patch"] = empty_patch_ids

main_rows = [r for r in load_jsonl("bench/swebench/results/main-v2.jsonl") if r["arm"] == "cherryontop"]
smoke_rows = [r for r in load_jsonl("bench/swebench/results/smoke-v2.jsonl") if r["arm"] == "cherryontop"]

def tier_a_row(r):
    iid = r["instance_id"]
    if iid in grading["resolved"]:
        resolved_flag = True
    elif iid in grading["unresolved"] or iid in grading["empty_patch"]:
        resolved_flag = False
    else:
        resolved_flag = None  # not yet graded / not found
    return {
        "instance_id": iid, "state": r["state"], "resolved": resolved_flag,
        "cost_usd": r["costUsd"], "turns": r["turns"], "wall_seconds": r.get("wallSeconds"),
        "tokens_total": tokens_of(r), "patch_bytes": r.get("patchBytes"),
    }

tier_a_main = [tier_a_row(r) for r in main_rows]
tier_a_smoke = [tier_a_row(r) for r in smoke_rows]
tier_a_valid = [r for r in tier_a_main if r["resolved"] is not None]
n_a = len(tier_a_valid)
k_a = sum(1 for r in tier_a_valid if r["resolved"])

# ---------------- Tier B ----------------
tb_main_rows = [r for r in load_jsonl("bench/tier-b/results/main.jsonl") if r["arm"] == "cherryontop"]
tb_grading_rows = load_jsonl("bench/tier-b/results/grading.jsonl")
# Latest grading row per (task_id, arm, repetition), excluding oracle-test rows.
tb_grading_latest = {}
for g in tb_grading_rows:
    if g["arm"] != "cherryontop":
        continue
    key = (g["task_id"], g["repetition"])
    tb_grading_latest[key] = g  # last one wins (appended in run order)

def tier_b_row(r):
    key = (r["task_id"], r["repetition"])
    g = tb_grading_latest.get(key)
    return {
        "task_id": r["task_id"], "state": r["state"], "resolved": g["resolved"] if g else None,
        "reward": g["reward"] if g else None,
        "cost_usd": r["costUsd"], "turns": r["turns"], "wall_seconds": r.get("wallSeconds"),
        "tokens_total": tokens_of(r), "patch_bytes": r.get("patchBytes"),
    }

tier_b = [tier_b_row(r) for r in tb_main_rows]
tier_b_valid = [r for r in tier_b if r["resolved"] is not None]
n_b = len(tier_b_valid)
k_b = sum(1 for r in tier_b_valid if r["resolved"])

output = {
    "design": "single-arm (cherryontop only), descriptive vs. published baselines -- see 2026-09-21-v2-design-change-addendum.md",
    "tier_a": {
        "smoke": tier_a_smoke,
        "main": tier_a_main,
        "n_valid": n_a, "n_resolved": k_a,
        "resolve_rate": round(k_a / n_a, 4) if n_a else None,
        "resolve_rate_wilson95": wilson_ci(k_a, n_a),
        "mean_cost_usd": round(sum(r["cost_usd"] for r in tier_a_valid) / n_a, 4) if n_a else None,
        "mean_turns": round(sum(r["turns"] for r in tier_a_valid) / n_a, 2) if n_a else None,
        "mean_wall_seconds": round(sum(r["wall_seconds"] for r in tier_a_valid) / n_a, 1) if n_a else None,
        "mean_tokens_total": round(sum(r["tokens_total"] for r in tier_a_valid) / n_a, 1) if n_a else None,
        "total_cost_usd": round(sum(r["cost_usd"] for r in tier_a_main), 4),
        "published_baseline": {"score": 0.852, "source": "Claude Sonnet 5 System Card SS8.2, p.116", "date": "2026-06-30", "n_instances": 500},
    },
    "tier_b": {
        "main": tier_b,
        "n_valid": n_b, "n_resolved": k_b,
        "resolve_rate": round(k_b / n_b, 4) if n_b else None,
        "resolve_rate_wilson95": wilson_ci(k_b, n_b),
        "mean_cost_usd": round(sum(r["cost_usd"] for r in tier_b_valid) / n_b, 4) if n_b else None,
        "mean_turns": round(sum(r["turns"] for r in tier_b_valid) / n_b, 2) if n_b else None,
        "mean_wall_seconds": round(sum(r["wall_seconds"] for r in tier_b_valid) / n_b, 1) if n_b else None,
        "mean_tokens_total": round(sum(r["tokens_total"] for r in tier_b_valid) / n_b, 1) if n_b else None,
        "total_cost_usd": round(sum(r["cost_usd"] for r in tier_b), 4),
        "published_baseline": {"score": 0.804, "source": "Claude Sonnet 5 System Card SS8.3, p.116-117", "date": "2026-06-30", "n_instances": 89, "note": "Terminal-Bench 2.1, mini-SWE-agent harness, xhigh effort -- dataset-version mismatch vs. the terminal-bench-3 task pool used here, disclosed in the addendum"},
    },
}

Path("bench/swebench/analysis-v2.json").write_text(json.dumps(output, indent=2) + "\n")
print(json.dumps(output, indent=2))
