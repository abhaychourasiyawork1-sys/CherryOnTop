#!/bin/bash
# One Terminal-Bench job through the CherryOnTop Harbor agent. Usage: run.sh <job-name> [harbor args...]
set -euo pipefail
B=/home/abhay06102003/Desktop/CherryOnTop-bench/terminal-bench
JOB=$1; shift
cd /home/abhay06102003/Desktop/CherryOnTop/bench/terminal-bench
# Snap docker cannot read hidden dirs (~/.local), where Harbor ships its compose
# files: import a copy of the package from a readable path instead.
export PYTHONPATH=$B/harbor-pkg:$PWD
# This shell may inherit a Claude app session (ANTHROPIC_BASE_URL, CLAUDE_CODE_*):
# Harbor would read the base URL as a custom endpoint and hand it to the agent.
# Every arm starts from a clean account environment instead.
unset ANTHROPIC_BASE_URL CLAUDECODE CLAUDE_PID CLAUDE_EFFORT
for v in $(compgen -e | grep -E '^CLAUDE_(CODE|AGENT)_'); do unset "$v"; done
export CTO_ROOT=/home/abhay06102003/Desktop/CherryOnTop
export CTO_STATE=${CTO_STATE:-$B/state/active}
export CTO_IC_MODE=${CTO_IC_MODE:-active}
export CTO_MODEL=haiku
# Snap docker has a private /tmp: Harbor's compose files must live where it can read them.
export TMPDIR=$B/tmp
exec ~/.local/share/uv/tools/harbor/bin/python -c "import sys; from harbor.cli.main import app; sys.argv[0]='harbor'; sys.exit(app())" run -p $B/tasks/terminal-bench-2 -a ${HARBOR_AGENT:-cherryontop_agent:CherryOnTop} -m anthropic/claude-haiku-4-5 \
  --agent-setup-timeout-multiplier 2 -n ${N_CONCURRENT:-1} --allow-agent-host 172.17.0.1 -o ${JOBS_DIR:-$B/jobs} --job-name "$JOB" -y "$@"
