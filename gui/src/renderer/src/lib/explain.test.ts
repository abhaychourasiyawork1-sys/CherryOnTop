import { describe, it, expect } from 'vitest';
import { explainRun, stepsOf } from './explain.js';
import { node } from './fixtures.js';

const at = (s: number) => new Date(Date.parse('2026-09-01T00:00:00.000Z') + s * 1000).toISOString();
const ev = (id: number, nodeId: string, type: string, payload: unknown, s = id) => ({ id, nodeId, type, payload, createdAt: at(s) });

describe('explainRun', () => {
  // The run from 2026-09-27: it closed PR #4 and opened #5, then failed the check.
  const root = node({ id: 'r', state: 'FAILED', goal: 'Close PR #4 and raise a PR' });
  const events = [
    ev(1, 'r', 'decision.made', { outcome: 'SELF_EXECUTE' }),
    ev(2, 'r', 'step.outcome', { succeeded: true, message: 'Job completed successfully' }),
    ev(3, 'r', 'validation.result', { passed: false, level: 'V1', reasonCodes: ['V0:run_claimed_success', 'V1:durable_outcome_produced', 'V2:no_observed_verification', 'V3:no_verifier', 'below_required_confidence'] }),
  ];
  const artifacts = [
    { id: 'a', nodeId: 'r', kind: 'command', path: null, summary: 'gh pr view 4 --json state' },
    { id: 'b', nodeId: 'r', kind: 'command', path: null, summary: 'gh pr close 4 --comment "x" && gh pr create --base y --head z' },
  ];

  it('says the work finished and only the check failed, and why, in plain words', () => {
    const x = explainRun(root, [root], events, artifacts);
    expect(x.verdict).toBe('unverified');
    expect(x.why[0]).toMatch(/work finished, but the check afterwards could not confirm/);
    expect(x.why.join(' ')).toMatch(/No test, build or other check ran/);
    expect(x.why.join(' ')).not.toMatch(/V2|below_required/);
  });

  it('lists what it did even though it failed', () => {
    const x = explainRun(root, [root], events, artifacts);
    expect(x.did.join(' ')).toMatch(/gh pr close 4/);
    expect(x.did.join(' ')).toMatch(/gh pr create/);
  });

  it('names the agent whose step failed', () => {
    const child = node({ id: 'c', parentId: 'r', state: 'FAILED', goal: 'Fix src/auth/login.ts' });
    const x = explainRun(root, [root, child], [
      ev(1, 'c', 'step.outcome', { succeeded: false, message: 'Your Claude login expired.' }),
      ev(2, 'r', 'validation.result', { passed: false, reasonCodes: ['V0:no_success_claim', 'V1:no_durable_outcome'] }),
    ], []);
    expect(x.verdict).toBe('failed');
    expect(x.why[0]).toMatch(/login\.ts.*Claude login expired/);
    expect(x.did[0]).toMatch(/Split the work across 1 agent/);
    // The cause, not the check's echo of it.
    expect(x.why).toHaveLength(1);
  });
});

describe('stepsOf', () => {
  it('tells the run as decisions and checks, with times', () => {
    const root = node({ id: 'r', state: 'COMPLETE', createdAt: at(0) });
    const steps = stepsOf(root, [root], [
      ev(1, 'r', 'decision.made', { outcome: 'SELF_EXECUTE' }, 1),
      ev(2, 'r', 'decision.made', { type: 'runtime_select', outcome: 'claude-code', breakdown: { successRate: 0.76, runs: 261 } }, 2),
      ev(3, 'r', 'step.progress', { message: 'Starting a sandbox' }, 3),
      ev(4, 'r', 'step.progress', { message: 'Starting a sandbox' }, 4),
      ev(5, 'r', 'exec.assistant', {}, 5),
      ev(6, 'r', 'validation.result', { passed: true, level: 'V2' }, 70),
    ]);
    expect(steps.map((s) => s.text)).toEqual([
      'Decided to do it as one agent', 'Chose claude-code to do the work', 'Starting a sandbox', 'The result was checked and confirmed',
    ]);
    expect(steps[1].detail).toBe('76% success over 261 earlier runs');
    expect(steps.at(-1)!.tone).toBe('good');
  });
});
