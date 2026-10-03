// H2.6 offline analysis self-checks (unit suite; needs `npm run build`).
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG, outcomeY, report, effect, collectRun, collect, priceUsd, readLedger, carriedInWindow } from './analysis.mjs';
import { monitor, evaluateLook, lookPrefix, conditionalPower } from './monitor.mjs';
import { gate, clopperPearsonLower, costUpperBound, balanceCheck, funnel } from './gate.mjs';

const row = (i, Z, y, resolved = true, extra = {}) => ({
  rootTaskId: `t${i}`, phase: 'main', Z, W: i % 3 === 0, final: true, assignedAt: String(i).padStart(8, '0'),
  costAfterUsd: y, taskCostUsd: 1, resolved, substitute: false, carriedAtBstar: Z === 'available' && i % 3 === 0,
  laterRecover: false, interventionsPerTask: 0, ...extra,
});
/** n tasks alternating arms; the masked arm's Y shifted by `shift` SDs. */
function stream(n, shift = 0, resolvedA = 1, resolvedM = 1) {
  let s = 1;
  const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  return Array.from({ length: n }, (_, i) => {
    const Z = i % 2 ? 'masked' : 'available';
    return row(i, Z, 2 + gauss() + (Z === 'masked' ? shift : 0), rand() < (Z === 'masked' ? resolvedM : resolvedA));
  });
}

describe('the frozen constants', () => {
  it('match DESIGN.md', () => {
    expect(CONFIG.epsilon).toBe(0.5);
    expect(CONFIG.nMax).toBe(3035);
    expect(CONFIG.cMask).toBe(3400);
    expect(CONFIG.looks).toEqual([759, 1518, 2277, 3035]);
    expect(CONFIG.efficacyBoundaries).toEqual([4.046, 2.861, 2.336, 2.023]);
    expect(CONFIG.futility).toEqual({ looks: [2, 3], theta: 2.843, cpMin: 0.10 });
    expect(CONFIG.safety).toEqual({ constant: 2.363, marginResolution: 0.02 });
    expect(CONFIG.turnBudget.T).toBe(80);
    expect(CONFIG.turnBudget.R).toBe(20);
    expect(CONFIG.pilot.instances).toHaveLength(40);
    expect(new Set(CONFIG.pilot.instances).size).toBe(40);
  });
});

describe('static consistency', () => {
  it('runtime constants, config and the boundary simulation agree', async () => {
    const { H26 } = await import(new URL('../../../dist/experiment/recover-eligibility.js', import.meta.url).pathname);
    expect(H26).toEqual({ epsilon: CONFIG.epsilon, hmacPrefix: CONFIG.hmacPrefix, nMax: CONFIG.nMax, cMask: CONFIG.cMask });
    const sim = readFileSync(new URL('./boundaries.mjs', import.meta.url), 'utf8');
    expect(sim).toContain(`const N_MAX = ${CONFIG.nMax};`);
    expect(sim).toContain(`const LOOKS = [${CONFIG.looks.join(', ')}];`);
    expect(sim).toContain(`const EFFICACY = [${CONFIG.efficacyBoundaries.join(', ')}];`);
    expect(sim).toContain(`const SAFETY_Z = ${CONFIG.safety.constant};`);
    expect(sim).toContain(`const SAFETY_MARGIN = ${CONFIG.safety.marginResolution};`);
    expect(sim).toContain(`const THETA = ${CONFIG.futility.theta};`);
    expect(sim).toContain(`const EPS = ${CONFIG.epsilon};`);
    const frozen = JSON.parse(readFileSync(new URL('./boundaries-result.json', import.meta.url), 'utf8'));
    expect(frozen.constants.EFFICACY).toEqual(CONFIG.efficacyBoundaries);
    expect(frozen.nullValidation.every((s) => s.trials === 40000)).toBe(true);
    const design = readFileSync(new URL('./DESIGN.md', import.meta.url), 'utf8');
    for (const c of ['4.046', '2.861', '2.336', '2.023', '2.363', '3,035', '3,400', 'ε = 0.5']) expect(design).toContain(c);
  });
});

describe('the primary outcome', () => {
  it('Y = C(b*→end) + 1[not resolved]·C(task); ungraded counts as unresolved', () => {
    expect(outcomeY(row(0, 'available', 0.3, true))).toBeCloseTo(0.3);
    expect(outcomeY(row(0, 'available', 0.3, false))).toBeCloseTo(1.3);
    expect(outcomeY(row(0, 'available', 0.3, null))).toBeCloseTo(1.3);
  });
  it('prices tokens at the pinned snapshot', () => {
    expect(priceUsd({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheCreationTokens: 1e6 }, 'claude-haiku-4-5')).toBeCloseTo(1 + 5 + 0.1 + 2);
  });
});

describe('the information clock and looks', () => {
  it('a look is the enrollment prefix at which min(n_a, n_m) first reaches its threshold', () => {
    const rows = stream(1600);
    const p = lookPrefix(rows, 1);
    const na = p.filter((r) => r.Z === 'available').length; const nm = p.filter((r) => r.Z === 'masked').length;
    expect(Math.min(na, nm)).toBe(759);
    expect(lookPrefix(rows, 3)).toBeNull();
    // 759 / 3035: the threshold is ⌈N_max/4⌉, so t is 0.25 to four decimals.
    expect(evaluateLook(rows, 1).t).toBeCloseTo(0.25, 3);
  });
  it('the final look takes every enrolled task, not the threshold prefix', () => {
    const rows = stream(6100);
    expect(lookPrefix(rows, 4)).toHaveLength(6100);
    expect(lookPrefix(rows.slice(0, 6000), 4)).toBeNull();
  });
  it('non-final outcomes never count toward a look', () => {
    const rows = stream(1600).map((r, i) => (i % 10 === 0 ? { ...r, final: false } : r));
    expect(lookPrefix(rows, 2)).toBeNull();
  });
  it('a null stream continues; a large effect stops at the first look it crosses, with its sign', () => {
    expect(monitor(stream(1600))[0].action).not.toMatch(/efficacy/);
    const big = monitor(stream(1600, 1));
    expect(big[0].action).toBe('stop: efficacy');
    expect(big[0].efficacy).toBe('availability lowers cost-to-go');
  });
  it('futility is evaluated only at looks 2 and 3, by conditional power', () => {
    expect(evaluateLook(stream(1600), 1).conditionalPower).toBeNull();
    expect(evaluateLook(stream(3100), 2).conditionalPower).not.toBeNull();
    // The pre-registered rule: at z = 0, CP ≈ 0.197 at look 2 (no stop) and
    // ≈ 0.004 at look 3 (stop).
    expect(conditionalPower(0, 0.5)).toBeCloseTo(0.1975, 3);
    expect(conditionalPower(0, 0.75)).toBeLessThan(0.10);
    expect(conditionalPower(2.5, 0.5)).toBeGreaterThan(0.10);
  });
  it('safety stops are directional and labelled safety, not efficacy', () => {
    // Resolution differs, Y does not (no redo price), so only safety can fire.
    const flat = (rows) => rows.map((r) => ({ ...r, taskCostUsd: 0 }));
    const harm = evaluateLook(flat(stream(1600, 0, 0.6, 0.8)), 1);
    expect(harm.safety.harmStop).toBe(true);
    expect(harm.action).toBe('stop: harm (safety, not efficacy)');
    const withhold = evaluateLook(flat(stream(1600, 0, 0.8, 0.6)), 1);
    expect(withhold.safety.benefitForWithholdingStop).toBe(true);
    expect(withhold.action).toBe('stop: benefit-for-withholding (safety, not efficacy)');
  });
});

describe('the report', () => {
  it('after an unscheduled stop it is descriptive only', () => {
    const r = report(stream(300));
    expect(r.kind).toMatch(/descriptive/);
    expect(r.E1.intervalKind).toBe('descriptive, not a test');
  });
  it('at a scheduled look the interval uses that look\'s boundary', () => {
    const rows = stream(1600);
    const r = report(rows, { look: 1 });
    const e = effect(lookPrefix(rows, 1));
    expect(r.E1.na + r.E1.nm).toBe(lookPrefix(rows, 1).length);
    expect(r.E1.intervalKind).toBe('repeated-confidence');
    expect(r.E1.interval[1] - r.E1.estimate).toBeCloseTo(4.046 * e.se);
  });
  it('analyses every assigned main task by its recorded Z, and never divides by a carry-out rate', () => {
    const rows = [...stream(40), row(99, 'masked', 0.5, null, { phase: 'pilot' })];
    const r = report(rows);
    expect(r.E1.na + r.E1.nm).toBe(40);
    expect(r.carryOut.note).toMatch(/never a divisor/);
    expect(JSON.stringify(r)).not.toMatch(/execution effect|cace|wald/i);
    expect(r.wording).toMatch(/availability/);
  });
  it('E1′ is the W = 1 stratum, defined before assignment, never by the observed choice', () => {
    const rows = stream(60).map((x) => ({ ...x, chosenKind: x.Z === 'available' ? 'recover' : 'continue' }));
    const r = report(rows);
    expect(r.E1prime.na + r.E1prime.nm).toBe(rows.filter((x) => x.W).length);
  });
});

describe('the pilot gate', () => {
  it('uses the one-sided Clopper–Pearson lower bound and the conservative cost bound', () => {
    expect(clopperPearsonLower(6, 40)).toBeCloseTo(0.0674, 4);
    expect(clopperPearsonLower(0, 40)).toBe(0);
    const costs = Array.from({ length: 40 }, (_, i) => 0.2 + (i % 7) * 0.05);
    const u = costUpperBound(costs);
    expect(u.cU).toBeGreaterThanOrEqual(u.tBound);
    expect(u.cU).toBeGreaterThanOrEqual(u.bootstrapP95);
  });
  it('reproduces the design\'s worked illustration', () => {
    const g = gate({ x: 6, n: 40, costs: Array(40).fill(0.4), budgetUsd: 1e9, integrationPassed: true });
    // The exact bound is 0.067409…: ⌈6070 / 0.067409…⌉ = 90,059. The design's
    // illustration rounds p_L to 0.0674 first and gets 90,060.
    expect(g.pL).toBeCloseTo(0.0674, 4);
    expect(g.nTasksU).toBe(Math.ceil(6070 / g.pL));
    expect(Math.ceil(6070 / 0.0674)).toBe(90060);
    expect(g.costU).toBeCloseTo(g.nTasksU * 0.4, 6);
    expect(g.decision).toBe('GO');
  });
  it('is NO-GO with no trigger, no budget, over budget, or a failed integration criterion', () => {
    const base = { n: 40, costs: Array(40).fill(0.4), budgetUsd: 1e9, integrationPassed: true };
    expect(gate({ ...base, x: 0 }).decision).toBe('NO-GO');
    expect(gate({ ...base, x: 6, budgetUsd: null }).decision).toBe('NO-GO');
    expect(gate({ ...base, x: 6, budgetUsd: 30000 }).decision).toBe('NO-GO');
    expect(gate({ ...base, x: 6, integrationPassed: false }).decision).toBe('NO-GO');
  });
});

describe('collection from a real run database', () => {
  it('builds rows from the ledger, events and usage', async () => {
    const dist = new URL('../../../dist/db/client.js', import.meta.url).pathname;
    if (!existsSync(dist)) return;
    const { createDb } = await import(dist);
    const { openLedger } = await import(new URL('../../../dist/experiment/ledger.js', import.meta.url).pathname);
    const { recordDispatchUsage } = await import(new URL('../../../dist/db/queries/tokens.js', import.meta.url).pathname);
    const { insertNode } = await import(new URL('../../../dist/db/queries/nodes.js', import.meta.url).pathname);
    const { appendEvent } = await import(new URL('../../../dist/db/queries/events.js', import.meta.url).pathname);
    const dir = mkdtempSync(join(tmpdir(), 'h26-collect-'));
    const db = createDb(join(dir, 'state.db'));
    insertNode(db, { id: 'root', parentId: null, goal: 'g', repoPath: '/r', state: 'COMPLETE', createdAt: 't', updatedAt: 't',
      contract: { goal: 'g', definition_of_done: [], authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 1 }, constraints: [] } });
    const usage = (at, tokens) => recordDispatchUsage(db, { nodeId: 'root', role: 'execute', model: 'haiku', costUsd: 0, createdAt: at,
      usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 10 } });
    usage('2026-01-01T00:00:00Z', 1_000_000);
    const ledger = openLedger(join(dir, 'ledger.db'));
    ledger.insert({ experimentId: 'e', phase: 'main', rootTaskId: 'root', boundaryKey: 'root#9', z: 'masked',
      record: JSON.stringify({ W: true, recoverRank: 1, completedDispatchesToBstar: 1 }), recordSha256: 'h', createdAt: '2026-01-01T00:10:00Z' });
    ledger.insert({ experimentId: 'e', phase: 'main', rootTaskId: 'another-run', boundaryKey: 'x#1', z: 'available', record: '{}', recordSha256: 'h', createdAt: 't' });
    ledger.close();
    appendEvent(db, { nodeId: 'root', type: 'experiment.boundary', createdAt: '2026-01-01T00:10:01Z',
      payload: { role: 'bstar_decision', rootTaskId: 'root', decisionId: 'd1', chosenKind: 'continue', substitute: false, Z: 'masked' } });
    usage('2026-01-01T00:20:00Z', 500_000);
    writeFileSync(join(dir, 'grade.json'), JSON.stringify({ resolved: false }));
    const { rows } = collectRun(dir, readLedger(join(dir, 'ledger.db')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Z: 'masked', W: true, carriedAtBstar: false, resolved: false, final: true, dispatchesToBstar: 1 });
    expect(rows[0].costAfterUsd).toBeCloseTo(0.5);
    expect(rows[0].taskCostUsd).toBeCloseTo(1.5);
    expect(outcomeY(rows[0])).toBeCloseTo(2.0);
  });
});

describe('recover carried out at b*', () => {
  const tree = new Set(['n']);
  const ev = (type, at, payload) => ({ nodeId: 'n', type, createdAt: at, payload });
  const pivot = (at) => ev('step.progress', at, { message: 'pivoting rather than repeating' });
  it('counts a composite carrying recover, only within the b* step', () => {
    const d = ev('experiment.boundary', '01', { chosenKind: 'composite', chosenCarriesRecover: true, decisionId: 'd' });
    expect(carriedInWindow(d, [d, pivot('02'), ev('step.outcome', '03', {})], tree)).toBe(true);
    // A pivot after the b* step ended is a later recover, not this one.
    expect(carriedInWindow(d, [d, ev('step.outcome', '02', {}), pivot('03')], tree)).toBe(false);
    const cont = ev('experiment.boundary', '01', { chosenKind: 'continue', chosenCarriesRecover: false, decisionId: 'd' });
    expect(carriedInWindow(cont, [cont, pivot('02')], tree)).toBe(false);
  });
});

describe('the pilot gate', () => {
  it('criterion 3: the masked count is checked against Binomial(n_triggered, 0.5)', () => {
    expect(balanceCheck(3, 6).passed).toBe(true);
    expect(balanceCheck(0, 12).passed).toBe(false);
    expect(balanceCheck(0, 0).passed).toBe(true);
  });
  it('the denominator is the scheduled 40, not the runs that left a database', () => {
    expect(funnel([]).tasks).toBe(40);
  });
});

describe('provider-refused runs never enter the analysis', () => {
  it('collect() excludes them, with the reason, and keeps the valid run', async () => {
    const dist = new URL('../../../dist/db/client.js', import.meta.url).pathname;
    if (!existsSync(dist)) return;
    const { createDb } = await import(dist);
    const { insertNode } = await import(new URL('../../../dist/db/queries/nodes.js', import.meta.url).pathname);
    const { appendEvent } = await import(new URL('../../../dist/db/queries/events.js', import.meta.url).pathname);
    const root = mkdtempSync(join(tmpdir(), 'h26-invalid-'));
    const make = (name, outcome) => {
      mkdirSync(join(root, 'runs', name), { recursive: true });
      const db = createDb(join(root, 'runs', name, 'state.db'));
      insertNode(db, { id: name, parentId: null, goal: 'g', repoPath: '/r', state: 'FAILED', createdAt: 't', updatedAt: 't',
        contract: { goal: 'g', definition_of_done: [], authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 1 }, constraints: [] } });
      appendEvent(db, { nodeId: name, type: 'step.outcome', createdAt: 't', payload: outcome });
    };
    make('refused', { succeeded: false, message: 'Your Claude five-hour usage limit is used up, so the request was refused.' });
    make('agent-failure', { succeeded: false, message: 'error_max_turns' });
    const runs = collect(join(root, 'runs'));
    expect(runs.map((r) => r.run)).toEqual(['agent-failure']);
    expect(runs.excluded).toEqual([{ run: 'refused', kind: 'provider_limit', reason: 'usage_limit_message', eventType: 'step.outcome' }]);
  });
});
