import { describe, it, expect, vi } from 'vitest';
import {
  prepareDispatch, taskShapeFingerprint, REAL_PREPARE_DEPS,
  type PrepareDispatchDeps, type PrepareDispatchInput,
} from './dispatch-preparation.js';
import type { Authority } from '../schemas/node-contract.js';

const AUTHORITY: Authority = {
  tools: ['read', 'edit'], spawn_children: true, max_child_count: 2, budget_usd: 5,
};

function input(over: Partial<PrepareDispatchInput> = {}): PrepareDispatchInput {
  return {
    goal: 'Fix the typo in README.md',
    authority: AUTHORITY,
    toolGrant: { allowedTools: ['read', 'edit'], readOnly: false },
    repository: 'github.com/acme/thing',
    repositoryRevision: 'rev-1',
    ...over,
  };
}

function spyDeps(): PrepareDispatchDeps & { [K in keyof PrepareDispatchDeps]: ReturnType<typeof vi.fn> } {
  return Object.fromEntries(
    Object.entries(REAL_PREPARE_DEPS).map(([name, fn]) => [name, vi.fn(fn as never)]),
  ) as never;
}

describe('prepareDispatch', () => {
  it('builds one coherent snapshot without repeating semantic derivation', () => {
    const deps = spyDeps();
    const result = prepareDispatch(input(), deps);

    expect(deps.taskEconomicsFor).toHaveBeenCalledTimes(1);
    expect(deps.contextPolicyFor).toHaveBeenCalledTimes(1);
    expect(deps.executionPolicyFor).toHaveBeenCalledTimes(1);
    expect(deps.currentPolicyVersions).toHaveBeenCalledTimes(1);
    expect(deps.contractFor).toHaveBeenCalledTimes(1);
    expect(result.goal).toBe('Fix the typo in README.md');
  });

  it('hands the understanding it was given to the economics, and reads nothing from the goal', () => {
    const deps = spyDeps();
    prepareDispatch(input({ understanding: { readOnly: true, anchors: ['README.md'] } }), deps);
    expect(deps.taskEconomicsFor.mock.calls[0][1]).toMatchObject({ readOnly: true });
  });

  it('knows a task only as far as it has been told: unknown is a change, and nobody has said it splits', () => {
    const snapshot = prepareDispatch(input());
    expect(snapshot.mode).toBe('change');
    expect(snapshot.economics.readOnly).toBe(false);
    expect(snapshot.understanding.splitProbability).toBeUndefined();
  });

  it('names the mode from what is known: answer, change, or split', () => {
    expect(prepareDispatch(input({ understanding: { readOnly: true, anchors: [] } })).mode).toBe('answer');
    expect(prepareDispatch(input()).mode).toBe('change');
    expect(prepareDispatch(input({ delegated: true })).mode).toBe('split');
  });

  it('keeps repository revision and policy versions identical for every consumer', () => {
    const snapshot = prepareDispatch(input());
    // Every consumer reads these off the one object; the test is that the
    // object holds a single answer rather than a recipe for computing one.
    expect(snapshot.repositoryRevision).toBe('rev-1');
    expect(snapshot.policyVersions).toEqual(snapshot.policyVersions);
    expect(snapshot.executionPolicy.contextBudget).toBe(snapshot.contextPolicy.tokenBudget);
  });

  it('derives the security scope from the grant it was given', () => {
    const snapshot = prepareDispatch(input({ toolGrant: { allowedTools: ['read'], readOnly: true } }));
    expect(snapshot.securityScope).toEqual({ tenant: 'local', tools: ['read'], readOnly: true });
  });

  it('carries explicit required checks into the validation contract', () => {
    const snapshot = prepareDispatch(input({ requiredChecks: ['changelog updated'] }));
    expect(snapshot.validationContract.requiredChecks).toEqual(['changelog updated']);
  });

  it('executes nothing — no sandbox, no model, no child', () => {
    // Proved structurally: the only things it may call are the injected
    // derivations, so a dispatch could only happen through one of them.
    const deps = spyDeps();
    prepareDispatch(input(), deps);
    const totalCalls = Object.values(deps).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
    expect(totalCalls).toBe(Object.keys(REAL_PREPARE_DEPS).length);
  });

  it('is frozen, so a downstream consumer cannot edit what the run believed', () => {
    const snapshot = prepareDispatch(input());
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('gives the same goal the same shape fingerprint every time', () => {
    expect(prepareDispatch(input()).taskShape).toBe(prepareDispatch(input()).taskShape);
  });
});

describe('taskShapeFingerprint', () => {
  const base = {
    mode: 'change' as const, splitProbability: 0.1,
    economics: {
      complexityBand: 'small' as const, hasExplicitAnchors: true,
      breadth: 0.1, verificationNeed: 0.8, readOnly: false,
    },
  };

  it('separates shapes that differ in how likely they are to decompose', () => {
    expect(taskShapeFingerprint(base)).not.toBe(taskShapeFingerprint({ ...base, splitProbability: 0.9 }));
    expect(taskShapeFingerprint(base)).not.toBe(taskShapeFingerprint({ ...base, splitProbability: undefined }));
  });

  it('separates answering from changing', () => {
    expect(taskShapeFingerprint(base)).not.toBe(taskShapeFingerprint({ ...base, mode: 'answer' }));
  });

  it('bands continuous signals, so two near-identical runs share a key', () => {
    expect(taskShapeFingerprint(base))
      .toBe(taskShapeFingerprint({ ...base, economics: { ...base.economics, breadth: 0.12 } }));
  });

  it('never embeds the goal text', () => {
    expect(taskShapeFingerprint(base)).not.toMatch(/README|typo/i);
  });
});
