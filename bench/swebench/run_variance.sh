#!/usr/bin/env bash
# Step 6: variance probe. Re-runs the pre-registered variance_probe_instance_ids
# subset for 2 extra repetitions (1 and 2) each, in the same pre-registered
# arm order as the main run, so each of those instances ends up with 3 total
# repetitions per arm (1 from Step 5 + 2 here).
set -euo pipefail
BUDGET="${1:?usage: run_variance.sh <budgetUsd> <outfile.jsonl>}"
OUTFILE="${2:?usage: run_variance.sh <budgetUsd> <outfile.jsonl>}"
cd "$(dirname "$0")/../.."

.swebench/bin/python3 -c "
import json
inst = json.load(open('bench/swebench/instances.json'))
order = json.load(open('bench/swebench/arm_order.json'))['order']
variance_ids = set(inst['variance_probe_instance_ids'])
for rep in (1, 2):
    for o in order:
        if o['instance_id'] not in variance_ids: continue
        for arm in o['arm_order']:
            print(rep, o['instance_id'], arm)
" | while read -r rep instance_id arm; do
  echo "=== $instance_id : $arm (rep $rep) ==="
  node bench/swebench/run_instance.mjs "$arm" "$instance_id" "$rep" "$BUDGET" "$OUTFILE"
done
