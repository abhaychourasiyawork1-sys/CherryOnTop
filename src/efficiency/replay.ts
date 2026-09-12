/** Re-running a decision the organization already took, from what it wrote down.
 *
 *  The auditability claim this runtime makes is that a decision can be explained
 *  from evidence rather than from a story: `decisions` holds the outcome and
 *  every term of the score behind it. That claim was never *checked*. The data
 *  being present is not the same as the data being sufficient, and a weight or a
 *  threshold that moves silently invalidates every past explanation without
 *  anything saying so.
 *
 *  So this takes a recorded decision, feeds its recorded inputs back through the
 *  same pure function that produced it, and reports whether today's code still
 *  reaches the same answer. Zero model calls, zero sandboxes — the decisions
 *  were arithmetic, which is exactly what makes replaying them free.
 *
 *  Deliberately narrow about what it will claim. A decision taken on a rule
 *  rather than a score (a node with no spawn authority never runs the formula),
 *  or one recorded before economics existed, is reported as *not replayable*
 *  rather than as reproduced — announcing an audit that never happened is worse
 *  than announcing none.
 */
import { scoreDelegation, counterfactual, type Counterfactual, type EconomicsInput } from '../engines/economics.js';

/** The shape `listDecisionsForNode` returns, narrowed to what a replay needs. */
export interface ReplayableDecision {
  id: string;
  type: string;
  outcome: string;
  breakdown: Record<string, number>;
}

export interface DecisionReplay {
  id: string;
  /** False when there is no formula to re-run — see the module note. */
  replayable: boolean;
  /** True only when the replay ran *and* agreed. */
  reproduced: boolean;
  recordedOutcome: string;
  replayedOutcome: string | null;
  recordedScore: number | null;
  replayedScore: number | null;
  /** The single change that would have produced the opposite decision. */
  counterfactual: Counterfactual | null;
  reason: string;
}

const TERMS = [
  'estimatedValue', 'modelCost', 'latencyCost',
  'coordinationCost', 'verificationCost', 'riskPenalty', 'threshold',
] as const;

function economicsFrom(breakdown: Record<string, number>): EconomicsInput | null {
  if (TERMS.some((term) => typeof breakdown[term] !== 'number')) return null;
  return Object.fromEntries(TERMS.map((term) => [term, breakdown[term]])) as unknown as EconomicsInput;
}

export function replayDecision(decision: ReplayableDecision): DecisionReplay {
  const base = {
    id: decision.id,
    recordedOutcome: decision.outcome,
    recordedScore: typeof decision.breakdown?.score === 'number' ? decision.breakdown.score : null,
    replayedOutcome: null,
    replayedScore: null,
    counterfactual: null,
  };

  // Only the economics decision has a formula. A runtime selection records a
  // score from a different scorer and is not re-run here.
  const input = decision.type === 'execution_decision' ? economicsFrom(decision.breakdown ?? {}) : null;
  if (!input) {
    return {
      ...base, replayable: false, reproduced: false,
      reason: 'no economics terms were recorded, so there is no formula to re-run',
    };
  }

  const result = scoreDelegation(input);
  // The recorded outcome may be ESCALATE or SELF_EXECUTE for reasons *after* the
  // score — budget floor, no agent allowance — so the replay compares what the
  // formula decides, and a divergence names both sides rather than asserting a
  // bug. What it proves is that the score and the delegate/do-not line still
  // come out where they did.
  const replayedOutcome = result.delegate ? 'DELEGATE' : 'SELF_EXECUTE';
  const reproduced = replayedOutcome === decision.outcome
    && (base.recordedScore === null || Math.abs(result.score - base.recordedScore) < 1e-9);

  return {
    ...base,
    replayable: true,
    reproduced,
    replayedOutcome,
    replayedScore: result.score,
    counterfactual: counterfactual({ ...decision.breakdown, score: result.score }),
    reason: reproduced
      ? 'the recorded inputs still produce the recorded decision'
      : `recorded ${decision.outcome} at ${base.recordedScore}, replays as ${replayedOutcome} at ${result.score}`,
  };
}

export interface NodeReplay {
  nodeId: string;
  total: number;
  replayable: number;
  reproduced: number;
  /** Every decision that ran and disagreed. The list worth reading. */
  diverged: DecisionReplay[];
  /** True when nothing that could be replayed disagreed. Vacuously true for a
   *  node that decided nothing — there is no claim to falsify. */
  allReproduced: boolean;
  decisions: DecisionReplay[];
}

export function replayNode(nodeId: string, decisions: ReplayableDecision[]): NodeReplay {
  const replays = decisions.map(replayDecision);
  const diverged = replays.filter((r) => r.replayable && !r.reproduced);
  return {
    nodeId,
    total: replays.length,
    replayable: replays.filter((r) => r.replayable).length,
    reproduced: replays.filter((r) => r.reproduced).length,
    diverged,
    allReproduced: diverged.length === 0,
    decisions: replays,
  };
}
