/** Buying the cheapest evidence that clears the floor.
 *
 *  Two rules, and the second is the one that makes this economics rather than
 *  ceremony:
 *
 *   1. **Finishing is not succeeding.** `EXECUTION_FINISHED` is a fact about a
 *      process; `TASK_SUCCESS` is a claim about the world. The first can never
 *      become the second without something having checked, which is what the
 *      level ladder is for.
 *   2. **Stop at the lowest sufficient level.** A task whose floor is already
 *      cleared by a green test in its own trace must not pay to re-run it.
 *      Escalation is bought, one level at a time, and only while the level
 *      below is not enough — the same shape the context selector uses to buy
 *      detail.
 *
 *  Deterministic and total. The only level that can do any work is V3, and the
 *  work is injected: this module never shells out, so the whole ladder is
 *  testable without a repository. */
import { clamp01 } from '../efficiency/policy-types.js';
import {
  LEVEL_MODEL, VALIDATION_LEVELS, requiredConfidence, DEFAULT_VALIDATION_CONTRACT,
  type ValidationContract, type ValidationLevel,
} from './contract.js';

export interface ValidationResult {
  level: ValidationLevel;
  passed: boolean;
  confidence: number;
  tokens: number;
  latencyMs: number;
  /** What the verdict actually rests on. A result that cannot say what it
   *  checked is a result nobody can dispute, which is the property that makes a
   *  false success invisible. */
  evidenceIds: string[];
  /** Stable codes for why it came out this way. */
  reasonCodes: string[];
}

/** What the runtime already knows about a finished run.
 *
 *  Every field is something recorded elsewhere — the result event, the artifacts
 *  table, the tool stream, the definition of done. Nothing here is new
 *  telemetry, which is what makes V0-V2 free. */
export interface ValidationEvidence {
  /** The run reported success. The claim, not a check of it. */
  claimedSuccess: boolean;
  /** Ids of durable things produced: artifacts, edited files. */
  artifactIds: string[];
  /** Verifying commands observed in the trace, and whether they passed. */
  observedChecks: Array<{ id: string; command: string; passed: boolean }>;
  /** Definition-of-done items and their state. */
  requiredChecks: Array<{ id: string; text: string; met: boolean }>;
}

export const NO_EVIDENCE: ValidationEvidence = {
  claimedSuccess: false, artifactIds: [], observedChecks: [], requiredChecks: [],
};

/** Runs a check now. Returns null when the capability is not available, which
 *  is different from a check that ran and failed and must never be confused
 *  with it. */
export type FreshVerifier = () => { passed: boolean; evidenceId: string; tokens: number; latencyMs: number } | null;

interface LevelVerdict {
  available: boolean;
  passed: boolean;
  evidenceIds: string[];
  tokens: number;
  latencyMs: number;
  reason: string;
}

const unavailable = (reason: string): LevelVerdict =>
  ({ available: false, passed: false, evidenceIds: [], tokens: 0, latencyMs: 0, reason });

function assess(
  level: ValidationLevel,
  evidence: ValidationEvidence,
  verify: FreshVerifier | undefined,
): LevelVerdict {
  const model = LEVEL_MODEL[level];
  switch (level) {
    case 'V0':
      return evidence.claimedSuccess
        ? { available: true, passed: true, evidenceIds: ['claim:run-reported-success'], tokens: 0, latencyMs: 0, reason: 'run_claimed_success' }
        : unavailable('no_success_claim');

    case 'V1':
      return evidence.artifactIds.length > 0
        ? { available: true, passed: true, evidenceIds: [...evidence.artifactIds], tokens: 0, latencyMs: 0, reason: 'artifacts_produced' }
        : unavailable('no_artifacts');

    case 'V2': {
      if (evidence.observedChecks.length === 0) return unavailable('no_observed_verification');
      // A failing check in the trace is evidence *against*, and outranks the
      // passing ones beside it: a run whose test went red and then stopped
      // looking has not verified anything.
      const failed = evidence.observedChecks.filter((check) => !check.passed);
      const passed = evidence.observedChecks.filter((check) => check.passed);
      if (failed.length > 0 && passed.length === 0) {
        return {
          available: true, passed: false, evidenceIds: failed.map((c) => c.id),
          tokens: 0, latencyMs: 0, reason: 'observed_verification_failed',
        };
      }
      return {
        available: true, passed: passed.length > 0, evidenceIds: passed.map((c) => c.id),
        tokens: 0, latencyMs: 0, reason: passed.length > 0 ? 'observed_verification_passed' : 'observed_verification_failed',
      };
    }

    case 'V3': {
      if (!verify) return unavailable('no_verifier');
      const run = verify();
      if (!run) return unavailable('verifier_unavailable');
      return {
        available: true, passed: run.passed, evidenceIds: [run.evidenceId],
        tokens: run.tokens || model.tokens, latencyMs: run.latencyMs || model.latencyMs,
        reason: run.passed ? 'fresh_verification_passed' : 'fresh_verification_failed',
      };
    }
  }
}

export interface ValidateInput {
  evidence: ValidationEvidence;
  contract?: ValidationContract;
  /** The capability that can run a check now. Absent means V3 is simply not
   *  available, and the ladder stops at V2. */
  verify?: FreshVerifier;
}

/** The verdict, and what reaching it cost.
 *
 *  Walks the ladder from the cheapest level, accumulating cost, and stops the
 *  moment the level reached is confident enough for the contract. Never
 *  escalates past a level that *failed*: a red test is not a reason to go and
 *  find a greener one. */
export function validate(input: ValidateInput): ValidationResult {
  const contract = input.contract ?? DEFAULT_VALIDATION_CONTRACT;
  const required = requiredConfidence(contract);
  const reasonCodes: string[] = [];

  let best: { level: ValidationLevel; verdict: LevelVerdict } | null = null;
  let tokens = 0;
  let latencyMs = 0;

  for (const level of VALIDATION_LEVELS) {
    const verdict = assess(level, input.evidence, input.verify);
    if (!verdict.available) { reasonCodes.push(`${level}:${verdict.reason}`); continue; }

    tokens += verdict.tokens;
    latencyMs += verdict.latencyMs;
    reasonCodes.push(`${level}:${verdict.reason}`);
    best = { level, verdict };

    // Evidence against. Climbing further would be shopping for a verdict.
    if (!verdict.passed) break;
    // Enough. The whole point of the ladder: the cheapest sufficient level.
    if (LEVEL_MODEL[level].confidence >= required) break;
  }

  if (!best) {
    return {
      level: 'V0', passed: false, confidence: 0, tokens, latencyMs,
      evidenceIds: [], reasonCodes: [...reasonCodes, 'no_evidence_at_any_level'],
    };
  }

  const confidence = clamp01(LEVEL_MODEL[best.level].confidence);

  // Named checks are a floor on their own, and they are checked *after* the
  // ladder rather than inside it: an item a person asked for and nothing closed
  // is a failure however green the tests were.
  const unmet = input.evidence.requiredChecks.filter((check) => !check.met);
  if (unmet.length > 0) reasonCodes.push(`required_checks_unmet:${unmet.length}`);

  const passed = best.verdict.passed && confidence >= required && unmet.length === 0;
  if (!passed && best.verdict.passed && confidence < required) {
    reasonCodes.push('below_required_confidence');
  }

  return {
    level: best.level,
    passed,
    confidence,
    tokens,
    latencyMs,
    evidenceIds: best.verdict.evidenceIds,
    reasonCodes,
  };
}

/** Whether a finished execution may be recorded as a successful task.
 *
 *  The one predicate that stands between `EXECUTION_FINISHED` and
 *  `TASK_SUCCESS`, so no caller has to remember the rule — and so that a caller
 *  that forgets to ask is a caller that never claims success at all. */
export function canClaimSuccess(result: ValidationResult): boolean {
  return result.passed;
}
