# cherryontop — Accountable Agent Organization Runtime

Give it a goal against a repository, and it grows an **organization of AI agents** to get
it done: a root agent that plans, decides whether to do the work itself or delegate it,
and — when a goal genuinely splits into independent pieces — spins up child agents to work
on those pieces in parallel, each with its own budget and authority.

Every agent runs inside an isolated, network-restricted Kubernetes sandbox, never directly
on your machine, and only the repository you point it at is visible inside that sandbox.
Every decision an agent makes — do the work directly or delegate, which runtime to
dispatch to, when to stop and ask a human — is made by a transparent, inspectable scoring
formula, not a hidden model call, and is logged as evidence in a hash-chained event log you
can independently verify (`org verify`).

The result is meant to be **accountable**: at the end of a run you can show someone exactly
what was authorized, what was decided, what was spent, and what evidence backs every claim
— not just a diff and a changelog.

## Why

Autonomous coding agents are useful and also opaque: it's hard to know in advance what an
agent *could* do, hard to know afterward *why* it did what it did, and hard to hand the
result to someone else with any confidence in it. This runtime is an attempt to fix that by
making three things first-class:

- **Mandates** — the authority a run operates under (which tools, whether it may delegate
  and how far, how much it may spend) is declared up front, enforced by the platform (not
  just told to the model), and shown to you in plain language *before* you press start.
- **Scored decisions** — whether to delegate, which runtime to use, when to stop — are
  arithmetic you can inspect (`org decision <id>` / the Proof tab), not a black box.
- **Evidence** — every tool call, artifact, refusal, and human decision is captured as it
  happens and chained into a tamper-evident log, exportable as a single self-contained
  receipt you can hand to someone else.

## How it works

Given a goal, a node (agent) first **plans**: it opens a short sandbox against your
repository and works out whether the goal breaks into independent pieces. A goal that
doesn't genuinely split is done directly rather than handed down a chain — the reasoning is
recorded either way.

If it does split, each piece is handed to its own child node, which inherits a *share* of
its parent's budget and delegation depth — never a fresh allotment. Budgets and
delegation limits are pools an agent divides among the agents it creates, so the total a
run can ever spend or spawn can never exceed what you authorized at the top.

Each node also chooses **which coding runtime** to dispatch to (Claude Code or Codex) using
the same kind of scored decision, based on success rate, cost, and latency it has measured
from its own past runs — and says so when it doesn't have enough history to judge yet
rather than pretending to.

Everything a run produces — files written, commands run, results — is captured as it
happens and becomes the evidence that closes the node's commitment.

## Interfaces

- **`org`** — an interactive terminal session (built on Ink). Type a goal and press enter to
  start a run; type `/` for a command menu (approvals, tree view, cost, focus, history...).
  This is the primary way to use the runtime day to day.
- **`org <command>`** — the same functionality as scriptable one-shot CLI commands, useful
  standalone or in scripts (`org run`, `org tree`, `org approve <id>`, `org daemon stop`...).
- **`org gui`** — "Mission Control," an Electron desktop app organized around *cases* (one
  goal plus everything it delegated to), with an inbox of what needs you, a searchable case
  history, an org-chart view you can scrub through the run's history, a full evidence
  ledger, and a one-file exportable receipt.

All three talk to the same background **daemon**, which keeps runs going even if you close
the window or the terminal.

**→ See [USAGE.md](USAGE.md) for the full walkthrough** — setup, every CLI/TUI command,
and a detailed tour of Mission Control (Desk, Cases, a case's four views, Mandates, Memory).

## Requirements

- Node.js ≥ 22
- Docker, plus [`kind`](https://kind.sigs.k8s.io/) and `kubectl` — the runtime provisions a
  local Kubernetes cluster (via `kind`) to sandbox agent work
- A Claude subscription (`claude login`) or an Anthropic API key (`ANTHROPIC_API_KEY`)
- Recommended: [Laya](https://github.com/NandhaKishorM/laya) for System-1 decisions
  (`pip install "laya[serve]"`). The daemon starts it on its own. Without it the runtime
  still works, but it does not split a goal across agents unless you explicitly ask it to.

## Quickstart

```bash
# 1. Install dependencies and build
npm install
npm run build
npm link              # makes `org` available on your PATH

# 2. Authenticate (pick one)
claude login                              # recommended — no extra cost
export ANTHROPIC_API_KEY=sk-ant-...       # or use an API key

# 3. Check the environment (bootstraps a local kind cluster on first run)
org doctor

# 4. Build and load the sandbox image into the cluster
./scripts/build-runner-image.sh

# 5. From the repository you want worked on:
cd /path/to/your/repo
org
```

Then just type what you want done and press enter. See
[USAGE.md](USAGE.md#one-time-setup) for troubleshooting (Docker group membership, `PATH`
issues, etc.) and the complete command reference.

## Project layout

```
src/
  adapters/       runtime adapters (Claude Code, Codex) that actually execute work
  approvals/      human-in-the-loop approval flow
  architecture/   executable invariants — the rules the design is not allowed to break
  cli/            `org` CLI commands (run, tree, doctor, approve, gui, verify, ...)
  context/        goal-aware selection of the repository context a dispatch is given
  daemon/         background process that supervises runs across sessions
  db/             SQLite schema, migrations, and queries (Drizzle ORM)
  decision/       the economic control plane: state, actions, utility, trust, fallback
  doctor/         environment/health checks
  engines/        the scoring engines behind delegate-vs-execute and runtime-choice decisions
  efficiency/     per-task token/latency ledger and the objective that gates changes to it
  events/         the hash-chained event log
  evidence/       versioned cross-run knowledge, and what it is worth reusing
  execution/      step execution, credential handling, and workstream scheduling
  intelligence/   coordinates planning and decision-making for a node
  k8s/            Kubernetes client for provisioning sandboxes
  lifecycle/      node/case state machines (xstate) — spawn, delegate, execute, complete
  recovery/       evidence-preserving retries and what a failed attempt ruled out
  schemas/        zod schemas shared across the runtime (decisions, etc.)
  server/         tRPC server the CLI/TUI/GUI talk to
  tui/            the interactive `org` terminal session (Ink)
  validation/     the evidence ladder between "the process exited" and "the task worked"
gui/              Mission Control — the Electron desktop app
scripts/          setup and dev scripts (runner image build, demo seeding, migrations)
test/             integration tests
```

## Token efficiency

The thing being optimized is **cost per successful task**, not the size of the initial
prompt. A smaller prompt that sends the agent hunting for what it was not given is more
expensive, not less: cost inside a dispatch grows superlinearly in turns, because the whole
conversation prefix is re-read on every one.

So each dispatch is given the part of the repository its goal is about — chosen from the
goal's own words *and* the compiler's import edges, so a named file arrives with its
dependencies, its dependents and its test — planning and synthesis are skipped whenever
their answer is already known or already mechanical, and the model tier follows the work's
complexity. Turn budgets adapt to what a task was judged to need, and a spend guard at the
single dispatch chokepoint stops a task that has run out of money, run out of turns, or
stopped making progress.

On top of that sits an economic control plane that decides, at each execution boundary,
whether there is a material opportunity worth acting on — and almost always answers no.
The agent stays the reasoner; `CONTINUE` is a genuine no-op, and the dispatch that follows
is byte-identical to the one that would have happened without it. See
[docs/architecture/dynamic-economic-runtime.md](docs/architecture/dynamic-economic-runtime.md).

There are exactly **two runtime modes**, and both are reversible without a code change.
`ORG_EFFICIENCY_MODE=disabled` is **Baseline** — fixed per-role models, lexical context,
nothing decided from the state of a run — and anything else is **Full Architecture**.
(`shadow` was a third mode and is now an alias for Baseline, which is what a shadow run
dispatched as; the measurement it existed for lives in the benchmark harness instead.)
`ORG_CONTEXT_PLANNER=off` returns the lexical selector on its own. Every task writes an
`efficiency_record` when it finishes, and `org tokens` reports what was spent. See
[USAGE.md](USAGE.md#token-efficiency) for the knobs and the failure behaviour.

## Development

```bash
npm run dev:cli      # run the CLI from source (tsx, no build step)
npm test             # run the test suite (vitest)
npm run typecheck    # type-check without emitting
npm run gui          # run Mission Control against a live-reloading renderer
npm run seed:demo    # seed a local database with plausible demo history
```

Environment variables useful during development:

- `ORG_DAEMON_PORT` (and `VITE_ORG_DAEMON_PORT` when building the GUI) — point the CLI/GUI
  at a daemon other than the default `4177`.
- `ORG_MAX_CONCURRENT_SANDBOXES` — raise the default cap of 2 concurrent sandboxes if you're
  billing against an API key rather than a subscription quota.
- `ORG_DB_PATH` — point at an alternate SQLite database (used by `npm run seed:demo`).
- `ORG_SYSTEM1` — `laya` (default), `jev` or `off`. See [USAGE.md](USAGE.md#system-1-decisions-laya).

System-1 live tests are opt-in and never part of `npm test`:

```bash
SYSTEM1_LIVE_TESTS=1 VITEST_SUITE=integration npx vitest run src/system1/live-laya.integration.test.ts   # needs laya-serve on PATH or ORG_LAYA_URL
SYSTEM1_LIVE_TESTS=1 VITEST_SUITE=integration npx vitest run src/system1/live-claude.integration.test.ts  # needs a logged-in claude
```

## Verifying the record

```bash
org verify
```

Walks the event log and reports the first row whose hash no longer matches the one before
it. Every event is hashed over its predecessor, so an after-the-fact edit is detectable.
This demonstrates the log hasn't been quietly altered — it isn't a cryptographic proof that
it *can't* be, and nothing here claims otherwise.

## License

ISC
