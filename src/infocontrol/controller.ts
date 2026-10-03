/** One dispatch's information controller: every hook call becomes a priced
 *  decision.
 *
 *  Order of authority, every time:
 *    1. hard guards (never overridden): spill/refetch reads are never shaped,
 *       ranged reads are never shaped, errors pass through, one finish block
 *       per dispatch, a `<cto_decide>` turn is never blocked;
 *    2. closed-form economics: carrying cost against priced refetch risk;
 *    3. System-1, only where the evidence cannot decide (`ambiguous`), through
 *       the guarded door every System-1 question goes through.
 *
 *  Both directions of the agent–environment interface pass through here (the
 *  HarnessBridge split): observations are projected on the way in (shape,
 *  dedup, subsume), actions on the way out (a search that found nothing, an
 *  identical repeat of a call that just failed into an unchanged world). A
 *  refused action always says why, from this dispatch's own trajectory, and
 *  never twice for the same call in the same world: insisting is evidence.
 *
 *  `shadow` computes and records every decision and changes nothing. A
 *  disabled component is recorded the same way, so an ablation still yields
 *  labelled decisions. Anything unexpected returns `{}`: the hook's no-op,
 *  which leaves the agent exactly as it would have been. */
import { createHash, randomUUID } from 'node:crypto';
import { estimateTokens } from '../context/candidates.js';
import type { Fact } from '../system1/compiler.js';
import {
  expectedRemainingTurns, carryingUsd, elisionValue, betaProbability, repeatValue, type Prices, type RefetchBelief, type RepeatBelief,
} from './economics.js';
import { predictRefetch, type RefetchFeatures, type RefetchModel } from './refetch-model.js';
import { classifyShell } from './shell.js';
import { runsCodeForResults } from '../execution/observation.js';
import { codeIdentifiers, extractText, shapeCandidates, termsOf } from './shape.js';
import type { NegativeFinding } from './memory.js';

export type Mode = 'off' | 'shadow' | 'active';
export type Component = 'shape' | 'dedup' | 'finish' | 'memory' | 'system1' | 'repeat' | 'recite';
export const COMPONENTS: readonly Component[] = ['shape', 'dedup', 'finish', 'memory', 'system1', 'repeat', 'recite'];

/** Which kind of authority refused an action. Kept apart in every receipt:
 *  a trajectory refusal is this controller's (the call cannot do anything new
 *  here), an economic veto is the Action Market's, a permission denial is the
 *  mandate's. One must never be recorded as another. */
export type Refusal = 'trajectory' | 'economic' | 'authority';

/** Where a shaped observation's full text is kept inside the sandbox. */
export const SPILL_DIR = '/tmp/cto-ic';

export interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  last_assistant_message?: string;
  /** PostToolUseFailure: what the failed call returned. */
  error?: string;
  /** SessionStart: why the session (re)started; `compact` after a compaction. */
  source?: string;
}

export interface SessionConfig {
  nodeId: string;
  taskRootId: string;
  role: string;
  goal: string;
  mode: Mode;
  disabled: ReadonlySet<Component>;
  prices: Prices;
  /** How sure the evidence must be before risk is ignored: the task's quality floor. */
  confidence: number;
  /** What a failed task loses, in dollars: the loss side of the finish gate. */
  taskValueUsd: number;
  beliefs: ReadonlyMap<string, RefetchBelief>;
  /** Fit from past elisions (refetch-model.ts). Absent: the per-cell Beta. */
  refetchModel?: RefetchModel | null;
  pastTurns: readonly number[];
  finish: { failed: number; finished: number };
  negatives: readonly NegativeFinding[];
  revision: string | null;
  /** Identical repeats into an unchanged world, from earlier dispatches. Absent: uniform. */
  repeat?: RepeatBelief;
}

export interface Judge {
  /** Probability of "yes", or null when System-1 could not answer. */
  (surface: 'info.finish' | 'info.elide', facts: Fact[], stateVersion: number): Promise<number | null>;
}

export interface SessionDeps {
  emit(type: 'ic.decision' | 'ic.outcome', payload: Record<string, unknown>): void;
  judge?: Judge;
  admitNegative?(finding: NegativeFinding): void;
}

interface Elision {
  decisionId: string;
  step: number;
  cell: string;
  locator: string;
  elidedTokens: number;
  features: RefetchFeatures;
  refetchedAt?: number;
}

/** What closing a session hands back for the memory layer. */
export interface SessionResult {
  refetch: Map<string, RefetchBelief>;
  /** One training row per elision: what was known, and whether it came back. */
  observations: Array<{ features: RefetchFeatures; used: boolean }>;
  turns: number;
  /** An unverified finish was allowed through (by policy or by mode): its
   *  validation verdict is the finish gate's training label. */
  unverifiedFinish: boolean;
  /** One row per identical repeat that was allowed to run: the repeat gate's training labels. */
  repeats: Array<{ differed: boolean; again: boolean }>;
  summary: Record<string, number>;
}

/** The last thing a call did, for the repeat gate. */
interface CallRecord {
  step: number;
  /** `world` right after the call ran: equal to the current one means nothing
   *  that could change its result has happened since. */
  world: number;
  failed: boolean;
  digest: string;
  tokens: number;
  tail: string;
  /** Identical repeats already allowed in this world. */
  repeats: number;
  /** The world a refusal was issued in: a second identical request there is let through. */
  refusedAt?: number;
}

const SHAPEABLE = new Set(['Bash', 'Read', 'Grep', 'Glob', 'WebFetch']);
/** Calls the repeat gate may refuse: the ones Claude Code runs a PreToolUse hook for here. */
const GATED = new Set(['Bash', 'Read', 'Grep', 'Glob', 'Edit', 'MultiEdit']);
const EDITORS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd']);

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

export class InfoSession {
  step = 0;
  private lastEditStep = -1;
  private lastExecStep = -1;
  private edits = 0;
  private execs = 0;
  private seen = new Map<string, { step: number; tool: string; decisionId?: string }>();
  /** Bumped by every edit and every command that may write: what makes a
   *  repeated call able to come out differently. Reads never bump it. */
  private world = 0;
  private calls = new Map<string, CallRecord>();
  private repeatLabels: Array<{ signature: string; differed?: boolean; again: boolean }> = [];
  /** Read lines in context, per file: line number → its text and the step that showed it. */
  private lines = new Map<string, Map<number, { text: string; step: number }>>();
  /** Duplicate/subsumed views already replaced once: the next identical request passes. */
  private struck = new Map<string, string>();
  private readonly filesEdited = new Set<string>();
  private lastFailure: { step: number; call: string; tail: string } | null = null;
  private elisions: Elision[] = [];
  private refetchCalls = new Set<string>();
  private negatives = new Map<string, { step: number; epoch: number; query: string }>();
  private finishBlocked = false;
  private unverifiedFinish = false;
  private usageSeen = new Set<string>();
  private turns = 0;
  private contextTokens = 0;
  private outputTokens = 0;
  private observationTokens = 0;
  private observations = 0;
  private counts: Record<string, number> = {};
  private priorHinted = false;
  private readonly query: Set<string>;
  /** Code identifiers the agent has already been shown or has written: the
   *  baseline against which an elided region's novelty is measured. */
  private readonly identifiers: Set<string>;

  constructor(readonly config: SessionConfig, private readonly deps: SessionDeps) {
    this.query = termsOf(config.goal);
    this.identifiers = codeIdentifiers(config.goal);
  }

  private get epoch(): number { return this.edits + this.execs; }

  private count(key: string, by = 1) { this.counts[key] = (this.counts[key] ?? 0) + by; }

  private applies(component: Component): boolean {
    return this.config.mode === 'active' && !this.config.disabled.has(component);
  }

  private remaining(): number { return expectedRemainingTurns(Math.max(this.turns, this.step), this.config.pastTurns); }

  /** The runtime's own usage, as it streams: what a turn really re-reads. */
  observeEvent(event: { type: string; payload: unknown }): void {
    if (event.type !== 'assistant') return;
    const message = (event.payload as { message?: { id?: string; usage?: Record<string, number> } } | null)?.message;
    if (!message?.id || this.usageSeen.has(message.id)) return;
    this.usageSeen.add(message.id);
    const u = message.usage ?? {};
    this.turns++;
    this.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    this.outputTokens += u.output_tokens ?? 0;
  }

  async handle(payload: HookPayload): Promise<Record<string, unknown>> {
    this.count('hooks');
    switch (payload.hook_event_name) {
      case 'PreToolUse': return this.preToolUse(payload);
      case 'PostToolUse': return this.postToolUse(payload);
      case 'PostToolUseFailure': return this.postToolFailure(payload);
      case 'Stop': return this.stop(payload);
      case 'PostCompact':
      case 'PreCompact':
        this.forgetContext();
        this.count('compactions');
        return {};
      case 'SessionStart': return payload.source === 'compact' ? this.recite() : {};
      default: return {};
    }
  }

  private decision(event: string, tool: string | undefined, action: string, applied: boolean, extra: Record<string, unknown> = {}): string {
    const decisionId = `ic-${randomUUID()}`;
    this.deps.emit('ic.decision', {
      decisionId, nodeId: this.config.nodeId, step: this.step, event, tool: tool ?? null, action, applied,
      mode: this.config.mode, epoch: this.epoch, contextTokens: this.contextTokens, turns: this.turns, ...extra,
    });
    this.count(`${action}${applied ? '' : ':not-applied'}`);
    return decisionId;
  }

  /** The locator a tool call reads, when it reads one an elision pointed at. */
  private refetchOf(tool: string, input: Record<string, unknown>): Elision | undefined {
    const target = tool === 'Bash' ? String(input.command ?? '') : String(input.file_path ?? input.path ?? '');
    if (!target) return undefined;
    return this.elisions.find((e) => e.refetchedAt === undefined && (tool === 'Bash' ? target.includes(e.locator) : target === e.locator));
  }

  private searchSignature(tool: string, input: Record<string, unknown>): { signature: string; query: string } | null {
    if (tool === 'Grep' || tool === 'Glob') {
      const query = `${tool} ${String(input.pattern ?? '')} in ${String(input.path ?? '.')}${input.glob ? ` (${String(input.glob)})` : ''}`;
      return { signature: hash(JSON.stringify([tool, input.pattern, input.path ?? '.', input.glob ?? null, input.type ?? null])), query };
    }
    if (tool === 'Bash') {
      const command = String(input.command ?? '').trim();
      const shell = classifyShell(command);
      if (shell.kind !== 'navigate' || !shell.programs.some((p) => SEARCHERS.has(p))) return null;
      return { signature: hash(command.replace(/\s+/g, ' ')), query: command.slice(0, 200) };
    }
    return null;
  }

  private preToolUse(p: HookPayload): Record<string, unknown> {
    const tool = p.tool_name ?? '';
    const input = p.tool_input ?? {};
    for (const t of codeIdentifiers(JSON.stringify(input))) this.identifiers.add(t);
    // Outcome labelling first: a refetch is evidence whatever else happens.
    const refetched = this.refetchOf(tool, input);
    if (refetched) {
      refetched.refetchedAt = this.step;
      if (p.tool_use_id) this.refetchCalls.add(p.tool_use_id);
      this.deps.emit('ic.outcome', { decisionId: refetched.decisionId, nodeId: this.config.nodeId, refetched: true, atStep: this.step, cell: refetched.cell });
      this.count('refetches');
    }

    const gated = this.repeatGate(tool, input);
    if (gated) return gated;

    const search = this.searchSignature(tool, input);
    if (!search) return {};
    const known = this.negatives.get(search.signature);
    if (known && known.epoch === this.epoch) {
      // Nothing has been edited or run since this exact search found nothing.
      const applied = this.applies('memory');
      this.decision('PreToolUse', tool, 'deny-negative', applied, { signature: search.signature, sinceStep: known.step, refusal: 'trajectory' satisfies Refusal });
      if (!applied) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Information control: this exact search found nothing at step ${known.step}, and nothing has been edited or run since, so it would find nothing again. Search somewhere or for something else.`,
        },
      };
    }
    const earlier = this.config.negatives.find((n) => n.signature === search.signature);
    if (earlier && !this.priorHinted) {
      // Another dispatch of this task searched this and found nothing. The tree
      // may have changed since, so this is advice, never a refusal.
      this.priorHinted = true;
      const applied = this.applies('memory');
      this.decision('PreToolUse', tool, 'advise-negative', applied, { signature: search.signature, from: earlier.nodeId });
      if (!applied) return {};
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: `Information control: an earlier attempt at this task ran this same search (${earlier.query}) and found nothing${earlier.revision ? ` at revision ${earlier.revision.slice(0, 10)}` : ''}.`,
        },
      };
    }
    return {};
  }

  private async postToolUse(p: HookPayload): Promise<Record<string, unknown>> {
    this.step++;
    const tool = p.tool_name ?? '';
    const input = p.tool_input ?? {};
    if (EDITORS.has(tool)) {
      this.edits++;
      this.lastEditStep = this.step;
      this.world++;
      const path = String(input.file_path ?? input.notebook_path ?? '');
      if (path) this.filesEdited.add(path);
      this.recordCall(tool, input, false, '');
      return {};
    }
    const shell = tool === 'Bash' ? classifyShell(String(input.command ?? '')) : null;
    if (shell?.kind === 'exec') { this.execs++; this.lastExecStep = this.step; this.world++; }

    const text = extractText(p.tool_response);
    if (GATED.has(tool)) this.recordCall(tool, input, false, text ?? '');
    if (text === null || !SHAPEABLE.has(tool)) return {};
    const tokens = estimateTokens(text);
    this.observations++;
    this.observationTokens += tokens;

    const search = this.searchSignature(tool, input);
    if (search && text.trim() === '') {
      this.negatives.set(search.signature, { step: this.step, epoch: this.epoch, query: search.query });
      this.deps.admitNegative?.({ signature: search.signature, query: search.query, nodeId: this.config.nodeId, step: this.step, revision: this.config.revision });
      return {};
    }

    // Hard guards: what the agent explicitly asked to see again, or nothing at all.
    const isRefetch = p.tool_use_id !== undefined && this.refetchCalls.has(p.tool_use_id);
    const ranged = tool === 'Read' ? input.offset !== undefined || input.limit !== undefined : shell?.ranged === true;
    const readsSpill = JSON.stringify(input).includes(SPILL_DIR);
    const numbered = tool === 'Read' ? numberedLines(p.tool_response, text) : null;
    const digest = hash(`${tool}\u0000${text}`);
    // Only what reaches the agent whole is "still above in this conversation":
    // a shaped or replaced view is not, so nothing may later point at it as if it were.
    const delivered = () => {
      this.seen.set(digest, { step: this.step, tool });
      if (numbered) this.rememberLines(String(input.file_path ?? ''), numbered);
      return {};
    };
    if (isRefetch || readsSpill || text.trim() === '') return delivered();

    // Exact duplicate of an observation still in context. Not shaping, so a
    // slice the agent ranged itself is deduped too: its copy is already there.
    const earlier = this.seen.get(digest);
    if (earlier) {
      const struck = this.struck.get(`dedup:${digest}`);
      if (struck !== undefined) {
        // Replaced once and asked for again: the agent wants it here. Give it.
        this.struck.delete(`dedup:${digest}`);
        this.deps.emit('ic.outcome', { decisionId: struck, nodeId: this.config.nodeId, refetched: true, atStep: this.step, cell: 'dedup' });
        this.count('refetches');
        return delivered();
      }
      const savedUsd = carryingUsd(tokens, this.remaining(), this.config.prices);
      const applied = this.applies('dedup');
      const decisionId = this.decision('PostToolUse', tool, 'dedup', applied, { originalTokens: tokens, sameAsStep: earlier.step, savedUsd });
      if (applied) {
        this.struck.set(`dedup:${digest}`, decisionId);
        return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: `[information control: identical to the output of step ${earlier.step} (${earlier.tool}), which is still above in this conversation. Run the same call again if you need it repeated here.]` } };
      }
      return delivered();
    }
    if (numbered) {
      const subsumed = this.subsume(String(input.file_path ?? ''), input, numbered, tokens);
      if (subsumed === 'deliver') return delivered();
      if (subsumed) return subsumed;
    }
    if (ranged) return delivered();
    // Hard guard: what a test run, a script or an inline program printed is
    // the evidence the agent decides on, so it is never shaped, only
    // deduplicated (a build or install log still is). HarnessBridge's learned
    // projection compressed test execution 3.1% of the time, against ~25% for
    // builds and 20-40% for reads and searches; measured here, shaping a
    // data-analysis run hid its correlation matrix from the agent
    // (Terminal-Bench bn-fit-modify, 2026-10-03).
    if (tool === 'Bash' && runsCodeForResults(String(input.command ?? ''))) return delivered();
    const outputIds = codeIdentifiers(text);
    try {
      const shaped = await this.shape(tool, input, text, tokens, outputIds, p.tool_use_id);
      // Only what reaches the agent counts as in context.
      if (shaped.hookSpecificOutput === undefined) delivered();
      return shaped;
    } finally {
      for (const t of outputIds) this.identifiers.add(t);
    }
  }

  /** A failed call (Claude Code reports these on their own event, never on
   *  PostToolUse). The output passes through untouched; what the controller
   *  learns is that it ran, what it returned, and that the agent saw it. */
  private postToolFailure(p: HookPayload): Record<string, unknown> {
    this.step++;
    const tool = p.tool_name ?? '';
    const input = p.tool_input ?? {};
    const text = typeof p.error === 'string' ? p.error : extractText(p.tool_response) ?? '';
    for (const t of codeIdentifiers(text)) this.identifiers.add(t);
    if (tool === 'Bash' && classifyShell(String(input.command ?? '')).kind === 'exec') {
      // A command that ran and failed is still a check that ran.
      this.execs++;
      this.lastExecStep = this.step;
      this.world++;
    }
    if (!EDITORS.has(tool) && SHAPEABLE.has(tool)) {
      this.observations++;
      this.observationTokens += estimateTokens(text);
    }
    if (GATED.has(tool)) this.recordCall(tool, input, true, text);
    this.lastFailure = { step: this.step, call: describeCall(tool, input), tail: tail(text, 300) };
    this.count('failures');
    return {};
  }

  /** The repeat gate's notion of "the same call": what it does, not how it was
   *  described (a Bash `description` or `timeout` changes nothing it runs). */
  private callSignature(tool: string, input: Record<string, unknown>): string {
    if (tool === 'Bash') return hash(`Bash\u0000${String(input.command ?? '').replace(/\s+/g, ' ').trim()}`);
    const { description: _d, timeout: _t, ...rest } = input;
    return hash(`${tool}\u0000${JSON.stringify(rest, Object.keys(rest).sort())}`);
  }

  /** What a call did, for the repeat gate; also settles the label of a repeat
   *  that was allowed to run. Called after `world` has moved for the call itself. */
  private recordCall(tool: string, input: Record<string, unknown>, failed: boolean, text: string): void {
    const signature = this.callSignature(tool, input);
    const digest = hash(text);
    const prev = this.calls.get(signature);
    const label = [...this.repeatLabels].reverse().find((l) => l.signature === signature && l.differed === undefined);
    if (label) label.differed = !(failed && prev?.failed === true && prev.digest === digest);
    const same = prev !== undefined && failed && prev.failed && prev.digest === digest && label !== undefined && !label.differed;
    this.calls.set(signature, {
      step: this.step, world: this.world, failed, digest, tokens: estimateTokens(text), tail: tail(text, 300),
      repeats: same ? prev.repeats + 1 : 0,
    });
  }

  /** Action projection for a call that just failed and that nothing since
   *  could have changed: priced, grounded, and never refused twice in one world. */
  private repeatGate(tool: string, input: Record<string, unknown>): Record<string, unknown> | null {
    if (!GATED.has(tool)) return null;
    const signature = this.callSignature(tool, input);
    const prev = this.calls.get(signature);
    if (!prev || !prev.failed || prev.world !== this.world) return null;
    // The loop goes on: an allowed identical repeat is being issued yet again.
    const open = [...this.repeatLabels].reverse().find((l) => l.signature === signature);
    if (open && open.differed === false) open.again = true;
    const allow = (): null => {
      this.repeatLabels.push({ signature, again: false });
      return null;
    };
    if (prev.refusedAt === this.world) {
      this.decision('PreToolUse', tool, 'allow-repeat', false, { signature, sinceStep: prev.step, insisted: true });
      return allow();
    }
    const feedback = `Information control: this exact call failed at step ${prev.step}, and nothing that could change its result has happened since — no file was edited and no other command was run. It would fail the same way again. What it returned:\n${prev.tail}\nChange something first (edit the code, fix the environment, or run a different command), or ask for something else. If you are sure it is worth repeating unchanged, issue it once more and it will run.`;
    const R = this.remaining();
    const outputPerTurn = this.turns > 0 ? this.outputTokens / this.turns : 0;
    const value = repeatValue({
      belief: this.config.repeat ?? { repeats: 0, differed: 0, again: 0 }, sessionRepeats: prev.repeats,
      duplicateTokens: prev.tokens, feedbackTokens: estimateTokens(feedback), remainingTurns: R,
      turnUsd: this.contextTokens * this.config.prices.read + outputPerTurn * this.config.prices.output,
    }, this.config.prices, this.config.confidence);
    const deny = value.verdict === 'deny';
    const applied = deny && this.applies('repeat');
    this.decision('PreToolUse', tool, deny ? 'deny-repeat' : 'allow-repeat', applied, {
      signature, sinceStep: prev.step, sessionRepeats: prev.repeats, ...value, ...(deny ? { refusal: 'trajectory' satisfies Refusal } : {}),
    });
    if (!applied) return allow();
    prev.refusedAt = this.world;
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: feedback } };
  }

  private rememberLines(path: string, numbered: ReadonlyMap<number, string>): void {
    if (!path) return;
    const known = this.lines.get(path) ?? new Map<number, { text: string; step: number }>();
    for (const [n, text] of numbered) known.set(n, { text, step: this.step });
    this.lines.set(path, known);
  }

  /** A Read whose every line, with its line number, this conversation already
   *  shows: nothing new was read, which the match itself proves. Replaced once
   *  by a pointer to where those lines are; asked again, it passes. */
  private subsume(path: string, input: Record<string, unknown>, numbered: ReadonlyMap<number, string>, tokens: number): Record<string, unknown> | 'deliver' | null {
    const key = `subsume:${path}:${String(input.offset ?? '')}:${String(input.limit ?? '')}`;
    const struck = this.struck.get(key);
    if (struck !== undefined) {
      this.struck.delete(key);
      this.deps.emit('ic.outcome', { decisionId: struck, nodeId: this.config.nodeId, refetched: true, atStep: this.step, cell: 'subsume' });
      this.count('refetches');
      return 'deliver';
    }
    const known = this.lines.get(path);
    if (!known || numbered.size === 0) return null;
    const steps = new Set<number>();
    for (const [n, text] of numbered) {
      const k = known.get(n);
      if (!k || k.text !== text) return null;
      steps.add(k.step);
    }
    const numbers = [...numbered.keys()];
    const from = Math.min(...numbers);
    const to = Math.max(...numbers);
    const pointer = `[information control: lines ${from}–${to} of ${path} are identical, line for line, to what step ${[...steps].sort((a, b) => a - b).join(', ')} already showed, which is still above in this conversation. Nothing new was read. Run this same Read again if you need them repeated here.]`;
    if (estimateTokens(pointer) >= tokens) return null;
    const applied = this.applies('dedup');
    const decisionId = this.decision('PostToolUse', 'Read', 'subsume', applied, {
      originalTokens: tokens, shapedTokens: estimateTokens(pointer), sameAsSteps: [...steps], savedUsd: carryingUsd(tokens - estimateTokens(pointer), this.remaining(), this.config.prices),
    });
    if (!applied) return null;
    this.struck.set(key, decisionId);
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: pointer } };
  }

  /** Everything a pointer could point at has left the context. */
  private forgetContext(): void {
    this.seen.clear();
    this.lines.clear();
    this.struck.clear();
  }

  /** The active state, compact: what the agent needs not to lose when its
   *  history is summarized (HarnessBridge's active-state index; the Harness
   *  Effect's objective recitation). Built only from this dispatch's own
   *  trajectory, so nothing in it is a guess. */
  activeState(): string {
    const lines = [`Goal: ${this.config.goal.trim().slice(0, 600)}`];
    if (this.filesEdited.size > 0) {
      const files = [...this.filesEdited];
      lines.push(`Files you have edited (${files.length}): ${files.slice(0, 15).join(', ')}${files.length > 15 ? ', …' : ''}`);
    }
    if (this.edits > 0) {
      lines.push(this.lastEditStep > this.lastExecStep
        ? `Verification: nothing has run since your last edit (step ${this.lastEditStep}); the current version is unchecked.`
        : `Verification: a command ran at step ${this.lastExecStep}, after your last edit (step ${this.lastEditStep}).`);
    }
    if (this.lastFailure) lines.push(`Last failure (step ${this.lastFailure.step}): ${this.lastFailure.call}\n${this.lastFailure.tail}`);
    const negatives = [...this.negatives.values()].filter((n) => n.epoch === this.epoch).slice(-5);
    if (negatives.length > 0) lines.push(`Searches that found nothing, with nothing changed since: ${negatives.map((n) => n.query).join('; ')}`);
    return lines.join('\n');
  }

  /** Moves only on progress worth telling the agent about: a file edited
   *  for the first time, the latest edit checked or not, a different call
   *  failing. Step numbers and repeated failures of the same call do not move it. */
  progressSignature(): string {
    const verified = this.edits === 0 ? 'none' : this.lastEditStep > this.lastExecStep ? 'unchecked' : 'checked';
    return [this.filesEdited.size, verified, this.lastFailure?.call ?? ''].join('|');
  }

  private recite(): Record<string, unknown> {
    this.forgetContext();
    const text = `[information control: where this task stands, from its own record before the compaction]\n${this.activeState()}`;
    const applied = this.applies('recite');
    this.decision('SessionStart', undefined, 'recite', applied, { recitedTokens: estimateTokens(text) });
    if (!applied) return {};
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
  }

  private async shape(tool: string, input: Record<string, unknown>, text: string, tokens: number, outputIds: Set<string>, toolUseId?: string): Promise<Record<string, unknown>> {
    const locator = tool === 'Read' ? String(input.file_path ?? '') : `${SPILL_DIR}/${toolUseId ?? 'unknown'}.out`;
    if (!locator || (tool !== 'Read' && !toolUseId)) return {};
    const query = new Set([...this.query, ...termsOf(JSON.stringify(input))]);
    const candidates = shapeCandidates({ text, query, locator, source: tool === 'Read' });
    if (candidates.length === 0) return {};

    const R = this.remaining();
    const outputPerTurn = this.turns > 0 ? this.outputTokens / this.turns : 0;
    const kind = tool === 'Bash' ? 'bash' : tool.toLowerCase();
    const progress = this.step / (this.step + R);
    const scored = candidates.map((c) => {
      const cell = `${kind}:${c.representation}`;
      const belief = this.config.beliefs.get(cell) ?? { refetched: 0, elided: 0 };
      const kept = codeIdentifiers(c.text);
      const features: RefetchFeatures = {
        tool: kind, representation: c.representation, originalTokens: tokens, keptFraction: c.tokens / Math.max(1, tokens),
        novelIdentifiers: [...outputIds].filter((t) => !kept.has(t) && !this.identifiers.has(t)).length, progress,
      };
      const probability = this.config.refetchModel
        ? predictRefetch(this.config.refetchModel, features, this.config.confidence)
        : betaProbability(belief, this.config.confidence);
      const value = elisionValue({
        elidedTokens: tokens - c.tokens, remainingTurns: R, probability,
        refetch: { contextTokens: this.contextTokens, outputPerTurn, sliceTokens: tokens - c.tokens, remainingTurns: R },
      }, this.config.prices);
      return { c, cell, probability, features, value };
    });
    const features = { tool, originalTokens: tokens, remainingTurns: R, contextTokens: this.contextTokens };

    let best = scored.filter((s) => s.value.verdict === 'elide')
      .sort((a, b) => (b.value.savedUsd - b.value.riskBoundUsd) - (a.value.savedUsd - a.value.riskBoundUsd))[0];
    let system1: number | null | undefined;
    if (!best) {
      const ambiguous = scored.filter((s) => s.value.verdict === 'ambiguous')
        .sort((a, b) => (b.value.savedUsd - b.value.riskMeanUsd) - (a.value.savedUsd - a.value.riskMeanUsd))[0];
      if (ambiguous && this.deps.judge && !this.config.disabled.has('system1') && this.config.mode !== 'off') {
        system1 = await this.deps.judge('info.elide', [
          ['tool', tool], ['request', JSON.stringify(input).slice(0, 300)],
          ['output_lines', text.split('\n').length], ['kept_view', ambiguous.c.text.slice(0, 600)],
        ], this.step);
        const cost = ambiguous.value.riskMeanUsd / Math.max(1e-12, ambiguous.probability.mean);
        if (system1 !== null && ambiguous.value.savedUsd - system1 * cost > 0) best = ambiguous;
      }
    }
    if (!best) {
      this.decision('PostToolUse', tool, 'keep', false, { ...features, candidates: scored.map((s) => ({ cell: s.cell, tokens: s.c.tokens, p: s.probability.mean, ...s.value })), ...(system1 !== undefined ? { system1 } : {}) });
      return {};
    }
    const applied = this.applies('shape');
    const decisionId = this.decision('PostToolUse', tool, `shape:${best.c.representation}`, applied, {
      ...features, shapedTokens: best.c.tokens, cell: best.cell, locator, ...best.value, p: best.probability.mean,
      estimator: this.config.refetchModel ? 'logistic' : 'beta', refetchFeatures: best.features, ...(system1 !== undefined ? { system1 } : {}),
    });
    if (!applied) return {};
    this.elisions.push({ decisionId, step: this.step, cell: best.cell, locator, elidedTokens: tokens - best.c.tokens, features: best.features });
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: best.c.text } };
  }

  private async stop(p: HookPayload): Promise<Record<string, unknown>> {
    const message = p.last_assistant_message ?? '';
    // A turn that ends asking CherryOnTop a question is not a finish.
    if (message.includes('<cto_decide')) return {};
    const unverified = this.edits > 0 && this.lastEditStep > this.lastExecStep;
    if (!unverified) return {};
    // The one block was spent and the agent still finished unchecked.
    if (this.finishBlocked) { this.unverifiedFinish = true; return {}; }

    const prior = this.config.finish;
    let pFail = (1 + prior.failed) / (2 + prior.finished);
    let system1: number | null | undefined;
    if (this.deps.judge && !this.config.disabled.has('system1') && this.config.mode !== 'off') {
      system1 = await this.deps.judge('info.finish', [
        ['files_edited', this.edits], ['runs_after_last_edit', 0], ['runs_total', this.execs],
        ['final_message', message.slice(0, 400)],
      ], this.step);
      // One more voice, worth as much as the history behind the prior.
      if (system1 !== null) pFail = (pFail * (2 + prior.finished) + system1) / (3 + prior.finished);
    }
    // A check is two model calls: issue the command, then read its result.
    const R = 2;
    const meanObservation = this.observations > 0 ? this.observationTokens / this.observations : 0;
    const outputPerTurn = this.turns > 0 ? this.outputTokens / this.turns : 0;
    const turnUsd = R * this.contextTokens * this.config.prices.read + outputPerTurn * this.config.prices.output
      + carryingUsd(meanObservation, R, this.config.prices);
    const ev = pFail * this.config.taskValueUsd - turnUsd;
    const block = ev > 0;
    const applied = block && this.applies('finish');
    this.decision('Stop', undefined, block ? 'block-finish' : 'allow-finish', applied, {
      pFail, turnUsd, taskValueUsd: this.config.taskValueUsd, edits: this.edits, execs: this.execs, ...(system1 !== undefined ? { system1 } : {}),
    });
    if (!applied) { this.unverifiedFinish = true; return {}; }
    this.finishBlocked = true;
    return {
      decision: 'block',
      reason: 'Information control: you edited files after the last time you ran anything, so nothing has checked the final version. Run one targeted check — the narrowest test, build or command that exercises your change — and fix anything it shows before finishing.',
    };
  }

  close(): SessionResult {
    const refetch = new Map<string, RefetchBelief>();
    for (const e of this.elisions) {
      const b = refetch.get(e.cell) ?? { refetched: 0, elided: 0 };
      refetch.set(e.cell, { refetched: b.refetched + (e.refetchedAt !== undefined ? 1 : 0), elided: b.elided + 1 });
    }
    const summary: Record<string, number> = {
      ...this.counts,
      steps: this.step, turns: this.turns, edits: this.edits, execs: this.execs,
      elisions: this.elisions.length,
      elidedTokens: this.elisions.reduce((s, e) => s + e.elidedTokens, 0),
    };
    const observations = this.elisions.map((e) => ({ features: e.features, used: e.refetchedAt !== undefined }));
    const repeats = this.repeatLabels.filter((l): l is { signature: string; differed: boolean; again: boolean } => l.differed !== undefined)
      .map((l) => ({ differed: l.differed, again: l.again }));
    return { refetch, observations, turns: Math.max(this.turns, this.step), unverifiedFinish: this.unverifiedFinish, repeats, summary };
  }
}

function tail(text: string, chars: number): string {
  const t = text.trim();
  return t.length <= chars ? t : `…${t.slice(-chars)}`;
}

function describeCall(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') return `\`${String(input.command ?? '').slice(0, 200)}\``;
  const target = input.file_path ?? input.path ?? input.pattern;
  return target === undefined ? tool : `${tool} ${String(target).slice(0, 200)}`;
}

/** A Read's lines keyed by their line numbers, or null when they cannot be
 *  known exactly. Claude Code hands the hook the file slice with its first
 *  line number; a transcript shows `N<tab>text` per line. */
export function numberedLines(response: unknown, text: string): Map<number, string> | null {
  const file = (response as { file?: { content?: unknown; startLine?: unknown } } | null)?.file;
  const out = new Map<number, string>();
  if (file && typeof file.content === 'string' && typeof file.startLine === 'number') {
    file.content.split('\n').forEach((line, i) => out.set((file.startLine as number) + i, line));
    if (file.content.endsWith('\n')) out.delete((file.startLine as number) + file.content.split('\n').length - 1);
    return out.size > 0 ? out : null;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\t(.*)$/.exec(line);
    if (!m) {
      if (line.trim() === '') continue;
      return null;
    }
    out.set(Number(m[1]), m[2]);
  }
  return out.size > 0 ? out : null;
}
