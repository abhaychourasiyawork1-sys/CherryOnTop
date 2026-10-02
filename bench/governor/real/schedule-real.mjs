#!/usr/bin/env node
/** Arm B's frozen run order: per task H0 r1, H4 r1, H4 r2, H0 r2 (drift cannot
 *  line up with one arm), dealt round-robin onto `lanes` parallel lanes, each
 *  lane on its own ports. Resumable: a finished run is never repeated. */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG = JSON.parse(readFileSync(join(import.meta.dirname, 'config.json'), 'utf8'));
// --h26: the H2.6 pilot (bench/governor/h26/DESIGN.md §8): the 40 frozen
// instances, one run each, all under the experiment config.
// H26_CONFIG names another config: one with `validation` set is the
// engineering validation, each instance run once per arm (h26ctl, h26),
// the arm order alternating by instance so drift cannot line up with an arm.
const H26 = process.argv[2] === '--h26'
  ? JSON.parse(readFileSync(process.env.H26_CONFIG ?? join(import.meta.dirname, '..', 'h26', 'config.json'), 'utf8')) : null;
const ROOT = (H26 ? H26.pilot.benchRoot : CONFIG.benchRoot).replace('~', homedir());
const LANES = H26 ? H26.pilot.lanes : CONFIG.lanes;
const order = [['H0', 1], ['H4', 1], ['H4', 2], ['H0', 2]];
const schedule = [];
let i = 0;
if (H26) {
  if (H26.validation) {
    H26.pilot.instances.forEach((inst, k) => {
      for (const arm of k % 2 === 0 ? ['h26ctl', 'h26'] : ['h26', 'h26ctl']) schedule.push({ runId: `v-${inst}-${arm}`, task: inst, arm, rep: 1, lane: i++ % LANES });
    });
  } else {
    for (const inst of H26.pilot.instances) schedule.push({ runId: `h26-${inst}`, task: inst, arm: 'h26', rep: 1, lane: i++ % LANES });
  }
  // The instance cache the runner reads, from the local SWE-bench dataset.
  mkdirSync(join(ROOT, 'instances'), { recursive: true });
  const missing = H26.pilot.instances.filter((id) => !existsSync(join(ROOT, 'instances', `${id}.json`)));
  if (missing.length > 0) {
    const py = join(import.meta.dirname, '..', '..', '..', '.swebench', 'bin', 'python');
    const code = `import json,sys\nfrom datasets import load_dataset\nwant=set(sys.argv[2:])\nfor r in load_dataset('princeton-nlp/SWE-bench_Verified', split='test'):\n  if r['instance_id'] in want: json.dump(r, open(sys.argv[1]+'/'+r['instance_id']+'.json','w'))`;
    execFileSync(py, ['-c', code, join(ROOT, 'instances'), ...missing], { stdio: 'inherit' });
  }
} else {
  for (const t of CONFIG.tasks) for (const [arm, rep] of order) schedule.push({ runId: `g-${t.id}-${arm}-r${rep}`, task: t.id, arm, rep, lane: i++ % CONFIG.lanes });
}
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
await Promise.all(Array.from({ length: LANES }, (_, n) => lane(n)));
console.log('schedule complete');
