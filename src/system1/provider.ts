import type { DecisionJudgment, DecisionRequest, ProviderName } from './types.js';

/** Why a provider could not answer. A *failure*, distinct from an uncertain
 *  answer: an uncertain judgment is still a judgment, and it goes to economics.
 *  A failure goes to the deterministic fallback. */
export type ProviderFailureKind = 'timeout' | 'unavailable' | 'http' | 'malformed' | 'rejected';

export class ProviderFailure extends Error {
  constructor(readonly kind: ProviderFailureKind, message: string) {
    super(message);
    this.name = 'ProviderFailure';
  }
}

/** Every System-1 provider. Answers come back in request order, one per
 *  request, or the call throws `ProviderFailure`: a partial batch is never
 *  returned, so no caller can mistake a missing answer for a "no". */
export interface System1Provider {
  readonly name: ProviderName;
  /** `timeoutMs` is what is left of the decision's latency budget; it
   *  overrides the provider's own default so a retry cannot overrun it. */
  decide(requests: readonly DecisionRequest[], options?: { timeoutMs?: number }): Promise<DecisionJudgment[]>;
}
