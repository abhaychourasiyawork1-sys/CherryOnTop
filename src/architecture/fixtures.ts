/** Task shapes this repository has never seen, and the states they produce.
 *
 *  The point of every fixture here is that **nothing in the runtime knows about
 *  it**. No handler is registered, no recipe is written, no branch mentions it.
 *  If the decision layer can still produce sensible options for a task nobody
 *  anticipated, the architecture is generic; if it needs a new case first, it is
 *  a pathway registry with a different shape.
 *
 *  So the goals are deliberately unlike the benchmark's — no "fix the bug", no
 *  "add a test" — and the fixtures assert nothing themselves. They exist to be
 *  handed to the real modules by `invariants.test.ts`. */
import { initialEconomicState, normalizeEconomicState, type EconomicState } from '../decision/state.js';

/** Goals from task families the runtime has no notion of. */
export const NOVEL_GOALS = [
  'Translate the German comments in the i18n bundle into English',
  'Work out why the Helm chart renders two ingresses on staging and one on prod',
  'Produce a dependency licence inventory grouped by SPDX identifier',
  'Reconcile the OpenAPI spec against what the handlers actually return',
  'Decide whether the retry backoff should be jittered, and say why',
] as const;

export interface FixtureOverrides {
  goal?: string;
  totalTokenBudget?: number;
  over?: Partial<EconomicState>;
}

export function novelState(input: FixtureOverrides = {}): EconomicState {
  const base = initialEconomicState({
    goal: input.goal ?? NOVEL_GOALS[0],
    totalTokenBudget: input.totalTokenBudget ?? 100_000,
    repository: 'github.com/acme/unfamiliar',
    repositoryRevision: 'rev-1',
    qualityFloor: 0.7,
  });
  return normalizeEconomicState({
    ...base,
    trajectory: { ...base.trajectory, orchestrationConfidence: 0.8 },
    ...input.over,
  });
}

/** A run doing a great deal of looking and learning a great deal from it.
 *
 *  The fixture that any "is the agent stuck?" heuristic gets wrong. An
 *  investigation doing its job searches *more* than one that is lost, and every
 *  count-based detector therefore flags exactly the run it should leave alone. */
export function productiveExploration(goal: string = NOVEL_GOALS[1]): EconomicState {
  return novelState({
    goal,
    over: {
      evidence: Array.from({ length: 12 }, (_, i) => ({
        id: `observed:finding-${i}`, kind: 'observation' as const,
        source: `grep:thing-${i}`, confidence: 0.7,
      })),
      uncertainty: { target: 0.2, structural: 0.2, behavioral: 0.4, validation: 0.5 },
      trajectory: {
        // Almost everything it has done is looking...
        progress: 0.35, explorationPressure: 0.9,
        // ...and it is learning as fast as it looks.
        informationGain: 0.85, stateSimilarity: 0.8,
        failurePressure: 0, orchestrationConfidence: 0.8,
      },
    },
  });
}

/** The same amount of looking, learning nothing. */
export function unproductiveExploration(goal: string = NOVEL_GOALS[1]): EconomicState {
  return novelState({
    goal,
    over: {
      evidence: [{ id: 'observed:one-thing', kind: 'observation', source: 'grep', confidence: 0.4 }],
      uncertainty: { target: 0.8, structural: 0.8, behavioral: 0.8, validation: 0.8 },
      trajectory: {
        progress: 0.05, explorationPressure: 0.9,
        informationGain: 0.02, stateSimilarity: 0.95,
        failurePressure: 0.2, orchestrationConfidence: 0.8,
      },
    },
  });
}

/** Two states that differ only in what there is to *do*, not in what the task
 *  is called. Anything that allocates from a task label gives them the same
 *  answer; anything that allocates from opportunity does not. */
export function sameLabelDifferentOpportunity(): { early: EconomicState; late: EconomicState } {
  const goal = NOVEL_GOALS[2];
  return {
    early: novelState({
      goal,
      over: {
        uncertainty: { target: 0.9, structural: 0.9, behavioral: 0.5, validation: 0.3 },
        trajectory: {
          progress: 0.05, informationGain: 0.1, explorationPressure: 0.7,
          failurePressure: 0, stateSimilarity: 0.1, orchestrationConfidence: 0.8,
        },
      },
    }),
    late: novelState({
      goal,
      over: {
        evidence: [
          { id: 'observed:src/a.ts', kind: 'fact', source: 'read', confidence: 0.9 },
          { id: 'observed:src/b.ts', kind: 'fact', source: 'read', confidence: 0.9 },
        ],
        uncertainty: { target: 0.1, structural: 0.1, behavioral: 0.2, validation: 0.9 },
        trajectory: {
          progress: 0.85, informationGain: 0.6, explorationPressure: 0.2,
          failurePressure: 0, stateSimilarity: 0.2, orchestrationConfidence: 0.8,
        },
        validation: { required: true, confidence: 0, status: 'unknown' },
      },
    }),
  };
}
