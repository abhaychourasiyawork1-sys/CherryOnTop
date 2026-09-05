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
2. `org` — opens the interactive session, which is the normal way to use this. It starts the daemon if it isn't running.
3. **Type what you want done and press enter.** That starts a run against the current directory. Everything the organization does then streams into one transcript: what each node decided and *why*, and Claude Code's actual reasoning, tool calls and diffs as they happen.
4. **Type `/` for commands.** A menu appears with every command and what it does; `⇥` completes, and `⇥` after a command completes its argument from live state (`/approve ⇥` offers the ids actually waiting on you). `?` on an empty line opens help.

The commands:

| Command | What it does |
|---|---|
| `/run [--spawn] [--budget <usd>] [--max-children <n>] [--repo <path>] <goal>` | A run with options — plain text is this with defaults |
| `/tree` | The node tree as it stands |
| `/why <id>` | The full scoring behind a node's decisions |
| `/approve <id>` · `/reject <id>` · `/approvals` | The approval flow |
| `/stop <id>` | Cancel a running node and tear down its sandbox |
| `/focus [id]` | Narrow the transcript to one node; bare `/focus` restores everything |
| `/verbose` | Show the raw events normally suppressed |
| `/cost` · `/doctor` · `/daemon start\|stop\|status` | Spend, environment checks, daemon control |
| `/history [n]` · `/clear` · `/notify` · `/help` · `/quit` | Transcript and session control |

`esc` interrupts the node you are focused on (or the only one running). `ctrl+c` twice quits — runs keep going in the daemon, and reopening `org` replays recent activity.

The scriptable commands still work standalone if you prefer them or need them in a script:

- `org run "<what you want done>"` — same flags as `/run`.
- `org tree`, `org commitment <id>`, `org decision <id>` — status and reasoning.
- `org approvals`, `org approve <id>`, `org reject <id>` — the approval flow outside the session.
- `org daemon stop` — when you're done for the session.

If you're logged in via `claude login`, that's it — no daemon-restart gotchas, since the subscription's credentials are read fresh from disk on every single run. The API-key path is different: the daemon only captures `ANTHROPIC_API_KEY` when it starts, so if you export it after the daemon is already running, `org run` notices and restarts the daemon for you — you don't have to. With neither available, `org run` refuses rather than dispatching work that would fail authentication several minutes later.

## What it actually does

Each node plans, decides for itself whether to do the work directly or delegate it to a child node (based on a transparent scoring formula you can inspect via `org decision`), and executes inside an isolated, network-restricted Kubernetes sandbox — not directly on your machine. Only the repository you point it at is visible inside that sandbox.
