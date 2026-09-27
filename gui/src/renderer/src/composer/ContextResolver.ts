// The runtime's own parser, imported rather than reimplemented: the composer
// must split questions from goals exactly the way org.ask will, or it would ask
// the record something the record does not recognize — or worse, start a run.
import { parseQuestion } from '../../../../../src/intelligence/ask.js';

/** What the one composer is being asked to do. The person never picks a mode;
 *  this decides, and the only guess it is allowed to make is the safe one. */
export type Intent = 'question' | 'work' | 'redirect';

export interface ContextRef {
  kind: 'file' | 'run' | 'decision' | 'artifact';
  id: string;
  label: string;
}

/** Words that mean "change what you are doing", not "also do this". Only
 *  consulted while a run is live, and only ever *suggests* redirection — the
 *  composer shows the choice before anything is stopped. */
const REDIRECT = /^(actually|instead|wait|stop|no[,.]|don'?t|do not|change of plan|switch to|rather)\b|\binstead\b/i;

export function resolveIntent(text: string, context: { hasCase: boolean; runLive: boolean }): Intent {
  // A question only makes sense about something on record. Starting a run
  // because someone asked a question would be much worse than the reverse.
  if (context.hasCase && parseQuestion(text).intent !== 'unknown') return 'question';
  if (context.runLive && REDIRECT.test(text.trim())) return 'redirect';
  return 'work';
}

/** Requests that can only be done by acting on GitHub as you — which a run
 *  gets only under a mandate that grants GitHub. Checked before sending, so
 *  the person chooses, rather than the run discovering it has no login. */
const GITHUB_WORK = /\b(pull request|(open|raise|create|close|merge|review|update|reopen)\s+(a |the |this )?(pr|pull)|pr\s*#?\d+|#\d+\b.*\b(pr|issue)|github|git push|push (it |this |the (branch|changes) )?(to|up)\b|(open|file|close|comment on)\s+(an? |the )?issue|release notes? on github)/i;

export function needsGitHub(text: string): boolean {
  return GITHUB_WORK.test(text);
}

/** The goal a run is created with: what was typed, plus whatever the person
 *  pointed at, stated explicitly so the record shows what the run was given. */
export function goalWithContext(text: string, refs: ContextRef[]): string {
  if (refs.length === 0) return text;
  const lines = refs.map((ref) => `- ${ref.kind}: ${ref.label}${ref.kind === 'file' ? '' : ` (${ref.id})`}`);
  return `${text}\n\nContext:\n${lines.join('\n')}`;
}

/** A redirect is recorded as what it is: the live run is stopped and a new one
 *  starts from the new instruction, naming the run it replaces. */
export function redirectGoal(text: string, previous: { id: string; title: string }, refs: ContextRef[] = []): string {
  return goalWithContext(
    `${text}\n\nThis redirects run ${previous.id} ("${previous.title}"), which was stopped for it. Build on what that run already did rather than starting over.`,
    refs,
  );
}

/** Adds a reference once; a second drop of the same file is a no-op. */
export function addRef(refs: ContextRef[], ref: ContextRef): ContextRef[] {
  return refs.some((existing) => existing.kind === ref.kind && existing.id === ref.id) ? refs : [...refs, ref];
}

/** The drag payload surfaces use for a Workspace object. */
export const REF_MIME = 'application/x-cherryontop-ref';

export function parseDroppedRef(raw: string): ContextRef | null {
  try {
    const value = JSON.parse(raw) as Partial<ContextRef>;
    if (!value || typeof value.id !== 'string' || typeof value.label !== 'string') return null;
    if (!['file', 'run', 'decision', 'artifact'].includes(String(value.kind))) return null;
    return { kind: value.kind as ContextRef['kind'], id: value.id, label: value.label };
  } catch {
    return null;
  }
}
