export interface TaskResourceEnvelope {
  remainingBudgetUsd: number;
  remainingTurns: number;
  remainingTokens: number;
  remainingDelegations: number;
}

export interface ResourceReservation {
  budgetUsd: number;
  turns: number;
  tokens: number;
  delegations: number;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function createTaskResourceEnvelope(input: ResourceReservation): TaskResourceEnvelope {
  return {
    remainingBudgetUsd: Math.max(0, finite(input.budgetUsd)),
    remainingTurns: Math.max(0, Math.floor(finite(input.turns))),
    remainingTokens: Math.max(0, Math.floor(finite(input.tokens))),
    remainingDelegations: Math.max(0, Math.floor(finite(input.delegations))),
  };
}

export function canAfford(
  envelope: TaskResourceEnvelope,
  reservation: ResourceReservation,
): boolean {
  return reservation.budgetUsd >= 0
    && reservation.turns >= 0
    && reservation.tokens >= 0
    && reservation.delegations >= 0
    && reservation.budgetUsd <= envelope.remainingBudgetUsd
    && reservation.turns <= envelope.remainingTurns
    && reservation.tokens <= envelope.remainingTokens
    && reservation.delegations <= envelope.remainingDelegations;
}

export function reserveForDelegation(
  envelope: TaskResourceEnvelope,
  reservation: ResourceReservation,
): TaskResourceEnvelope {
  if (!canAfford(envelope, reservation)) return { ...envelope };
  return {
    remainingBudgetUsd: envelope.remainingBudgetUsd - reservation.budgetUsd,
    remainingTurns: envelope.remainingTurns - Math.floor(reservation.turns),
    remainingTokens: envelope.remainingTokens - Math.floor(reservation.tokens),
    remainingDelegations: envelope.remainingDelegations - Math.floor(reservation.delegations),
  };
}

export function remainingEnvelope(envelope: TaskResourceEnvelope): TaskResourceEnvelope {
  return { ...envelope };
}
