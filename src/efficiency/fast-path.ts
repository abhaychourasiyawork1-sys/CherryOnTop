export interface FastPathInput {
  goal: string;
  taskClass: string;
  complexity: 'low' | 'medium' | 'high';
  worthSplitting: boolean;
  anchors: string[];
}

export interface FastPathDecision {
  eligible: boolean;
  confidence: number;
  reason: string;
}

export function classifyFastPath(input: FastPathInput): FastPathDecision {
  if (input.worthSplitting) {
    return { eligible: false, confidence: 0, reason: 'task is explicitly or heuristically splittable' };
  }

  if (input.anchors.length !== 1) {
    return { eligible: false, confidence: 0.2, reason: 'fast path requires exactly one concrete anchor' };
  }

  if (input.complexity !== 'low') {
    return { eligible: false, confidence: 0.2, reason: 'fast path is restricted to low-complexity work' };
  }

  if (!['trivial_edit', 'documentation'].includes(input.taskClass)) {
    return { eligible: false, confidence: 0.4, reason: 'task class is not currently safe for the fast path' };
  }

  if (/\b(?:entire|whole|repository|repo|codebase|all|every|across|throughout)\b/i.test(input.goal)) {
    return { eligible: false, confidence: 0.2, reason: 'goal is broad despite having an anchor' };
  }

  return {
    eligible: true,
    confidence: 0.9,
    reason: 'single anchored low-complexity task with no split signal',
  };
}
