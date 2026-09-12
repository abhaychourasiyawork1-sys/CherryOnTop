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
The budget is checked at the same place a tool call is: immediately before a sandbox
opens. An agent that has already spent its share gets no further sandbox, and says so in
its transcript rather than failing silently. A mandate with no budget set (`$0`) means
nobody costed it, not that it is out of money, so it is not stopped on spend.
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

## Token efficiency

The runtime tiers models by role, caps how long planning and synthesis can run, and caches
plans — all to spend fewer tokens without changing what a run produces. Every knob below is
an `ORG_*` environment variable with a baked-in default; there is no config file. **The
daemon captures its environment once at start**, so changing one of these takes effect on
the next `org daemon` restart — the same contract as `ORG_RUNNER_IMAGE`.

| Variable | Default | What it does |
|---|---|---|
| `ORG_MODEL_PLAN` | `haiku` | Model used for planning dispatches |
| `ORG_MODEL_EXECUTE` | *(none — runtime default)* | Model used for execution dispatches |
| `ORG_MODEL_SYNTHESIZE` | `haiku` | Model used for synthesis dispatches |
| `ORG_MAX_TURNS_PLAN` | `2` | Turn cap for planning dispatches. Planning is look-then-answer: it is handed a goal-aware repository map and asked for a JSON array, not asked to explore |
| `ORG_MAX_TURNS_SYNTHESIZE` | `1` | Turn cap for synthesis dispatches |
| `ORG_MAX_TURNS_EXECUTE` | `60` | Circuit breaker on work dispatches. Cost inside a dispatch grows superlinearly in turns — the conversation prefix is re-read on every one — and this was the only unbounded term in the system. The agent is told the number so it summarises at the limit rather than being cut off at it. `0` removes the cap |
| `ORG_PLAN_CACHE_TTL_HOURS` | `24` | How long a cached plan stays valid; `0` disables the plan cache |
| `ORG_RESULT_CACHE_TTL_HOURS` | `24` | How long a finished **read-only** dispatch's answer may be served again, for the same goal against the same committed HEAD under the same model and grant; `0` disables result reuse |
| `ORG_REPO_MAP_TOKENS` | `6000` | **Ceiling** — not a target — on the repository context prefixed onto a dispatch; `0` disables it |
| `ORG_ROLE_PROMPTS` | on | Role-scoped system prompts (below); `off`/`0`/`false`/`no` disable |
| `ORG_EFFICIENCY_MODE` | `enabled` | `enabled` \| `shadow` \| `disabled` — see **Rollout** below |
| `ORG_MODEL_FAST` | `haiku` | Model for the fast tier |
| `ORG_MODEL_STANDARD` | *(none — runtime default)* | Model for the standard tier |
| `ORG_MODEL_DEEP` | *(none — off)* | Model for the deep tier. Unset means routing never tiers **up** |
| `ORG_MAX_CHILD_JOBS` | `2` | Most children one node may fan out to. A node's own `max_child_count` authority can only lower this, never raise it |

An empty value, or `none`/`default`/`off`, on any `ORG_MODEL_*` variable means "pass no
`--model` flag" — the runtime's own default model is used instead.

**Repository context.** On the first dispatch against a given worktree HEAD the runtime
scans the repo once — every tracked file plus its top-level symbols — and caches that scan
by HEAD. What is cached is the *unbudgeted* scan, so every node sitting on the commit shares
one `git ls-files` and one pass over the sources, while each still gets a different view of
it. Turning `ORG_REPO_MAP_TOKENS` down therefore bites on the next dispatch rather than the
next commit, by construction.

Each dispatch then selects from that scan the part its **goal** is about: goal terms are
matched against path segments and camelCase-split symbol names, and files nothing ties to
the goal are dropped rather than used to top the budget up. `ORG_REPO_MAP_TOKENS` is a
ceiling, not a target — a one-file fix should and does come in far under it. Both planning
and execute dispatches get context; planning previously had none and spent its turns
rediscovering the repository.

Two things keep this from being lossy in the harmful direction. A directory skeleton is
always included (capped at a share of the budget), so a goal that matches nothing still
leaves the agent knowing the repo's shape. And the wrapper states plainly that the listing
is partial and that other files exist — an agent told "here is a map of the repository"
would reasonably read an absent file as a missing one.

Each dispatch publishes a `context.receipt` event recording the budget, how many files were
selected and dropped, whether anything relevant was truncated, and whether the selection was
actually applied. Since a dispatch is an `argv` array with nowhere to attach metadata, the
event log is that channel. If selection ever throws, it degrades **upward** — to the whole
inventory rendered to the same ceiling, which is what every dispatch received before.

Set `ORG_REPO_MAP_TOKENS=0` to turn context off entirely.

**Model routing.** Beyond the fixed per-role choice, execution dispatches pick a tier from
the goal's assessed complexity: low-complexity work runs on the fast tier, and so does any
node that has spent more than 80% of its budget. Routing is deliberately asymmetric — it
tiers **down** freely, and tiers **up** only to a model you have named in `ORG_MODEL_DEEP`.
A downgrade that goes wrong is caught by the model-rejection fallback below; an upgrade that
goes wrong is a bill nobody asked for. An explicit `ORG_MODEL_PLAN`/`_EXECUTE`/`_SYNTHESIZE`
overrides routing outright. Every routing decision is written to memory as a `model_route`
row with its reason.

**Turn budget.** A dispatch's cost does not grow with its turn count, it grows *faster*
than its turn count: the conversation prefix is re-read on every turn, so a measured 42-turn
run spent 1.77M cache-read tokens against a 19-turn one's 652k. Work dispatches were left
uncapped on the reasoning that a whole-codebase investigation needs its turns — true, and it
left the dominant term in the bill unbounded. `ORG_MAX_TURNS_EXECUTE` (default 60) is a
circuit breaker sitting above every turn count measured here, so it costs nothing today and
bounds the tail. The agent is *told* the number in its role prompt: a run cut off at a cap
reports "max turns exceeded" and loses what it found, while one that knows its budget
summarises inside it.

**Result reuse.** The same read-only goal, under the same model and the same grant, gets the
answer the last run produced instead of a second sandbox — applied where the money is: a
cached plan skips a dispatch measured at $0.045, a cached read-only execution skips one
measured at $0.95. Strictly read-only, because "we did not re-run it" is only equivalent to
"we re-ran it" when there were no side effects to lose. A hit publishes the answer as a
`node.answer` event (the reused run leaves no transcript of its own), counts as *work
avoided* rather than a zero-token dispatch, and reports what that work cost the last time it
was actually paid for. `org tokens` shows the hits; `ORG_RESULT_CACHE_TTL_HOURS=0` turns it
off.

What makes a reused answer still true is **not** the commit it was produced at. Keying on
HEAD is correct and blunt: one commit to a README would invalidate every cached answer about
every module, which in a repository anyone is working in is a cache that never hits. Validity
is instead the files the run actually read — taken from its own event stream, so it is the
run's evidence rather than a guess — checked against the current tree file by file. A
directory it *searched* is checked as a set, so a module added to an audited package
invalidates the audit rather than being silently omitted from it. Two things make it fall
back to requiring the exact commit: a `Bash` call, which can read anything we cannot name,
and a stream we learned nothing from. A dirty tree is never reusable at all.

**Critical-path scheduling.** The sandbox queue holds two things that are not comparable. A
planning dispatch is capped at 2 turns and nothing can start until it answers; a synthesis
dispatch is capped at 1 turn and is the last thing between a person and their answer; a work
dispatch may run 60 turns and blocks only itself. Coordination dispatches therefore take a
freed slot ahead of queued work dispatches. Ordering only — the concurrency ceiling
(`ORG_MAX_CONCURRENT_SANDBOXES`) is untouched, so the worst this degrades to is the
first-in-first-out behaviour it replaced.

**Replaying a decision.** `org decision <nodeId> --replay` re-runs each recorded decision
through the same arithmetic that produced it and reports whether today's code still agrees,
naming the single term that would have flipped it. Free — the decisions were formulas, not
model calls. A decision taken on a rule rather than a score is reported as *not replayable*
rather than as reproduced: announcing an audit that never happened is worse than announcing
none.

**Conditional synthesis.** A delegating node used to buy a synthesis sandbox whenever any
child had said anything. Children now close their report with a small JSON envelope (status,
summary, findings, changed files, uncertainties, confidence) alongside their prose, which
lets the parent see what they said without paying a model to read it. The parent then routes:
one reporter returns its own answer; compatible, self-declared-complete results merge
deterministically at zero tokens; and a model is kept for what genuinely turns on judgement
— two children that edited the same file, a child that half finished or is unsure of itself,
or prose nothing can parse. The rule for reaching the model is deliberately generous: a merge
that guesses is far worse than a synthesis call that was not strictly necessary. A child that
ignores the envelope request, or emits something malformed, degrades to exactly the old prose
merge.

**Rollout.** `ORG_EFFICIENCY_MODE` is one switch over context selection, conditional
synthesis and model routing together:

- `disabled` — the behaviour before this work: the full repository map on every dispatch,
  unconditional synthesis, fixed per-role models.
- `shadow` — every decision is computed and recorded (`context.receipt` events with
  `applied: false`, `model_route` and `integration_decision` memory rows) but **not acted
  on**, so the run stays byte-comparable to a `disabled` one. This is how you see what the
  change would do before taking it.
- `enabled` (default) — the decisions are acted on.

Because it is a single switch, it is also the A/B knob: `node bench/run.mjs efficiency`
runs the fixed goal set with it `enabled` and `disabled`. **That dispatches real, paid model
calls.**

**Measuring it.** Every task writes one `efficiency_record` to memory when it reaches a
terminal state: tokens split into input/output/cached, the coordination and recovery
*shares* of them, dispatch counts, time spent getting a container ready rather than working
(`executionOverheadRatio` — the measurement that decides whether warm pools and snapshots
would be machinery bought to save seconds on a path that costs minutes; it enables nothing on
its own, which is the point), the dispatches that were avoided and what those avoided
dispatches had cost when they were last actually paid for, queue time separated
from dispatch time, and end-to-end wall clock. `workAvoidedRatio` — dispatches avoided over
dispatches considered — is the direct answer to "is this organization getting cheaper as it
accumulates reusable work?". `src/efficiency/objective.ts` turns a set of
those into a verdict — tokens per **successful** task, p50/p95 latency over every task, and
a normalized objective `J` — behind two hard gates that no weighting can trade away: quality
must not regress, and success rate must not fall by more than epsilon. An optimized run that
was never quality-scored fails the gate rather than passing it by silence.

**Role-scoped system prompts.** With `ORG_ROLE_PROMPTS` on, three of the runtime's four
lifecycle stages — `plan`, `execute`, `synthesize` — get a system prompt (the shared
"harness constitution" plus a stage-specific stanza, defined in `src/prompts/roles.ts`)
delivered via the runtime's `--append-system-prompt`, instead of that framing being
repeated in the user prompt on every turn. A fourth role, `verify`, has a stanza defined
but is not wired to any dispatch. Turning it off (`off`/`0`/`false`/`no`) folds that
framing back into the prompt text instead — with one gap, described next.

The same applies on a runtime that has no `--append-system-prompt` at all (Codex exec is
the current example, and silently drops appended system prompts). Which route is used is
decided per dispatch by `honoursSystemPrompt()` probing the adapter, rather than by
hardcoding runtime names, and the framing appears exactly once either way. What goes
inline differs by stage:

- `plan` and `synthesize` fold in their **whole** stanza, so nothing is lost.
- `execute` folds in only the **standing constraints** from the node's mandate. Its stanza
  — the harness constitution, the allowed-tools sentence, and the definition of done —
  rides the system prompt only, and is not delivered when role prompts are off or when the
  run lands on a system-prompt-less runtime. Constraints always arrive; the rest of the
  execute framing does not. If you depend on the definition of done reaching the agent,
  leave `ORG_ROLE_PROMPTS` on and check `org tree` for which runtime a node selected.

A tiered-down model is only sent to a runtime that can actually serve it: the adapter is
asked first (`modelFor()`), so a Claude alias like Haiku is never sent to Codex, which
would fail the whole dispatch — no plan, or no combined answer. If the model is one the
runtime accepts but your plan cannot call, all three roles fall back to a one-shot retry
without `--model`, which costs an extra rejected request every time. `org doctor` now has a
**callable models** row that probes both Haiku and Sonnet with your current auth and tells
you up front which one (if either) will hit this fallback. That probe **makes two real,
billable model calls and can take up to ~40 seconds**, so unlike the rest of `org doctor`
it spends a little of your quota each time you run it.

### `org tokens [caseId]`

Prints per-role, per-model token usage: number of dispatches, input/output/cache-read
tokens and cost, with a total row and how many dispatches were served from the plan cache
instead of a fresh model call. Pass a case id to scope it to one case; omit it for
everything recorded.

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
