#!/usr/bin/env python3
"""Step 8 analysis: the pre-registered tests from PUBLIC-BENCHMARK-PROMPT.md
Section 0.3, and nothing else. Run once, after all grading is in."""
import json
from pathlib import Path

import numpy as np
from scipy.stats import wilcoxon

RNG = np.random.default_rng(44)  # fixed seed for the bootstrap, distinct from the sampling/order seeds


def load_jsonl(path):
    return [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]


def load_grading(path):
    d = json.loads(Path(path).read_text())
    return {"resolved": set(d["resolved_ids"]), "unresolved": set(d["unresolved_ids"]), "empty_patch": set(d.get("empty_patch_ids", []))}


main_rows = load_jsonl("bench/swebench/results/main.jsonl")
variance_rows = load_jsonl("bench/swebench/results/variance.jsonl")

direct_grading = load_grading("bench/swebench/grading/claude-code-direct.direct-main.json")
ct_grading = load_grading("bench/swebench/grading/cherryontop.cherryontop-main.json")


def resolved(grading, instance_id):
    if instance_id in grading["resolved"]:
        return True
    if instance_id in grading["unresolved"] or instance_id in grading["empty_patch"]:
        return False
    raise ValueError(f"{instance_id} not found in grading report")


# ---- Primary + co-primary: paired main-run rows (repetition 0) ----
by_instance = {}
for r in main_rows:
    by_instance.setdefault(r["instance_id"], {})[r["arm"]] = r

instances = sorted(by_instance)
pairs = []
for iid in instances:
    d, c = by_instance[iid].get("direct"), by_instance[iid].get("cherryontop")
    if not d or not c:
        continue
    pairs.append({
        "instance_id": iid,
        "direct_cost": d["costUsd"], "cherryontop_cost": c["costUsd"],
        "direct_resolved": resolved(direct_grading, iid), "cherryontop_resolved": resolved(ct_grading, iid),
        "direct_turns": d["turns"], "cherryontop_turns": c["turns"],
        "direct_wall": d["wallSeconds"], "cherryontop_wall": c["wallSeconds"],
        "direct_tokens": d["inputTokens"] + d["outputTokens"] + d["cacheReadTokens"] + d.get("cacheCreationTokens", 0),
        "cherryontop_tokens": c["inputTokens"] + c["outputTokens"] + c["cacheReadTokens"] + c.get("cacheCreationTokens", 0),
    })

n = len(pairs)
cost_diff = np.array([p["cherryontop_cost"] - p["direct_cost"] for p in pairs])  # negative = cherryontop cheaper

# Wilcoxon signed-rank on the paired cost difference
wres = wilcoxon(cost_diff, alternative="two-sided", zero_method="wilcox")

# Bootstrap CI on the median paired difference (10,000 resamples)
boot_medians = np.array([np.median(RNG.choice(cost_diff, size=n, replace=True)) for _ in range(10_000)])
ci_lo, ci_hi = np.percentile(boot_medians, [2.5, 97.5])

# McNemar exact (= the doc's own signTestP: exact two-sided binomial on discordant pairs)
from math import comb
disc_a_only = sum(1 for p in pairs if p["direct_resolved"] and not p["cherryontop_resolved"])  # direct resolved, cherryontop did not
disc_b_only = sum(1 for p in pairs if p["cherryontop_resolved"] and not p["direct_resolved"])  # cherryontop resolved, direct did not
both = sum(1 for p in pairs if p["direct_resolved"] and p["cherryontop_resolved"])
neither = sum(1 for p in pairs if not p["direct_resolved"] and not p["cherryontop_resolved"])
disc_n = disc_a_only + disc_b_only
if disc_n == 0:
    mcnemar_p = 1.0
else:
    k = min(disc_a_only, disc_b_only)
    mcnemar_p = min(1.0, 2 * sum(comb(disc_n, i) for i in range(k + 1)) / (2 ** disc_n))

resolve_rate_direct = sum(p["direct_resolved"] for p in pairs) / n
resolve_rate_ct = sum(p["cherryontop_resolved"] for p in pairs) / n


def wilson_ci(k, n, z=1.96):
    if n == 0:
        return (0, 0)
    phat = k / n
    denom = 1 + z**2 / n
    center = phat + z**2 / (2 * n)
    margin = z * ((phat * (1 - phat) / n + z**2 / (4 * n**2)) ** 0.5)
    return ((center - margin) / denom, (center + margin) / denom)


# ---- Secondary ----
cost_per_resolved_direct = sum(p["direct_cost"] for p in pairs if p["direct_resolved"]) / max(1, sum(p["direct_resolved"] for p in pairs))
cost_per_resolved_ct = sum(p["cherryontop_cost"] for p in pairs if p["cherryontop_resolved"]) / max(1, sum(p["cherryontop_resolved"] for p in pairs))

# ---- Variance probe ----
variance_by_key = {}
for r in main_rows + variance_rows:
    variance_by_key.setdefault((r["instance_id"], r["arm"]), []).append(r)

variance_ids = json.loads(Path("bench/swebench/instances.json").read_text())["variance_probe_instance_ids"]
variance_summary = {}
for iid in variance_ids:
    for arm in ("direct", "cherryontop"):
        rows = sorted(variance_by_key[(iid, arm)], key=lambda r: r["repetition"])
        costs = [r["costUsd"] for r in rows]
        variance_summary[f"{iid}:{arm}"] = {
            "costs": costs, "mean": float(np.mean(costs)), "sd": float(np.std(costs, ddof=1)) if len(costs) > 1 else 0.0,
        }

output = {
    "n_pairs": n,
    "primary_cost": {
        "wilcoxon_statistic": float(wres.statistic), "wilcoxon_p": float(wres.pvalue),
        "median_diff_usd": float(np.median(cost_diff)), "bootstrap_ci_95": [float(ci_lo), float(ci_hi)],
        "mean_diff_usd": float(np.mean(cost_diff)),
        "n_cherryontop_cheaper": int(sum(cost_diff < 0)), "n_direct_cheaper": int(sum(cost_diff > 0)), "n_tied": int(sum(cost_diff == 0)),
    },
    "co_primary_resolution": {
        "resolve_rate_direct": resolve_rate_direct, "resolve_rate_direct_wilson95": wilson_ci(sum(p["direct_resolved"] for p in pairs), n),
        "resolve_rate_cherryontop": resolve_rate_ct, "resolve_rate_cherryontop_wilson95": wilson_ci(sum(p["cherryontop_resolved"] for p in pairs), n),
        "both_resolved": both, "neither_resolved": neither, "direct_only": disc_a_only, "cherryontop_only": disc_b_only,
        "mcnemar_exact_p": mcnemar_p,
        "non_inferior": disc_b_only >= disc_a_only or mcnemar_p > 0.05,
    },
    "secondary": {
        "cost_per_resolved_direct": cost_per_resolved_direct, "cost_per_resolved_cherryontop": cost_per_resolved_ct,
        "mean_turns_direct": float(np.mean([p["direct_turns"] for p in pairs])), "mean_turns_cherryontop": float(np.mean([p["cherryontop_turns"] for p in pairs])),
        "mean_wall_direct": float(np.mean([p["direct_wall"] for p in pairs])), "mean_wall_cherryontop": float(np.mean([p["cherryontop_wall"] for p in pairs])),
        "mean_tokens_direct": float(np.mean([p["direct_tokens"] for p in pairs])), "mean_tokens_cherryontop": float(np.mean([p["cherryontop_tokens"] for p in pairs])),
    },
    "pairs": pairs,
    "variance_probe": variance_summary,
}
Path("bench/swebench/analysis.json").write_text(json.dumps(output, indent=2))
print(json.dumps({k: v for k, v in output.items() if k not in ("pairs", "variance_probe")}, indent=2))
