// Arm B: one row per run from its preserved database, plus the grade.
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
const ROOT = join(homedir(), 'Desktop/CherryOnTop-bench/governor/runs');
const rows = [];
for (const r of readdirSync(ROOT).filter((d) => d.startsWith('g-')).sort()) {
  const dir = join(ROOT, r);
  if (!existsSync(join(dir, 'meta.json'))) continue;
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const grade = existsSync(join(dir, 'grade.json')) ? JSON.parse(readFileSync(join(dir, 'grade.json'), 'utf8')) : null;
  const db = new Database(join(dir, 'state.db'), { readonly: true });
  const tok = existsSync(join(dir, 'tokens.json')) ? JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf8')) : { rows: [] };
  const usage = (tok.rows ?? []).map((u) => ({ role: u.role, n: u.dispatches, usd: u.costUsd, turns: u.turns }));
  const q = (sql) => { try { return db.prepare(sql).all(); } catch (e) { return [{ error: String(e) }]; } };
  const packets = q("select value from memory where kind='decision_packet'").map((x) => JSON.parse(x.value));
  const ev = (t) => q(`select count(*) n from events where type='${t}'`)[0]?.n ?? 0;
  rows.push({
    run: r, task: meta.task_id, arm: meta.arm, rep: meta.rep, state: meta.outcome.state, wallMin: (meta.wallMs ?? 0) / 60000,
    files: meta.changed_files.length,
    // An empty patch cannot resolve anything; the harness emits no report for one.
    resolved: grade?.resolved ?? (meta.changed_files.length === 0 ? false : null),
    usage, packets: packets.length,
    chosen: packets.map((p) => p.chosen.id), faults: packets.flatMap((p) => p.candidates.flatMap((c) => c.reasonCodes.filter((x) => x.startsWith('fault:')))).length,
    interventionsCarried: ev('governor.intervention_carried'), validations: ev('validation.result'),
    experiences: q("select count(*) n from memory where kind='causal_experience'")[0]?.n ?? 0,
    // Did any dispatch prompt carry text the governor added? (captured Job specs)
    governorTextJobs: readdirSync(join(dir, 'jobs')).filter((f) => /intervention-proposals|Advisory from the runtime/.test(readFileSync(join(dir, 'jobs', f), 'utf8'))).length,
    // The pre-existing budget bug (see the 2026-10-01 pilot): the market finds no feasible execution candidate.
    noFeasibleCandidate: q("select payload from events where type='decision.receipt'").some((x) => String(x.payload).includes('no execution candidate is feasible')),
  });
  db.close();
}
writeFileSync(join(ROOT, '..', 'collected.json'), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows.map(({ usage, chosen, ...r }) => ({ ...r, usd: usage.reduce((s, u) => s + (u.usd ?? 0), 0).toFixed(3), turns: usage.reduce((s, u) => s + (u.turns ?? 0), 0), dispatches: usage.reduce((s, u) => s + u.n, 0), chosen: [...new Set(chosen)].join(',') })), null, 0).replace(/},{/g, '},\n{'));
