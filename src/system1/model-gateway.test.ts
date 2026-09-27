import { describe, it, expect, vi } from 'vitest';
import { createModelGateway } from './model-gateway.js';
import { createSystem1 } from './guard.js';
import type { System1Provider } from './provider.js';
import type { DecisionJudgment, DecisionRequest } from './types.js';

function provider(): System1Provider & { decide: ReturnType<typeof vi.fn> } {
  return {
    name: 'laya',
    decide: vi.fn(async (rs: readonly DecisionRequest[]) => rs.map((r): DecisionJudgment => ({
      requestId: r.id, provider: 'laya', surface: r.surface, primitive: r.primitive,
      result: r.primitive === 'choice'
        ? { selectedId: r.candidates[1].id, probabilities: Object.fromEntries(r.candidates.map((c, i) => [c.id, i === 1 ? 0.69 : 0.31])) }
        : r.primitive === 'score' ? { score: { value: 1.2, min: 0, max: r.candidates.length - 1 } } : { probability: 0.8 },
      calibration: { version: 'x' }, confidence: { provider: 0.5, orchestration: 0 },
      metadata: { model: 'typed-decisions', questionVersion: r.questionVersion, inputDigest: r.inputDigest, stateVersion: r.stateVersion, latencyMs: 3, inputTokens: 40 },
    }))),
  };
}

const body = (json: unknown) => JSON.stringify(json);
const choice = { type: 'choice', question: 'Which?', options: [{ id: 'A', description: 'refactor' }, { id: 'B', description: 'rewrite' }] };

function gateway(maxRequests = 4) {
  const p = provider();
  const g = createModelGateway({
    system1: createSystem1(p, { maxCallsPerScope: 10, timeoutMs: 1_000 }),
    scope: 'node-1', goal: 'fix the parser', maxRequests,
  });
  return { p, g };
}

describe('model decision gateway', () => {
  it('answers noul, choice and score in one batched provider call, compactly', async () => {
    const { p, g } = gateway();
    const reply = await g.handle([
      body({ type: 'noul', question: 'Is the cache safe to drop?' }),
      body(choice),
      body({ type: 'score', question: 'How risky?', levels: ['low', 'medium', 'high'] }),
    ]);
    expect(p.decide).toHaveBeenCalledTimes(1);
    expect(reply.message).toContain('[1] noul: yes-probability 0.80');
    expect(reply.message).toContain('[2] choice: B (A=0.31, B=0.69)');
    expect(reply.message).toContain('nearest: "medium"');
  });

  it('never exposes the provider, its endpoint or the audit record to the model', async () => {
    const { g } = gateway();
    const reply = await g.handle([body(choice)]);
    expect(reply.message).not.toMatch(/laya|jev|typed-decisions|http|digest|calibrat/i);
  });

  it('rejects malformed and unsupported frames without calling System-1', async () => {
    const { p, g } = gateway();
    const reply = await g.handle(['{bad', body({ type: 'vote', question: 'q' })]);
    expect(p.decide).not.toHaveBeenCalled();
    expect(reply.message).toMatch(/\[1\] rejected: .*JSON/);
    expect(reply.message).toMatch(/\[2\] rejected: unsupported/);
  });

  it('replays a repeated question free, without spending the allowance', async () => {
    const { p, g } = gateway(1);
    await g.handle([body(choice)]);
    const again = await g.handle([body(choice)]);
    expect(again.message).toContain('[1] choice: B');
    expect(p.decide).toHaveBeenCalledTimes(1);
    expect(g.used()).toBe(1);
  });

  it('bounds new questions per dispatch', async () => {
    const { g } = gateway(1);
    await g.handle([body(choice)]);
    const reply = await g.handle([body({ type: 'noul', question: 'Another new question?' })]);
    expect(reply.message).toMatch(/rejected: decision allowance/);
  });

  it('says so plainly when System-1 cannot answer', async () => {
    const g = createModelGateway({
      system1: createSystem1(null, { maxCallsPerScope: 1, timeoutMs: 10 }), scope: 'n', goal: 'g', maxRequests: 2,
    });
    const reply = await g.handle([body(choice)]);
    expect(reply.message).toContain('[1] unavailable: decide with your own judgment');
  });
});
