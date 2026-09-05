# Using the Accountable Agent Organization Runtime

## One-time setup

1. Install Docker, `kind`, and `kubectl` if you don't have them.
2. In this repo: `npm install && npm run build && npm link` — this makes the `org` command available anywhere on your machine. If `org` still isn't found afterwards, npm's global bin directory isn't on your `PATH`; symlink it somewhere that is: `ln -sf "$(npm config get prefix)/bin/org" ~/.local/bin/org`.
3. Authenticate — pick one:
   - **Claude subscription (recommended, no extra cost):** run `claude login` once on this machine. The runtime relays your existing session in automatically on every run — nothing to export, nothing to keep in sync.
   - **API key:** `export ANTHROPIC_API_KEY=sk-ant-...` (add it to your shell profile) — get one at https://console.anthropic.com/settings/keys. Only used if no subscription login is found.
4. `org doctor` — this auto-bootstraps a local Kubernetes cluster (`kind`) the first time. Fix anything it reports red, then re-run it.
5. `./scripts/build-runner-image.sh` — builds the sandbox image and loads it into the cluster. Re-run it if `org doctor` ever reports the runner image missing (recreating the cluster clears it).

If your user isn't in the `docker` group, prefix **setup** commands with `sg docker -c "..."` (`org doctor` tells you when this is the problem). Everyday use — `org`, `org run`, `org tree`, `org approve` — talks to Kubernetes, not Docker, and needs no group membership.

## Every time you want to use it

1. `cd` into the repository you want the organization to work on. It must live somewhere under your home directory.
2. `org` — opens the interactive dashboard, which is the normal way to use this. It starts the daemon if it isn't running. From there: `n` starts a run (goal, repo, delegation, budget, max children), `t` opens the tree, `enter` drills into a node, `a` jumps to whatever is waiting on your approval, `q` quits.
3. Inside a node: the lifecycle line shows where it is, the decision block shows the full score breakdown behind `SELF_EXECUTE`/`DELEGATE`/`ESCALATE`, and the output section renders Claude Code's actual reasoning, tool calls and diffs **live, as they happen**. `l` opens the full unabridged output (scroll with `↑↓`/`jk`, `f` jumps back to live), `d` opens every decision the node has made, `esc` goes back.
4. If a node is waiting on you, its detail screen offers `y` approve / `r` reject in place.

The scriptable commands still work standalone if you prefer them or need them in a script:

- `org run "<what you want done>"` — creates a root node. `--repo <path>` points at a different repository; `--spawn --budget <usd> --max-children <n>` lets it delegate (a child costs $1 of budget; below that, it asks for approval instead of failing silently).
- `org tree` — quick status check. `org commitment <id>` / `org decision <id>` — what it decided and why.
- `org approvals`, `org approve <id>`, `org reject <id>` — the approval flow outside the dashboard.
- `org daemon stop` — when you're done for the session.

If you're logged in via `claude login`, that's it — no daemon-restart gotchas, since the subscription's credentials are read fresh from disk on every single run. The API-key path is different: the daemon only captures `ANTHROPIC_API_KEY` when it starts, so if you export it after the daemon is already running, `org run` notices and restarts the daemon for you — you don't have to. With neither available, `org run` refuses rather than dispatching work that would fail authentication several minutes later.

## What it actually does

Each node plans, decides for itself whether to do the work directly or delegate it to a child node (based on a transparent scoring formula you can inspect via `org decision`), and executes inside an isolated, network-restricted Kubernetes sandbox — not directly on your machine. Only the repository you point it at is visible inside that sandbox.
