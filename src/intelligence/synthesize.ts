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

function clipTo(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}\n\n[report truncated]`;
}

function clip(text: string): string {
  return clipTo(text, MAX_REPORT_CHARS);
}

/** Successively smaller renderings of one child's report: the full (clipped)
 *  report, then tighter clips, then a marker. Only the rungs that actually
 *  shrink are kept, so a short report has just the one. */
const REPORT_RUNGS = [4_000, 1_200];
const REPORT_OMITTED = '_Report omitted to fit the prompt budget; it is recorded in full against this agent._';

function reportLadder(report: string): string[] {
  if (!report.trim()) return ['_This agent produced no report._'];
  const rungs = [clip(report), ...REPORT_RUNGS.map((max) => clipTo(report, max)), REPORT_OMITTED];
  const ladder: string[] = [];
  for (const rung of rungs) {
    if (ladder.length === 0 || rung.length < ladder[ladder.length - 1].length) ladder.push(rung);
  }
  return ladder;
}

function childSection(child: ChildReport, index: number, body: string): string {
  return [
    `### Agent ${index + 1}${child.succeeded ? '' : ' (did not finish)'}`,
    `Asked to: ${child.goal}`,
    '',
    body,
  ].join('\n');
}

/** The synthesis prompt as independent parts, so the prompt compiler can shrink
 *  one child's report without touching the rest. Each part except the last
 *  ends in the `---` rule that separates it from the next; joined with a blank
 *  line, the parts are byte-for-byte `buildSynthesisPrompt`. */
export interface SynthesisParts {
  head: string;
  /** One ladder per child, richest first. */
  children: string[][];
  tail: string;
}

export const SECTION_RULE = '\n\n---';

export function synthesisParts(goal: string, children: ChildReport[]): SynthesisParts {
  return {
    head: `THE ORIGINAL GOAL: ${goal}${SECTION_RULE}`,
    children: children.map((child, index) =>
      reportLadder(child.report).map((body) => `${childSection(child, index, body)}${SECTION_RULE}`)),
    tail: 'Write the single combined answer now, in GitHub-flavoured Markdown.',
  };
}

export function buildSynthesisPrompt(goal: string, children: ChildReport[]): string {
  const parts = synthesisParts(goal, children);
  return [parts.head, ...parts.children.map((ladder) => ladder[0]), parts.tail].join('\n\n');
}
