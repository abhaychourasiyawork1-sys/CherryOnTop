#!/usr/bin/env node
/** Arm B's frozen run order: per task H0 r1, H4 r1, H4 r2, H0 r2 (drift cannot
 *  line up with one arm), dealt round-robin onto `lanes` parallel lanes, each
 *  lane on its own ports. Resumable: a finished run is never repeated. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG = JSON.parse(readFileSync(join(import.meta.dirname, 'config.json'), 'utf8'));
const ROOT = CONFIG.benchRoot.replace('~', homedir());
const order = [['H0', 1], ['H4', 1], ['H4', 2], ['H0', 2]];
const schedule = [];
let i = 0;
for (const t of CONFIG.tasks) for (const [arm, rep] of order) schedule.push({ runId: `g-${t.id}-${arm}-r${rep}`, task: t.id, arm, rep, lane: i++ % CONFIG.lanes });
mkdirSync(join(ROOT, 'runs'), { recursive: true });
const file = join(ROOT, 'schedule.json');
if (!existsSync(file)) writeFileSync(file, JSON.stringify({ frozenAt: new Date().toISOString(), schedule }, null, 2));

async function lane(n) {
  for (const s of schedule.filter((x) => x.lane === n)) {
    if (existsSync(join(ROOT, 'runs', s.runId, 'meta.json'))) { console.log(`skip ${s.runId}`); continue; }
    console.log(`[${new Date().toISOString()}] RUN ${s.runId} (lane ${n})`);
    const code = await new Promise((resolve) => spawn('node', [join(import.meta.dirname, 'run-real.mjs'), s.runId, s.task, s.arm, String(s.rep), String(n)], { stdio: ['ignore', 'inherit', 'inherit'] }).on('exit', resolve));
    console.log(`[${new Date().toISOString()}] END ${s.runId} exit=${code}`);
  }
}
await Promise.all(Array.from({ length: CONFIG.lanes }, (_, n) => lane(n)));
console.log('schedule complete');
