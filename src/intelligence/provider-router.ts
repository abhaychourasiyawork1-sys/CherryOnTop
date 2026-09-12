/** Which provider serves a chosen model — a question asked *after* the model is
 *  chosen, and never inside the model's identity.
 *
 *  The distinction is the whole point. "Sonnet" is a model; the thing that
 *  serves it can be rate-limited, down, or simply absent from this deployment,
 *  and none of that should change which model the work needs. Folding the two
 *  together is how a provider outage silently becomes a quality decision — the
 *  router picks whatever is up, and the run gets a weaker model without anyone
 *  deciding that.
 *
 *  Built over `selectRuntime`, which already scores adapters on observed
 *  success, cost and latency. This adds the two things that score cannot see:
 *  whether a provider can serve the model at all, and whether it is healthy
 *  right now.
 */
import { selectRuntime, type SelectRuntimeResult } from './select-runtime.js';
import type { RuntimeStat } from '../db/queries/memory.js';

export type ProviderHealth = 'healthy' | 'degraded' | 'rate_limited' | 'down';

export interface ProviderCapability {
  /** The adapter name, as `selectRuntime` and the decisions table use it. */
  provider: string;
  /** Model names it can serve. `null` means it imposes no restriction. */
  models: string[] | null;
  health: ProviderHealth;
}

export interface ProviderRouteInput {
  /** The model already chosen. Never revised here. */
  model: string | undefined;
  candidates: ProviderCapability[];
  stats: RuntimeStat[];
  minRuns?: number;
}

export interface ProviderRouteDecision {
  provider: string | null;
  /** True when the answer needed no scoring — one viable candidate, or an
   *  obvious default. */
  fastPath: boolean;
  reason: string;
  /** Providers ruled out, and why. The record that makes a silent downgrade
   *  impossible to hide. */
  rejected: { provider: string; reason: string }[];
  /** Present when scoring ran. */
  breakdown?: SelectRuntimeResult['breakdown'];
}

const UNUSABLE: Record<ProviderHealth, string | null> = {
  healthy: null,
  degraded: null,
  rate_limited: 'rate limited',
  down: 'reported down',
};

/** Can this provider serve this model at all? A capability question, asked
 *  before any scoring — a cheaper provider that cannot serve the model is not
 *  a cheaper option, it is a different answer to a different question. */
function serves(candidate: ProviderCapability, model: string | undefined): boolean {
  if (model === undefined) return true;
  return candidate.models === null || candidate.models.includes(model);
}

export function routeProvider(input: ProviderRouteInput): ProviderRouteDecision {
  const rejected: { provider: string; reason: string }[] = [];
  const viable: ProviderCapability[] = [];

  for (const candidate of input.candidates) {
    const unhealthy = UNUSABLE[candidate.health];
    if (unhealthy) { rejected.push({ provider: candidate.provider, reason: unhealthy }); continue; }
    if (!serves(candidate, input.model)) {
      rejected.push({ provider: candidate.provider, reason: `cannot serve ${input.model}` });
      continue;
    }
    viable.push(candidate);
  }

  if (viable.length === 0) {
    return {
      provider: null, fastPath: true, rejected,
      reason: input.model
        ? `no healthy provider can serve ${input.model}`
        : 'no healthy provider is available',
    };
  }

  // One viable candidate is not a decision. Scoring it would produce a
  // breakdown that implies a comparison nobody made.
  if (viable.length === 1) {
    return {
      provider: viable[0].provider, fastPath: true, rejected,
      reason: `${viable[0].provider} is the only healthy provider that serves this model`,
    };
  }

  // Prefer a healthy provider over a degraded one before cost or latency gets a
  // vote: degraded means it is working badly, and no saving makes that a good
  // trade.
  const healthy = viable.filter((candidate) => candidate.health === 'healthy');
  const pool = healthy.length > 0 ? healthy : viable;

  const selected = selectRuntime({
    available: pool.map((candidate) => candidate.provider),
    stats: input.stats,
    minRuns: input.minRuns,
  });

  return {
    provider: selected.runtime,
    fastPath: selected.breakdown.reason_insufficient_history === 1,
    rejected: [
      ...rejected,
      ...(healthy.length > 0
        ? viable.filter((c) => c.health !== 'healthy').map((c) => ({ provider: c.provider, reason: 'degraded, and a healthy provider was available' }))
        : []),
    ],
    reason: selected.breakdown.reason_insufficient_history === 1
      ? `not enough history to move off the default; ${selected.runtime} it is`
      : `${selected.runtime} scores ${Number(selected.breakdown.score).toFixed(2)} across ${selected.breakdown.alternativesConsidered} providers`,
    breakdown: selected.breakdown,
  };
}

/** The next provider to try after one failed, or null when there is nowhere
 *  left to go.
 *
 *  Separate from `routeProvider` on purpose: a fallback is not a re-route. The
 *  failed provider is excluded rather than re-scored, because whatever its
 *  history says, it just failed. */
export function fallbackProvider(
  input: ProviderRouteInput & { failed: string; failure: ProviderHealth },
): ProviderRouteDecision {
  const remaining = input.candidates
    .filter((candidate) => candidate.provider !== input.failed);

  const decision = routeProvider({ ...input, candidates: remaining });
  return {
    ...decision,
    rejected: [...decision.rejected, { provider: input.failed, reason: `just failed (${input.failure})` }],
    reason: decision.provider
      ? `${input.failed} ${input.failure === 'rate_limited' ? 'is rate limited' : 'failed'}; falling back to ${decision.provider}`
      : `${input.failed} ${input.failure === 'rate_limited' ? 'is rate limited' : 'failed'} and nothing else can serve this`,
  };
}
