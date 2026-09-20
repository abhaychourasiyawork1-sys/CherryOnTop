#!/usr/bin/env bash
# Drives Step 5 (main run) or Step 6 (variance probe) of
# docs/benchmarks/PUBLIC-BENCHMARK-PROMPT.md: for each instance in
# arm_order.json, runs both arms in the pre-registered order, sequentially
# (the k8s cluster and local docker are shared resources; running two
# dispatches at once against them is exactly the resource-contention risk
# the internal 2026-09-20 benchmark's cluster checks exist to avoid).
#
# Usage: run_main.sh <budgetUsd> <outfile.jsonl> [repetition]
set -euo pipefail
BUDGET="${1:?usage: run_main.sh <budgetUsd> <outfile.jsonl> [repetition]}"
OUTFILE="${2:?usage: run_main.sh <budgetUsd> <outfile.jsonl> [repetition]}"
REPETITION="${3:-0}"
cd "$(dirname "$0")/../.."

.swebench/bin/python3 -c "
import json
order = json.load(open('bench/swebench/arm_order.json'))['order']
for o in order:
    for arm in o['arm_order']:
        print(o['instance_id'], arm)
" | while read -r instance_id arm; do
  echo "=== $instance_id : $arm (rep $REPETITION) ==="
  node bench/swebench/run_instance.mjs "$arm" "$instance_id" "$REPETITION" "$BUDGET" "$OUTFILE"
done
