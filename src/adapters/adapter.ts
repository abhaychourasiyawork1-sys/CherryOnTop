import { z } from 'zod';

export const StructuredEventSchema = z.object({
  type: z.string(),
  payload: z.unknown(),
});
export type StructuredEvent = z.infer<typeof StructuredEventSchema>;

/** What a node is permitted to reach for, in the shape an adapter needs to tell
 *  its runtime. `allowedTools: null` means unrestricted — see enforce-tools.ts
 *  for why an empty grant is the sentinel for "no restriction". */
export interface ToolGrant {
  allowedTools: string[] | null;
  readOnly: boolean;
}

/** Optional per-dispatch controls. All absent = today's behaviour exactly. */
export interface BuildCommandOptions {
  /** Passed verbatim to the runtime's model flag. A short alias ("haiku",
   *  "sonnet") or a full pinned id both work. */
  model?: string;
  /** Reasoning effort, passed to the runtime's own effort flag. Only one of
   *  the levels the adapter reports in `discoverCapabilities().efforts`. */
  effort?: string;
  /** Hard cap on agent turns for this dispatch. */
  maxTurns?: number;
  /** Appended to the runtime's built-in system prompt (Task 12). */
  systemPrompt?: string;
  /** Run as a multi-turn session fed over stdin instead of a one-shot prompt.
   *  The goal is then *not* in argv; the caller sends it as the first message.
   *  Only honoured by an adapter that declares `supportsSession`. */
  session?: boolean;
  /** Runtime settings JSON (Claude Code `--settings`): how information
   *  control attaches its hooks to one dispatch. Ignored by a runtime without
   *  a settings flag. */
  settings?: string;
}

/** What a harness can do right now, separate from what the market chooses.
 *  Candidates are generated from these rather than from hardcoded router
 *  assumptions, and the fingerprint is part of every candidate's identity so
 *  evidence never pools across different execution semantics. */
export interface HarnessCapabilitySnapshot {
  harness: string;
  /** Whether a model name survives into this harness's argv at all. */
  acceptsModelFlag: boolean;
  /** Whether this harness can serve a given model name. */
  serves(model: string): boolean;
  /** Reasoning-effort settings it exposes. `default` when it exposes none. The
   *  order is not interpreted: the market learns what an effort is worth. */
  efforts: string[];
  /** Model names it offers, as its own CLI spells them. Empty when it only
   *  runs its default model. The market proposes each; nothing ranks them
   *  here, and their order means nothing. */
  models: string[];
  /** Numeric facts the adapter knows about one candidate (context size, an
   *  effort index, anything). Facts describe; they never rank. Each fact's
   *  weight in what a candidate can do is learned from outcomes. */
  candidateFacts?: (model: string | undefined, effort: string) => Record<string, number>;
  supportsSession: boolean;
  health: 'healthy' | 'degraded' | 'rate_limited' | 'down';
  /** Stable hash of the above: two snapshots with different semantics never
   *  share a fingerprint. */
  fingerprint: string;
}

export interface RuntimeAdapter {
  name: string;
  /** Optional: an adapter that knows more about itself than argv probing can
   *  reveal (native effort levels, sandbox modes) reports it here. Absent, the
   *  snapshot is derived by probing `buildCommand` — see execution-market.ts. */
  discoverCapabilities?(): Partial<Omit<HarnessCapabilitySnapshot, 'harness' | 'health' | 'fingerprint'>>;
  /** See `HarnessCapabilitySnapshot.candidateFacts`. */
  candidateFacts?(model: string | undefined, effort: string): Record<string, number>;
  /** `grant` is optional so a caller that has no contract in hand (a plan or
   *  synthesis pass on the parent's own authority) still builds a command. When
   *  it is supplied the adapter must express it in the runtime's own permission
   *  flags, so a forbidden call is refused before it happens rather than
   *  reported after. */
  buildCommand(goal: string, grant?: ToolGrant, opts?: BuildCommandOptions): string[];
  /** Whether this runtime can actually serve a model *name*. Optional: absent
   *  means "any name the caller passes". It exists because the flag surviving
   *  into argv is not the same question as the runtime accepting the value —
   *  see codex.ts, which takes `--model` and then rejects a Claude alias. */
  servesModel?(model: string): boolean;
  /** Whether this runtime can hold a stdin-fed session (the private decision
   *  round trip needs one). Absent means it cannot. */
  supportsSession?: boolean;
  /** Wraps one raw output line as a StructuredEvent, or null if it is not a
   *  recognizable event (blank, malformed JSON, or missing a `type` field). */
  parseLine(line: string): StructuredEvent | null;
  /** A runtime CherryOnTop drives itself, in-process (the owned agent loop):
   *  `executeStep` hands it the whole dispatch instead of running
   *  `buildCommand`'s argv in a sandbox. Its `buildCommand` then only
   *  describes the dispatch, for capability probing. */
  run?(input: import('../execution/execute-step.js').ExecuteStepInput): Promise<import('../execution/execute-step.js').ExecuteStepResult>;
  parseEventStream(stream: NodeJS.ReadableStream): Promise<StructuredEvent[]>;
}
