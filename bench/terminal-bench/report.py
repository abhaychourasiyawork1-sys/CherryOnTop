#!/usr/bin/env python3
"""Terminal-Bench 2.0 results for one CherryOnTop arm, against the published
Haiku 4.5 harness rows (tbench.ai leaderboard, read 2026-10-01).

Reads Harbor's per-trial result.json (verifier reward, exception, cost and
tokens the agent reported) and joins each trial to its CherryOnTop node in the
arm's state.db for what information control did. Read-only; rerunnable while
the sweep is still going.

Usage: python3 report.py [arm] [--json out.json]
"""
import glob
import json
import math
import os
import sqlite3
import sys

B = os.path.expanduser("~/Desktop/CherryOnTop-bench/terminal-bench")
ARM = next((a for a in sys.argv[1:] if not a.startswith("--")), "active")
OUT = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None

# Published TB 2.0 rows at Claude Haiku 4.5 (n = 89 tasks x 5 attempts on the leaderboard).
PUBLISHED = {
    "Goose": 0.355, "Mini-SWE-Agent": 0.298, "Terminus 2": 0.283,
    "Claude Code": 0.275, "OpenHands": 0.139,
}


def wilson(k, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def binom_two_sided(k, n, p):
    """Exact two-sided binomial p-value (sum of outcomes no likelier than k)."""
    pmf = [math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(n + 1)]
    return min(1.0, sum(x for x in pmf if x <= pmf[k] * (1 + 1e-9)))


trials = []
for path in sorted(glob.glob(f"{B}/jobs/{ARM}/*/*/result.json")):
    r = json.load(open(path))
    if "verifier_result" not in r and "exception_info" not in r:
        continue  # still running
    task = path.split("/")[-3]
    agent = r.get("agent_result") or {}
    rewards = (r.get("verifier_result") or {}).get("rewards") or {}
    exc = r.get("exception_info") or None
    trials.append({
        "task": task,
        "reward": float(rewards.get("reward", 0.0) or 0.0),
        "exception": (exc or {}).get("exception_type"),
        "cost_usd": agent.get("cost_usd"),
        "input_tokens": agent.get("n_input_tokens"),
        "cache_tokens": agent.get("n_cache_tokens"),
        "output_tokens": agent.get("n_output_tokens"),
        "node": (agent.get("metadata") or {}).get("cherryontop_node"),
        "seconds": None,
    })
    started, finished = r.get("started_at"), r.get("finished_at")
    if started and finished:
        from datetime import datetime
        f = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))  # noqa: E731
        trials[-1]["seconds"] = (f(finished) - f(started)).total_seconds()

# What information control did, per node.
db_path = f"{B}/state/{ARM}/state.db"
ic = {}
if os.path.exists(db_path):
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    for node, payload in db.execute("select node_id, payload from events where type = 'ic.session'"):
        s = json.loads(payload)
        agg = ic.setdefault(node, {"dispatches": 0, "hooks": 0, "hookMs": 0, "elisions": 0, "elidedTokens": 0, "turns": 0, "finishBlocks": 0, "dedups": 0, "denies": 0})
        agg["dispatches"] += 1
        for k in ("hooks", "hookMs", "elisions", "elidedTokens", "turns"):
            agg[k] += s.get(k, 0) or 0
        agg["finishBlocks"] += s.get("block-finish", 0) or 0
        agg["dedups"] += s.get("dedup", 0) or 0
        agg["denies"] += s.get("deny-negative", 0) or 0
    refetch = dict(db.execute(
        "select node_id, count(*) from events where type = 'ic.outcome' and json_extract(payload, '$.refetched') = 1 group by node_id"))
    for node, n in refetch.items():
        ic.setdefault(node, {}).setdefault("refetches", 0)
        ic[node]["refetches"] = n

n = len(trials)
solved = sum(1 for t in trials if t["reward"] >= 1.0)
cost = [t["cost_usd"] for t in trials if t["cost_usd"] is not None]
lo, hi = wilson(solved, n)
summary = {
    "arm": ARM, "trials": n, "solved": solved, "pass_rate": solved / n if n else 0,
    "pass_rate_ci95": [lo, hi],
    "mean_reward": sum(t["reward"] for t in trials) / n if n else 0,
    "exceptions": {},
    "cost_usd_total": sum(cost), "cost_usd_mean": sum(cost) / len(cost) if cost else None,
    "cost_usd_median": sorted(cost)[len(cost) // 2] if cost else None,
    "cost_per_solved_usd": sum(cost) / solved if solved else None,
    "output_tokens_total": sum(t["output_tokens"] or 0 for t in trials),
    "input_tokens_total": sum(t["input_tokens"] or 0 for t in trials),
    "vs_published": {
        h: {"published": p, "delta_pp": 100 * ((solved / n if n else 0) - p), "p_value": binom_two_sided(solved, n, p) if n else None}
        for h, p in PUBLISHED.items()
    },
    "information_control": {
        k: sum((ic.get(t["node"]) or {}).get(k, 0) for t in trials)
        for k in ("dispatches", "hooks", "hookMs", "elisions", "elidedTokens", "refetches", "finishBlocks", "dedups", "denies", "turns")
    },
}
for t in trials:
    if t["exception"]:
        summary["exceptions"][t["exception"]] = summary["exceptions"].get(t["exception"], 0) + 1

print(f"# Terminal-Bench 2.0 — CherryOnTop ({ARM}), Claude Haiku 4.5\n")
print(f"Trials: {n} · solved: {solved} · pass rate {100 * summary['pass_rate']:.1f}% "
      f"(95% CI {100 * lo:.1f}–{100 * hi:.1f}) · mean reward {summary['mean_reward']:.3f}")
if cost:
    print(f"Cost: ${summary['cost_usd_total']:.2f} total · ${summary['cost_usd_mean']:.3f} mean/task · "
          f"${summary['cost_usd_median']:.3f} median · "
          + (f"${summary['cost_per_solved_usd']:.3f} per solved task" if solved else "no solved task yet"))
print(f"Exceptions: {summary['exceptions'] or 'none'}\n")
print("| harness (Haiku 4.5) | pass rate | CherryOnTop − this (pp) | p, exact binomial vs this rate |")
print("|---|---|---|---|")
print(f"| **CherryOnTop (this run)** | **{100 * summary['pass_rate']:.1f}%** | — | — |")
for h, v in summary["vs_published"].items():
    print(f"| {h} (published) | {100 * v['published']:.1f}% | {v['delta_pp']:+.1f} | {v['p_value']:.3f} |")
print("\nInformation control:", json.dumps(summary["information_control"]))
if OUT:
    json.dump({"summary": summary, "trials": trials}, open(OUT, "w"), indent=1)
