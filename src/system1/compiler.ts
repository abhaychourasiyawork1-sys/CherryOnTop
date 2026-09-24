/** The Decision Compiler: the only place CherryOnTop's internal state becomes a
 *  System-1 question.
 *
 *  Deterministic by construction. The same question about the same facts is
 *  the same request, with the same id and digest, so a duplicate can be
 *  recognised and a stale answer can be refused.
 *
 *  It extracts *facts*. It must never carry an old heuristic's verdict into the
 *  request (a `worthSplitting`, a decomposition score): a provider shown the
 *  answer it is replacing would learn to echo it, and the receipt would call
 *  that a judgment. */
import { createHash } from 'node:crypto';
import type { EconomicState } from '../decision/state.js';
import {
  assertValidRequest,
  type DecisionCandidate, type DecisionPrimitive, type DecisionRequest, type DecisionSurface,
} from './types.js';

/** The typed-decisions checkpoint reads 1,024 tokens of state and silently
 *  drops the rest. ~3,000 characters of JSON stays inside that with room for
 *  the tokenizer, and it is this compiler, not the tokenizer, that decides what
 *  gets left out. */
export const STATE_CHAR_BUDGET = 3_000;
const GOAL_CHARS = 1_500;

/** Versioned harness questions. Changing a wording is a new version, so
 *  receipts from before and after the change are never compared as equals. */
export const HARNESS_QUESTIONS = {
  // Asked as a described two-way choice rather than a bare yes/no. Measured
  // against live Laya (typed-decisions) on 40 labelled goals
  // (bench/system1-calibration): AUC 0.89 as a choice, stable across a
  // train/test split, against 0.80 for the bare yes/no and 0.86 for a yes/no
  // with criteria. P(decomposable) is the calibrated probability of `many`.
  'execution.decomposable': {
    version: 'execution.decomposable@2',
    text: 'How should this task be staffed?',
    options: [
      { id: 'one', action: 'self-execute', description: 'one agent: it is a single coherent investigation, fix or change whose steps depend on each other' },
      { id: 'many', action: 'offer-delegation', description: 'several agents in parallel: it is made of separate, independent deliverables' },
    ],
  },
  'action.helpful': {
    version: 'action.helpful@1',
    // Conditioned on the action being carried out, so this composes with the
    // candidate's own failure risk instead of counting failure a second time.
    text: 'Assuming this action is carried out as described, would it materially improve the expected outcome of the task compared with continuing without it?',
  },
  'runtime.next_action': {
    version: 'runtime.next_action@1',
    text: 'Which available action is most justified as the next intervention, given the task, its unresolved uncertainty, the evidence so far and the remaining resources?',
  },
} as const;

export type Fact = [key: string, value: string | number | boolean];

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const pct = (x: number) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;

/** What System-1 may know about the run, as readable facts, most important
 *  first. Only fields a semantic judgment can use are included. Unrelated
 *  bookkeeping (optimization token pools, capability lists) never reaches the
 *  request, so changing it cannot change a digest. */
export function stateFacts(state: EconomicState): Fact[] {
  const r = state.resources;
  const facts: Fact[] = [
    ['progress', pct(state.trajectory.progress)],
    ['validation', `${state.validation.status}${state.validation.required ? ' (required)' : ''}`],
    ['doubt_about_correctness', pct(state.uncertainty.validation)],
    ['doubt_about_structure', pct(state.uncertainty.structural)],
    ['doubt_about_target', pct(state.uncertainty.target)],
    ['repeated_failures', pct(state.trajectory.failurePressure)],
    ['repeating_same_ground', pct(state.trajectory.stateSimilarity)],
  ];
  if (r.totalTokenBudget > 0) facts.push(['budget_used', pct(r.consumedTokens / r.totalTokenBudget)]);
  if (state.evidence.length > 0) facts.push(['evidence_items', state.evidence.length]);
  return facts;
}

export interface CompileInput {
  source: DecisionRequest['source'];
  surface: DecisionSurface;
  primitive: DecisionPrimitive;
  question: string;
  questionVersion: string;
  goal: string;
  /** Priority order: earlier facts survive the budget, later ones are dropped. */
  facts?: Fact[];
  /** Choice options (any order; canonicalized here) or score levels (rubric
   *  order, which is meaning and is kept). */
  candidates?: DecisionCandidate[];
  /** Keep the options in the order given. For a harness question whose
   *  options are constants: the order is already deterministic, and Laya is
   *  sensitive to it. Measured on the decomposability question: AUC 0.89 with
   *  the declared order against 0.835 sorted. A calibrator is only valid for
   *  the order it was fitted on. */
  fixedOrder?: boolean;
  stateVersion: number;
}

/** Throws `InvalidDecisionError` for anything a provider must not be asked. */
export function compileRequest(input: CompileInput): DecisionRequest {
  let truncated = input.goal.length > GOAL_CHARS;
  const state: Record<string, string | number | boolean> = { task: input.goal.slice(0, GOAL_CHARS) };
  for (const [key, value] of input.facts ?? []) {
    if (key === 'task' || key in state) continue;
    const next = { ...state, [key]: typeof value === 'string' ? value.slice(0, 400) : value };
    if (JSON.stringify(next).length > STATE_CHAR_BUDGET) {
      truncated = true;
      continue;
    }
    Object.assign(state, next);
  }

  const raw = (input.candidates ?? []).map((c) => ({ id: c.id, action: c.action, description: c.description.trim() }));
  const candidates = input.primitive === 'choice' && !input.fixedOrder
    ? [...raw].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    : raw;

  const question = input.question.trim();
  const inputDigest = sha256([input.source, input.surface, input.primitive, question, input.questionVersion, state, candidates]);
  const request: DecisionRequest = {
    id: `s1-${inputDigest.slice(0, 16)}`,
    source: input.source,
    surface: input.surface,
    primitive: input.primitive,
    question,
    questionVersion: input.questionVersion,
    state,
    candidates,
    stateVersion: input.stateVersion,
    inputDigest,
    truncated,
  };
  assertValidRequest(request);
  return request;
}

/** A harness surface, with its versioned question. */
export function compileHarnessRequest(input: Omit<CompileInput, 'source' | 'question' | 'questionVersion' | 'primitive'> & {
  surface: keyof typeof HARNESS_QUESTIONS;
  /** What the question is about, when it is about one thing (an action). Put in
   *  the question rather than the state so every question about the same state
   *  shares one forward pass. */
  subject?: string;
}): DecisionRequest {
  const q: { version: string; text: string; options?: readonly DecisionCandidate[] } = HARNESS_QUESTIONS[input.surface];
  const { subject, ...rest } = input;
  return compileRequest({
    ...rest,
    ...(q.options ? { candidates: [...q.options], fixedOrder: true } : {}),
    source: 'harness',
    primitive: input.surface === 'action.helpful' ? 'noul' : 'choice',
    question: subject ? `${q.text} Action: ${subject.slice(0, 200)}` : q.text,
    questionVersion: q.version,
  });
}
