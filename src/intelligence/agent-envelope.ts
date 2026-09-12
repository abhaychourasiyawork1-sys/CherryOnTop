/** What a parent hands a child, in refs rather than prose.
 *
 *  Delegation used to hand over a subgoal string and nothing else, so every
 *  child rediscovered the repository from zero — N children, N identical scans,
 *  N identical maps in N prompts. The envelope says instead: here is what you
 *  must have, here is what may help, here is what you must not look at, here is
 *  your budget, and here is the shape your answer has to take.
 *
 *  Three properties it is built for:
 *
 *   - **Refs, not transcripts.** A field carrying raw text where a `ContextRef`
 *     would do is rejected at construction, not tidied up later. Prose is how a
 *     handoff silently becomes a copy of the parent's whole conversation.
 *   - **Deterministic serialization.** Two envelopes that say the same thing
 *     must produce the same bytes, or every fingerprint built on one is noise.
 *   - **Scope is checked before the handoff, not after.** A child cannot be
 *     asked to read something it is not permitted to read; that is a
 *     construction error, not a runtime refusal.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../context/store.js';
import { type ContextRef, type SecurityScope, scopePermits } from '../context/types.js';

export interface AgentBudget {
  tokens?: number;
  usd?: number;
  /** The hard turn cap the child will run under. Stated so it can plan inside
   *  it rather than be cut off at it. */
  maxTurns?: number;
}

export interface OutputContract {
  /** The envelope shape the child must close its report with. */
  schema: 'AgentResultEnvelope';
  /** Fields the parent will actually read. A child asked for a field nothing
   *  reads is paying output tokens for it. */
  required: string[];
}

export interface AgentEnvelope {
  goal: string;
  /** Must be resolvable by the child, and within its scope. */
  requiredContext: ContextRef[];
  suggestedContext: ContextRef[];
  /** Named explicitly rather than left to omission: "do not look at this" and
   *  "I did not mention this" are different instructions, and only one of them
   *  survives a child deciding to be thorough. */
  forbiddenContext: ContextRef[];
  constraints: string[];
  budget: AgentBudget;
  /** Manifest identities for the capabilities the child may use. Refs so a
   *  manifest is cached and versioned independently of the handoff that
   *  mentions it. */
  capabilities: string[];
  outputContract: OutputContract;
  /** The context-store revision this envelope was built against. What makes a
   *  later delta expressible: the child knows what it was told, so the parent
   *  can send only what has changed since. */
  contextRevision: string;
  scope: SecurityScope;
}

export class EnvelopeError extends Error {}

export interface BuildEnvelopeInput {
  goal: string;
  requiredContext?: ContextRef[];
  suggestedContext?: ContextRef[];
  forbiddenContext?: ContextRef[];
  constraints?: string[];
  budget?: AgentBudget;
  capabilities?: string[];
  outputContract?: OutputContract;
  scope: SecurityScope;
  /** The scope each ref was produced under, for the pre-handoff check. Absent
   *  means unknown, which is refused rather than assumed safe. */
  refScopes?: Map<string, SecurityScope>;
}

const DEFAULT_CONTRACT: OutputContract = {
  schema: 'AgentResultEnvelope',
  required: ['status', 'summary', 'findings', 'changedFiles', 'uncertainties', 'confidence'],
};

function sortRefs(refs: ContextRef[]): ContextRef[] {
  return [...refs].sort((a, b) =>
    a.semanticId < b.semanticId ? -1 : a.semanticId > b.semanticId ? 1 : a.version - b.version);
}

/** Anything that looks like a pasted transcript rather than a reference. */
const TRANSCRIPT = /\n\s*\n/;

export function buildAgentEnvelope(input: BuildEnvelopeInput): AgentEnvelope {
  const goal = input.goal.trim();
  if (!goal) throw new EnvelopeError('an envelope needs a goal');

  const required = sortRefs(input.requiredContext ?? []);
  const suggested = sortRefs(input.suggestedContext ?? []);
  const forbidden = sortRefs(input.forbiddenContext ?? []);

  // A ref cannot be both required and forbidden. Silently preferring one would
  // make the stricter instruction the one that loses.
  const forbiddenIds = new Set(forbidden.map((ref) => ref.semanticId));
  const conflict = [...required, ...suggested].find((ref) => forbiddenIds.has(ref.semanticId));
  if (conflict) throw new EnvelopeError(`${conflict.semanticId} is both offered and forbidden`);

  // Scope is checked here, before anything is handed over — a child asked to
  // read what it may not read is a construction error, not a runtime refusal.
  if (input.refScopes) {
    for (const ref of [...required, ...suggested]) {
      const producer = input.refScopes.get(ref.semanticId);
      if (!producer) throw new EnvelopeError(`the scope of ${ref.semanticId} is unknown, so it cannot be handed over`);
      if (!scopePermits(producer, input.scope)) {
        throw new EnvelopeError(`${ref.semanticId} is outside the scope this agent will run under`);
      }
    }
  }

  const constraints = (input.constraints ?? []).map((c) => c.trim()).filter(Boolean);
  const pasted = constraints.find((c) => TRANSCRIPT.test(c) || c.length > 2000);
  if (pasted) {
    throw new EnvelopeError('a constraint carries a transcript — hand over a ContextRef instead of pasted text');
  }

  return {
    goal,
    requiredContext: required,
    suggestedContext: suggested,
    forbiddenContext: forbidden,
    constraints,
    budget: input.budget ?? {},
    capabilities: [...(input.capabilities ?? [])].sort(),
    outputContract: input.outputContract ?? DEFAULT_CONTRACT,
    contextRevision: revisionOf([...required, ...suggested]),
    scope: input.scope,
  };
}

/** A stable name for exactly this set of context versions. Two envelopes
 *  offering the same versions share it, whatever order they were assembled in;
 *  one offering a newer version does not. */
export function revisionOf(refs: ContextRef[]): string {
  return createHash('sha256')
    .update(canonicalJson(sortRefs(refs).map((ref) => [ref.semanticId, ref.contentHash])))
    .digest('hex')
    .slice(0, 16);
}

/** Bytes. Deterministic by construction — every field is either sorted or
 *  scalar, and `canonicalJson` fixes key order. */
export function serializeEnvelope(envelope: AgentEnvelope): string {
  return canonicalJson(envelope);
}

export function envelopeFingerprint(envelope: AgentEnvelope): string {
  return createHash('sha256').update(serializeEnvelope(envelope)).digest('hex');
}

/** The envelope as instructions a runtime can actually be handed, since the only
 *  channel to a dispatch is its argv.
 *
 *  Deliberately compact: this is the *coordination* half of the prompt, and
 *  coordination tokens are paid on every child. Empty sections are omitted
 *  rather than rendered as headings with nothing under them. */
export function renderEnvelope(envelope: AgentEnvelope): string {
  const lines: string[] = [];
  const list = (label: string, items: string[]) => {
    if (items.length > 0) lines.push(`${label}: ${items.join(', ')}`);
  };

  list('Context you have been given', envelope.requiredContext.map((r) => r.semanticId));
  list('Context that may help', envelope.suggestedContext.map((r) => r.semanticId));
  list('Do not read', envelope.forbiddenContext.map((r) => r.semanticId));
  if (envelope.constraints.length > 0) {
    lines.push('Standing constraints (follow even where they conflict with the most direct path):');
    for (const constraint of envelope.constraints) lines.push(`  - ${constraint}`);
  }
  if (envelope.budget.maxTurns) lines.push(`You have at most ${envelope.budget.maxTurns} turns.`);
  if (envelope.budget.usd) lines.push(`Budget: $${envelope.budget.usd.toFixed(2)}.`);

  return lines.join('\n');
}
