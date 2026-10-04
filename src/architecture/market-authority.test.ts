/** One final decision authority, as tests.
 *
 *  These read the source because the claims are about what production code
 *  *contains*: that no execution path picks a harness or model outside the
 *  Action Market, that specialized engines cannot dispatch, that System-1
 *  cannot select, that there is no second market. A behavioural test cannot
 *  catch a bypass added beside the market for a case somebody thought special. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function productionFiles(dir = 'src'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionFiles(path));
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** The source with comments stripped, so prose may name what code may not do. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
}

const importers = (pattern: RegExp) => productionFiles().filter((file) => pattern.test(code(file)));

describe('no production execution decision bypasses the market', () => {
  it('builds execution candidates in exactly one runtime module', () => {
    expect(importers(/generateExecutionCandidates|markFeasibility/).sort())
      .toEqual(['src/intelligence/model-router.ts', 'src/intelligence/provider-router.ts', 'src/lifecycle/execution-market.ts'].sort());
  });

  it('keeps no model or harness selector anywhere in production', () => {
    // The retired authorities, by name. Any of them returning is a second
    // decision-maker beside the market.
    expect(importers(/\b(routeModel|routeProvider|fallbackProvider|selectRuntime|chooseAdapter|modelChoiceFor|decideExecutionPath|decideModel|decideEvidence|decideSynthesis|planEvidence|evaluateFallback)\b/)).toEqual([]);
  });

  it('dispatches every sandbox on a candidate the market committed to', () => {
    // Each executeStep call site hands its result to `runOnMarket`, which is
    // what settles the commitment and re-enters the market on refusal.
    const manager = code('src/lifecycle/node-actor-manager.ts');
    const dispatches = manager.match(/executeStep\(\{/g)?.length ?? 0;
    const committed = manager.match(/runOnMarket\(db, nodeId, '(plan|execute|synthesize)'/g)?.length ?? 0;
    expect(dispatches).toBeGreaterThan(0);
    expect(committed).toBe(dispatches);
    const selections = manager.match(/selectExecution\(db, \{/g)?.length ?? 0;
    expect(selections).toBeGreaterThanOrEqual(dispatches);
  });

  it('lets only the market choose among execution candidates', () => {
    const market = code('src/lifecycle/execution-market.ts');
    expect(market).toMatch(/chooseEconomicAction\(/);
    expect(market).toMatch(/book\.commit\(/);
  });
});

describe('specialized engines provide; they do not dispatch', () => {
  const providers = [
    'src/engines/decide-execution.ts',
    'src/intelligence/model-router.ts',
    'src/intelligence/provider-router.ts',
    'src/intelligence/integrate-results.ts',
    'src/execution/evidence-planner.ts',
    'src/recovery/engine.ts',
    'src/decision/system1-decision.ts',
  ];

  it('none of them can start a sandbox or reach an adapter', () => {
    for (const file of providers) {
      const source = code(file);
      expect(source, file).not.toMatch(/execute-step\.js|executeStep\(|adapters\/(claude-code|codex|stopgap)\.js/);
    }
  });

  it('none of them commits', () => {
    for (const file of providers) expect(code(file), file).not.toMatch(/commitAction|CommitmentBook/);
  });
});

describe('System-1 refines estimates; it never selects', () => {
  it('asks no choice question of the next action', () => {
    expect(code('src/decision/system1-decision.ts')).not.toMatch(/runtime\.next_action/);
  });

  it('returns whatever the market decides after refinement', () => {
    const source = code('src/decision/system1-decision.ts');
    expect(source).toMatch(/chooseEconomicAction\(\{ state, candidates: refined/);
  });

  it('is nowhere given a path to the execution market', () => {
    expect(importers(/execution-market\.js/).filter((f) => f.startsWith('src/system1/'))).toEqual([]);
  });
});

describe('no second market, no second state machine', () => {
  it('exports exactly one chooser in the decision layer', () => {
    const choosers = productionFiles('src/decision')
      .flatMap((file) => [...code(file).matchAll(/export function (choose\w*)/g)].map((m) => m[1]));
    expect(choosers).toEqual(['chooseEconomicAction']);
  });

  it('moves economic state only through the one reducer', () => {
    // The commitment lifecycle is events on `applyEconomicEvent`, not a table
    // of its own.
    const commitment = code('src/decision/commitment.ts');
    expect(commitment).toMatch(/applyEconomicEvent\(/);
    expect(commitment).not.toMatch(/version\s*\+\s*1/);
  });
});
