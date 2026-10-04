import { describe, it, expect } from 'vitest';
import {
  uninformedDifficulty, difficultyFrom, mergeDifficulty, withObservedFailures, withSemanticEstimate,
  upperDifficulty, roleOpenness, dispatchDifficulty,
} from './difficulty.js';
import { SHRINKAGE_K } from '../learning/hierarchical.js';

describe('an uninformed belief', () => {
  it('knows nothing: middle of the scale, zero concentration, zero confidence', () => {
    const d = uninformedDifficulty();
    expect(d).toMatchObject({ value: 0.5, concentration: 0, confidence: 0, sources: [] });
  });

  it('is pessimistic in proportion to how little it knows', () => {
    const wide = upperDifficulty(uninformedDifficulty(), 0.9);
    const narrow = upperDifficulty(difficultyFrom(0.5, 200, 'history'), 0.9);
    expect(wide).toBeGreaterThan(narrow);
    expect(narrow).toBeGreaterThanOrEqual(0.5);
    expect(narrow).toBeLessThan(0.6);
  });

  it('is more pessimistic when the contract demands more confidence', () => {
    const d = difficultyFrom(0.5, 8, 'history');
    expect(upperDifficulty(d, 0.95)).toBeGreaterThan(upperDifficulty(d, 0.6));
  });
});

describe('merging evidence', () => {
  it('weights by concentration and adds it', () => {
    const merged = mergeDifficulty(difficultyFrom(0.2, 30, 'history'), difficultyFrom(0.8, 10, 'system1'));
    expect(merged.value).toBeCloseTo(0.35);
    expect(merged.concentration).toBe(40);
    expect(merged.confidence).toBeCloseTo(40 / (40 + SHRINKAGE_K));
    expect(merged.sources).toEqual(['history', 'system1']);
  });

  it('ignores evidence with no concentration rather than averaging it in', () => {
    const merged = mergeDifficulty(difficultyFrom(0.2, 10, 'history'), difficultyFrom(0.9, 0, 'system1'));
    expect(merged.value).toBeCloseTo(0.2);
  });
});

describe('observed failures', () => {
  it('raise difficulty toward 1 and add concentration, and change nothing at zero pressure', () => {
    const prior = difficultyFrom(0.4, 8, 'history');
    const after = withObservedFailures(prior, 0.5);
    expect(after.value).toBeCloseTo(0.4 + 0.6 * 0.5);
    expect(after.concentration).toBeGreaterThan(prior.concentration);
    expect(after.sources).toContain('observed_failures');
    expect(withObservedFailures(prior, 0)).toBe(prior);
  });

  it('move an uninformed belief too', () => {
    const after = withObservedFailures(uninformedDifficulty(), 0.5);
    expect(after.value).toBeCloseTo(0.75);
    expect(after.concentration).toBeGreaterThan(0);
  });
});

describe('a semantic estimate', () => {
  it('may raise a belief freely and is weighted by how much each side deserves belief', () => {
    const current = difficultyFrom(0.4, 8, 'history');
    const after = withSemanticEstimate(current, 0.8, 0.5);
    expect(after.value).toBeGreaterThan(0.4);
    expect(after.value).toBeLessThan(0.8);
    expect(after.sources).toContain('system1');
  });

  it('never argues below what observed failures established', () => {
    const failing = withObservedFailures(difficultyFrom(0.4, 8, 'history'), 0.5);
    expect(withSemanticEstimate(failing, 0.05, 1).value).toBeGreaterThanOrEqual(failing.value);
    expect(withSemanticEstimate(failing, 0.99, 1).value).toBeGreaterThan(failing.value);
  });

  it('with no confidence changes nothing', () => {
    const current = difficultyFrom(0.4, 8, 'history');
    expect(withSemanticEstimate(current, 0.9, 0).value).toBeCloseTo(0.4);
  });
});

describe('a dispatch carries part of the task', () => {
  it('scales by how open-ended the role is', () => {
    expect(roleOpenness(60, 60)).toBe(1);
    expect(roleOpenness(1, 60)).toBeLessThan(roleOpenness(6, 60));
    expect(roleOpenness(undefined, 60)).toBe(1);
    const task = difficultyFrom(0.8, 8, 'history');
    expect(dispatchDifficulty(task, roleOpenness(6, 60))).toBeLessThan(dispatchDifficulty(task, 1));
  });
});
