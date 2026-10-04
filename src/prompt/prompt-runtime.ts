/** The lifecycle-facing half of prompt construction.
 *
 *  `node-actor-manager.ts` used to build each dispatch's prompt by nesting
 *  template strings at three call sites (execute, plan, synthesize), each with
 *  its own ordering and none with a bound. This module owns that policy: the
 *  lifecycle hands over the *pieces* it has — the goal, the selected repository
 *  context, the conversation, the evidence the market bought — and gets back
 *  the two strings the runtime takes, or a refusal that says why.
 *
 *  What "policy" means here is small and explicit:
 *
 *   - which channel a piece rides and how stable it is (→ cache layout);
 *   - how much it matters when the budget is short, and what cheaper form it can
 *     take (→ demotion order);
 *   - that a required piece is never silently cut.
 *
 *  Under budget the output is byte-for-byte what the hand-built assembly
 *  produced (the tests compare against a copy of it), so the compiler changes
 *  nothing until something is actually too big.
 *
 *  Priorities, low to high (optional pieces go first; required ones never do):
 *
 *      repo context 40  <  conversation 50  <  bought evidence 60
 *
 *  The repository map is a navigation aid the agent can rebuild by looking; the
 *  conversation has a ladder of cheaper forms to walk down first; evidence is
 *  something the economic boundary already decided was worth paying for.
 */
import { repoContextPreamble } from '../intelligence/repo-map.js';
import { synthesisParts, type ChildReport } from '../intelligence/synthesize.js';
import { contextWindowTokens, promptArgBytes } from '../config/efficiency.js';
import { DEFAULT_PROMPT_BUDGET, type PromptBudget } from './prompt-budget.js';
import { compilePrompt, type PromptCompileReceipt } from './prompt-compiler.js';
import { BLOCK_SEPARATOR, layoutOrder, type PromptBlock, type PromptDocument } from './prompt-ir.js';

export interface AssembledPrompt {
  /** The system-prompt channel, or undefined when nothing rides it. */
  system: string | undefined;
  /** The user-message channel: what becomes the runtime's prompt argument. */
  goal: string;
  /** Null only when the compiler itself could not run (`fellBack`). */
  receipt: PromptCompileReceipt | null;
  /** Set when a required piece cannot fit. `goal` is then empty and the caller
   *  must not dispatch. */
  refused?: string;
  /** The compiler threw and the pieces were concatenated in layout order,
   *  unbounded — the path every dispatch took before it existed. */
  fellBack?: boolean;
}

export function promptBudgetFromConfig(): PromptBudget {
  return {
    ...DEFAULT_PROMPT_BUDGET,
    providerContextLimit: contextWindowTokens(),
    maxBytesPerChannel: promptArgBytes(),
  };
}

/** Compiles, and never throws. A defect in the optimizer costs a dispatch its
 *  bound, never its run: the fallback is the plain layout-order join, which is
 *  what the runtime received before the compiler existed. */
export function compileWithFallback(document: PromptDocument, budget: PromptBudget): AssembledPrompt {
  try {
    const compiled = compilePrompt(document, budget);
    if (compiled.receipt.status === 'refused') {
      return { system: undefined, goal: '', receipt: compiled.receipt, refused: compiled.receipt.reasons.join('; ') };
    }
    return { system: compiled.system || undefined, goal: compiled.user, receipt: compiled.receipt };
  } catch (err) {
    console.error('Prompt compiler failed; dispatching the unbounded layout:', err);
    const join = (channel: 'system' | 'user') => layoutOrder(document.blocks)
      .filter((b) => b.channel === channel && b.content.length > 0)
      .map((b) => b.content)
      .join(BLOCK_SEPARATOR);
    return { system: join('system') || undefined, goal: join('user'), receipt: null, fellBack: true };
  }
}

export interface RoleParts { constitution: string; stanza: string }

function roleBlocks(role: RoleParts | undefined): PromptBlock[] {
  if (!role) return [];
  return [
    { id: 'role.constitution', kind: 'role', channel: 'system', cacheClass: 'STATIC', priority: 100, required: true, content: role.constitution },
    { id: 'role.stanza', kind: 'role', channel: 'system', cacheClass: 'TASK_STABLE', priority: 100, required: true, content: role.stanza },
  ];
}

const PRIORITY = { repo: 40, conversation: 50, evidence: 60, required: 100 } as const;

function repoBlock(repoContext: string | null | undefined): PromptBlock[] {
  if (!repoContext || !repoContext.trim()) return [];
  return [{
    id: 'repo-context', kind: 'repo-context', channel: 'user', cacheClass: 'TASK_STABLE',
    priority: PRIORITY.repo, required: false, content: repoContextPreamble(repoContext),
  }];
}

/** Conversation so far: optional, with cheaper renderings supplied by whoever
 *  can produce them (the session store knows how to condense its own turns). */
export type Conversation = string | { text: string; fallbacks?: string[] };

function conversationBlock(preface: Conversation | undefined): PromptBlock[] {
  if (!preface) return [];
  const { text, fallbacks } = typeof preface === 'string' ? { text: preface, fallbacks: undefined } : preface;
  if (!text) return [];
  return [{
    id: 'preface', kind: 'conversation', channel: 'user', cacheClass: 'SESSION_STABLE',
    priority: PRIORITY.conversation, required: false, content: text,
    ...(fallbacks?.length ? { fallbacks } : {}),
  }];
}

export interface ExecutePromptInput {
  /** Delivered through the system channel when the runtime honours one. */
  role?: RoleParts;
  goal: string;
  /** Present on a proof-only retry; leads the message and suppresses nothing
   *  else (the caller decides not to pass repo context for such a pass). */
  proofInstruction?: string;
  repoContext?: string | null;
  /** What a parent addressed to this child. Standing constraints ride it, so
   *  it is required: a constraint dropped for space is a mandate ignored. */
  envelope?: string;
  preface?: Conversation;
  /** Text the economic boundary bought for this dispatch. */
  evidence?: string;
}

export function assembleExecutePrompt(input: ExecutePromptInput, budget: PromptBudget): AssembledPrompt {
  const blocks: PromptBlock[] = [
    ...roleBlocks(input.role),
    ...(input.proofInstruction ? [{
      id: 'proof-instruction', kind: 'instruction', channel: 'user', cacheClass: 'STATIC', priority: PRIORITY.required,
      required: true, content: input.proofInstruction,
    } satisfies PromptBlock] : []),
    ...repoBlock(input.repoContext),
    ...(input.envelope ? [{
      id: 'handoff-envelope', kind: 'handoff', channel: 'user', cacheClass: 'SESSION_STABLE', priority: PRIORITY.required,
      required: true, content: input.envelope,
    } satisfies PromptBlock] : []),
    ...conversationBlock(input.preface),
    { id: 'goal', kind: 'goal', channel: 'user', cacheClass: 'DYNAMIC', priority: PRIORITY.required, required: true, content: input.goal },
    ...(input.evidence ? [{
      id: 'evidence', kind: 'evidence', channel: 'user', cacheClass: 'DYNAMIC', priority: PRIORITY.evidence,
      required: false, content: input.evidence,
    } satisfies PromptBlock] : []),
  ];
  return compileWithFallback({ blocks }, budget);
}

export interface PlanPromptInput {
  role?: RoleParts;
  goal: string;
  repoContext?: string | null;
  preface?: Conversation;
  /** The role prompt as text, for a runtime that cannot take a system prompt.
   *  Trails the goal, where it always sat. */
  inlineRole?: string;
}

export function assemblePlanPrompt(input: PlanPromptInput, budget: PromptBudget): AssembledPrompt {
  const blocks: PromptBlock[] = [
    ...roleBlocks(input.role),
    ...repoBlock(input.repoContext),
    ...conversationBlock(input.preface),
    { id: 'goal', kind: 'goal', channel: 'user', cacheClass: 'DYNAMIC', priority: PRIORITY.required, required: true, content: input.goal },
    ...(input.inlineRole ? [{
      id: 'role.inline', kind: 'role', channel: 'user', cacheClass: 'DYNAMIC', priority: PRIORITY.required,
      required: true, content: input.inlineRole,
    } satisfies PromptBlock] : []),
  ];
  return compileWithFallback({ blocks }, budget);
}

export interface SynthesisPromptInput {
  role?: RoleParts;
  goal: string;
  children: ChildReport[];
  inlineRole?: string;
}

export function assembleSynthesisPrompt(input: SynthesisPromptInput, budget: PromptBudget): AssembledPrompt {
  const parts = synthesisParts(input.goal, input.children);
  const blocks: PromptBlock[] = [
    ...roleBlocks(input.role),
    { id: 'synthesis-head', kind: 'goal', channel: 'user', cacheClass: 'DYNAMIC', priority: PRIORITY.required, required: true, content: parts.head },
    // Every agent must be represented, so each report is required — but each
    // can shrink through its own ladder, and equal priority means the loss is
    // shared out, largest report first, instead of landing on the last few.
    ...parts.children.map((ladder, index): PromptBlock => ({
      id: `child-report.${index + 1}`, kind: 'child-report', channel: 'user', cacheClass: 'DYNAMIC',
      priority: PRIORITY.evidence, required: true, content: ladder[0],
      ...(ladder.length > 1 ? { fallbacks: ladder.slice(1) } : {}),
    })),
    { id: 'synthesis-tail', kind: 'goal', channel: 'user', cacheClass: 'DYNAMIC', priority: PRIORITY.required, required: true, content: parts.tail },
    ...(input.inlineRole ? [{
      id: 'role.inline', kind: 'role', channel: 'user', cacheClass: 'DYNAMIC', priority: PRIORITY.required,
      required: true, content: input.inlineRole,
    } satisfies PromptBlock] : []),
  ];
  return compileWithFallback({ blocks }, budget);
}
