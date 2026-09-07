import type { RuntimeStat } from '../db/queries/memory.js';

export interface SelectRuntimeInput {
  /** Which adapters this deployment can actually dispatch to. Never widened
   *  from memory: a runtime the org once used but no longer has installed must
   *  not be chosen. */
  available: string[];
  stats: RuntimeStat[];
  /** Below this, a runtime's history is a coincidence rather than evidence. */
  minRuns?: number;
}

export interface SelectRuntimeResult {
  runtime: string;
  breakdown: Record<string, number>;
}

const DEFAULT_RUNTIME = 'claude-code';
const MIN_RUNS = 3;

// Doc §10's shape, applied to runtime choice rather than delegation: a score
// built from terms you can read off, not a model's opinion.
//   score = successRate - costPenalty - latencyPenalty
// Cost and latency are normalized against the *best* observed runtime, so the
// weights mean the same thing whether runs cost cents or dollars.
const COST_WEIGHT = 0.3;
const LATENCY_WEIGHT = 0.15;
// Both penalties are capped. The ratio to the best runtime is unbounded — one
// runtime being four times the price of another produces a penalty of 0.9,
// which is larger than the entire 0..1 range of success rate, so a cheap
// runtime that fails half its runs would beat a reliable expensive one. A
// failed run costs everything it spent and delivers nothing, so reliability
// must dominate: these caps let cost and latency break a near-tie and never
// more.
const MAX_COST_PENALTY = 0.25;
const MAX_LATENCY_PENALTY = 0.15;

/** Picks the runtime to dispatch with, and shows its working. The breakdown is
 *  persisted as a Decision, which is what makes "why did you switch from Claude
 *  to Codex?" a question with an evidence-backed answer instead of a guess. */
export function selectRuntime(input: SelectRuntimeInput): SelectRuntimeResult {
  const minRuns = input.minRuns ?? MIN_RUNS;
  const fallback = input.available.includes(DEFAULT_RUNTIME)
    ? DEFAULT_RUNTIME
    : input.available[0];

  const usable = input.stats.filter(
    (stat) => input.available.includes(stat.runtime) && stat.runs >= minRuns,
  );

  // Nothing has been observed enough to justify moving off the default. Saying
  // so in the breakdown is the point — a fallback that looks like a decision is
  // worse than no decision.
  if (usable.length === 0) {
    return {
      runtime: fallback,
      breakdown: { score: 0, reason_insufficient_history: 1, runsRequired: minRuns },
    };
  }

  const bestCost = Math.min(...usable.map((s) => s.avgCostUsd));
  const bestLatency = Math.min(...usable.map((s) => s.avgLatencyMs));

  const scored = usable.map((stat) => {
    const costPenalty = bestCost > 0
      ? Math.min((stat.avgCostUsd / bestCost - 1) * COST_WEIGHT, MAX_COST_PENALTY)
      : 0;
    const latencyPenalty = bestLatency > 0
      ? Math.min((stat.avgLatencyMs / bestLatency - 1) * LATENCY_WEIGHT, MAX_LATENCY_PENALTY)
      : 0;
    return {
      stat,
      costPenalty,
      latencyPenalty,
      score: stat.successRate - costPenalty - latencyPenalty,
    };
  });

  // Ties go to the more-observed runtime rather than to whichever sorted first.
  scored.sort((a, b) => b.score - a.score || b.stat.runs - a.stat.runs);
  const winner = scored[0];

  return {
    runtime: winner.stat.runtime,
    breakdown: {
      successRate: winner.stat.successRate,
      costPenalty: winner.costPenalty,
      latencyPenalty: winner.latencyPenalty,
      score: winner.score,
      runs: winner.stat.runs,
      avgCostUsd: winner.stat.avgCostUsd,
      avgLatencyMs: winner.stat.avgLatencyMs,
      alternativesConsidered: scored.length,
    },
  };
}
