/** The one door every System-1 question goes through, harness and model alike.
 *
 *  Deterministic controls only, and all of them here so that no caller can
 *  reach a provider around one:
 *
 *   - **dedup**: the same digest is answered once per scope and replayed free;
 *   - **budget**: a scope may spend a fixed number of provider calls, and a
 *     retry spends from the same count (a retry never gets a fresh budget);
 *   - **bounded retry**: at most one, only for transient faults, and inside the
 *     decision's latency budget;
 *   - **stale refusal**: a judgment computed against an older state version
 *     than the caller now holds is returned as a failure, never applied;
 *   - **calibration**: every judgment passes through it before anyone reads it.
 *
 *  A failure here is not an error. It is an explicit outcome that every
 *  surface has a deterministic fallback for, and none of those fallbacks is
 *  the old semantic heuristic. */
import { calibrate } from './calibration.js';
import { ProviderFailure, type ProviderFailureKind, type System1Provider } from './provider.js';
import { assertValidJudgment, type DecisionJudgment, type DecisionRequest } from './types.js';

export type GuardFailureKind = ProviderFailureKind | 'budget' | 'stale' | 'disabled';

export interface JudgeOutcome {
  request: DecisionRequest;
  judgment?: DecisionJudgment;
  failure?: { kind: GuardFailureKind; reason: string };
  /** Replayed from an earlier identical question: no provider call, no cost. */
  cached: boolean;
  /** Provider attempts spent on this batch (shared by every request in it). */
  attempts: number;
  latencyMs: number;
}

export interface JudgeOptions {
  /** CherryOnTop's confidence in the state these questions describe. */
  orchestration: number;
  /** Read *after* the provider answers, so a state that moved on while the
   *  question was in flight is caught. Absent means the state cannot move. */
  currentStateVersion?: () => number;
}

export interface System1 {
  readonly provider: string;
  judge(scope: string, requests: readonly DecisionRequest[], options: JudgeOptions): Promise<JudgeOutcome[]>;
  /** Calls spent and left in a scope. */
  usage(scope: string): { calls: number; remaining: number };
  forget(scope: string): void;
}

export interface GuardConfig {
  maxCallsPerScope: number;
  timeoutMs: number;
  now?: () => number;
}

const TRANSIENT: ReadonlySet<ProviderFailureKind> = new Set(['timeout', 'unavailable', 'http']);
const MAX_ATTEMPTS = 2;

interface Scope {
  calls: number;
  answers: Map<string, DecisionJudgment>;
}

export function createSystem1(provider: System1Provider | null, config: GuardConfig): System1 {
  const now = config.now ?? Date.now;
  const scopes = new Map<string, Scope>();
  const scopeOf = (id: string): Scope => {
    let s = scopes.get(id);
    if (!s) scopes.set(id, s = { calls: 0, answers: new Map() });
    return s;
  };

  return {
    provider: provider?.name ?? 'none',
    usage(scope) {
      const s = scopeOf(scope);
      return { calls: s.calls, remaining: Math.max(0, config.maxCallsPerScope - s.calls) };
    },
    forget(scope) { scopes.delete(scope); },

    async judge(scopeId, requests, options) {
      const scope = scopeOf(scopeId);
      const started = now();
      const outcomes: JudgeOutcome[] = requests.map((request) => {
        const cached = scope.answers.get(request.inputDigest);
        return cached
          ? { request, judgment: { ...cached, requestId: request.id }, cached: true, attempts: 0, latencyMs: 0 }
          : { request, cached: false, attempts: 0, latencyMs: 0 };
      });

      // One provider question per distinct digest, however often it was asked.
      const pending = new Map<string, number[]>();
      outcomes.forEach((o, i) => {
        if (o.cached) return;
        pending.set(o.request.inputDigest, [...(pending.get(o.request.inputDigest) ?? []), i]);
      });
      if (pending.size === 0) return outcomes;

      const failAll = (kind: GuardFailureKind, reason: string, attempts: number) => {
        for (const indices of pending.values()) {
          for (const i of indices) outcomes[i] = { ...outcomes[i], failure: { kind, reason }, attempts, latencyMs: now() - started };
        }
        return outcomes;
      };

      if (!provider) return failAll('disabled', 'no System-1 provider is configured', 0);

      const unique = [...pending.values()].map((indices) => requests[indices[0]]);
      const deadline = started + config.timeoutMs;
      let attempts = 0;
      let judgments: DecisionJudgment[] | undefined;
      let lastFailure: ProviderFailure | undefined;
      while (attempts < MAX_ATTEMPTS) {
        if (scope.calls >= config.maxCallsPerScope) {
          return failAll('budget', `System-1 budget spent (${scope.calls} of ${config.maxCallsPerScope} calls)`, attempts);
        }
        const left = deadline - now();
        if (left <= 0) break;
        scope.calls++;
        attempts++;
        try {
          judgments = await provider.decide(unique, { timeoutMs: left });
          break;
        } catch (err) {
          lastFailure = err instanceof ProviderFailure ? err : new ProviderFailure('malformed', String(err));
          if (!TRANSIENT.has(lastFailure.kind)) break;
        }
      }
      if (!judgments) {
        return failAll(lastFailure?.kind ?? 'timeout', lastFailure?.message ?? 'the decision latency budget ran out', attempts);
      }

      const version = options.currentStateVersion?.();
      unique.forEach((request, u) => {
        const indices = pending.get(request.inputDigest)!;
        let outcome: Pick<JudgeOutcome, 'judgment' | 'failure'>;
        try {
          const judgment = judgments![u];
          // Re-checked here rather than trusted from the provider: this is the
          // boundary, and a fake or future provider must meet it too.
          assertValidJudgment(judgment, request);
          if (version !== undefined && version !== request.stateVersion) {
            outcome = { failure: { kind: 'stale', reason: `asked about state v${request.stateVersion}, state is now v${version}` } };
          } else {
            const calibrated = calibrate(judgment, options.orchestration);
            scope.answers.set(request.inputDigest, calibrated);
            outcome = { judgment: calibrated };
          }
        } catch (err) {
          outcome = { failure: { kind: 'malformed', reason: err instanceof Error ? err.message : String(err) } };
        }
        for (const i of indices) {
          outcomes[i] = {
            ...outcomes[i], ...outcome,
            ...(outcome.judgment ? { judgment: { ...outcome.judgment, requestId: outcomes[i].request.id } } : {}),
            attempts, latencyMs: now() - started,
          };
        }
      });
      return outcomes;
    },
  };
}

// ---------------------------------------------------------------------------
// The process-wide instance. Module state for the same reason the sandbox
// limiter is: the budget and the dedup cache are properties of the daemon, and
// threading one handle through every lifecycle call site would buy nothing.
// Unconfigured means "no provider", so tests and a daemon without Laya get the
// deterministic fallback rather than a hang.
// ---------------------------------------------------------------------------

let current: System1 = createSystem1(null, { maxCallsPerScope: 0, timeoutMs: 0 });

export function system1(): System1 {
  return current;
}

/** Installs the daemon's System-1. Returns a restore function for tests. */
export function setSystem1(next: System1): () => void {
  const previous = current;
  current = next;
  return () => { current = previous; };
}
