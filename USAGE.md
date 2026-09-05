# Using the Accountable Agent Organization Runtime

## One-time setup

1. Install Docker, `kind`, and `kubectl` if you don't have them.
2. In this repo: `npm install && npm run build && npm link` — this makes the `org` command available anywhere on your machine. If `org` still isn't found afterwards, npm's global bin directory isn't on your `PATH`; symlink it somewhere that is: `ln -sf "$(npm config get prefix)/bin/org" ~/.local/bin/org`.
3. Authenticate — pick one:
   - **Claude subscription (recommended, no extra cost):** run `claude login` once on this machine. The runtime relays your existing session in automatically on every run — nothing to export, nothing to keep in sync.
   - **API key:** `export ANTHROPIC_API_KEY=sk-ant-...` (add it to your shell profile) — get one at https://console.anthropic.com/settings/keys. Only used if no subscription login is found.
4. `org doctor` — this auto-bootstraps a local Kubernetes cluster (`kind`) the first time. Fix anything it reports red, then re-run it.
5. `./scripts/build-runner-image.sh` — builds the sandbox image and loads it into the cluster. Re-run it if `org doctor` ever reports the runner image missing (recreating the cluster clears it).

If your user isn't in the `docker` group, prefix **setup** commands with `sg docker -c "..."` (`org doctor` tells you when this is the problem). Everyday use — `org run`, `org tree`, `org watch`, `org approve` — talks to Kubernetes, not Docker, and needs no group membership.

## Every time you want to use it

1. `cd` into the repository you want the organization to work on. It must live somewhere under your home directory.
2. `org run "<describe what you want done>"` — creates a root accountable node. Add `--repo <path>` to point at a different repository, and `--spawn --budget <usd> --max-children <n>` if you want it able to delegate subtasks to child nodes (a child costs $1 of budget; below that, it asks you for approval instead of failing silently).
3. `org watch` (in another terminal) — live view of the organization tree as it works.
4. If something needs your approval: `org approvals` lists what's pending, `org approve <id>` or `org reject <id>` resolves it.
5. `org tree` — quick status check any time. `org commitment <id>` / `org decision <id>` — see what it decided and why, with the full score breakdown.
6. When you're done for the session: `org daemon stop`.

If you're logged in via `claude login`, that's it — no daemon-restart gotchas, since the subscription's credentials are read fresh from disk on every single run. The API-key path is different: the daemon only captures `ANTHROPIC_API_KEY` when it starts, so if you export it after the daemon is already running, `org run` notices and restarts the daemon for you — you don't have to. With neither available, `org run` refuses rather than dispatching work that would fail authentication several minutes later.

## What it actually does

Each node plans, decides for itself whether to do the work directly or delegate it to a child node (based on a transparent scoring formula you can inspect via `org decision`), and executes inside an isolated, network-restricted Kubernetes sandbox — not directly on your machine. Only the repository you point it at is visible inside that sandbox.
