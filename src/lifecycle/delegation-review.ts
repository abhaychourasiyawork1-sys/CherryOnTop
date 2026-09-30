/** The parent's decision on a child's work.
 *
 *  A child finishing is a fact about a process. Whether the parent will take
 *  responsibility for what it produced is a separate decision, made here, from
 *  evidence — and it is the only path to `ACCEPTED`.
 *
 *  Two questions, kept apart on purpose:
 *   - did the child do what *it* was asked (its own validation, its authority,
 *     its prerequisites) — the existing `validateDelegatedOutcome` rules;
 *   - does the candidate satisfy what the *parent* required — acceptance checks
 *     the child may never have seen a reason to run.
 *
 *  A check is met only by evidence: a verifying command in the candidate's own
 *  trace that passed, or a fresh result from an injected verifier. Silence is a
 *  failure, not a pass — "no evidence" is exactly how a false acceptance would
 *  get through. Deterministic and total; nothing here shells out.
 */
import { validateDelegatedOutcome, type DelegatedChildOutcome } from '../validation/delegated.js';
import { MINIMUM_QUALITY_FLOOR } from '../validation/contract.js';
import type { ValidationResult } from '../validation/engine.js';
import type { FailedCheck } from './delegation-reports.js';
import { writeScopeViolations } from './delegation-scope.js';

export interface ObservedCheck { id: string; command: string; passed: boolean }

/** What a finished child leaves behind, as far as the parent's review is
 *  concerned. Everything is optional beyond the verdict: a runtime that records
 *  less simply gives the review less to accept on. */
export interface ChildRunResult {
  /** The child's own verdict — its validation passed. The claim's check, not
   *  the parent's acceptance. */
  succeeded: boolean;
  /** Stopped on purpose. Never reviewed, never replaced. */
  cancelled?: boolean;
  /** The child's final answer, prose with an optional result envelope. */
  answer?: string;
  /** Files the runtime observed the child write. */
  changedFiles?: string[];
  observedChecks?: ObservedCheck[];
  /** References to the durable evidence behind the run. */
  evidenceRefs?: string[];
  validation?: ValidationResult;
  /** Whether everything it did was inside its granted authority. Absent means
   *  nothing reported a breach. */
  authorityCompliant?: boolean;
  /** Changed files that still hold unresolved merge-conflict markers. A candidate
   *  that has any is not finished, whatever else is true of it. */
  conflictMarkers?: string[];
}

/** A fresh answer for one acceptance check, from a capability the trace does not
 *  have. Null means "cannot say" — never "failed". */
export type CheckVerifier = (check: string) => { passed: boolean; evidenceId: string; observed?: string } | null;

export interface ReviewInput {
  assignment: { id: string; acceptanceChecks: string[]; dependencies: string[]; writeScope?: string[] };
  run: ChildRunResult;
  verifyCheck?: CheckVerifier;
}

export interface ReviewVerdict {
  accepted: boolean;
  failedChecks: FailedCheck[];
  /** What the acceptance rests on (or, on failure, what it was refused on). */
  evidenceRefs: string[];
  reasons: string[];
}

const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');

interface CheckOutcome { check: string; met: boolean; observed: string; evidenceRefs: string[] }

function evaluateCheck(check: string, observed: ObservedCheck[], verify?: CheckVerifier): CheckOutcome {
  // A fresh result outranks the trace: it is about the tree as it stands, which
  // is the tree the parent would be taking responsibility for.
  const fresh = verify?.(check) ?? null;
  if (fresh) {
    return {
      check, met: fresh.passed,
      observed: fresh.passed ? 'verified on the candidate' : fresh.observed ?? 'failed on the candidate',
      evidenceRefs: [fresh.evidenceId],
    };
  }

  const wanted = normalize(check);
  // Either direction: "npm test passes" names the command `npm test`, and the
  // check `npm test` names the run `npm test --silent`.
  const matches = observed.filter((run) => {
    const command = normalize(run.command);
    return command.length >= 3 && (wanted.includes(command) || command.includes(wanted));
  });
  const passing = matches.filter((run) => run.passed);
  if (passing.length > 0) {
    return { check, met: true, observed: 'passed in the candidate\'s trace', evidenceRefs: passing.map((run) => run.id) };
  }
  if (matches.length > 0) {
    return { check, met: false, observed: 'the matching run failed', evidenceRefs: matches.map((run) => run.id) };
  }
  return { check, met: false, observed: 'no evidence in the candidate that this holds', evidenceRefs: [] };
}

/** What a child's own validation would have said, when nothing recorded it. The
 *  boolean is all there is, so it is all that is claimed. */
function fallbackValidation(succeeded: boolean): ValidationResult {
  return succeeded
    ? { level: 'V1', passed: true, confidence: 0.5, tokens: 0, latencyMs: 0, evidenceIds: ['child:validated'], reasonCodes: ['child_reported_validated'] }
    : { level: 'V0', passed: false, confidence: 0, tokens: 0, latencyMs: 0, evidenceIds: [], reasonCodes: ['child_did_not_validate'] };
}

export function reviewChildWork(input: ReviewInput): ReviewVerdict {
  const { assignment, run } = input;
  const validation = run.validation ?? fallbackValidation(run.succeeded);
  const observed = run.observedChecks ?? [];
  const changedFiles = run.changedFiles ?? [];
  const outcomes = assignment.acceptanceChecks.map((check) => evaluateCheck(check, observed, input.verifyCheck));

  const child: DelegatedChildOutcome = {
    id: assignment.id,
    succeeded: run.succeeded,
    validation,
    changedPaths: changedFiles,
    authorityCompliant: run.authorityCompliant ?? true,
    dependenciesSatisfied: true,
  };

  const result = validateDelegatedOutcome({
    parentRequiredChecks: assignment.acceptanceChecks,
    children: [child],
    mergedOutcome: {
      claimedSuccess: run.succeeded,
      artifactIds: changedFiles,
      // The child's own validated evidence is durable proof that something was
      // produced — including an investigation's report, which changes no file.
      durableOutcomeIds: validation.passed ? validation.evidenceIds : [],
      observedChecks: observed,
      requiredChecks: outcomes.map((outcome, index) => ({ id: `acceptance:${index}`, text: outcome.check, met: outcome.met })),
    },
    // The *child's* rigour was already decided by its own profile and is checked
    // above. The parent's floor is the lowest a delegated result may fall to —
    // work exists — and its own requirements arrive as named checks, which
    // `validate` treats as a floor no confidence can buy back.
    contract: {
      qualityFloor: MINIMUM_QUALITY_FLOOR,
      allowedUncertainty: 1 - MINIMUM_QUALITY_FLOOR,
      requiredChecks: assignment.acceptanceChecks,
    },
  });

  // What the candidate actually touched, against what it was allowed to touch.
  // The diff is the list; no model is involved and nothing is guessed.
  const violations = writeScopeViolations(changedFiles, assignment.writeScope);

  const markers = run.conflictMarkers ?? [];

  const failedChecks: FailedCheck[] = [];
  if (markers.length > 0) {
    failedChecks.push({
      check: 'resolved every merge conflict',
      observed: `unresolved conflict markers in: ${markers.slice(0, 10).join(', ')}`,
      expected: 'no <<<<<<< / >>>>>>> markers left — keep both your change and the work already merged',
      evidenceRefs: [],
    });
  }
  if (violations.length > 0) {
    const outside = violations.filter((violation) => violation.reason === 'outside_scope').map((violation) => violation.path);
    const protectedPaths = violations.filter((violation) => violation.reason === 'protected').map((violation) => violation.path);
    const observed = [
      outside.length > 0 ? `wrote outside its scope: ${outside.slice(0, 10).join(', ')}` : '',
      protectedPaths.length > 0 ? `wrote protected files: ${protectedPaths.slice(0, 10).join(', ')}` : '',
    ].filter(Boolean).join('; ');
    failedChecks.push({
      check: 'stayed within its write scope',
      observed,
      expected: assignment.writeScope
        ? `only paths within: ${assignment.writeScope.slice(0, 10).join(', ')}; protected files need an explicit grant — report the need instead of editing them`
        : 'no protected files (CI config, env files, package manifests, lockfiles) without an explicit grant — report the need instead of editing them',
      evidenceRefs: [],
    });
  }
  if (result.reasons.includes(`authority_violation:${assignment.id}`)) {
    failedChecks.push({
      check: 'stayed within the authority it was granted',
      observed: 'the child reported acting outside its authority', expected: 'no breach', evidenceRefs: [],
    });
  }
  if (result.reasons.some((reason) => reason.startsWith('child_execution_failed') || reason.startsWith('child_validation_failed'))) {
    failedChecks.push({
      check: 'the child\'s own validation of its definition of done',
      observed: validation.reasonCodes.join(', ') || 'the child did not finish',
      expected: 'the child\'s own validation passes', evidenceRefs: validation.evidenceIds,
    });
  }
  for (const outcome of outcomes.filter((entry) => !entry.met)) {
    failedChecks.push({
      check: outcome.check, observed: outcome.observed,
      expected: 'evidence that this holds in the candidate changes', evidenceRefs: outcome.evidenceRefs,
    });
  }
  // The parent's own reading of the merged candidate can fail on its own — e.g.
  // nothing durable was produced at all. It must still say why.
  if (!result.passed && failedChecks.length === 0) {
    failedChecks.push({
      check: 'the candidate as a whole',
      observed: result.parentValidation.reasonCodes.join(', ') || result.reasons.join(', '),
      expected: 'durable, validated work', evidenceRefs: result.parentValidation.evidenceIds,
    });
  }

  const evidenceRefs = [...new Set([
    ...outcomes.filter((entry) => entry.met).flatMap((entry) => entry.evidenceRefs),
    ...(validation.passed ? validation.evidenceIds : []),
  ])];
  return { accepted: result.passed && violations.length === 0 && markers.length === 0, failedChecks, evidenceRefs, reasons: result.reasons };
}
