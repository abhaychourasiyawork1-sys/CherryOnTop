#!/usr/bin/env node
/** Offline evaluation of shaping policies on full-information labels.
 *
 *  Every candidate representation of every observation that reached the
 *  shaping stage carries: the exact carrying cost it would save, the price of
 *  one refetch, and the information-use label (did the agent later use a code
 *  identifier only the elided part held). So every policy is scored on the same
 *  counterfactuals: realised value = saved − (used ? refetch : 0).
 *
 *  Estimators are cross-fitted: sessions are split in two folds by node, and
 *  each fold is scored with an estimator fit on the other.
 *
 *  Usage: npm run build && node bench/infocontrol/policy-eval.mjs --db ~/.org/state.db [--db ...] [--json out.json]
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { replay, trajectoryFromEvents } from '../../dist/infocontrol/replay.js';
import { fitRefetchModel, predictRefetch } from '../../dist/infocontrol/refetch-model.js';
import { refetchBound, refetchMean } from '../../dist/infocontrol/economics.js';

const args = process.argv.slice(2);
const opt = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const dbs = opt('db').map((p) => p.replace(/^~/, homedir()));
const jsonPath = opt('json')[0];
const CONFIDENCE = Number(opt('confidence')[0] ?? 0.9);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

const sessions = [];
for (const path of dbs) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const goals = new Map(db.prepare('select id, goal from nodes').all().map((n) => [n.id, n.goal]));
  const ids = db.prepare("select distinct node_id from events where type = 'exec.assistant'").all().map((r) => r.node_id);
  const stmt = db.prepare("select type, payload from events where node_id = ? and type like 'exec.%' order by id");
  for (const nodeId of ids) {
    let current = null;
    const split = [];
    for (const r of stmt.all(nodeId)) {
      const p = parse(r.payload);
      if (r.type === 'exec.system' && p?.subtype === 'init') { current = []; split.push(current); }
      if (!current) { current = []; split.push(current); }
      current.push({ type: r.type, payload: p });
    }
    split.forEach((rows, i) => {
      const steps = trajectoryFromEvents(rows);
      if (steps.filter((s) => s.kind === 'turn').length < 3) return;
      const model = rows.find((e) => e.type === 'exec.assistant')?.payload?.message?.model ?? 'haiku';
      sessions.push({ id: `${nodeId}#${i}`, nodeId, goal: goals.get(nodeId) ?? '', model, steps });
    });
  }
  db.close();
}

const turnsOf = sessions.map((s) => s.steps.filter((x) => x.kind === 'turn').length);
const fold = (id) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 2;
let baselineUsd = 0;
const observations = [[], []]; // per fold: [{ session, candidates: [...] }]
for (const [i, s] of sessions.entries()) {
  const rep = await replay(s.steps, { goal: s.goal, model: s.model, pastTurns: turnsOf.filter((_, j) => j !== i), disabled: ['shape', 'dedup', 'finish', 'memory', 'system1'] });
  baselineUsd += rep.baselineUsd;
  const byObs = new Map();
  for (const c of rep.candidateLabels) {
    const k = `${s.id}/${c.observation}`;
    if (!byObs.has(k)) byObs.set(k, []);
    byObs.get(k).push(c);
  }
  for (const cands of byObs.values()) observations[fold(s.nodeId)].push(cands);
}

const allLabels = (f) => observations[f].flat();
const fitBeta = (labels) => {
  const m = new Map();
  for (const l of labels) { const b = m.get(l.cell) ?? { refetched: 0, elided: 0 }; m.set(l.cell, { refetched: b.refetched + (l.used ? 1 : 0), elided: b.elided + 1 }); }
  return m;
};
const estimators = {
  'beta-cell': (train) => { const m = fitBeta(train); return (c) => { const b = m.get(c.cell) ?? { refetched: 0, elided: 0 }; return { mean: refetchMean(b), bound: refetchBound(b, CONFIDENCE) }; }; },
  logistic: (train) => { const m = fitRefetchModel(train.map((l) => ({ features: l.features, used: l.used })), 1); return (c) => predictRefetch(m, c.features, CONFIDENCE); },
};

const value = (c) => c.savedUsd - (c.used ? c.refetchUsd : 0);
const results = {};
const add = (name, f, v, elided, harmful) => {
  const r = results[name] ??= { realisedUsd: 0, elisions: 0, harmful: 0 };
  r.realisedUsd += v; r.elisions += elided; r.harmful += harmful;
};
const calibration = {};
for (const f of [0, 1]) {
  const train = allLabels(1 - f);
  for (const obs of observations[f]) {
    // Oracle: perfect knowledge of use.
    const best = Math.max(0, ...obs.map(value));
    add('oracle', f, best, best > 0 ? 1 : 0, 0);
    // Static rule (no economics): shape any output over 2k tokens to its largest salient view.
    const big = obs[0]?.features.originalTokens > 2000 ? obs.filter((c) => c.features.representation === 'salient').sort((a, b) => b.features.keptFraction - a.features.keptFraction)[0] : undefined;
    if (big) add('static>2k-salient', f, value(big), 1, big.used ? 1 : 0); else add('static>2k-salient', f, 0, 0, 0);
  }
  for (const [name, make] of Object.entries(estimators)) {
    const predict = make(train);
    let sq = 0; let n = 0;
    for (const obs of observations[f]) {
      const preds = obs.map((c) => ({ c, p: predict(c) }));
      for (const { c, p } of preds) { sq += (p.mean - (c.used ? 1 : 0)) ** 2; n++; }
      for (const which of ['mean', 'bound']) {
        const choice = preds.map(({ c, p }) => ({ c, ev: c.savedUsd - p[which] * c.refetchUsd })).filter((x) => x.ev > 0).sort((a, b) => b.ev - a.ev)[0];
        if (choice) add(`${name}:${which}`, f, value(choice.c), 1, choice.c.used ? 1 : 0); else add(`${name}:${which}`, f, 0, 0, 0);
      }
    }
    const base = allLabels(f).filter((l) => l.used).length / Math.max(1, n);
    (calibration[name] ??= []).push({ fold: f, n, brier: sq / Math.max(1, n), constantBrier: base * (1 - base) });
  }
}

const out = {
  sessions: sessions.length, observations: observations[0].length + observations[1].length, baselineUsd,
  calibration,
  policies: Object.fromEntries(Object.entries(results).map(([k, r]) => [k, { ...r, reduction: r.realisedUsd / baselineUsd, harmfulRate: r.elisions ? r.harmful / r.elisions : 0 }])),
};
console.log(JSON.stringify(out, null, 2));
if (jsonPath) writeFileSync(jsonPath, JSON.stringify(out, null, 2));
