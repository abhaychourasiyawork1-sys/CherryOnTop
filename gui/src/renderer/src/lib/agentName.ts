/** A short, referable name for an agent.
 *
 *  An agent's identity is its goal, and a goal is a whole instruction — often a
 *  paragraph. Using it verbatim as the speaker name, which is what the
 *  transcript did, produced a wall of repeated prose down the left of the page
 *  and made it impossible to tell one agent from another at a glance.
 *
 *  This finds the thing the goal is *about*. A path if there is one, since that
 *  is how developers actually refer to work; otherwise the subject left after
 *  the instruction verb is removed. */

/** Instruction scaffolding that says nothing about which agent this is —
 *  every agent in a review organization starts with one of these. */
const LEAD_IN = new RegExp(
  '^\\s*(?:'
  + '(?:read-only|readonly)\\s+(?:audit|review)\\s*:?\\s*|'
  + '(?:please\\s+)?(?:carefully\\s+)?'
  + '(?:review|audit|analyse|analyze|inspect|examine|investigate|check|look\\s+at|go\\s+through|'
  + 'implement|add|create|build|write|fix|repair|patch|debug|refactor|rewrite|'
  + 'update|document|test|migrate|port|optimi[sz]e|profile|benchmark)'
  + '\\s+(?:the\\s+|a\\s+|an\\s+|all\\s+|every\\s+|each\\s+)?'
  + ')+',
  'i',
);

/** Trailing boilerplate about how to report, which is identical across siblings. */
const TAIL = /\s*(?:,?\s*(?:and|then)\s+)?(?:produce|report|reply|respond|give|output|write up|summari[sz]e)\b[\s\S]*$/i;

const PATH = /(?:^|[\s"'`(])((?:src|lib|app|test|tests|scripts|gui|packages?)\/[\w./*-]+)/;

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/^[\s,;:.-]+|[\s,;:.]+$/g, '');
}

export function agentName(goal: string, limit = 42): string {
  const flat = tidy(goal);
  if (!flat) return 'Agent';

  // A path is the most useful name a developer can be given, and the one they
  // would use themselves.
  const path = flat.match(PATH)?.[1];
  if (path) return path.length <= limit ? path : `…${path.slice(-(limit - 1))}`;

  const subject = tidy(flat.replace(TAIL, '').replace(LEAD_IN, '')) || flat;
  if (subject.length <= limit) return subject;

  // Cut on a word boundary; a name broken mid-word reads as a rendering fault.
  const cut = subject.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  // Keep the whole-word cut unless it would throw away most of the name.
  return `${(space >= limit * 0.4 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
