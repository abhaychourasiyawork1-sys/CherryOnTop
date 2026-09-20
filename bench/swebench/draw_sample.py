#!/usr/bin/env python3
"""Draws the fixed, public, deterministic instance sample for the CherryOnTop
vs. claude-code-direct SWE-bench Verified benchmark.

Per docs/benchmarks/PUBLIC-BENCHMARK-PROMPT.md Step 1: stratified by
repository, fixed seed, written before any run happens and never touched
after. Re-running this script must reproduce byte-identical output.

Stratification choice: one instance per distinct repository, rather than
proportional-to-population. SWE-bench Verified is 46% django/django; a
population-proportional draw of 8 would put ~4 slots in one repo and let its
idiosyncrasies dominate an 8-point report. One-per-repo maximizes the number
of distinct codebases a reader can generalize across, at the cost of not
reflecting the dataset's true repo distribution -- disclosed in the report's
Threats to Validity section.

Smoke instances are drawn separately, from the "<15 min fix" difficulty
band, and are excluded from the main and variance sets so that pipeline
debugging never touches the instances the statistics are computed over.
"""
import json
import random

from datasets import load_dataset

SEED = 42
N_MAIN = 8
N_SMOKE = 2
N_VARIANCE = 3  # subset of the main N_MAIN, each gets 2 extra repetitions

ds = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")
rows = [dict(r) for r in ds]

rng = random.Random(SEED)

# --- Smoke: two easy instances, excluded from everything else. ---
easy = [r for r in rows if r["difficulty"] == "<15 min fix"]
rng.shuffle(easy)
smoke = easy[:N_SMOKE]
smoke_ids = {r["instance_id"] for r in smoke}

# --- Main: one instance per distinct repo, up to N_MAIN repos. ---
remaining = [r for r in rows if r["instance_id"] not in smoke_ids]
by_repo = {}
for r in remaining:
    by_repo.setdefault(r["repo"], []).append(r)

repo_names = sorted(by_repo.keys())
rng.shuffle(repo_names)
chosen_repos = repo_names[:N_MAIN]

main = []
for repo in chosen_repos:
    candidates = by_repo[repo]
    rng.shuffle(candidates)
    main.append(candidates[0])

# Deterministic instance order for reporting (sorted by instance_id, not by
# the shuffle order, so the published table doesn't leak the RNG's internal
# state).
main.sort(key=lambda r: r["instance_id"])

# --- Variance probe: first N_VARIANCE of the main set, by instance_id. ---
variance_ids = [r["instance_id"] for r in main[:N_VARIANCE]]


def stratify_row(r):
    return {
        "instance_id": r["instance_id"],
        "repo": r["repo"],
        "base_commit": r["base_commit"],
        "difficulty": r["difficulty"],
        "problem_statement_chars": len(r["problem_statement"]),
        "fail_to_pass_count": len(json.loads(r["FAIL_TO_PASS"])),
        "pass_to_pass_count": len(json.loads(r["PASS_TO_PASS"])),
    }


output = {
    "dataset": "princeton-nlp/SWE-bench_Verified",
    "seed": SEED,
    "stratification": "one instance per distinct repository (not population-proportional; see draw_sample.py docstring)",
    "smoke": [stratify_row(r) for r in smoke],
    "main": [stratify_row(r) for r in main],
    "variance_probe_instance_ids": variance_ids,
}

with open("bench/swebench/instances.json", "w") as f:
    json.dump(output, f, indent=2)
    f.write("\n")

print(f"smoke: {[r['instance_id'] for r in smoke]}")
print(f"main ({len(main)} repos): {[r['instance_id'] for r in main]}")
print(f"variance probe subset: {variance_ids}")
