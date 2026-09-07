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

  return [
    'You are the lead of a team that has just finished. Each agent below worked on',
    'one part of the same goal and reported back. Write the single combined answer',
    'for whoever asked.',
    '',
    `THE ORIGINAL GOAL: ${goal}`,
    '',
    '---',
    '',
    sections.join('\n\n---\n\n'),
    '',
    '---',
    '',
    'Write the answer now. Requirements:',
    '- Answer the original goal directly. Do not describe the process or the team.',
    '- Merge overlapping findings; report a repeated pattern once, not once per agent.',
    '- Keep every concrete detail that matters — file:line references, code, numbers.',
    '- Order by importance, most serious first.',
    '- Say plainly if an agent did not finish and what is therefore unchecked.',
    '- Use GitHub-flavoured Markdown. Tables and mermaid diagrams are welcome where',
    '  they genuinely make the answer clearer; do not add them for decoration.',
    '- Output only the answer itself. No preamble, no sign-off.',
  ].join('\n');
}
