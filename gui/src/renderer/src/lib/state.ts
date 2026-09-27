/** The lifecycle states from src/lifecycle/node-machine.ts, grouped by what a
 *  person watching needs to know: is this running, is it waiting on me, did it
 *  end. The hue follows the group, never the individual state — five colours
 *  stay legible across a tree, sixteen do not. */
export type Tone = 'executing' | 'planning' | 'at-risk' | 'failed' | 'settled';

const TONES: Record<string, Tone> = {
  CREATED: 'planning',
  ORIENT: 'planning',
  PLAN: 'planning',
  INTELLIGENCE_GATE: 'planning',
  EXECUTION_DECISION: 'planning',
  SELF_EXECUTE: 'executing',
  DELEGATE: 'executing',
  ESCALATE: 'at-risk',
  WAIT_APPROVAL: 'at-risk',
  VERIFY: 'executing',
  VALIDATE: 'executing',
  INTERRUPTED: 'planning',
  COMPLETE: 'settled',
  CANCELLED: 'settled',
  FAILED: 'failed',
};

/** A FAILED node a parent has already replaced with a fresh child reads as
 *  settled, not failed: the honest history stays FAILED underneath (see
 *  markNodeSuperseded, src/db/queries/nodes.ts) so the transcript is never
 *  lost, but a tree or graph view showing it plain red would tell whoever is
 *  watching that something is still wrong here, when the actual answer is
 *  "this was retried and the retry is what to look at". */
export function toneOf(state: string, supersededBy?: string | null): Tone {
  if (state === 'FAILED' && supersededBy) return 'settled';
  return TONES[state] ?? 'planning';
}

export function isTerminal(state: string): boolean {
  return state === 'COMPLETE' || state === 'FAILED' || state === 'CANCELLED';
}

/** What the node is doing, in the words of someone watching rather than the
 *  words of the state machine. */
const LABELS: Record<string, string> = {
  CREATED: 'Starting',
  ORIENT: 'Orienting',
  PLAN: 'Planning',
  INTELLIGENCE_GATE: 'Gathering context',
  EXECUTION_DECISION: 'Deciding',
  SELF_EXECUTE: 'Working',
  DELEGATE: 'Delegating',
  ESCALATE: 'Escalating',
  WAIT_APPROVAL: 'Waiting on you',
  VERIFY: 'Verifying',
  VALIDATE: 'Verifying',
  INTERRUPTED: 'Paused',
  COMPLETE: 'Done',
  CANCELLED: 'Stopped',
  FAILED: 'Failed',
};

export function labelOf(state: string, supersededBy?: string | null): string {
  if (state === 'FAILED' && supersededBy) return 'Replaced';
  return LABELS[state] ?? state.toLowerCase().replace(/_/g, ' ');
}
