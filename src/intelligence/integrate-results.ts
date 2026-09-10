/** Deciding whether combining the children's answers needs a model at all.
 *
 *  Synthesis used to be unconditional: any child with anything to say bought a
 *  whole sandbox to merge it. But most of what a merge does is mechanical —
 *  attribute each piece, list the files, keep the caveats — and mechanical work
 *  does not need a model. What does need one is judgement: two children that
 *  touched the same file, a child that only half finished, a child that answered
 *  in prose nobody can parse.
 *
 *  So this routes. The deterministic paths cost nothing; the model is kept for
 *  the cases that actually turn on a judgement call, and the rule for reaching
 *  it is deliberately generous — a merge that guesses is far worse than a
 *  synthesis call that was not strictly necessary. */
import { parseResultEnvelope, type AgentResultEnvelope } from './result-envelope.js';
import type { ChildReport } from './synthesize.js';

/** Below this, a child is telling you not to take its word for it. */
const CONFIDENT = 0.5;

export type IntegrationDecision =
  /** Nobody reported anything. There is nothing to combine. */
  | { kind: 'nothing' }
  /** Exactly one child answered. Its answer is the answer. */
  | { kind: 'return_child'; text: string }
  /** Compatible, self-declared-complete results, combined without a model. */
  | { kind: 'merge'; text: string }
  /** Something needs judging. `children` carries prose only — the envelopes
   *  have already been read, and resending them would pay input tokens for the
   *  very block that exists to avoid this call. */
  | { kind: 'synthesize'; children: ChildReport[]; reason: string };

interface Reported { report: ChildReport; envelope: AgentResultEnvelope; prose: string; structured: boolean }

function bullets(label: string, items: string[]): string[] {
  return items.length === 0 ? [] : [`${label}:`, ...items.map((item) => `- ${item}`), ''];
}

function mergeText(reported: Reported[]): string {
  const sections = reported.flatMap(({ report, envelope }) => [
    `## ${report.goal}`,
    '',
    envelope.summary,
    '',
    ...bullets('Findings', envelope.findings),
    ...bullets('Changed', envelope.changedFiles),
    ...bullets('Not verified', envelope.uncertainties),
  ]);
  return sections.join('\n').trim();
}

/** The first reason these results cannot be combined mechanically, or null when
 *  they can. Returning the reason rather than a boolean is what lets the
 *  progress line say *why* a sandbox is being spent. */
function needsJudgement(reported: Reported[]): string | null {
  const unstructured = reported.find((r) => !r.structured);
  if (unstructured) return `${unstructured.report.goal} reported in prose, which only a model can merge`;

  const incomplete = reported.find((r) => r.envelope.status !== 'success');
  if (incomplete) return `${incomplete.report.goal} reported "${incomplete.envelope.status}"`;

  const unsure = reported.find((r) => r.envelope.confidence < CONFIDENT);
  if (unsure) return `${unsure.report.goal} is not confident in its own result`;

  // Two children editing one file is the case a mechanical merge must never
  // guess at: which of the two describes the file as it now stands is exactly
  // the judgement a model is for.
  const seen = new Map<string, string>();
  for (const { report, envelope } of reported) {
    for (const file of envelope.changedFiles) {
      const other = seen.get(file);
      if (other && other !== report.goal) return `${file} was changed by more than one agent`;
      seen.set(file, report.goal);
    }
  }
  return null;
}

export function decideIntegration(children: ChildReport[]): IntegrationDecision {
  const reported: Reported[] = children
    .filter((child) => child.report.trim().length > 0)
    .map((report) => {
      const parsed = parseResultEnvelope(report.report, report.succeeded ? 'success' : 'failed');
      return { report, envelope: parsed.envelope, prose: parsed.prose, structured: parsed.structured };
    });

  if (reported.length === 0) return { kind: 'nothing' };

  // One answer does not need merging into anything. Children that produced
  // nothing are already visible as failures in the tree and in the node's own
  // result message; restating that costs a sandbox and adds nothing.
  if (reported.length === 1) return { kind: 'return_child', text: reported[0].prose };

  const reason = needsJudgement(reported);
  if (reason) {
    return {
      kind: 'synthesize',
      reason,
      children: reported.map(({ report, prose }) => ({ ...report, report: prose })),
    };
  }

  return { kind: 'merge', text: mergeText(reported) };
}
