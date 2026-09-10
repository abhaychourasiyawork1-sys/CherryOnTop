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
