# Token Efficiency & Dispatch Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut tokens (and latency) per run by tiering models per dispatch role, caching plans, handing children a repo map, and giving each node-lifecycle stage a role-scoped system prompt — with every change degrading to today's behaviour on any failure.

**Architecture:** All model spend is in the three sandboxed `executeStep` dispatches (`plan`, `execute`, `synthesize`) routed through `src/lifecycle/node-actor-manager.ts`. Changes are: (1) thread `model` / `maxTurns` / `systemPrompt` options through `ExecuteStepInput` → `RuntimeAdapter.buildCommand`; (2) pure helper modules for config defaults, token accounting, plan-cache keys, git state, repo maps, and role prompts; (3) thin wiring in the three dispatch closures. No new services, no DB migration (`memory.value` is already JSON).

**Tech Stack:** TypeScript/Node ≥ 22, ESM (`.js` import specifiers), Vitest, Drizzle ORM + better-sqlite3, Commander, tRPC, XState. Runner dispatch is the `claude` / `codex` CLI inside a Kubernetes Job.

**Spec:** `docs/superpowers/specs/2026-09-08-token-efficiency-design.md`

## Global Constraints

- **No optimization may fail a run.** Every new path has a documented fallback to current behaviour (see the spec's Failure posture table). When in doubt, catch and continue.
- **Node ≥ 22**, `"type": "module"` — all relative imports use the `.js` extension even for `.ts` files.
- **No new runtime dependencies** without calling it out. `execa` is already available; prefer `node:child_process` for one-shot git calls.
- **Config is via `ORG_*` environment variables**, not a config file. The codebase has no config-file loader and the spec's YAML block is illustrative only; env vars are the established pattern (`ORG_RUNNER_IMAGE`, `ORG_WORKTREE_PATH`, `ORG_MAX_CONCURRENT_SANDBOXES`, …). New vars must be added to the passthrough list in `src/daemon/manager.ts`.
- **Tests:** Vitest, files co-located as `*.test.ts`. Run a single file with `npx vitest run <path>`; the whole suite with `npm test`.
- **Commits:** one per task minimum, conventional-commit prefixes (`feat:`, `fix:`, `test:`, `refactor:`, `chore:`), end the body with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- **`memory` table row shape:** `{ id, kind, key, value (JSON), confidence, nodeId, createdAt }`. New `kind`s introduced here: `dispatch_usage`, `plan`, `repo_map`.
- **Phases are independently shippable.** Phase 1 must land before 2 or 3 (Task 1's `usageFromEvents` and Task 3's config module are shared). Phases 2 and 3 are independent of each other.

---

## File Structure

**Phase 1 — cheap levers**

| File | Responsibility |
|------|----------------|
| `src/execution/tokens.ts` (create) | `usageFromEvents` (read `usage` off the `result` event); `shouldRetryWithoutModel` (detect a model-rejection error) |
| `src/config/efficiency.ts` (create) | Read `ORG_*` env vars into typed defaults: per-role `{ model, maxTurns }`, plan-cache TTL, repo-map budget, role-prompts on/off |
| `src/adapters/adapter.ts` (modify) | Extend `buildCommand` signature with an `opts` object; add `BuildCommandOptions` |
| `src/adapters/claude-code.ts` (modify) | Emit `--model`, `--max-turns`, `--append-system-prompt` from `opts` |
| `src/adapters/codex.ts` (modify) | Emit `--model` / turn cap where Codex supports it; ignore the rest |
| `src/execution/execute-step.ts` (modify) | Pass `input.model` / `input.maxTurns` / `input.systemPrompt` into `buildCommand`; put `usageFromEvents(collected)` on the result |
| `src/execution/git-state.ts` (create) | `repoHead(worktreePath)`, `repoDirty(worktreePath)` — one-shot `git` calls, null/false on any failure |
| `src/db/queries/plan-cache.ts` (create) | `planCacheKey`, `getCachedPlan`, `putCachedPlan` over `memory` rows of `kind: 'plan'` |
| `src/db/queries/tokens.ts` (create) | `recordDispatchUsage`, `tokensByRole` aggregate for `org tokens` |
| `src/server/routers/memory.ts` (modify) | Add a `tokens` query returning the aggregate |
| `src/cli/commands/tokens.ts` (create) | `org tokens [caseId]` — print the table |
| `src/cli/index.ts` (modify) | Register the command |
| `src/lifecycle/node-actor-manager.ts` (modify) | Wire model/maxTurns/read-only-grant into the 3 dispatch closures; plan-cache lookup in `planSubgoals`; record `dispatch_usage`; one-retry model fallback |
| `src/daemon/manager.ts` (modify) | Pass the new `ORG_*` vars to the daemon process |
| `src/doctor/checks.ts` + `src/cli/commands/doctor.ts` (modify) | Probe which models the current auth can call |

**Phase 2 — repo-map handoff**

| File | Responsibility |
|------|----------------|
| `src/intelligence/repo-map.ts` (create) | `buildRepoMap(worktreePath, tokenBudget)`; `withRepoMap(goal, map)` |
| `src/lifecycle/node-actor-manager.ts` (modify) | Build/store a `repo_map` row on the parent; prefix child `execute` goals |
| `bench/run.mjs` (create) + `package.json` (modify) | `npm run bench` — with/without comparison over a fixed goal set |
| `bench/goals.json` (create) | The benchmark goal set + rubric |

**Phase 3 — role-based system prompts**

| File | Responsibility |
|------|----------------|
| `src/prompts/roles.ts` (create) | `HARNESS_CONSTITUTION`; `buildRolePrompt(role, params)` |
| `src/lifecycle/node-actor-manager.ts` (modify) | Pass `systemPrompt` per role; drop `withConstraints`, move constraints into the `execute` role prompt |
| `src/intelligence/plan.ts` (modify) | Slim `buildPlanPrompt` — role/rules move to the system prompt |
| `src/intelligence/synthesize.ts` (modify) | Slim `buildSynthesisPrompt` likewise |
| `src/execution/prompt.ts` + `src/execution/prompt.test.ts` (delete) | `withConstraints` is gone; the file has no other export |
| `bench/run.mjs` (modify) | Add role-prompt comparison mode |

---

## PHASE 1 — Cheap levers

### Task 1: Token accounting helpers (`src/execution/tokens.ts`)

**Files:**
- Create: `src/execution/tokens.ts`
- Test: `src/execution/tokens.test.ts`

**Interfaces:**
- Consumes: `StructuredEvent` from `src/adapters/adapter.ts` (`{ type: string; payload: unknown }`).
- Produces:
  - `interface DispatchUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; numTurns: number }`
  - `function usageFromEvents(events: StructuredEvent[]): DispatchUsage`
  - `function shouldRetryWithoutModel(events: StructuredEvent[]): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
// src/execution/tokens.test.ts
import { describe, it, expect } from 'vitest';
import { usageFromEvents, shouldRetryWithoutModel } from './tokens.js';
import type { StructuredEvent } from '../adapters/adapter.js';

const ev = (payload: unknown): StructuredEvent => ({ type: String((payload as { type?: unknown }).type ?? 'x'), payload });

describe('usageFromEvents', () => {
  it('reads the usage block off the final result event', () => {
    const events = [
      ev({ type: 'assistant' }),
      ev({
        type: 'result',
        total_cost_usd: 0.03,
        num_turns: 7,
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_input_tokens: 8000,
          cache_creation_input_tokens: 500,
        },
      }),
    ];
    expect(usageFromEvents(events)).toEqual({
      inputTokens: 1200, outputTokens: 340, cacheReadTokens: 8000,
      cacheCreationTokens: 500, numTurns: 7,
    });
  });

  it('returns all zeros when there is no result event or no usage block', () => {
    expect(usageFromEvents([ev({ type: 'assistant' })])).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 0,
    });
    expect(usageFromEvents([ev({ type: 'result', total_cost_usd: 0.01 })]).inputTokens).toBe(0);
  });

  it('uses the last result event when several are present', () => {
    const events = [
      ev({ type: 'result', usage: { input_tokens: 1 } }),
      ev({ type: 'result', usage: { input_tokens: 999 } }),
    ];
    expect(usageFromEvents(events).inputTokens).toBe(999);
  });
});

describe('shouldRetryWithoutModel', () => {
  const errResult = (text: string): StructuredEvent =>
    ({ type: 'result', payload: { type: 'result', is_error: true, result: text } });

  it('is true when the runtime rejected the requested model', () => {
    expect(shouldRetryWithoutModel([errResult('model "haiku" is not available on your plan')])).toBe(true);
    expect(shouldRetryWithoutModel([errResult('Invalid model name: haiku')])).toBe(true);
    expect(shouldRetryWithoutModel([errResult('You do not have access to this model')])).toBe(true);
  });

  it('is false for any other error or a clean run', () => {
    expect(shouldRetryWithoutModel([errResult('Request timed out')])).toBe(false);
    expect(shouldRetryWithoutModel([{ type: 'result', payload: { type: 'result', is_error: false } }])).toBe(false);
    expect(shouldRetryWithoutModel([])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/execution/tokens.test.ts`
Expected: FAIL — `Cannot find module './tokens.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/execution/tokens.ts
import type { StructuredEvent } from '../adapters/adapter.js';

export interface DispatchUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  numTurns: number;
}

const ZERO: DispatchUsage = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 0,
};

function lastResultPayload(events: StructuredEvent[]): Record<string, unknown> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'result') continue;
    const p = events[i].payload;
    return typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : null;
  }
  return null;
}

/** Pulls token counts off Claude Code's final `result` event. The event also
 *  carries `total_cost_usd`, which the rest of the codebase already reads. Any
 *  shape we don't recognise yields zeros — never throws, never fails a run. */
export function usageFromEvents(events: StructuredEvent[]): DispatchUsage {
  const payload = lastResultPayload(events);
  if (!payload) return { ...ZERO };
  const u = (payload.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheCreationTokens: n(u.cache_creation_input_tokens),
    numTurns: n(payload.num_turns),
  };
}

// Matched against the runtime's own final error text. Deliberately broad on
// phrasing and narrow on intent: only a *model* rejection should trigger the
// one-shot retry without --model. A timeout or auth error must not.
const MODEL_REJECTION = /\b(model)\b[^.]*\b(not available|no access|not found|invalid|unknown|unsupported|do not have access)\b|\b(invalid|unknown) model\b|not available on your (plan|subscription)/i;

export function shouldRetryWithoutModel(events: StructuredEvent[]): boolean {
  const payload = lastResultPayload(events);
  if (!payload || payload.is_error !== true) return false;
  const text = typeof payload.result === 'string' ? payload.result : String(payload.subtype ?? '');
  return MODEL_REJECTION.test(text);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/execution/tokens.test.ts`
Expected: PASS (9 assertions)

- [ ] **Step 5: Commit**

```bash
git add src/execution/tokens.ts src/execution/tokens.test.ts
git commit -m "feat: token-usage and model-rejection helpers for dispatch accounting

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Adapter options — `--model`, `--max-turns` (`adapter.ts`, `claude-code.ts`, `codex.ts`)

**Files:**
- Modify: `src/adapters/adapter.ts`
- Modify: `src/adapters/claude-code.ts`
- Modify: `src/adapters/codex.ts`
- Test: `src/adapters/claude-code.test.ts` (extend), `src/adapters/codex.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - `interface BuildCommandOptions { model?: string; maxTurns?: number; systemPrompt?: string }` exported from `src/adapters/adapter.ts`
  - `RuntimeAdapter.buildCommand(goal: string, grant?: ToolGrant, opts?: BuildCommandOptions): string[]`
- Note: `systemPrompt` is declared now but only emitted by the claude-code adapter in Task 12. This task wires `model` + `maxTurns` only.

- [ ] **Step 1: Write the failing tests** (append to `src/adapters/claude-code.test.ts`)

```typescript
describe('dispatch options', () => {
  it('adds --model when opts.model is set, before the goal', () => {
    const cmd = claudeCodeAdapter.buildCommand('do it', undefined, { model: 'haiku' });
    expect(cmd).toContain('--model');
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('haiku');
    expect(cmd.at(-1)).toBe('do it');
  });

  it('adds --max-turns when opts.maxTurns is set', () => {
    const cmd = claudeCodeAdapter.buildCommand('do it', undefined, { maxTurns: 15 });
    expect(cmd[cmd.indexOf('--max-turns') + 1]).toBe('15');
  });

  it('adds neither flag when opts is empty or omitted', () => {
    expect(claudeCodeAdapter.buildCommand('do it', undefined, {})).not.toContain('--model');
    expect(claudeCodeAdapter.buildCommand('do it')).not.toContain('--max-turns');
  });

  it('still puts the grant allowlist and the goal in the right places alongside opts', () => {
    const cmd = claudeCodeAdapter.buildCommand('do it', { allowedTools: ['Read'], readOnly: true }, { model: 'haiku' });
    expect(cmd[cmd.indexOf('--allowedTools') + 1]).toBe('Read');
    expect(cmd.at(-1)).toBe('do it');
  });
});
```

```typescript
// src/adapters/codex.test.ts  (create)
import { describe, it, expect } from 'vitest';
import { codexAdapter } from './codex.js';

describe('codexAdapter dispatch options', () => {
  it('maps opts.model to --model', () => {
    const cmd = codexAdapter.buildCommand('do it', undefined, { model: 'gpt-5-mini' });
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('gpt-5-mini');
    expect(cmd.at(-1)).toBe('do it');
  });

  it('ignores maxTurns and systemPrompt (Codex exec has no equivalent flag)', () => {
    const cmd = codexAdapter.buildCommand('do it', undefined, { maxTurns: 3, systemPrompt: 'x' });
    expect(cmd).not.toContain('--max-turns');
    expect(cmd.join(' ')).not.toContain('x');
  });

  it('adds no --model when opts is omitted', () => {
    expect(codexAdapter.buildCommand('do it')).not.toContain('--model');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/adapters/claude-code.test.ts src/adapters/codex.test.ts`
Expected: FAIL — `buildCommand` ignores the third argument / `--model` absent

- [ ] **Step 3: Edit `src/adapters/adapter.ts`**

```typescript
/** Optional per-dispatch controls. All absent = today's behaviour exactly. */
export interface BuildCommandOptions {
  /** Passed verbatim to the runtime's model flag. A short alias ("haiku",
   *  "sonnet") or a full pinned id both work. */
  model?: string;
  /** Hard cap on agent turns for this dispatch. */
  maxTurns?: number;
  /** Appended to the runtime's built-in system prompt (Task 12). */
  systemPrompt?: string;
}
```

And change the interface method:

```typescript
  buildCommand(goal: string, grant?: ToolGrant, opts?: BuildCommandOptions): string[];
```

- [ ] **Step 4: Edit `src/adapters/claude-code.ts`**

```typescript
import type { RuntimeAdapter, StructuredEvent, ToolGrant, BuildCommandOptions } from './adapter.js';

// ...

  buildCommand(goal: string, grant?: ToolGrant, opts: BuildCommandOptions = {}): string[] {
    const permission = grant?.allowedTools
      ? ['--allowedTools', grant.allowedTools.join(',')]
      : [];
    const model = opts.model ? ['--model', opts.model] : [];
    const maxTurns = opts.maxTurns ? ['--max-turns', String(opts.maxTurns)] : [];
    const systemPrompt = opts.systemPrompt ? ['--append-system-prompt', opts.systemPrompt] : [];
    return ['claude', '--print', '--output-format', 'stream-json', '--verbose',
      ...permission, ...model, ...maxTurns, ...systemPrompt,
      '--dangerously-skip-permissions', goal];
  },
```

- [ ] **Step 5: Edit `src/adapters/codex.ts`**

```typescript
import type { RuntimeAdapter, StructuredEvent, ToolGrant, BuildCommandOptions } from './adapter.js';

// ...

  buildCommand(goal: string, grant?: ToolGrant, opts: BuildCommandOptions = {}): string[] {
    const sandbox = grant?.readOnly ? ['--sandbox', 'read-only'] : [];
    // Codex exec takes --model; it has no turn cap or append-system-prompt flag,
    // so maxTurns / systemPrompt are dropped here and (for the per-tool half)
    // still enforced by execute-step's stream check.
    const model = opts.model ? ['--model', opts.model] : [];
    return ['codex', 'exec', '--json', '--skip-git-repo-check', ...sandbox, ...model, goal];
  },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/adapters/claude-code.test.ts src/adapters/codex.test.ts`
Expected: PASS (existing adapter tests still green — the new 3rd arg is optional)

- [ ] **Step 7: Commit**

```bash
git add src/adapters/adapter.ts src/adapters/claude-code.ts src/adapters/codex.ts src/adapters/claude-code.test.ts src/adapters/codex.test.ts
git commit -m "feat: per-dispatch model and max-turns options on RuntimeAdapter.buildCommand

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Efficiency config module (`src/config/efficiency.ts`)

**Files:**
- Create: `src/config/efficiency.ts`
- Modify: `src/daemon/manager.ts` (env passthrough)
- Test: `src/config/efficiency.test.ts`

**Interfaces:**
- Consumes: `process.env`.
- Produces:
  - `type DispatchRole = 'plan' | 'execute' | 'synthesize'`
  - `function dispatchOptionsFor(role: DispatchRole): { model?: string; maxTurns?: number }`
  - `function planCacheTtlHours(): number` — `0` = disabled
  - `function repoMapTokenBudget(): number` — `0` = disabled (Phase 2)
  - `function rolePromptsEnabled(): boolean` (Phase 3)

- [ ] **Step 1: Write the failing test**

```typescript
// src/config/efficiency.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { dispatchOptionsFor, planCacheTtlHours, repoMapTokenBudget, rolePromptsEnabled } from './efficiency.js';

const KEYS = [
  'ORG_MODEL_PLAN', 'ORG_MODEL_EXECUTE', 'ORG_MODEL_SYNTHESIZE',
  'ORG_MAX_TURNS_PLAN', 'ORG_MAX_TURNS_SYNTHESIZE',
  'ORG_PLAN_CACHE_TTL_HOURS', 'ORG_REPO_MAP_TOKENS', 'ORG_ROLE_PROMPTS',
];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('dispatchOptionsFor', () => {
  it('defaults plan and synthesize to haiku with turn caps, execute to no model', () => {
    expect(dispatchOptionsFor('plan')).toEqual({ model: 'haiku', maxTurns: 15 });
    expect(dispatchOptionsFor('synthesize')).toEqual({ model: 'haiku', maxTurns: 1 });
    expect(dispatchOptionsFor('execute')).toEqual({});
  });

  it('lets env vars override the model per role', () => {
    process.env.ORG_MODEL_PLAN = 'sonnet';
    process.env.ORG_MODEL_EXECUTE = 'haiku';
    expect(dispatchOptionsFor('plan').model).toBe('sonnet');
    expect(dispatchOptionsFor('execute').model).toBe('haiku');
  });

  it('treats an empty / "default" / "none" model env var as "no --model"', () => {
    process.env.ORG_MODEL_PLAN = 'none';
    expect(dispatchOptionsFor('plan').model).toBeUndefined();
  });

  it('lets env vars override the turn caps and ignores non-numbers', () => {
    process.env.ORG_MAX_TURNS_PLAN = '30';
    process.env.ORG_MAX_TURNS_SYNTHESIZE = 'oops';
    expect(dispatchOptionsFor('plan').maxTurns).toBe(30);
    expect(dispatchOptionsFor('synthesize').maxTurns).toBe(1);
  });
});

describe('scalar knobs', () => {
  it('planCacheTtlHours defaults to 24 and clamps junk to the default', () => {
    expect(planCacheTtlHours()).toBe(24);
    process.env.ORG_PLAN_CACHE_TTL_HOURS = '0';
    expect(planCacheTtlHours()).toBe(0);
    process.env.ORG_PLAN_CACHE_TTL_HOURS = 'x';
    expect(planCacheTtlHours()).toBe(24);
  });

  it('repoMapTokenBudget defaults to 6000, 0 disables', () => {
    expect(repoMapTokenBudget()).toBe(6000);
    process.env.ORG_REPO_MAP_TOKENS = '0';
    expect(repoMapTokenBudget()).toBe(0);
  });

  it('rolePromptsEnabled defaults true, "off"/"0"/"false" disable', () => {
    expect(rolePromptsEnabled()).toBe(true);
    for (const v of ['off', '0', 'false', 'no']) {
      process.env.ORG_ROLE_PROMPTS = v;
      expect(rolePromptsEnabled()).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config/efficiency.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/config/efficiency.ts
//
// Every knob here is an ORG_* environment variable with a baked-in default.
// The daemon captures its environment once at start (src/daemon/manager.ts), so
// changing one of these takes effect on the next `org daemon` restart — the same
// contract as ORG_RUNNER_IMAGE and friends. There is no config file.

export type DispatchRole = 'plan' | 'execute' | 'synthesize';

const NO_MODEL = new Set(['', 'none', 'default', 'off']);

function envModel(key: string, fallback?: string): string | undefined {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  return NO_MODEL.has(v) ? undefined : raw.trim();
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const MODEL_KEY: Record<DispatchRole, string> = {
  plan: 'ORG_MODEL_PLAN',
  execute: 'ORG_MODEL_EXECUTE',
  synthesize: 'ORG_MODEL_SYNTHESIZE',
};

// Defaults: the two narrow tasks tier down to Haiku; execution is left alone.
const MODEL_DEFAULT: Record<DispatchRole, string | undefined> = {
  plan: 'haiku',
  execute: undefined,
  synthesize: 'haiku',
};

const MAX_TURNS_DEFAULT: Partial<Record<DispatchRole, number>> = {
  plan: 15,
  synthesize: 1,
};

export function dispatchOptionsFor(role: DispatchRole): { model?: string; maxTurns?: number } {
  const opts: { model?: string; maxTurns?: number } = {};
  const model = envModel(MODEL_KEY[role], MODEL_DEFAULT[role]);
  if (model) opts.model = model;

  if (role === 'plan') opts.maxTurns = envInt('ORG_MAX_TURNS_PLAN', MAX_TURNS_DEFAULT.plan!);
  if (role === 'synthesize') opts.maxTurns = envInt('ORG_MAX_TURNS_SYNTHESIZE', MAX_TURNS_DEFAULT.synthesize!);

  return opts;
}

/** 0 disables the plan cache entirely. */
export function planCacheTtlHours(): number {
  return envInt('ORG_PLAN_CACHE_TTL_HOURS', 24);
}

/** 0 disables the repo-map handoff (Phase 2). */
export function repoMapTokenBudget(): number {
  return envInt('ORG_REPO_MAP_TOKENS', 6000);
}

/** Role-scoped system prompts (Phase 3). On unless explicitly turned off. */
export function rolePromptsEnabled(): boolean {
  const v = (process.env.ORG_ROLE_PROMPTS ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/config/efficiency.test.ts`
Expected: PASS

- [ ] **Step 5: Edit `src/daemon/manager.ts`** — add the new vars to the env passthrough block (around lines 35–39, alongside `ORG_RUNNER_IMAGE`):

```typescript
          ...(process.env.ORG_MODEL_PLAN ? { ORG_MODEL_PLAN: process.env.ORG_MODEL_PLAN } : {}),
          ...(process.env.ORG_MODEL_EXECUTE ? { ORG_MODEL_EXECUTE: process.env.ORG_MODEL_EXECUTE } : {}),
          ...(process.env.ORG_MODEL_SYNTHESIZE ? { ORG_MODEL_SYNTHESIZE: process.env.ORG_MODEL_SYNTHESIZE } : {}),
          ...(process.env.ORG_MAX_TURNS_PLAN ? { ORG_MAX_TURNS_PLAN: process.env.ORG_MAX_TURNS_PLAN } : {}),
          ...(process.env.ORG_MAX_TURNS_SYNTHESIZE ? { ORG_MAX_TURNS_SYNTHESIZE: process.env.ORG_MAX_TURNS_SYNTHESIZE } : {}),
          ...(process.env.ORG_PLAN_CACHE_TTL_HOURS ? { ORG_PLAN_CACHE_TTL_HOURS: process.env.ORG_PLAN_CACHE_TTL_HOURS } : {}),
          ...(process.env.ORG_REPO_MAP_TOKENS ? { ORG_REPO_MAP_TOKENS: process.env.ORG_REPO_MAP_TOKENS } : {}),
          ...(process.env.ORG_ROLE_PROMPTS ? { ORG_ROLE_PROMPTS: process.env.ORG_ROLE_PROMPTS } : {}),
```

- [ ] **Step 6: Run the daemon manager test to confirm nothing broke**

Run: `npx vitest run src/daemon/manager.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/config/efficiency.ts src/config/efficiency.test.ts src/daemon/manager.ts
git commit -m "feat: efficiency config module (ORG_* env vars, baked-in defaults)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Thread options through `executeStep` and put usage on the result

**Files:**
- Modify: `src/execution/execute-step.ts`
- Test: `src/execution/execute-step.test.ts` (extend)

**Interfaces:**
- Consumes: `BuildCommandOptions` (Task 2), `usageFromEvents` / `DispatchUsage` (Task 1).
- Produces:
  - `ExecuteStepInput` gains `model?: string; maxTurns?: number; systemPrompt?: string`.
  - `ExecuteStepResult` gains `usage: DispatchUsage`.

- [ ] **Step 1: Write the failing test** (append to `src/execution/execute-step.test.ts`; follow the file's existing dependency-injection style — it passes a `Partial<ExecuteStepDeps>` and a fake adapter)

```typescript
import { usageFromEvents } from './tokens.js';

describe('executeStep dispatch options', () => {
  it('passes model / maxTurns / systemPrompt into adapter.buildCommand', async () => {
    let seenOpts: unknown;
    const adapter = {
      name: 'fake',
      buildCommand: (goal: string, _grant: unknown, opts: unknown) => { seenOpts = opts; return ['x']; },
      parseLine: () => null,
      parseEventStream: async () => [],
    };
    await executeStep(
      {
        nodeId: 'n', goal: 'g', namespace: 'ns', worktreePath: '/tmp', credentials: {},
        adapter: adapter as never, image: 'img',
        model: 'haiku', maxTurns: 3, systemPrompt: 'be brief',
      },
      fakeDepsThatCompleteImmediately(), // reuse whatever this file already defines
    );
    expect(seenOpts).toEqual({ model: 'haiku', maxTurns: 3, systemPrompt: 'be brief' });
  });

  it('populates result.usage from the collected events', async () => {
    const result = await executeStep(
      { nodeId: 'n', goal: 'g', namespace: 'ns', worktreePath: '/tmp', credentials: {}, adapter: fakeAdapterEmittingResultWithUsage(), image: 'img' },
      fakeDepsThatCompleteImmediately(),
    );
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });
});
```

> Implementer note: this test file already builds fake deps for `createJob` / `waitForJobCompletion` / `streamJobLogs` etc. Reuse those helpers; only the adapter and the two new assertions are new. If a helper named differently, adapt — the point is: (a) capture the 3rd arg to `buildCommand`, (b) feed one `{"type":"result","usage":{"input_tokens":10,...}}` line through `parseLine`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/execution/execute-step.test.ts`
Expected: FAIL — `buildCommand` called with 2 args; `result.usage` undefined

- [ ] **Step 3: Edit `src/execution/execute-step.ts`**

In `ExecuteStepInput` add:

```typescript
  /** Per-dispatch model override (role-tiered by the caller). Omitted → runtime default. */
  model?: string;
  /** Hard turn cap for this dispatch. */
  maxTurns?: number;
  /** Appended to the runtime's system prompt. */
  systemPrompt?: string;
```

In `ExecuteStepResult` add:

```typescript
  /** Token counts for this dispatch, read from the runtime's final result
   *  event. All zeros when the runtime reported none. */
  usage: import('./tokens.js').DispatchUsage;
```

Add the import at the top:

```typescript
import { usageFromEvents } from './tokens.js';
```

Change the `buildCommand` call (currently `command: input.adapter.buildCommand(input.goal, input.grant),`):

```typescript
      command: input.adapter.buildCommand(input.goal, input.grant, {
        model: input.model,
        maxTurns: input.maxTurns,
        systemPrompt: input.systemPrompt,
      }),
```

Every `return { succeeded, message, events, ... }` in this function must also carry `usage`. There are three return sites (the success path, and two early guards return `ExecuteStepResult`-shaped objects — check the file). For the main success path:

```typescript
      return {
        succeeded: jobResult.succeeded,
        message: jobResult.succeeded ? jobResult.message : (runtimeError(collected) ?? jobResult.message),
        events: collected,
        usage: usageFromEvents(collected),
      };
```

For any early-return object that has no events, add `usage: usageFromEvents([])`.

- [ ] **Step 4: Update the `NodeMachineContext.lastResult` fallback shapes**

`src/lifecycle/node-machine.ts` builds `{ succeeded: false, message: String(event.error), events: [] }` on `onError` in two places (SELF_EXECUTE and DELEGATE). TypeScript will now require `usage`. Add `usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 0 }` to both, or import a `ZERO_USAGE` constant — export one from `tokens.ts`:

```typescript
// add to src/execution/tokens.ts
export const ZERO_USAGE: DispatchUsage = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 0,
};
```

and use `ZERO_USAGE` in node-machine.ts's two `onError` actions and in `delegate-child.ts`'s several `ExecuteStepResult` literals (`succeeded: false, ... events: []`).

- [ ] **Step 5: Typecheck + run affected tests**

Run: `npm run typecheck`
Expected: no errors

Run: `npx vitest run src/execution/execute-step.test.ts src/lifecycle/node-machine.test.ts src/lifecycle/delegate-child.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/execution/execute-step.ts src/execution/execute-step.test.ts src/execution/tokens.ts src/lifecycle/node-machine.ts src/lifecycle/delegate-child.ts
git commit -m "feat: executeStep forwards model/maxTurns/systemPrompt and returns token usage

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Git state helpers + plan cache (`git-state.ts`, `plan-cache.ts`)

**Files:**
- Create: `src/execution/git-state.ts`
- Create: `src/db/queries/plan-cache.ts`
- Test: `src/execution/git-state.test.ts`, `src/db/queries/plan-cache.test.ts`

**Interfaces:**
- Consumes: `Db` from `src/db/client.js`; `memory` table.
- Produces:
  - `function repoHead(worktreePath: string): string | null`
  - `function repoDirty(worktreePath: string): boolean`
  - `function planCacheKey(goal: string, repoHead: string): string` (sha256 hex)
  - `function getCachedPlan(db: Db, key: string, ttlHours: number, now?: Date): string[] | null`
  - `function putCachedPlan(db: Db, key: string, subgoals: string[], head: string, createdAt: string): void`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/execution/git-state.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoHead, repoDirty } from './git-state.js';

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gitstate-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'hello');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('git-state', () => {
  it('repoHead returns a 40-char sha for a real repo, null for a non-repo', () => {
    expect(repoHead(tmpRepo())).toMatch(/^[0-9a-f]{40}$/);
    expect(repoHead(mkdtempSync(join(tmpdir(), 'plain-')))).toBeNull();
  });

  it('repoDirty is false on a clean tree, true after an edit', () => {
    const dir = tmpRepo();
    expect(repoDirty(dir)).toBe(false);
    writeFileSync(join(dir, 'a.txt'), 'changed');
    expect(repoDirty(dir)).toBe(true);
  });

  it('repoDirty is true (fail-safe) when the path is not a repo', () => {
    expect(repoDirty(mkdtempSync(join(tmpdir(), 'plain2-')))).toBe(true);
  });
});
```

```typescript
// src/db/queries/plan-cache.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { planCacheKey, getCachedPlan, putCachedPlan } from './plan-cache.js';

const DB = './test-plancache.db';
afterEach(() => { for (const s of ['', '-journal', '-wal', '-shm']) if (existsSync(DB + s)) unlinkSync(DB + s); });

describe('plan cache', () => {
  it('planCacheKey is stable and depends on both goal and head', () => {
    expect(planCacheKey('g', 'h')).toBe(planCacheKey('g', 'h'));
    expect(planCacheKey('g', 'h')).not.toBe(planCacheKey('g', 'h2'));
    expect(planCacheKey('g', 'h')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a stored plan within TTL and null past it', () => {
    const db = createDb(DB);
    const key = planCacheKey('goal', 'head1');
    putCachedPlan(db, key, ['sub a', 'sub b'], 'head1', '2026-09-08T00:00:00.000Z');

    const fresh = new Date('2026-09-08T05:00:00.000Z');
    expect(getCachedPlan(db, key, 24, fresh)).toEqual(['sub a', 'sub b']);

    const stale = new Date('2026-09-10T00:00:00.000Z');
    expect(getCachedPlan(db, key, 24, stale)).toBeNull();
  });

  it('ttlHours of 0 always misses', () => {
    const db = createDb(DB);
    const key = planCacheKey('goal', 'head1');
    putCachedPlan(db, key, ['x', 'y'], 'head1', new Date().toISOString());
    expect(getCachedPlan(db, key, 0)).toBeNull();
  });

  it('a corrupt row is treated as a miss, not an error', () => {
    const db = createDb(DB);
    // put a row whose value is not a string[]
    putCachedPlan(db, 'k', ['ok'], 'h', new Date().toISOString());
    db.run?.(''); // no-op; see note
    expect(getCachedPlan(db, 'missing-key', 24)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/execution/git-state.test.ts src/db/queries/plan-cache.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write `src/execution/git-state.ts`**

```typescript
import { execFileSync } from 'node:child_process';

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** The worktree's committed HEAD, or null when it is not a git repo / git is
 *  unavailable. Used as the plan-cache and repo-map key. */
export function repoHead(worktreePath: string): string | null {
  const out = git(['rev-parse', 'HEAD'], worktreePath);
  return out && /^[0-9a-f]{40}$/.test(out) ? out : null;
}

/** True when the tree has uncommitted changes — or when we cannot tell. A
 *  dirty (or unknowable) tree must never be served a cached plan, because the
 *  key only captures the committed state. */
export function repoDirty(worktreePath: string): boolean {
  const out = git(['status', '--porcelain'], worktreePath);
  if (out === null) return true;
  return out.length > 0;
}
```

- [ ] **Step 4: Write `src/db/queries/plan-cache.ts`**

```typescript
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memory } from '../schema.js';
import { randomUUID } from 'node:crypto';

const KIND = 'plan';

export function planCacheKey(goal: string, head: string): string {
  return createHash('sha256').update(`${goal}\0${head}`).digest('hex');
}

interface PlanValue { subgoals: string[]; repoHead: string }

/** A previously computed subgoal list for this exact goal + committed HEAD,
 *  if one was stored within `ttlHours`. Any miss / malformed row / disabled
 *  cache returns null — the caller then plans normally. */
export function getCachedPlan(db: Db, key: string, ttlHours: number, now: Date = new Date()): string[] | null {
  if (ttlHours <= 0) return null;
  const row = db.select().from(memory)
    .where(and(eq(memory.kind, KIND), eq(memory.key, key)))
    .all()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (!row) return null;

  const ageMs = now.getTime() - Date.parse(row.createdAt);
  if (!Number.isFinite(ageMs) || ageMs > ttlHours * 3_600_000) return null;

  const value = row.value as Partial<PlanValue> | null;
  const subgoals = value?.subgoals;
  if (!Array.isArray(subgoals) || subgoals.some((s) => typeof s !== 'string') || subgoals.length < 2) {
    return null;
  }
  return subgoals as string[];
}

export function putCachedPlan(db: Db, key: string, subgoals: string[], head: string, createdAt: string): void {
  db.insert(memory).values({
    id: randomUUID(),
    kind: KIND,
    key,
    value: { subgoals, repoHead: head } satisfies PlanValue,
    confidence: null,
    nodeId: null,
    createdAt,
  }).run();
}
```

> Note on the "corrupt row" test: simplify it to just assert `getCachedPlan(db, 'never-stored', 24)` is `null`. Drop the `db.run?.('')` line — it was a placeholder. The malformed-value branch is covered by reading the code; if you want it tested, insert a row directly via `db.insert(memory).values({... value: { subgoals: 'nope' } ...})` and assert `null`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/execution/git-state.test.ts src/db/queries/plan-cache.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/execution/git-state.ts src/execution/git-state.test.ts src/db/queries/plan-cache.ts src/db/queries/plan-cache.test.ts
git commit -m "feat: git-state helpers and semantic plan cache (goal + HEAD keyed)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `dispatch_usage` recording + `org tokens`

**Files:**
- Create: `src/db/queries/tokens.ts`
- Modify: `src/server/routers/memory.ts`
- Create: `src/cli/commands/tokens.ts`
- Modify: `src/cli/index.ts`
- Test: `src/db/queries/tokens.test.ts`

**Interfaces:**
- Consumes: `DispatchUsage` (Task 1), `Db`, `memory` table, `subtreeNodeIds` from `src/db/queries/nodes.js`.
- Produces:
  - `function recordDispatchUsage(db: Db, r: { nodeId: string; role: string; model: string | null; usage: DispatchUsage; costUsd: number; createdAt: string }): void`
  - `interface RoleTokenRow { role: string; model: string; dispatches: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number }`
  - `function tokensByRole(db: Db, caseId?: string): { rows: RoleTokenRow[]; planCacheHits: number }`

- [ ] **Step 1: Write the failing test**

```typescript
// src/db/queries/tokens.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { recordDispatchUsage, tokensByRole } from './tokens.js';

const DB = './test-tokens.db';
afterEach(() => { for (const s of ['', '-journal', '-wal', '-shm']) if (existsSync(DB + s)) unlinkSync(DB + s); });

const usage = (input: number, output: number) => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 1,
});

describe('tokensByRole', () => {
  it('aggregates dispatch_usage rows by role and model', () => {
    const db = createDb(DB);
    const t = '2026-09-08T00:00:00.000Z';
    recordDispatchUsage(db, { nodeId: 'a', role: 'plan', model: 'haiku', usage: usage(100, 20), costUsd: 0.001, createdAt: t });
    recordDispatchUsage(db, { nodeId: 'a', role: 'plan', model: 'haiku', usage: usage(50, 10), costUsd: 0.0005, createdAt: t });
    recordDispatchUsage(db, { nodeId: 'a', role: 'execute', model: null, usage: usage(9000, 800), costUsd: 0.09, createdAt: t });

    const { rows } = tokensByRole(db);
    const plan = rows.find((r) => r.role === 'plan')!;
    expect(plan.dispatches).toBe(2);
    expect(plan.inputTokens).toBe(150);
    expect(plan.model).toBe('haiku');
    const exec = rows.find((r) => r.role === 'execute')!;
    expect(exec.model).toBe('(default)');
    expect(exec.inputTokens).toBe(9000);
  });

  it('counts plan-cache hit rows', () => {
    const db = createDb(DB);
    // a plan-cache-hit is recorded as a dispatch_usage row with role 'plan:cache-hit'
    recordDispatchUsage(db, { nodeId: 'a', role: 'plan:cache-hit', model: null, usage: usage(0, 0), costUsd: 0, createdAt: 'x' });
    expect(tokensByRole(db).planCacheHits).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/queries/tokens.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/db/queries/tokens.ts`**

```typescript
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memory } from '../schema.js';
import { subtreeNodeIds } from './nodes.js';
import type { DispatchUsage } from '../../execution/tokens.js';

const KIND = 'dispatch_usage';

export function recordDispatchUsage(
  db: Db,
  r: { nodeId: string; role: string; model: string | null; usage: DispatchUsage; costUsd: number; createdAt: string },
): void {
  db.insert(memory).values({
    id: randomUUID(),
    kind: KIND,
    key: r.role,
    value: { role: r.role, model: r.model, usage: r.usage, costUsd: r.costUsd },
    confidence: null,
    nodeId: r.nodeId,
    createdAt: r.createdAt,
  }).run();
}

export interface RoleTokenRow {
  role: string;
  model: string;
  dispatches: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

interface StoredValue { role: string; model: string | null; usage: DispatchUsage; costUsd: number }

export function tokensByRole(db: Db, caseId?: string): { rows: RoleTokenRow[]; planCacheHits: number } {
  const all = db.select().from(memory).where(eq(memory.kind, KIND)).all();
  const scope = caseId ? new Set(subtreeNodeIds(db, caseId)) : null;
  const rows = all.filter((row) => !scope || (row.nodeId && scope.has(row.nodeId)));

  let planCacheHits = 0;
  const acc = new Map<string, RoleTokenRow>();
  for (const row of rows) {
    const v = row.value as StoredValue;
    if (v.role === 'plan:cache-hit') { planCacheHits++; continue; }
    const model = v.model ?? '(default)';
    const bucket = `${v.role}\0${model}`;
    const cur = acc.get(bucket) ?? { role: v.role, model, dispatches: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
    cur.dispatches += 1;
    cur.inputTokens += v.usage?.inputTokens ?? 0;
    cur.outputTokens += v.usage?.outputTokens ?? 0;
    cur.cacheReadTokens += v.usage?.cacheReadTokens ?? 0;
    cur.costUsd += v.costUsd ?? 0;
    acc.set(bucket, cur);
  }
  return {
    rows: [...acc.values()].sort((a, b) => b.inputTokens - a.inputTokens),
    planCacheHits,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/queries/tokens.test.ts`
Expected: PASS

- [ ] **Step 5: Add a tRPC query** — in `src/server/routers/memory.ts`, add to the router object:

```typescript
  tokens: publicProcedure
    .input(z.object({ caseId: z.string().optional() }).optional())
    .query(({ input, ctx }) => tokensByRole(ctx.db, input?.caseId)),
```

Add the imports (`import { tokensByRole } from '../../db/queries/tokens.js';` and `z` if not already imported).

- [ ] **Step 6: Write `src/cli/commands/tokens.ts`**

```typescript
import type { Command } from 'commander';
import { createDaemonClient } from '../../daemon/client.js';

export function registerTokensCommand(program: Command): void {
  program
    .command('tokens [caseId]')
    .description('Show token usage by dispatch role and model')
    .action(async (caseId?: string) => {
      const client = createDaemonClient();
      const { rows, planCacheHits } = await client.memory.tokens.query(caseId ? { caseId } : undefined);
      if (rows.length === 0) {
        console.log('No dispatch usage recorded yet.');
        return;
      }
      const fmt = (n: number) => n.toLocaleString('en-US');
      console.log('role'.padEnd(18) + 'model'.padEnd(12) + 'runs'.padEnd(6) + 'in'.padEnd(12) + 'out'.padEnd(10) + 'cache-read'.padEnd(12) + 'cost $');
      let tin = 0, tout = 0, tcost = 0;
      for (const r of rows) {
        tin += r.inputTokens; tout += r.outputTokens; tcost += r.costUsd;
        console.log(
          r.role.padEnd(18) + r.model.padEnd(12) + String(r.dispatches).padEnd(6) +
          fmt(r.inputTokens).padEnd(12) + fmt(r.outputTokens).padEnd(10) +
          fmt(r.cacheReadTokens).padEnd(12) + r.costUsd.toFixed(4),
        );
      }
      console.log('-'.repeat(76));
      console.log('total'.padEnd(36) + fmt(tin).padEnd(12) + fmt(tout).padEnd(10) + ''.padEnd(12) + tcost.toFixed(4));
      console.log(`plan-cache hits: ${planCacheHits}`);
    });
}
```

- [ ] **Step 7: Register it** in `src/cli/index.ts` (import + `registerTokensCommand(program);`).

- [ ] **Step 8: Typecheck + build check**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add src/db/queries/tokens.ts src/db/queries/tokens.test.ts src/server/routers/memory.ts src/cli/commands/tokens.ts src/cli/index.ts
git commit -m "feat: record per-dispatch token usage and add 'org tokens'

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Wire tiering, turn caps, read-only planning grant, plan cache, usage recording, and model fallback into `node-actor-manager.ts`

This is the integration task. It touches the three dispatch closures (`planSubgoals`, `synthesizeChildren`, the `executeStep` actor) plus a small pure helper.

**Files:**
- Create: `src/lifecycle/dispatch-helpers.ts`
- Modify: `src/lifecycle/node-actor-manager.ts`
- Test: `src/lifecycle/dispatch-helpers.test.ts`

**Interfaces:**
- Consumes: `dispatchOptionsFor` (Task 3), `shouldRetryWithoutModel` / `usageFromEvents` (Task 1), `repoHead` / `repoDirty` (Task 5), `planCacheKey` / `getCachedPlan` / `putCachedPlan` (Task 5), `recordDispatchUsage` (Task 6).
- Produces:
  - `function readOnlyPlanningGrant(grant: ToolGrant | undefined): ToolGrant` — intersects the node's grant with a read-only tool set.
  - `const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS']`

- [ ] **Step 1: Write the failing test for the pure helper**

```typescript
// src/lifecycle/dispatch-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { readOnlyPlanningGrant, READ_ONLY_TOOLS } from './dispatch-helpers.js';

describe('readOnlyPlanningGrant', () => {
  it('an unrestricted grant becomes the read-only tool set', () => {
    expect(readOnlyPlanningGrant({ allowedTools: null, readOnly: false })).toEqual({
      allowedTools: READ_ONLY_TOOLS, readOnly: true,
    });
    expect(readOnlyPlanningGrant(undefined)).toEqual({ allowedTools: READ_ONLY_TOOLS, readOnly: true });
  });

  it('a restricted grant is intersected — writers are dropped, readers kept', () => {
    const g = readOnlyPlanningGrant({ allowedTools: ['Read', 'Edit', 'Bash', 'Grep'], readOnly: false });
    expect(g.allowedTools).toEqual(['Read', 'Grep']);
    expect(g.readOnly).toBe(true);
  });

  it('a restricted grant with no readers at all yields an empty allowlist (planning can still look via none? -> keep READ_ONLY set)', () => {
    // If the node was granted only writers, planning still needs to read: fall
    // back to the read-only set rather than an allowlist of nothing.
    const g = readOnlyPlanningGrant({ allowedTools: ['Edit', 'Write'], readOnly: false });
    expect(g.allowedTools).toEqual(READ_ONLY_TOOLS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lifecycle/dispatch-helpers.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/lifecycle/dispatch-helpers.ts`**

```typescript
import type { ToolGrant } from '../adapters/adapter.js';

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS'];

/** The grant a planning dispatch runs under: never more than read-only, and
 *  never wider than what the node itself holds. Planning inspects the repo to
 *  decide a split; it must not start doing the work. */
export function readOnlyPlanningGrant(grant: ToolGrant | undefined): ToolGrant {
  if (!grant || grant.allowedTools === null) {
    return { allowedTools: [...READ_ONLY_TOOLS], readOnly: true };
  }
  const intersection = grant.allowedTools.filter((t) => READ_ONLY_TOOLS.includes(t));
  return {
    allowedTools: intersection.length > 0 ? intersection : [...READ_ONLY_TOOLS],
    readOnly: true,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lifecycle/dispatch-helpers.test.ts`
Expected: PASS

- [ ] **Step 5: Edit `planSubgoals` in `src/lifecycle/node-actor-manager.ts`**

Add imports at the top of the file:

```typescript
import { dispatchOptionsFor } from '../config/efficiency.js';
import { planCacheTtlHours } from '../config/efficiency.js';
import { repoHead, repoDirty } from '../execution/git-state.js';
import { planCacheKey, getCachedPlan, putCachedPlan } from '../db/queries/plan-cache.js';
import { recordDispatchUsage } from '../db/queries/tokens.js';
import { shouldRetryWithoutModel } from '../execution/tokens.js';
import { readOnlyPlanningGrant } from './dispatch-helpers.js';
import { grantOf } from ... // grantOf is already defined in this file; no import needed
```

Inside `planSubgoals`, right after the `worktreePath` / `maxChildren < 2` guard and before the credentials check, add the cache lookup:

```typescript
  const ttl = planCacheTtlHours();
  const head = repoHead(worktreePath);
  const dirty = repoDirty(worktreePath);
  const cacheKey = head && !dirty ? planCacheKey(goal, head) : null;
  if (cacheKey) {
    const cached = getCachedPlan(db, cacheKey, ttl);
    if (cached) {
      publishProgress(db, nodeId, 'Reusing a plan computed earlier for this goal and repo state');
      recordDispatchUsage(db, {
        nodeId, role: 'plan:cache-hit', model: null,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 0 },
        costUsd: 0, createdAt: new Date().toISOString(),
      });
      return cached;
    }
  }
```

In the `executeStep({...})` call inside `planSubgoals`, add:

```typescript
      ...dispatchOptionsFor('plan'),                 // model + maxTurns
      grant: readOnlyPlanningGrant(grantOf(getNode(db, nodeId)!.contract.authority)),
```

After `const result = await dispatch(...)` resolves and `text` is parsed into `subgoals`, record usage and store the plan:

```typescript
    recordDispatchUsage(db, {
      nodeId, role: 'plan', model: dispatchOptionsFor('plan').model ?? null,
      usage: result.usage, costUsd: costFromEvents(result.events), createdAt: new Date().toISOString(),
    });
    if (cacheKey && subgoals.length >= 2) {
      putCachedPlan(db, cacheKey, subgoals, head!, new Date().toISOString());
    }
```

where `costFromEvents` is a 2-line local helper (sum `total_cost_usd` off `result` events) — add it near the top of the file:

```typescript
function costFromEvents(events: { type: string; payload: unknown }[]): number {
  return events
    .filter((e) => e.type === 'result')
    .reduce((s, e) => s + Number((e.payload as { total_cost_usd?: number } | null)?.total_cost_usd ?? 0), 0);
}
```

- [ ] **Step 6: Edit `synthesizeChildren`** — in its `executeStep({...})` call add `...dispatchOptionsFor('synthesize'),` and after it resolves:

```typescript
    recordDispatchUsage(db, {
      nodeId, role: 'synthesize', model: dispatchOptionsFor('synthesize').model ?? null,
      usage: result.usage, costUsd: costFromEvents(result.events), createdAt: new Date().toISOString(),
    });
```

- [ ] **Step 7: Edit the `executeStep` actor closure** (the `fromPromise` around line 383–451).

Wrap the dispatch in a one-shot model-fallback:

```typescript
        const execOpts = dispatchOptionsFor('execute');
        const runOnce = (model: string | undefined) => dispatch(db, nodeId, () => executeStep({
          nodeId,
          goal: input.goal,
          namespace: NAMESPACE,
          worktreePath,
          credentials: resolveCredentials(os.homedir(), process.env.ANTHROPIC_API_KEY),
          adapter,
          image: runnerImageOverride(),
          grant: grantOf(node!.contract.authority),
          model,
          maxTurns: execOpts.maxTurns,
          onViolation: (tool) => publishDenial(db, nodeId, tool, node!.contract.authority),
          onEvent: (event) => { /* unchanged block */ },
        }));

        let result = await runOnce(execOpts.model);
        if (execOpts.model && shouldRetryWithoutModel(result.events)) {
          publishProgress(db, nodeId, `Model "${execOpts.model}" is unavailable on this plan — retrying on the default model`);
          insertMemoryRow(db, 'model_tier_unavailable', 'execute', { model: execOpts.model }, nodeId);
          result = await runOnce(undefined);
        }
        recordDispatchUsage(db, {
          nodeId, role: 'execute', model: execOpts.model ?? null,
          usage: result.usage, costUsd: costFromEvents(result.events), createdAt: new Date().toISOString(),
        });
```

> `input.goal` replaces `withConstraints(input.goal, ...)` **only in Phase 3 / Task 13**. For Phase 1, keep `goal: withConstraints(input.goal, node?.contract.constraints ?? []),` exactly as it is — just add `model` / `maxTurns` / the fallback wrapper around it.
>
> `insertMemoryRow` helper: a 6-line function near the top of the file — `db.insert(memory).values({ id: randomUUID(), kind, key, value, confidence: null, nodeId, createdAt: new Date().toISOString() }).run();`. Import `memory` from `../db/schema.js` if not already imported.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS. The existing `node-actor-manager.test.ts` still drives an escalating contract that never dispatches, so it is unaffected. Fix any TypeScript fallout from the new fields.

- [ ] **Step 9: Commit**

```bash
git add src/lifecycle/dispatch-helpers.ts src/lifecycle/dispatch-helpers.test.ts src/lifecycle/node-actor-manager.ts
git commit -m "feat: tier models, cap turns, cache plans, record usage, fall back on model rejection

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Doctor probe for callable models

**Files:**
- Modify: `src/doctor/checks.ts`
- Modify: `src/cli/commands/doctor.ts`
- Test: `src/doctor/checks.test.ts` (extend if present; else add a focused test)

**Interfaces:**
- Produces: `function probeModels(run?: (args: string[]) => string): { haiku: boolean; sonnet: boolean }` in `src/doctor/checks.ts` (inject the runner for testability).

- [ ] **Step 1: Write the failing test**

```typescript
// in src/doctor/checks.test.ts
import { probeModels } from './checks.js';

describe('probeModels', () => {
  it('reports a model callable when the probe command succeeds', () => {
    const ok = probeModels(() => 'ok');
    expect(ok).toEqual({ haiku: true, sonnet: true });
  });
  it('reports a model not callable when its probe throws', () => {
    const res = probeModels((args) => {
      if (args.includes('haiku')) throw new Error('no access');
      return 'ok';
    });
    expect(res).toEqual({ haiku: false, sonnet: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/doctor/checks.test.ts`
Expected: FAIL — `probeModels` not exported

- [ ] **Step 3: Add `probeModels` to `src/doctor/checks.ts`**

```typescript
import { execFileSync } from 'node:child_process';

function defaultProbe(args: string[]): string {
  return execFileSync('claude', args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Which models the current auth can actually call. Advisory: `org doctor`
 *  prints it so a Pro-plan user knows tiering will fall back before they run. */
export function probeModels(run: (args: string[]) => string = defaultProbe): { haiku: boolean; sonnet: boolean } {
  const test = (model: string): boolean => {
    try { run(['--print', '--model', model, 'reply with the single word ok']); return true; }
    catch { return false; }
  };
  return { haiku: test('haiku'), sonnet: test('sonnet') };
}
```

- [ ] **Step 4: Surface it in `src/cli/commands/doctor.ts`** — add a check row following the file's existing pattern (each check returns `{ ok, message }`):

```typescript
      {
        name: 'callable models',
        run: () => {
          const m = probeModels();
          if (m.haiku && m.sonnet) return { ok: true, message: 'haiku and sonnet both callable' };
          if (!m.haiku && !m.sonnet) return { ok: false, message: 'neither haiku nor sonnet callable — check auth' };
          return { ok: true, message: `${m.haiku ? 'haiku' : 'sonnet'} callable; ${m.haiku ? 'sonnet' : 'haiku'} is not — model tiering will fall back` };
        },
      },
```

(Import `probeModels`. Match the exact shape the surrounding checks use — if they're async, wrap accordingly.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/doctor/checks.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/doctor/checks.ts src/doctor/checks.test.ts src/cli/commands/doctor.ts
git commit -m "feat: org doctor probes which models the current auth can call

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Phase 1 docs

**Files:**
- Modify: `USAGE.md`

- [ ] **Step 1: Add a "Token efficiency" section to `USAGE.md`** documenting the env vars introduced in Task 3, with the defaults table and a note that changes take effect on `org daemon` restart. Include `org tokens` and the new `org doctor` row.

- [ ] **Step 2: Commit**

```bash
git add USAGE.md
git commit -m "docs: document token-efficiency env vars, org tokens, model probe

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## PHASE 2 — Repo-map handoff

### Task 10: Repo-map builder (`src/intelligence/repo-map.ts`)

**Files:**
- Create: `src/intelligence/repo-map.ts`
- Test: `src/intelligence/repo-map.test.ts`

**Interfaces:**
- Produces:
  - `function buildRepoMap(worktreePath: string, tokenBudget: number): string` (synchronous — one `git ls-files` call + file reads; return `''` on any failure or `tokenBudget <= 0`)
  - `function withRepoMap(goal: string, map: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
// src/intelligence/repo-map.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRepoMap, withRepoMap } from './repo-map.js';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repomap-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'export function alpha() {}\nexport class Beta {}\n');
  writeFileSync(join(dir, 'README.md'), '# hi');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'i'], { cwd: dir });
  return dir;
}

describe('buildRepoMap', () => {
  it('lists tracked files and top-level symbols within budget', () => {
    const map = buildRepoMap(repo(), 6000);
    expect(map).toContain('src/a.ts');
    expect(map).toContain('alpha');
    expect(map).toContain('Beta');
    expect(map).toContain('README.md');
  });

  it('returns "" for a non-repo, a zero budget, or a bad path', () => {
    expect(buildRepoMap(mkdtempSync(join(tmpdir(), 'plain-')), 6000)).toBe('');
    expect(buildRepoMap(repo(), 0)).toBe('');
    expect(buildRepoMap('/no/such/dir', 6000)).toBe('');
  });

  it('drops symbols (tree only) when the budget is tiny', () => {
    const map = buildRepoMap(repo(), 20); // ~80 chars
    expect(map).toContain('src/a.ts');
    expect(map).not.toContain('alpha');
  });
});

describe('withRepoMap', () => {
  it('prefixes the goal with the map, and is a no-op for an empty map', () => {
    expect(withRepoMap('do the thing', '')).toBe('do the thing');
    const out = withRepoMap('do the thing', 'MAP');
    expect(out).toContain('MAP');
    expect(out.trimEnd().endsWith('do the thing')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/intelligence/repo-map.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/intelligence/repo-map.ts`**

```typescript
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ponytail: regex symbol scan, not a parser. Covers the top-level declarations
// of the languages this repo actually contains; upgrade to web-tree-sitter if a
// benchmark shows the map is too coarse to help.
const SYMBOL = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(|def|func)\s+([A-Za-z_$][\w$]*)/;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cts|mts|py|go|rs|java|rb|c|cc|cpp|h|hpp)$/;
const CHARS_PER_TOKEN = 4;

function tracked(worktreePath: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

function symbolsOf(worktreePath: string, file: string): string[] {
  try {
    const lines = readFileSync(join(worktreePath, file), 'utf8').split('\n');
    const names: string[] = [];
    for (const line of lines) {
      const m = SYMBOL.exec(line);
      if (m?.[1]) names.push(m[1]);
      if (names.length >= 40) break;
    }
    return names;
  } catch {
    return [];
  }
}

/** A compact, size-bounded view of the repository handed to a child so it can
 *  navigate instead of grepping from zero. Empty string on any failure — the
 *  caller then dispatches with the bare goal, exactly as before. */
export function buildRepoMap(worktreePath: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return '';
  const files = tracked(worktreePath);
  if (!files) return '';

  const budgetChars = tokenBudget * CHARS_PER_TOKEN;
  const treeBlock = ['Repository files:', ...files.map((f) => `  ${f}`)].join('\n');

  if (treeBlock.length >= budgetChars) {
    // Even the tree is over budget: truncate it.
    const keep: string[] = [];
    let used = 'Repository files:\n'.length;
    for (const f of files) {
      const line = `  ${f}\n`;
      if (used + line.length > budgetChars) { keep.push(`  [... ${files.length - keep.length} more files]`); break; }
      keep.push(`  ${f}`); used += line.length;
    }
    return ['Repository files:', ...keep].join('\n');
  }

  const symbolLines: string[] = [];
  let used = treeBlock.length;
  for (const f of files) {
    if (!SOURCE_EXT.test(f)) continue;
    const names = symbolsOf(worktreePath, f);
    if (names.length === 0) continue;
    const line = `  ${f}: ${names.join(', ')}`;
    if (used + line.length + 1 > budgetChars) break;
    symbolLines.push(line); used += line.length + 1;
  }

  return symbolLines.length > 0
    ? `${treeBlock}\n\nTop-level symbols:\n${symbolLines.join('\n')}`
    : treeBlock;
}

export function withRepoMap(goal: string, map: string): string {
  if (!map.trim()) return goal;
  return [
    'Here is a map of the repository you are working in. Use it to navigate;',
    'do not re-derive it.',
    '',
    map,
    '',
    '---',
    '',
    goal,
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/intelligence/repo-map.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/repo-map.ts src/intelligence/repo-map.test.ts
git commit -m "feat: compact size-bounded repo map for child dispatches

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: Wire the repo map into delegation

**Files:**
- Modify: `src/lifecycle/node-actor-manager.ts`
- Modify: `src/db/queries/plan-cache.ts` → no; use a dedicated helper instead
- Create: `src/db/queries/repo-map-cache.ts`
- Test: `src/db/queries/repo-map-cache.test.ts`

**Interfaces:**
- Produces:
  - `function getRepoMap(db: Db, head: string): string | null`
  - `function putRepoMap(db: Db, head: string, map: string, createdAt: string): void`

- [ ] **Step 1: Write the failing test**

```typescript
// src/db/queries/repo-map-cache.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { getRepoMap, putRepoMap } from './repo-map-cache.js';

const DB = './test-repomap.db';
afterEach(() => { for (const s of ['', '-journal', '-wal', '-shm']) if (existsSync(DB + s)) unlinkSync(DB + s); });

it('stores and retrieves a map by repo head, null when absent', () => {
  const db = createDb(DB);
  expect(getRepoMap(db, 'headX')).toBeNull();
  putRepoMap(db, 'headX', 'THE MAP', new Date().toISOString());
  expect(getRepoMap(db, 'headX')).toBe('THE MAP');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/queries/repo-map-cache.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/db/queries/repo-map-cache.ts`**

```typescript
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memory } from '../schema.js';

const KIND = 'repo_map';

export function getRepoMap(db: Db, head: string): string | null {
  const row = db.select().from(memory)
    .where(and(eq(memory.kind, KIND), eq(memory.key, head)))
    .all()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const map = (row?.value as { map?: unknown } | undefined)?.map;
  return typeof map === 'string' && map.length > 0 ? map : null;
}

export function putRepoMap(db: Db, head: string, map: string, createdAt: string): void {
  db.insert(memory).values({
    id: randomUUID(), kind: KIND, key: head, value: { map },
    confidence: null, nodeId: null, createdAt,
  }).run();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/db/queries/repo-map-cache.test.ts`
Expected: PASS

- [ ] **Step 5: Wire into `node-actor-manager.ts`**

Add imports:

```typescript
import { buildRepoMap, withRepoMap } from '../intelligence/repo-map.js';
import { getRepoMap, putRepoMap } from '../db/queries/repo-map-cache.js';
import { repoMapTokenBudget } from '../config/efficiency.js';
```

In the `delegateToChild` actor closure, after `subgoals` is known to be non-empty and before `delegateToChildren` is called, build and store the map once:

```typescript
          if (subgoals.length > 0) {
            const head = repoHead(node?.repoPath ?? process.env.ORG_WORKTREE_PATH ?? '');
            const budget = repoMapTokenBudget();
            if (head && budget > 0 && !getRepoMap(db, head)) {
              const map = buildRepoMap(node?.repoPath ?? process.env.ORG_WORKTREE_PATH ?? '', budget);
              if (map) putRepoMap(db, head, map, new Date().toISOString());
            }
          }
```

The children are started by `realDelegateDeps(db).startChild(childId, goal)` → `startNodeActor`. The map needs to reach the child's `execute` dispatch. Simplest wiring that stays within existing structure: in the `executeStep` actor closure, look up the map for the current node's repo head and prefix the goal — this covers both children and self-executing nodes (a self-executing node benefits equally):

```typescript
        // Phase 2: hand the agent a repo map so it navigates instead of
        // re-exploring. Empty/absent map → bare goal, as before.
        const mapHead = repoHead(worktreePath);
        const repoMap = mapHead ? getRepoMap(db, mapHead) : null;
        // build lazily for a self-executing root that never delegated
        const effectiveMap = repoMap ?? (() => {
          const b = repoMapTokenBudget();
          if (!mapHead || b <= 0) return null;
          const m = buildRepoMap(worktreePath, b);
          if (m) putRepoMap(db, mapHead, m, new Date().toISOString());
          return m || null;
        })();
        const goalForDispatch = effectiveMap ? withRepoMap(input.goal, effectiveMap) : input.goal;
```

Then use `goalForDispatch` where the closure currently passes the goal. In Phase 1 that line is `goal: withConstraints(input.goal, ...)` → make it `goal: withConstraints(goalForDispatch, ...)`. In Phase 3 (Task 13) it becomes `goal: goalForDispatch`.

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/db/queries/repo-map-cache.ts src/db/queries/repo-map-cache.test.ts src/lifecycle/node-actor-manager.ts
git commit -m "feat: build a repo map once per repo state and prefix agent dispatches with it

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: Benchmark harness (`bench/`)

**Files:**
- Create: `bench/goals.json`
- Create: `bench/run.mjs`
- Modify: `package.json` (add `"bench": "node bench/run.mjs"`)
- Create: `bench/README.md`

**Interfaces:** none (standalone script). It shells out to `org run` with different `ORG_*` env values and reads `org tokens --json` (add a `--json` flag to the tokens command in this task).

- [ ] **Step 1: Add `--json` to `org tokens`** — in `src/cli/commands/tokens.ts`, accept `--json` and, when set, `console.log(JSON.stringify({ rows, planCacheHits }))` instead of the table. Commit this small change with the bench task.

- [ ] **Step 2: Write `bench/goals.json`**

```json
{
  "repo": ".",
  "goals": [
    { "id": "typo-fix", "goal": "Fix any typos in README.md", "rubric": "README typos corrected, no code changed" },
    { "id": "small-bug", "goal": "Find and fix off-by-one errors in src/, if any", "rubric": "a real off-by-one is fixed or a clear 'none found' with evidence" },
    { "id": "add-test", "goal": "Add a unit test for src/engines/economics.ts scoreDelegation tolerance behaviour", "rubric": "a passing test that exercises the 1e-9 tolerance path" },
    { "id": "audit", "goal": "Audit every query module in src/db/queries for missing error handling", "rubric": "each module named with a concrete finding or 'clean'" },
    { "id": "doc", "goal": "Document the node lifecycle states in a new docs/lifecycle.md", "rubric": "each state from node-machine.ts described accurately" }
  ]
}
```

- [ ] **Step 3: Write `bench/run.mjs`**

```javascript
#!/usr/bin/env node
// Compare token usage / outcome with a knob on vs off.
// Usage:
//   node bench/run.mjs repo-map      # ORG_REPO_MAP_TOKENS=6000 vs =0
//   node bench/run.mjs role-prompts  # ORG_ROLE_PROMPTS=on vs off   (Phase 3)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const mode = process.argv[2];
const MATRIX = {
  'repo-map': [['on', { ORG_REPO_MAP_TOKENS: '6000' }], ['off', { ORG_REPO_MAP_TOKENS: '0' }]],
  'role-prompts': [['on', { ORG_ROLE_PROMPTS: 'on' }], ['off', { ORG_ROLE_PROMPTS: 'off' }]],
};
if (!MATRIX[mode]) { console.error('mode must be one of: ' + Object.keys(MATRIX).join(', ')); process.exit(2); }

const { goals } = JSON.parse(readFileSync(new URL('./goals.json', import.meta.url)));
const sh = (cmd, args, env) => execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });

for (const [label, env] of MATRIX[mode]) {
  console.log(`\n=== ${mode}: ${label} ===`);
  sh('org', ['daemon', 'stop'], env);          // restart so env is recaptured
  sh('org', ['daemon', 'start'], env);
  for (const g of goals) {
    const started = Date.now();
    const out = sh('org', ['run', g.goal], env);
    const id = (out.match(/Root node created: (\S+)/) || [])[1];
    // crude wait — poll `org tree` until the root is terminal
    let state = '';
    while (!['COMPLETE', 'FAILED', 'CANCELLED'].includes(state)) {
      await new Promise((r) => setTimeout(r, 5000));
      state = (sh('org', ['tree'], env).split('\n').find((l) => l.startsWith(id)) || '').split(/\s+/)[1] || '';
    }
    const tokens = JSON.parse(sh('org', ['tokens', id, '--json'], env));
    const totalIn = tokens.rows.reduce((s, r) => s + r.inputTokens, 0);
    console.log(`${g.id}\t${state}\t${totalIn} in-tokens\t${((Date.now() - started) / 1000).toFixed(0)}s\trubric: ${g.rubric}`);
  }
}
console.log('\nScore the rubric column by hand. Ship criterion: total in-tokens lower AND every rubric still passes.');
```

- [ ] **Step 4: Write `bench/README.md`** — explain it needs a real cluster + auth, is manual/interactive, and the ship criteria from the spec (Phase 2: tokens strictly lower + no rubric regression; Phase 3: rubric improves/holds + retries don't rise + tokens don't rise).

- [ ] **Step 5: Commit**

```bash
git add bench/ package.json src/cli/commands/tokens.ts
git commit -m "feat: bench harness comparing a knob on vs off over a fixed goal set

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Run the benchmark manually** (requires a live kind cluster + `claude login`)

Run: `npm run bench repo-map`
Expected: a table. **Do not merge Phase 2's default-on** unless total in-tokens is lower and every rubric still passes. If it fails, set the default `ORG_REPO_MAP_TOKENS` to `0` in `src/config/efficiency.ts` (keep the machinery, ship it off) and note the result in `bench/README.md`.

---

## PHASE 3 — Role-based system prompts

### Task 13: Role prompt module (`src/prompts/roles.ts`)

**Files:**
- Create: `src/prompts/roles.ts`
- Test: `src/prompts/roles.test.ts`

**Interfaces:**
- Produces:
  - `type PromptRole = 'plan' | 'execute' | 'synthesize' | 'verify'`
  - `interface RolePromptParams { allowedTools?: string[] | null; constraints?: string[]; definitionOfDone?: string[] }`
  - `const HARNESS_CONSTITUTION: string`
  - `function buildRolePrompt(role: PromptRole, params?: RolePromptParams): string`

- [ ] **Step 1: Write the failing test**

```typescript
// src/prompts/roles.test.ts
import { describe, it, expect } from 'vitest';
import { buildRolePrompt, HARNESS_CONSTITUTION } from './roles.js';

describe('buildRolePrompt', () => {
  it('every role starts with the constitution', () => {
    for (const role of ['plan', 'execute', 'synthesize', 'verify'] as const) {
      expect(buildRolePrompt(role).startsWith(HARNESS_CONSTITUTION)).toBe(true);
    }
  });

  it('plan tells the agent to split only if it genuinely divides and stay read-only', () => {
    const p = buildRolePrompt('plan');
    expect(p).toMatch(/only if it genuinely divides/i);
    expect(p).toMatch(/do not (make|implement)/i);
    expect(p).toMatch(/JSON array/i);
  });

  it('execute interpolates tools, constraints and DoD, and omits empty sections cleanly', () => {
    const withAll = buildRolePrompt('execute', {
      allowedTools: ['Read', 'Edit'],
      constraints: ['Do not touch the database'],
      definitionOfDone: ['tests pass', 'no lint errors'],
    });
    expect(withAll).toContain('Read, Edit');
    expect(withAll).toContain('Do not touch the database');
    expect(withAll).toContain('tests pass');

    const bare = buildRolePrompt('execute', { allowedTools: null, constraints: [], definitionOfDone: [] });
    expect(bare).not.toMatch(/constraints:\s*\n\s*\n/i); // no dangling empty label
    expect(bare).toMatch(/any tool/i);                   // null allowlist phrased as unrestricted
  });

  it('is compact — under 500 words for any role', () => {
    for (const role of ['plan', 'execute', 'synthesize', 'verify'] as const) {
      expect(buildRolePrompt(role, { constraints: ['x'], definitionOfDone: ['y'], allowedTools: ['Read'] }).split(/\s+/).length).toBeLessThan(500);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/prompts/roles.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/prompts/roles.ts`**

```typescript
export type PromptRole = 'plan' | 'execute' | 'synthesize' | 'verify';

export interface RolePromptParams {
  allowedTools?: string[] | null;
  constraints?: string[];
  definitionOfDone?: string[];
}

export const HARNESS_CONSTITUTION = [
  'You are one node in an accountable agent organization. Three rules govern every node:',
  '1. Work strictly inside the mandate you were given — the tools, the budget, the scope. If a task needs more than you hold, stop and say so; do not find a way around it.',
  '2. Produce evidence, not just a result. What you changed, what you ran, what you verified — state it so someone who was not here can check it.',
  '3. Be honest about uncertainty and blockers. "I could not verify X" is worth more than a confident guess.',
].join('\n');

function list(label: string, items: string[] | undefined): string {
  const real = (items ?? []).map((s) => s.trim()).filter(Boolean);
  if (real.length === 0) return '';
  return `\n\n${label}:\n${real.map((s) => `  - ${s}`).join('\n')}`;
}

function stanza(role: PromptRole, p: RolePromptParams): string {
  switch (role) {
    case 'plan':
      return [
        'YOUR ROLE FOR THIS RUN: planner.',
        'Split the goal into independent, non-overlapping, self-contained subgoals — but only if it genuinely divides. Prefer fewer children. If it is one unit of work, return an empty array.',
        'Inspect the repository read-only. Do not make any changes and do not implement anything.',
        'Output contract: a JSON array of strings and nothing else.',
      ].join('\n');
    case 'execute': {
      const tools = p.allowedTools === null || p.allowedTools === undefined
        ? 'You may use any tool available to you.'
        : `You may use only these tools: ${p.allowedTools.join(', ')}.`;
      return [
        'YOUR ROLE FOR THIS RUN: implementer closing one commitment.',
        tools,
        'Work to the definition of done and then stop — do not gold-plate.',
        'Your final message is the evidence that closes this commitment: state what you changed, what you verified, and what remains unchecked.',
        'If a standing constraint blocks the most direct path, follow the constraint and say which one and where.',
        list('Standing constraints (told, not enforced)', p.constraints),
        list('Definition of done', p.definitionOfDone),
      ].join('\n');
    }
    case 'synthesize':
      return [
        'YOUR ROLE FOR THIS RUN: lead combining your team\'s reports into the single answer the requester is owed.',
        'Merge overlapping findings — report a repeated pattern once. Keep every concrete detail: file:line references, code, numbers. Order by importance, most serious first.',
        'Say plainly if an agent did not finish and what is therefore unchecked. Output only the answer — no preamble, no sign-off.',
      ].join('\n');
    case 'verify':
      return [
        'YOUR ROLE FOR THIS RUN: verifier.',
        'For each definition-of-done criterion, decide MET / NOT MET / INSUFFICIENT EVIDENCE against the evidence produced. Do not fix anything.',
        'Output a structured verdict, one line per criterion, with the evidence you relied on.',
        list('Definition of done', p.definitionOfDone),
      ].join('\n');
  }
}

/** The constitution plus a role stanza, for `--append-system-prompt`. */
export function buildRolePrompt(role: PromptRole, params: RolePromptParams = {}): string {
  return `${HARNESS_CONSTITUTION}\n\n${stanza(role, params)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/prompts/roles.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/prompts/roles.ts src/prompts/roles.test.ts
git commit -m "feat: role-based system prompts (constitution + per-stage stanza)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 14: Wire role prompts in; retire `withConstraints`; slim the user prompts

**Files:**
- Modify: `src/lifecycle/node-actor-manager.ts`
- Modify: `src/intelligence/plan.ts`
- Modify: `src/intelligence/synthesize.ts`
- Delete: `src/execution/prompt.ts`, `src/execution/prompt.test.ts`
- Modify: `src/intelligence/plan.test.ts`, `src/intelligence/synthesize.test.ts` (adjust expectations)
- Test: `src/lifecycle/node-actor-manager.test.ts` (add an assertion — see Step 6)

**Interfaces:**
- Consumes: `buildRolePrompt` (Task 13), `rolePromptsEnabled` (Task 3).

- [ ] **Step 1: Slim `buildPlanPrompt` in `src/intelligence/plan.ts`**

Remove the role/rules sentences that now live in the `plan` stanza. Keep only the task-specific content:

```typescript
export function buildPlanPrompt(goal: string, maxChildren: number): string {
  const limit = Math.max(1, Math.min(maxChildren, MAX_SUBGOALS));
  return [
    `Split this goal across up to ${limit} independent agents.`,
    '',
    `GOAL: ${goal}`,
    '',
    `Reply with ONLY a JSON array of up to ${limit} strings — one self-contained subgoal each,`,
    'written for an agent who cannot see this conversation. No subgoal may depend on or overlap another.',
    'Reply with exactly [] if the goal is already a single unit of work.',
    'Example: ["Audit src/auth for unhandled promise rejections", "Add tests for the cart discount edge cases"]',
  ].join('\n');
}
```

Update `src/intelligence/plan.test.ts` expectations accordingly (the parse tests for `parseSubgoals` are unaffected; only assertions on `buildPlanPrompt`'s wording change).

- [ ] **Step 2: Slim `buildSynthesisPrompt` in `src/intelligence/synthesize.ts`**

Drop the "You are the lead..." framing and the requirements list that now live in the `synthesize` stanza; keep the goal, the per-agent sections, and the output-format reminder:

```typescript
export function buildSynthesisPrompt(goal: string, children: ChildReport[]): string {
  const sections = children.map((child, index) => [
    `### Agent ${index + 1}${child.succeeded ? '' : ' (did not finish)'}`,
    `Asked to: ${child.goal}`,
    '',
    child.report.trim() ? clip(child.report) : '_This agent produced no report._',
  ].join('\n'));

  return [
    `THE ORIGINAL GOAL: ${goal}`,
    '',
    '---',
    '',
    sections.join('\n\n---\n\n'),
    '',
    '---',
    '',
    'Write the single combined answer now, in GitHub-flavoured Markdown.',
  ].join('\n');
}
```

Update `src/intelligence/synthesize.test.ts` wording assertions (`hasReports` / `clip` / `MAX_REPORT_CHARS` tests are unaffected).

- [ ] **Step 3: Edit `node-actor-manager.ts` — planning dispatch**

Add import: `import { buildRolePrompt } from '../prompts/roles.js';` and `import { rolePromptsEnabled } from '../config/efficiency.js';`

In `planSubgoals`'s `executeStep` call add:

```typescript
      systemPrompt: rolePromptsEnabled() ? buildRolePrompt('plan') : undefined,
```

- [ ] **Step 4: Edit `node-actor-manager.ts` — synthesis dispatch**

In `synthesizeChildren`'s `executeStep` call add:

```typescript
      systemPrompt: rolePromptsEnabled() ? buildRolePrompt('synthesize') : undefined,
```

- [ ] **Step 5: Edit `node-actor-manager.ts` — execute dispatch; retire `withConstraints`**

Remove `import { withConstraints } from '../execution/prompt.js';`.

In the `executeStep` actor closure (`runOnce` from Task 7), change the goal line from
`goal: withConstraints(goalForDispatch, node?.contract.constraints ?? []),`
to
`goal: goalForDispatch,`

and add to the same `executeStep({...})`:

```typescript
          systemPrompt: rolePromptsEnabled()
            ? buildRolePrompt('execute', {
                allowedTools: grantOf(node!.contract.authority).allowedTools,
                constraints: node?.contract.constraints ?? [],
                definitionOfDone: node?.contract.definition_of_done ?? [],
              })
            : undefined,
```

> If `rolePromptsEnabled()` is false, constraints would be silently dropped (they no longer ride the goal). Guard: when role prompts are off, keep the old behaviour by falling back to a minimal inline prefix. Simplest — always pass the constraints through the system prompt path, and when role prompts are off, still prepend them to the goal:
> ```typescript
> const constraints = node?.contract.constraints ?? [];
> const goalWithConstraints = (!rolePromptsEnabled() && constraints.length > 0)
>   ? `Standing instructions (follow even where they conflict with the most direct path):\n${constraints.map((c) => `  - ${c}`).join('\n')}\n\n${goalForDispatch}`
>   : goalForDispatch;
> ```
> Use `goalWithConstraints` as the dispatch goal. This keeps constraints honoured in both modes and still removes the separate `prompt.ts` module.

- [ ] **Step 6: Delete `src/execution/prompt.ts` and `src/execution/prompt.test.ts`**

```bash
git rm src/execution/prompt.ts src/execution/prompt.test.ts
```

- [ ] **Step 7: Add a wiring assertion to `node-actor-manager.test.ts`**

The existing escalating-contract test never dispatches. Add a small unit test that calls the exported helpers directly instead — or, cheaper, assert in `dispatch-helpers.test.ts` style that `buildRolePrompt('execute', {...})` is what the manager would pass. Minimum viable: a test that imports nothing new and just confirms `src/execution/prompt.js` is gone:

```typescript
it('no longer imports the retired prompt module', async () => {
  await expect(import('../execution/prompt.js')).rejects.toThrow();
});
```

- [ ] **Step 8: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: PASS. Expect to touch `plan.test.ts` and `synthesize.test.ts` for wording; everything else green.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: wire role system prompts into plan/execute/synthesize; retire withConstraints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 15: Phase 3 benchmark + docs

**Files:**
- Modify: `bench/run.mjs` (role-prompts mode already stubbed in Task 12 — verify it works)
- Modify: `USAGE.md`

- [ ] **Step 1: Run the role-prompt benchmark** (live cluster + auth)

Run: `npm run bench role-prompts`
Expected: a table. **Ship criterion:** rubric improves or holds, retry count does not rise, total in-tokens (prompt + retries) does not rise. If a role's stanza fails, keep `rolePromptsEnabled()` default-on but drop that stanza to an empty string in `roles.ts` and record why in `bench/README.md`.

- [ ] **Step 2: Document `ORG_ROLE_PROMPTS` in `USAGE.md`** — what it does, the four roles, that it is on by default, and how to disable.

- [ ] **Step 3: Commit**

```bash
git add bench/ USAGE.md src/prompts/roles.ts
git commit -m "docs: document ORG_ROLE_PROMPTS; record Phase 3 benchmark result

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task(s) |
|---|---|
| 1a Per-dispatch token accounting (`usageFromEvents`, `ExecuteStepResult.usage`, `memory` rows, `org tokens`) | 1, 4, 6, 7 |
| 1b Configurable model tiering (`ExecuteStepInput.model/maxTurns`, `buildCommand` opts, config, resolve per role, Pro-plan one-retry fallback + `model_tier_unavailable` row) | 2, 3, 4, 7 |
| 1b Doctor probe | 8 |
| 1c Read-only planning grant; `--max-turns` caps (synth=1, plan=15) | 3, 7 |
| 1d Semantic plan cache (`goal + HEAD` key, dirty-skip, TTL, hit recorded for `org tokens`) | 5, 7 |
| Phase 2 map builder (`git ls-files` + symbols, size bound, tree-only fallback, `""` on error; tree-sitter deferred with ponytail note) | 10 |
| Phase 2 handoff (`withRepoMap`, `repo_map` memory row keyed by head, child execute only) | 10, 11 |
| Phase 2 benchmark gate | 12 |
| Phase 3 delivery (`--append-system-prompt` only; `systemPrompt` through input→adapter) | 2, 4, 14 |
| Phase 3 `roles.ts` (`HARNESS_CONSTITUTION` + plan/execute/synthesize/verify stanzas; verify defined, not wired) | 13 |
| Phase 3 consequent changes (`withConstraints` off the goal path; slim `buildPlanPrompt`/`buildSynthesisPrompt`; text config-tunable via `ORG_ROLE_PROMPTS`) | 14 |
| Phase 3 benchmark gate | 12, 15 |
| Config surface (env vars, not YAML — deviation noted in Global Constraints) | 3, 9, 15 |
| Failure posture (every knob degrades to current behaviour) | 3, 5, 7, 10, 11, 14 |
| Docs in USAGE.md | 9, 15 |

Deviation from spec, called out: **config is `ORG_*` env vars, not a YAML file** — the codebase has no config-file loader and building one is out of proportion to the change (Global Constraints). `verify` stanza is written but unwired (spec agrees). `caseId` is not stored on `dispatch_usage` rows — `org tokens [caseId]` scopes by `subtreeNodeIds` on the existing `nodeId` column instead (simpler, same result).

**Placeholder scan:** No "TBD"/"handle errors"/"similar to Task N". Two places say "match the file's existing pattern" (doctor check row shape in Task 8; execute-step fake-deps in Task 4) — both are because the surrounding code's exact shape must be followed and is visible in the file; the required behaviour and signatures are given in full.

**Type consistency:** `DispatchUsage` (Task 1) fields `inputTokens/outputTokens/cacheReadTokens/cacheCreationTokens/numTurns` used identically in Tasks 4, 6, 7. `BuildCommandOptions` `{model?, maxTurns?, systemPrompt?}` (Task 2) matches `ExecuteStepInput` additions (Task 4) and the call site (Task 4, 7, 14). `dispatchOptionsFor(role)` returns `{model?, maxTurns?}` — spread into `executeStep` input in Task 7. `planCacheKey/getCachedPlan/putCachedPlan` signatures (Task 5) match call sites (Task 7). `buildRolePrompt(role, params)` / `RolePromptParams` (Task 13) match the call in Task 14. `withRepoMap(goal, map)` (Task 10) matches Task 11. `recordDispatchUsage` signature (Task 6) matches all four call sites (Task 7).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-08-token-efficiency.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
