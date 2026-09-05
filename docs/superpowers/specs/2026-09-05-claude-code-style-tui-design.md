# Claude-Code-Style TUI Design

Status: approved through Q&A brainstorming (2026-09-05). Supersedes [2026-09-05-interactive-tui-design.md](2026-09-05-interactive-tui-design.md), whose drill-down screen stack shipped and was then found to be the wrong interaction model in daily use.

## Why replace a TUI that works

The shipped dashboard is correct and passes its tests. It is also the wrong shape. Its failure is structural, not cosmetic:

- **It makes you navigate to information.** Home → tree → node → output is four keypresses before you see what an agent is actually doing. Claude Code never asks you to navigate; everything arrives in one scroll.
- **It shows nothing between states.** A node passes `ORIENT → PLAN → INTELLIGENCE_GATE → EXECUTION_DECISION` in well under a second. The dashboard renders a state name you must already understand, then moves on. Nothing explains what happened or why.
- **Its only input is keybindings.** There is no way to discover what the tool can do from inside the tool, and the multi-field new-run form takes five prompts to express what one sentence would.

The goal is Claude Code's interaction model — one transcript, one input box, slash commands — carrying the org-specific content the drill-down screens were built to show.

## Decisions

Each was chosen explicitly during brainstorming; the rejected alternatives are recorded so they are not silently revisited.

| Decision | Chosen | Rejected |
|---|---|---|
| Main view | One append-only scroll with a persistent input box | Split live-pane/input layout; keeping screens with a command palette overlay |
| Concurrent nodes | Chronological interleave with a speaker header per node change, children indented under parents, `/focus` to narrow | One node in full with others as status lines; raw interleave with id prefixes |
| Plain (non-slash) input | Starts a root run with that text as the goal, using `org run`'s current defaults | Rejecting plain text; context-sensitive meaning |
| On open | Replay the last 200 persisted events across all nodes, then continue live | Only still-running nodes; empty/live-only |
| Feature scope | All four bundles: input ergonomics, live feedback, depth on demand, interrupt & control | — |

## Architecture

An Ink application over three pure units and one thin rendering shell.

```
bus events (WebSocket) ─┐
persisted history ──────┼─→ transcript reducer ─→ Block[] ─→ <Transcript>
command results ────────┘                                      ├─ <Static> finalized blocks
                                                               └─ live tail (spinner, elapsed)
keystrokes ─→ <InputBox> ─→ command registry ─→ tRPC ─→ daemon
```

**Why `<Static>`.** Ink 7 exports `Static`, which writes output once and never repaints it. Finalized blocks go there, so a 500-event run neither flickers nor repaints the whole transcript per event, and the terminal's own scrollback works normally. Only the tail — the currently-working node's pending tool call, its spinner and elapsed timer — lives in the repainting region. Without this the design degrades into a full repaint per event, which is the failure mode that would make a long run unusable.

**What `<Static>` costs, and how the design pays it.** Output already written cannot be retroactively changed or removed — the same constraint a real terminal has. Two commands would otherwise pretend otherwise, so both are defined forward-only:

- `/focus <id>` filters which blocks are *emitted from now on*. It prints a marker line (`── focused on 71df36e0 · /focus to restore ──`) rather than rewriting history above it. Anything already on screen stays; this matches how a terminal behaves and needs no explanation to the user.
- `/clear` writes the terminal's own clear sequence, resets the reducer's block list, and remounts the `<Static>` region with a fresh key. It clears the screen, not the event log — `/history` still pages back through everything.

No other command depends on mutating already-written output.

### Unit 1 — transcript reducer (`src/tui/transcript.ts`)

A pure function `(state, BusEvent) → { state, blocks: Block[] }`. No React, no I/O.

```ts
type Block =
  | { kind: 'header'; nodeId: string; goal: string; state: string; depth: number }
  | { kind: 'line'; nodeId: string; line: RenderedLine }        // from stream-renderer.ts
  | { kind: 'system'; nodeId: string | null; text: string; tone: 'info' | 'warn' | 'good' | 'bad' }
  | { kind: 'command'; input: string; output: string[] };
```

Responsibilities:

- **Speaker headers.** Emit a `header` when the emitting node differs from the previous block's node, or when that node's lifecycle state changes. This is what keeps interleaved output readable.
- **Depth.** Children indent under parents, computed from `parentId`.
- **Narration.** Turn `state.transition` events into readable `system` blocks rather than bare state names: node created (with repo, delegation and budget), decision made with its one-line reason, delegation, escalation, terminal result with cost and duration. This is the direct fix for "shows nothing between states".
- **Finalization.** A block is finalized once it cannot change: any line whose node has since emitted something else, and every resolved tool call. Finalized blocks are handed to `<Static>`; the reducer marks them, the shell routes them.
- **Delegation to `stream-renderer.ts`.** Claude Code event rendering is already correct and stays untouched; the reducer only wraps its `RenderedLine` output in attribution.

`/verbose` relaxes the renderer's noise suppression so `system`, hook and rate-limit events appear; nothing is ever discarded, only withheld.

### Unit 2 — command registry (`src/tui/commands/`)

One record per command; the executor, the `/` autocomplete menu and `/help` all read the same list, so a command cannot exist without documentation.

```ts
interface Command {
  name: string;
  summary: string;
  usage?: string;
  completeArg?: (partial: string) => Promise<string[]>;
  run(args: string, ctx: CommandContext): Promise<Block[]>;
}
```

`completeArg` is load-bearing for the "feels finished" requirement: `/approve ⇥` offers the ids actually awaiting approval, `/focus ⇥` the running nodes, `/why ⇥` the nodes that have decisions.

| Command | Purpose |
|---|---|
| `/run <goal>` | Root run. Flags `--spawn --budget <usd> --max-children <n> --repo <path>`. Bare text is this with defaults. |
| `/tree` | Snapshot of the node tree printed into the scroll |
| `/focus [id]` | Narrow the scroll to one node; bare `/focus` restores everything |
| `/why <id>` | Full economics breakdown behind a decision |
| `/approve <id>`, `/reject <id>`, `/approvals` | Approval flow |
| `/stop <id>` | Cancel a running node |
| `/cost` | Spend summary |
| `/doctor` | Environment checks, inline |
| `/daemon start\|stop\|status` | Daemon lifecycle |
| `/verbose`, `/clear`, `/history [n]`, `/notify` | Transcript controls |
| `/help`, `/quit` | — |

Argument parsing reuses `src/cli/validation.ts` (`nonNegativeNumber`, `resolveRepoPath`), so the TUI and the CLI flags cannot validate differently — the same constraint that motivated extracting them.

### Unit 3 — input box (`src/tui/input-box.tsx`)

Written here rather than taken from `@inkjs/ui`, whose `TextInput` exposes none of the four things this needs: the filtered command menu below the cursor, `⇥` completion, `↑↓` history through previously submitted lines, and multi-line paste via Ink's `usePaste` (a pasted goal currently arrives as a burst of keystrokes).

Keys: `⏎` submit · `⇥` complete · `↑↓` history, or menu selection while the menu is open · `esc` dismiss the menu, otherwise interrupt the focused node · `ctrl+o` expand the last collapsed result · `ctrl+c` twice to quit · `?` help when the input is empty.

There is now exactly one focus target, so the text-entry/global-key arbitration (`input-mode.ts`, `TextEntryContext`, `EscapeOwnerContext`) is deleted rather than extended. The escape-trap class of bug cannot recur because the condition that produced it no longer exists.

### Status line

One line pinned below the input: `2 running · 1 waiting on you · $0.26 · daemon ok`. Fed by `daemon.stats`, which gains a `pendingApprovals` count so this is one round-trip rather than two; daemon health is whether that call last succeeded. Refreshes on each bus event, floored at 3s.

## Backend changes

Cancellation is the only capability that does not exist today. Each piece sits where all callers route through it.

1. **`src/lifecycle/node-machine.ts`** — root-level `on: { CANCEL: '.CANCELLED' }` plus `CANCELLED: { type: 'final' }`. Root-level placement makes every state cancellable — mid-execute, mid-delegate, waiting on approval — without editing each one.
2. **`src/k8s/client.ts`** — `waitForJobCompletion` treats a 404 from `readNamespacedJobStatus` as `{ succeeded: false, message: 'Job was cancelled' }` instead of throwing. This is the root-cause fix: a Job deleted underneath a running step becomes a graceful outcome for *every* caller, not only the cancel path.
3. **`src/k8s/cleanup.ts`** — `deleteNodeJobs(nodeId, namespace)`, deleting by the `org.nodeId` label the manifest already sets. Necessary because Jobs use `generateName`, so exact names are not known to the caller.
4. **`src/lifecycle/node-actor-manager.ts`** — `cancelNode(db, nodeId)` sends `CANCEL` and deletes the node's Jobs. The existing terminal-state handler closes commitments and deletes the NetworkPolicy for any final state, so `CANCELLED` inherits cleanup unchanged.
5. **`src/server/routers/node.ts`** — `node.cancel` mutation.
6. **`src/db/queries/events.ts`** — `listRecentEvents(db, { limit, before })`, paging across all nodes by row id, exposed as `events.recent`. Startup pulls 200; `/history` pulls the previous 200.
7. **`src/db/queries/stats.ts`** — `getOrgStats` gains `pendingApprovals`.

## Files

**Deleted:** `src/tui/screens/` (all six), `src/tui/navigation.ts`, `src/tui/navigation.test.ts`, `src/tui/input-mode.ts`, `src/tui/use-node-stream.tsx`.

**Kept unchanged:** `src/tui/stream-renderer.ts` (+ its tests), `src/tui/client.ts`, `src/tui/format.ts`, and `StreamLine` from `src/tui/stream-lines.tsx`. The `StreamLines` list wrapper in that file is dropped — the transcript view owns list layout now.

**Created:** `src/tui/transcript.ts`, `src/tui/input-box.tsx`, `src/tui/transcript-view.tsx`, `src/tui/status-line.tsx`, `src/tui/commands/index.ts` and one module per command group, `src/tui/notify.ts`.

**Rewritten:** `src/tui/app.tsx`.

## Testing

The interaction logic becomes testable for the first time, because it no longer lives inside components.

- **Transcript reducer** — unit tests over the real captured Claude Code fixtures already in the repo, plus the case that cannot be eyeballed: two nodes interleaving must produce correct speaker headers, correct depth, and no lost lines.
- **Command registry** — parse-and-dispatch tests: flag parsing against the shared validators, unknown commands, argument completion.
- **Cancellation** — a real-cluster integration test: start a Job, cancel it mid-flight, assert the node reaches `CANCELLED`, the Job is gone, and no Secret or NetworkPolicy is left behind.
- **Ink rendering** — manually verified, per this project's precedent. It is now a thin shell over tested logic rather than the place the logic lives.

Acceptance is unchanged in kind from the previous TUI: watching a real Claude Code run stream into the transcript live, plus cancelling one mid-run.

## Deferred

- **Token-level typing** via `--include-partial-messages` — still deferred, for the same reason as before.
- **Persistent scroll history across sessions** — `/history` pages the event log; it does not persist a rendered transcript.
- **Command aliases and user-defined commands** — the registry makes both trivial to add later; neither is needed to use the tool.
