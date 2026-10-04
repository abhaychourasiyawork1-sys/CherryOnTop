// H2.6 engineering-validation benchmark: mechanical metrics per run, from the
// preserved databases. NOT an efficacy analysis: no arm comparison here is
// causal, and nothing here feeds a pre-registered parameter.
//   node bench/governor/h26/validation/collect.mjs <benchRoot>
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { priceUsd, readLedger, carriedInWindow, invalidity } from '../analysis.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

export function collectValidationRun(dir, ledger = readLedger(join(dir, '..', '..', 'ledger.db'))) {
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const grade = existsSync(join(dir, 'grade.json')) ? JSON.parse(readFileSync(join(dir, 'grade.json'), 'utf8')) : null;
  const db = new Database(join(dir, 'state.db'), { readonly: true });
  try {
    const q = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch { return []; } };
    const ev = q('select node_id as nodeId, type, payload, created_at as createdAt from events order by id').map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    const of = (type) => ev.filter((e) => e.type === type);
    const usage = q("select node_id as nodeId, value, created_at as createdAt from memory where kind = 'dispatch_usage'").map((r) => ({ ...r, value: JSON.parse(r.value) }));
    const sum = (f) => usage.reduce((s, u) => s + (f(u.value.usage ?? {}) ?? 0), 0);
    const exec = usage.filter((u) => u.value.role === 'execute').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const econ = of('economic.decision');
    const obs = econ.filter((e) => e.payload.decisionId && !['not_due', 'reentrant'].includes(e.payload.reason));
    const xb = of('experiment.boundary');
    const nodeIds = new Set(q('select id from nodes').map((n) => n.id));
    const tree = nodeIds; // one root task per run
    const assignments = ledger.filter((a) => nodeIds.has(a.root_task_id)).map((a) => ({ ...a, record: JSON.parse(a.record) }));
    const bstar = xb.filter((e) => e.payload.role === 'bstar_final_decision' || e.payload.role === 'bstar_decision');
    const finalBstar = (root) => bstar.filter((e) => e.payload.rootTaskId === root).at(-1) ?? null;
    const pivots = of('step.progress').filter((e) => /pivoting rather than repeating/.test(e.payload?.message ?? ''));
    const turnBudget = of('dispatch.turn_budget').map((e) => e.payload);
    const outcomes = of('step.outcome').map((e) => e.payload);
    const validations = of('validation.result').map((e) => ({ passed: e.payload.passed, level: e.payload.level }));
    const masked = assignments.filter((a) => a.z === 'masked');
    const bstarRows = assignments.map((a) => {
      const d = finalBstar(a.root_task_id);
      const recoverChosen = Boolean(d && (d.payload.chosenCarriesRecover ?? d.payload.chosenKind === 'recover'));
      return {
        Z: a.z, W: a.record.W, rank: a.record.recoverRank, marginUsd: a.record.marginUsd, marginShare: a.record.marginShare,
        available: (a.record.unmaskedSnapshot ?? []).filter((e) => e.feasible).length, maskedCount: a.z === 'masked' ? (a.record.recoverCandidates ?? []).length : 0,
        chosenKind: d?.payload.chosenKind ?? null, substitute: d?.payload.substitute ?? null,
        recoverChosen, recoverCarried: carriedInWindow(d, ev, tree),
        dispatchesToBstar: a.record.completedDispatchesToBstar, turnsUsedAtBstar: a.record.turnsUsedAtBstar,
        experimentMs: d?.payload.experimentMs ?? null,
      };
    });
    return {
      run: meta.run_id, task: meta.task_id, instance: meta.instance_id, arm: meta.arm, state: meta.outcome?.state ?? null,
      resolved: grade && grade.resolved !== undefined ? Boolean(grade.resolved) : null,
      wallMin: (meta.wallMs ?? 0) / 60000,
      tokens: { input: sum((u) => u.inputTokens), output: sum((u) => u.outputTokens), cacheRead: sum((u) => u.cacheReadTokens), cacheWrite: sum((u) => u.cacheCreationTokens) },
      costUsdPinned: usage.reduce((s, u) => s + priceUsd(u.value.usage ?? {}, u.value.model), 0),
      costUsdReported: usage.reduce((s, u) => s + (u.value.costUsd ?? 0), 0),
      turns: sum((u) => u.numTurns), dispatches: usage.length, executeDispatches: exec.length,
      retries: Math.max(0, exec.length - 1),
      validations,
      economicDecisions: econ.length, decisionLatencyMs: econ.reduce((s, e) => s + (e.payload.latencyMs ?? 0), 0),
      governorPackets: q("select count(*) n from memory where kind = 'decision_packet'")[0]?.n ?? 0,
      d1: {
        // Every economic cycle logs one economic.decision; observable ones decided.
        totalBoundaries: econ.length,
        observable: obs.length,
        interventionEligible: obs.filter((e) => !(e.payload.reasonCodes ?? []).includes('ineligible:no_telemetry')).length,
        // Evaluated boundaries with a recover candidate on the menu (only an
        // experiment run logs them): every non-b* experiment.boundary, plus b*.
        recoverCandidateBoundaries: xb.filter((e) => !String(e.payload.role).startsWith('bstar')).length + assignments.length,
        excluded: xb.filter((e) => e.payload.role === 'excluded').map((e) => e.payload.reason),
        refused: xb.filter((e) => e.payload.role === 'refused').map((e) => e.payload.reason),
        bstar: assignments.length,
      },
      bstar: bstarRows,
      maskIntegrity: {
        maskedBstarRecoverChoices: bstarRows.filter((r) => r.Z === 'masked' && r.recoverChosen).length,
        maskedBstarRecoverCarried: bstarRows.filter((r) => r.Z === 'masked' && r.recoverCarried).length,
        laterRecoverCandidates: xb.filter((e) => e.payload.role === 'later').length,
        laterRecoverCarried: Math.max(0, pivots.length - bstarRows.filter((r) => r.recoverCarried).length),
        masked: masked.length,
      },
      d2: {
        budget: turnBudget,
        firstDispatchCap: turnBudget[0]?.cap ?? null,
        firstDispatchTurns: exec[0]?.value.usage?.numTurns ?? null,
        retryOccurred: exec.length > 1,
        retrySurvived: exec.length > 1 && (exec[1].value.usage?.numTurns ?? 0) > 0,
        terminations: outcomes.map((o) => (o.succeeded ? 'completed' : o.message)),
      },
      experimentEvents: { assignment: of('experiment.assignment').length, boundary: xb.length, writeFailure: of('experiment.write_failure').length },
    };
  } finally { db.close(); }
}

if (process.argv[1] && process.argv[1].endsWith('collect.mjs')) {
  const root = process.argv[2];
  const dirs = readdirSync(join(root, 'runs')).filter((d) => existsSync(join(root, 'runs', d, 'meta.json')));
  // Provider-refused runs are not agent outcomes: excluded, with the reason.
  const excluded = [];
  const runs = dirs.flatMap((d) => {
    const invalid = invalidity(join(root, 'runs', d));
    if (invalid) { excluded.push({ run: d, ...invalid }); return []; }
    return [collectValidationRun(join(root, 'runs', d))];
  });
  writeFileSync(join(root, 'collected.json'), JSON.stringify(runs, null, 1));
  writeFileSync(join(root, 'excluded.json'), JSON.stringify(excluded, null, 1));
  if (excluded.length) console.error(`excluded ${excluded.length} invalid run(s): ${excluded.map((e) => `${e.run} (${e.reason})`).join(', ')}`);
  console.log(JSON.stringify(runs.map((r) => ({ run: r.run, state: r.state, resolved: r.resolved, execs: r.executeDispatches, bstar: r.d1.bstar, masked: r.maskIntegrity.masked })), null, 0));
}
