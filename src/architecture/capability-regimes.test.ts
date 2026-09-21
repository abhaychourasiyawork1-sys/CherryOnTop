import { describe, it, expect } from 'vitest';
import { CAPABILITY_REGIMES, buildScenario, buildAllScenarios } from './capability-regimes.js';

describe('capability preservation', () => {
  it.each([...CAPABILITY_REGIMES])('%s remains reachable', (regime) => {
    const result = buildScenario(regime);
    // The observed answer rides along so a failure names which capability went
    // and what the module said instead.
    expect(`${regime}:${result.reachable}:${result.observed}`).toBe(`${regime}:true:${result.observed}`);
  });

  it('covers every declared regime exactly once', () => {
    const scenarios = buildAllScenarios();
    expect(scenarios.map((s) => s.regime)).toEqual([...CAPABILITY_REGIMES]);
  });

  it('names an existing capability for every regime', () => {
    for (const scenario of buildAllScenarios()) {
      expect(scenario.capability.length).toBeGreaterThan(0);
    }
  });
});
