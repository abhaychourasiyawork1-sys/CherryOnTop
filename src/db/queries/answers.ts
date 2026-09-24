import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { events } from '../schema.js';

/** The answer a node is accountable for.
 *
 *  Two shapes, and reading only one of them loses work: a node that delegated
 *  publishes a combined `node.answer` and may have no `exec.result` at all,
 *  while a node that did the work itself never publishes one because its final
 *  report already is its answer. A parent combining its children's reports has
 *  to handle both, or a delegating child contributes nothing to its parent's
 *  answer — silently, since an empty report reads the same as a quiet one.
 *
 *  Shared so the runtime and the API cannot drift on what "the answer" means. */
export function answerOf(db: Db, nodeId: string): string {
  const rows = db.select().from(events).where(eq(events.nodeId, nodeId)).all();

  const combined = rows.filter((row) => row.type === 'node.answer').at(-1);
  const combinedText = (combined?.payload as { text?: unknown } | null)?.text;
  if (typeof combinedText === 'string' && combinedText.trim()) return combinedText;

  // The last result that says something: a run stopped before finishing
  // leaves a synthetic, empty result behind it (execute-step.ts), which must
  // not hide an earlier attempt's real report.
  const texts = rows.filter((row) => row.type === 'exec.result')
    .map((row) => (row.payload as { result?: unknown } | null)?.result)
    .filter((text): text is string => typeof text === 'string' && text.trim().length > 0);
  return texts.at(-1) ?? '';
}
