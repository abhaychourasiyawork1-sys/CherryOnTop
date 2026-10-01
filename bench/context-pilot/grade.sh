#!/usr/bin/env bash
# Grades every p-* run's model.patch with the official SWE-bench harness
# (same invocation as bench/swebench/grade_matrix.sh), one instance image at a
# time, and writes <run>/grade.json = {resolved, report}. Idempotent.
# An empty patch is graded too: it is recorded as unresolved, not as missing.
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT_REPO=$PWD
PY=$ROOT_REPO/.swebench/bin/python
BENCH=$HOME/Desktop/CherryOnTop-bench
GRADE_DIR=$BENCH/grading
mkdir -p "$GRADE_DIR/predictions"

instances=$(ls "$BENCH/runs" | grep '^p-' | while read r; do "$PY" -c "import json;print(json.load(open('$BENCH/runs/$r/meta.json'))['instance_id'])"; done | sort -u)
for inst in $instances; do
  runs=$(ls "$BENCH/runs" | grep '^p-' | while read r; do
    [ -f "$BENCH/runs/$r/grade.json" ] && continue
    "$PY" -c "import json,sys;m=json.load(open('$BENCH/runs/$r/meta.json'));sys.exit(0 if m['instance_id']=='$inst' else 1)" && echo "$r"
  done)
  [ -z "$runs" ] && continue
  image="swebench/sweb.eval.x86_64.$(echo "$inst" | tr 'A-Z' 'a-z' | sed 's/__/_1776_/'):latest"
  sg docker -c "docker image inspect '$image' >/dev/null 2>&1 || docker pull -q '$image'" >/dev/null 2>&1
  for r in $runs; do
    pred=$GRADE_DIR/predictions/$r.jsonl
    "$PY" - "$r" "$inst" "$pred" <<'PYEOF'
import json, sys, os
r, inst, pred = sys.argv[1:4]
patch = open(os.path.expanduser(f'~/Desktop/CherryOnTop-bench/runs/{r}/model.patch')).read()
open(pred, 'w').write(json.dumps({'instance_id': inst, 'model_patch': patch, 'model_name_or_path': r}) + '\n')
PYEOF
    echo "=== grading $r ($inst)"
    (cd "$GRADE_DIR" && sg docker -c "'$PY' -m swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Verified \
      --predictions_path '$pred' --instance_ids '$inst' --run_id 'ctxpilot-$r' --max_workers 1 --timeout 1800 \
      --report_dir '$GRADE_DIR/reports'" 2>&1 | tail -4)
    report="$GRADE_DIR/logs/run_evaluation/ctxpilot-$r/$r/$inst/report.json"
    "$PY" - "$r" "$inst" "$report" <<'PYEOF'
import json, sys, os
r, inst, report = sys.argv[1:4]
out = os.path.expanduser(f'~/Desktop/CherryOnTop-bench/runs/{r}/grade.json')
if os.path.exists(report):
    rep = json.load(open(report))[inst]
    json.dump({'resolved': bool(rep.get('resolved')), 'harness': 'swebench 5.0.2 official run_evaluation', 'report': rep}, open(out, 'w'), indent=1)
    print('  resolved =', rep.get('resolved'))
else:
    print('  NO REPORT — leaving ungraded (harness failure, not a task failure)')
PYEOF
  done
  lower=$(echo "$inst" | tr 'A-Z' 'a-z' | sed 's/__/_1776_/')
  sg docker -c "docker images --format '{{.Repository}}:{{.Tag}}' | grep -i 'sweb.eval' | grep -i -e '$lower' | xargs -r docker rmi -f" >/dev/null 2>&1
  sg docker -c "docker container prune -f" >/dev/null 2>&1
done
echo "grading done"
