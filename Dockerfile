FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Pinned: the CLI's flag contract is load-bearing (see claude-code.ts), so an
# unpinned upgrade can silently change how every runner behaves.
RUN npm install -g @anthropic-ai/claude-code@2.1.261

# job-manifest.ts pins runAsUser: 1000; node:22-slim already ships a uid-1000
# "node" user, so nothing further is needed for the security context to work.
USER node
WORKDIR /workspace
