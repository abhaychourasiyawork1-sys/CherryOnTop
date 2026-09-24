FROM node:22-slim

# Python beside Node: an agent is asked to build and *test* whatever the task
# needs, and many tasks are Python. Without it the agent spent turns searching
# the image for an interpreter and could not run a single test (measured on
# Terminal-Bench vba-userform-port), while the same agent on the host could.
# PIP_BREAK_SYSTEM_PACKAGES lets `pip install --user` work in this throwaway
# sandbox; venv is there for agents that prefer one.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*
ENV PIP_BREAK_SYSTEM_PACKAGES=1

# Pinned: the CLI's flag contract is load-bearing (see claude-code.ts), so an
# unpinned upgrade can silently change how every runner behaves.
RUN npm install -g @anthropic-ai/claude-code@2.1.261

# job-manifest.ts pins runAsUser: 1000; node:22-slim already ships a uid-1000
# "node" user, so nothing further is needed for the security context to work.
USER node
WORKDIR /workspace
