import { describe, it, expect } from 'vitest';
import {
  createTaskResourceEnvelope,
  reserveForDelegation,
  remainingEnvelope,
  canAfford,
} from './task-envelope.js';

describe('task resource envelope', () => {
  it('creates a normalized root envelope', () => {
    const envelope = createTaskResourceEnvelope({
      budgetUsd: 5,
      turns: 20,
      tokens: 12000,
      delegations: 2,
    });

    expect(envelope).toEqual({
      remainingBudgetUsd: 5,
      remainingTurns: 20,
      remainingTokens: 12000,
      remainingDelegations: 2,
    });
  });

  it('rejects a reservation that exceeds any resource', () => {
    const envelope = createTaskResourceEnvelope({
      budgetUsd: 1,
      turns: 10,
      tokens: 5000,
      delegations: 1,
    });

    expect(canAfford(envelope, {
      budgetUsd: 1.01,
      turns: 2,
      tokens: 100,
      delegations: 0,
    })).toBe(false);
  });

  it('reserves valid resources without mutating the original envelope', () => {
    const envelope = createTaskResourceEnvelope({
      budgetUsd: 5,
      turns: 20,
      tokens: 12000,
      delegations: 2,
    });

    const next = reserveForDelegation(envelope, {
      budgetUsd: 1.5,
      turns: 6,
      tokens: 3000,
      delegations: 1,
    });

    expect(next).toEqual({
      remainingBudgetUsd: 3.5,
      remainingTurns: 14,
      remainingTokens: 9000,
      remainingDelegations: 1,
    });
    expect(envelope.remainingBudgetUsd).toBe(5);
    expect(envelope.remainingTurns).toBe(20);
  });

  it('does not partially apply an unaffordable reservation', () => {
    const envelope = createTaskResourceEnvelope({
      budgetUsd: 1,
      turns: 10,
      tokens: 5000,
      delegations: 1,
    });

    expect(reserveForDelegation(envelope, {
      budgetUsd: 0.5,
      turns: 11,
      tokens: 100,
      delegations: 1,
    })).toEqual(envelope);
  });

  it('returns a stable copy of remaining resources', () => {
    const envelope = createTaskResourceEnvelope({
      budgetUsd: 5,
      turns: 20,
      tokens: 12000,
      delegations: 2,
    });

    expect(remainingEnvelope(envelope)).toEqual(envelope);
    expect(remainingEnvelope(envelope)).not.toBe(envelope);
  });
});
