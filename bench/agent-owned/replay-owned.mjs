#!/usr/bin/env node
/** Offline replay of recorded Claude Code dispatches through the owned loop
 *  (src/agent/replay.ts): same recorded actions and outputs, CherryOnTop's
 *  context instead of Claude Code's. No model, no sandbox, no network.
 *
 *  Usage:
 *    npm run build
 *    node bench/agent-owned/replay-owned.mjs --db ~/.org/state.db [--db more.db ...]
 *         [--min-turns 3] [--json report.json] [--md report.md]
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { ARMS, replayOwned, sessionFromEvents, calibration } from '../../dist/agent/replay.js';

const args = process.argv.slice(2);
const opt = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const dbs = opt('db').map((p) => p.replace(/^~/, homedir()));
if (dbs.length === 0) { console.error('need --db <state.db>'); process.exit(2); }
const minTurns = Number(opt('min-turns')[0] ?? 3);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function sessionsOf(rows) {
  const sessions = [];
  let current = null;
  for (const row of rows) {
    if (row.type === 'exec.system' && row.payload?.subtype === 'init') { current = []; sessions.push(current); }
    if (!current) { current = []; sessions.push(current); }
    current.push(row);
  }
  return sessions;
}

const records = [];
// Information control prices carrying with the turn counts of past dispatches;
// the corpus's own sessions are that history here.
const pending = [];
for (const path of dbs) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const goals = new Map(db.prepare('select id, goal from nodes').all().map((n) => [n.id, n.goal]));
  const nodeIds = db.prepare("select distinct node_id from events where type = 'exec.assistant'").all().map((r) => r.node_id);
  const stmt = db.prepare("select type, payload from events where node_id = ? and type like 'exec.%' order by id");
  for (const nodeId of nodeIds) {
    const rows = stmt.all(nodeId).map((r) => ({ type: r.type, payload: parse(r.payload) }));
    for (const [index, session] of sessionsOf(rows).entries()) {
      const rec = sessionFromEvents(session, goals.get(nodeId) ?? '');
      if (rec.turns.length < minTurns || !rec.model) continue;
      const first = rec.turns[0].contextTokens;
      const scale = calibration(rec);
      pending.push({ rec, scale, first, path, nodeId, index });
    }
  }
  db.close();
}
const pastTurns = pending.map((p) => p.rec.turns.length);
for (const { rec, scale, first, path, nodeId, index } of pending) {
  {
    {
      const arms = {};
      for (const arm of ARMS) arms[arm.name] = await replayOwned(rec, arm, { pastTurns });
      records.push({
        db: path, nodeId, session: index, model: rec.model, turns: rec.turns.length, scale,
        recorded: { costUsd: rec.recordedUsd, firstContext: first, peakContext: Math.max(...rec.turns.map((t) => t.contextTokens)), contextTokens: rec.turns.reduce((s, t) => s + t.contextTokens, 0) },
        arms,
      });
    }
  }
}

const sum = (f) => records.reduce((s, r) => s + f(r), 0);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const recordedUsd = sum((r) => r.recorded.costUsd);
const summary = {
  sessions: records.length,
  turns: sum((r) => r.turns),
  recorded: { costUsd: recordedUsd, contextTokens: sum((r) => r.recorded.contextTokens), medianFirstContext: median(records.map((r) => r.recorded.firstContext)) },
  arms: Object.fromEntries(ARMS.map(({ name }) => {
    const usd = sum((r) => r.arms[name].costUsd);
    return [name, {
      costUsd: usd, vsRecorded: recordedUsd > 0 ? usd / recordedUsd - 1 : null,
      vsRecordedAt1hWrites: recordedUsd > 0 ? sum((r) => r.arms[name].costAt1hWritesUsd) / recordedUsd - 1 : null,
      contextTokens: sum((r) => r.arms[name].contextTokens),
      compactions: sum((r) => r.arms[name].compactions), microCompactions: sum((r) => r.arms[name].microCompactions ?? 0), projected: sum((r) => r.arms[name].projected), elidedChars: sum((r) => r.arms[name].elidedChars),
      unrecoverable: sum((r) => r.arms[name].unrecoverable), toolCalls: sum((r) => r.arms[name].toolCalls),
      fullyReplayed: records.filter((r) => r.arms[name].turnsReplayed === r.turns).length,
    }];
  })),
  medianCalibration: median(records.map((r) => r.scale)),
};

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const lines = [
  `# Owned-loop offline replay`, '',
  `${summary.sessions} recorded Claude Code sessions (${summary.turns} turns), replayed with identical actions and outputs.`,
  `Recorded cost (Claude Code, 1-hour cache writes): $${recordedUsd.toFixed(2)}; median first-turn context ${summary.recorded.medianFirstContext} tokens.`,
  `Median estimator calibration (real/estimated tokens): ${summary.medianCalibration.toFixed(2)}.`, '',
  `Recorded context tokens: ${summary.recorded.contextTokens}.`, '',
  '| arm | cost | vs recorded | vs recorded, same cache-write price | context tokens | vs recorded | compactions | micro | projected | unrecoverable | fully replayed |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...Object.entries(summary.arms).map(([name, a]) => `| ${name} | $${a.costUsd.toFixed(2)} | ${pct(a.vsRecorded)} | ${pct(a.vsRecordedAt1hWrites)} | ${a.contextTokens} | ${pct(a.contextTokens / summary.recorded.contextTokens - 1)} | ${a.compactions} | ${a.microCompactions} | ${a.projected} | ${a.unrecoverable} | ${a.fullyReplayed}/${summary.sessions} |`),
  '', 'Counterfactual: the model is assumed to act as recorded on the owned context. Projections are the no-refetch bound.',
];
console.log(lines.join('\n'));
const jsonPath = opt('json')[0];
if (jsonPath) writeFileSync(jsonPath, JSON.stringify({ summary, records }, null, 2));
const mdPath = opt('md')[0];
if (mdPath) writeFileSync(mdPath, lines.join('\n') + '\n');
