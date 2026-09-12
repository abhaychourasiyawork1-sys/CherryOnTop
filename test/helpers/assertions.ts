import { expect } from 'vitest';

export function expectWithinBudget(actual: number, budget: number): void {
  expect(actual).toBeLessThanOrEqual(budget);
}

export function expectEventTypes(events: Array<{ type: string }>, types: string[]): void {
  expect(events.map((event) => event.type)).toEqual(types);
}

export function expectStructuredError(value: unknown, code: string): void {
  expect(value).toMatchObject({ code });
}

export function expectIdempotent<T>(first: T, second: T): void {
  expect(second).toEqual(first);
}
