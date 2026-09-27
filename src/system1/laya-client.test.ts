import { describe, it, expect, vi } from 'vitest';
import { createHttpProvider } from './laya-client.js';
import { compileRequest, compileHarnessRequest } from './compiler.js';
import { ProviderFailure } from './provider.js';

const noul = (goal = 'g') => compileHarnessRequest({ surface: 'action.helpful', goal, stateVersion: 1, subject: 'run the tests' });
const choice = () => compileRequest({
  source: 'model', surface: 'model.request', primitive: 'choice', question: 'Which approach?',
  questionVersion: 'model@1', goal: 'g', stateVersion: 1,
  candidates: [{ id: 'B', action: '', description: 'add abstraction' }, { id: 'A', action: '', description: 'refactor' }],
});

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function provider(fetchImpl: typeof fetch, timeoutMs = 1_000) {
  return createHttpProvider({ name: 'laya', url: 'http://laya.test', apiKey: 'k', timeoutMs, model: 'typed-decisions', fetch: fetchImpl });
}

describe('HTTP System-1 provider', () => {
  it('answers one noul over the Jev wire protocol, with the checkpoint pinned', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      expect(body.model).toBe('typed-decisions');
      expect(body.questions.q0).toMatchObject({ type: 'noul' });
      expect((init!.headers as Record<string, string>).authorization).toBe('Bearer k');
      return reply({ answers: { q0: { type: 'noul', noul: 0.8, confidence: 0.8 } }, usage: { input_tokens: 90 }, routing: { model: 'typed-decisions' } });
    });
    const [j] = await provider(fetchImpl as unknown as typeof fetch).decide([noul()]);
    expect(j.result.probability).toBe(0.8);
    expect(j.metadata.model).toBe('typed-decisions');
    expect(j.metadata.inputTokens).toBe(90);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://laya.test/v1/systemone');
  });

  it('answers one choice with options keyed by their stable ids', async () => {
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const q = JSON.parse(String(init!.body)).questions.q0;
      expect(Object.keys(q.criteria)).toEqual(['A', 'B']);
      return reply({ answers: { q0: { type: 'choice', choice: 'A', probabilities: { A: 0.7, B: 0.3 }, confidence: 0.4 } } });
    });
    const [j] = await provider(fetchImpl as unknown as typeof fetch).decide([choice()]);
    expect(j.result.selectedId).toBe('A');
    expect(j.calibration.rawProbability).toBe(0.7);
  });

  it('batches independent questions about one state into one forward pass', async () => {
    const r1 = compileHarnessRequest({ surface: 'action.helpful', goal: 'g', stateVersion: 1, subject: 'validate' });
    const r2 = compileHarnessRequest({ surface: 'action.helpful', goal: 'g', stateVersion: 1, subject: 'narrow the search' });
    const other = noul('a different task');
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const n = Object.keys(JSON.parse(String(init!.body)).questions).length;
      return reply({ answers: Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, { noul: 0.1 * (i + 1), confidence: 0.5 }])) });
    });
    const out = await provider(fetchImpl as unknown as typeof fetch).decide([r1, other, r2]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out.map((j) => j.requestId)).toEqual([r1.id, other.id, r2.id]);
    expect(out[2].result.probability).toBeCloseTo(0.2);
  });

  it('reports a timeout as a timeout', async () => {
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => new Promise((_, reject) => {
      init!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' })));
    })) as unknown as typeof fetch;
    await expect(provider(fetchImpl, 20).decide([noul()])).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reports an HTTP failure, and a refused question as rejected', async () => {
    await expect(provider((async () => reply({}, 503)) as unknown as typeof fetch).decide([noul()])).rejects.toMatchObject({ kind: 'http' });
    await expect(provider((async () => reply({}, 422)) as unknown as typeof fetch).decide([noul()])).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('reports an unreachable server as unavailable', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(provider(fetchImpl).decide([noul()])).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('treats a malformed body, a missing answer or an extra answer as malformed', async () => {
    const bad = [
      new Response('not json', { status: 200 }),
      reply({ answers: {} }),
      reply({ answers: { q0: { noul: 0.4 }, q9: { noul: 0.1 } } }),
      reply({ answers: { q0: { noul: 'high' } } }),
    ];
    for (const res of bad) {
      const err = await provider((async () => res) as unknown as typeof fetch).decide([noul()]).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderFailure);
      expect(err.kind).toBe('malformed');
    }
  });

  it('refuses to guess an endpoint', async () => {
    const p = createHttpProvider({ name: 'jev', url: '', timeoutMs: 100 });
    await expect(p.decide([noul()])).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
