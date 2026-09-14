/** When one branch fails, and when two branches disagree.
 *
 *  Two failure modes that only appear once work runs in parallel, and both have
 *  the same tempting wrong answer: do something global. Cancel everything
 *  because one branch died; take the newest claim because two disagree. Both are
 *  cheap to implement and both throw away exactly the information that would
 *  have made the right call.
 *
 *  So:
 *
 *   - **Failure propagates along dependencies and nowhere else.** A branch that
 *     needed the failed branch's *output* cannot proceed. One that merely needed
 *     to understand the same module is unaffected, and cancelling it would bin
 *     work that was going fine — which on a shared-context goal is most of the
 *     fan-out.
 *   - **Contradictions are recorded, and precedence is stated rather than
 *     guessed.** Which of two contradictory claims is true is a question about
 *     the repository. What this can say is which one *deserves more belief*, in
 *     an order that can be read and argued with, and the loser is kept so the
 *     disagreement stays diagnosable.
 *
 *  Deterministic and total: no model, no clock, no I/O. */
import { dependentsOf, type WorkstreamNode } from './workstreams.js';
import type { EvidenceConflict } from '../evidence/types.js';

export type { EvidenceConflict };

export interface FailurePropagation {
  /** The branch that failed. */
  failed: string;
  /** Branches that cannot proceed because they needed its output. */
  cancelled: string[];
  /** Branches that are unaffected and must keep running. */
  unaffected: string[];
  reasons: string[];
}

/** What a failure costs, and what it does not.
 *
 *  Total: a failure in a branch this plan does not contain cancels nothing,
 *  which is the correct answer rather than an exception — a stale id from a
 *  retried plan must not be able to take down a healthy run. */
export function propagateFailure(nodes: WorkstreamNode[], failedId: string): FailurePropagation {
  const ids = nodes.map((node) => node.id);
  if (!ids.includes(failedId)) {
    return { failed: failedId, cancelled: [], unaffected: [...ids].sort(), reasons: ['unknown_workstream'] };
  }

  const cancelled = dependentsOf(nodes, failedId);
  const lost = new Set([failedId, ...cancelled]);
  const unaffected = ids.filter((id) => !lost.has(id)).sort();

  return {
    failed: failedId,
    cancelled,
    unaffected,
    reasons: [
      ...cancelled.map((id) => `cancelled:${id}:depends_on:${failedId}`),
      ...unaffected.map((id) => `unaffected:${id}`),
    ],
  };
}

/** A claim one branch made about one subject.
 *
 *  `subject` is what the claim is *about* — a path, a symbol — and is what makes
 *  two claims comparable at all. Two branches describing different files are not
 *  disagreeing, however different their content. */
export interface EvidenceClaim {
  id: string;
  subject: string;
  content: string;
  revision?: string;
  validated: boolean;
  /** Which branch produced it. Two claims from one branch are a revision of a
   *  view; two from different branches are a disagreement. */
  workstreamId: string;
  createdAt: string;
}

/** How serious a disagreement is.
 *
 *  Two *validated* claims contradicting each other is the worst case: something
 *  checked both of them and they still disagree, which means one of the checks
 *  is wrong or the tree changed underneath. Two guesses disagreeing is ordinary. */
function severityOf(claims: EvidenceClaim[]): EvidenceConflict['severity'] {
  const validated = claims.filter((claim) => claim.validated).length;
  if (validated >= 2) return 'high';
  if (validated === 1) return 'medium';
  return 'low';
}

/** Claims that cannot all be right.
 *
 *  Grouped by subject, and only reported when the *content* differs and the
 *  claims came from different branches. Two branches independently observing
 *  the same thing is agreement and the most useful signal there is; recording it
 *  as a conflict would bury the real ones. */
export function detectEvidenceConflicts(claims: EvidenceClaim[]): EvidenceConflict[] {
  const bySubject = new Map<string, EvidenceClaim[]>();
  for (const claim of claims) {
    bySubject.set(claim.subject, [...(bySubject.get(claim.subject) ?? []), claim]);
  }

  const conflicts: EvidenceConflict[] = [];
  for (const [subject, group] of [...bySubject.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const distinctContent = new Set(group.map((claim) => claim.content));
    if (distinctContent.size < 2) continue;
    const distinctBranches = new Set(group.map((claim) => claim.workstreamId));
    if (distinctBranches.size < 2) continue;

    conflicts.push({
      // Derived from the subject rather than random, so the same disagreement
      // observed twice is one conflict rather than two rows nobody can join.
      id: `conflict:${subject}`,
      evidenceIds: group.map((claim) => claim.id).sort(),
      reason: `${distinctBranches.size} workstreams disagree about ${subject}`,
      severity: severityOf(group),
      resolved: false,
    });
  }
  return conflicts;
}

/** Which claim deserves belief, and why.
 *
 *  Stated as an order rather than scored, because a reader has to be able to
 *  argue with it:
 *
 *   1. **Current revision beats any other.** This is the architectural
 *      invariant — evidence about the tree as it stands outranks evidence about
 *      the tree as it was, whatever else is true of either.
 *   2. **Checked beats asserted.**
 *   3. **Newer beats older.**
 *   4. **Id**, so the answer is the same twice.
 *
 *  Note what it does *not* do: resolve the conflict. The loser is returned
 *  beside the winner, because a precedence rule is a working assumption and the
 *  disagreement is a fact. */
export function resolveByPrecedence(
  claims: EvidenceClaim[],
  currentRevision?: string,
): { preferred: EvidenceClaim | null; superseded: EvidenceClaim[]; reasonCodes: string[] } {
  if (claims.length === 0) return { preferred: null, superseded: [], reasonCodes: ['no_claims'] };

  const ranked = [...claims].sort((a, b) => {
    const currentA = currentRevision && a.revision === currentRevision ? 1 : 0;
    const currentB = currentRevision && b.revision === currentRevision ? 1 : 0;
    if (currentA !== currentB) return currentB - currentA;
    if (a.validated !== b.validated) return a.validated ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  });

  const [preferred, ...superseded] = ranked;
  const reasonCodes: string[] = [];
  if (currentRevision && preferred.revision === currentRevision) reasonCodes.push('current_revision');
  if (preferred.validated) reasonCodes.push('validated');
  if (superseded.length > 0) reasonCodes.push(`superseded:${superseded.length}`);
  // Said out loud: nothing here established which claim is *true*.
  reasonCodes.push('unresolved_disagreement');

  return { preferred, superseded, reasonCodes };
}
