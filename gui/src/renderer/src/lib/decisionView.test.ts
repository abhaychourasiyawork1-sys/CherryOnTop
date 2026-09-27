import { describe, it, expect } from 'vitest';
import { decisionsOf, keyDecisions, evidenceOf, confidenceOf, countByType } from './decisionView.js';

const row = (outcome: string, breakdown: Record<string, number> = {}, type = 'execution_decision') =>
  ({ id: outcome, nodeId: 'n', type, outcome, breakdown, createdAt: '2026-09-01T00:00:01Z' });

const receipt = (payload: unknown, id = 7) =>
  ({ id, nodeId: 'n', type: 'decision.receipt', payload, createdAt: '2026-09-01T00:00:02Z' });

describe('decision view', () => {
  it('says what was decided and why, concisely, from the record', () => {
    const [view] = decisionsOf([row('DELEGATE', { system1_asked: 1, system1_p_decomposable: 0.963, score: 0.6, threshold: 0.3 })], []);
    expect(view.title).toBe('Split the work across agents');
    expect(view.why).toBe('Judged 96% likely to split into independent pieces; scored 0.60 against a bar of 0.30.');
  });

  it('uses the engine’s own reason and alternatives from a receipt', () => {
    const [view] = decisionsOf([], [receipt({
      chosen: 'RUN_MODEL', reason: 'this is one unit of work', confidence: 0.5,
      alternatives: [{ type: 'SPAWN_AGENT', reason: 'split the goal across agents' }],
    })]);
    expect(view).toMatchObject({
      title: 'Do the work directly',
      why: 'This is one unit of work',
      alternatives: [{ label: 'Split the work across agents', reason: 'split the goal across agents' }],
      engineConfidence: 0.5,
    });
  });

  it('ignores malformed receipts and orders by time', () => {
    const views = decisionsOf([row('SELF_EXECUTE')], [receipt(null), receipt({ chosen: 'STOP' }, 8)]);
    expect(views.map((v) => v.title)).toEqual(['Do the work as one agent', 'Stop here']);
  });

  it('keeps routine runtime picks out of the default view', () => {
    const views = decisionsOf([row('claude-code', { successRate: 0.77, runs: 253 }, 'runtime_selection'), row('DELEGATE')], []);
    expect(keyDecisions(views).map((v) => v.title)).toEqual(['Split the work across agents']);
    expect(views[0].why).toBe('77% of 253 earlier runs succeeded with it.');
  });
});

describe('evidence', () => {
  const evidence = evidenceOf({
    artifacts: [
      { id: 'a1', nodeId: 'n', kind: 'file_edit', path: 'src/a.ts', summary: '' },
      { id: 'a2', nodeId: 'n', kind: 'command', path: null, summary: 'curl https://example.com' },
      { id: 'a3', nodeId: 'n', kind: 'result', path: null, summary: 'Done' },
    ],
    events: [
      { id: 1, nodeId: 'n', type: 'validation.result', payload: { level: 'V2', passed: true }, createdAt: '' },
      { id: 2, nodeId: 'n', type: 'system1.judgment', payload: { surface: 'execution.decomposable' }, createdAt: '' },
    ],
    approvals: [
      { id: 'p', nodeId: 'n', reason: 'more budget', status: 'approved', createdAt: '' },
      { id: 'q', nodeId: 'n', reason: 'pending', status: 'pending', createdAt: '' },
    ],
  });

  it('types evidence by provenance and keeps the source reference', () => {
    expect(countByType(evidence)).toEqual({ observed: 1, derived: 2, verified: 1, user: 1, external: 1 });
    expect(evidence[0]).toMatchObject({ summary: 'Edited src/a.ts', provenance: { kind: 'artifact', ref: 'a1' } });
  });

  it('never reports more confidence than the evidence supports', () => {
    expect(confidenceOf(0.95, [])).toBe('unverified');
    const unverified = evidence.filter((e) => e.type !== 'verified');
    expect(confidenceOf(0.95, unverified)).toBe('medium');
    expect(confidenceOf(0.95, evidence)).toBe('high');
    const failed = evidenceOf({ artifacts: [], events: [{ id: 3, nodeId: 'n', type: 'validation.result', payload: { level: 'V1', passed: false }, createdAt: '' }] });
    expect(confidenceOf(0.95, failed)).toBe('low');
  });
});
