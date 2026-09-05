# Interactive TUI — Design Spec

Status: approved by user through visual + text brainstorming (2026-09-05). Supersedes the Phase 4 `org watch` design (a flat, polling-only, non-interactive list) in the original v0.1 plan and spec. This is the primary interface for using the Accountable Agent Organization Runtime day to day; the discrete CLI commands (`org run`, `org tree`, `org approve`, etc.) remain available unchanged for scripting/automation.

## 1. Scope

Replace `org watch` with a full-screen, drill-down interactive dashboard that is the primary way a user operates this tool — comparable in spirit to `k9s` (Kubernetes TUI navigation patterns) and to Claude Code's own interactive session (for how live agent output renders). Launched via `org` with no subcommand, or `org watch` kept as an alias for muscle memory.

Explicitly in scope: live tree navigation, per-node lifecycle/decision/commitment detail, live-streamed and nicely-rendered execution output (reasoning text, tool calls, diffs — matching Claude Code's own visual language), starting new runs from inside the TUI, inline approval/rejection, and an org-wide Home overview.

Explicitly out of scope for this pass: replacing the underlying accountability engines, changing the node lifecycle itself, or touching anything in Phases 1–5 beyond what's needed to make data available live instead of only after the fact.

## 2. Why drill-down, not multi-pane

Two layouts were mocked up and compared: a k9s-style drill-down (one focused screen, `Enter` to go deeper, `Esc` to back out) and an always-visible multi-pane split (tree + detail + live output simultaneously). Drill-down was chosen — it scales cleanly to trees of unknown depth (a multi-pane's fixed regions get cramped fast once delegation goes more than one level deep, which this system explicitly supports), and a follow-up mockup confirmed drill-down does not mean sparse: the node-detail screen carries everything (lifecycle position, full decision breakdown, live output) on one screen, organized into sections that appear only when relevant rather than always-reserved panes.

## 3. Navigation structure

```
Home  →  Tree  →  Node detail  →  (full decision log | full output)
```

- **Breadcrumb** always visible at the top (`org › tree › d57c`), so depth is never disorienting.
- **Home**: org-wide stats (active/complete/failed node counts, total spend across the current run, daemon uptime) plus the root-level tree, pulled from the same health signals `org doctor` already checks (cluster reachable, runner image loaded, auth present) shown as a compact status line.
- **Tree**: the hierarchy, one row per node (badge + short id + state + goal), exactly like today's `org tree` but interactive and live-updating.
- **Node detail**: see §4.
- **Full decision log / full output**: the same content as the node-detail screen's summarized sections, unabridged and scrollable — reached via `d`/`l` from node detail, not separate top-level destinations.

## 4. Node detail screen content

In this order, top to bottom, each section present only while relevant:

1. **Header** — goal text, budget spent/total.
2. **Lifecycle** — the XState states rendered as a linear progress indicator (`CREATED → ORIENT → PLAN → INTELLIGENCE_GATE → EXECUTION_DECISION → ...`) with the current state marked. This is a direct, honest rendering of the real state machine — no invented steps.
3. **Thought process — Intelligence Gate** — the coordinator's actual output (complexity classification, sufficientContext) with a one-line rationale, timestamped.
4. **Thought process — Execution Decision** — the full economics score breakdown as a table (same fields `org decision` already prints: estimatedValue, modelCost, latencyCost, coordinationCost, verificationCost, riskPenalty, threshold, score) plus the resulting outcome (SELF_EXECUTE / DELEGATE / ESCALATE), timestamped. Present once a decision exists for this node; absent before then.
5. **Live output** — see §5. Present only while a step is actively executing; replaced by a collapsed "Output (finished, press `l` for full)" line once the step completes.
6. **Approval action** — only when the node is in `WAIT_APPROVAL`: the escalation reason plus inline `y`/`r` hints.
7. **Footer hint bar** — context-sensitive keybindings for whatever the current screen actually supports (matches §7's table; a screen never shows a hint for an action it doesn't support).

## 5. Live output rendering

Raw `stream-json` events (message text, tool_use, tool_result) are parsed and rendered in the same visual language Claude Code's own CLI uses, not dumped as JSON:

- Assistant reasoning text streams as flowing prose, token-by-token as it arrives.
- A tool call collapses to one line the instant it starts: `● Read <file>`, `● Edit <file>`, `● Bash <command>`, etc. — a spinner/`▌` cursor shows while a call is in flight.
- `Read`/similar calls stay one line once resolved.
- `Edit` calls expand into a compact unified diff (`+`/`-` lines, colorized), truncated with an explicit "`x` to expand" affordance for long diffs rather than forcing a scroll.
- `Bash` calls show their command and a spinner until the result returns.

This rendering is a single shared function (`renderStreamEvent`), used identically wherever live or historical output is shown — the node-detail summary, the full-output drill-in, and (implicitly) anywhere a future surface needs it. It is not TUI-specific display logic bolted onto the Ink layer; it's a pure transform from structured event to renderable block.

## 6. Architecture: from polling to live

Three additions make the above possible; nothing about the accountability engines, the node lifecycle, or the K8s execution substrate changes.

1. **Follow-mode log streaming** — `src/k8s/client.ts` gains `followJobLogs(jobName, namespace): AsyncIterable<string>`, using the Kubernetes API's native `follow: true` on pod logs (a stream, not a one-shot fetch). `execute-step.ts`'s current behavior — fetch the whole log only after `waitForJobCompletion` resolves — is replaced by consuming this stream concurrently with waiting for completion, parsing and emitting each line as it arrives.

2. **An internal event bus** (`src/events/bus.ts`) — a process-wide publish/subscribe primitive. `execute-step.ts` publishes each parsed structured event the moment it's parsed (not just after the Job finishes); `node-actor-manager.ts`'s existing `actor.subscribe` callback (already the single place every state transition passes through) additionally publishes each transition to the same bus. This is a small, dependency-free addition — an `EventEmitter` keyed by nodeId is sufficient; no message queue or external broker is needed for a single-daemon, single-machine system.

3. **tRPC subscriptions over WebSocket** — `@fastify/websocket` (previously scoped but never installed, per the original spec's §17/§4.2) is added; one new subscription procedure, `events.subscribe`, wraps the bus as an async-iterable tRPC subscription, scoped optionally by nodeId. The CLI's tRPC client (`daemon/client.ts`) adds a `splitLink`: subscriptions route over a new `wsLink`, every existing query/mutation keeps using the current `httpBatchLink` unchanged. This is additive to the client, not a replacement.

A consequence worth naming explicitly: because the bus captures every transition and event as it happens rather than only what polling would have caught, `org events`/`org decision` on the plain CLI also become effectively real-time (the SQLite writes already happened synchronously; only the "was anyone watching" side changes). This is a backend correctness improvement, not a TUI-only side effect.

## 7. Interaction model

**Launch**: `org` with no arguments opens the TUI at Home. `org watch` is kept as an alias. The existing discrete commands (`org run`, `org tree`, `org approve`, `org reject`, `org commitment`, `org decision`, `org doctor`, `org daemon ...`) are unchanged and continue to work standalone — the TUI is additive, not a replacement of the scriptable surface.

**Starting a new run from inside the TUI**: pressing `n` from Home or Tree opens an inline form with the same fields as `org run`'s flags — goal (text), spawn (toggle), budget (number), max-children (number), repo path (text, defaulting to `process.cwd()` of the terminal the TUI itself was launched from — the daemon is a long-running background process with no per-invocation cwd of its own, so this must come from the TUI process, exactly like the plain CLI's `--repo` default does today) — validated with the same shared function the CLI's `nonNegativeNumber` helper already uses (extracted into a shared module so the two never drift apart), then calls the same `node.create` mutation the CLI uses today.

**Keybindings**:

| Key | Action | Where |
|---|---|---|
| `↑↓` / `j k` | move selection | Home, Tree |
| `Enter` | drill into selected node | Tree |
| `Esc` / `Backspace` | back up one level | anywhere but Home |
| `n` | open the new-run form | Home, Tree |
| `/` | filter the tree by goal text or state | Tree |
| `a` | jump to the next node in `WAIT_APPROVAL` (no-op if none) | anywhere |
| `y` | approve | Node detail, only when `WAIT_APPROVAL` |
| `r` | reject | Node detail, only when `WAIT_APPROVAL` |
| `d` | open the full decision log | Node detail |
| `l` | open the full output | Node detail |
| `f` | toggle follow/pause on a scrolling output pane | Node detail, full output |
| `q` | quit the TUI (does not stop the daemon) | anywhere |
| `?` | help overlay | anywhere |

The footer hint bar always shows only the keys the current screen actually supports — never a global static legend that includes actions unavailable on the current screen.

## 8. Testing

Consistent with this project's existing pattern (pure logic gets real unit tests; interactive Ink rendering gets manual verification, same as `org doctor`/the current `org watch`):

- `renderStreamEvent` (§5) — pure function, unit tested against fixture event sequences (message text, each tool-call type, malformed/unknown event types).
- Event bus (§6.2) — publish/subscribe/unsubscribe, unit tested without a daemon or cluster.
- `followJobLogs` (§6.1) — integration-tested against the real `kind` cluster, skip-if-unavailable, matching every other K8s client function's existing test pattern.
- New-run form validation — the shared function is unit tested once; both the CLI flag parser and the TUI form call it, so behavior can't drift between the two entry points.
- The Ink application itself (screens, navigation, keybinding wiring) — manually verified end-to-end per the exit checklist in the implementation plan, not automated.

## 9. Explicitly deferred

- Multi-pane layout (rejected in favor of drill-down, §2) — not revisited unless drill-down proves insufficient in practice.
- A `:resource`-style command-jump mode (k9s has this for power users) — the keybinding table above covers the actions this system actually has; add a command palette only if the action surface grows enough to need one.
- Remote/multi-machine TUI access — this is a local daemon talking to a local terminal; nothing here anticipates a browser-based or remote client (that remains the doc's own long-standing v0.3+ GUI roadmap item, unrelated to this terminal-native design).
