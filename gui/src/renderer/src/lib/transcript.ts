import { createStreamRenderer, type RenderedLine } from '../../../../../src/tui/stream-renderer.js';
import type { OrgEvent } from './eventLog.js';
import { labelOf } from './state.js';

/** One block of the transcript, attributed to one agent. Contiguous events from
 *  the same node collapse into a single turn, so the reading is speech rather
 *  than a log of individual events. */
export type NoteTone = 'plain' | 'problem';

export interface Note {
  text: string;
  /** A failed step reads as a failure, not as another line of narration. */
  tone: NoteTone;
  /** How many times in a row this happened. 1 for almost everything; higher is
   *  a retry loop, which is worth seeing as one fact rather than as repetition. */
  count: number;
}

export type Phase = 'plan' | 'work' | 'answer';

export interface Turn {
  key: string;
  nodeId: string;
  /** Planning and execution are two separate sandbox runs. Reading them as one
   *  stream is baffling — the planner explains a split, then the worker starts
   *  over from scratch on the same repository. */
  phase: Phase;
  /** How far below the task's root this agent sits. The gutter indents by it,
   *  which is what makes delegation visible in the shape of the transcript. */
  depth: number;
  lines: RenderedLine[];
  /** Set on an `answer` turn: the finished answer this node is accountable for.
   *  For a delegating node it is the combined one, built from its children. */
  answer?: string;
  /** Plain-language notes about what the organization itself did — decided to
   *  delegate, chose a runtime, moved to a new state. Distinct from `lines`,
   *  which is the runtime's own output. A retrying node repeats the same three
   *  notes every attempt, so an identical consecutive note carries a count
   *  instead of a copy. */
  notes: Note[];
  at: string;
}

/** State transitions worth narrating. The machine passes through sixteen states
 *  and most are bookkeeping; reporting each one would bury the runtime's actual
 *  output under a running commentary on the state machine. */
const NARRATED = new Set(['SELF_EXECUTE', 'DELEGATE', 'ESCALATE', 'WAIT_APPROVAL', 'COMPLETE', 'FAILED', 'CANCELLED']);

function decisionNote(payload: unknown): string | null {
  const decision = payload as { type?: string; outcome?: string; breakdown?: Record<string, number> } | null;
  if (!decision?.outcome) return null;
  if (decision.type === 'runtime_selection') {
    const runs = decision.breakdown?.runs;
    return runs
      ? `Chose ${decision.outcome}, on ${runs} previous runs`
      : `Chose ${decision.outcome}`;
  }
  // A score is only meaningful against the threshold it was compared to. When
  // the engine short-circuits — no spawn authority, say — it records a score of
  // 0 and no threshold, and printing "scored +0.00" would dress a hard rule up
  // as a close call.
  const score = decision.breakdown?.score;
  const scored = score === undefined || decision.breakdown?.threshold === undefined
    ? ''
    : ` (scored ${score >= 0 ? '+' : '−'}${Math.abs(score).toFixed(2)} against ${decision.breakdown.threshold.toFixed(2)})`;
  if (decision.outcome === 'DELEGATE') return `Decided to delegate${scored}`;
  if (decision.outcome === 'SELF_EXECUTE') return `Decided to do this itself${scored}`;
  if (decision.outcome === 'ESCALATE') return `Reached the edge of its authority${scored}`;
  return `Decided: ${decision.outcome}`;
}

export interface TurnOptions {
  /** Drop the runtime's end-of-run cost line. In the transcript it is noise —
   *  a turn that says only "session cost: $0.41" — and the number is already on
   *  the task in the rail and in the agent's spend. The Activity tab keeps it,
   *  where it marks the boundary between runs. */
  omitSummaries?: boolean;
}

/** Events for one task, in order, as turns. `depths` comes from tasks.ts.
 *
 *  A fresh renderer per node, not one shared: createStreamRenderer tracks
 *  pending tool calls by id, and two agents running concurrently would otherwise
 *  resolve each other's tool results. */
/** A refused request, with the window that ran out and when it comes back.
 *  Informational rate-limit events (the window merely filling up) are not shown:
 *  every run emits them. */
function rateLimitNote(payload: unknown): string | null {
  const info = (payload as { rate_limit_info?: { status?: string; rateLimitType?: string; resetsAt?: number } } | null)?.rate_limit_info;
  if (info?.status !== 'rejected') return null;
  const window = info.rateLimitType === 'five_hour' ? 'five-hour'
    : info.rateLimitType === 'seven_day' ? 'seven-day'
    : (info.rateLimitType ?? 'usage');
  if (typeof info.resetsAt !== 'number') {
    return `Your Claude ${window} usage limit is used up — nothing will run until it resets.`;
  }
  const when = new Date(info.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Your Claude ${window} usage limit is used up. It resets at ${when} — nothing will run until then.`;
}

/** The few runtime `system` events worth reading. Everything else there is
 *  genuinely chatter. */
function systemNote(payload: unknown): string | null {
  const system = payload as { subtype?: string; attempt?: number; max_retries?: number; error?: string } | null;
  if (system?.subtype !== 'api_retry') return null;
  const attempt = system.attempt ?? 0;
  const max = system.max_retries ?? 0;
  // Deliberately does not claim the API is unreachable: the commonest cause is
  // a spent usage window, and the rate_limit_event alongside it says so.
  return `Request refused — retrying (attempt ${attempt} of ${max})`;
}

/** A note is a one-line fact about what the organization did. Anything longer
 *  than this is a message that got away from itself — a planner reciting four
 *  whole subgoals, say — and printing it in full buries the transcript it is
 *  supposed to be annotating. The source of that particular message is fixed;
 *  this is the guard, and it also covers every event already on disk. */
const NOTE_LIMIT = 140;

function clipNote(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= NOTE_LIMIT) return flat;
  const cut = flat.slice(0, NOTE_LIMIT - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > NOTE_LIMIT * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function addNote(turn: Turn, text: string, tone: NoteTone = 'plain'): void {
  const note = clipNote(text);
  const last = turn.notes.at(-1);
  if (last?.text === note) { last.count += 1; return; }
  turn.notes.push({ text: note, tone, count: 1 });
}

export function toTurns(events: OrgEvent[], depths: Map<string, number>, options: TurnOptions = {}): Turn[] {
  const renderers = new Map<string, ReturnType<typeof createStreamRenderer>>();
  const rendererFor = (nodeId: string) => {
    let renderer = renderers.get(nodeId);
    if (!renderer) { renderer = createStreamRenderer(); renderers.set(nodeId, renderer); }
    return renderer;
  };

  const turns: Turn[] = [];
  // Where each rendered line currently lives, so a tool result updates the line
  // its call created rather than appending a duplicate further down.
  const lineHome = new Map<string, Turn>();

  const turnFor = (event: OrgEvent, phase: Phase = 'work'): Turn => {
    const last = turns.at(-1);
    if (last && last.nodeId === event.nodeId && last.phase === phase) return last;
    const turn: Turn = {
      key: `${event.nodeId}-${phase}-${event.id ?? turns.length}`,
      nodeId: event.nodeId,
      phase,
      depth: depths.get(event.nodeId) ?? 0,
      lines: [],
      notes: [],
      at: event.createdAt,
    };
    turns.push(turn);
    return turn;
  };

  for (const event of events) {
    // The answer the node owes. A turn of its own, because it is the thing
    // whoever asked was waiting for — not another line of working.
    if (event.type === 'node.answer') {
      const text = (event.payload as { text?: string } | null)?.text;
      if (text?.trim()) {
        const turn = turnFor(event, 'answer');
        turn.answer = text;
      }
      continue;
    }

    // The combining run is a third kind of sandbox, and reading it as more work
    // is confusing. Its result is the answer above; its working is not shown.
    if (event.type.startsWith('synth.')) continue;

    if (event.type === 'decision.made') {
      const note = decisionNote(event.payload);
      if (note) addNote(turnFor(event), note);
      continue;
    }

    // What the node is about to do, in practice: which sandbox, which runtime,
    // which repository. Without these a node sat in "Working" for ten minutes
    // with nothing to say for itself.
    if (event.type === 'step.progress') {
      const message = (event.payload as { message?: string } | null)?.message;
      if (message) addNote(turnFor(event), message);
      continue;
    }

    // How a step ended. A dispatch that never ran used to produce no event at
    // all, so a broken run and a quiet one looked identical.
    if (event.type === 'step.outcome') {
      const outcome = event.payload as { succeeded?: boolean; message?: string } | null;
      if (outcome?.message && !outcome.succeeded) addNote(turnFor(event), outcome.message, 'problem');
      continue;
    }

    if (event.type === 'state.transition') {
      const state = (event.payload as { state?: string } | null)?.state;
      if (state && NARRATED.has(state)) addNote(turnFor(event), labelOf(state));
      continue;
    }

    // A retry is not noise. The runtime's `system` events are suppressed by the
    // stream renderer, which is right for hook chatter and init banners — but an
    // API retry is the reason nothing is happening, and hiding it leaves a
    // reader watching a spinner for minutes with no idea anything is wrong.
    // A refused request is not a connection problem. Reporting it as one is what
    // made an exhausted usage window look like a network fault for ten retries.
    if (event.type.endsWith('.rate_limit_event')) {
      const note = rateLimitNote(event.payload);
      if (note) addNote(turnFor(event, event.type.startsWith('plan.') ? 'plan' : 'work'), note, 'problem');
      continue;
    }

    if (event.type.endsWith('.system')) {
      const note = systemNote(event.payload);
      if (note) addNote(turnFor(event, event.type.startsWith('plan.') ? 'plan' : 'work'), note, 'problem');
      continue;
    }

    const phase: Phase | null = event.type.startsWith('exec.') ? 'work'
      : event.type.startsWith('plan.') ? 'plan'
      : null;
    if (!phase) continue;

    // A renderer per node *and* phase: they are separate runs with separate
    // tool-call ids, and sharing one would let a planning result resolve a
    // working tool call.
    const results = rendererFor(`${event.nodeId}:${phase}`)
      .feed({ type: event.type.slice(phase.length + 1), payload: event.payload });
    if (results.length === 0) continue;

    for (const result of results) {
      if (options.omitSummaries && result.line.kind === 'summary') continue;
      if (result.action === 'update') {
        const home = lineHome.get(result.line.key);
        if (home) {
          home.lines = home.lines.map((line) => (line.key === result.line.key ? result.line : line));
          continue;
        }
      }
      // The planner's answer is a JSON array meant for the machine. Showing it
      // as something the agent "said" is noise — a bare `[]` in the middle of
      // the prose.
      if (phase === 'plan' && result.line.kind === 'text' && /^\s*\[[\s\S]*\]\s*$/.test(result.line.content)) continue;

      const turn = turnFor(event, phase);
      turn.lines.push(result.line);
      lineHome.set(result.line.key, turn);
    }
  }

  // A turn that produced neither output nor a note is a node that only passed
  // through bookkeeping states — nothing to show.
  return turns.filter((turn) => turn.lines.length > 0 || turn.notes.length > 0 || turn.answer);
}

/** The lines for a single node, for the sidebar's Activity tab. Same renderer,
 *  same folding rules — one implementation, two surfaces. */
export function toLines(events: OrgEvent[], nodeId: string): RenderedLine[] {
  const turns = toTurns(events.filter((event) => event.nodeId === nodeId), new Map());
  return turns.flatMap((turn) => turn.lines);
}

export interface TurnSummary {
  /** A glimpse of the reasoning, not the whole of it. */
  thought?: string;
  /** The last thing the agent actually said. */
  said?: string;
  /** How much it did, for a turn shown collapsed. */
  steps: number;
  files: number;
}

/** What a child's turn looks like in the main conversation: enough to follow
 *  along, not enough to bury what the root is doing. The full transcript stays
 *  one click away in that node's own panel. */
export function summarizeTurn(turn: Turn, limit = 200): TurnSummary {
  const said = [...turn.lines].reverse().find((line) => line.kind === 'text');
  const thought = [...turn.lines].reverse().find((line) => line.kind === 'thinking');
  return {
    thought: thought && clip(thought.content, Math.round(limit * 0.6)),
    said: said && clip(said.content, limit),
    steps: turn.lines.filter((line) => line.kind !== 'text' && line.kind !== 'thinking').length,
    files: turn.lines.filter((line) => line.kind === 'diff').length,
  };
}

function clip(text: string, limit: number): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length <= limit ? flat : `${flat.slice(0, limit).trimEnd()}…`;
}

export interface Activity {
  read: number;
  edited: number;
  ran: number;
  /** Everything else the runtime reported doing. */
  other: number;
  total: number;
}

/** What an agent actually did, as counts rather than as a list.
 *
 *  A turn can carry eighty tool lines. Printed one per row they bury the two
 *  sentences that say what was found, which is the thing the reader came for.
 *  Counted, they fit on one line and the detail is one click away. */
export function activityOf(lines: RenderedLine[]): Activity {
  let read = 0, edited = 0, ran = 0, other = 0;
  for (const line of lines) {
    if (line.kind === 'text' || line.kind === 'thinking' || line.kind === 'summary') continue;
    if (line.kind === 'diff') { edited++; continue; }
    // The renderer writes the tool name into the line content.
    const content = line.content ?? '';
    if (/^\s*(Read|Grep|Glob|Search|WebFetch|List)\b/i.test(content)) read++;
    else if (/^\s*(Write|Edit|NotebookEdit|Create)\b/i.test(content)) edited++;
    else if (/^\s*(Bash|Run|Execute)\b/i.test(content)) ran++;
    else other++;
  }
  return { read, edited, ran, other, total: read + edited + ran + other };
}

/** The activity strip's words. Empty when the agent did nothing worth counting,
 *  so the caller can leave the strip out entirely rather than print "0 steps". */
export function describeActivity(activity: Activity): string {
  const parts = [
    activity.read > 0 && `${activity.read} read`,
    activity.edited > 0 && `${activity.edited} edited`,
    activity.ran > 0 && `${activity.ran} ${activity.ran === 1 ? 'command' : 'commands'}`,
    activity.other > 0 && `${activity.other} other`,
  ].filter(Boolean) as string[];
  return parts.join(' · ');
}
