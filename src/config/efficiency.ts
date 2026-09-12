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

// Planning answers one question — "does this goal come apart, and if so into
// what?" — and answers it as a JSON array. It is not a coding agent with a
// smaller budget. 15 was a coding agent's allowance: a measured planning run
// used 5 turns exploring a repository it was already handed a goal-aware map of
// (src/context/dispatch-context.ts). Two turns is look-then-answer.
//
// `execute` is the one unbounded term in the whole system. The conversation
// prefix is re-read on every turn, so cost inside a dispatch grows superlinearly
// in turns: a measured 42-turn run spent 1.77M cache-read tokens against a
// 19-turn one's 652k. 60 is a circuit breaker rather than a budget — the
// measured spread was 19-42, so it costs nothing today and bounds the one term
// nothing bounded. `ORG_MAX_TURNS_EXECUTE=0` removes it, which is the behaviour
// this branch shipped with.
const MAX_TURNS_DEFAULT: Partial<Record<DispatchRole, number>> = {
  plan: 2,
  synthesize: 1,
  execute: 60,
};

export function dispatchOptionsFor(role: DispatchRole): { model?: string; maxTurns?: number } {
  const opts: { model?: string; maxTurns?: number } = {};
  const model = envModel(MODEL_KEY[role], MODEL_DEFAULT[role]);
  if (model) opts.model = model;

  if (role === 'plan') opts.maxTurns = envInt('ORG_MAX_TURNS_PLAN', MAX_TURNS_DEFAULT.plan!);
  if (role === 'synthesize') opts.maxTurns = envInt('ORG_MAX_TURNS_SYNTHESIZE', MAX_TURNS_DEFAULT.synthesize!);
  // Zero means uncapped, and the runtime reads an *absent* flag as uncapped —
  // passing `--max-turns 0` would end the run before its first turn.
  if (role === 'execute') {
    const cap = envInt('ORG_MAX_TURNS_EXECUTE', MAX_TURNS_DEFAULT.execute!);
    if (cap > 0) opts.maxTurns = cap;
  }

  return opts;
}

/** The most children one node may fan out to by default.
 *
 *  Was a flat 5. Each child is a whole sandbox with its own turn loop, and on a
 *  broad goal they mostly re-read the same repository — five of them cost five
 *  times one and answer a fifth of the question each. Two is enough to be a
 *  real split and cheap enough to be wrong about; raise it deliberately, per
 *  deployment, once a fan-out of that size is shown to pay for itself. A node's
 *  own `max_child_count` authority still applies and can only lower this. */
export function maxChildJobs(): number {
  return Math.max(1, envInt('ORG_MAX_CHILD_JOBS', 2));
}

/** 0 disables the plan cache entirely. */
export function planCacheTtlHours(): number {
  return envInt('ORG_PLAN_CACHE_TTL_HOURS', 24);
}

/** How long a finished read-only dispatch's answer stays reusable; 0 disables
 *  result reuse entirely.
 *
 *  Same validity rule as the plan cache, one level up: the same goal against the
 *  same committed tree, under the same model and the same grant. The difference
 *  is what it saves — a cached plan skips a planning sandbox measured at $0.045,
 *  a cached read-only execution skips one measured at $0.95. Restricted to
 *  read-only dispatches, because "we did not re-run it" is only equivalent to
 *  "we re-ran it" when there were no side effects to lose. */
export function resultCacheTtlHours(): number {
  return envInt('ORG_RESULT_CACHE_TTL_HOURS', 24);
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

export type EfficiencyMode = 'disabled' | 'shadow' | 'enabled';

/** How much of the efficiency work is live.
 *
 *  `disabled` is this branch's behaviour before adaptive routing: fixed
 *  per-role models, nothing decided from complexity. `shadow` decides and
 *  records but dispatches as `disabled` would, so a deployment can measure the
 *  change before taking it. `enabled` acts on the decisions.
 *
 *  Defaults to `enabled`: the components it gates all degrade to the previous
 *  behaviour on any failure, and a flag nobody turns on measures nothing. */
export function efficiencyMode(): EfficiencyMode {
  return parseEfficiencyMode(process.env.ORG_EFFICIENCY_MODE);
}

export function parseEfficiencyMode(value: string | undefined): EfficiencyMode {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'disabled' || v === 'off' || v === '0' || v === 'false') return 'disabled';
  if (v === 'shadow') return 'shadow';
  return 'enabled';
}

/** The model name for a tier, or undefined to let the runtime use its own
 *  default. `fast` is the only tier with a baked-in value: tiering *down* can
 *  only save, while tiering up is a cost increase nobody asked for, so `deep`
 *  stays opt-in until an operator names a model for it. */
export function modelForTier(tier: 'fast' | 'standard' | 'deep'): string | undefined {
  if (tier === 'fast') return envModel('ORG_MODEL_FAST', 'haiku');
  if (tier === 'deep') return envModel('ORG_MODEL_DEEP', undefined);
  return envModel('ORG_MODEL_STANDARD', undefined);
}

/** True when the operator named a model for this role explicitly. An explicit
 *  choice outranks anything routing would decide — that is what makes it an
 *  override rather than a suggestion. */
export function hasExplicitModel(role: DispatchRole): boolean {
  return process.env[MODEL_KEY[role]] !== undefined;
}
