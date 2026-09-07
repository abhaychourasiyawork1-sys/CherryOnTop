export type AskIntent = 'why' | 'blocking' | 'cost' | 'evidence' | 'unknown';

export interface AskQuestion {
  intent: AskIntent;
  /** The node the question is about, when the question named one. */
  nodeId: string | null;
}

// Deliberately a parser, not a model. The four questions below are the ones the
// record can answer with evidence; anything else returns `unknown` so the GUI
// can offer the ones that work rather than paraphrasing its way to a plausible
// answer it cannot support.
const PATTERNS: { intent: Exclude<AskIntent, 'unknown'>; test: RegExp }[] = [
  { intent: 'why', test: /\bwhy\b|\bexplain\b|\breason(ing)?\b/i },
  { intent: 'blocking', test: /\bblock(ed|ing)?\b|\bstuck\b|\bwaiting\b/i },
  { intent: 'evidence', test: /\bevidence\b|\bartifacts?\b|\bproduced\b|\bproof\b/i },
  { intent: 'cost', test: /\bcost(s|ing)?\b|\bspend|\bspent\b|\bbudget\b|\bmoney\b|\$/i },
];

// A uuid, or the short prefix a person actually types after seeing one.
const ID = /\b([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8})\b/i;

export function parseQuestion(text: string): AskQuestion {
  const nodeId = text.match(ID)?.[1] ?? null;
  // Order matters: "why is it blocked?" is a why-question about a blockage, and
  // the explanation is the more useful answer.
  const intent = PATTERNS.find((pattern) => pattern.test.test(text))?.intent ?? 'unknown';
  return { intent, nodeId };
}
