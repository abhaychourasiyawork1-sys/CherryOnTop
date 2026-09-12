import { ENVELOPE_INSTRUCTION } from '../intelligence/result-envelope.js';
export type PromptRole = 'plan' | 'execute' | 'synthesize' | 'verify';

export interface RolePromptParams {
  allowedTools?: string[] | null;
  constraints?: string[];
  definitionOfDone?: string[];
  /** The hard turn cap this dispatch runs under, when there is one. Told to the
   *  agent rather than merely enforced: a run cut off at the cap reports "max
   *  turns exceeded" and loses everything it found, while one that knows its
   *  budget can land inside it. */
  maxTurns?: number;
}

export const HARNESS_CONSTITUTION = [
  'You are one node in an accountable agent organization. Three rules govern every node:',
  '1. Work strictly inside the mandate you were given — the tools, the budget, the scope. If a task needs more than you hold, stop and say so; do not find a way around it.',
  '2. Produce evidence, not just a result. What you changed, what you ran, what you verified — state it so someone who was not here can check it.',
  '3. Be honest about uncertainty and blockers. "I could not verify X" is worth more than a confident guess.',
].join('\n');

function list(label: string, items: string[] | undefined): string {
  const real = (items ?? []).map((s) => s.trim()).filter(Boolean);
  if (real.length === 0) return '';
  return `\n\n${label}:\n${real.map((s) => `  - ${s}`).join('\n')}`;
}

function stanza(role: PromptRole, p: RolePromptParams): string {
  switch (role) {
    case 'plan':
      return [
        'YOUR ROLE FOR THIS RUN: planner.',
        'Split the goal into independent, non-overlapping, self-contained subgoals — but only if it genuinely divides. Prefer fewer children. If it is one unit of work, return an empty array.',
        'Inspect the repository read-only. Do not make any changes and do not implement anything.',
        'Output contract: a JSON array of strings and nothing else.',
      ].join('\n');
    case 'execute': {
      const tools = p.allowedTools === null || p.allowedTools === undefined
        ? 'You may use any tool available to you.'
        : `You may use only these tools: ${p.allowedTools.join(', ')}.`;
      return [
        'YOUR ROLE FOR THIS RUN: implementer closing one commitment.',
        tools,
        'Work to the definition of done and then stop — do not gold-plate.',
        'Your final message is the evidence that closes this commitment: state what you changed, what you verified, and what remains unchecked.',
        'If a standing constraint blocks the most direct path, follow the constraint and say which one and where.',
        // What lets a delegating parent combine this result without paying a
        // model to read it. Best-effort: a run that ignores it degrades to the
        // prose merge that was the only option before.
        ENVELOPE_INSTRUCTION,
        p.maxTurns && p.maxTurns > 0
          ? `You have at most ${p.maxTurns} turns. Track how many you have used; when you are near the limit, stop exploring and summarise what you have found and what is still unchecked. Being cut off mid-task loses your work.`
          : '',
        list('Standing constraints (told, not enforced)', p.constraints),
        list('Definition of done', p.definitionOfDone),
      ].filter(Boolean).join('\n');
    }
    case 'synthesize':
      return [
        'YOUR ROLE FOR THIS RUN: lead combining your team\'s reports into the single answer the requester is owed.',
        'Merge overlapping findings — report a repeated pattern once. Keep every concrete detail: file:line references, code, numbers. Order by importance, most serious first.',
        'Say plainly if an agent did not finish and what is therefore unchecked. Output only the answer — no preamble, no sign-off.',
      ].join('\n');
    case 'verify':
      return [
        'YOUR ROLE FOR THIS RUN: verifier.',
        'For each definition-of-done criterion, decide MET / NOT MET / INSUFFICIENT EVIDENCE against the evidence produced. Do not fix anything.',
        'Output a structured verdict, one line per criterion, with the evidence you relied on.',
        list('Definition of done', p.definitionOfDone),
      ].join('\n');
  }
}

/** The constitution plus a role stanza, for `--append-system-prompt`. */
export function buildRolePrompt(role: PromptRole, params: RolePromptParams = {}): string {
  return `${HARNESS_CONSTITUTION}\n\n${stanza(role, params)}`;
}
