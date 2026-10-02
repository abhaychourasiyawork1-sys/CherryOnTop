// H2.6 (bench/governor/h26/DESIGN.md): assignment, masking, persistence.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { insertNode } from '../db/queries/nodes.js';
import { appendEvent, listEventsForNode } from '../db/queries/events.js';
import { recordDispatchUsage } from '../db/queries/tokens.js';
import { createRequire } from 'node:module';
import { openLedger, type Ledger } from './ledger.js';
import { actionCandidate, type ActionCandidate } from '../decision/actions.js';
import { chooseEconomicAction, type UnmaskedMenu } from '../decision/engine.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from '../decision/state.js';
import { compose } from '../governor/contracts.js';
import { evaluateBoundary, forgetNode } from '../lifecycle/economic-runtime.js';
import {
  __resetForTests, assign, boundaryMask, canonicalJson, carriesRecover, eligibilityFailure, H26, parseConfig, snapshotDigest, wouldSelect,
  type ActiveExperiment, type BoundaryFacts,
} from './recover-eligibility.js';

const DB = './test-h26.db';
const LEDGER = './test-h26-ledger.db';
const opened: Ledger[] = [];
afterEach(() => {
  for (const l of opened.splice(0)) l.close();
  __resetForTests();
  for (const f of [DB, LEDGER]) for (const s of ['', '-journal', '-wal', '-shm']) if (existsSync(f + s)) unlinkSync(f + s);
});
const ledger = (): Ledger => { const l = openLedger(LEDGER); opened.push(l); return l; };
/** The ledger file through a second, raw connection (what an operator could do). */
function rawLedger<T>(run: (d: { prepare(q: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown }; exec(q: string): void; transaction(f: () => void): () => void }) => T): T {
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const d = new Database(LEDGER);
  try { return run(d); } finally { d.close(); }
}
const assignments = (): number => (existsSync(LEDGER) ? rawLedger((d) => (d.prepare("select count(*) n from sqlite_master where name = 'assignments'").get() as { n: number }).n && (d.prepare('select count(*) n from assignments').get() as { n: number }).n) : 0);
const KEY = Buffer.from('11'.repeat(32), 'hex');

const HEX = (c: string) => c.repeat(64);
function experiment(over: Partial<{ phase: 'pilot' | 'main'; integrityOk: boolean; buildFingerprint: string; ledger: Ledger }> = {}): ActiveExperiment {
  const config = parseConfig({
    experimentId: `test-${randomUUID()}`, phase: over.phase ?? 'pilot', epsilon: 0.5,
    hmacPrefix: H26.hmacPrefix, keyCommitment: null, nMax: 3035, cMask: 3400,
  });
  return {
    config, ledger: over.ledger ?? ledger(), key: () => KEY,
    integrity: () => (over.integrityOk === false
      ? { ok: false, check: 'clean-tree', detail: 'dirty' }
      : { ok: true, commit: 'c0ffee', fingerprints: { configSha256: HEX('a'), lockfileSha256: HEX('b'), installedTreeSha256: HEX('c'), buildFingerprint: over.buildFingerprint ?? HEX('d'), keyCommitment: HEX('e') } }),
  };
}

function boundaryState(over: Partial<EconomicState> = {}): EconomicState {
  return normalizeEconomicState({
    ...initialEconomicState({ goal: 'g', totalTokenBudget: 400_000, validationRequired: true }),
    version: 12,
    uncertainty: { target: 0.4, structural: 0.4, behavioral: 0.4, validation: 0.6 },
    trajectory: { progress: 0.2, informationGain: 0, explorationPressure: 0.2, failurePressure: 0.6, stateSimilarity: 0.5, orchestrationConfidence: 0.6 },
    validation: { required: true, confidence: 1, status: 'failed' },
    ...over,
  });
}
const recover = actionCandidate({ id: 'recovery:retry', kind: 'recover', capability: 'recovery', tokenCost: 100, expectedTokenBenefit: 80_000, expectedProgress: 0.5, confidence: 1, metadata: { failureSignature: 'Bash#npm test#boom' } });
const deepRecover = actionCandidate({ id: 'deep:recover', kind: 'recover', capability: 'recovery', tokenCost: 200, expectedTokenBenefit: 1_000, confidence: 0.5 });
const read = actionCandidate({ id: 'evidence:a', kind: 'acquire_evidence', capability: 'evidence.read-file', tokenCost: 100, expectedTokenBenefit: 3_000, confidence: 1, metadata: { path: 'a.ts' } });

/** The real market's unmasked priced menu for these candidates. */
function menuOf(state: EconomicState, candidates: ActionCandidate[]): UnmaskedMenu {
  let menu: UnmaskedMenu | null = null;
  chooseEconomicAction({ state, candidates, experimentMask: (m) => { menu = m; return null; } });
  return menu!;
}

function facts(db: ReturnType<typeof createDb>, over: Partial<BoundaryFacts> = {}): BoundaryFacts {
  return {
    db, nodeId: 'node-1', rootTaskId: 'task-1', state: boundaryState(), completedDispatches: 1,
    failureSignature: 'Bash#npm test#boom', turnsUsed: 60, spendHardStop: false, ...over,
  };
}
const rows = (db: ReturnType<typeof createDb>, type: string) =>
  db.all<{ type: string; payload: string }>(sql`select type, payload from events where type = ${type}`).map((r) => JSON.parse(r.payload));

// ---------------------------------------------------------------------------

describe('the coin', () => {
  it('is deterministic HMAC-SHA256 over prefix ‖ 0x00 ‖ τ, first 8 bytes big-endian', () => {
    const a = assign(KEY, 'task-1'); const b = assign(KEY, 'task-1');
    expect(a).toEqual(b);
    expect(a.message).toBe(Buffer.concat([Buffer.from(H26.hmacPrefix), Buffer.from([0]), Buffer.from('task-1')]).toString('hex'));
    expect(a.z).toBe(a.u < 0.5 ? 'masked' : 'available');
    expect(Number(BigInt(a.u64)) / 2 ** 64).toBe(a.u);
  });

  it('ε is exactly 0.5 and a config with any other value is refused', () => {
    expect(H26.epsilon).toBe(0.5);
    expect(() => parseConfig({ experimentId: 'x', phase: 'main', epsilon: 0.4, hmacPrefix: H26.hmacPrefix, keyCommitment: null, nMax: 3035, cMask: 3400 })).toThrow();
    expect(() => parseConfig({ experimentId: 'x', phase: 'main', epsilon: 0.5, hmacPrefix: H26.hmacPrefix, keyCommitment: null, nMax: 3000, cMask: 3400 })).toThrow();
  });

  it('assigns independent task ids about half and half, and depends on the key', () => {
    const n = 20_000;
    let masked = 0;
    for (let i = 0; i < n; i++) if (assign(KEY, `task-${i}`).z === 'masked') masked++;
    // 99.99 % binomial interval for p = 0.5.
    expect(Math.abs(masked - n / 2)).toBeLessThan(4 * Math.sqrt(n) / 2 * 1.4);
    const other = Buffer.from('22'.repeat(32), 'hex');
    let differ = 0;
    for (let i = 0; i < 200; i++) if (assign(KEY, `t${i}`).z !== assign(other, `t${i}`).z) differ++;
    expect(differ).toBeGreaterThan(60);
  });
});

describe('the unmasked snapshot', () => {
  it('canonical JSON ignores key order; the digest is stable', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
    const s = boundaryState();
    expect(snapshotDigest(menuOf(s, [recover, read]))).toBe(snapshotDigest(menuOf(s, [read, recover])));
  });

  it('W, rank and margin come from the unmasked market order', () => {
    const s = boundaryState();
    const m = menuOf(s, [recover, read]);
    const sel = wouldSelect(m);
    const unmasked = chooseEconomicAction({ state: s, candidates: [recover, read] });
    expect(sel.W).toBe(carriesRecover(unmasked.action));
    expect(sel.rank).toBeGreaterThanOrEqual(1);
    expect(sel.marginUsd).not.toBeNull();
  });

  it('recover inside a composite is still recover', () => {
    const adv = actionCandidate({ id: 'dormant:x', kind: 'acquire_evidence', capability: 'c', metadata: { advice: 'look' } });
    expect(carriesRecover(compose(recover, adv, 'SEQ'))).toBe(true);
    expect(carriesRecover(read)).toBe(false);
  });
});

describe('§5 eligibility rules', () => {
  const db = () => createDb(DB);
  it('an eligible retry boundary passes', () => {
    expect(eligibilityFailure(facts(db()), menuOf(boundaryState(), [recover, read]))).toBeNull();
  });
  const cases: Array<[string, Partial<BoundaryFacts>, (s: EconomicState) => EconomicState, ActionCandidate[]]> = [
    ['intervention-eligible', {}, (s) => ({ ...s, trajectory: { ...s.trajectory, orchestrationConfidence: 0 } }), [recover]],
    ['a-real-retry', { completedDispatches: 0 }, (s) => s, [recover]],
    ['a-real-retry', { failureSignature: null }, (s) => s, [recover]],
    ['a-real-retry', {}, (s) => s, [deepRecover]],
    ['never-under-a-hard-stop', { spendHardStop: true }, (s) => s, [recover]],
    ['never-in-an-irreversible-state', {}, (s) => ({ ...s, trajectory: { ...s.trajectory, progress: 0.9 }, validation: { required: true, confidence: 0, status: 'failed' } }), [recover]],
  ];
  for (const [rule, over, st, cands] of cases) {
    it(`excludes when ${rule} fails (${JSON.stringify(over)})`, () => {
      const state = normalizeEconomicState(st(boundaryState()));
      expect(eligibilityFailure(facts(db(), { ...over, state }), menuOf(state, cands))).toBe(rule);
    });
  }
  it('excludes under a hard stop in the state', () => {
    const state = boundaryState({ constraints: { qualityFloor: 0, hardStop: true } });
    const rule = eligibilityFailure(facts(db(), { state }), menuOf(state, [recover]));
    // A hard-stopped state leaves nothing feasible either; either rule refuses it.
    expect(['never-under-a-hard-stop', 'never-the-sole-required-validation-path']).toContain(rule);
  });
  it('excludes when masking would leave no feasible path forward', () => {
    const state = boundaryState();
    const m = menuOf(state, [recover]);
    const blocked: UnmaskedMenu = { ...m, entries: m.entries.map((e) => (carriesRecover(e.candidate) ? e : { ...e, feasible: false })) };
    expect(eligibilityFailure(facts(db(), { state }), blocked)).toBe('never-the-sole-required-validation-path');
  });
  it('excludes a non-executable recover composite', () => {
    const state = boundaryState();
    const comp = compose(recover, read, 'SEQ');
    expect(eligibilityFailure(facts(db(), { state }), menuOf(state, [recover, comp]))).toBe('executable');
  });
});

describe('the mask at b*', () => {
  it('masks every recover candidate, never continue, persists one complete record, and the market chooses the rest', () => {
    const db = createDb(DB);
    const exp = experiment();
    // A task the coin masks.
    let root = ''; for (let i = 0; ; i++) { if (assign(KEY, `t${i}`).z === 'masked') { root = `t${i}`; break; } }
    const state = boundaryState();
    const { mask, outcome } = boundaryMask(exp, facts(db, { rootTaskId: root, state }));
    const d = chooseEconomicAction({ state, candidates: [recover, deepRecover, read], experimentMask: mask });
    expect(carriesRecover(d.action)).toBe(false);
    for (const id of ['recovery:retry', 'deep:recover']) {
      expect(d.candidates!.find((c) => c.id === id)!.reasonCodes).toContain('unavailable:experiment:masked');
    }
    expect(d.candidates!.find((c) => c.id === 'continue')!.status).not.toBe('rejected');
    const role = outcome();
    expect(role.role).toBe('bstar');
    const stored = exp.ledger.get(exp.config.experimentId, 'pilot', root)!;
    const rec = JSON.parse(stored.record);
    for (const f of ['experimentId', 'phase', 'preregTag', 'buildCommit', 'configSha256', 'lockfileSha256', 'installedTreeSha256', 'buildFingerprint',
      'rootTaskId', 'nodeId', 'stateVersion', 'boundaryKey', 'snapshotDigest', 'W', 'recoverRank', 'marginUsd', 'marginShare',
      'hmacMessage', 'u', 'u64', 'epsilon', 'Z', 'recoverCandidates', 'stateSignature', 'regime', 'progressPhase',
      'completedDispatchesToBstar', 'turnsUsedAtBstar']) expect(rec).toHaveProperty(f);
    expect(rec.Z).toBe('masked');
    expect(rows(db, 'experiment.assignment')).toHaveLength(1);
  });

  it('W does not depend on Z: the same menu gives the same W in both arms', () => {
    const db = createDb(DB);
    const exp = experiment();
    const state = boundaryState();
    const ids = { masked: '', available: '' };
    for (let i = 0; !ids.masked || !ids.available; i++) { const z = assign(KEY, `w${i}`).z; if (!ids[z]) ids[z] = `w${i}`; }
    const Ws = (['masked', 'available'] as const).map((z) => {
      const { mask } = boundaryMask(exp, facts(db, { rootTaskId: ids[z], nodeId: `n-${z}`, state }));
      chooseEconomicAction({ state, candidates: [recover, read], experimentMask: mask });
      return JSON.parse(exp.ledger.get(exp.config.experimentId, 'pilot', ids[z])!.record);
    });
    expect(Ws[0].Z).toBe('masked'); expect(Ws[1].Z).toBe('available');
    expect(Ws[0].W).toBe(Ws[1].W);
    expect(Ws[0].snapshotDigest).toBe(Ws[1].snapshotDigest);
  });

  it('an available task keeps recover on the menu, and the market may choose it', () => {
    const db = createDb(DB);
    const exp = experiment();
    let root = ''; for (let i = 0; ; i++) { if (assign(KEY, `a${i}`).z === 'available') { root = `a${i}`; break; } }
    const state = boundaryState();
    const unmasked = chooseEconomicAction({ state, candidates: [recover, read] });
    const { mask } = boundaryMask(exp, facts(db, { rootTaskId: root, state }));
    const d = chooseEconomicAction({ state, candidates: [recover, read], experimentMask: mask });
    expect(d.action.id).toBe(unmasked.action.id);
  });

  it('one boundary is one decision, however many times the market runs', () => {
    const db = createDb(DB);
    const exp = experiment();
    const state = boundaryState();
    const { mask } = boundaryMask(exp, facts(db, { state }));
    const m = menuOf(state, [recover, read]);
    expect(mask(m)).toEqual(mask(m));
    expect(rows(db, 'experiment.assignment')).toHaveLength(1);
  });

  it('later boundaries of the task are never masked, and are logged', () => {
    const db = createDb(DB);
    const exp = experiment();
    let root = ''; for (let i = 0; ; i++) { if (assign(KEY, `l${i}`).z === 'masked') { root = `l${i}`; break; } }
    const state = boundaryState();
    boundaryMask(exp, facts(db, { rootTaskId: root, state })).mask(menuOf(state, [recover]));
    const later = boundaryMask(exp, facts(db, { rootTaskId: root, state: { ...state, version: 30 } }));
    expect(later.mask(menuOf(state, [recover]))).toBeNull();
    expect(later.outcome().role).toBe('later');
    expect(rows(db, 'experiment.boundary').some((p) => p.role === 'later')).toBe(true);
  });

  it('the same boundary re-evaluated (a crash after commit) honours the stored Z without a second record', () => {
    const db = createDb(DB);
    const exp = experiment();
    const state = boundaryState();
    const first = boundaryMask(exp, facts(db, { state })).mask(menuOf(state, [recover, read]));
    const again = boundaryMask(exp, facts(db, { state })).mask(menuOf(state, [recover, read]));
    expect(again).toEqual(first);
    expect(rows(db, 'experiment.assignment')).toHaveLength(1);
    expect(rows(db, 'experiment.boundary').some((p) => p.role === 'integrity_stop')).toBe(false);
  });

  it('a re-evaluation that prices differently is not a stop: only the assignment identity is compared', () => {
    const db = createDb(DB);
    const exp = experiment();
    const state = boundaryState();
    const first = boundaryMask(exp, facts(db, { state })).mask(menuOf(state, [recover, read]));
    const again = boundaryMask(exp, facts(db, { state })).mask(menuOf(state, [recover]));
    expect(again).toEqual(first);
    expect(rows(db, 'experiment.boundary').some((p) => p.role === 'integrity_stop')).toBe(false);
  });

  it('a differing assignment identity for the same boundary is an integrity stop: the stored Z holds, and no task is assigned after', () => {
    const db = createDb(DB);
    const exp = experiment();
    const state = boundaryState();
    const first = boundaryMask(exp, facts(db, { state })).mask(menuOf(state, [recover, read]));
    // Same boundary and ledger, but a different build answers now.
    const other: ActiveExperiment = { ...experiment({ buildFingerprint: HEX('9'), ledger: exp.ledger }), config: exp.config };
    const again = boundaryMask(other, facts(db, { state })).mask(menuOf(state, [recover, read]));
    expect(again).toEqual(first);
    expect(rows(db, 'experiment.boundary').some((p) => p.role === 'integrity_stop')).toBe(true);
    expect(exp.ledger.stopped(exp.config.experimentId)).toBe('differing_assignment_for_bstar');
    const next = boundaryMask(exp, facts(db, { rootTaskId: 'task-2', nodeId: 'n2', state }));
    expect(next.mask(menuOf(state, [recover]))).toBeNull();
    expect(next.outcome()).toEqual({ role: 'refused', reason: 'integrity_stop' });
  });

  it('two evaluations racing on one task never produce conflicting assignments', () => {
    const db = createDb(DB);
    const exp = experiment();
    const state = boundaryState();
    // Same boundary, two evaluations: one record, the same answer.
    const a = boundaryMask(exp, facts(db, { state })); const b = boundaryMask(exp, facts(db, { state }));
    expect(a.mask(menuOf(state, [recover]))).toEqual(b.mask(menuOf(state, [recover])));
    // A different boundary of the same task, concurrently: it is not b*.
    const c = boundaryMask(exp, facts(db, { nodeId: 'child', state }));
    expect(c.mask(menuOf(state, [recover]))).toBeNull();
    expect(c.outcome().role).toBe('later');
    expect(assignments()).toBe(1);
  });

  it('a failed write: not enrolled, no mask, a write_failure event, and assignment stops', () => {
    const db = createDb(DB);
    const real = ledger();
    const exp = experiment({ ledger: { ...real, insert: () => ({ kind: 'failed', error: 'disk full' }) } });
    const state = boundaryState();
    let root = ''; for (let i = 0; ; i++) { if (assign(KEY, `f${i}`).z === 'masked') { root = `f${i}`; break; } }
    const m = boundaryMask(exp, facts(db, { rootTaskId: root, state }));
    expect(m.mask(menuOf(state, [recover]))).toBeNull();
    expect(m.outcome()).toEqual({ role: 'not_enrolled', reason: 'write_failure' });
    expect(exp.ledger.get(exp.config.experimentId, 'pilot', root)).toBeNull();
    expect(rows(db, 'experiment.write_failure')).toHaveLength(1);
    expect(rows(db, 'experiment.assignment')).toHaveLength(0);
    expect(real.stopped(exp.config.experimentId)).toBe('write_failure');
    const next = boundaryMask(exp, facts(db, { rootTaskId: 'other', nodeId: 'n9', state }));
    expect(next.mask(menuOf(state, [recover]))).toBeNull();
    expect(next.outcome()).toEqual({ role: 'refused', reason: 'integrity_stop' });
  });

  it('records are immutable: UPDATE and DELETE are refused by the database', () => {
    const db = createDb(DB);
    const exp = experiment();
    const state = boundaryState();
    boundaryMask(exp, facts(db, { state })).mask(menuOf(state, [recover]));
    const refusal = (run: () => unknown): string => {
      try { run(); return 'no error'; } catch (err) { const e = err as Error & { cause?: Error }; return `${e.message} ${e.cause?.message ?? ''}`; }
    };
    expect(refusal(() => rawLedger((d) => d.prepare("update assignments set z = 'available'").run()))).toMatch(/immutable/);
    expect(refusal(() => rawLedger((d) => d.prepare('delete from assignments').run()))).toMatch(/immutable/);
    exp.ledger.stop(exp.config.experimentId, 'r', 'd', 't');
    expect(refusal(() => rawLedger((d) => d.prepare('delete from stops').run()))).toMatch(/immutable/);
    expect(exp.ledger.get(exp.config.experimentId, 'pilot', 'task-1')).not.toBeNull();
  });

  it('the kill switch stops new assignment and leaves existing records alone', () => {
    const db = createDb(DB);
    const exp = experiment();
    const state = boundaryState();
    boundaryMask(exp, facts(db, { state })).mask(menuOf(state, [recover]));
    const off = boundaryMask('off', facts(db, { rootTaskId: 'task-9', nodeId: 'n9', state }));
    expect(off.mask(menuOf(state, [recover]))).toBeNull();
    expect(off.outcome()).toEqual({ role: 'refused', reason: 'kill_switch' });
    expect(assignments()).toBe(1);
  });

  it('C_mask stops assignment at 3,400 masked main-phase tasks', () => {
    const db = createDb(DB);
    const exp = experiment({ phase: 'main' });
    rawLedger((d) => {
      const ins = d.prepare("insert into assignments values (?, 'main', ?, ?, 'masked', '{}', 'h', 't')");
      d.transaction(() => { for (let i = 0; i < 3400; i++) ins.run(exp.config.experimentId, 'pre' + i, 'k' + i); })();
    });
    expect(exp.ledger.countMasked(exp.config.experimentId, 'main')).toBe(3400);
    const state = boundaryState();
    const m = boundaryMask(exp, facts(db, { rootTaskId: 'new', state }));
    expect(m.mask(menuOf(state, [recover]))).toBeNull();
    expect(m.outcome()).toEqual({ role: 'refused', reason: 'c_mask' });
  });

  it('a failed tagged-build check refuses assignment and writes nothing', () => {
    const db = createDb(DB);
    const state = boundaryState();
    const m = boundaryMask(experiment({ integrityOk: false }), facts(db, { state }));
    expect(m.mask(menuOf(state, [recover]))).toBeNull();
    expect(m.outcome()).toEqual({ role: 'refused', reason: 'refused:clean-tree' });
    expect(assignments()).toBe(0);
  });

  it('the ledger reports a unique-key conflict rather than overwriting', () => {
    const exp = { ledger: ledger() };
    const row = { experimentId: 'e', phase: 'pilot', rootTaskId: 't', boundaryKey: 'n#1', z: 'masked' as const, record: '{}', recordSha256: 'h', createdAt: 't' };
    expect(exp.ledger.insert(row).kind).toBe('inserted');
    const again = exp.ledger.insert({ ...row, z: 'available' });
    expect(again.kind).toBe('conflict');
    expect(exp.ledger.get('e', 'pilot', 't')!.z).toBe('masked');
  });
});

// ---------------------------------------------------------------------------
// Through the real boundary (evaluateBoundary), as production runs it.
// ---------------------------------------------------------------------------

describe('H2.6 through evaluateBoundary', () => {
  const GOAL = 'Fix the failing session test in src/auth/session.ts';
  const prev = process.env.ORG_GOVERNOR_ABLATION;
  beforeAll(() => { process.env.ORG_GOVERNOR_ABLATION = 'H2'; });
  afterAll(() => { if (prev === undefined) delete process.env.ORG_GOVERNOR_ABLATION; else process.env.ORG_GOVERNOR_ABLATION = prev; });

  function failedRetry(db: ReturnType<typeof createDb>, id: string): void {
    insertNode(db, {
      id, parentId: null, goal: GOAL, repoPath: '/tmp', state: 'CREATED', createdAt: 't0', updatedAt: 't0',
      contract: { goal: GOAL, definition_of_done: ['the test passes'], authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 1 }, constraints: [] },
    });
    for (let i = 0; i < 8; i++) {
      const u = randomUUID();
      appendEvent(db, { nodeId: id, type: 'exec.assistant', createdAt: new Date().toISOString(), payload: { message: { content: [{ type: 'tool_use', id: u, name: 'Bash', input: { command: 'npm test' } }] } } });
      appendEvent(db, { nodeId: id, type: 'exec.user', createdAt: new Date().toISOString(), payload: { message: { content: [{ type: 'tool_result', tool_use_id: u, content: 'error: readStore is not a function', is_error: true }] } } });
    }
    recordDispatchUsage(db, { nodeId: id, role: 'execute', model: null, costUsd: 0.1, createdAt: 't1', usage: { inputTokens: 60_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 8 } });
  }

  it('with no experiment the boundary is exactly H2.5', () => {
    const db = createDb(DB);
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) failedRetry(db, id);
    const a = evaluateBoundary(db, { nodeId: ids[0], goal: GOAL }, { experiment: null });
    const b = evaluateBoundary(db, { nodeId: ids[1], goal: GOAL });
    expect(a.decision!.action.id).toBe(b.decision!.action.id);
    expect(a.experiment).toEqual({ role: 'none' });
    expect(assignments()).toBe(0);
    for (const id of ids) forgetNode(id);
  });

  it('a synthetic stream: ~50/50 assignment, masked ⇒ no recover at b*, available ⇒ the market\'s own choice, later boundaries unmasked', () => {
    const db = createDb(DB);
    const exp = experiment();
    const tally = { masked: 0, available: 0, recoverChosenAvailable: 0, recoverChosenMasked: 0, laterMasked: 0, bstar: 0 };
    for (let i = 0; i < 60; i++) {
      const id = randomUUID();
      failedRetry(db, id);
      const out = evaluateBoundary(db, { nodeId: id, goal: GOAL }, { experiment: exp });
      if (out.experiment?.role !== 'bstar') continue;
      tally.bstar++;
      tally[out.experiment.z]++;
      if (carriesRecover(out.decision!.action)) tally[out.experiment.z === 'masked' ? 'recoverChosenMasked' : 'recoverChosenAvailable']++;
      // The next boundary of the same task: recover is back on the menu.
      for (let k = 0; k < 2; k++) appendEvent(db, { nodeId: id, type: 'exec.assistant', createdAt: new Date().toISOString(), payload: { message: { content: [] } } });
      const later = evaluateBoundary(db, { nodeId: id, goal: GOAL }, { experiment: exp });
      if (later.cycle.candidates.some(carriesRecover) && later.decision!.candidates?.some((c) => c.reasonCodes.includes('unavailable:experiment:masked'))) tally.laterMasked++;
      forgetNode(id);
    }
    expect(tally.bstar).toBeGreaterThan(40);
    expect(tally.masked).toBeGreaterThan(10);
    expect(tally.available).toBeGreaterThan(10);
    expect(tally.recoverChosenMasked).toBe(0);
    expect(tally.recoverChosenAvailable).toBeGreaterThan(0);
    expect(tally.laterMasked).toBe(0);
    // Every b* left exactly one immutable record and one decision log.
    expect(assignments()).toBe(tally.bstar);
    expect(rows(db, 'experiment.boundary').filter((p) => p.role === 'bstar_decision')).toHaveLength(tally.bstar);
  });

  it('masked tasks never offer recover to a System-1 re-choice either', () => {
    const db = createDb(DB);
    const exp = experiment();
    for (let i = 0; i < 20; i++) {
      const id = randomUUID();
      failedRetry(db, id);
      const out = evaluateBoundary(db, { nodeId: id, goal: GOAL }, { experiment: exp });
      if (out.experiment?.role === 'bstar' && out.experiment.z === 'masked') {
        const menu = out.cycle.candidates.filter((c) => !out.unavailable!.has(c.id));
        expect(menu.some(carriesRecover)).toBe(false);
        expect(listEventsForNode(db, id).some((e) => e.type === 'experiment.boundary')).toBe(true);
        forgetNode(id);
        return;
      }
      forgetNode(id);
    }
    throw new Error('no masked task in 20 draws');
  });
});

export { randomBytes };
