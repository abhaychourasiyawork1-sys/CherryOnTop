#!/usr/bin/env node
/** The frozen run order, and the loop that executes it.
 *  Per task the arms are interleaved A B B A (baseline, candidate, candidate,
 *  baseline) so a drifting provider or machine does not line up with one arm.
 *  Resumable: a run whose meta.json exists is skipped, never repeated — a rerun
 *  would be a second sample the schedule never promised. */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const CONFIG = JSON.parse(readFileSync(join(import.meta.dirname, 'config.json'), 'utf8'));
const ROOT = CONFIG.benchRoot.replace('~', homedir());
const order = [['baseline', 1], ['candidate', 1], ['candidate', 2], ['baseline', 2]];
const schedule = [];
let slot = 0;
for (const t of CONFIG.tasks) for (const [arm, rep] of order) {
  schedule.push({ runId: `p-${t.id}-${arm}-r${rep}`, task: t.id, instance: t.instance, arm, rep, slot: slot++ });
}
mkdirSync(ROOT, { recursive: true });
const file = join(ROOT, 'schedule.json');
if (!existsSync(file)) writeFileSync(file, JSON.stringify({ frozenAt: new Date().toISOString(), schedule }, null, 2));
if (process.argv[2] === '--print') { console.log(schedule.map((s) => `${s.slot}\t${s.runId}`).join('\n')); process.exit(0); }

for (const s of schedule) {
  if (existsSync(join(ROOT, 'runs', s.runId, 'meta.json'))) { console.log(`skip ${s.runId} (done)`); continue; }
  console.log(`[${new Date().toISOString()}] RUN ${s.runId}`);
  const r = spawnSync('node', [join(import.meta.dirname, 'run-one.mjs'), s.runId, s.task, s.arm, String(s.rep), String(s.slot)], { stdio: ['ignore', 'inherit', 'inherit'] });
  console.log(`[${new Date().toISOString()}] END ${s.runId} exit=${r.status}`);
}
console.log('schedule complete');
