#!/bin/bash
# The Terminal-Bench 2.0 sweep for one arm: every task, one at a time, resumable.
#
# One Harbor job per task (jobs/<arm>/<task>), so a crash, a reboot or a rate-limit
# pause loses at most the task in flight, and a rerun skips every task that already
# has a result. After each task its image is removed: Docker's data dir is on the
# root partition, which cannot hold 89 task images.
#
# A trial that ends because the subscription's usage window is spent is not a task
# result: it is deleted and retried after the window resets.
#
# Usage: sweep.sh <arm> [task ...]      (no tasks = all 89)
# Run under `sg docker -c` so docker works without the group in this login.
set -uo pipefail
B=/home/abhay06102003/Desktop/CherryOnTop-bench/terminal-bench
ARM=${1:?arm}; shift
TASKS=("$@")
[ ${#TASKS[@]} -eq 0 ] && mapfile -t TASKS < <(ls "$B/tasks/terminal-bench-2")
mkdir -p "$B/jobs/$ARM" "$B/logs/$ARM"

limited() {  # did this trial hit the subscription's usage limit? (the agent marks it)
  grep -rqs 'RATE LIMITED' "$1" --include=driver.log 2>/dev/null
}

for task in "${TASKS[@]}"; do
  job="$B/jobs/$ARM/$task"
  if ls "$job"/*/result.json >/dev/null 2>&1 && ! limited "$job"; then
    echo "[$(date +%T)] skip $task (done)"; continue
  fi
  while true; do
    rm -rf "$job"
    image=$(python3 -c "import tomllib;print(tomllib.load(open('$B/tasks/terminal-bench-2/$task/task.toml','rb'))['environment']['docker_image'])")
    echo "[$(date +%T)] start $task ($image)"
    # Jobs land in jobs/<arm>/<task>.
    JOBS_DIR="$B/jobs/$ARM" "$(dirname "$0")/run.sh" "$task" -i "$task" > "$B/logs/$ARM/$task.log" 2>&1
    docker image rm -f "$image" >/dev/null 2>&1
    docker image prune -f >/dev/null 2>&1
    if limited "$job"; then
      echo "[$(date +%T)] $task hit the usage limit; waiting 30 min before retrying"
      sleep 1800
      continue
    fi
    echo "[$(date +%T)] done $task: $(python3 -c "
import json,glob
r=[json.load(open(p)) for p in glob.glob('$job/*/result.json')]
print(r[0].get('verifier_result',{}).get('rewards') if r else 'no result')" 2>/dev/null)"
    break
  done
done
echo "[$(date +%T)] sweep $ARM complete"
