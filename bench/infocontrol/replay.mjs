#!/usr/bin/env node
/** Offline replay of recorded dispatches through the information controller.
 *
 *  Reads any runtime state.db read-only, splits each node's exec stream into
 *  CLI sessions (a session starts at the runtime's `init` event), replays each
 *  session through `dist/infocontrol/replay.js` under a policy, and re-prices
 *  it. Nothing here calls a model or the cluster.
 *
 *  Usage:
 *    npm run build
 *    node bench/infocontrol/replay.mjs --db ~/.org/state.db [--db more.db ...]
 *         [--ablate shape,dedup,...] [--beliefs beliefs.json] [--min-turns 3]
 *         [--export trajectory_events.jsonl] [--json report.json]
 *         [--estimator logistic|beta] [--seed-db <state.db>]   (seed: write proxy labels as refetch-model rows)
 */
import Database from 'better-sqlite3';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { replay, trajectoryFromEvents } from '../../dist/infocontrol/replay.js';
import { fitRefetchModel } from '../../dist/infocontrol/refetch-model.js';
import { createDb } from '../../dist/db/client.js';
import { recordRefetchObservation } from '../../dist/infocontrol/memory.js';

const args = process.argv.slice(2);
const opt = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const dbs = opt('db').map((p) => p.replace(/^~/, homedir()));
if (dbs.length === 0) { console.error('need --db <state.db>'); process.exit(2); }
const ablate = (opt('ablate')[0] ?? '').split(',').filter(Boolean);
const minTurns = Number(opt('min-turns')[0] ?? 3);
const beliefsFile = opt('beliefs')[0];
const beliefs = beliefsFile && existsSync(beliefsFile) ? new Map(Object.entries(JSON.parse(readFileSync(beliefsFile, 'utf8')))) : undefined;
const exportPath = opt('export')[0];
const jsonPath = opt('json')[0];

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function sessionsOf(rows) {
  const sessions = [];
  let current = null;
  for (const row of rows) {
    if (row.type === 'exec.system' && row.p?.subtype === 'init') { current = []; sessions.push(current); }
    if (!current) { current = []; sessions.push(current); }
    current.push({ type: row.type, payload: row.p });
  }
  return sessions;
}

const exported = [];
const records = [];
for (const path of dbs) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const nodes = new Map(db.prepare('select id, goal from nodes').all().map((n) => [n.id, n.goal]));
  const nodeIds = db.prepare("select distinct node_id from events where type = 'exec.assistant'").all().map((r) => r.node_id);
  const stmt = db.prepare("select type, payload from events where node_id = ? and (type like 'exec.%' or type = 'validation.result') order by id");
  for (const nodeId of nodeIds) {
    const rows = stmt.all(nodeId).map((r) => ({ type: r.type, p: parse(r.payload) }));
    const validation = rows.filter((r) => r.type === 'validation.result').at(-1)?.p ?? null;
    const sessions = sessionsOf(rows.filter((r) => r.type.startsWith('exec.')));
    sessions.forEach((session, index) => {
      const steps = trajectoryFromEvents(session);
      const turns = steps.filter((s) => s.kind === 'turn');
      if (turns.length < minTurns) return;
      const model = session.find((e) => e.type === 'exec.assistant')?.payload?.message?.model ?? 'haiku';
      records.push({ path, nodeId, index, steps, model, goal: nodes.get(nodeId) ?? '', validated: validation ? validation.passed === true : null, last: index === sessions.length - 1 });
      if (exportPath) {
        let step = 0;
        for (const s of steps) {
          if (s.kind === 'result') { exported.push({ trace_id: `${nodeId}#${index}`, step: step++, action_type: 'outcome', output_tokens: s.usage.output_tokens ?? 0, validated: validation ? validation.passed === true : null }); continue; }
          exported.push(s.kind === 'turn'
            ? { trace_id: `${nodeId}#${index}`, step: step++, action_type: 'model_call', input_tokens: s.usage.input_tokens ?? 0, cache_read_tokens: s.usage.cache_read_input_tokens ?? 0, cache_write_tokens: s.usage.cache_creation_input_tokens ?? 0, output_tokens: s.usage.output_tokens ?? 0, context_size: (s.usage.input_tokens ?? 0) + (s.usage.cache_read_input_tokens ?? 0) + (s.usage.cache_creation_input_tokens ?? 0) }
            : { trace_id: `${nodeId}#${index}`, step: step++, action_type: `tool:${s.name}`, query: JSON.stringify(s.input).slice(0, 300), output_tokens_est: Math.ceil(s.output.length / 4), outcome: s.isError ? 'error' : 'ok' });
        }
      }
    });
  }
  db.close();
}

// Turn history for the survival estimate: leave-one-out, so a session never
// informs its own prediction.
const allTurns = records.map((r) => r.steps.filter((s) => s.kind === 'turn').length);
const pastFor = (i) => allTurns.filter((_, j) => j !== i);
const fold = (nodeId) => [...nodeId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 2;

// Pass 1: label every candidate representation (independent of beliefs).
const labelsByFold = [[], []];
for (const [i, r] of records.entries()) {
  const rep = await replay(r.steps, { goal: r.goal, model: r.model, pastTurns: pastFor(i) });
  labelsByFold[fold(r.nodeId)].push(...rep.candidateLabels);
}
const fit = (labels) => {
  const out = new Map();
  for (const l of labels) {
    const b = out.get(l.cell) ?? { refetched: 0, elided: 0 };
    out.set(l.cell, { refetched: b.refetched + (l.used ? 1 : 0), elided: b.elided + 1 });
  }
  return out;
};
const foldBeliefs = [fit(labelsByFold[1]), fit(labelsByFold[0])]; // fold f is scored with the other fold's beliefs
const estimator = opt('estimator')[0] ?? 'logistic';
const toRows = (labels) => labels.filter((l) => l.features).map((l) => ({ features: l.features, used: l.used }));
const foldModels = estimator === 'logistic' ? [fitRefetchModel(toRows(labelsByFold[1])), fitRefetchModel(toRows(labelsByFold[0]))] : [null, null];
const seedDb = opt('seed-db')[0];
if (seedDb) {
  const target = createDb(seedDb.replace(/^~/, homedir()));
  const rows = toRows([...labelsByFold[0], ...labelsByFold[1]]);
  for (const row of rows) recordRefetchObservation(target, 'proxy', row, null);
  console.error(`seeded ${rows.length} proxy refetch observations into ${seedDb}`);
}
const brier = (f) => {
  const b = foldBeliefs[f]; const xs = labelsByFold[f];
  const err = xs.map((l) => { const x = b.get(l.cell) ?? { refetched: 0, elided: 0 }; const p = (1 + x.refetched) / (2 + x.elided); return (p - (l.used ? 1 : 0)) ** 2; });
  return { n: xs.length, brier: err.reduce((a, c) => a + c, 0) / Math.max(1, err.length), baseRate: xs.filter((l) => l.used).length / Math.max(1, xs.length) };
};
const fitBeliefsPath = opt('fit-beliefs')[0];
if (fitBeliefsPath) writeFileSync(fitBeliefsPath, JSON.stringify(Object.fromEntries(fit([...labelsByFold[0], ...labelsByFold[1]])), null, 2));

const POLICIES = (opt('policies')[0] ?? (ablate.length ? 'given' : 'full')).split(',');
const disabledFor = (p) => (p === 'given' ? ablate : p === 'full' ? [] : p.startsWith('no-') ? p.slice(3).split('+') : []);

const sum = (rs, f) => rs.reduce((s, r) => s + f(r), 0);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const out = { sessions: records.length, estimator, calibration: { fold0: brier(0), fold1: brier(1) }, policies: {} };
let detail = [];
for (const policy of POLICIES) {
  const results = [];
  for (const [i, r] of records.entries()) {
    const report = await replay(r.steps, {
      goal: r.goal, model: r.model, disabled: disabledFor(policy), pastTurns: pastFor(i),
      beliefs: beliefs ?? foldBeliefs[fold(r.nodeId)], refetchModel: foldModels[fold(r.nodeId)],
    });
    results.push({ nodeId: r.nodeId, session: r.index, model: r.model, validated: r.validated, last: r.last, ...report, candidateLabels: undefined });
  }
  const baseline = sum(results, (r) => r.baselineUsd);
  const decisions = {};
  for (const r of results) for (const [k, v] of Object.entries(r.decisions)) decisions[k] = (decisions[k] ?? 0) + v;
  const finals = results.filter((r) => r.last && r.validated !== null);
  const cell = (pred) => { const xs = finals.filter(pred); return { n: xs.length, failed: xs.filter((r) => !r.validated).length }; };
  const elisions = results.flatMap((r) => r.elisions);
  out.policies[policy] = {
    disabled: disabledFor(policy),
    baselineUsd: baseline,
    byClass: { read: sum(results, (r) => r.baseline.readUsd), write: sum(results, (r) => r.baseline.writeUsd), output: sum(results, (r) => r.baseline.outputUsd), input: sum(results, (r) => r.baseline.inputUsd) },
    savedUsd: sum(results, (r) => r.savedUsd),
    policyUsd: Object.fromEntries(['noRefetch', 'meanRefetch', 'proxyRefetch', 'allRefetch'].map((k) => [k, sum(results, (r) => r.policyUsd[k])])),
    reduction: Object.fromEntries(['noRefetch', 'meanRefetch', 'proxyRefetch', 'allRefetch'].map((k) => [k, 1 - sum(results, (r) => r.policyUsd[k]) / baseline])),
    medianSessionReductionProxy: median(results.map((r) => (r.baselineUsd > 0 ? 1 - r.policyUsd.proxyRefetch / r.baselineUsd : 0))),
    elisions: elisions.length,
    elisionsUsedProxy: elisions.filter((e) => e.used).length,
    elidedTokens: sum(results, (r) => r.elidedTokens),
    decisions,
    finishGate: { unverified: cell((r) => r.unverifiedFinish), verified: cell((r) => !r.unverifiedFinish) },
  };
  if (policy === POLICIES[0]) detail = results;
}
console.log(JSON.stringify(out, null, 2));
if (jsonPath) writeFileSync(jsonPath, JSON.stringify({ ...out, sessions: detail }, null, 2));
if (exportPath) writeFileSync(exportPath, exported.map((e) => JSON.stringify(e)).join('\n') + '\n');
