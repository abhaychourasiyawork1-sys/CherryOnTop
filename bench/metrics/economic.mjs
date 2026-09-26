/** What a benchmark run actually says, in the terms this architecture was
 *  approved on.
 *
 *  Plain JavaScript and no imports from `dist/`, deliberately: these are pure
 *  functions over records, they run in the unit suite without a build, and the
 *  arithmetic that decides whether a change ships should not itself depend on
 *  the change having compiled.
 *
 *  Three rules shape every number here.
 *
 *  **Per successful task, not per task.** A change that halves tokens by failing
 *  twice as often has not improved anything, and a mean over all tasks would
 *  call it a win. The denominator is successes throughout.
 *
 *  **Quality is a gate, not a term.** It appears in the objective *and* outside
 *  it, because a weighted score can always be improved by spending quality, and
 *  the whole point of a quality floor is that no weighting may trade it away.
 *
 *  **Absence is not zero.** A run nobody scored, an intervention nobody checked,
 *  a metric nothing produced — all report `null`. Averaging an unmeasured thing
 *  in as zero is how a harness flatters exactly the runs it failed to observe. */

/** Mean of the values that exist. Null when none do — never 0, because "we
 *  measured nothing" and "we measured zero" are different results. */
export function mean(values) {
  const present = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

export function sum(values) {
  return values.reduce((total, value) =>
    total + (typeof value === 'number' && Number.isFinite(value) ? value : 0), 0);
}

/** Nearest-rank percentile, no interpolation: with the handful of tasks a
 *  benchmark corpus has, an interpolated p95 is a number no run produced. */
export function percentile(values, p) {
  const present = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (present.length === 0) return null;
  const sorted = [...present].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

const share = (part, whole) => (whole > 0 ? part / whole : 0);

/** Every number a comparison reads, from one arm's records.
 *
 *  The order is the order a report should present them in: the primary metric
 *  first, then the two things it is not allowed to have been bought with, then
 *  where the tokens went, then what the control plane cost and whether it was
 *  any good. */
export const SYSTEM1_FIELDS = [
  'system1Calls', 'system1Questions', 'system1CachedAnswers', 'system1LatencyMs', 'system1InputTokens',
  'system1Failures', 'system1Fallbacks', 'system1Epochs', 'system1Candidates', 'modelDecisionRequests',
];

/** System-1 counters summed over a set of efficiency records. Absent fields
 *  (records written before System-1 existed) count as zero. */
export function system1Totals(records) {
  return Object.fromEntries(SYSTEM1_FIELDS.map((field) =>
    [field, (records ?? []).reduce((acc, r) => acc + (Number.isFinite(r?.[field]) ? r[field] : 0), 0)]));
}

export function summarizeEconomicRun(records) {
  const all = records ?? [];
  const successful = all.filter((record) => record.outcome === 'success');
  const totalTokens = sum(all.map((r) => r.totalTokens));

  return {
    tasks: all.length,

    // ---- the primary metric, and the two it may not be bought with ---------
    tokensPerSuccessfulTask: mean(successful.map((r) => r.totalTokens)),
    successRate: all.length === 0 ? null : successful.length / all.length,
    qualityScore: mean(all.map((r) => r.qualityScore)),
    p50LatencyMs: percentile(all.map((r) => r.endToEndMs), 50),
    p95LatencyMs: percentile(all.map((r) => r.endToEndMs), 95),

    // ---- where the tokens went --------------------------------------------
    // Slices of the same spend, reported so a regression can be attributed
    // rather than only observed.
    initialContextTokens: mean(all.map((r) => r.contextEstimatedTokens)),
    explorationTokens: mean(all.map((r) => r.explorationTokens)),
    evidenceTokens: mean(all.map((r) => r.evidenceTokens)),
    validationTokens: mean(all.map((r) => r.validationTokens)),
    recoveryTokens: mean(all.map((r) => r.recoveryTokens)),
    duplicatedInformationTokens: mean(all.map((r) => r.duplicatedInformationTokens)),

    // ---- what the control plane cost, and whether it earned it -------------
    orchestrationTokens: mean(all.map((r) => r.orchestrationTokens)),
    orchestrationOverheadRatio: share(sum(all.map((r) => r.orchestrationTokens)), totalTokens),
    optimizationRoi: mean(all.map((r) => r.optimizationRoi)),
    // Null when nothing was reconciled: "no intervention helped" and "we never
    // checked" are different results and only one is a verdict.
    beneficialInterventionRate: mean(all.map((r) => r.beneficialInterventionRate)),
    memoryNetValue: mean(all.map((r) => r.memoryNetValue)),
    duplicationRatio: share(sum(all.map((r) => r.duplicatedInformationTokens)), totalTokens),

    // ---- System-1 diagnostics ----------------------------------------------
    // Explain the whole-harness numbers above; they are never the objective.
    // Summed, not averaged: overhead is paid per run, and a mean over tasks
    // that never reached a decision epoch would hide what the others paid.
    system1: system1Totals(all),

    // ---- how a cheap-looking arm might have got that way -------------------
    tasksStopped: all.filter((r) => r.stopReason !== null && r.stopReason !== undefined).length,
    // Mixing two policy generations produces a number describing neither.
    policyVersions: [...new Set(all.map((r) => r.policyVersion).filter(Boolean))].sort(),
  };
}

/** Percentage change, with `null` propagating rather than becoming zero. */
export function deltaPct(optimized, baseline) {
  if (typeof optimized !== 'number' || typeof baseline !== 'number') return null;
  if (baseline === 0) return null;
  return ((optimized - baseline) / baseline) * 100;
}

/** The acceptance contract, applied.
 *
 *  A strong win needs tokens per successful task down, quality level or up,
 *  success rate level or up, latency level or acceptably up, and orchestration
 *  overhead justified. Anything less is reported as what it is rather than
 *  rounded towards a verdict. */
export function compareArms(baseline, full, options = {}) {
  const epsilon = options.epsilon ?? 0.02;
  const latencyTolerancePct = options.latencyTolerancePct ?? 25;
  const maxOrchestrationOverhead = options.maxOrchestrationOverhead ?? 0.05;

  const failures = [];
  const inconclusive = [];

  const tokenDeltaPct = deltaPct(full.tokensPerSuccessfulTask, baseline.tokensPerSuccessfulTask);
  if (tokenDeltaPct === null) inconclusive.push('tokens per successful task could not be compared');
  else if (tokenDeltaPct >= 0) failures.push(`tokens per successful task did not fall (${tokenDeltaPct.toFixed(1)}%)`);

  // Silence is not a pass. An unscored optimized arm must not be able to ship a
  // quality regression by simply not measuring one — but a baseline that was
  // never scored has no bar to clear.
  if (baseline.qualityScore !== null) {
    if (full.qualityScore === null) failures.push('quality was not scored on the Full Architecture arm');
    else if (full.qualityScore < baseline.qualityScore) failures.push('quality regressed');
  } else {
    inconclusive.push('quality was not scored on either arm');
  }

  if (baseline.successRate !== null && full.successRate !== null) {
    if (full.successRate < baseline.successRate - epsilon) {
      failures.push(`success rate fell more than ${epsilon}`);
    }
  } else {
    inconclusive.push('success rate could not be compared');
  }

  const latencyDeltaPct = deltaPct(full.p95LatencyMs, baseline.p95LatencyMs);
  if (latencyDeltaPct === null) inconclusive.push('latency could not be compared');
  else if (latencyDeltaPct > latencyTolerancePct) {
    failures.push(`p95 latency rose ${latencyDeltaPct.toFixed(1)}%, past the ${latencyTolerancePct}% tolerance`);
  }

  // Stopping tasks is a way to look cheap that has nothing to do with being
  // efficient. The success-rate gate catches most of it, but not the case where
  // the guard stopped a task the baseline would also have failed.
  if (full.tasksStopped > baseline.tasksStopped) {
    failures.push(`the guard stopped more tasks (${full.tasksStopped} vs ${baseline.tasksStopped})`);
  }

  if (full.orchestrationOverheadRatio > maxOrchestrationOverhead) {
    failures.push(
      `orchestration overhead is ${(full.orchestrationOverheadRatio * 100).toFixed(1)}% of spend, `
      + `past the ${(maxOrchestrationOverhead * 100).toFixed(0)}% bar`,
    );
  }

  // Two policy generations averaged together describe neither.
  const generations = new Set([...baseline.policyVersions, ...full.policyVersions]
    .map((id) => id.split(':').slice(1).join(':')));
  if (generations.size > 1) {
    failures.push(`records span ${generations.size} policy generations and are not comparable`);
  }

  return {
    accepted: failures.length === 0 && inconclusive.length === 0,
    tokenDeltaPct,
    qualityDelta: full.qualityScore !== null && baseline.qualityScore !== null
      ? full.qualityScore - baseline.qualityScore
      : null,
    successDeltaPct: deltaPct(full.successRate, baseline.successRate),
    latencyDeltaPct,
    orchestrationOverheadRatio: full.orchestrationOverheadRatio,
    failures,
    inconclusive,
    verdict: failures.length > 0
      ? 'regressed'
      : inconclusive.length > 0
        ? 'inconclusive'
        : 'improved',
  };
}

/** The report, as text. Primary metric first, quality and latency beside it. */
export function renderComparison(baseline, full, comparison) {
  const fmt = (value, digits = 0) =>
    value === null || value === undefined ? 'not measured' : Number(value).toFixed(digits);
  const delta = (value) => (value === null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`);

  const rows = [
    ['tokens / successful task', fmt(baseline.tokensPerSuccessfulTask), fmt(full.tokensPerSuccessfulTask), delta(comparison.tokenDeltaPct)],
    ['quality', fmt(baseline.qualityScore, 3), fmt(full.qualityScore, 3), comparison.qualityDelta === null ? 'n/a' : comparison.qualityDelta.toFixed(3)],
    ['success rate', fmt(baseline.successRate, 3), fmt(full.successRate, 3), delta(comparison.successDeltaPct)],
    ['p95 latency (ms)', fmt(baseline.p95LatencyMs), fmt(full.p95LatencyMs), delta(comparison.latencyDeltaPct)],
    ['tasks stopped', String(baseline.tasksStopped), String(full.tasksStopped), ''],
    ['initial context tokens', fmt(baseline.initialContextTokens), fmt(full.initialContextTokens), ''],
    ['exploration tokens', fmt(baseline.explorationTokens), fmt(full.explorationTokens), ''],
    ['evidence tokens', fmt(baseline.evidenceTokens), fmt(full.evidenceTokens), ''],
    ['validation tokens', fmt(baseline.validationTokens), fmt(full.validationTokens), ''],
    ['recovery tokens', fmt(baseline.recoveryTokens), fmt(full.recoveryTokens), ''],
    ['duplicated information', fmt(baseline.duplicatedInformationTokens), fmt(full.duplicatedInformationTokens), ''],
    ['orchestration tokens', fmt(baseline.orchestrationTokens), fmt(full.orchestrationTokens), ''],
    ['orchestration overhead', `${(baseline.orchestrationOverheadRatio * 100).toFixed(2)}%`, `${(full.orchestrationOverheadRatio * 100).toFixed(2)}%`, ''],
    ['optimization ROI', fmt(baseline.optimizationRoi, 3), fmt(full.optimizationRoi, 3), ''],
    ['beneficial interventions', fmt(baseline.beneficialInterventionRate, 3), fmt(full.beneficialInterventionRate, 3), ''],
    ['memory net value', fmt(baseline.memoryNetValue), fmt(full.memoryNetValue), ''],
  ];

  const columns = ['metric', 'baseline', 'full', 'delta'];
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => `| ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join(' | ')} |`;

  return [
    line(columns),
    `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`,
    ...rows.map(line),
    '',
    `verdict: ${comparison.verdict}`,
    ...comparison.failures.map((reason) => `  regression: ${reason}`),
    ...comparison.inconclusive.map((reason) => `  inconclusive: ${reason}`),
  ].join('\n');
}
