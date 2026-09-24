/** A deterministic stand-in for Laya, for tests that exercise paths behind a
 *  System-1 judgment. Answers every noul with `probability`, every choice with
 *  its first option, and records what it was asked. */
import { createSystem1, setSystem1 } from './guard.js';
import type { System1Provider } from './provider.js';
import type { DecisionJudgment, DecisionRequest } from './types.js';

export function fakeLaya(probability: number): System1Provider & { asked: DecisionRequest[] } {
  const asked: DecisionRequest[] = [];
  return {
    name: 'laya',
    asked,
    async decide(requests) {
      asked.push(...requests);
      return requests.map((r): DecisionJudgment => ({
        requestId: r.id, provider: 'laya', surface: r.surface, primitive: r.primitive,
        result: r.primitive === 'choice'
          ? { selectedId: r.candidates[0].id, probabilities: Object.fromEntries(r.candidates.map((c, i) => [c.id, i === 0 ? 1 : 0])) }
          : r.primitive === 'score' ? { score: { value: 0, min: 0, max: r.candidates.length - 1 } } : { probability },
        calibration: { rawProbability: probability, version: 'fake' },
        confidence: { provider: 1, orchestration: 0 },
        metadata: {
          model: 'fake', questionVersion: r.questionVersion, inputDigest: r.inputDigest,
          stateVersion: r.stateVersion, latencyMs: 0, inputTokens: 0,
        },
      }));
    },
  };
}

/** Installs a fake Laya as the process System-1. Returns the restore function. */
export function useFakeLaya(probability: number): { restore: () => void; provider: ReturnType<typeof fakeLaya> } {
  const provider = fakeLaya(probability);
  const restore = setSystem1(createSystem1(provider, { maxCallsPerScope: 100, timeoutMs: 1_000 }));
  return { restore, provider };
}
