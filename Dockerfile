FROM node:22-slim

# Python beside Node: an agent is asked to build and *test* whatever the task
# needs, and many tasks are Python. Without it the agent spent turns searching
# the image for an interpreter and could not run a single test (measured on
# Terminal-Bench vba-userform-port), while the same agent on the host could.
# PIP_BREAK_SYSTEM_PACKAGES lets `pip install --user` work in this throwaway
# sandbox; venv is there for agents that prefer one.
# procps: agents reach for `ps` to check on a process; build-essential and
# python3-dev (Python.h, whose absence stopped a sklearn venv build): many
# Python projects (scikit-learn, astropy) compile extensions before a test runs,
# which the same agent on the host could always do.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  python3 python3-pip python3-venv python3-dev procps build-essential \
  && rm -rf /var/lib/apt/lists/*
ENV PIP_BREAK_SYSTEM_PACKAGES=1

# Pinned: the CLI's flag contract is load-bearing (see claude-code.ts), so an
# unpinned upgrade can silently change how every runner behaves. Kept equal to
# the host CLI a benchmark compares against — bench/swebench/run_instance.mjs
# refuses to run when they differ (background-task handling changed between
# 2.1.261 and 2.1.280).
RUN npm install -g @anthropic-ai/claude-code@2.1.280

# Claude Code's Bash tool does not inherit the container's PATH (measured: a
# pod PATH with a lent toolchain first still gave the agent /usr/bin/python3),
# but it sources CLAUDE_ENV_FILE into every command. src/k8s/sandbox-env.ts sets
# both variables when a toolchain is lent.
RUN printf '%s\n' '[ -n "$ORG_TOOLCHAIN_PATH" ] && export PATH="$ORG_TOOLCHAIN_PATH:$PATH"' > /etc/org-sandbox-env.sh

# job-manifest.ts pins runAsUser: 1000; node:22-slim already ships a uid-1000
# "node" user, so nothing further is needed for the security context to work.
USER node
WORKDIR /workspace
