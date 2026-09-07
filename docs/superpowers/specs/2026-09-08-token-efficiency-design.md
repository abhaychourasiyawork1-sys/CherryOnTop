# Token Efficiency & Dispatch Optimization — Design

**Date:** 2026-09-08
**Status:** Approved for implementation planning
**Scope:** Reduce tokens consumed per run (primary metric) and run latency (secondary),
without measurable loss of execution output quality — and, via role-based system prompts
per lifecycle stage, aim to improve output quality at the same time.

---

## Background

CherryOnTop's own coordination layer — `decompose`, `select-runtime`, `economics`,
`ask` — is already heuristic and makes **no model calls**. All token spend is in the
sandboxed coding-runtime dispatches (`claude` / `codex`), of which there are three
kinds, all routed through `executeStep`:

| Role | Call site | Prompt builder | Nature |
|------|-----------|----------------|--------|
| `plan` | [node-actor-manager.ts](../../../src/lifecycle/node-actor-manager.ts) ~L275 | `buildPlanPrompt` ([plan.ts](../../../src/intelligence/plan.ts)) | Full agent session that reads the repo and emits a JSON array of subgoals |
| `synthesize` | node-actor-manager.ts ~L209 | `buildSynthesisPrompt` ([synthesize.ts](../../../src/intelligence/synthesize.ts)) | Full agent session that merges child reports into one markdown answer |
| `execute` | node-actor-manager.ts ~L410 | the node's goal, via [prompt.ts](../../../src/execution/prompt.ts) `withConstraints` | The actual work |

### Observed waste

1. **No model selection.** [claude-code.ts](../../../src/adapters/claude-code.ts) never
   passes `--model`. Planning (emit JSON) and synthesis (merge markdown) run on the same
   default model as real coding.
2. **Repo context re-derived N times.** The planning run explores the repo and discards
   that; each of N children then re-explores the same repo from zero.
3. **No cross-dispatch prompt caching.** Each sibling runs in a fresh Kubernetes Job (cold
   context) against the same repo. Anthropic prompt caching is per-process with a ~5-minute
   TTL, so cold Jobs cannot share a warm prefix.
4. **Synthesis loads a full sandbox** for a task needing no repo and no tools.
5. **Plans are never cached.** The same goal against an unchanged repo re-runs the whole
   planning sandbox.
6. **No system prompt for any stage.** The adapter runs `claude --print <goal>` with no
   `--append-system-prompt`. The executor — the most expensive dispatch — receives a bare
   goal string; the mandate, the tool grant, and the definition of done are never framed
   for it. `withConstraints` prepends the standing constraints to the goal instead of
   treating them as what they are (a system-level operating frame), and re-pays that
   prefix on every retry.

### Auth constraint

CherryOnTop runs under a **Claude subscription** (`claude login` / OAuth), possibly a Pro
plan. Consequences:

- `--model` works, but a Pro plan may reject some model IDs — the design must degrade
  gracefully, never fail a run over tiering.
- Explicit API-side cache breakpoints and the token-counting API are unavailable. Token
  usage is instead read from the `usage` block already present on Claude Code `result`
  events (the same events `total_cost_usd` is read from today in
  [stats.ts:31](../../../src/db/queries/stats.ts)).
- A KV/prefix-reuse caching proxy (LMCache and similar target self-hosted vLLM, not a
  hosted API) cannot reduce Anthropic-side token billing under subscription auth. **Out of
  scope** — revisit only if auth moves to API key + a model gateway.

---

## Approach

**Approach B, delivered in phases.** Phase 1 is cheap levers with no execution-quality risk
and establishes the measurement baseline. Phase 2 is the repo-map handoff, gated by a
benchmark. Phase 3 is role-based system prompts per lifecycle stage, also benchmark-gated
(reusing the Phase 2 harness). The caching proxy (Approach C) is deferred per the auth
constraint above.

Phases 2 and 3 are independent and may land in either order; Phase 1a (token accounting) is
a prerequisite for both.

Every optimization must degrade to current behaviour on any failure. No optimization may
fail a run.

---

## Phase 1

### 1a. Per-dispatch token accounting

*Build first — it is the instrument that guards every subsequent change.*

- **New module** `src/execution/tokens.ts` exporting `usageFromEvents(events: StructuredEvent[]): DispatchUsage`.
  - Reads the final `result` event's `usage` object: `input_tokens`, `output_tokens`,
    `cache_read_input_tokens`, `cache_creation_input_tokens`, plus `num_turns`.
  - Absent or malformed `usage` → returns all zeros (never throws).
- **`ExecuteStepResult`** gains `usage: DispatchUsage`.
- **Persistence:** `node-actor-manager` writes one `memory` row per dispatch,
  `kind: 'dispatch_usage'`, `value` = `{ role, model, usage, costUsd, caseId, nodeId }`.
  No DB schema change — `memory.value` is already JSON.
- **New read command** `org tokens [caseId]`:
  - Rows grouped by `role` and `model`: dispatch count, input/output tokens,
    cache-read ratio, cost.
  - Plan-cache hit count (see 1d).
  - Grand totals.
  - With no `caseId`: aggregate across all runs.

This command is the before/after measurement for 1b–1d, Phase 2, and Phase 3.

### 1b. Configurable model tiering

- **`ExecuteStepInput`** gains optional `model?: string` and `maxTurns?: number`.
- **`RuntimeAdapter.buildCommand`** signature becomes
  `buildCommand(goal: string, grant?: ToolGrant, opts?: { model?: string; maxTurns?: number })`.
  - `claude-code` adapter appends `--model <id>` when `opts.model` is set and
    `--max-turns <n>` when `opts.maxTurns` is set.
  - `codex` adapter maps what it can and ignores the rest.
  - `stopgap` adapter ignores both.
- **Config — `efficiency.models` block** (in run config, falling back to daemon config):

  ```yaml
  efficiency:
    models:
      plan:       "haiku"   # default
      synthesize: "haiku"   # default
      execute:    null       # default: null = omit --model, use CLI default
  ```

  Per-role. Values are passed verbatim to `--model`, so a short alias (`haiku`, `sonnet`,
  `opus`) or a full pinned ID both work; aliases are the default because they survive
  model version bumps. `null`/absent → no `--model` flag for that role. `execute` is
  settable but defaults to `null`.
- **`node-actor-manager`** resolves the role's configured model and passes it to the
  matching `executeStep` call.
- **Pro-plan fallback:** if a dispatch's `result` event is an error whose text names an
  unavailable/forbidden/unknown model (matched by a small regex against known phrasings),
  the dispatch is retried **once** with `model` unset. On retry:
  - write a `memory` row `kind: 'model_tier_unavailable'`, `value` = `{ role, model, message }`;
  - emit a visible progress line ("Requested model X unavailable on this plan; falling back to the default model");
  - proceed. If the retry also fails, that is a real failure and surfaces normally.
- **Doctor check:** `org doctor` gains a probe that runs a minimal `claude --print --model <id>`
  ("reply with ok") for `haiku` and `sonnet`, reporting which the current auth can call.
  Advisory only — does not block anything.

### 1c. Dispatch shaping

- **Read-only planning grant.** The `plan` dispatch passes a grant intersected with a
  read-only tool set (`Read`, `Grep`, `Glob`, `LS` — no `Edit`, `Write`, `Bash`,
  `NotebookEdit`). Reuses the existing `--allowedTools` plumbing. A planner cannot start
  doing the work.
- **`--max-turns` caps** via the `maxTurns` option from 1b:
  - `synthesize`: `1` (no tools, single answer).
  - `plan`: a small bound (default `15`, configurable) — the token-domain counterpart of
    the existing `PLAN_TIMEOUT_MS`.
  - `execute`: unset.
- Both caps are config-overridable under a `maxTurns` block; defaults baked in.

### 1d. Semantic plan cache

Before the `plan` dispatch:

1. Compute `repoHead` = `git rev-parse HEAD` in the worktree and
   `dirty` = `git status --porcelain` non-empty.
2. If `dirty` → skip the cache entirely, always re-plan (the repo no longer matches any
   committed state).
3. Otherwise `key = sha256(goal + "\0" + repoHead)`. Look up `memory` where
   `kind = 'plan'` and `key` matches.
   - **Hit** within TTL (default 24h, `planCacheTtlHours` config) → use stored `subgoals`,
     skip the dispatch, record a `plan_cache_hit` for `org tokens`.
   - **Miss** → run planning as today; on success store
     `{ subgoals, repoHead }` with `kind: 'plan'`, `key`, `createdAt`.

Invalidation is automatic: a new commit changes `repoHead` and misses. No manual busting.

---

## Phase 2 — Repo-map handoff

*Gated by a benchmark. Ships only if tokens drop and quality holds.*

### Map builder

**New module** `src/intelligence/repo-map.ts` exporting
`buildRepoMap(worktreePath: string, tokenBudget: number): Promise<string>`.

- **Tree:** `git ls-files`, grouped by directory.
- **Symbols:** top-level declarations per source file. Primary implementation:
  `web-tree-sitter` with grammar wasm bundled for the repo's most common languages
  (detected by extension count; cap at the top 4). Fallback if tree-sitter proves too
  heavy to bundle or too slow: a `ctags`-based pass, or tree-only.
- **Size bound:** `repoMapTokenBudget` config, default ~6000 tokens (estimated by a
  chars/4 heuristic). Over budget → drop symbols, emit the tree only. Still over → truncate
  the tree with a `[... N more files]` marker.
- Any error → return `""` (no prefix; children behave as today).

### Handoff

- Built once, during/after the planning pass, stored as a `memory` row
  `kind: 'repo_map'`, `key = repoHead`, so siblings and a cached-plan re-run reuse it.
- **New function** `withRepoMap(goal: string, map: string): string` in
  [prompt.ts](../../../src/execution/prompt.ts), a sibling of `withConstraints`, composed
  at the same assembly point. Empty map → returns `goal` unchanged.
- Applied to **child `execute` dispatches only**. Not to planning (it is already looking at
  the repo) and not to synthesis (no repo needed).

### Benchmark gate

- Harness in `bench/` (a shared runner both Phase 2 and Phase 3 use): ~5 real goals
  against this repo, each run with and without the map.
- Records tokens (from 1a) and a pass/fail rubric on the output per goal.
- `npm run bench` prints a comparison table (mode flag selects repo-map or role-prompt
  comparison).
- **Ship criterion:** total tokens strictly lower **and** no rubric regression. Otherwise
  Phase 2 does not merge.

---

## Phase 3 — Role-based system prompts per lifecycle stage

*Gated by a benchmark. Ships only if quality improves (or holds) and tokens do not rise
net of retries.*

### Motivation

Other harnesses give every agent a distinct operating frame — CrewAI's required
`role` / `goal` / `backstory`, OpenHands' per-agent prompt-plus-action-set, the
`AGENTS.md` / `CLAUDE.md` convention injected into the system prompt. CherryOnTop gives
its dispatches none. A well-scoped role frame is reported to cut wasted exploratory turns
and reduce retries; if first-pass success improves, the added prompt tokens are paid back
(and the frame is cached within a session anyway).

### Delivery

- **`--append-system-prompt` only.** Claude Code's built-in coding-agent scaffolding stays;
  our framing is appended. No `--system-prompt` full-replace path (dropped to avoid losing
  tool-use scaffolding).
- **`ExecuteStepInput`** gains `systemPrompt?: string`.
- **`RuntimeAdapter.buildCommand` opts** gains `systemPrompt?: string`:
  - `claude-code`: appends `--append-system-prompt <text>` when set.
  - `codex`: maps to its instructions mechanism if one exists, else ignores.
  - `stopgap`: ignores.
- `node-actor-manager` builds the role's system prompt and passes it to the matching
  `executeStep` call.

### New module `src/prompts/roles.ts`

- **`HARNESS_CONSTITUTION`** — the shared preamble (the "backstory"), carrying CherryOnTop's
  nature: work strictly inside the declared mandate; produce evidence, not just a result;
  state plainly when blocked or uncertain rather than working around it; stay in scope.
- **`buildRolePrompt(role, params)`** — returns `HARNESS_CONSTITUTION` + the role stanza.
  Each stanza is kept tight (target ≤ ~400 tokens):

  | Role | Stanza content |
  |------|----------------|
  | `plan` | Planner for one node. Split the goal into independent, non-overlapping, self-contained subgoals **only if it genuinely divides**. Inspect read-only; do not implement. Prefer fewer children. Output contract: JSON array of strings. |
  | `execute` | Implementer closing one commitment under a mandate. Tools permitted: `{grant}`. Standing constraints (told, not enforced): `{constraints}`. Definition of done: `{dod}`. Work to the DoD and stop. Final report must state what changed, what was verified, and what is unchecked — it becomes the evidence that closes the commitment. If a constraint blocks the direct path, say so rather than working around it. |
  | `synthesize` | Lead combining the team's reports into the one answer owed to the requester. Merge overlapping findings. Preserve every `file:line`, number, and code detail. Order by importance. Flag unfinished pieces explicitly. Output only the answer. |
  | `verify` | Verifier. For each definition-of-done criterion, return `MET` / `NOT MET` / `INSUFFICIENT EVIDENCE` against the evidence produced. Do not fix anything. Structured verdict. |

- The `verify` stanza is **written now but not wired** — `VERIFY` has no model call today
  ([node-machine.ts](../../../src/lifecycle/node-machine.ts) `VERIFY` state). It is
  connected when DoD-checking becomes a real dispatch in a later phase.

### Consequent changes

- **`withConstraints` is removed from the goal path.** Constraints move into the `execute`
  role prompt via `{constraints}`. The goal string passed to the executor is just the goal.
  Removes the per-retry re-payment of the constraints prefix.
- **`buildPlanPrompt` / `buildSynthesisPrompt` are slimmed.** Role and rules move to the
  system prompt; the user prompt keeps only the task specifics (the goal, the child
  reports, the exact output format). Net user-prompt tokens drop; the moved text is
  cached.
- Role-prompt text lives in config (`efficiency.rolePrompts`, see below) so it is tunable
  without a release; the module holds the defaults.

### Benchmark gate

- Reuses the shared `bench/` goal set and harness in role-prompt comparison mode.
- Compares **with role prompts vs without**: tokens (from 1a), retry count, and the
  pass/fail output rubric.
- **Ship criterion:** rubric improves or holds, retry count does not rise, and total
  tokens (prompt + retries) do not rise. Otherwise Phase 3 does not merge, or merges with
  only the stanzas that individually pass.

---

## Config surface

One optional `efficiency` block (exact home — run config vs daemon config — follows the
existing config precedence; all keys optional, defaults baked in):

```yaml
efficiency:
  models:
    plan:       "haiku"
    synthesize: "haiku"
    execute:    null
  maxTurns:
    plan:       15
    synthesize: 1
  planCacheTtlHours: 24
  repoMapTokenBudget: 6000        # Phase 2
  rolePrompts:                     # Phase 3
    enabled: true
    plan:       null               # null = use the built-in default stanza
    execute:    null
    synthesize: null
    verify:     null               # defined, not yet wired
```

Documented in USAGE.md as part of each phase.

---

## Failure posture

| Failure | Behaviour |
|---------|-----------|
| `--model` rejected by plan tier | one retry without `--model`, log, proceed on default |
| `usage` block absent from `result` | record zeros, run unaffected |
| plan cache miss / dirty repo | plan normally |
| corrupt / expired plan-cache row | treat as miss |
| `git rev-parse` fails (no git, shallow) | skip plan cache, skip repo-map reuse key; plan and explore normally |
| repo-map build throws or over budget hard-fails | empty prefix; children explore as today |
| `efficiency.rolePrompts.enabled: false` or a stanza is `null`-and-no-default | dispatch runs with no `--append-system-prompt` (or the built-in default), exactly as pre-Phase-3 |
| `--append-system-prompt` unsupported by the runtime | adapter omits it; goal-only dispatch as today |
| bench shows no win | that phase does not merge (Phase 3 may merge a subset of stanzas) |

No optimization can fail a run.

---

## Testing

**Unit**

- `usageFromEvents`: real Claude Code `result` fixture (with and without `usage`);
  cache-token fields; zero-on-absent.
- plan-cache: key derivation, TTL boundary, dirty-bit skip, corrupt-row → miss.
- per-role model/`maxTurns` argument construction in the `claude-code` adapter.
- fallback-on-model-error: error-text regex matches known phrasings; retry path unsets
  `model`; `model_tier_unavailable` row written.
- `withRepoMap`: empty map is a no-op; non-empty map is prefixed once.
- `buildRolePrompt`: each role returns constitution + its stanza; `execute` interpolates
  `{grant}` / `{constraints}` / `{dod}`; empty constraints/DoD render cleanly (no dangling
  labels); a config override replaces the default stanza; `enabled: false` yields no prompt.
- `claude-code` adapter: `systemPrompt` opt → `--append-system-prompt <text>` present and
  correctly quoted; absent opt → flag omitted.

**Integration**

- one test asserting a `plan` dispatch carries `--model <configured>`, a read-only
  `--allowedTools` set, `--max-turns 15`, and (Phase 3) `--append-system-prompt` with the
  planner stanza.
- one test asserting an `execute` dispatch's goal string no longer contains the constraints
  prefix and the constraints appear in the appended system prompt instead.

**Benchmark (not unit)**

- `bench/` shared harness: Phase 2 map quality and token delta; Phase 3 role-prompt
  quality, retry-count, and token delta.

---

## Expected impact

- `plan` + `synthesize` move to Haiku — roughly an order-of-magnitude cheaper per those
  dispatches, and faster.
- Plan cache removes repeat planning sandboxes entirely for unchanged repos.
- Repo-map removes the per-sibling repo re-exploration that dominates `execute` token
  cost on fan-out runs.
- Role prompts aim to raise first-pass success, cutting retries (each retry is a full
  cold dispatch); they also move duplicated user-prompt text into the cached system
  prompt.
- All of these reduce latency as well as tokens.

Actual numbers come from `org tokens` before and after each phase — no change ships on an
estimate.

---

## Out of scope

- In-cluster caching proxy (Approach C) — cannot reduce Anthropic-side billing under
  subscription auth.
- Migrating the runner from the `claude` CLI to the Claude Agent SDK (session resume,
  programmatic compaction) — a larger change; revisit if Phase 1+2 prove insufficient.
- Context minification and other lossy input-reduction techniques — quality risk exceeds
  the "small, if measured" bar set for this work.
- Routing low-complexity `execute` dispatches to Haiku — possible via the `models.execute`
  config knob, but not a default and not benchmarked here.
- `--system-prompt` full-replace per role — dropped to keep Claude Code's tool-use
  scaffolding; only `--append-system-prompt` is used.
- Rewriting Claude Code's / Codex's built-in system prompts, or a repo-level `AGENTS.md`
  generator — out of scope; the constitution is the runtime's frame, `CLAUDE.md` already
  covers repo conventions.
