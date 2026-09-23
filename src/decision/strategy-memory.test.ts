import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import { recordStrategyOutcome, getStrategyOutcomes } from '../db/queries/memory.js';
import { strategyPriorFor, strategyPriorsFor, learningKeysFor } from './strategy-memory.js';
import { prepareDispatch } from './dispatch-preparation.js';
import { observationFrom } from '../learning/hierarchical.js';
import type { Authority } from '../schemas/node-contract.js';

const TEST_DB = './test-strategy-memory.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const AUTHORITY: Authority = { tools: ['Read', 'Edit'], spawn_children: true, max_child_count: 2, budget_usd: 5 };

function snapshot(goal = 'Fix refreshSession in src/auth/session.ts') {
  return prepareDispatch({
    goal, authority: AUTHORITY, toolGrant: { allowedTools: AUTHORITY.tools, readOnly: false },
    repository: 'github.com/acme/thing', repositoryRevision: 'rev-1',
  });
}

function store(
  db: ReturnType<typeof createDb>, id: string,
  over: Partial<Parameters<typeof observationFrom>[0]> = {},
) {
  const prep = snapshot();
  recordStrategyOutcome(db, {
    id, nodeId: `n-${id}`, createdAt: 't0',
    observation: observationFrom({
      strategy: 'MANAGED', taskClass: prep.taskClass, taskShape: prep.taskShape,
      repository: prep.repository, exactPattern: `${prep.repository}@${prep.taskShape}`,
      validated: true, qualityDelta: 0.1, costUsd: 0.2, latencyMs: 60_000,
      recoveryCount: 0, validationLevel: 'V2', ...over,
    }),
  });
}

describe('learningKeysFor', () => {
  it('keys a task at every level it belongs to', () => {
    const keys = learningKeysFor(snapshot());
    expect(keys.GLOBAL).toBe('all');
    expect(keys.TASK_CLASS).toBeTruthy();
    expect(keys.TASK_SHAPE).toContain('/');
    expect(keys.REPOSITORY).toBe('github.com/acme/thing');
    expect(keys.EXACT_PATTERN).toContain('github.com/acme/thing@');
  });

  it('omits the repository levels when the task has no repository', () => {
    const keys = learningKeysFor(prepareDispatch({
      goal: 'Explain the retry policy', authority: AUTHORITY,
      toolGrant: { allowedTools: null, readOnly: true },
    }));
    expect(keys.REPOSITORY).toBeUndefined();
    expect(keys.EXACT_PATTERN).toBeUndefined();
  });

  it('never keys on raw goal text', () => {
    expect(JSON.stringify(learningKeysFor(snapshot()))).not.toContain('refreshSession');
  });
});

describe('strategyPriorFor', () => {
  it('returns the uninformed prior when nothing has been stored', () => {
    const db = createDb(TEST_DB);
    const prior = strategyPriorFor(db, { preparation: snapshot() });
    expect(prior.expectedSuccess).toBe(0.5);
    expect(prior.effectiveObservations).toBe(0);
  });

  it('reads back what was stored, at every level the run was keyed at', () => {
    const db = createDb(TEST_DB);
    store(db, '1');
    const prep = snapshot();
    expect(getStrategyOutcomes(db, 'GLOBAL', 'all')).toHaveLength(1);
    expect(getStrategyOutcomes(db, 'TASK_CLASS', prep.taskClass)).toHaveLength(1);
    expect(getStrategyOutcomes(db, 'REPOSITORY', 'github.com/acme/thing')).toHaveLength(1);
  });

  it('shrinks one stored run toward the uninformed prior rather than believing it', () => {
    const db = createDb(TEST_DB);
    store(db, '1');
    const prior = strategyPriorFor(db, { preparation: snapshot(), strategy: 'MANAGED' });
    // One run is a coin toss wearing a specific label. It moves the estimate,
    // and it does not decide it.
    expect(prior.expectedSuccess).toBeGreaterThan(0.5);
    expect(prior.expectedSuccess).toBeLessThan(0.75);
  });

  it('grows more confident as consistent evidence accumulates', () => {
    const db = createDb(TEST_DB);
    for (let i = 0; i < 20; i++) store(db, String(i));
    const prior = strategyPriorFor(db, { preparation: snapshot(), strategy: 'MANAGED' });
    expect(prior.expectedSuccess).toBeGreaterThan(0.9);
    expect(prior.effectiveObservations).toBeGreaterThan(20);
  });

  it('keeps one strategy\'s history out of another\'s prior', () => {
    const db = createDb(TEST_DB);
    for (let i = 0; i < 10; i++) store(db, `m${i}`, { strategy: 'MANAGED', validated: true });
    for (let i = 0; i < 10; i++) store(db, `d${i}`, { strategy: 'SERIAL_DELEGATED', validated: false });
    const priors = strategyPriorsFor(db, { preparation: snapshot() });
    expect(priors.MANAGED.expectedSuccess).toBeGreaterThan(priors.SERIAL_DELEGATED.expectedSuccess);
  });

  it('counts an invalid run and then leaves it out of the estimate', () => {
    const db = createDb(TEST_DB);
    store(db, '1', { validated: false, validity: 'INVALID_INFRA' });
    const prior = strategyPriorFor(db, { preparation: snapshot(), strategy: 'MANAGED' });
    expect(prior.census.excluded.INVALID_INFRA).toBeGreaterThan(0);
    expect(prior.expectedSuccess).toBe(0.5);
  });

  it('distinguishes a clean success from one that needed recovery', () => {
    const db = createDb(TEST_DB);
    store(db, '1', { recoveryCount: 0 });
    store(db, '2', { recoveryCount: 2 });
    const prior = strategyPriorFor(db, { preparation: snapshot(), strategy: 'MANAGED' });
    expect(prior.outcomes.SUCCESS).toBeGreaterThan(0);
    expect(prior.outcomes.SUCCESS_WITH_RECOVERY).toBeGreaterThan(0);
  });

  it('keeps the deterministic policy when the store cannot be read', () => {
    // A learning layer whose failure mode is "the runtime behaves as it always
    // did" is one worth having; one that can fail a dispatch is not.
    const broken = { select: () => { throw new Error('no database'); } } as never;
    expect(getStrategyOutcomes(broken, 'GLOBAL', 'all')).toEqual([]);
  });
});
