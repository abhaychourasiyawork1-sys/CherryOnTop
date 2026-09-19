/** Whether a benchmark row is evidence about the product, or evidence about
 *  the harness.
 *
 *  The previous harness had two buckets — `environment` and `product` — and
 *  they answer a narrower question than a comparison needs: "should this be
 *  retried?". That is not the same as "does this row belong in the statistics?".
 *  A run that hit a snapshot mismatch is not retryable *and* is not a product
 *  failure; folding it into either bucket corrupts the comparison in a
 *  different direction each time.
 *
 *  So five classes, and the rule is that only `VALID` rows reach the primary
 *  statistics. Everything else is counted, named, and reported alongside —
 *  because "nine of twelve runs were valid" and "nine runs" are different
 *  statements and only the first one is honest.
 *
 *  Deterministic and total: no clock, no I/O, no model. */

/** The classes, in the order a reader should think about them: the run did not
 *  happen, the environment stopped it, the harness lied about it, the snapshot
 *  was wrong, somebody stopped it, or it is real evidence. */
export const VALIDITY = /** @type {const} */ ([
  'VALID', 'INVALID_INFRA', 'INVALID_ENV', 'INVALID_TELEMETRY', 'INVALID_SNAPSHOT', 'ABORTED',
]);

/** Which of the retry-classifier's kinds is infrastructure and which is
 *  environment.
 *
 *  Both are "not the product", and they are kept apart because the fixes are
 *  different people's jobs: infrastructure is a cluster nobody can schedule on,
 *  environment is a token nobody refreshed. A report that says "eleven
 *  environment failures" when nine of them were an unschedulable cluster sends
 *  the wrong person looking. */
const INFRA_KINDS = new Set(['network', 'cluster', 'resources']);
const ENV_KINDS = new Set(['rate_limited', 'credentials']);

/** The most a single token can plausibly cost, in dollars.
 *
 *  Deliberately far above any real rate — the most expensive published output
 *  token is well under this — because the purpose is to catch the impossible,
 *  not to audit the invoice. A row whose reported cost exceeds even this bound
 *  is not an expensive run; it is a broken measurement.
 *
 *  ponytail: a single loose bound rather than per-model rates. If cost
 *  attribution ever needs to be exact, this wants the real rate card keyed by
 *  the model the row names. */
const MAX_USD_PER_TOKEN = 100 / 1_000_000;

/** The least a row must have spent to be worth checking at all. Below this,
 *  rounding in the provider's own reporting dominates. */
const NEGLIGIBLE_USD = 0.005;

/** Does the runtime's own ledger describe something that could have happened?
 *
 *  This is the check that was missing when a real paid run recorded $2.00
 *  against four turns and it sailed through into the headline number. Three
 *  impossibilities, all of them arithmetic rather than judgement:
 *
 *   - money spent with no tokens to show for it,
 *   - a cost no quantity of the tokens reported could produce,
 *   - dispatches that ran for no turns, or turns with no dispatch behind them.
 *
 *  Returns `null` when the row is consistent, and the reason when it is not. */
export function telemetryAnomaly(row) {
  const tokens = (row.inputTokens ?? 0) + (row.outputTokens ?? 0)
    + (row.cacheReadTokens ?? 0) + (row.cacheCreationTokens ?? 0);
  const cost = row.costUsd ?? 0;

  if (cost < 0 || tokens < 0) return 'negative cost or token count';
  if (cost > NEGLIGIBLE_USD && tokens === 0) return `$${cost.toFixed(4)} spent against zero tokens`;
  if (cost > NEGLIGIBLE_USD && cost > tokens * MAX_USD_PER_TOKEN) {
    return `$${cost.toFixed(4)} is more than ${tokens} tokens can cost at any published rate`;
  }
  const dispatches = row.dispatches ?? 0;
  const turns = row.turns ?? 0;
  if (dispatches > 0 && turns === 0 && tokens > 0) return `${dispatches} dispatches recorded with zero turns`;
  if (turns > 0 && dispatches === 0) return `${turns} turns recorded with no dispatch behind them`;
  return null;
}

/** The class this row belongs in, and why.
 *
 *  Order matters and is the policy: a run that never started cannot be judged
 *  on its telemetry, and a run from the wrong snapshot is not evidence about
 *  this comparison however clean its numbers look. */
export function classifyValidity(row, expected = {}) {
  if (row.state === 'CANCELLED' || row.aborted) {
    return { validity: 'ABORTED', reason: 'the run was stopped before it finished' };
  }

  if (row.state === 'UNRUNNABLE') {
    const kind = row.failureKind ?? 'unknown';
    if (INFRA_KINDS.has(kind)) return { validity: 'INVALID_INFRA', reason: kind };
    if (ENV_KINDS.has(kind)) return { validity: 'INVALID_ENV', reason: kind };
    // An unrunnable row whose cause the classifier could not name is not a
    // product failure by default. Guessing "product" there is how a broken
    // harness reads as a broken runtime.
    return { validity: 'INVALID_INFRA', reason: `unclassified launch failure: ${kind}` };
  }

  if (expected.repositoryRevision && row.repositoryRevision !== expected.repositoryRevision) {
    return {
      validity: 'INVALID_SNAPSHOT',
      reason: `ran against ${row.repositoryRevision ?? 'an unrecorded revision'}, expected ${expected.repositoryRevision}`,
    };
  }
  if (expected.environmentFingerprint && row.environmentFingerprint !== expected.environmentFingerprint) {
    return {
      validity: 'INVALID_ENV',
      reason: `environment ${row.environmentFingerprint ?? 'unrecorded'} differs from ${expected.environmentFingerprint}`,
    };
  }

  const anomaly = telemetryAnomaly(row);
  if (anomaly) return { validity: 'INVALID_TELEMETRY', reason: anomaly };

  // A FAILED state is a real result about the product and belongs in the
  // statistics. That is the whole point of separating validity from success.
  return { validity: 'VALID', reason: row.state === 'FAILED' ? 'a real product failure' : 'ok' };
}

/** Every row classified, with the invalid ones counted rather than dropped. */
export function partitionByValidity(rows, expected = {}) {
  const classified = rows.map((row) => ({ ...row, ...classifyValidity(row, expected) }));
  const counts = Object.fromEntries(VALIDITY.map((name) => [name, 0]));
  for (const row of classified) counts[row.validity]++;
  return {
    rows: classified,
    valid: classified.filter((row) => row.validity === 'VALID'),
    invalid: classified.filter((row) => row.validity !== 'VALID'),
    counts,
  };
}

/** One line per class, for a report that has to say what it excluded. */
export function renderValidity(partition) {
  const lines = [`valid ${partition.counts.VALID} of ${partition.rows.length}`];
  for (const name of VALIDITY) {
    if (name === 'VALID' || partition.counts[name] === 0) continue;
    const reasons = [...new Set(partition.invalid.filter((r) => r.validity === name).map((r) => r.reason))];
    lines.push(`  ${name}: ${partition.counts[name]} (${reasons.join('; ')})`);
  }
  if (partition.counts.VALID === 0) {
    lines.push('  NOTHING VALID — this run says nothing about the product.');
  }
  return lines.join('\n');
}
