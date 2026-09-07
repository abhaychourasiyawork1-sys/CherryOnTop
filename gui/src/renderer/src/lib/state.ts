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
  COMPLETE: 'settled',
  CANCELLED: 'settled',
  FAILED: 'failed',
};

export function toneOf(state: string): Tone {
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
  COMPLETE: 'Done',
  CANCELLED: 'Stopped',
  FAILED: 'Failed',
};

export function labelOf(state: string): string {
  return LABELS[state] ?? state.toLowerCase().replace(/_/g, ' ');
}
