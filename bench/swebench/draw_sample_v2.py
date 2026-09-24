#!/usr/bin/env python3
"""Draws the Tier A (SWE-bench Verified) sample for the v2 public benchmark.

Per docs/benchmarks/PUBLIC-BENCHMARK-PROMPT-V2.md §2.1: fixed seed, four
slots stratified by the dataset's own `difficulty` field, one instance per
distinct repository. Must NOT reuse any of the 10 instances (8 main + 2
smoke) drawn by draw_sample.py (seed 42) for the 2026-09-21 v1 report --
those have been seen, so reusing them would invite the charge that the set
was chosen knowing the outcome.

Slot A4 uses the dataset's ">1 hour" difficulty stratum, split in the raw
data into "1-4 hours" (42 rows) and ">4 hours" (3 rows); both are non-empty
here so A4 draws from their union rather than falling back to a second
"15 min - 1 hour" slot.

Re-running this script must reproduce byte-identical output.
"""
import json
import random

from datasets import load_dataset

SEED = 2026
PRIOR_INSTANCE_IDS = {
    # v1 main (8) + v1 smoke (2), docs/benchmarks/PUBLIC-BENCHMARK-PROMPT.md, seed 42
    "astropy__astropy-14309", "django__django-15252", "mwaskom__seaborn-3187",
    "pallets__flask-5014", "psf__requests-1142", "pydata__xarray-6744",
    "scikit-learn__scikit-learn-14710", "sympy__sympy-17139",
    "sphinx-doc__sphinx-9698", "django__django-13512",
}

ds = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")
rows = [dict(r) for r in ds if r["instance_id"] not in PRIOR_INSTANCE_IDS]

rng = random.Random(SEED)


def pick(candidates, used_repos):
    pool = [r for r in candidates if r["repo"] not in used_repos]
    rng.shuffle(pool)
    return pool[0]


easy = [r for r in rows if r["difficulty"] == "<15 min fix"]
hard = [r for r in rows if r["difficulty"] == "15 min - 1 hour"]
hardest = [r for r in rows if r["difficulty"] in ("1-4 hours", ">4 hours")]

used_repos = set()

a1 = pick(easy, used_repos)
used_repos.add(a1["repo"])
a2 = pick(easy, used_repos)
used_repos.add(a2["repo"])
a3 = pick(hard, used_repos)
used_repos.add(a3["repo"])
a4_stratum = ">1 hour (1-4 hours / >4 hours union)"
a4 = pick(hardest, used_repos)
used_repos.add(a4["repo"])


def stratify_row(r, slot, purpose):
    return {
        "slot": slot,
        "purpose": purpose,
        "instance_id": r["instance_id"],
        "repo": r["repo"],
        "base_commit": r["base_commit"],
        "difficulty": r["difficulty"],
        "problem_statement_chars": len(r["problem_statement"]),
        "fail_to_pass_count": len(json.loads(r["FAIL_TO_PASS"])),
        "pass_to_pass_count": len(json.loads(r["PASS_TO_PASS"])),
    }


tier_a = [
    stratify_row(a1, "A1", "Simple. The orchestration-tax case"),
    stratify_row(a2, "A2", "Simple, different repository"),
    stratify_row(a3, "A3", "Hard"),
    stratify_row(a4, "A4", f"Hardest available ({a4_stratum})"),
]

output = {
    "dataset": "princeton-nlp/SWE-bench_Verified",
    "grading_dataset": "SWE-bench/SWE-bench_Verified",
    "seed": SEED,
    "excluded_prior_instance_ids": sorted(PRIOR_INSTANCE_IDS),
    "stratification": "A1/A2: <15 min fix (distinct repos); A3: 15 min - 1 hour; A4: 1-4 hours / >4 hours union. One instance per distinct repository across all four slots.",
    "tier_a": tier_a,
}

with open("bench/swebench/instances-v2.json", "w") as f:
    json.dump(output, f, indent=2)
    f.write("\n")

for r in tier_a:
    print(f"{r['slot']}: {r['instance_id']} ({r['difficulty']}, {r['repo']})")
