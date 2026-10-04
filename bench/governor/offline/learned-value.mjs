// Learned capability economics, offline (H2.5 Phase 2).
//
// Model. One observation per evaluated boundary, recorded only after its task
// has ended: (what was carried out there — a capability, or `continue`; the
// state's regime and phase; the realized cost-to-go). Cost-to-go is tokens
// from the boundary to the end of the run, plus the run's tokens again if it
// failed *validation* (a redo), divided by the boundary's own token budget so
// small and large tasks share a scale. Every input is runtime-visible: no
// ground truth, no hidden-failure label, no oracle re-run.
//
// Estimate. Hierarchical shrinkage, each level toward its parent with k
// pseudo-observations: grand mean → capability → capability × regime
// (failing?, validation status) → × phase. The learned advantage of a
// capability over carrying on in this cell is μ(continue) − μ(capability);
// it is shrunk toward the market's own predicted advantage by the capability's
// regime-level count, so with no data the market is exactly H2.5. Its
// standard error loads the conservative cost (z). The market's own order then
// chooses over the adjusted prices: the model changes prices, never who
// chooses. Updates are chronological per stream.
import { statePattern } from '../../../dist/governor/memory.js';
import { isExecutable } from '../../../dist/lifecycle/executable.js';
import { runTask } from '../sim.mjs';
import { cfg, compareSnap, oracle } from './evaluate.mjs';

const PRICE = cfg.usdPerToken;

export function regimeOf(state) {
  const [, phase, failing, validation] = statePattern(state).split('|');
  return { regime: `${failing}|${validation}`, phase };
}
export const capabilityOf = (c) => `${c.kind}|${c.capability}`;

/** Runtime-visible covariates of cost-to-go, for the regression baseline. */
export function featuresOf(state) {
  const u = state.uncertainty;
  return [1, state.trajectory.progress, (u.target + u.structural + u.behavioral + u.validation) / 4, u.structural, u.behavioral,
    state.trajectory.failurePressure, state.validation.status === 'failed' ? 1 : 0, state.validation.confidence,
    state.trajectory.orchestrationConfidence];
}

/** Online ridge regression: the expected cost-to-go of a state whatever is
 *  done there. Solved on demand from accumulated normal equations. */
export function createBaseline(dim, ridge = 1) {
  const A = Array.from({ length: dim }, (_, i) => Array.from({ length: dim }, (_, j) => (i === j ? ridge : 0)));
  const b = new Array(dim).fill(0);
  let beta = null;
  const solve = () => {
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < dim; c++) {
      let p = c; for (let r = c + 1; r < dim; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < dim; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= dim; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((row, i) => row[dim] / row[i]);
  };
  return {
    add(x, y) { for (let i = 0; i < dim; i++) { b[i] += x[i] * y; for (let j = 0; j < dim; j++) A[i][j] += x[i] * x[j]; } beta = null; },
    predict(x) { beta ??= solve(); return x.reduce((s, xi, i) => s + xi * beta[i], 0); },
  };
}

export function createValueModel({ k = 20, levels = 3, adjust = false } = {}) {
  // adjust: learn capability effects on the residual of a state baseline
  // fitted to *all* boundaries, so a capability carried out in harder states
  // is not blamed for the state it was carried out in.
  const baseline = adjust ? createBaseline(9) : null;
  const pending = [];
  const cells = new Map(); // key → { n, sum, sq }
  let all = { n: 0, sum: 0, sq: 0 };
  const add = (key, y) => {
    const c = cells.get(key) ?? { n: 0, sum: 0, sq: 0 };
    c.n += 1; c.sum += y; c.sq += y * y; cells.set(key, c);
  };
  const keys = (cap, r) => [cap, `${cap}#${r.regime}`, `${cap}#${r.regime}#${r.phase}`].slice(0, levels);
  const shrink = (key, prior) => {
    const c = cells.get(key);
    return c ? { mean: (c.sum + k * prior) / (c.n + k), n: c.n } : { mean: prior, n: 0 };
  };
  const estimate = (cap, r) => {
    const grand = all.n ? all.sum / all.n : 0;
    let mean = grand; let n = 0;
    for (const key of keys(cap, r)) ({ mean, n } = shrink(key, mean));
    const sigma2 = all.n > 1 ? Math.max(1e-6, all.sq / all.n - grand * grand) : 1;
    return { mean, n, se: Math.sqrt(sigma2 / (n + k)), regimeN: cells.get(keys(cap, r)[Math.min(1, levels - 1)])?.n ?? 0 };
  };
  return {
    observe(cap, r, y, x) {
      if (baseline) { pending.push({ cap, r, y, x }); return; }
      all = { n: all.n + 1, sum: all.sum + y, sq: all.sq + y * y }; for (const key of keys(cap, r)) add(key, y);
    },
    /** Ends a task's batch: the baseline learns from the whole task first, then
     *  the residuals are recorded against the baseline as it then stands. */
    commit() {
      if (!baseline) return;
      for (const o of pending) baseline.add(o.x, o.y);
      for (const o of pending) { const e = o.y - baseline.predict(o.x); all = { n: all.n + 1, sum: all.sum + e, sq: all.sq + e * e }; for (const key of keys(o.cap, o.r)) add(key, e); }
      pending.length = 0;
    },
    /** Learned advantage of `cap` over continue, in normalized cost units. */
    advantage(cap, r) {
      const c = estimate(cap, r); const base = estimate('continue|agent.continue', r);
      return { adv: base.mean - c.mean, se: Math.hypot(c.se, base.se), n: c.regimeN };
    },
    cells,
  };
}

/** The market under learned prices: each executable candidate's costs move by
 *  (predicted − learned) advantage; its conservative cost also carries the
 *  learned advantage's uncertainty. Then the market's own order chooses. */
export function learnedGate(model, { z = 1, k = 20, record } = {}) {
  return (view) => {
    const { state, decision } = view;
    const budget = state.resources.totalTokenBudget;
    const r = regimeOf(state);
    const byId = new Map(view.considered.map((c) => [c.id, c]));
    const cont = decision.candidates.find((s) => s.kind === 'continue');
    const priced = decision.candidates
      .filter((s) => s.status !== 'rejected' && s.kind !== 'stop' && (s.kind === 'continue' || byId.has(s.id)))
      .map((s) => {
        if (s.kind === 'continue') return s;
        const c = byId.get(s.id);
        const predicted = cont ? (cont.expectedCostUsd - s.expectedCostUsd) / PRICE : 0;
        const l = model.advantage(capabilityOf(c), r);
        const w = l.n / (l.n + k);
        const used = w * l.adv * budget + (1 - w) * predicted;
        const shift = (predicted - used) * PRICE;
        record?.(state.version, s.id, { predicted, learned: l.adv * budget, used, se: l.se * budget, n: l.n, cap: capabilityOf(c), regime: r });
        return { ...s, expectedCostUsd: s.expectedCostUsd + shift, conservativeCostUsd: s.conservativeCostUsd + shift + z * w * l.se * budget * PRICE };
      })
      .sort(compareSnap);
    const best = priced[0];
    return !best || best.kind === 'continue' ? null : byId.get(best.id);
  };
}

/** Oracle "never recover" upper bound, under the same feasibility filter. */
export const neverRecoverGate = (view) => {
  const keep = view.decision.candidates.filter((s) => s.status !== 'rejected' && s.kind !== 'stop' && s.kind !== 'recover')
    .filter((s) => s.kind === 'continue' || view.considered.some((c) => c.id === s.id)).sort(compareSnap);
  return !keep[0] || keep[0].kind === 'continue' ? null : view.considered.find((c) => c.id === keep[0].id);
};

/**
 * A chronological stream per rep. `policy`: 'H0' | 'H2' | 'H2.5' (feasibility)
 * | 'oracle' (H2.5 + never recover) | 'learned'. `freezeAt`: stop updating the
 * model from this task index on (held-out generalization).
 */
export function runStream(policy, tasks, { world = cfg, reps = 3, oracleK = 3, model: modelOpts = {}, z = 1, k = 20, freezeAt = Infinity } = {}) {
  const runs = [];
  const models = [];
  for (let rep = 0; rep < reps; rep++) {
    const model = createValueModel({ k, ...modelOpts });
    models.push(model);
    const history = new Map();
    tasks.forEach((task, index) => {
      const views = [];
      const decisions = new Map();
      const opts = { variant: policy === 'H0' ? 'H0' : 'H2', rep, regime: policy === 'H0' ? 'M0' : 'M1', history: policy === 'H0' ? null : history };
      if (policy !== 'H0' && policy !== 'H2') opts.executable = isExecutable;
      if (policy === 'oracle') opts.gate = neverRecoverGate;
      if (policy === 'learned') opts.gate = learnedGate(model, { z, k, record: (v, id, d) => decisions.set(`${v}|${id}`, d) });
      if (policy !== 'H0') opts.observe = ({ state }) => views.push({ version: state.version, consumed: state.resources.consumedTokens, budget: state.resources.totalTokenBudget, r: regimeOf(state), x: featuresOf(state) });
      // Selected vs carried counting needs a gate; the identity gate is the market itself.
      if (!opts.gate && policy !== 'H0') opts.gate = (v) => v.decision.action;
      const run = runTask(task, world, opts);
      // Freeze what the base run saw before the oracle's masked re-runs fire
      // the same hooks: counterfactual runs never become training data.
      const seen = [...views]; const priced = new Map(decisions);
      const truth = policy === 'H0' ? [] : oracle(task, run, opts, oracleK, world).map((t) => ({ ...t, learned: priced.get(`${t.version}|${t.id}`) ?? null }));
      // After the task: its boundaries become observations (runtime-visible only).
      if (index < freezeAt) {
        const w = run.w;
        const carriedAt = new Map(w.trace.filter((e) => (e.kind === 'intervention' || e.kind === 'recovery') && e.tokens > 0 && e.capability !== 'agent')
          .map((e) => [e.version, e]));
        const ivAt = new Map(w.interventions.map((i) => [i.version, i]));
        for (const v of seen) {
          const iv = ivAt.get(v.version); const ev = carriedAt.get(v.version);
          const cap = iv && ev ? `${iv.kind}|${ev.capability}` : 'continue|agent.continue';
          const y = ((w.tokens - v.consumed) + (w.outcome.validated ? 0 : w.tokens)) / Math.max(1, v.budget);
          model.observe(cap, v.r, y, v.x);
        }
        model.commit();
      }
      if (policy !== 'H0' && run.w.outcome.validated) history.set(task.repo, (history.get(task.repo) ?? 0) + 1);
      const w = run.w;
      runs.push({ taskId: task.id, bucket: task.bucket, index, rep, success: w.outcome.succeeded, validated: w.outcome.validated, tokens: w.tokens,
        steps: w.step, autonomousSteps: w.step - new Set(w.interventions.map((i) => i.version)).size,
        selected: w.selected ?? 0, carried: w.interventions.length, interventionTokens: w.interventionTokens,
        kinds: w.interventions.map((i) => i.kind), truth, calibration: [], abstained: 0, disruptionTokens: w.disruptionTokens, discoveryTokens: 0, lookTokens: w.govTokens, replayTokens: 0, preventionDebt: 0, unavoidable: task.unavoidable, recall: { opportunities: 0, r3: 0, genMiss: 0 }, looks: run.boundaries.filter((b) => b.deep).length });
    });
  }
  runs.models = models;
  return runs;
}
