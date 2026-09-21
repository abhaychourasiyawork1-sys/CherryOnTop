#!/usr/bin/env node
/** The strategy regimes the architecture is actually judged on, and whether
 *  each one was reachable, exercised, and measured.
 *
 *  The previous paired run was read as if features the benchmark never
 *  activated had been tested. They had not. Three facts, never collapsed:
 *
 *    reachable — the preconditions for this regime hold in this configuration
 *    exercised — a run actually took this strategy
 *    measured  — a *paired* run showed taking it changed the outcome
 *
 *  A regime whose preconditions do not hold — delegation switched off, no
 *  verifier configured — is reported `UNREACHABLE`. It is emphatically not a
 *  failed task: "the configuration forbade this" and "the product could not do
 *  this" are different claims, and only one of them is a regression.
 *
 *  Every precondition is declared *before* the run, so a report cannot be
 *  rationalised afterwards into whatever the run happened to do.
 *
 *  Pure data and pure functions. Run directly to print the manifest:
 *  `node bench/strategy-regimes.mjs`.
 */

/** What each regime needs in order to be possible at all.
 *
 *  `requires` names configuration facts, not outcomes. A regime is unreachable
 *  when the configuration forbids it; it is *unexercised* when the
 *  configuration allowed it and no run chose it — which is a result about the
 *  policy, and worth seeing. */
export const STRATEGY_REGIMES = [
  {
    id: 'MANAGED_SIMPLE',
    strategy: 'MANAGED',
    requires: [],
    expectation: 'One execution dispatch. No planner, no classifier, no child, no synthesis. The regression the whole architecture exists to remove.',
  },
  {
    id: 'MANAGED_MEDIUM',
    strategy: 'MANAGED',
    requires: [],
    expectation: 'One dispatch, observed verification, no fan-out.',
  },
  {
    id: 'MANAGED_RISKY',
    strategy: 'MANAGED',
    requires: [],
    expectation: 'A wide change validated at V2 or above; cheaper evidence must not clear it.',
  },
  {
    id: 'SERIAL_DELEGATED',
    strategy: 'SERIAL_DELEGATED',
    requires: ['spawn_children', 'child_budget'],
    expectation: 'A validated plan whose branches must run in order. A good outcome, not a degraded parallel run.',
  },
  {
    id: 'PARALLEL_DELEGATED',
    strategy: 'PARALLEL_DELEGATED',
    requires: ['spawn_children', 'child_budget', 'multiple_children'],
    expectation: 'Independent branches, no write conflicts, and economics that preferred concurrency to ordering.',
  },
  {
    id: 'PARTIAL_DELEGATION_RECOVERY',
    strategy: 'SERIAL_DELEGATED',
    requires: ['spawn_children', 'child_budget', 'multiple_children'],
    expectation: 'One child fails; independent successful siblings are retained and only blocked work is reconsidered.',
  },
  {
    id: 'VALIDATION_ESCALATION',
    strategy: 'MANAGED',
    requires: [],
    expectation: 'Cheap evidence is insufficient, so the ladder climbs — and stops at the cheapest level that clears the floor.',
  },
  {
    id: 'CONTEXT_EXPANSION',
    strategy: 'MANAGED',
    requires: ['context_planner'],
    expectation: 'One artifact requested at the boundary, charged once, and available to the next dispatch.',
  },
];

/** Every column a regime row reports. Named here so a report that silently
 *  stops emitting one is a diff rather than an absence nobody notices. */
export const REGIME_COLUMNS = [
  'reachability', 'exercised', 'validity', 'success', 'cost', 'turns',
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'wallSeconds',
  'validationLevel', 'recoveryCount', 'strategy',
];

/** The configuration facts a deployment can hold. Read from the same
 *  environment the daemon reads, so the manifest describes the run that is
 *  about to happen rather than an idealised one. */
export function capabilitiesOf(env = process.env) {
  const childCap = Number(env.ORG_MAX_CHILD_JOBS ?? 2);
  const budget = Number(env.ORG_BENCH_BUDGET_USD ?? 5);
  return {
    spawn_children: childCap > 0,
    multiple_children: childCap > 1,
    // Two shares have to clear the per-agent floor or a delegation only ever
    // escalates — see MIN_AGENT_BUDGET_USD.
    child_budget: budget >= 1,
    context_planner: Number(env.ORG_REPO_MAP_TOKENS ?? 6000) > 0,
  };
}

/** `REACHABLE` or `UNREACHABLE`, with the preconditions that failed.
 *
 *  Never `FAILED`. A configuration that forbids delegation has not discovered
 *  that delegation is broken. */
export function reachabilityOf(regime, capabilities) {
  const missing = regime.requires.filter((requirement) => !capabilities[requirement]);
  return {
    id: regime.id,
    reachability: missing.length === 0 ? 'REACHABLE' : 'UNREACHABLE',
    missing,
  };
}

export function manifest(env = process.env) {
  const capabilities = capabilitiesOf(env);
  return STRATEGY_REGIMES.map((regime) => ({
    ...regime,
    ...reachabilityOf(regime, capabilities),
  }));
}

/** Rows that may become policy-learning evidence.
 *
 *  Invalid rows are counted and set aside, never dropped: "twelve runs, nine of
 *  them valid" and "nine runs" are different statements and only the first is
 *  honest. An unreachable regime contributes no evidence either — there was no
 *  run to learn from. */
export function learnableRows(rows) {
  const excluded = {};
  const usable = rows.filter((row) => {
    const reason = row.reachability === 'UNREACHABLE'
      ? 'UNREACHABLE'
      : row.validity !== 'VALID' ? row.validity : null;
    if (reason) {
      excluded[reason] = (excluded[reason] ?? 0) + 1;
      return false;
    }
    return true;
  });
  return { usable, excluded, total: rows.length };
}

/** Whether a regime was taken by any recorded run. Separate from reachable on
 *  purpose: a reachable regime nothing chose is a fact about the policy, and
 *  the most interesting row in the table. */
export function exercisedIn(regime, rows) {
  return rows.some((row) => row.regime === regime.id || row.strategy === regime.strategy);
}

function render(rows) {
  const columns = ['regime', 'strategy', 'reachability', 'exercised', 'measured', 'missing'];
  const cells = rows.map((row) => [
    row.id, row.strategy, row.reachability, 'n/a', 'n/a',
    row.missing.length > 0 ? row.missing.join(',') : '-',
  ]);
  const widths = columns.map((column, i) =>
    Math.max(column.length, ...cells.map((cell) => String(cell[i]).length)));
  const line = (values) => `| ${values.map((v, i) => String(v).padEnd(widths[i])).join(' | ')} |`;
  console.log('\n## Strategy regimes\n');
  console.log(line(columns));
  console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
  for (const cell of cells) console.log(line(cell));
  console.log(`\nColumns reported per exercised regime: ${REGIME_COLUMNS.join(', ')}.`);
  console.log('`exercised` and `measured` stay n/a until a paid paired run fills them in.');
}

if (import.meta.url === `file://${process.argv[1]}`) render(manifest());
