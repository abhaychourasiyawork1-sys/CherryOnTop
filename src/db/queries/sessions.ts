import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client.js';
import { nodes, sessions } from '../schema.js';
import { answerOf } from './answers.js';
import { listArtifactsForNodes } from './artifacts.js';
import { subtreeNodeIds } from './nodes.js';

export interface SessionRecord {
  id: string;
  repoPath: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export function listSessions(db: Db): SessionRecord[] {
  return db.select().from(sessions).orderBy(desc(sessions.updatedAt)).all();
}

export function getSession(db: Db, id: string): SessionRecord | undefined {
  return db.select().from(sessions).where(eq(sessions.id, id)).get();
}

export function insertSession(db: Db, record: SessionRecord): void {
  db.insert(sessions).values(record).run();
}

export function updateSession(db: Db, id: string, patch: Partial<Pick<SessionRecord, 'title' | 'updatedAt'>>): void {
  db.update(sessions).set(patch).where(eq(sessions.id, id)).run();
}

/** Removes the session from the sidebar. Its runs stay on record — they are
 *  what the audit trail is made of — they simply no longer belong to a chat. */
export function deleteSession(db: Db, id: string): void {
  db.update(nodes).set({ sessionId: null }).where(eq(nodes.sessionId, id)).run();
  db.delete(sessions).where(eq(sessions.id, id)).run();
}

/** The session's root runs, oldest first. */
export function sessionRuns(db: Db, sessionId: string) {
  return db.select().from(nodes)
    .where(and(eq(nodes.sessionId, sessionId), isNull(nodes.parentId)))
    .orderBy(asc(nodes.createdAt)).all();
}

export interface SessionTurn {
  nodeId: string;
  request: string;
  state: string;
  answer: string;
  files: string[];
}

export function sessionTurns(db: Db, sessionId: string, before?: string): SessionTurn[] {
  const runs = sessionRuns(db, sessionId);
  const cut = before ? runs.findIndex((run) => run.id === before) : -1;
  return (cut >= 0 ? runs.slice(0, cut) : runs).map((run) => {
    const files = listArtifactsForNodes(db, subtreeNodeIds(db, run.id))
      .filter((a) => (a.kind === 'file_write' || a.kind === 'file_edit') && a.path)
      .map((a) => a.path as string);
    return { nodeId: run.id, request: run.goal, state: run.state, answer: answerOf(db, run.id), files: [...new Set(files)] };
  });
}

/** How much earlier conversation a run is handed. The same shape the open
 *  source agents converged on (OpenHands' condenser keeps the first events and
 *  the most recent ones; aider summarises the middle once history passes a
 *  token limit): the first turn verbatim, because it usually states the task;
 *  the latest turns verbatim, because they are what "it", "that" and "again"
 *  refer to; everything between compressed to one line each.
 *
 *  ponytail: the middle is compressed mechanically (request + outcome + files),
 *  not by a model. Add an LLM rolling summary stored on the session row when
 *  sessions routinely run past the budget. */
export const MEMORY_BUDGET = { recentTurns: 4, answerChars: 4000, totalChars: 24000 };

export function renderSessionMemory(turns: SessionTurn[], budget = MEMORY_BUDGET): string {
  if (turns.length === 0) return '';
  const full = (turn: SessionTurn, n: number) => [
    `### Turn ${n} (${outcome(turn.state)})`,
    `Request:\n${turn.request.trim()}`,
    turn.answer.trim() ? `Your answer:\n${clip(turn.answer.trim(), budget.answerChars)}` : 'Your answer: (none recorded)',
    turn.files.length ? `Files changed: ${turn.files.slice(0, 30).join(', ')}` : '',
  ].filter(Boolean).join('\n\n');
  const line = (turn: SessionTurn, n: number) =>
    `- Turn ${n} (${outcome(turn.state)}): ${clip(oneLine(turn.request), 200)}${turn.files.length ? ` — changed ${turn.files.slice(0, 8).join(', ')}` : ''}`;

  const recentFrom = Math.max(1, turns.length - budget.recentTurns);
  const entries = turns.map((turn, i) => ({ turn, n: i + 1, verbatim: i === 0 || i >= recentFrom }));
  const render = () => {
    const out: string[] = [];
    for (const { turn, n, verbatim } of entries) {
      if (verbatim) { out.push(full(turn, n)); continue; }
      if (out.at(-1)?.startsWith('- ')) out[out.length - 1] += `\n${line(turn, n)}`;
      else out.push(line(turn, n));
    }
    return out.join('\n\n');
  };
  // Over budget: condense the oldest verbatim turns first. The newest turn is
  // the one a follow-up is most likely about, so it is the last to go.
  let body = render();
  for (const entry of entries.slice(0, -1)) {
    if (body.length <= budget.totalChars) break;
    entry.verbatim = false;
    body = render();
  }
  return [
    '## This conversation so far',
    'You are continuing a chat session. The request below is the newest message in it. Earlier turns are summarised here, with the files each one changed; read those files for their current state rather than trusting this summary. Resolve references like "it", "that" or "again" against them, and do not redo finished work.',
    clip(body, budget.totalChars),
    '## Newest message',
  ].join('\n\n');
}

export function sessionMemoryFor(db: Db, sessionId: string, before?: string): string {
  return renderSessionMemory(sessionTurns(db, sessionId, before));
}

function outcome(state: string): string {
  return state === 'COMPLETE' ? 'done' : state === 'FAILED' ? 'failed' : state === 'CANCELLED' ? 'stopped' : 'in progress';
}

function oneLine(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
