/** How much proving this particular task needs, and what it may spend proving
 *  it.
 *
 *  `contract.ts` answers "how right does this have to be" from one signal —
 *  how much the goal looks like it needs verifying. That is the right floor and
 *  the wrong shape for the decision the lifecycle actually faces, which is
 *  *which rung of the ladder is the minimum acceptable one*. A confidence floor
 *  and a minimum level are not the same statement: a delegated change with
 *  three children agreeing is confident and unverified.
 *
 *  So a profile adds three things a floor cannot say:
 *
 *   - **a minimum level.** A risky write must reach observed verification even
 *     if a cheaper level happened to clear the floor.
 *   - **whether fresh verification is on the table at all.** V3 costs money and
 *     wall-clock; a read-only investigation should not buy one, and a delegated
 *     change with weak proof should.
 *   - **why.** Every raise is a named risk reason, because a validation floor
 *     nobody can explain is one nobody will trust when it blocks a release.
 *
 *  A profile only ever *raises*. Explicit human-named checks are an independent
 *  floor on top of it and are never traded away. Deterministic and total: this
 *  decides what evidence is required, and runs none of it. */
import { contractFor, MINIMUM_QUALITY_FLOOR, type ValidationContract, type ValidationLevel } from './contract.js';
import type { ExecutionStrategy } from '../decision/strategy-gate.js';
import type { TaskEconomicsSignals } from '../efficiency/policy-types.js';

export interface ValidationProfile {
  qualityFloor: number;
  minimumLevel: ValidationLevel;
  requiredChecks: string[];
  freshVerificationAllowed: boolean;
  /** Tokens this task may spend establishing its own correctness. Zero means
   *  "only evidence that already exists", which is the common and cheapest
   *  case. */
  validationBudget: number;
  riskReasons: string[];
}

export interface ValidationProfileInput {
  strategy: ExecutionStrategy;
  economics: Pick<TaskEconomicsSignals,
    'complexityBand' | 'verificationNeed' | 'readOnly' | 'expectedModificationScope'>;
  requiredChecks?: string[];
  /** How many times this task has already failed and been recovered. A task on
   *  its third attempt has demonstrated that cheap evidence was not enough. */
  recoveryCount?: number;
  /** Whether a fresh verifier exists in this deployment at all. Absent means
   *  no: the ladder stops at V2 and says so rather than pretending. */
  freshVerifierAvailable?: boolean;
}

/** What one fresh verification is allowed to cost. Matches `LEVEL_MODEL.V3`,
 *  which is the only level that spends anything. */
const FRESH_VERIFICATION_BUDGET = 2_000;

/** Above this, a change is touching enough of the tree that "a file changed" is
 *  not evidence it changed correctly. */
const RISKY_MODIFICATION_SCOPE = 0.6;

const LEVEL_ORDER: Record<ValidationLevel, number> = { V0: 0, V1: 1, V2: 2, V3: 3 };

function atLeast(a: ValidationLevel, b: ValidationLevel): ValidationLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

export function validationProfileFor(input: ValidationProfileInput): ValidationProfile {
  const { economics } = input;
  const riskReasons: string[] = [];
  const requiredChecks = [...new Set(input.requiredChecks ?? [])];
  const recoveries = Math.max(0, input.recoveryCount ?? 0);

  // The floor stays where `contractFor` put it. A profile may raise the *level*
  // without inventing a second answer to the confidence question.
  const contract = contractFor({ verificationNeed: economics.verificationNeed, requiredChecks });

  // Start from the cheapest thing that is still evidence. V0 is never a
  // minimum: "the process exited zero" is the claim being checked.
  let minimumLevel: ValidationLevel = 'V1';

  const tiny = economics.complexityBand === 'tiny' || economics.complexityBand === 'small';
  if (!tiny) {
    minimumLevel = atLeast(minimumLevel, 'V2');
    riskReasons.push('not_a_small_change');
  }

  if (economics.expectedModificationScope >= RISKY_MODIFICATION_SCOPE) {
    minimumLevel = atLeast(minimumLevel, 'V2');
    riskReasons.push('wide_modification_scope');
  }

  // Delegated work is checked at V2 *and* aggregated across children — see
  // `delegated.ts`. A parent that accepted "all children reported success" has
  // validated a tally, not an outcome.
  if (input.strategy !== 'MANAGED') {
    minimumLevel = atLeast(minimumLevel, 'V2');
    riskReasons.push('delegated_work_needs_observed_verification');
  }

  // An investigation's durable result is a finding, not a green test. Holding
  // it to V2 would make every task of that shape permanently unverifiable,
  // which is the "silence is a pass" failure arrived at from the other side.
  if (economics.readOnly) {
    minimumLevel = 'V1';
    riskReasons.push('read_only_durable_finding');
  }

  if (recoveries > 0) {
    minimumLevel = atLeast(minimumLevel, 'V2');
    riskReasons.push(`prior_attempts_failed:${recoveries}`);
  }

  // Fresh verification is bought only where it can change the answer: a task
  // that writes, whose cheaper evidence has already proved insufficient, in a
  // deployment that actually has a verifier.
  const freshVerificationAllowed = input.freshVerifierAvailable === true
    && !economics.readOnly
    && (recoveries > 0 || economics.expectedModificationScope >= RISKY_MODIFICATION_SCOPE || input.strategy !== 'MANAGED');
  if (freshVerificationAllowed) riskReasons.push('fresh_verification_permitted');

  return {
    // Never below the global minimum, whatever a task signal said.
    qualityFloor: Math.max(MINIMUM_QUALITY_FLOOR, contract.qualityFloor),
    minimumLevel,
    requiredChecks,
    freshVerificationAllowed,
    validationBudget: freshVerificationAllowed ? FRESH_VERIFICATION_BUDGET : 0,
    riskReasons,
  };
}

/** The profile expressed as the contract the ladder already consumes.
 *
 *  Reuses `contractFor` rather than hardcoding a class-specific floor, and
 *  keeps the explicit checks exactly as the person wrote them. */
export function contractForProfile(profile: ValidationProfile): ValidationContract {
  return {
    qualityFloor: profile.qualityFloor,
    requiredChecks: profile.requiredChecks,
    allowedUncertainty: 1 - profile.qualityFloor,
  };
}

/** Whether a verdict cleared the profile's *level* floor as well as its
 *  confidence floor.
 *
 *  The two can disagree, and when they do the level wins: a task that demanded
 *  an observed check and got an artifact has not been verified, however
 *  confident the artifact made the arithmetic. */
export function meetsMinimumLevel(profile: ValidationProfile, reached: ValidationLevel): boolean {
  return LEVEL_ORDER[reached] >= LEVEL_ORDER[profile.minimumLevel];
}
