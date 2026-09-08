/** Combining what the children reported into the one answer the root owes.
 *
 *  Without this a delegating root finished with "All 3 delegated pieces
 *  completed" — a status line, not an answer. Whoever asked the question got
 *  nothing back, and had to open each child in turn and read its report
 *  themselves, which is the work they delegated in the first place. */

export interface ChildReport {
  goal: string;
  succeeded: boolean;
  /** The child's own final answer. Empty when it produced none. */
  report: string;
}

/** Long reports are passed as a command-line argument, so they cannot be
 *  unbounded. Generous enough for a detailed review, short of any shell limit. */
export const MAX_REPORT_CHARS = 12_000;

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_REPORT_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_REPORT_CHARS)}\n\n[report truncated]`;
}

/** True when there is actually something to combine. A root whose children all
 *  came back empty has nothing to synthesize, and asking anyway spends a sandbox
 *  to be told so. */
export function hasReports(children: ChildReport[]): boolean {
  return children.some((child) => child.report.trim().length > 0);
}

export function buildSynthesisPrompt(goal: string, children: ChildReport[]): string {
  const sections = children.map((child, index) => [
    `### Agent ${index + 1}${child.succeeded ? '' : ' (did not finish)'}`,
    `Asked to: ${child.goal}`,
    '',
    child.report.trim() ? clip(child.report) : '_This agent produced no report._',
  ].join('\n'));

  // The lead framing and the requirements list live in the `synthesize` system
  // stanza (src/prompts/roles.ts); only the material to combine is sent here.
  return [
    `THE ORIGINAL GOAL: ${goal}`,
    '',
    '---',
    '',
    sections.join('\n\n---\n\n'),
    '',
    '---',
    '',
    'Write the single combined answer now, in GitHub-flavoured Markdown.',
  ].join('\n');
}
