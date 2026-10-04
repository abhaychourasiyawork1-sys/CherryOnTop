// Builds the benchmark report page from the raw summaries. Every number and
// every chart mark comes from summary.json / collected.json — nothing typed in.
//
//   node bench/governor/report.mjs <summaryV1> <summaryV2> <collectedArmB> <out.html>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [, , V1P, V2P, ARMB, OUT] = process.argv;
const s = JSON.parse(readFileSync(V1P, 'utf8'));
const v2 = existsSync(V2P) ? JSON.parse(readFileSync(V2P, 'utf8')) : null;
const armB = existsSync(ARMB) ? JSON.parse(readFileSync(ARMB, 'utf8')) : [];
const B = s.passB; const A = s.passA;
const VARS = ['H0', 'H1', 'H2', 'H3a', 'H3b', 'H3+AH', 'H4'];
const NAMES = {
  H0: 'No governor', H1: 'Economic market', H2: '+ risk & option', H3a: '+ discovery & proposals',
  H3b: '+ composition', 'H3+AH': '+ adaptive horizon', H4: '+ learning (full)',
};

const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const sp = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`);
const pp = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)} pp`);
const k = (x) => (x == null ? '—' : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : `${Math.round(x / 1000)}k`);
const usd = (x) => (x == null ? '—' : `$${x.toFixed(3)}`);
const ci = (c, f = sp) => (c ? `${f(c[0])} … ${f(c[1])}` : '—');
const num = (x, d = 2) => (x == null ? '—' : x.toFixed(d));

// ---------------------------------------------------------------------------
// Chart helpers (SVG, drawn to one scale per chart)
// ---------------------------------------------------------------------------
function scale(d0, d1, r0, r1) { const f = (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0); f.d = [d0, d1]; return f; }
function ticks(lo, hi, n = 5) {
  const step0 = (hi - lo) / n; const mag = 10 ** Math.floor(Math.log10(Math.abs(step0) || 1));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => (hi - lo) / m <= n) ?? mag * 10;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10)); return out;
}
const tip = (t) => `data-tip="${esc(t)}" tabindex="0"`;

function axesY(y, x0, x1, fmt, label) {
  const t = ticks(...y.d);
  return t.map((v) => `<line class="grid" x1="${x0}" x2="${x1}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${x0 - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('')
    + (label ? `<text class="axlabel" x="${x0}" y="14">${esc(label)}</text>` : '');
}
function axesX(x, y0, fmt, label, W) {
  const t = ticks(...x.d);
  return t.map((v) => `<text class="tick" x="${x(v)}" y="${y0 + 16}" text-anchor="middle">${fmt(v)}</text>`).join('')
    + `<line class="axis" x1="${x(x.d[0])}" x2="${x(x.d[1])}" y1="${y0}" y2="${y0}"/>`
    + (label ? `<text class="axlabel" x="${W - 10}" y="${y0 + 32}" text-anchor="end">${esc(label)}</text>` : '');
}

/** Forest plot: relative CPS delta with 95% CI per comparison. */
function forest(rows, title) {
  const W = 640; const rowH = 30; const L = 190; const R = W - 20; const H = 44 + rows.length * rowH;
  const lo = Math.min(-0.06, ...rows.map((r) => r.ci[0])); const hi = Math.max(0.06, ...rows.map((r) => r.ci[1]));
  const x = scale(lo, hi, L, R);
  const body = rows.map((r, i) => {
    const yy = 30 + i * rowH + rowH / 2;
    const cls = r.ci[1] < 0 ? 'good' : r.ci[0] > 0 ? 'bad' : 'flat';
    return `<g ${tip(`${r.label}: CPS ${sp(r.v)} (95% CI ${ci(r.ci)})`)}><text class="rowlabel" x="${L - 10}" y="${yy + 4}" text-anchor="end">${esc(r.label)}</text>
      <line class="ci ${cls}" x1="${x(r.ci[0])}" x2="${x(r.ci[1])}" y1="${yy}" y2="${yy}"/>
      <circle class="pt ${cls}" cx="${x(r.v)}" cy="${yy}" r="5"/>
      <text class="val" x="${R}" y="${yy - 8}" text-anchor="end">${sp(r.v)}</text></g>`;
  }).join('');
  return `<figure><figcaption>${esc(title)}</figcaption><div class="chartwrap"><svg viewBox="0 0 ${W} ${H + 30}" role="img" aria-label="${esc(title)}">
    ${ticks(lo, hi, 6).map((v) => `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="24" y2="${H}"/><text class="tick" x="${x(v)}" y="${H + 16}" text-anchor="middle">${sp(v, 0)}</text>`).join('')}
    <line class="zero" x1="${x(0)}" x2="${x(0)}" y1="20" y2="${H}"/>
    <text class="axlabel" x="${R}" y="${H + 32}" text-anchor="end">change in cost per successful task (left = cheaper)</text>
    ${body}</svg></div></figure>`;
}

function scatterLabeled(points, title, xl, yl, xf, yf) {
  const W = 640; const H = 340; const L = 70; const Rr = W - 30; const T = 30; const Bb = H - 46;
  const xs = points.map((p) => p.x); const ys = points.map((p) => p.y);
  const padx = (Math.max(...xs) - Math.min(...xs)) * 0.25 || 0.01; const pady = (Math.max(...ys) - Math.min(...ys)) * 0.3 || 1000;
  const x = scale(Math.min(...xs) - padx, Math.max(...xs) + padx, L, Rr);
  const y = scale(Math.min(...ys) - pady, Math.max(...ys) + pady, Bb, T);
  const used = [];
  const marks = points.map((p) => {
    let ly = y(p.y) - 10; while (used.some((u) => Math.abs(u.y - ly) < 13 && Math.abs(u.x - x(p.x)) < 70)) ly -= 13; used.push({ x: x(p.x), y: ly });
    return `<g ${tip(`${p.label}: ${xl} ${xf(p.x)}, ${yl} ${yf(p.y)}`)}><circle class="pt ${p.cls ?? ''}" cx="${x(p.x)}" cy="${y(p.y)}" r="6"/>
      <text class="dlabel" x="${x(p.x) + 9}" y="${ly}">${esc(p.label)}</text></g>`;
  }).join('');
  return `<figure><figcaption>${esc(title)}</figcaption><div class="chartwrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
    ${axesY(y, L, Rr, yf, yl)}${axesX(x, Bb, xf, xl, W)}${marks}</svg></div></figure>`;
}

function dotStrip(deltas, title) {
  const W = 640; const H = 260; const L = 70; const Rr = W - 20; const T = 30; const Bb = H - 40;
  const sorted = [...deltas].sort((a, b) => a.delta - b.delta);
  const lo = Math.min(...sorted.map((d) => d.delta)); const hi = Math.max(...sorted.map((d) => d.delta));
  const y = scale(Math.min(lo, -1000), Math.max(hi, 1000), Bb, T);
  const x = scale(0, sorted.length - 1, L + 4, Rr - 4);
  const bw = Math.max(1.5, (Rr - L) / sorted.length - 1.5);
  const bars = sorted.map((d, i) => {
    const y0 = y(0); const y1 = y(d.delta);
    return `<rect class="bar ${d.delta < 0 ? 'good' : d.delta > 0 ? 'bad' : 'flat'}" x="${x(i) - bw / 2}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.max(1, Math.abs(y1 - y0))}" ${tip(`${d.taskId} (${d.bucket}): ${d.delta >= 0 ? '+' : '−'}${k(Math.abs(d.delta))} tokens`)}/>`;
  }).join('');
  return `<figure><figcaption>${esc(title)}</figcaption><div class="chartwrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
    ${axesY(y, L, Rr, (v) => `${v >= 0 ? '+' : '−'}${k(Math.abs(v))}`, 'H4 − H0 tokens per task (reps averaged)')}
    <line class="zero" x1="${L}" x2="${Rr}" y1="${y(0)}" y2="${y(0)}"/>${bars}
    <text class="axlabel" x="${Rr}" y="${Bb + 26}" text-anchor="end">120 tasks, sorted by delta</text></svg></div></figure>`;
}

function scatterCloud(pts, title, xl, yl, xf, yf, clipX) {
  const W = 640; const H = 320; const L = 70; const Rr = W - 20; const T = 30; const Bb = H - 46;
  const P = pts.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const qx = (q) => [...P.map((p) => p.x)].sort((a, b) => a - b)[Math.floor(q * (P.length - 1))];
  const xlo = clipX ? qx(0.02) : Math.min(...P.map((p) => p.x)); const xhi = clipX ? qx(0.98) : Math.max(...P.map((p) => p.x));
  const ys = P.map((p) => p.y).sort((a, b) => a - b); const ylo = ys[Math.floor(0.02 * (ys.length - 1))]; const yhi = ys[Math.floor(0.98 * (ys.length - 1))];
  const x = scale(Math.min(xlo, 0), xhi, L, Rr); const y = scale(Math.min(ylo, 0), Math.max(yhi, 0), Bb, T);
  const clamp = (v, f) => Math.max(Math.min(f.d[0], f.d[1]), Math.min(Math.max(f.d[0], f.d[1]), v));
  const dots = P.map((p) => `<circle class="cloud ${p.y > 0 ? 'good' : 'bad'}" cx="${x(clamp(p.x, x))}" cy="${y(clamp(p.y, y))}" r="2.6"/>`).join('');
  return `<figure><figcaption>${esc(title)}</figcaption><div class="chartwrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
    ${axesY(y, L, Rr, yf, yl)}${axesX(x, Bb, xf, xl, W)}<line class="zero" x1="${L}" x2="${Rr}" y1="${y(0)}" y2="${y(0)}"/>${dots}</svg></div></figure>`;
}

function lines(series, title, yl, yf) {
  const W = 640; const H = 300; const L = 70; const Rr = W - 70; const T = 30; const Bb = H - 46;
  const all = series.flatMap((s) => s.pts.map((p) => p.y)).filter(Number.isFinite);
  const y = scale(Math.min(...all) * 0.9, Math.max(...all) * 1.05, Bb, T);
  const xs = series[0].pts.map((p) => p.x); const x = scale(Math.min(...xs), Math.max(...xs), L, Rr);
  const paths = series.map((sr) => {
    const pts = sr.pts.filter((p) => Number.isFinite(p.y));
    const last = pts.at(-1);
    return `<path class="line ${sr.cls}" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.x)},${y(p.y)}`).join('')}"/>`
      + pts.map((p) => `<circle class="pt ${sr.cls}" cx="${x(p.x)}" cy="${y(p.y)}" r="4" ${tip(`${sr.label}, tasks ${p.x}–${p.x + 11}: ${yf(p.y)}`)}/>`).join('')
      + `<text class="dlabel" x="${x(last.x) + 8}" y="${y(last.y) + (sr.cls === 'b' ? 14 : -4)}">${esc(sr.label)}</text>`;
  }).join('');
  return `<figure><figcaption>${esc(title)}</figcaption><div class="chartwrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
    ${axesY(y, L, Rr, yf, yl)}${axesX(x, Bb, (v) => v, 'prior tasks in the stream', W)}${paths}</svg></div></figure>`;
}

function binnedBars(pts, title) {
  const bins = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
  const rows = bins.slice(0, -1).map((lo, i) => {
    const inBin = pts.filter((p) => p.x >= lo && p.x < bins[i + 1]);
    return { lo, hi: bins[i + 1], n: inBin.length, mean: inBin.length ? inBin.reduce((s, p) => s + p.y, 0) / inBin.length : 0 };
  });
  const W = 640; const H = 280; const L = 70; const Rr = W - 20; const T = 30; const Bb = H - 46;
  const lo = Math.min(0, ...rows.map((r) => r.mean)); const hi = Math.max(0, ...rows.map((r) => r.mean));
  const y = scale(lo * 1.15 - 1, hi * 1.15 + 1, Bb, T);
  const bw = (Rr - L) / rows.length;
  const bars = rows.map((r, i) => `<rect class="bar ${r.mean > 0 ? 'good' : 'bad'}" x="${L + i * bw + 6}" y="${Math.min(y(0), y(r.mean))}" width="${bw - 12}" height="${Math.max(1, Math.abs(y(r.mean) - y(0)))}" ${tip(`Commitment ${Math.round(r.lo * 100)}–${Math.round(Math.min(1, r.hi) * 100)}% of the run: mean realized saving ${r.mean >= 0 ? '+' : '−'}${k(Math.abs(r.mean))} tokens per intervention (n=${r.n})`)}/>
    <text class="tick" x="${L + i * bw + bw / 2}" y="${Bb + 16}" text-anchor="middle">${Math.round(r.lo * 100)}–${Math.round(Math.min(1, r.hi) * 100)}%</text>
    <text class="val" x="${L + i * bw + bw / 2}" y="${(r.mean >= 0 ? y(r.mean) - 6 : y(r.mean) + 14)}" text-anchor="middle">n=${r.n}</text>`).join('');
  return `<figure><figcaption>${esc(title)}</figcaption><div class="chartwrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
    ${axesY(y, L, Rr, (v) => `${v >= 0 ? '+' : '−'}${k(Math.abs(v))}`, 'mean realized saving per intervention (tokens)')}
    <line class="zero" x1="${L}" x2="${Rr}" y1="${y(0)}" y2="${y(0)}"/>${bars}
    <text class="axlabel" x="${Rr}" y="${Bb + 32}" text-anchor="end">when in the run the intervention happened (share of steps)</text></svg></div></figure>`;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
function dashboard(sec, label) {
  const head = ['Variant', 'Success', 'Tokens / success', 'Cost / success', 'Autonomy', 'Interventions / task', 'Prevention debt / task', 'Confirmed miss', 'Discovery tok / task', 'Overhead'];
  const body = VARS.map((v) => {
    const m = sec.variants[v];
    return `<tr><th scope="row"><span class="vtag">${v}</span> ${esc(NAMES[v])}</th><td>${pct(m.successRate)}</td><td>${k(m.tokensPerSuccess)}</td><td>${usd(m.cpsUsd)}</td><td>${pct(m.autonomyRatio)}</td><td>${num(m.interventionsPerTask)}</td><td>${k(m.preventionDebtPerTask)}</td><td>${pct(m.confirmedMissRate)}</td><td>${Math.round(m.discoveryTokensPerTask)}</td><td>${pct(m.governorOverheadRatio)}</td></tr>`;
  }).join('');
  return `<div class="tablewrap"><table><caption>${esc(label)}</caption><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function comparisons(sec, label) {
  const row = (name, p) => `<tr><th scope="row">${name}</th><td class="${p.cpsRelDeltaCI[1] < 0 ? 'good' : p.cpsRelDeltaCI[0] > 0 ? 'bad' : ''}">${sp(p.cpsRelDelta)}</td><td>${ci(p.cpsRelDeltaCI)}</td><td class="${p.successDeltaCI[0] > 0 ? 'good' : p.successDeltaCI[1] < 0 ? 'bad' : ''}">${pp(p.successDelta)}</td><td>${ci(p.successDeltaCI, pp)}</td><td>${p.contingency.both} / ${p.contingency.onlyA} / ${p.contingency.onlyB} / ${p.contingency.neither}</td></tr>`;
  const vsH0 = VARS.slice(1).map((v) => row(`${v} vs H0`, sec.vsH0[v])).join('');
  const vsPrev = VARS.slice(1).map((v) => row(`${v} vs ${sec.vsPrevious[v].previous}`, sec.vsPrevious[v])).join('');
  return `<div class="tablewrap"><table><caption>${esc(label)}</caption><thead><tr><th scope="col">Comparison (paired by task)</th><th scope="col">CPS Δ</th><th scope="col">95% CI</th><th scope="col">Success Δ</th><th scope="col">95% CI</th><th scope="col">Both / only base / only variant / neither</th></tr></thead>
    <tbody>${vsH0}<tr class="sep"><td colspan="6"></td></tr>${vsPrev}</tbody></table></div>`;
}

const verdictClass = (v) => (v.startsWith('retain') ? 'good' : v === 'remove' ? 'bad' : 'warn');

// ---------------------------------------------------------------------------
const att = s.attribution;
const forestVsH0 = forest(VARS.slice(1).map((v) => ({ label: `${v} ${NAMES[v]}`, v: B.vsH0[v].cpsRelDelta, ci: B.vsH0[v].cpsRelDeltaCI })), 'Each variant against no governor (Pass B, 120 tasks × 3 reps)');
const forestStep = forest(att.map((a) => ({ label: a.mechanism.replace(' (+proposal lane)', '').replace(' (M2)', ''), v: a.cpsRelDelta, ci: a.cpsRelDeltaCI })), 'Each mechanism against the layer below it');

const plot1 = scatterLabeled(VARS.map((v) => ({ label: v, x: B.variants[v].successRate, y: B.variants[v].tokensPerSuccess, cls: v === 'H0' ? 'base' : v === 'H2' ? 'hi' : '' })),
  'Plot 1 — cost against success, one point per variant', 'validated ground-truth success', 'tokens per success', (x) => pct(x, 1), (y) => k(y));
const plot2 = dotStrip(B.vsH0.H4.perTaskTokenDelta, 'Plot 2 — where H4’s cost difference comes from, task by task');
const plot3 = scatterCloud(s.plots.interventionEconomics, 'Plot 3 — what the governor expected an intervention to save, against what it saved', 'expected saving (tokens)', 'realized saving, oracle re-run (tokens)', (v) => k(v), (v) => `${v >= 0 ? '+' : '−'}${k(Math.abs(v))}`, true);
const plot4 = scatterLabeled(s.plots.recallVsDiscovery.map((r) => ({ label: r.variant, x: r.discoveryTokensPerTask ?? 0, y: r.recallAt3 ?? 0, cls: r.variant === 'H3b' ? 'hi' : '' })),
  'Plot 4 — opportunity recall@3 against discovery spend', 'discovery tokens per task', 'OpportunityRecall@3', (x) => Math.round(x), (y) => pct(y, 0));
const plot5 = binnedBars(s.plots.preventionFrontier, 'Plot 5 — prevention timing: realized value of H4 interventions by when they happened');
const plot6 = lines([
  { label: 'cold (M0)', cls: 'a', pts: s.learningCurve.M0.map((b) => ({ x: b.priorTasks, y: b.tokensPerSuccess })) },
  { label: 'warm causal (M2)', cls: 'b', pts: s.learningCurve.M2.map((b) => ({ x: b.priorTasks, y: b.tokensPerSuccess })) },
], 'Plot 6 — learning curve: tokens per success over the task stream, H4', 'tokens per success, blocks of 12 tasks', (v) => k(v));

// Stress table
const stressRows = Object.entries(s.stress).map(([name, o]) => {
  const c = (v) => o[v];
  return `<tr><th scope="row">${esc(name.replace(/_/g, ' '))}</th>${['H0', 'H1', 'H3', 'H4'].map((v) => `<td>${pct(c(v).successRate, 0)} · ${c(v).tokensPerSuccess ? k(c(v).tokensPerSuccess) : k(c(v).tokensPerTask) + '/task'}</td>`).join('')}
    <td>${pct(o.H4.autonomyRatio, 0)} · ${num(o.H4.interventionsPerTask, 1)}</td><td>${pct(o.H4.governorOverheadRatio, 0)}</td><td class="${o.H4vsH0.cpsRelDeltaCI[1] < 0 ? 'good' : o.H4vsH0.cpsRelDeltaCI[0] > 0 ? 'bad' : ''}">${o.H4vsH0.tasks && Number.isFinite(o.H4vsH0.cpsRelDelta) ? `${sp(o.H4vsH0.cpsRelDelta)} <span class="muted">[${ci(o.H4vsH0.cpsRelDeltaCI)}]</span>` : '—'}</td></tr>`;
}).join('');

// Bucket table
const bucketRows = Object.entries(B.byBucket).map(([b, o]) => `<tr><th scope="row">${b}</th>${VARS.map((v) => `<td>${pct(o[v].successRate, 0)} · ${k(o[v].tokensPerSuccess)}</td>`).join('')}<td class="${o.H4vsH0.cpsRelDeltaCI[1] < 0 ? 'good' : o.H4vsH0.cpsRelDeltaCI[0] > 0 ? 'bad' : ''}">${sp(o.H4vsH0.cpsRelDelta)}</td></tr>`).join('');

// Agenticity / economics table
const agentRows = VARS.slice(1).map((v) => {
  const m = B.variants[v];
  return `<tr><th scope="row">${v}</th><td>${pct(m.autonomyRatio)}</td><td>${pct(m.zeroInterventionShare, 0)}</td><td>${pct(m.autonomousSuccessShare, 0)}</td><td>${num(m.evaluationsPerTask, 1)}</td><td>${m.horizonMean == null ? 'backoff' : `${num(m.horizonMean, 2)} / ${num(m.horizonMedian, 0)}`}</td><td>${m.interventionTruth ? pct(m.interventionTruth.productiveRate, 0) : '—'}</td><td>${m.interventionTruth ? num(m.interventionTruth.roi, 2) : '—'}</td><td>${m.interventionTruth ? k(m.interventionTruth.regretPerIntervention) : '—'}</td><td>${num(m.marketMsPerEvaluation, 3)} ms</td><td>${num(m.packetBytesPerTask / 1024, 0)} KB</td></tr>`;
}).join('');

// Memory
const mm = s.memory;
const memRows = Object.entries(mm.arms).map(([kk, m]) => `<tr><th scope="row">${kk}</th><td>${pct(m.successRate)}</td><td>${k(m.tokensPerSuccess)}</td><td>${pct(m.governorOverheadRatio)}</td><td>${k(m.replayTokensPerTask)}</td><td>${m.calibration ? num(m.calibration.brier, 3) : '—'}</td></tr>`).join('');

// Arm B
const armBy = (arm) => armB.filter((r) => r.arm === arm);
const armStats = (arm) => {
  const rows = armBy(arm); const graded = rows.filter((r) => r.resolved !== null);
  const usdSum = rows.reduce((s2, r) => s2 + r.usage.reduce((a, u) => a + (u.usd ?? 0), 0), 0);
  const solved = graded.filter((r) => r.resolved).length;
  return { n: rows.length, graded: graded.length, solved, usd: usdSum, perRun: rows.length ? usdSum / rows.length : null, perSolved: solved ? usdSum / solved : null,
    turns: rows.length ? rows.reduce((a, r) => a + r.usage.reduce((b, u) => b + (u.turns ?? 0), 0), 0) / rows.length : null,
    dispatches: rows.length ? rows.reduce((a, r) => a + r.usage.reduce((b, u) => b + (u.n ?? 0), 0), 0) / rows.length : null,
    packets: rows.reduce((a, r) => a + r.packets, 0), carried: rows.reduce((a, r) => a + r.interventionsCarried, 0),
    faults: rows.reduce((a, r) => a + (r.faults > 0 ? 1 : 0), 0), completed: rows.filter((r) => r.state === 'COMPLETE').length,
    textJobs: rows.reduce((a, r) => a + (r.governorTextJobs ?? 0), 0), budgetBug: rows.filter((r) => r.noFeasibleCandidate).length };
};
const bH0 = armStats('H0'); const bH4 = armStats('H4');
const armBRows = armB.map((r) => `<tr><th scope="row">${esc(r.task)} r${r.rep}</th><td><span class="vtag">${r.arm}</span></td><td>${esc(r.state)}</td><td>${r.resolved === null ? 'ungraded' : r.resolved ? 'resolved' : 'not resolved'}</td><td>$${r.usage.reduce((a, u) => a + (u.usd ?? 0), 0).toFixed(3)}</td><td>${r.usage.reduce((a, u) => a + (u.turns ?? 0), 0)}</td><td>${r.usage.reduce((a, u) => a + (u.n ?? 0), 0)}</td><td>${r.packets}</td><td>${[...new Set(r.chosen)].join(', ') || '—'}</td><td>${r.interventionsCarried}</td><td>${r.governorTextJobs ?? 0}</td></tr>`).join('');

// v2
const v2B = v2?.passB;
const v2rows = v2B ? ['H3b', 'H3+AH', 'H4'].map((v) => `<tr><th scope="row">${v}</th><td>${pct(B.variants[v].successRate)} → ${pct(v2B.variants[v].successRate)}</td><td>${k(B.variants[v].tokensPerSuccess)} → ${k(v2B.variants[v].tokensPerSuccess)}</td><td>${num(B.variants[v].evaluationsPerTask, 1)} → ${num(v2B.variants[v].evaluationsPerTask, 1)}</td><td>${pct(B.variants[v].autonomyRatio)} → ${pct(v2B.variants[v].autonomyRatio)}</td><td>${v === 'H3b' ? '—' : `${sp(v2B.vsPrevious[v].cpsRelDelta)} [${ci(v2B.vsPrevious[v].cpsRelDeltaCI)}]`}</td><td>${v === 'H3b' ? '—' : `${pp(v2B.vsPrevious[v].successDelta)} [${ci(v2B.vsPrevious[v].successDeltaCI, pp)}]`}</td></tr>`).join('') : '';

const L4 = s.learning;
const fp = s.fingerprint;
const h4 = B.variants.H4; const h2 = B.variants.H2; const h0 = B.variants.H0;

const html = `<title>Economic Governor Benchmark</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,500;6..72,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: a single reading column (lab notebook), wide figures and tables that scroll inside their own frame. */
:root{
  --bg:#f6f7f8; --surface:#ffffff; --ink:#15191d; --ink-2:#4a535c; --muted:#6c757e; --rule:#dde1e5; --grid:#e8ebee;
  --accent:#2a78d6; --accent-soft:#e3eefb; --base:#7a828a;
  --good:#1a7f4b; --good-soft:#e2f3ea; --bad:#c23b3a; --bad-soft:#fbe7e6; --warn:#9a6a00; --warn-soft:#fbf1da;
  --font-display:"Newsreader", "Iowan Old Style", Georgia, serif;
  --font-body:"IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  --font-mono:"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#121518; --surface:#1a1e22; --ink:#eef1f3; --ink-2:#b9c1c8; --muted:#8d969e; --rule:#2c3238; --grid:#252a2f;
  --accent:#3987e5; --accent-soft:#1c2c40; --base:#9aa2a9;
  --good:#3fbf7f; --good-soft:#163024; --bad:#ec6b6a; --bad-soft:#3a1d1d; --warn:#e0a83a; --warn-soft:#352a14; color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#121518; --surface:#1a1e22; --ink:#eef1f3; --ink-2:#b9c1c8; --muted:#8d969e; --rule:#2c3238; --grid:#252a2f;
  --accent:#3987e5; --accent-soft:#1c2c40; --base:#9aa2a9;
  --good:#3fbf7f; --good-soft:#163024; --bad:#ec6b6a; --bad-soft:#3a1d1d; --warn:#e0a83a; --warn-soft:#352a14; color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:15px/1.6 var(--font-body);padding-inline:16px;padding-block:28px 64px}
main{max-width:980px;margin:0 auto;display:grid;gap:44px}
.prose{max-width:68ch}
h1,h2,h3{font-family:var(--font-display);font-weight:600;text-wrap:balance;line-height:1.2;margin:0}
h1{font-size:2.3rem;letter-spacing:-.01em}
h2{font-size:1.55rem;padding-bottom:6px;border-bottom:1px solid var(--rule)}
h3{font-size:1.15rem;margin-top:8px}
p{margin:0}
section{display:grid;gap:16px;min-width:0}
.eyebrow{font:500 .72rem/1 var(--font-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.meta{font:.8rem/1.5 var(--font-mono);color:var(--muted)}
.lede{font-size:1.05rem;color:var(--ink-2);max-width:70ch}
.verdict{background:var(--surface);border:1px solid var(--rule);border-radius:10px;padding:20px 22px;display:grid;gap:10px}
.verdict dl{display:grid;grid-template-columns:minmax(150px,max-content) 1fr;gap:8px 18px;margin:0}
.verdict dt{font:600 .78rem/1.5 var(--font-mono);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding-top:2px}
.verdict dd{margin:0}
.verdict .final dd{font-weight:600}
@media (max-width:560px){.verdict dl{grid-template-columns:1fr}.verdict dd{margin-bottom:6px}}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.tile{background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:14px 16px;display:grid;gap:4px;min-width:0}
.tile .n{font:500 1.5rem/1.1 var(--font-mono);font-variant-numeric:tabular-nums}
.tile .l{font-size:.82rem;color:var(--ink-2)}
.tablewrap,.chartwrap{overflow-x:auto;min-width:0}
table{border-collapse:collapse;width:100%;font-size:.86rem;font-variant-numeric:tabular-nums;background:var(--surface);border:1px solid var(--rule)}
caption{text-align:left;font:600 .8rem/1.4 var(--font-mono);color:var(--muted);padding:0 0 8px;text-transform:uppercase;letter-spacing:.05em}
th,td{padding:7px 10px;border-bottom:1px solid var(--grid);text-align:right;white-space:nowrap;vertical-align:top}
th[scope=row],thead th:first-child{text-align:left}
thead th{font-weight:600;color:var(--ink-2);background:var(--bg);border-bottom:1px solid var(--rule);white-space:normal;min-width:70px}
tr.sep td{padding:2px;background:var(--bg)}
td.good{color:var(--good);font-weight:600} td.bad{color:var(--bad);font-weight:600} td.warn{color:var(--warn);font-weight:600}
.wrap td,.wrap th{white-space:normal}
.vtag{font:500 .76rem/1 var(--font-mono);background:var(--accent-soft);color:var(--ink);padding:2px 6px;border-radius:4px}
.pill{font:600 .74rem/1 var(--font-mono);padding:3px 8px;border-radius:99px;display:inline-block;white-space:nowrap}
.pill.good{background:var(--good-soft);color:var(--good)} .pill.bad{background:var(--bad-soft);color:var(--bad)} .pill.warn{background:var(--warn-soft);color:var(--warn)}
.muted{color:var(--muted);font-weight:400}
figure{margin:0;background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:14px 14px 8px;display:grid;gap:6px;min-width:0}
figcaption{font-weight:600;font-size:.92rem}
.figgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr));gap:16px}
.note{font-size:.84rem;color:var(--ink-2);max-width:72ch}
svg{width:100%;height:auto;display:block;min-width:440px}
svg text{fill:var(--muted);font:11px var(--font-mono)}
svg .tick{fill:var(--muted)} svg .axlabel{fill:var(--ink-2);font-size:11px}
svg .rowlabel{fill:var(--ink);font:12px var(--font-body)} svg .val{fill:var(--ink-2)} svg .dlabel{fill:var(--ink);font:500 12px var(--font-mono)}
svg .grid{stroke:var(--grid);stroke-width:1} svg .axis{stroke:var(--rule)} svg .zero{stroke:var(--ink-2);stroke-width:1;stroke-dasharray:3 3}
svg .ci{stroke-width:2.5;stroke-linecap:round} svg .ci.good{stroke:var(--good)} svg .ci.bad{stroke:var(--bad)} svg .ci.flat{stroke:var(--base)}
svg .pt{fill:var(--accent);stroke:var(--surface);stroke-width:2} svg .pt.good{fill:var(--good)} svg .pt.bad{fill:var(--bad)} svg .pt.flat{fill:var(--base)}
svg .pt.base{fill:var(--base)} svg .pt.hi{fill:var(--good)} svg .pt.a{fill:var(--base)} svg .pt.b{fill:var(--accent)}
svg .bar.good{fill:var(--good)} svg .bar.bad{fill:var(--bad)} svg .bar.flat{fill:var(--base)}
svg .cloud{fill-opacity:.45} svg .cloud.good{fill:var(--good)} svg .cloud.bad{fill:var(--bad)}
svg .line{fill:none;stroke-width:2} svg .line.a{stroke:var(--base)} svg .line.b{stroke:var(--accent)}
svg [data-tip]:focus{outline:none} svg [data-tip]:focus-visible circle,svg [data-tip]:focus-visible{stroke:var(--ink);stroke-width:2}
#tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--bg);font:12px/1.4 var(--font-mono);padding:6px 9px;border-radius:5px;max-width:320px;z-index:9}
ul.tight{margin:0;padding-left:20px;display:grid;gap:5px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:14px 16px;display:grid;gap:6px;min-width:0}
.card h3{margin:0;font-size:1rem}
.card p,.card li{font-size:.88rem;color:var(--ink-2)}
code{font:.85em var(--font-mono);background:var(--accent-soft);padding:1px 4px;border-radius:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
<div id="tip" hidden></div>
<main>
<header style="display:grid;gap:10px">
  <span class="eyebrow">CherryOnTop · feat/economic-action-market · ${esc(s.generation)}</span>
  <h1>Economic Governor Benchmark</h1>
  <p class="lede">An Economic Governor was built around the frontier agent, following plan.md: risk-aware pricing, autonomy horizon, candidate discovery, composition and counterfactual learning. It was then benchmarked under benchmarking-plan.md, in two arms: a pre-registered simulated agent world driven by the real compiled governor (5,784 runs), and 20 real Haiku runs on SWE-bench Verified.</p>
  <p class="meta">Harness ${esc(fp?.harness ?? '')} · config ${esc(fp?.config ?? '')} · sim ${esc(fp?.sim ?? '')} · pre-registration tag governor-bench-prereg · node ${esc(fp?.node ?? '')}</p>
</header>

<section aria-labelledby="verdict">
  <h2 id="verdict">Verdict</h2>
  <div class="verdict"><dl>
    <dt>What changed</dt><dd>The market can now price downstream failure, look for missing interventions, compose two of them, decide when to look, and learn from its misses. The agent stays in charge of the work; the market still makes every harness choice.</dd>
    <dt>What the benchmark says</dt><dd>The full governor (H4) costs ${sp(B.vsH0.H4.cpsRelDelta)} more per successful task than no governor [CI ${ci(B.vsH0.H4.cpsRelDeltaCI)}], with ${pp(B.vsH0.H4.successDelta)} success. In real runs it never acted, because the one look it gets is blocked.</dd>
    <dt>What worked</dt><dd>Risk-aware pricing (H2): ${sp(att[1].cpsRelDelta)} cost per success against the market alone [CI ${ci(att[1].cpsRelDeltaCI)}], with no loss of quality. Composition gave a small gain. Easy and over-intervention tasks stayed almost untouched.</dd>
    <dt>What did not</dt><dd>Discovery, the adaptive horizon and learning each added cost. Replays ate ${pct(h4.governorOverheadRatio, 0)} of H4's tokens for an ROI of ${num(L4.replayROI, 3)}. The governor rarely saw the useful intervention (recall@3 ${pct(h4.opportunityRecall?.at3, 0)}), and its failure probabilities ran about ${num((h4.calibration?.meanPredicted ?? 0) / (h4.calibration?.observedRate || 1), 1)}× too high.</dd>
    <dt class="final">Overall verdict</dt><dd class="final">Not yet a win. Keep risk pricing (H2), gate replay hard, fix the cold-start horizon, and do not promote discovery or learning until they pay for themselves. Agent autonomy was preserved.</dd>
  </dl></div>
  <div class="tiles">
    <div class="tile"><span class="n">${sp(att[1].cpsRelDelta)}</span><span class="l">H2 vs H1 cost per success, the one clean win</span></div>
    <div class="tile"><span class="n">${sp(B.vsH0.H4.cpsRelDelta)}</span><span class="l">H4 vs H0 cost per success</span></div>
    <div class="tile"><span class="n">${pp(B.vsH0.H4.successDelta)}</span><span class="l">H4 vs H0 ground-truth success</span></div>
    <div class="tile"><span class="n">${pct(h4.autonomyRatio, 0)}</span><span class="l">H4 steps left fully to the agent</span></div>
    <div class="tile"><span class="n">${bH4.carried} / ${bH4.n}</span><span class="l">real H4 runs with a carried-out intervention</span></div>
  </div>
</section>

<section aria-labelledby="impl">
  <h2 id="impl">What was implemented</h2>
  <p class="prose">All 22 features of plan.md, in <code>src/governor/</code> (9 modules), wired into the existing seams. The market (<code>chooseEconomicAction</code>) is still the only chooser; the governor only proposes candidates, prices them and decides when to look.</p>
  <div class="cols">
    <div class="card"><h3>L1 State & ledger</h3><ul class="tight"><li>DecisionPacket for every look: every candidate with source, status, price, provenance; no context bodies (packet.ts)</li><li>Estimate provenance gains <code>signal</code>; signal estimates no longer pose as deterministic</li><li>Per-source coverage records in the deep path</li></ul></div>
    <div class="card"><h3>L2 Governor (System-0)</h3><ul class="tight"><li>Risk snapshot, velocity, exposure by doubt dimension, irreversibility (risk.ts)</li><li>Prevention value and frontier; option exposure scales information value only</li><li>Autonomy horizon priced as look cost ÷ unobserved loss rate (horizon.ts)</li><li>Action-space uncertainty, dormant pool, discovery as a priced candidate, agent proposal lane (coverage.ts)</li><li>Action contracts, depth-2 SEQ/PAR with branch-and-bound (contracts.ts)</li></ul></div>
    <div class="card"><h3>L3 Market</h3><ul class="tight"><li>One new seam: a <code>valuation</code> that replaces the signal level of the estimate funnel. Hard constraints, the quality floor and the ranking are unchanged</li><li>Candidate snapshots for every candidate seen</li></ul></div>
    <div class="card"><h3>L4 Learning</h3><ul class="tight"><li>Miss taxonomy (12 labels, 8 outcome classes), failure backtrace, hindsight candidates (miss.ts)</li><li>Diagnostic ladder chosen by the market; replay on frozen packet copies; weak / supported / validated evidence (ladder.ts)</li><li>Causal memory with FOUND / NOT_FOUND / RULED_OUT, bounded decaying motifs, calibration (memory.ts)</li></ul></div>
  </div>
  <p class="note">Production default is H4. <code>ORG_GOVERNOR_ABLATION</code> selects benchmark variants only. Governor-originated interventions are carried out as advice the agent may ignore, plus one optional proposal invitation per run. Learning runs when a node ends and is persisted in the existing memory table, so no migration was needed. The P2 work-in-progress was kept and its 25 failing tests fixed; one of them was a real bug, where validation ignored the node's read-only grant.</p>
</section>

<section aria-labelledby="verified">
  <h2 id="verified">What was verified</h2>
  <div class="tablewrap"><table class="wrap"><thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Notes</th></tr></thead><tbody>
    <tr><th scope="row">TypeScript</th><td class="good">clean</td><td style="text-align:left">tsc --noEmit</td></tr>
    <tr><th scope="row">Unit suite</th><td class="good">2,879 / 2,879</td><td style="text-align:left">244 files; includes 56 governor tests (invariants: continue always available, proposers never choose, sources fail safely, replay cannot mutate packets, stale evidence cannot override newer, composition depth ≤ 2, H1 ≡ plain market)</td></tr>
    <tr><th scope="row">Integration (real kind cluster)</th><td class="good">28 pass · 3 skipped</td><td style="text-align:left">3 tests updated to the no-wording rules; none failed because of the governor (identical under H1)</td></tr>
    <tr><th scope="row">End-to-end · GUI</th><td class="good">1 / 1 · 264 / 264</td><td style="text-align:left">build passes</td></tr>
    <tr><th scope="row">Live daemon</th><td class="good">variant reaches it</td><td style="text-align:left">H0 runs wrote 0 packets, H4 runs wrote packets and causal experiences (Arm B)</td></tr>
  </tbody></table></div>
</section>

<section aria-labelledby="design">
  <h2 id="design">How it was benchmarked</h2>
  <p class="prose">Production calls the governor only at dispatch boundaries, and on a first dispatch that look is blocked by missing telemetry. So a real-model run can only show overhead and dormancy. The mechanism questions were answered in <strong>Arm A</strong>: a simulated agent world, governed by the real compiled governor at every step, with the state built by the same formulas production uses. Ground truth (latent failure modes, true intervention effects) is never visible to the governor. Its parameters, the analysis code and the decision rules were frozen in a git tag before the first run. <strong>Arm B</strong> is the reality check.</p>
  <ul class="tight prose">
    <li>Pass A: 24 tasks × 3 reps × 7 variants. Pass B: 120 tasks × 3 reps × 7 variants + memory arms (3,600 runs) with an oracle masked re-run for each of the first three interventions. Stress: 7 sets × 20 tasks × 3 reps × 4 variants.</li>
    <li>Common random numbers pair the variants. 95% CIs come from a 2,000-resample paired bootstrap over tasks. CPS is total tokens ÷ ground-truth successes, at $3 per million tokens.</li>
    <li>H4 learns along a chronological stream: 48 training tasks, 24 adaptation tasks, 48 held-out tasks with memory frozen.</li>
  </ul>
</section>

<section aria-labelledby="dash">
  <h2 id="dash">Results dashboard</h2>
  ${dashboard(B, 'Pass B (confirmatory) · 120 tasks × 3 reps')}
  ${comparisons(B, 'Pass B paired comparisons')}
  <div class="figgrid">${forestVsH0}${forestStep}</div>
  <details><summary>Pass A (rapid, 24 tasks × 3 reps)</summary>${dashboard(A, 'Pass A · 24 tasks × 3 reps')}${comparisons(A, 'Pass A paired comparisons')}</details>
</section>

<section aria-labelledby="attr">
  <h2 id="attr">Which mechanism earned its cost</h2>
  <div class="tablewrap"><table><caption>Mechanism attribution · Pass B incremental comparisons · pre-registered decision rules</caption><thead><tr><th scope="col">Mechanism</th><th scope="col">Net saving / task</th><th scope="col">CPS Δ [95% CI]</th><th scope="col">Quality Δ [95% CI]</th><th scope="col">Added governor cost / task</th><th scope="col">Decision</th></tr></thead><tbody>
  ${att.map((a) => `<tr><th scope="row">${esc(a.mechanism)} <span class="muted">${a.from}→${a.to}</span></th><td>${a.netSavingsTokensPerTask >= 0 ? '+' : '−'}${k(Math.abs(a.netSavingsTokensPerTask))}</td><td>${sp(a.cpsRelDelta)} <span class="muted">[${ci(a.cpsRelDeltaCI)}]</span></td><td>${pp(a.qualityDelta)} <span class="muted">[${ci(a.qualityDeltaCI, pp)}]</span></td><td>${k(a.addedCostTokensPerTask)}</td><td><span class="pill ${verdictClass(a.verdict)}">${esc(a.verdict)}</span></td></tr>`).join('')}
  </tbody></table></div>
  <p class="note">Net saving is tokens per task, positive meaning cheaper. Added governor cost is intervention, disruption, discovery and replay tokens. The economic market (H1) on its own is neutral to slightly worse, because production carries out only recover and file reads, and the rest of what it chooses is recorded without effect.</p>
</section>

<section aria-labelledby="plots">
  <h2 id="plots">The six plots</h2>
  <div class="figgrid">${plot1}${plot2}</div>
  <p class="note">Plot 1: only H2 (green) moves the right way, slightly cheaper at the same success. Plot 2: H4's extra cost is spread over many tasks plus a few large losses, not one outlier.</p>
  <div class="figgrid">${plot3}${plot4}</div>
  <p class="note">Plot 3: the governor's expected savings do not predict realized savings. Most interventions saved nothing or cost tokens (productive rate ${pct(h4.interventionTruth?.productiveRate, 0)} for H4). Plot 4: discovery raised recall@3 from ${pct(h2.opportunityRecall?.at3, 1)} to about ${pct(B.variants.H3b.opportunityRecall?.at3, 1)}, still far too low to matter. H4's learning pulled recall back down.</p>
  <div class="figgrid">${plot5}${plot6}</div>
  <p class="note">Plot 5: the realized value of an intervention against when in the run it happened; this is the timing test. Plot 6: the warm-memory curve lies on top of the cold one. Learning moved held-out cost by ${sp(mm.H4_M2_vs_M0_heldout.cpsRelDelta)} [${ci(mm.H4_M2_vs_M0_heldout.cpsRelDeltaCI)}].</p>
</section>

<section aria-labelledby="agency">
  <h2 id="agency">Was agentic autonomy preserved?</h2>
  <p class="prose">Yes, in the sense the plan cares about. The agent chose every action in every run. The governor never planned, never required approval for a tool call, and only offered advice that could be ignored. Health checks: on easy tasks H4 left ${pct(s.stress.easy.H4.autonomyRatio, 1)} of steps untouched, at ${pct(s.stress.easy.H4.governorOverheadRatio, 1)} overhead. On over-intervention tasks it was ${pct(s.stress.over_intervention.H4.autonomyRatio, 1)}. In real runs it intervened 0 times. The cost: on hard tasks the governor intervenes often and mostly unproductively, so the market's autonomy is cheap but its interventions are not yet good.</p>
  <div class="tablewrap"><table><caption>Agenticity and governor economics · Pass B</caption><thead><tr><th scope="col">Variant</th><th scope="col">Autonomy ratio</th><th scope="col">Zero-intervention tasks</th><th scope="col">Autonomous successes</th><th scope="col">Looks / task</th><th scope="col">Horizon mean / median</th><th scope="col">Productive interventions</th><th scope="col">Intervention ROI</th><th scope="col">Regret / intervention</th><th scope="col">Market time / look</th><th scope="col">Packets / task</th></tr></thead><tbody>${agentRows}</tbody></table></div>
  <p class="note">Productive interventions, ROI and regret come from the oracle: each intervention is re-run masked under the same random draws. ROI is realized saving ÷ intervention tokens. Strategy novelty: the proposal lane was invited, but no agent proposal ever won the market (${num(h4.proposalsAcceptedPerTask, 3)} accepted per task).</p>
</section>

<section aria-labelledby="overhead">
  <h2 id="overhead">Overhead introduced by the governor</h2>
  <div class="tiles">
    <div class="tile"><span class="n">${num(h4.marketMsPerEvaluation, 2)} ms</span><span class="l">market + governor compute per look (H4)</span></div>
    <div class="tile"><span class="n">${num(h4.packetBytesPerTask / 1024, 0)} KB</span><span class="l">DecisionPackets per task (${num(h4.evaluationsPerTask, 0)} looks)</span></div>
    <div class="tile"><span class="n">${pct(B.variants['H3+AH'].governorOverheadRatio, 1)}</span><span class="l">tokens spent on interventions, H3+AH</span></div>
    <div class="tile"><span class="n">${pct(h4.governorOverheadRatio, 1)}</span><span class="l">H4 total, ${k(h4.replayTokensPerTask)} of it replays per task</span></div>
    <div class="tile"><span class="n">${bH4.n ? `$${(bH4.perRun - bH0.perRun).toFixed(3)}` : '—'}</span><span class="l">real H4 − H0 cost per run: agent noise, since no governor text reached a prompt</span></div>
  </div>
  <p class="note">The deterministic part of the governor is effectively free. Its cost is the interventions it buys and, for H4, the counterfactual replays: the ladder chose the multi-replay option for every one of the ${Object.values(L4.diagnosisOptions).reduce((a, b) => a + b, 0)} misses it diagnosed. That broke the plan's own rule that "most failures are classified without replay".</p>
</section>

<section aria-labelledby="buckets">
  <h2 id="buckets">By task bucket</h2>
  <div class="tablewrap"><table><caption>Success · tokens per success · Pass B</caption><thead><tr><th scope="col">Bucket</th>${VARS.map((v) => `<th scope="col">${v}</th>`).join('')}<th scope="col">H4 vs H0 CPS</th></tr></thead><tbody>${bucketRows}</tbody></table></div>
  <p class="note">Gate E fails: the losses concentrate in multi-file (${sp(B.byBucket.multi.H4vsH0.cpsRelDelta)}) and exploratory tasks, and H2's gain sits in exploratory and risky ones.</p>
</section>

<section aria-labelledby="stress">
  <h2 id="stress">Stress tests</h2>
  <div class="tablewrap"><table><caption>Success · tokens per success, per variant · H4 autonomy · interventions · overhead · H4 vs H0</caption><thead><tr><th scope="col">Set</th><th scope="col">H0</th><th scope="col">H1</th><th scope="col">H3</th><th scope="col">H4</th><th scope="col">H4 autonomy · iv/task</th><th scope="col">H4 overhead</th><th scope="col">H4 vs H0 CPS [CI]</th></tr></thead><tbody>${stressRows}</tbody></table></div>
  <ul class="tight prose">
    <li><strong>Easy and over-intervention:</strong> the governor mostly disappears, as intended.</li>
    <li><strong>Long and near-miss:</strong> H4 is worse (${sp(s.stress.long.H4vsH0.cpsRelDelta)}, ${sp(s.stress.near_miss.H4vsH0.cpsRelDelta)}). Prevention debt is not reduced; interventions arrive and fail to prevent.</li>
    <li><strong>Candidate generation:</strong> discovery lifted H3's recall a little, but most boundaries still lacked the useful option (generation-miss rate ${pct(s.stress.candidate_generation.H3.opportunityRecall?.generationMissRate, 0)}). The special fix was never proposed and accepted.</li>
    <li><strong>Unavoidable:</strong> the governor kept intervening on impossible tasks, and H4's replays tripled its overhead (${pct(s.stress.unavoidable.H4.governorOverheadRatio, 0)}).</li>
  </ul>
</section>

<section aria-labelledby="learn">
  <h2 id="learn">Memory and learning</h2>
  <div class="tablewrap"><table><caption>Memory regimes · Pass B</caption><thead><tr><th scope="col">Arm</th><th scope="col">Success</th><th scope="col">Tokens / success</th><th scope="col">Overhead</th><th scope="col">Replay tokens / task</th><th scope="col">Brier (failure p)</th></tr></thead><tbody>${memRows}</tbody></table></div>
  <ul class="tight prose">
    <li>Warm causal vs cold, held-out window: ${sp(mm.H4_M2_vs_M0_heldout.cpsRelDelta)} CPS [${ci(mm.H4_M2_vs_M0_heldout.cpsRelDeltaCI)}], success ${pp(mm.H4_M2_vs_M0_heldout.successDelta)}. Pre-registered test H5: no meaningful improvement.</li>
    <li>Factual memory (M1) changed nothing. Historical reuse was offered at boundaries but never chosen: the quality floor rejects knowledge priced with 15% stale risk at early-run confidence.</li>
    <li>Ladder: ${Object.entries(L4.diagnosisOptions).map(([o, n]) => `${o} × ${n}`).join(', ')}; evidence ${L4.evidenceLevels.validated} validated, ${L4.evidenceLevels.supported} supported. Replay ROI ${num(L4.replayROI, 3)} (tokens saved held-out ÷ replay tokens). ${L4.finalMotifs} motifs retained at the end.</li>
    <li>Calibration: predicted failure p averages ${num(h4.calibration?.meanPredicted, 2)} against an observed ${num(h4.calibration?.observedRate, 2)}. The V(s) prior (validation doubt × 0.5) is too pessimistic. Recalibration helped a little (Brier ${num(B.variants['H3+AH'].calibration?.brier, 3)} → ${num(h4.calibration?.brier, 3)}).</li>
  </ul>
</section>

<section aria-labelledby="misses">
  <h2 id="misses">Failure and miss findings</h2>
  <div class="cols">
    <div class="card"><h3>Miss taxonomy (governor's own view, H4)</h3><p>${Object.entries(h4.missTaxonomy).map(([m, n]) => `${m.replace(/_/g, ' ').toLowerCase()} ${n}`).join(' · ')}</p><p>Outcomes: ${Object.entries(h4.outcomeClasses).map(([o, n]) => `${o.replace(/_/g, ' ').toLowerCase()} ${n}`).join(' · ')}</p></div>
    <div class="card"><h3>Top causes</h3><ul class="tight"><li>The useful intervention was usually never on the table (generation-miss ${pct(h4.opportunityRecall?.generationMissRate, 0)}). Latent failure modes give the state almost no early signal.</li><li>Memory recommended interventions that discovery then failed to retrieve (memory misses).</li><li>The right action, taken too late (precommitment misses).</li></ul></div>
    <div class="card"><h3>Defects the benchmark exposed</h3><ul class="tight"><li>Cold-start horizon: every adaptive run began with a 16-step blind window. Fixed after freezing; see the post-hoc run.</li><li>The replay value estimate ignores how rarely evidence changes a decision, so it always buys replays.</li><li>H1's own <code>deep:validate</code> and <code>deep:constrain</code> are chosen but never carried out in production.</li></ul></div>
  </div>
</section>

<section aria-labelledby="armb">
  <h2 id="armb">Real model (Arm B)</h2>
  <p class="prose">SWE-bench Verified, Haiku 4.5 for every role, System-1 on, same build for both arms. ${bH0.n + bH4.n} runs, ${bH0.graded + bH4.graded} graded by the official harness.</p>
  <div class="tiles">
    <div class="tile"><span class="n">${bH0.solved}/${bH0.graded} · ${bH4.solved}/${bH4.graded}</span><span class="l">resolved, H0 · H4</span></div>
    <div class="tile"><span class="n">$${(bH0.perRun ?? 0).toFixed(3)} · $${(bH4.perRun ?? 0).toFixed(3)}</span><span class="l">cost per run, H0 · H4</span></div>
    <div class="tile"><span class="n">${bH0.perSolved ? `$${bH0.perSolved.toFixed(3)}` : '—'} · ${bH4.perSolved ? `$${bH4.perSolved.toFixed(3)}` : '—'}</span><span class="l">cost per resolved task, H0 · H4</span></div>
    <div class="tile"><span class="n">${bH4.packets} / ${bH4.carried}</span><span class="l">H4 governor looks / interventions carried out</span></div>
  </div>
  <div class="tablewrap"><table><thead><tr><th scope="col">Run</th><th scope="col">Arm</th><th scope="col">State</th><th scope="col">Grade</th><th scope="col">Cost</th><th scope="col">Turns</th><th scope="col">Dispatches</th><th scope="col">Packets</th><th scope="col">Chosen</th><th scope="col">Carried</th><th scope="col">Governor text</th></tr></thead><tbody>${armBRows}</tbody></table></div>
  <p class="note">The governor looked once per H4 run (${bH4.packets} looks) and chose <code>continue</code> every time. In ${bH4.faults} of ${bH4.n} runs every intervention was refused for missing telemetry, because the look happens before the agent has acted. Every captured Job spec was searched for governor text; ${bH4.textJobs} contained any. Each H4 dispatch was therefore content-identical to H0's, and the cost gap between the arms is agent noise. ${bH0.budgetBug + bH4.budgetBug} runs (${bH0.budgetBug} H0, ${bH4.budgetBug} H4) were stopped by the pre-existing "no execution candidate is feasible" budget bug the 2026-10-01 pilot found, which happens with or without a governor. With n = 2 per task, cost and resolve-rate differences are not interpretable, and the arm is a dormancy and quality-preservation check, not a powered comparison.</p>
</section>

${v2B ? `<section aria-labelledby="v2">
  <h2 id="v2">Post-hoc run · cold-start horizon fixed</h2>
  <p class="prose"><span class="pill warn">exploratory, not pre-registered</span> After the results were frozen, one defect was fixed: with nothing measured yet, the horizon now looks at the next boundary instead of sleeping for 16 steps. Everything else is unchanged, and the run was rebuilt in a separate directory. This tests a bug fix, not tuning.</p>
  <div class="tablewrap"><table><caption>Pass B, v1 → v2</caption><thead><tr><th scope="col">Variant</th><th scope="col">Success</th><th scope="col">Tokens / success</th><th scope="col">Looks / task</th><th scope="col">Autonomy</th><th scope="col">CPS vs previous layer (v2)</th><th scope="col">Success vs previous (v2)</th></tr></thead><tbody>${v2rows}</tbody></table></div>
  <p class="note">The fix removes the success loss: H3+AH now matches H0, at ${sp(v2B.vsH0['H3+AH'].cpsRelDelta)} CPS. The horizon then collapses to about one step, because a look is nearly free, so the adaptive horizon still does not beat the backoff. H4's learning still costs success.</p>
</section>` : ''}

<section aria-labelledby="dev">
  <h2 id="dev">Deviations from the plan</h2>
  <div class="tablewrap"><table class="wrap"><thead><tr><th scope="col">Original assumption</th><th scope="col">Observed issue</th><th scope="col">Replacement</th><th scope="col">Evidence / impact</th></tr></thead><tbody>
    <tr><td>Risk reduction sums over doubt dimensions</td><td>An action addressing two doubts would be paid twice</td><td>Noisy-OR across dimensions; validation carries the whole doubt-explained exposure</td><td>Unit tests show risk V(s) equals V(s) when risk is flat</td></tr>
    <tr><td>DecisionPacket keeps separate estimate snapshots</td><td>Duplicates the candidate list</td><td>One compact snapshot per candidate carries its estimate</td><td>About 5 KB per look</td></tr>
    <tr><td>Horizon loss rate is p·R spread over the steps left</td><td>Wrong units: the horizon was always 1</td><td>p × tokens per step + velocity × R; look cost includes learned regret</td><td>Fixed before the frozen run</td></tr>
    <tr><td>Advice may be re-offered at every look</td><td>The same advice was repeated 17 times on one task</td><td>Not re-offered until a new failure or validation result</td><td>Fixed before the frozen run</td></tr>
    <tr><td>Regret counts chosen interventions</td><td>Production records some choices without carrying them out</td><td>Regret and learning count only carried-out interventions (new <code>governor.intervention_carried</code> event)</td><td>Fixed before the frozen run</td></tr>
    <tr><td>Horizon at version 0 priced like any other look</td><td>16-step blind window</td><td>The first look is always followed by another</td><td>Post-hoc v2, labelled above</td></tr>
    <tr><td>Production per-step governance</td><td>Production boundaries are dispatches</td><td>Arm A simulates per-step boundaries; Arm B measures production as it is</td><td>Mechanism results describe the target architecture</td></tr>
    <tr><td>System-1 semantic discovery tier</td><td>Laya answers typed choices; it does not generate candidates</td><td>Tier left as an injectable hook; it is off in production</td><td>Discovery uses the registry and the agent tier</td></tr>
    <tr><td>Level-2 replay in production</td><td>No sandbox-fork capability exists</td><td>Executor is injected; production stops at Level 1</td><td>Replay measured only in Arm A</td></tr>
  </tbody></table></div>
</section>

<section aria-labelledby="limits">
  <h2 id="limits">Limits of this evidence</h2>
  <ul class="tight prose">
    <li>Arm A tests the controller's logic in a world model I wrote; its true effects and signals are assumptions. Arm B is real but small and cannot exercise the mechanisms.</li>
    <li>Pass B's full protocol (1,800 runs per real model) was not run on a frontier model; real-model cost would be dominated by tasks where the governor cannot act.</li>
    <li>Success CIs are narrow because the paired worlds share draws. They describe the simulator's variance, not real-agent variance.</li>
  </ul>
</section>
</main>
<script>
(() => {
  const tip = document.getElementById('tip');
  const show = (el, x, y) => { tip.textContent = el.getAttribute('data-tip'); tip.hidden = false;
    const w = tip.offsetWidth; tip.style.left = Math.min(window.innerWidth - w - 8, x + 12) + 'px'; tip.style.top = (y + 14) + 'px'; };
  document.addEventListener('pointerover', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el, e.clientX, e.clientY); });
  document.addEventListener('pointermove', (e) => { if (!tip.hidden && e.target.closest('[data-tip]')) { tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; } });
  document.addEventListener('pointerout', (e) => { if (e.target.closest('[data-tip]')) tip.hidden = true; });
  document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el) { const r = el.getBoundingClientRect(); show(el, r.right, r.top); } });
  document.addEventListener('focusout', () => { tip.hidden = true; });
})();
</script>
`;
writeFileSync(OUT, html);
console.log(`wrote ${OUT} (${(html.length / 1024).toFixed(0)} KB)`);
