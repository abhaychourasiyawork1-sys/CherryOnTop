/** What is known about a task — and where it came from.
 *
 *  Nothing here reads the goal's wording to decide what it means. A regex over a
 *  sentence cannot tell "explain why X crashes" from "why does X crash, please
 *  fix it", or "review the codebase" from "review the codebase and fix what you
 *  find", and the mistake it makes is confident. Meaning is System-1's (Laya's)
 *  question, and the answers it has already given are on the node's own event
 *  chain, so understanding is read back from there rather than kept in a second
 *  place that could disagree with it.
 *
 *  Three sources, and no others:
 *   - **typed answers** — whether the task asks only for an answer
 *     (`execution.change_requested`) and how likely it is to come apart
 *     (`execution.decomposable`);
 *   - **anchors** — what the goal *literally names*: paths, filenames, backticked
 *     identifiers. That is syntax, not judgement, and it is the only thing read
 *     from the text;
 *   - **the difficulty belief** (`difficulty.ts`), which is kept apart because it
 *     changes as the run does.
 *
 *  Unknown stays unknown. No answer is not "explain" (a wrong read-only grant
 *  costs the whole task, a wrong writable one only costs the narrowing) and not
 *  "splits" (paying a planner to be told no is the expensive mistake).
 *
 *  Deterministic and total. */
import type { Db } from '../db/client.js';
import { listEventsForNode } from '../db/queries/events.js';
import { SYSTEM1_EVENT } from '../system1/receipts.js';
import { extractAnchors } from '../efficiency/task-economics.js';

/** The grant applied for a dispatch, as recorded on its judgment receipt. */
export const READ_ONLY_GRANT = 'read-only-grant';
export const WRITABLE_GRANT = 'writable-grant';

/** What kind of work the runtime is doing, from what it *knows* rather than
 *  from a reading of the words: it was asked only for an answer, it changes
 *  something, or it was handed out in pieces. */
export type TaskMode = 'answer' | 'change' | 'split';

export interface TaskUnderstanding {
  /** The task asks only for an answer. False when nothing said so. */
  readOnly: boolean;
  /** Calibrated probability the work comes apart into independent pieces, when
   *  System-1 has been asked. Absent means nobody knows. */
  splitProbability?: number;
  /** What the goal literally names. */
  anchors: string[];
}

export const UNKNOWN_UNDERSTANDING = (goal: string): TaskUnderstanding => ({ readOnly: false, anchors: extractAnchors(goal) });

interface JudgmentPayload {
  surface?: string;
  finalRuntimeAction?: string;
  calibratedOutput?: { probabilities?: Record<string, number> } | null;
}

/** Everything the node's own judgments say about the task, newest answer wins. */
export function understandingFor(db: Db, nodeId: string, goal: string): TaskUnderstanding {
  const understanding: TaskUnderstanding = UNKNOWN_UNDERSTANDING(goal);
  try {
    for (const row of listEventsForNode(db, nodeId)) {
      if (row.type !== SYSTEM1_EVENT) continue;
      const payload = row.payload as JudgmentPayload;
      if (payload.surface === 'execution.change_requested') {
        if (payload.finalRuntimeAction === READ_ONLY_GRANT) understanding.readOnly = true;
        else if (payload.finalRuntimeAction === WRITABLE_GRANT) understanding.readOnly = false;
      } else if (payload.surface === 'execution.decomposable') {
        const many = payload.calibratedOutput?.probabilities?.many;
        if (typeof many === 'number' && Number.isFinite(many)) understanding.splitProbability = many;
      }
    }
  } catch {
    // A node whose events cannot be read is a node nothing is known about.
  }
  return understanding;
}

/** Answering, changing, or (once handed out) splitting. */
export function modeOf(understanding: Pick<TaskUnderstanding, 'readOnly'>, delegated = false): TaskMode {
  return delegated ? 'split' : understanding.readOnly ? 'answer' : 'change';
}
