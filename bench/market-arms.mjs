#!/usr/bin/env node
// The Action Market against its benchmark arms, offline: no cluster, no model,
// no database, no network. Run: `npm run build && node bench/market-arms.mjs`.
//
// What it answers: on one frozen task corpus, with one frozen ground truth,
// what does each routing policy pay per *validated* success?
//
//   fixed     — one candidate for everything (the pre-market default: runtime default model, medium effort)
//   economic  — the production Action Market: real candidates, real priors,
//               real `chooseEconomicAction`, learning from its own outcomes
//               through the real hierarchical estimator
//   random    — a uniformly random feasible candidate
//   oracle    — the candidate with the lowest *true* expected cost (upper bound)
//
// These arms live here, outside `src/`, on purpose: production has exactly one
// routing architecture. The ground truth is deliberately *not* the router's
// prior — codex is better than its prior on some shapes, the fast tier is
// genuinely good on trivial docs work and bad elsewhere — so a policy that only
// follows its priors is visibly beaten by one that learns.
//
// Everything is seeded. Two runs print the same table.
import { generateExecutionCandidates, executionEstimate } from '../dist/intelligence/model-router.js';
import { markFeasibility } from '../dist/intelligence/provider-router.js';
import { chooseEconomicAction } from '../dist/decision/engine.js';
import { initialEconomicState } from '../dist/decision/state.js';
import { candidateFingerprint, clearPredictionCache } from '../dist/decision/transition.js';
import { candidateEvidence, withLearningValue, capabilityObservations } from '../dist/lifecycle/execution-market.js';
import { fitCapability } from '../dist/intelligence/capability.js';
import { usdPerTokenFor } from '../dist/execution/pricing.js';


const SEED = Number(process.env.SEED ?? 7);
const TASKS = Number(process.env.TASKS ?? 400);
const MAX_ATTEMPTS = 4;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const harnesses = [
  { harness: 'claude-code', acceptsModelFlag: true, serves: (m) => /haiku|sonnet|opus|fable/.test(m), models: ['haiku', 'sonnet', 'opus', 'fable'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsSession: true, health: 'healthy', fingerprint: 'cc' },
  { harness: 'codex', acceptsModelFlag: true, serves: (m) => !/haiku|sonnet|opus|fable|claude/.test(m), models: [], efforts: ['default'], supportsSession: false, health: 'healthy', fingerprint: 'cx' },
];

const SHAPES = [
  { name: 'docs:low', difficulty: 0.15, weight: 0.3, tokens: 25_000 },
  { name: 'bugfix:medium', difficulty: 0.45, weight: 0.45, tokens: 45_000 },
  { name: 'refactor:high', difficulty: 0.8, weight: 0.25, tokens: 90_000 },
];

/** The world as it actually is — the thing no arm but the oracle can see.
 *  Deliberately not the router's prior: real capability is not price. Haiku is
 *  weaker at agentic work than its price suggests, sonnet stronger, fable
 *  barely better than opus; effort helps with diminishing returns; codex's
 *  default is a strong mid-priced model. */
const TRUE_CAPABILITY = { haiku: 0.25, sonnet: 0.7, opus: 0.82, fable: 0.86, default: 0.62 };
const EFFORT = { low: 0, medium: 0.05, high: 0.09, xhigh: 0.11, max: 0.12, default: 0.05 };
const EFFORT_TOKENS = { low: 0.7, medium: 1, high: 1.3, xhigh: 1.6, max: 2, default: 1 };
function truth(shape, candidate) {
  const model = candidate.metadata.model ?? 'default';
  const effort = candidate.metadata.effort;
  const cap = Math.min(1, (candidate.metadata.harness === 'codex' ? 0.66 : TRUE_CAPABILITY[model] ?? 0.6) + (EFFORT[effort] ?? 0));
  const shortfall = Math.max(0, shape.difficulty - cap);
  return {
    tokensMultiplier: (1 + 3 * shortfall) * (EFFORT_TOKENS[effort] ?? 1),
    success: Math.max(0.05, 0.97 - 1.4 * shortfall),
    qualityRisk: Math.min(0.9, 0.02 + shortfall),
  };
}

function trueExpectedCost(shape, candidate) {
  const t = truth(shape, candidate);
  const dispatch = shape.tokens * t.tokensMultiplier * usdPerTokenFor(candidate.metadata.model);
  // Geometric retries until success, and a wrong result redone once.
  return dispatch / t.success + t.qualityRisk * dispatch / t.success;
}

function corpus() {
  const r = rng(SEED);
  return Array.from({ length: TASKS }, (_, i) => {
    const x = r();
    let acc = 0;
    const shape = SHAPES.find((s) => (acc += s.weight) >= x) ?? SHAPES.at(-1);
    return { id: i, shape, noise: 0.8 + r() * 0.4 };
  });
}

/** As production does it: every failed attempt on the task raises the
 *  failure pressure a quarter step, and difficulty moves towards 1 by it. */
function candidatesFor(shape, failures = 0, capability = undefined) {
  const pressure = Math.min(1, failures * 0.25);
  const generated = generateExecutionCandidates({
    role: 'execute', difficulty: shape.difficulty + (1 - shape.difficulty) * pressure, harnesses,
    dispatchTokens: shape.tokens, dispatchLatencyMs: 120_000,
    ...(capability ? { capability } : {}),
  });
  return markFeasibility({ candidates: generated, harnesses }).filter((c) => typeof c.metadata.infeasible !== 'string');
}

const state = () => initialEconomicState({ goal: 'bench', totalTokenBudget: 4_000_000 });

const ARMS = {
  fixed: () => (_task, cands) => cands.find((c) => c.metadata.harness === 'claude-code' && c.metadata.model === undefined && c.metadata.effort === 'medium'),
  random: () => { const r = rng(SEED + 1); return (_task, cands) => cands[Math.floor(r() * cands.length)]; },
  oracle: () => (task, cands) => [...cands].sort((a, b) => trueExpectedCost(task.shape, a) - trueExpectedCost(task.shape, b))[0],
  economic: () => {
    const observations = [];
    const policy = (task, cands, excluded) => {
      const s = state();
      const pool = cands.filter((c) => !excluded.has(c.id));
      // The production evidence path: learned capability per model family at
      // this task's difficulty, measured tokens per candidate.
      const taskKeys = [{ level: 'GLOBAL', value: 'all' }, { level: 'TASK_SHAPE', value: task.shape.name }];
      const priced = withLearningValue(pool, s, observations, taskKeys, new Map());
      const estimates = Object.fromEntries(priced.map((c) => [c.id, executionEstimate(c, s, candidateEvidence(observations, c, taskKeys))]));
      const started = process.hrtime.bigint();
      const decision = chooseEconomicAction({ state: s, candidates: priced, estimates, nowMs: () => 0 });
      policy.overheadNs += process.hrtime.bigint() - started;
      policy.decisions += 1;
      return decision.blocked ? null : decision.action;
    };
    policy.overheadNs = 0n;
    policy.decisions = 0;
    // What the arm has learned so far, refitted from every validated outcome.
    policy.capability = () => fitCapability(capabilityObservations(observations));
    policy.observe = (task, candidate, outcome) => observations.push({
      difficulty: candidate.metadata.difficulty,
      modelKey: candidate.metadata.modelKey,
      candidateKey: candidate.metadata.candidateKey,
      facts: candidate.metadata.facts,
      validationStrength: 0.85,
      unitTokens: candidate.metadata.unitTokens,
      candidateId: candidateFingerprint(candidate),
      task: [{ level: 'GLOBAL', value: 'all' }, { level: 'TASK_SHAPE', value: task.shape.name }],
      stateSignature: 's',
      predicted: { costUsd: 0, latencyMs: 0, successProbability: 0, progress: 1 },
      actual: { costUsd: outcome.usd, latencyMs: 0, succeeded: outcome.succeeded, validated: outcome.validated, progress: 1, tokens: outcome.tokens },
      recoveryCount: 0, validationLevel: 'V2', validity: 'VALID',
    });
    return policy;
  },
};

function run(armName) {
  clearPredictionCache();
  const policy = ARMS[armName]();
  const r = rng(SEED + 99); // the same world draws for every arm
  let usd = 0; let tokens = 0; let validated = 0; let attempts = 0;
  for (const task of corpus()) {
    const excluded = new Set();
    let done = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !done; attempt++) {
      // Only the economic arm reads difficulty; the others see the same menu.
      const cands = candidatesFor(task.shape, armName === 'economic' ? attempt : 0, policy.capability?.());
      const chosen = policy(task, cands, excluded);
      if (!chosen) break;
      const t = truth(task.shape, chosen);
      const used = Math.round(task.shape.tokens * t.tokensMultiplier * task.noise);
      const cost = used * usdPerTokenFor(chosen.metadata.model);
      const succeeded = r() < t.success;
      const correct = succeeded && r() >= t.qualityRisk;
      usd += cost; tokens += used; attempts += 1;
      policy.observe?.(task, chosen, { usd: cost, tokens: used, succeeded, validated: correct });
      if (correct) { validated += 1; done = true; }
    }
  }
  return {
    arm: armName, usd, tokens, validated, attempts,
    overheadMs: policy.overheadNs !== undefined ? Number(policy.overheadNs) / 1e6 : 0,
    decisions: policy.decisions ?? 0,
  };
}

const rows = ['fixed', 'random', 'economic', 'oracle'].map(run);
const fixed = rows.find((r) => r.arm === 'fixed');
const fmt = (n, d = 4) => n.toFixed(d);
console.log(`Action Market benchmark arms — ${TASKS} tasks, seed ${SEED}, frozen corpus, isolated, no model calls\n`);
console.log('arm       validated  success   $/validated  tokens/validated  attempts  routing ms/decision  net savings vs fixed');
for (const r of rows) {
  const perSuccess = r.usd / Math.max(1, r.validated);
  const fixedPer = fixed.usd / Math.max(1, fixed.validated);
  console.log([
    r.arm.padEnd(9),
    String(r.validated).padStart(9),
    `${fmt((r.validated / TASKS) * 100, 1)}%`.padStart(8),
    `$${fmt(perSuccess)}`.padStart(12),
    String(Math.round(r.tokens / Math.max(1, r.validated))).padStart(17),
    String(r.attempts).padStart(9),
    (r.decisions ? fmt(r.overheadMs / r.decisions, 3) : '-').padStart(20),
    `${fmt(((fixedPer - perSuccess) / fixedPer) * 100, 1)}%`.padStart(21),
  ].join('  '));
}
console.log('\nRouting overhead is measured wall clock of the deterministic market (no System-1 in this harness: $0 routing spend).');
console.log('Net savings = cost per validated success, fixed minus arm, over fixed — failures are paid for, never dropped.');
