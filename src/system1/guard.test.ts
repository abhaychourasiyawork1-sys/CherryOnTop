import { describe, it, expect, vi } from 'vitest';
import { createSystem1 } from './guard.js';
import { ProviderFailure, type System1Provider } from './provider.js';
import { compileHarnessRequest } from './compiler.js';
import type { DecisionJudgment, DecisionRequest } from './types.js';

const request = (goal = 'g', stateVersion = 1) => compileHarnessRequest({ surface: 'action.helpful', goal, stateVersion, subject: 'validate' });

const answer = (r: DecisionRequest, p = 0.7): DecisionJudgment => ({
  requestId: r.id, provider: 'laya', surface: r.surface, primitive: r.primitive, result: { probability: p },
  calibration: { rawProbability: p, version: 'uncalibrated' }, confidence: { provider: 0.6, orchestration: 0 },
  metadata: { model: 'm', questionVersion: r.questionVersion, inputDigest: r.inputDigest, stateVersion: r.stateVersion, latencyMs: 1, inputTokens: 5 },
});

function fake(behaviour: (rs: readonly DecisionRequest[], call: number) => DecisionJudgment[] | Error): System1Provider & { decide: ReturnType<typeof vi.fn> } {
  let call = 0;
  return {
    name: 'laya',
    decide: vi.fn(async (rs: readonly DecisionRequest[]) => {
      const out = behaviour(rs, ++call);
      if (out instanceof Error) throw out;
      return out;
    }),
  };
}

const cfg = { maxCallsPerScope: 3, timeoutMs: 1_000 };

describe('System-1 guard', () => {
  it('deduplicates a repeated question: one provider call, then free replays', async () => {
    const p = fake((rs) => rs.map((r) => answer(r)));
    const s = createSystem1(p, cfg);
    const r = request();
    const [a, b] = await s.judge('n', [r, r], { orchestration: 0.5 });
    const [c] = await s.judge('n', [r], { orchestration: 0.5 });
    expect(p.decide).toHaveBeenCalledTimes(1);
    expect(p.decide.mock.calls[0][0]).toHaveLength(1);
    expect(a.judgment?.result.probability).toBe(0.7);
    expect(b.judgment?.result.probability).toBe(0.7);
    expect(c.cached).toBe(true);
    expect(s.usage('n').calls).toBe(1);
  });

  it('a retry spends from the same budget', async () => {
    const p = fake((rs, call) => (call === 1 ? new ProviderFailure('unavailable', 'down') : rs.map((r) => answer(r))));
    const s = createSystem1(p, cfg);
    const [o] = await s.judge('n', [request()], { orchestration: 0.5 });
    expect(o.judgment).toBeDefined();
    expect(o.attempts).toBe(2);
    expect(s.usage('n')).toEqual({ calls: 2, remaining: 1 });
  });

  it('does not retry a question the provider refused', async () => {
    const p = fake(() => new ProviderFailure('rejected', 'bad question'));
    const [o] = await createSystem1(p, cfg).judge('n', [request()], { orchestration: 0.5 });
    expect(o.failure?.kind).toBe('rejected');
    expect(p.decide).toHaveBeenCalledTimes(1);
  });

  it('refuses a judgment about a state that has moved on', async () => {
    const p = fake((rs) => rs.map((r) => answer(r)));
    const [o] = await createSystem1(p, cfg).judge('n', [request('g', 4)], { orchestration: 0.5, currentStateVersion: () => 5 });
    expect(o.judgment).toBeUndefined();
    expect(o.failure?.kind).toBe('stale');
  });

  it('refuses a judgment whose digest does not match the question', async () => {
    const p = fake((rs) => rs.map((r) => ({ ...answer(r), metadata: { ...answer(r).metadata, inputDigest: 'forged' } })));
    const [o] = await createSystem1(p, cfg).judge('n', [request()], { orchestration: 0.5 });
    expect(o.failure?.kind).toBe('malformed');
  });

  it('stops at the budget without calling the provider again', async () => {
    const p = fake(() => new ProviderFailure('timeout', 'slow'));
    const s = createSystem1(p, { maxCallsPerScope: 3, timeoutMs: 1_000 });
    await s.judge('n', [request('a')], { orchestration: 0.5 });
    const [o] = await s.judge('n', [request('b')], { orchestration: 0.5 });
    expect(o.failure?.kind).toBe('budget');
    expect(p.decide).toHaveBeenCalledTimes(3);
  });

  it('treats an out-of-range probability as a malformed answer, not something to clamp into a verdict', async () => {
    const p = fake((rs) => rs.map((r) => answer(r, 1.3)));
    const [o] = await createSystem1(p, cfg).judge('n', [request()], { orchestration: 0.5 });
    expect(o.failure?.kind).toBe('malformed');
  });

  it('with no provider, every question fails over deterministically', async () => {
    const [o] = await createSystem1(null, cfg).judge('n', [request()], { orchestration: 0.5 });
    expect(o.failure?.kind).toBe('disabled');
  });

  it('calibrates every judgment it hands back', async () => {
    const p = fake((rs) => rs.map((r) => answer(r, 0.7)));
    const [o] = await createSystem1(p, cfg).judge('n', [request()], { orchestration: 0.25 });
    expect(o.judgment?.calibration.calibratedProbability).toBe(0.7);
    expect(o.judgment?.calibration.version).toBe('identity@1');
    expect(o.judgment?.confidence.orchestration).toBe(0.25);
  });
});
