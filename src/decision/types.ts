/** One vocabulary for every choice the runtime makes, and one receipt shape for
 *  explaining it.
 *
 *  The value is not the enum — it is that every decision, whoever makes it,
 *  comes back in a shape that names what was chosen, what it beat, and what it
 *  was expected to cost. A system that can only tell you *what* it did cannot be
 *  argued with; one that tells you what it nearly did instead can. */

export type DecisionType =
  | 'REUSE_CONTEXT'
  | 'RETRIEVE_CONTEXT'
  | 'EXPAND_CONTEXT'
  | 'RUN_TOOL'
  | 'RUN_TEST'
  | 'REUSE_COMPUTATION'
  | 'RESTORE_SNAPSHOT'
  | 'FORK_WORKSPACE'
  | 'RUN_MODEL'
  | 'SPAWN_AGENT'
  | 'ESCALATE_MODEL'
  | 'SYNTHESIZE'
  | 'WAIT'
  | 'STOP';

export interface DecisionEstimate {
  tokens: number;
  latencyMs: number;
  costUsd: number;
}

export const FREE: DecisionEstimate = { tokens: 0, latencyMs: 0, costUsd: 0 };

export interface DecisionAlternative {
  type: DecisionType;
  reason: string;
  estimate: DecisionEstimate;
}

export interface DecisionReceipt {
  chosen: DecisionType;
  reason: string;
  /** How sure the engine is, 0 to 1. A hard gate is 1 — it is a rule, not a
   *  judgement — and an economic call is whatever margin it cleared by. */
  confidence: number;
  estimate: DecisionEstimate;
  /** What it was compared against. Empty only when a hard gate left nothing to
   *  compare. */
  alternatives: DecisionAlternative[];
  /** Named when a rule rather than an economic comparison decided this. */
  gate?: string;
  /** True when the answer needed no scoring at all. */
  fastPath: boolean;
}

export function receipt(over: Partial<DecisionReceipt> & Pick<DecisionReceipt, 'chosen' | 'reason'>): DecisionReceipt {
  return {
    confidence: 1,
    estimate: FREE,
    alternatives: [],
    fastPath: false,
    ...over,
  };
}
