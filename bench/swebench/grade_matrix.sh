#!/usr/bin/env bash
# Grades bench/swebench/results/matrix.jsonl with the official SWE-bench
# harness: one prediction set per (arm, rep), run one instance at a time so the
# disk only ever holds one instance image (they are 4-7 GB each; grading all
# at once filled the disk last time). Idempotent: a graded (run, instance)
# pair is skipped. Reports land under bench/swebench/grading/logs/run_evaluation.
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
PY=$ROOT/.swebench/bin/python
NAME=${MATRIX_NAME:-matrix}
PRED_DIR=$ROOT/bench/swebench/predictions/$NAME
GRADE_DIR=$ROOT/bench/swebench/grading
mkdir -p "$PRED_DIR"

# One predictions file per (arm, rep); an empty patch is still listed so the
# harness records it as unresolved rather than missing.
"$PY" - <<'PY'
import json, os, collections
root = os.getcwd()
name_ = os.environ.get('MATRIX_NAME', 'matrix')
rows = [json.loads(l) for l in open(f'{root}/bench/swebench/results/{name_}.jsonl') if l.strip()]
sets = collections.defaultdict(list)
for r in rows:
    if r.get('rateLimited'): continue
    p = f"{root}/bench/swebench/patches/{r['instance_id']}.{r['arm']}.{r['repetition']}.patch"
    patch = open(p).read() if os.path.exists(p) else ''
    name = f"{r['arm']}-{r['repetition']}"
    sets[name].append({'instance_id': r['instance_id'], 'model_patch': patch, 'model_name_or_path': name})
for name, preds in sets.items():
    with open(f'{root}/bench/swebench/predictions/{name_}/{name}.jsonl', 'w') as f:
        f.write(''.join(json.dumps(p) + '\n' for p in preds))
    print(name, len(preds))
PY

instances=$("$PY" -c "
import json
print(' '.join(sorted({json.loads(l)['instance_id'] for l in open('bench/swebench/results/${NAME}.jsonl') if l.strip()})))")

cd "$GRADE_DIR"
for inst in $instances; do
  # The harness does not pull a missing image itself (the first evaluation of
  # each instance failed with "image not found"), so pull it up front.
  image="swebench/sweb.eval.x86_64.$(echo "$inst" | tr 'A-Z' 'a-z' | sed 's/__/_1776_/'):latest"
  sg docker -c "docker image inspect '$image' >/dev/null 2>&1 || docker pull -q '$image'" >/dev/null 2>&1
  for pred in "$PRED_DIR"/*.jsonl; do
    name=$(basename "$pred" .jsonl)
    report="logs/run_evaluation/matrix-$name/$name/$inst/report.json"
    [ -f "$report" ] && continue
    grep -q "\"$inst\"" "$pred" || continue
    echo "=== grading $inst for $name"
    sg docker -c "'$PY' -m swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Verified \
      --predictions_path '$pred' --instance_ids '$inst' --run_id 'matrix-$name' --max_workers 1 --timeout 1800 \
      --report_dir '$GRADE_DIR/matrix-reports'" 2>&1 | tail -4
  done
  # Free this instance's image before pulling the next one.
  lower=$(echo "$inst" | tr 'A-Z' 'a-z' | sed 's/__/_1776_/')
  sg docker -c "docker images --format '{{.Repository}}:{{.Tag}}' | grep -i 'sweb.eval' | grep -i -e '$lower' -e '$(echo "$inst" | tr 'A-Z' 'a-z')' | xargs -r docker rmi -f" >/dev/null 2>&1
  sg docker -c "docker container prune -f" >/dev/null 2>&1
done
echo "grading done"
