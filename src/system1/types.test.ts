import { describe, it, expect } from 'vitest';
import { assertValidJudgment, assertValidRequest, type DecisionJudgment, type DecisionRequest } from './types.js';
import { compileRequest } from './compiler.js';

const choice = (options = [{ id: 'A', action: '', description: 'first' }, { id: 'B', action: '', description: 'second' }]) =>
  compileRequest({
    source: 'model', surface: 'model.request', primitive: 'choice', question: 'Which?',
    questionVersion: 'model@1', goal: 'g', candidates: options, stateVersion: 3,
  });

const judgment = (request: DecisionRequest, result: DecisionJudgment['result']): DecisionJudgment => ({
  requestId: request.id, provider: 'laya', surface: request.surface, primitive: request.primitive, result,
  calibration: { version: 'x' }, confidence: { provider: 0.5, orchestration: 0.5 },
  metadata: { model: 'm', questionVersion: request.questionVersion, inputDigest: request.inputDigest, stateVersion: 3, latencyMs: 1, inputTokens: 1 },
});

describe('DecisionRequest validation', () => {
  it('rejects an empty question', () => {
    expect(() => compileRequest({
      source: 'model', surface: 'model.request', primitive: 'noul', question: '   ',
      questionVersion: 'v', goal: 'g', stateVersion: 0,
    })).toThrow(/empty/);
  });

  it('rejects duplicate option ids', () => {
    expect(() => choice([{ id: 'A', action: '', description: 'x' }, { id: 'A', action: '', description: 'y' }])).toThrow(/duplicate/);
  });

  it('rejects an unknown primitive', () => {
    const r = { ...choice(), primitive: 'vote' } as unknown as DecisionRequest;
    expect(() => assertValidRequest(r)).toThrow(/unknown primitive/);
  });

  it('keeps stable ids and provenance', () => {
    const a = choice();
    const b = choice();
    expect(a.id).toBe(b.id);
    expect(a.inputDigest).toBe(b.inputDigest);
    expect(a.source).toBe('model');
    expect(a.stateVersion).toBe(3);
  });
});

describe('DecisionJudgment validation', () => {
  it('rejects non-finite probabilities', () => {
    const r = choice();
    expect(() => assertValidJudgment(judgment(r, { selectedId: 'A', probabilities: { A: Number.NaN, B: 0.5 } }), r)).toThrow();
    const n = compileRequest({ source: 'harness', surface: 'action.helpful', primitive: 'noul', question: 'q', questionVersion: 'v', goal: 'g', stateVersion: 3 });
    expect(() => assertValidJudgment(judgment(n, { probability: Number.POSITIVE_INFINITY }), n)).toThrow();
    expect(() => assertValidJudgment(judgment(n, { probability: 1.2 }), n)).toThrow();
  });

  it('rejects a choice of an option that was never offered', () => {
    const r = choice();
    expect(() => assertValidJudgment(judgment(r, { selectedId: 'Z', probabilities: { A: 0.5, B: 0.5 } }), r)).toThrow(/not offered/);
  });

  it('rejects an answer to a different request', () => {
    const r = choice();
    expect(() => assertValidJudgment({ ...judgment(r, { selectedId: 'A', probabilities: { A: 0.6, B: 0.4 } }), requestId: 'other' }, r)).toThrow();
  });
});
