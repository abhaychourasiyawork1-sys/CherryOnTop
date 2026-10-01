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
 *  `shadow` computes and records every decision and changes nothing. A
 *  disabled component is recorded the same way, so an ablation still yields
 *  labelled decisions. Anything unexpected returns `{}`: the hook's no-op,
 *  which leaves the agent exactly as it would have been. */
import { createHash, randomUUID } from 'node:crypto';
import { estimateTokens } from '../context/candidates.js';
import type { Fact } from '../system1/compiler.js';
import {
  expectedRemainingTurns, carryingUsd, elisionValue, betaProbability, type Prices, type RefetchBelief,
} from './economics.js';
import { predictRefetch, type RefetchFeatures, type RefetchModel } from './refetch-model.js';
import { classifyShell } from './shell.js';
import { codeIdentifiers, extractText, shapeCandidates, termsOf } from './shape.js';
import type { NegativeFinding } from './memory.js';

export type Mode = 'off' | 'shadow' | 'active';
export type Component = 'shape' | 'dedup' | 'finish' | 'memory' | 'system1';
export const COMPONENTS: readonly Component[] = ['shape', 'dedup', 'finish', 'memory', 'system1'];

/** Where a shaped observation's full text is kept inside the sandbox. */
export const SPILL_DIR = '/tmp/cto-ic';

export interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  last_assistant_message?: string;
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
  summary: Record<string, number>;
}

const SHAPEABLE = new Set(['Bash', 'Read', 'Grep', 'Glob', 'WebFetch']);
const EDITORS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd']);

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

export class InfoSession {
  step = 0;
  private lastEditStep = -1;
  private lastExecStep = -1;
  private edits = 0;
  private execs = 0;
  private seen = new Map<string, { step: number; tool: string }>();
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
      case 'Stop': return this.stop(payload);
      case 'PostCompact':
      case 'PreCompact':
        // The earlier copies a dedupe would point at are gone from context.
        this.seen.clear();
        this.count('compactions');
        return {};
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

    const search = this.searchSignature(tool, input);
    if (!search) return {};
    const known = this.negatives.get(search.signature);
    if (known && known.epoch === this.epoch) {
      // Nothing has been edited or run since this exact search found nothing.
      const applied = this.applies('memory');
      this.decision('PreToolUse', tool, 'deny-negative', applied, { signature: search.signature, sinceStep: known.step });
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
    if (EDITORS.has(tool)) { this.edits++; this.lastEditStep = this.step; return {}; }
    const shell = tool === 'Bash' ? classifyShell(String(input.command ?? '')) : null;
    if (shell?.kind === 'exec') { this.execs++; this.lastExecStep = this.step; }

    const text = extractText(p.tool_response);
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

    // Hard guards.
    const isRefetch = p.tool_use_id !== undefined && this.refetchCalls.has(p.tool_use_id);
    const ranged = tool === 'Read' ? input.offset !== undefined || input.limit !== undefined : shell?.ranged === true;
    const readsSpill = JSON.stringify(input).includes(SPILL_DIR);
    if (isRefetch || ranged || readsSpill || text.trim() === '') return {};

    // Exact duplicate of an observation still in context.
    const digest = hash(`${tool}\u0000${text}`);
    const earlier = this.seen.get(digest);
    if (earlier) {
      const savedUsd = carryingUsd(tokens, this.remaining(), this.config.prices);
      const applied = this.applies('dedup');
      this.decision('PostToolUse', tool, 'dedup', applied, { originalTokens: tokens, sameAsStep: earlier.step, savedUsd });
      if (applied) {
        return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: `[information control: identical to the output of step ${earlier.step} (${earlier.tool}), which is still above in this conversation]` } };
      }
      return {};
    }
    this.seen.set(digest, { step: this.step, tool });
    const outputIds = codeIdentifiers(text);
    try {
      return await this.shape(tool, input, text, tokens, outputIds, p.tool_use_id);
    } finally {
      for (const t of outputIds) this.identifiers.add(t);
    }
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
    return { refetch, observations, turns: Math.max(this.turns, this.step), unverifiedFinish: this.unverifiedFinish, summary };
  }
}
