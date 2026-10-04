/** Can this execution candidate actually run right now?
 *
 *  A feasibility question, and only that. This module used to pick the
 *  provider — Claude or Codex — by scoring runtime history; that choice now
 *  belongs to the Action Market, which prices every Harness × Model × Effort
 *  candidate on its own evidence. What remains here is what the market cannot
 *  know on its own:
 *
 *   - is the harness up (an outage or a spent quota makes it *infeasible*,
 *     never a reason to switch into a different routing mode);
 *   - can it serve this model name at all;
 *   - does it expose this effort setting;
 *   - has this exact candidate already been refused in this run (a model the
 *     plan does not include) — so recovery re-enters the market without it.
 *
 *  A degraded harness stays feasible but is priced as riskier. Infeasible
 *  candidates are returned marked, not dropped, so the receipt can say why
 *  each one could not run. */
import type { ActionCandidate } from '../decision/actions.js';
import type { HarnessCapabilitySnapshot } from '../adapters/adapter.js';

export type ProviderHealth = HarnessCapabilitySnapshot['health'];

/** How much a degraded harness adds to a candidate's failure probability. A
 *  price, not a gate: a degraded harness that is still far cheaper can win. */
const DEGRADED_FAILURE_RISK = 0.25;

export interface FeasibilityInput {
  candidates: ActionCandidate[];
  harnesses: HarnessCapabilitySnapshot[];
  /** Candidate ids observed to be unrunnable earlier in this run, with why. */
  refused?: ReadonlyMap<string, string>;
}

function infeasibility(candidate: ActionCandidate, harness: HarnessCapabilitySnapshot | undefined, refused?: ReadonlyMap<string, string>): string | null {
  if (!harness) return 'harness_unavailable';
  if (harness.health === 'down') return 'harness_down';
  if (harness.health === 'rate_limited') return 'harness_rate_limited';
  const model = candidate.metadata.model as string | undefined;
  if (model !== undefined && !harness.acceptsModelFlag) return 'harness_has_no_model_flag';
  if (model !== undefined && !harness.serves(model)) return 'harness_cannot_serve_model';
  const effort = candidate.metadata.effort as string | undefined;
  if (effort !== undefined && !harness.efforts.includes(effort)) return 'effort_unsupported';
  return refused?.get(candidate.id) ?? null;
}

export function markFeasibility(input: FeasibilityInput): ActionCandidate[] {
  const byName = new Map(input.harnesses.map((h) => [h.harness, h]));
  return input.candidates.map((candidate) => {
    const harness = byName.get(candidate.metadata.harness as string);
    const reason = infeasibility(candidate, harness, input.refused);
    if (reason) return { ...candidate, metadata: { ...candidate.metadata, infeasible: reason } };
    if (harness?.health === 'degraded') {
      return {
        ...candidate,
        failureRisk: Math.min(1, candidate.failureRisk + DEGRADED_FAILURE_RISK),
        metadata: { ...candidate.metadata, degraded: true },
      };
    }
    return candidate;
  });
}
