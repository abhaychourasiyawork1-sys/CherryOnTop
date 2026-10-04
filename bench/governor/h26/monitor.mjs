// H2.6 interim monitor (bench/governor/h26/DESIGN.md §7). Offline, over the
// collected rows; only the four scheduled looks can produce a conclusion.
//   node bench/governor/h26/monitor.mjs <runsDir>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, collect, lookPrefix, outcomeY, welch, safety, Phi } from './analysis.mjs';

const N_MAX = CONFIG.nMax;
const LOOKS = CONFIG.looks;
const C = CONFIG.efficacyBoundaries;
const { theta: THETA, cpMin: CP_MIN, looks: FUTILITY_LOOKS } = CONFIG.futility;
const { constant: SAFETY_Z, marginResolution: MARGIN } = CONFIG.safety;

export { lookPrefix };

export function conditionalPower(z, t) {
  return 1 - Phi((C[3] - Math.abs(z) * Math.sqrt(t) - THETA * (1 - t)) / Math.sqrt(1 - t));
}

/** The verdict at scheduled look k, or null when the data have not reached it. */
export function evaluateLook(rows, k) {
  const prefix = lookPrefix(rows, k);
  if (!prefix) return null;
  const a = prefix.filter((r) => r.Z === 'available').map(outcomeY);
  const m = prefix.filter((r) => r.Z === 'masked').map(outcomeY);
  const t = LOOKS[k - 1] / N_MAX;
  const w = welch(a, m);
  const s = safety(prefix);
  const efficacy = Math.abs(w.z) >= C[k - 1];
  const harm = s.z <= -SAFETY_Z && s.delta <= -MARGIN;
  const benefitForWithholding = s.z >= SAFETY_Z && s.delta >= MARGIN;
  const cp = FUTILITY_LOOKS.includes(k) ? conditionalPower(w.z, t) : null;
  const futility = cp !== null && cp < CP_MIN;
  return {
    look: k, t, na: a.length, nm: m.length, z: w.z, estimate: w.diff, se: w.se, boundary: C[k - 1],
    efficacy: efficacy ? (w.z < 0 ? 'availability lowers cost-to-go' : 'availability raises cost-to-go') : null,
    safety: { ...s, harmStop: harm, benefitForWithholdingStop: benefitForWithholding },
    conditionalPower: cp, futilityStop: futility,
    action: efficacy ? 'stop: efficacy' : harm ? 'stop: harm (safety, not efficacy)' : benefitForWithholding
      ? 'stop: benefit-for-withholding (safety, not efficacy)' : futility ? 'stop: futility (non-binding)' : (k === LOOKS.length ? 'final' : 'continue'),
  };
}

/** Every look the data have reached, in order, up to the first that stops. */
export function monitor(rows) {
  const out = [];
  for (let k = 1; k <= LOOKS.length; k++) {
    const v = evaluateLook(rows, k);
    if (!v) break;
    out.push(v);
    if (v.action.startsWith('stop') || v.action === 'final') break;
  }
  return out;
}

/** Freeze each reached look's data set: written once, and every later run of
 *  the monitor must reproduce it exactly. */
export function freezeLooks(rows, dir) {
  for (let k = 1; k <= LOOKS.length; k++) {
    const prefix = lookPrefix(rows, k);
    if (!prefix) break;
    const file = join(dir, `look-${k}.json`);
    const ids = prefix.map((r) => r.rootTaskId);
    if (!existsSync(file)) writeFileSync(file, JSON.stringify({ look: k, frozenAt: new Date().toISOString(), rootTaskIds: ids }, null, 1));
    else if (JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).rootTaskIds) !== JSON.stringify(ids)) throw new Error(`look ${k}: data differ from the frozen snapshot ${file}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('monitor.mjs')) {
  const rows = collect(process.argv[2]).flatMap((r) => r.rows);
  const i = process.argv.indexOf('--snapshots');
  if (i > 0) freezeLooks(rows, process.argv[i + 1]);
  console.log(JSON.stringify(monitor(rows), null, 1));
}
