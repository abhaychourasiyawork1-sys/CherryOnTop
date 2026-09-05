FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# job-manifest.ts pins runAsUser: 1000; node:22-slim already ships a uid-1000
# "node" user, so nothing further is needed for the security context to work.
USER node
WORKDIR /workspace
