#!/bin/bash
# Paid benchmark: CherryOnTop (full architecture, owned runtime) vs Claude Code
# (Harbor's stock agent, installed fresh from the web) on long Terminal-Bench 2.0
# tasks, Claude Haiku 4.5, both billed on the same API key.
#
#   owned   CherryOnTop daemon: Action Market, System-1 (Laya), validation,
#           information control active, the owned loop (priced compaction,
#           recitation, breaker, refusal cap, spill budgets, 1h prefix cache)
#   cc-api  Harbor's claude-code agent, unchanged, ANTHROPIC_API_KEY
#
# Tasks run one at a time, interleaved per task (owned then cc-api), resumable:
# a finished task is skipped on rerun (sweep.sh). CherryOnTop's spend cap is
# CTO_BUDGET per task; Claude Code is bounded by the task's own time limit.
#
# Usage: bench/agent-owned/tb-owned-vs-cc.sh [task ...]
#        (default: the four tasks in bench/agent-owned/tb-tasks.txt)
# Report: CMP_TASKS=bench/agent-owned/tb-tasks.txt CMP_CTO=owned CMP_CC=cc-api \
#         CMP_STATE=~/Desktop/CherryOnTop-bench/terminal-bench/state/owned python3 bench/terminal-bench/compare.py
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
B=/home/abhay06102003/Desktop/CherryOnTop-bench/terminal-bench
set -a; . "$HOME/.config/cherryontop/anthropic.env"; set +a
[ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "no ANTHROPIC_API_KEY"; exit 2; }
TASKS=("$@")
[ ${#TASKS[@]} -eq 0 ] && mapfile -t TASKS < "$ROOT/bench/agent-owned/tb-tasks.txt"
export CTO_BUDGET=${CTO_BUDGET:-2}
# ARMS="owned" reruns CherryOnTop only, against Claude Code results already on disk.
ARMS=${ARMS:-owned cc-api}
for task in "${TASKS[@]}"; do
  case " $ARMS " in *" owned "*) CTO_RUNTIME=anthropic-owned CTO_STATE=$B/state/owned HARBOR_AGENT=cherryontop_agent:CherryOnTop "$ROOT/bench/terminal-bench/sweep.sh" owned "$task";; esac
  case " $ARMS " in *" cc-api "*) HARBOR_AGENT=cherryontop_agent:ClaudeCodeApi "$ROOT/bench/terminal-bench/sweep.sh" cc-api "$task";; esac
done
echo "[$(date +%T)] owned vs cc-api complete"
