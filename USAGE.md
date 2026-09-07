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
| `/stop [--task] <id>` | Cancel one agent, or the whole task with `--task` |
| `/focus [id]` | Narrow the transcript to one node; bare `/focus` restores everything |
| `/verbose` | Show the raw events normally suppressed |
| `/cost` · `/doctor` · `/daemon start\|stop\|status` | Spend, environment checks, daemon control |
| `/history [n]` · `/clear` · `/notify` · `/help` · `/quit` | Transcript and session control |

`esc` interrupts the node you are focused on (or the only one running). `ctrl+c` twice quits — runs keep going in the daemon, and reopening `org` replays recent activity.

## Mission Control — the desktop view

`org gui` opens a window organized around **cases**. One case is one goal you gave and
every agent it delegated to. It starts the daemon if it isn't running, and closing the
window does not stop anything — runs keep going, exactly as with the CLI.

First time only: `npm run gui:build`.

**Open it from the repository you want worked on.** `org gui` mounts that repository into
every sandbox it dispatches, exactly as `org run` does. Opened somewhere that isn't a git
repository, the window still shows past runs but says why it cannot start a new one.

The window has four destinations in the left rail.

### Desk — what needs you

The first screen, and an inbox of *consequences* rather than only of approvals. Six things
can put a case here, ranked by who is blocked:

| | |
|---|---|
| **Waiting on you** | An agent reached the edge of its authority and stopped. Decide it in place, with the scored decision that took it there. |
| **Interrupted** | The daemon stopped while it was working. Its place is saved; Resume picks up from there. |
| **Over budget** | Spend passed the ceiling it was authorized for. |
| **Refused a tool** | It reached for something its mandate does not grant, and was refused. |
| **Finished incomplete** | It reported done with one of its own checks unmet. |
| **Gone quiet** | Still running, but nothing has happened for five minutes. |

Below the queue, everything running right now, with a live line saying what each agent is
doing and how long it has been doing it.

### Cases — every run, searchable

Every case you have ever started, with what it cost against its ceiling, how many agents
it built, how many of its checks were met, how long it ran, and whether a person had to
decide anything. Filter by outcome, mandate, runtime, repository, whether the checks are
all met, and whether it ran untouched by a human. Search the goal.

### A case — four views over one record

The **Conversation** answers three questions in order: what you asked, what came back, and
how it got there. The answer sits at the top the moment it exists, rather than at the end
of the working. Each agent is a numbered station on a single spine, named for what it
worked on — a path where there is one — and what it *did* is folded into one line
("12 read · 3 edited · 1 command") that opens on click. What the organization decided is
kept small and quiet beside what the agents actually said, so the two never read as the
same kind of thing.

Above every view, the header answers what a person actually asks: the objective, the
mandate it ran under and what that permitted, where it got to, what it spent, how many of
its promised checks are met, what it produced, and how many decisions a human made.
**Run again** forks it under a different mandate. **Stop task** ends the whole thing at
once — every agent in it, however deep — and asks you to confirm, naming how many will
stop. Stopping agents one at a time does not work on an organization: a parent whose child
you cancel treats that as a failed delegation and dispatches a replacement.

- **Conversation** — what the agents thought and said, as a transcript. Each speaker sits
  in the left gutter, indented by how deep in the hierarchy it is, so you watch the
  organization take shape in the shape of the reading. File edits and commands appear as
  one quiet line each; click one for the diff. When the work was split, the root reads
  every agent's report and writes one combined answer at the end.
- **Organization** — the same case as a chart you can move around: **scroll to zoom**
  (toward the pointer, so whatever you are looking at stays put), **drag to pan**, and
  **Fit** to bring the whole tree back. A **scrubber** sits underneath. Drag it and
  the organization replays its own history: agents appearing, budgets draining, approvals
  blocking. Click any agent for its full detail on the right — its answer, spend against
  budget, its checks, the authority it held, its scored decisions, what it produced, and
  its runtime's own output.
- **Proof** — the evidence ledger. Every scored decision, every artifact, every refused
  tool call and every point a person decided something, filtered by the question you are
  asking. Open any entry for its chain of custody and, for a decision, its arithmetic.
- **Receipt** — the whole case as one object you can hand to someone else, and export as a
  single self-contained HTML file. It carries the mandate, the chain of custody, the
  checks and their evidence, every decision, every human decision, cost and time. It does
  not show the model's internal reasoning, and says so.

### Mandates — what agents are permitted to do

A mandate is the authority a case runs under: which tools, whether it may delegate and how
far, how much it may spend, and any standing instructions.

Both limits are **pools an agent divides among the agents it creates**, never counters it
decrements. "Up to 6 agents" means the whole organization, at any depth — not six per
agent — and a child's budget is a share of its parent's, so a $25 root splitting three ways
gives each child $6.25 and keeps a share for its own planning. The total can therefore
never exceed what you authorized, which is what the sentence above the input box promises. Three ship with the app —
**Investigate** (read-only, no delegation, $1), **Focused change** (editing tools, one
agent, $5) and **Project** (up to five agents, $25) — and you can make your own.

As you edit one, the panel beside it says exactly what an organization under it could and
could not do, and what would make it stop and ask you. That is worked out from the
contract alone: no model, no sandbox, nothing spent. The same line appears above the input
box before you press Start, so you always know the blast radius in advance.

Two boundaries are enforced by the platform: the **budget**, and the **tools**. A tool a
mandate does not grant is refused before the call happens, and the refusal is recorded.
**Instructions are not enforced** — they are told to the agent, and the window labels them
that way everywhere it shows them.

An empty tool list means *no restriction*, not *no tools*. The shipped mandates all name
their tools explicitly.

### Memory — what the organization has learned

Measured from its own finished runs, not from a benchmark: success rate, average cost and
average time per runtime. These are the numbers the runtime selection actually picks with,
so each claim shows the runs behind it and lets you **exclude** one you know was anomalous
— which changes what it decides next. Anything under five runs says so rather than
printing a percentage it has not earned.

### Everywhere

- **One input.** The box at the bottom is the only place to type. Typing a goal starts a
  case under the mandate shown beside it. Typing a question — `why`, `what is blocking
  this`, `what did it produce`, `cost` — answers it in place from the record, not from a
  model.
- **Agents queue rather than stampede.** At most two sandboxes run at once, because the
  limit that matters is your Claude usage quota, not the cluster — a fan-out that started
  five agents at once could spend a five-hour window in minutes. A queued agent says so,
  and how many are ahead of it. Raise it with `ORG_MAX_CONCURRENT_SANDBOXES=4` if you are
  billing against an API key rather than a subscription.
- **If you run out of quota**, the run says exactly that and when the window resets, rather
  than reporting a network problem.
- **If the daemon restarts**, an agent parked on your approval is put back exactly where it
  was and your decision still counts. An agent that was mid-execution is marked
  **Interrupted** with its place saved, and waits for you to Resume it — carrying on costs
  a fresh sandbox, and spending money is your call, not a daemon's.

`npm run gui` runs it against a live-reloading renderer if you are working on it.
Set `ORG_DAEMON_PORT` (and `VITE_ORG_DAEMON_PORT` when building) to point it at a
daemon other than the default `4177`.

Two things exist only for working on the window itself: `npm run seed:demo` fills a
database with a plausible history (`ORG_DB_PATH=./demo.db npm run seed:demo`), and
`npm --prefix gui run dev:renderer` serves the renderer in a plain browser on port 5199,
proxying to the daemon so the two share an origin. Neither is part of the app.

The scriptable commands still work standalone if you prefer them or need them in a script:

- `org run "<what you want done>"` — same flags as `/run`.
- `org tree`, `org commitment <id>`, `org decision <id>` — status and reasoning.
- `org approvals`, `org approve <id>`, `org reject <id>` — the approval flow outside the session.
- `org daemon stop` — when you're done for the session.
- `org verify` — walks the event log and reports the first row that no longer matches its
  hash. Each event is hashed over the one before it, so an edit after the fact is
  detectable. This shows the log has not been quietly changed; it is not proof that it
  cannot be, and nothing in the product claims otherwise.

If you're logged in via `claude login`, that's it — no daemon-restart gotchas, since the subscription's credentials are read fresh from disk on every single run. The API-key path is different: the daemon only captures `ANTHROPIC_API_KEY` when it starts, so if you export it after the daemon is already running, `org run` notices and restarts the daemon for you — you don't have to. With neither available, `org run` refuses rather than dispatching work that would fail authentication several minutes later.

## What it actually does

Each node plans, decides for itself whether to do the work directly or delegate it to a child node (based on a transparent scoring formula you can inspect via `org decision`), and executes inside an isolated, network-restricted Kubernetes sandbox — not directly on your machine. Only the repository you point it at is visible inside that sandbox.

Given a goal big enough to split, a node first plans: it opens a short sandbox
against your repository, works out whether the goal breaks into independent
pieces, and hands each piece to its own agent to work on in parallel. A goal that
does not genuinely split is done directly rather than handed down a chain — the
planner says so, and you can read its reasoning in the Conversation.

It also chooses which runtime to dispatch to — Claude Code or Codex — by the same kind of
scored, inspectable decision, using the success rate, cost and latency it has measured
from its own past runs. Until a runtime has enough history to judge, it says so and stays
on the default rather than pretending to have decided. Everything a run produces — files
written, commands run, results — is captured as it happens and becomes the evidence that
closes the node's commitment.
