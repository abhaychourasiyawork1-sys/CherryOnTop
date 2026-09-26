/** System-1 end to end, deterministically: the real HTTP provider, guard,
 *  compiler, calibration, surfaces and receipts, against a local HTTP server
 *  that speaks `laya-serve`'s wire protocol (bearer auth, `/v1/systemone`,
 *  typed answers). No model, no cluster, no network beyond loopback. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpProvider } from './laya-client.js';
import { createSystem1, type System1 } from './guard.js';
import { assessDecomposability } from './decomposability.js';
import { createModelGateway } from './model-gateway.js';
import { buildReceipt } from './receipts.js';
import { refineWithSystem1 } from '../decision/system1-decision.js';
import { chooseEconomicAction } from '../decision/engine.js';
import { actionCandidate } from '../decision/actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from '../decision/state.js';
import { decideExecution } from '../engines/decide-execution.js';
import { compileHarnessRequest } from './compiler.js';
import { nextAfterValidation } from '../validation/engine.js';

type Behaviour = 'ok' | 'slow' | 'down';
let behaviour: Behaviour = 'ok';
let requests = 0;
let noul = 0.9;
let server: Server;
let url = '';
const KEY = 'test-key';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests++;
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401).end(); return; }
      if (behaviour === 'down') { res.writeHead(503).end(); return; }
      const { questions } = JSON.parse(body) as { questions: Record<string, { type: string; criteria?: Record<string, string> | string[] }> };
      const answers = Object.fromEntries(Object.entries(questions).map(([k, q]) => {
        if (q.type === 'noul') return [k, { type: 'noul', noul, confidence: Math.max(noul, 1 - noul) }];
        const ids = Array.isArray(q.criteria) ? q.criteria.map((_, i) => String(i)) : Object.keys(q.criteria ?? {});
        // The decomposability staffing choice answers with the configured
        // probability on "many"; any other choice prefers its last option.
        if (ids.includes('many')) {
          return [k, { type: 'choice', choice: noul >= 0.5 ? 'many' : 'one', probabilities: { many: noul, one: 1 - noul }, confidence: 0.5 }];
        }
        const last = ids[ids.length - 1];
        return [k, { type: 'choice', choice: last, probabilities: Object.fromEntries(ids.map((id) => [id, id === last ? 0.8 : 0.2 / (ids.length - 1)])), confidence: 0.5 }];
      }));
      const reply = () => res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ model: 'typed-decisions', answers, usage: { input_tokens: 120, output_tokens: 0 }, routing: { model: 'typed-decisions' } }));
      if (behaviour === 'slow') setTimeout(reply, 400); else reply();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function s1(opts: { timeoutMs?: number; maxCalls?: number } = {}): System1 {
  return createSystem1(
    createHttpProvider({ name: 'laya', url, apiKey: KEY, timeoutMs: opts.timeoutMs ?? 1_000, model: 'typed-decisions' }),
    { maxCallsPerScope: opts.maxCalls ?? 10, timeoutMs: opts.timeoutMs ?? 1_000 },
  );
}

const reset = (b: Behaviour = 'ok', p = 0.9) => { behaviour = b; noul = p; requests = 0; };
const authority = { budget_usd: 5, spawn_children: true, max_child_count: 4, tools: [] as string[] };
const AMBIGUOUS = 'Audit every module for dead code and also document the public services';

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'fix the parser', totalTokenBudget: 100_000, qualityFloor: 0.3 });
  return normalizeEconomicState({ ...base, trajectory: { ...base.trajectory, orchestrationConfidence: 0.8 }, ...over });
}

describe('System-1 integration', () => {
  it('successful model decision: compact answer, receipt with full provenance', async () => {
    reset();
    const gateway = createModelGateway({ system1: s1(), scope: 'n', goal: 'fix the parser', maxRequests: 3 });
    const reply = await gateway.handle([JSON.stringify({ type: 'choice', question: 'Lower risk?', options: [{ id: 'A', description: 'refactor' }, { id: 'B', description: 'rewrite' }] })]);
    expect(reply.message).toContain('[1] choice: B');
    const receipt = buildReceipt(reply.records[0].outcome!, { provider: 'laya', finalRuntimeAction: 'advice-returned-to-model' });
    expect(receipt).toMatchObject({
      source: 'model', surface: 'model.request', primitive: 'choice', provider: 'laya', model: 'typed-decisions',
      legalOptions: ['A', 'B'], selectedAction: 'B', calibrationVersion: 'identity@1', tokenCost: 120, fallback: false,
    });
    expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt);
  });

  it('Laya timeout: deterministic fallback inside the latency budget', async () => {
    reset('slow');
    const started = Date.now();
    const r = await assessDecomposability({ scope: 'n', goal: AMBIGUOUS, authority, existingChildren: 0 }, s1({ timeoutMs: 150 }));
    expect(Date.now() - started).toBeLessThan(400);
    expect(r.bundle.worthSplitting).toBe(false);
    expect(r.outcome?.failure?.kind).toBe('timeout');
  });

  it('stale judgment is refused, never applied', async () => {
    reset();
    const request = compileHarnessRequest({ surface: 'execution.decomposable', goal: AMBIGUOUS, stateVersion: 3 });
    const [o] = await s1().judge('n', [request], { orchestration: 0.5, currentStateVersion: () => 4 });
    expect(o.failure?.kind).toBe('stale');
    expect(o.judgment).toBeUndefined();
  });

  it('duplicate request: one provider call, replayed free', async () => {
    reset();
    const sys = s1();
    const frame = JSON.stringify({ type: 'noul', question: 'Is the cache safe to drop?' });
    const gateway = createModelGateway({ system1: sys, scope: 'n', goal: 'g', maxRequests: 3 });
    await gateway.handle([frame, frame]);
    await gateway.handle([frame]);
    expect(requests).toBe(1);
    expect(sys.usage('n').calls).toBe(1);
  });

  it('budget exhaustion: retries spend the same budget, then questions fail over', async () => {
    reset('down');
    const sys = s1({ maxCalls: 3 });
    await assessDecomposability({ scope: 'n', goal: AMBIGUOUS, authority, existingChildren: 0 }, sys);
    const second = await assessDecomposability({ scope: 'n', goal: `${AMBIGUOUS} again`, authority, existingChildren: 0 }, sys);
    expect(requests).toBe(3);
    expect(second.outcome?.failure?.kind).toBe('budget');
  });

  it('hard-stop short-circuit: no question reaches Laya', async () => {
    reset();
    const st = normalizeEconomicState({ ...state(), constraints: { qualityFloor: 0.3, hardStop: true } });
    const v = actionCandidate({ id: 'v', kind: 'validate', capability: 'c', confidence: 0.9, expectedQualityBenefit: 0.8, tokenCost: 100 });
    const r = await refineWithSystem1({ s1: s1(), scope: 'n', state: st, candidates: [v], decision: chooseEconomicAction({ state: st, candidates: [v] }) });
    expect(requests).toBe(0);
    expect(r.decision.action.kind).toBe('stop');
  });

  it('no-spawn short-circuit: no question reaches Laya', async () => {
    reset();
    await assessDecomposability({ scope: 'n', goal: AMBIGUOUS, authority: { ...authority, spawn_children: false }, existingChildren: 0 }, s1());
    expect(requests).toBe(0);
  });

  it('Choice/economics conflict: economics wins', async () => {
    reset('ok', 1);
    const st = state();
    const strong = actionCandidate({ id: 'deep:constrain', kind: 'constrain', capability: 'c', confidence: 0.9, expectedTokenBenefit: 20_000, tokenCost: 0 });
    const weak = actionCandidate({ id: 'deep:validate', kind: 'validate', capability: 'v', confidence: 0.9, expectedQualityBenefit: 0.1, tokenCost: 2_000 });
    const r = await refineWithSystem1({ s1: s1(), scope: 'n', state: st, candidates: [weak, strong], decision: chooseEconomicAction({ state: st, candidates: [weak, strong] }) });
    expect(r.decision.action.id).toBe('deep:constrain');
  });

  it('validation failure -> recovery: judged helpful only if it can change the action, and the gate is unchanged', async () => {
    reset('ok', 0);
    const st = state({ trajectory: { ...state().trajectory, failurePressure: 0.9, progress: 0.1 } });
    const recover = actionCandidate({ id: 'deep:recover', kind: 'recover', capability: 'r', confidence: 0.8, expectedProgress: 0.8, expectedTokenBenefit: 40_000, tokenCost: 5_000 });
    const before = chooseEconomicAction({ state: st, candidates: [recover] });
    expect(before.action.kind).toBe('recover');
    const r = await refineWithSystem1({ s1: s1(), scope: 'n', state: st, candidates: [recover], decision: before });
    expect(r.decision.action.kind).toBe('continue');
    // The lifecycle's recovery gate is untouched by any of this.
    expect(nextAfterValidation({ executionSucceeded: false, validation: { level: 'V2', passed: false, confidence: 0.8, tokens: 0, latencyMs: 0, evidenceIds: [], reasonCodes: [] }, executionAttempts: 1 })).toBe('RECOVER');
  });

  it('a live yes still has to clear deterministic economics', async () => {
    reset('ok', 0.9);
    const r = await assessDecomposability({ scope: 'n', goal: AMBIGUOUS, authority, existingChildren: 0 }, s1());
    expect(r.bundle.signals.system1_p_decomposable).toBeGreaterThan(0.9);
    expect(decideExecution({ goal: AMBIGUOUS, authority, complexity: r.bundle.complexity, worthSplitting: r.bundle.worthSplitting }).outcome).toBe('DELEGATE');
  });
});
