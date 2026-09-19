/** Matching two arms so the difference between them means something.
 *
 *  A benchmark comparison is only as good as its pairing. Two arms that ran
 *  different goals, or the same goals against different commits, or with one
 *  arm's daemon reading the other's database, produce a number that looks
 *  exactly like a result and is not one. Most of this file is about refusing
 *  those cases rather than computing anything.
 *
 *  The statistics are deliberately weak. With seven goals per arm there is no
 *  honest way to make a strong claim, and a harness that produces a confident
 *  p-value from seven paired observations is a harness that will be quoted. So:
 *  a **sign test**, which assumes nothing about the distribution, reported
 *  beside the plain paired difference and the sample size, with the wording
 *  chosen so that "suggestive" cannot be read as "significant".
 *
 *  Plain JavaScript, no imports from `dist/`: the arithmetic that decides
 *  whether a change ships should not depend on the change having compiled. */

/** Everything that has to match for two runs to be the same experiment.
 *
 *  Not the arm, obviously — that is what differs. Everything else, because
 *  everything else is a confound. */
export function pairKeyOf(row) {
  return [
    row.goal,
    row.repositoryRevision ?? 'unknown-revision',
    row.provider ?? 'unknown-provider',
    row.models ?? 'unknown-models',
    row.environmentFingerprint ?? 'unknown-environment',
  ].join('|');
}

/** Matched pairs, and everything that could not be matched.
 *
 *  Unmatched rows are *returned*, not dropped. A comparison over five of seven
 *  goals is a different claim from a comparison over seven, and a harness that
 *  silently discards the two it could not pair makes them the same claim. */
export function pairRuns(baselineRows, fullRows) {
  const index = new Map();
  for (const row of baselineRows ?? []) {
    const key = pairKeyOf(row);
    index.set(key, [...(index.get(key) ?? []), row]);
  }

  const pairs = [];
  const unmatchedFull = [];
  for (const full of fullRows ?? []) {
    const key = pairKeyOf(full);
    const bucket = index.get(key);
    if (!bucket || bucket.length === 0) { unmatchedFull.push(full); continue; }
    pairs.push({ key, goal: full.goal, baseline: bucket.shift(), full });
  }

  const unmatchedBaseline = [...index.values()].flat();

  return {
    pairs: pairs.sort((a, b) => (a.key < b.key ? -1 : 1)),
    unmatchedBaseline: unmatchedBaseline.sort((a, b) => (a.goal < b.goal ? -1 : 1)),
    unmatchedFull: unmatchedFull.sort((a, b) => (a.goal < b.goal ? -1 : 1)),
    reasons: [
      ...unmatchedBaseline.map((row) => `unmatched:baseline:${row.goal}`),
      ...unmatchedFull.map((row) => `unmatched:full:${row.goal}`),
    ].sort(),
  };
}

/** Exact two-sided binomial tail for a fair coin — the sign test's p-value.
 *
 *  Exact rather than approximated because the sample sizes here are small
 *  enough that a normal approximation is simply wrong, and a wrong p-value is
 *  worse than none. */
export function signTestP(wins, losses) {
  const n = wins + losses;
  if (n === 0) return null;
  const choose = (a, b) => {
    let result = 1;
    for (let i = 0; i < b; i++) result = (result * (a - i)) / (i + 1);
    return result;
  };
  const extreme = Math.min(wins, losses);
  let tail = 0;
  for (let k = 0; k <= extreme; k++) tail += choose(n, k);
  return Math.min(1, (tail / 2 ** n) * 2);
}

/** How the paired difference should be *described*, given how little evidence
 *  there is.
 *
 *  The wording matters more than the number. "Suggestive" and "significant"
 *  mean different things and only one of them is claimable from seven paired
 *  observations, so the strongest word this returns is deliberately weak. */
export function describeEvidence(n, p) {
  if (n === 0) return 'no paired observations';
  if (n < 5) return `too few paired observations (${n}) to say anything beyond the direction`;
  if (p === null) return 'no signed differences to test';
  if (p <= 0.05) return `consistent in direction across ${n} pairs (sign test p=${p.toFixed(3)}); suggestive, not conclusive at this sample size`;
  if (p <= 0.2) return `leans one way across ${n} pairs (sign test p=${p.toFixed(3)}); weak`;
  return `no consistent direction across ${n} pairs (sign test p=${p.toFixed(3)})`;
}

/** The paired difference on one metric, with an honest account of how much it
 *  is worth. */
export function pairedDifference(pairs, metric, options = {}) {
  const lowerIsBetter = options.lowerIsBetter ?? true;
  const usable = (pairs ?? []).filter((pair) =>
    Number.isFinite(pair.baseline?.[metric]) && Number.isFinite(pair.full?.[metric]));

  if (usable.length === 0) {
    return {
      metric, n: 0, meanDifference: null, medianDifference: null,
      meanPercent: null, wins: 0, losses: 0, ties: 0, p: null,
      evidence: describeEvidence(0, null),
    };
  }

  const differences = usable.map((pair) => pair.full[metric] - pair.baseline[metric]);
  const better = lowerIsBetter ? (d) => d < 0 : (d) => d > 0;
  const worse = lowerIsBetter ? (d) => d > 0 : (d) => d < 0;

  const wins = differences.filter(better).length;
  const losses = differences.filter(worse).length;
  const ties = differences.length - wins - losses;
  const p = signTestP(wins, losses);

  const sorted = [...differences].sort((a, b) => a - b);
  const median = sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  // Mean of the per-pair *percentages*, not the percentage of the means: one
  // enormous goal must not decide the headline for six small ones.
  const percents = usable
    .filter((pair) => pair.baseline[metric] !== 0)
    .map((pair) => ((pair.full[metric] - pair.baseline[metric]) / pair.baseline[metric]) * 100);

  return {
    metric,
    n: usable.length,
    meanDifference: differences.reduce((sum, d) => sum + d, 0) / differences.length,
    medianDifference: median,
    meanPercent: percents.length === 0 ? null : percents.reduce((sum, d) => sum + d, 0) / percents.length,
    wins, losses, ties, p,
    evidence: describeEvidence(wins + losses, p),
  };
}

// ------------------------------------------------------------- isolation

/** Resources one arm may use without touching the other's.
 *
 *  Two arms sharing a SQLite file and a port is not a subtle contamination: the
 *  second arm reads the first arm's efficiency records and reports them as its
 *  own. Derived from the arm name so it is stable across a rerun — a comparison
 *  you cannot repeat is not a measurement. */
export function isolationFor(arm, options = {}) {
  const basePort = options.basePort ?? 7801;
  // Stable, small, and distinct per arm. A hash rather than an index so two
  // arms named in either order get the same assignment.
  let hash = 0;
  for (const char of String(arm)) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  const offset = hash % 50;
  return {
    arm,
    port: basePort + offset,
    databasePath: `${options.baseDir ?? '.bench'}/${arm}/org.db`,
    env: {
      ORG_DAEMON_PORT: String(basePort + offset),
      ORG_DB_PATH: `${options.baseDir ?? '.bench'}/${arm}/org.db`,
    },
  };
}

/** True when two arms could read or write each other's state. */
export function isolationConflict(a, b) {
  return a.port === b.port || a.databasePath === b.databasePath;
}

// ------------------------------------------------------------- failures

/** Patterns that mean the *harness or its environment* failed, not the product.
 *
 *  The distinction decides whether a run should be retried or recorded as a
 *  failure, and getting it wrong in either direction corrupts the comparison:
 *  retrying a real product failure hides it, and recording an expired token as
 *  a product failure invents one. */
const ENVIRONMENT_PATTERNS = [
  [/rate.?limit|usage limit|quota|429/i, 'rate_limited'],
  [/401|unauthor|invalid[_ ]api[_ ]key|credentials? (?:are )?(?:unusable|expired|invalid)|please run .?claude login/i, 'credentials'],
  [/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|network/i, 'network'],
  [/no such (?:cluster|context)|kind cluster|kubeconfig|ImagePullBackOff|ErrImagePull/i, 'cluster'],
  [/ENOSPC|no space left|EMFILE|out of memory/i, 'resources'],
];

export function classifyFailure(text) {
  const output = String(text ?? '');
  for (const [pattern, kind] of ENVIRONMENT_PATTERNS) {
    if (pattern.test(output)) return { retryable: true, kind, scope: 'environment' };
  }
  // Everything else is the product's own failure and is a *result*. Retrying it
  // would turn a finding into a flake.
  return { retryable: false, kind: 'product_failure', scope: 'product' };
}

/** The `org run` flags a goal is dispatched with.
 *
 *  Delegation, the budget floor and the spend cap are all **off by default** in
 *  the CLI — `--max-children` defaults to 0, which means no spawn authority,
 *  which means the delegate path is never reached. A benchmark that does not
 *  set them measures a runtime with delegation, the spend guard and the
 *  Action Market's execution veto all disabled, and reports the result as
 *  though it had exercised them. That is exactly what the 2026-09-17 run did:
 *  the hard-budget regime never engaged a cap, because nothing set one.
 *
 *  So the flags are read from the environment and applied identically to every
 *  arm, and the values used are recorded in the manifest. Unset means the old
 *  behaviour, so an existing invocation is unchanged.
 *
 *  - `ORG_BENCH_MAX_CHILDREN` — `--max-children`, and `--spawn` with it.
 *  - `ORG_BENCH_BUDGET_USD`   — `--budget`. Must clear MIN_AGENT_BUDGET_USD*2
 *                                (i.e. $1) or every split escalates instead.
 *  - `ORG_TASK_SPEND_CAP_USD` — read by the runtime itself, not a flag; listed
 *                                here so the manifest records it. */
export function dispatchFlags(env = process.env) {
  const flags = [];
  const children = Number(env.ORG_BENCH_MAX_CHILDREN);
  if (Number.isFinite(children) && children > 0) {
    flags.push('--spawn', '--max-children', String(Math.floor(children)));
  }
  const budget = Number(env.ORG_BENCH_BUDGET_USD);
  if (Number.isFinite(budget) && budget > 0) {
    flags.push('--budget', String(budget));
  }
  return flags;
}

/** What those flags were, for the manifest. A run that cannot say whether
 *  delegation was even reachable cannot be compared with one that can. */
export function dispatchConfig(env = process.env) {
  return {
    maxChildren: Number(env.ORG_BENCH_MAX_CHILDREN) || 0,
    budgetUsd: Number(env.ORG_BENCH_BUDGET_USD) || 0,
    taskSpendCapUsd: Number(env.ORG_TASK_SPEND_CAP_USD) || 0,
    delegationReachable: (Number(env.ORG_BENCH_MAX_CHILDREN) || 0) > 0
      && (Number(env.ORG_BENCH_BUDGET_USD) || 0) >= 1,
    spendGuardEngaged: (Number(env.ORG_TASK_SPEND_CAP_USD) || 0) > 0,
  };
}

/** The most times one goal may be retried before it is recorded as unrunnable.
 *
 *  Two: enough for a transient token refresh or a scheduling hiccup, few enough
 *  that a persistently broken environment stops the run rather than grinding
 *  through the whole matrix. */
export const MAX_ENVIRONMENT_RETRIES = 2;

// ------------------------------------------------------------- metadata

/** Everything needed to reproduce one comparison.
 *
 *  A benchmark result without this is an anecdote about a terminal somebody had
 *  open. Every field is something that changes the answer. */
export function runMetadata(input) {
  return {
    startedAt: input.startedAt,
    mode: input.mode,
    goalSet: input.goalSet,
    goalIds: [...(input.goalIds ?? [])].sort(),
    repositoryRevision: input.repositoryRevision ?? null,
    repositoryDirty: input.repositoryDirty ?? null,
    nodeVersion: input.nodeVersion ?? null,
    provider: input.provider ?? null,
    models: input.models ?? null,
    runnerImage: input.runnerImage ?? null,
    /** Whether delegation and the spend guard were reachable at all. A run
     *  with `delegationReachable: false` says nothing about delegation, and a
     *  report that omits this reads as though it did. */
    dispatch: input.dispatch ?? dispatchConfig(),
    // The composite policy identifiers seen in the records. More than one
    // generation means the comparison is not one comparison.
    policyVersions: [...new Set(input.policyVersions ?? [])].sort(),
    arms: (input.arms ?? []).map((arm) => ({
      arm: arm.arm, port: arm.port, databasePath: arm.databasePath, env: arm.env,
    })),
  };
}

/** Whether the metadata describes something repeatable. */
export function validateMetadata(metadata) {
  const problems = [];
  if (!metadata.repositoryRevision) problems.push('no repository revision recorded');
  if (metadata.repositoryDirty) problems.push('the working tree was dirty, so the revision does not describe what ran');
  if (metadata.goalIds.length === 0) problems.push('no goals recorded');
  // The *generation*, not the whole identifier. A policy id is
  // `<architecture>:<policy>:<engine>`, and the two arms of a comparison differ
  // in the architecture by construction — refusing that would refuse every
  // valid comparison. What must not differ is everything after it.
  const generations = new Set(metadata.policyVersions.map((id) => id.split(':').slice(1).join(':')));
  if (generations.size > 1) {
    problems.push(`records span ${generations.size} policy generations`);
  }
  const arms = metadata.arms ?? [];
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      if (isolationConflict(arms[i], arms[j])) {
        problems.push(`arms ${arms[i].arm} and ${arms[j].arm} share a port or database`);
      }
    }
  }
  return { reproducible: problems.length === 0, problems };
}
