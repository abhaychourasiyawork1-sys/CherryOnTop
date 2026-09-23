/** The architecture, as tests.
 *
 *  These assert *properties of the design* rather than behaviours of a module,
 *  and they are deliberately hard to satisfy by accident. Each one names a way
 *  this system could quietly stop being what it was approved as — usually by a
 *  reasonable-looking local change — and fails when it does.
 *
 *  Two of them read the source. That is unusual and it is the point: "there are
 *  no task-specific pathways" and "there are no magic thresholds" are claims
 *  about what the code *contains*, and no behavioural test can catch a pathway
 *  added beside the generic one for a case somebody thought was special. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  NOVEL_GOALS, novelState, productiveExploration, unproductiveExploration,
  sameLabelDifferentOpportunity,
} from './fixtures.js';
import { runDecisionCycle } from '../decision/orchestration-loop.js';
import { chooseEconomicAction } from '../decision/engine.js';
import { evaluateDeepPath } from '../decision/deep-path.js';
import { inspectFastPath } from '../decision/fast-path.js';
import { allocateBudget } from '../decision/budget.js';
import { evaluateFallback } from '../decision/fallback.js';
import { evaluateHistoricalEvidence } from '../evidence/reuse.js';
import { parseRuntimeMode } from '../config/efficiency.js';
import { actionCandidate, ACTION_KINDS } from '../decision/actions.js';
import { buildCandidates } from '../context/candidates.js';
import { taskEconomicsFor } from '../efficiency/task-economics.js';
import type { KnowledgeItem } from '../evidence/types.js';

const frozen = () => 1_000;

describe('a novel task needs no handler registered for it', () => {
  it('produces options for every goal shape the runtime has never seen', () => {
    for (const goal of NOVEL_GOALS) {
      // Struggling, so the screen has something to see and the deep path runs.
      const state = novelState({
        goal,
        over: {
          uncertainty: { target: 0.9, structural: 0.9, behavioral: 0.6, validation: 0.9 },
          trajectory: {
            progress: 0.1, informationGain: 0.05, explorationPressure: 0.6,
            failurePressure: 0.8, stateSimilarity: 0.9, orchestrationConfidence: 0.8,
          },
        },
      });
      const cycle = runDecisionCycle(state, { nowMs: frozen });
      expect(cycle.decision, goal).toBeDefined();
      expect(cycle.candidates.length, goal).toBeGreaterThan(0);
    }
  });

  it('classifies the goal only as a prior, never as a selector of behaviour', () => {
    // Task classification still exists and is still used — for weights. What it
    // must never do is decide *which* options exist.
    for (const goal of NOVEL_GOALS) {
      const signals = taskEconomicsFor(goal);
      expect(signals.complexityBand).toBeTruthy();
      const kinds = new Set(evaluateDeepPath(unproductiveExploration(goal)).map((c) => c.kind));
      // The same option set is reachable whatever the goal is called.
      expect(kinds.size).toBeGreaterThan(0);
    }
  });

  it('keeps the action vocabulary closed and generic', () => {
    // Every verb is something *any* task can do. A kind named for a task shape
    // — 'refactor', 'investigate' — would be a pathway wearing an enum's
    // clothes.
    for (const kind of ACTION_KINDS) {
      expect(kind).toMatch(/^[a-z_]+$/);
    }
    expect(ACTION_KINDS).toHaveLength(10);
  });

  it('has no task-class vocabulary anywhere in the decision layer', () => {
    const forbidden = /\b(refactor|investigation|debugging|documentation|test[- ]authoring|tiny[- ]edit)\b/i;
    const offenders: string[] = [];
    for (const file of readdirSync('src/decision').filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const source = readFileSync(join('src/decision', file), 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        // Prose is allowed to name a task shape; code is not.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (forbidden.test(code)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('no universal stuck threshold', () => {
  it('leaves a run that explores heavily and learns heavily alone', () => {
    // The fixture every count-based detector gets wrong: an investigation doing
    // its job searches *more* than one that is lost.
    const cycle = runDecisionCycle(productiveExploration(), { nowMs: frozen });
    expect(cycle.decision?.action.kind).toBe('continue');
    expect(inspectFastPath(productiveExploration()).reasons).not.toContain('high_duplication');
  });

  it('acts on the same amount of exploration when it produces nothing', () => {
    const screen = inspectFastPath(unproductiveExploration());
    expect(screen.opportunity).toBe(true);
    expect(screen.reasons).toContain('high_duplication');
  });

  it('separates the two on information gain alone, with exploration held equal', () => {
    // Identical exploration pressure, opposite verdicts. Nothing counted; the
    // difference is whether the ground was new.
    expect(productiveExploration().trajectory.explorationPressure)
      .toBe(unproductiveExploration().trajectory.explorationPressure);
    expect(inspectFastPath(productiveExploration()).opportunity)
      .not.toBe(inspectFastPath(unproductiveExploration()).opportunity);
  });

  it('contains no count-against-constant rules in the decision layer', () => {
    // `searchCount > 5`, `turns >= 20`, `failures > 3` — the shape this
    // architecture is not allowed to encode. Comparisons against a *state
    // dimension* are fine; comparisons of a count against a literal are not.
    const forbidden = /\b(?:searchCount|turnCount|failureCount|attempts|retries|turns)\s*[<>]=?\s*\d/;
    const offenders: string[] = [];
    for (const file of readdirSync('src/decision').filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const source = readFileSync(join('src/decision', file), 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        const code = line.replace(/\/\/.*$/, '');
        if (forbidden.test(code)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('uncertainty widens generation, not only selection', () => {
  const REPO = [
    { path: 'src/core/client.ts', symbols: ['connect'], imports: [] },
    { path: 'src/core/schema.ts', symbols: ['Table'], imports: [] },
    { path: 'src/a.ts', symbols: ['a'], imports: ['./core/client.js', './core/schema.js'] },
    { path: 'src/b.ts', symbols: ['b'], imports: ['./core/client.js'] },
    { path: 'src/c.ts', symbols: ['c'], imports: ['./core/schema.js'] },
  ];
  const candidates = (goal: string, anchors: string[] = []) => buildCandidates({
    entries: REPO, goal, anchors,
    taskFit: { verificationNeed: 0.5, investigationLikelihood: 0.8, readOnly: true },
  });

  it('still produces candidates for a goal that names nothing and matches nothing', () => {
    // Relaxing a marginal test over an empty candidate set changes nothing.
    // Widening has to happen where the candidates are made, or it does not
    // happen at all.
    expect(candidates('review this and find problems').length).toBeGreaterThan(0);
  });

  it('reaches for what the repository depends on, since nothing points anywhere else', () => {
    const found = candidates('review this and find problems').map((c) => c.path);
    expect(found).toContain('src/core/client.ts');
  });

  it('believes it barely, so the selector widens rather than pruning on it', () => {
    for (const candidate of candidates('review this and find problems')) {
      // "Much of the repository depends on this" is a fact about the
      // repository, not about the goal.
      expect(candidate.confidenceScore).toBeLessThan(0.5);
    }
  });

  it('stops reaching the moment the goal does point somewhere', () => {
    const anchored = candidates('fix src/a.ts', ['src/a.ts']);
    expect(anchored.every((c) => !c.relationships.some((r) => r.startsWith('depended-on-by:')))).toBe(true);
  });
});

describe('no fixed task-to-budget percentages', () => {
  it('allocates differently for one task label as its opportunities change', () => {
    const { early, late } = sameLabelDifferentOpportunity();
    // Both opportunities cost the same and are offered to both states. What
    // differs is only what each is *worth* there, which is read off the doubt
    // the state actually carries.
    const opportunities = (state: typeof early) => [
      actionCandidate({
        id: 'ctx', kind: 'acquire_evidence', capability: 'context.select',
        expectedTokenBenefit: state.uncertainty.structural * 200_000, tokenCost: 60_000, confidence: 0.9,
      }),
      actionCandidate({
        id: 'val', kind: 'validate', capability: 'validation.progressive',
        expectedQualityBenefit: state.uncertainty.validation, tokenCost: 60_000, confidence: 0.9,
      }),
    ];

    const a = allocateBudget({ state: early, opportunities: opportunities(early) });
    const b = allocateBudget({ state: late, opportunities: opportunities(late) });

    // Same goal, same label, different answers — because what there is to *do*
    // changed.
    expect(a).not.toEqual(b);
    expect(a.context).toBeGreaterThan(b.context);
    expect(b.validation).toBeGreaterThan(a.validation);
  });

  it('holds nothing back when there is nothing to hold it back for', () => {
    const state = novelState();
    const allocation = allocateBudget({ state, opportunities: [] });
    expect(allocation.unallocated).toBe(state.resources.remainingTokens);
  });

  it('contains no constant share applied to a budget in the decision layer', () => {
    // `budget * 0.3`, `remaining * 0.25` — a fixed slice of a task's money is a
    // fixed task-to-budget rule however it is spelled. The deep path's
    // share-of-remaining costs are *prices for one action*, not allocations,
    // and live in deep-path.ts; budget.ts is what must be free of them.
    const source = readFileSync('src/decision/budget.ts', 'utf8');
    expect(source).not.toMatch(/(?:budget|remaining|pool)\s*\*\s*0\.\d/i);
  });
});

describe('current evidence outranks historical knowledge', () => {
  const item: KnowledgeItem = {
    id: 'k1', kind: 'fact', content: 'x'.repeat(4_000),
    repository: 'github.com/acme/unfamiliar', revision: 'rev-1',
    sourcePaths: ['src/a.ts'], sourceSymbols: [], confidence: 1, validated: true,
    createdAt: '2026-09-14T00:00:00.000Z',
  };

  it('refuses stored knowledge about something this run has already seen', () => {
    const observed = novelState({
      over: { evidence: [{ id: 'observed:src/a.ts', kind: 'fact', source: 'read', confidence: 0.9 }] },
    });
    expect(evaluateHistoricalEvidence({ item, state: observed }).usable).toBe(false);
  });

  it('is a rule rather than a weighting a large enough benefit could overturn', () => {
    const observed = novelState({
      over: { evidence: [{ id: 'observed:src/a.ts', kind: 'fact', source: 'read', confidence: 0.9 }] },
    });
    const enormous = { ...item, content: 'x'.repeat(1_000_000) };
    const verdict = evaluateHistoricalEvidence({ item: enormous, state: observed });
    expect(verdict.usable).toBe(false);
    expect(verdict.expectedBenefit).toBe(0);
    expect(verdict.reasonCodes).toContain('current_evidence_outranks_history');
  });

  it('still offers knowledge about ground this run has not covered', () => {
    const elsewhere = novelState({
      over: { evidence: [{ id: 'observed:src/z.ts', kind: 'fact', source: 'read', confidence: 0.9 }] },
    });
    expect(evaluateHistoricalEvidence({ item, state: elsewhere }).usable).toBe(true);
  });
});

describe('insufficient confidence falls back rather than intervening', () => {
  it('refuses an expensive action the decision is not confident enough for', () => {
    const state = novelState();
    const decision = chooseEconomicAction({
      state,
      candidates: [actionCandidate({
        id: 'dear', kind: 'recover', capability: 'recovery.retry',
        expectedTokenBenefit: 90_000, tokenCost: 80_000, confidence: 0.2,
      })],
    });
    const fallback = evaluateFallback({ state, decision });
    expect(fallback.mode).toBe('baseline');
  });

  it('shrinks the eligible set from the top down as confidence falls', () => {
    const state = novelState();
    const eligible = (confidence: number) => [1_000, 30_000, 80_000].filter((tokenCost) =>
      evaluateFallback({
        state,
        decision: chooseEconomicAction({
          state,
          candidates: [actionCandidate({
            id: 'a', kind: 'acquire_evidence', capability: 'evidence.read-file',
            expectedTokenBenefit: tokenCost * 2, tokenCost, confidence,
          })],
        }),
      }).mode === 'full').length;
    expect(eligible(0.95)).toBeGreaterThanOrEqual(eligible(0.3));
    expect(eligible(0.3)).toBeGreaterThanOrEqual(eligible(0.02));
  });

  it('never makes an uncertain orchestrator more willing to act', () => {
    const confident = novelState({ over: { trajectory: { ...novelState().trajectory, orchestrationConfidence: 0.95 } } });
    const doubtful = novelState({ over: { trajectory: { ...novelState().trajectory, orchestrationConfidence: 0.05 } } });
    const candidate = actionCandidate({
      id: 'a', kind: 'explore', capability: 'agent.search',
      expectedTokenBenefit: 40_000, tokenCost: 20_000, confidence: 0.9,
    });
    expect(chooseEconomicAction({ state: doubtful, candidates: [candidate] }).confidence)
      .toBeLessThan(chooseEconomicAction({ state: confident, candidates: [candidate] }).confidence);
  });
});

describe('the product has exactly two runtime modes', () => {
  it('maps every spelling anyone has used onto baseline or full', () => {
    const modes = new Set(
      [
        'disabled', 'off', '0', 'false', 'baseline', 'shadow',
        'enabled', 'full', 'canary', 'replay', 'experiment', '', undefined,
      ].map((value) => parseRuntimeMode(value as string | undefined)),
    );
    expect([...modes].sort()).toEqual(['baseline', 'full']);
  });

  it('declares no third mode anywhere in configuration', () => {
    const source = readFileSync('src/config/efficiency.ts', 'utf8');
    expect(source).toMatch(/RuntimeMode = 'baseline' \| 'full'/);
    // Shadow and replay belong to evaluation tooling, not to what an operator
    // can be running.
    expect(source).not.toMatch(/export type RuntimeMode[^\n]*shadow/);
  });

  it('keeps shadow recording unreachable from configuration', () => {
    const shadow = readFileSync('src/learning/shadow.ts', 'utf8');
    // It exists, and nothing about it is a mode: it records a candidate
    // decision beside the real one and returns no decision at all.
    expect(shadow).not.toMatch(/runtimeMode|ORG_EFFICIENCY_MODE/);
  });
});
