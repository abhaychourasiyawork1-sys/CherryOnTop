/** Whether a run is working or wandering, read off what it actually did.
 *
 *  No model judges this. A judge would be a per-turn LLM call on the hot path
 *  of the thing being optimized, which is the one shape of optimization that
 *  cannot pay for itself — and it would make the guard's verdict something
 *  nobody can reproduce from the record afterwards.
 *
 *  What there is instead is the sandbox's own tool stream, which
 *  `observationsFromEvents` already pairs call-with-result. Four numbers come
 *  out of it, and the important property of all four is that ambiguity yields
 *  the middle: a trace we cannot read produces moderate signals, and moderate
 *  signals never trip the guard's stall branch. Being unsure must look like
 *  being unsure, not like a verdict. */
import type { StructuredEvent } from '../adapters/adapter.js';
import { observationsFromEvents, type Observation } from '../execution/observation.js';
// The shape `decision/trajectory.ts` compares. Imported rather than restated so
// the producer of a fingerprint and the comparison over it cannot disagree
// about the fields.
import type { ExecutionSnapshot } from '../decision/trajectory.js';

export interface ProgressSignals {
  /** [0,1]. The share of the trajectory spent looking rather than doing. */
  exploration: number;
  /** [0,1]. The share that produced something durable: an edit, a command that
   *  ran green. */
  progress: number;
  /** [0,1]. How much of it was the same failure over again. */
  repeatedFailure: number;
  /** [0,1]. How much of it was the same search over again. */
  repeatedSearch: number;
}

/** What the middle looks like. Returned whenever the stream says too little to
 *  judge — and chosen so the guard's stall branch (progress <= 0.1 AND
 *  exploration >= 0.8) cannot fire on it. */
export const UNKNOWN_PROGRESS: ProgressSignals = {
  exploration: 0.5, progress: 0.5, repeatedFailure: 0, repeatedSearch: 0,
};

/** Tools that gather. Nothing here changes the repository or proves anything
 *  about it; a run made entirely of these has, so far, produced nothing. */
const SEARCH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebSearch', 'WebFetch']);

/** Tools that change something. The output of the work, rather than its input. */
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Update']);

/** Bookkeeping. Neither looking nor doing, and counting it as either would let
 *  a run look productive by writing todo lists. */
const INERT_TOOLS = new Set(['TodoWrite', 'ExitPlanMode']);

/** A shell command that proves something: the test run, the build, the linter.
 *  Passing one is the strongest evidence of progress a trajectory can offer,
 *  and failing one repeatedly is the strongest evidence against. */
const VERIFYING = /\b(?:test|tests|vitest|jest|pytest|build|tsc|typecheck|lint|eslint|check|cargo|go\s+test|make)\b/i;

/** `Bash:git/status` — the operation, where the tool has one. */
function identity(observation: Observation): string {
  return observation.tool.operation
    ? `${observation.tool.name}:${observation.tool.operation}`
    : observation.tool.name;
}

/** What the call was *about*, for the repeat test: the same grep for the same
 *  pattern is a repeat; two greps for different things are two searches. */
function callSignature(observation: Observation): string {
  const input = observation.invocation.input ?? {};
  const salient = ['file_path', 'notebook_path', 'path', 'pattern', 'command', 'query', 'url']
    .map((key) => (typeof input[key] === 'string' ? `${key}=${input[key] as string}` : ''))
    .filter(Boolean)
    .join('|');
  return `${identity(observation)}#${salient}`;
}

function shellCommand(observation: Observation): string {
  const command = observation.invocation.input?.command;
  return typeof command === 'string' ? command : '';
}

/** How much of a list is repetition: 0 when every entry is distinct, rising
 *  towards 1 as the same thing is done over and over. */
function repetition(keys: string[]): number {
  if (keys.length <= 1) return 0;
  return 1 - new Set(keys).size / keys.length;
}

export function summarizeExecutionTrajectory(events: StructuredEvent[]): ProgressSignals {
  let observations: Observation[];
  try {
    observations = observationsFromEvents(events, 'trajectory');
  } catch {
    return { ...UNKNOWN_PROGRESS };
  }

  const counted = observations.filter((o) => !INERT_TOOLS.has(o.tool.name));
  // One tool call is not a trajectory. Judging a run on its first action is how
  // a guard kills something that had not started yet.
  if (counted.length < 3) return { ...UNKNOWN_PROGRESS };

  const searches: Observation[] = [];
  const failures: Observation[] = [];
  let productive = 0;
  let verified = 0;

  for (const observation of counted) {
    const name = observation.tool.name;
    if (!observation.execution.succeeded) failures.push(observation);

    if (WRITE_TOOLS.has(name)) { productive += 1; continue; }
    if (SEARCH_TOOLS.has(name)) { searches.push(observation); continue; }

    // Everything else is a shell command or an unrecognised tool. A verifying
    // command that passed is the strongest progress there is; one that failed
    // is not progress, but it is not searching either — it is an attempt.
    const command = shellCommand(observation);
    if (VERIFYING.test(command)) {
      if (observation.execution.succeeded) { productive += 1; verified += 1; }
      continue;
    }
    if (observation.execution.succeeded) productive += 0.5;
  }

  const total = counted.length;
  const exploration = searches.length / total;
  // Verified work counts for more than unverified work: the run that edited a
  // file and proved the edit is further along than the one that only edited.
  const progress = Math.min(1, (productive + verified * 0.5) / total);

  return {
    exploration: Math.min(1, exploration),
    progress,
    repeatedFailure: repetition(failures.map(callSignature)) * Math.min(1, failures.length / total),
    repeatedSearch: repetition(searches.map(callSignature)),
  };
}

// ---------------------------------------------------------------------------
// The fingerprint.
//
// `summarizeExecutionTrajectory` above answers "how is this run going?" from
// the whole stream. This answers a different question the same stream can
// settle: "what is this run *about* right now?" — which files, which searches,
// which failures. Two of those, compared, are what `decision/trajectory.ts`
// reads to tell a run going in circles from one working carefully in one place.
//
// Deliberately about *subjects* rather than calls. An agent re-reading one file
// at three offsets, or grepping three spellings of one symbol, is repeating
// itself and looks entirely different call-by-call; what repeats is the target.
// ---------------------------------------------------------------------------

/** The inputs that name what a call was *about*, in priority order. The first
 *  one present wins, so a `Read` is identified by its path and a `Grep` by its
 *  pattern rather than by whichever key happens to be enumerated first. */
const TARGET_KEYS = ['file_path', 'notebook_path', 'path', 'pattern', 'query', 'url', 'command'] as const;

function targetOf(observation: Observation): string {
  const input = observation.invocation.input ?? {};
  for (const key of TARGET_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** A failure's identity, stable across repetitions and distinct between
 *  different problems.
 *
 *  The tool and its subject, plus the first error-shaped line of the output.
 *  Not the whole output: a compiler error carries line numbers and a timestamp,
 *  and hashing those would make the same failure look new every time — which is
 *  precisely the case the signal exists to catch. */
function failureSignature(observation: Observation): string {
  const head = observation.raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /error|fail|exception|refused|denied|cannot|not found/i.test(line)) ?? '';
  return `${identity(observation)}#${targetOf(observation)}#${head.slice(0, 120)}`;
}

export interface SnapshotInput {
  events: StructuredEvent[];
  /** Monotonic, supplied by the caller — this module has no clock and must not
   *  acquire one, because a signal that depends on wall-clock is a signal that
   *  cannot be reproduced from the record afterwards. */
  sequence: number;
  tokensConsumed: number;
  knownEvidence?: string[];
  validationStatus?: ExecutionSnapshot['validationStatus'];
}

/** What the run is about, read off its own tool stream.
 *
 *  Total, like everything else on this path: an unreadable stream produces an
 *  empty fingerprint, and an empty fingerprint has zero overlap with anything —
 *  so a trace we cannot read can only make the orchestrator *less* willing to
 *  act, never more. */
export function executionSnapshot(input: SnapshotInput): ExecutionSnapshot {
  const base: ExecutionSnapshot = {
    sequence: input.sequence,
    tokensConsumed: Math.max(0, input.tokensConsumed),
    activeTargets: [], searchTargets: [], failureSignatures: [],
    knownEvidence: [...new Set(input.knownEvidence ?? [])],
    validationStatus: input.validationStatus ?? 'unknown',
    productiveActions: 0, totalActions: 0,
  };

  let observations: Observation[];
  try {
    observations = observationsFromEvents(input.events, 'snapshot');
  } catch {
    return base;
  }

  const counted = observations.filter((o) => !INERT_TOOLS.has(o.tool.name));
  const activeTargets = new Set<string>();
  const searchTargets = new Set<string>();
  const failureSignatures: string[] = [];
  let productive = 0;

  for (const observation of counted) {
    const name = observation.tool.name;
    const target = targetOf(observation);

    if (!observation.execution.succeeded) failureSignatures.push(failureSignature(observation));

    if (WRITE_TOOLS.has(name)) {
      // A file that was edited is where the work *is*, not where it looked.
      if (target) activeTargets.add(target);
      productive += 1;
      continue;
    }
    if (SEARCH_TOOLS.has(name)) {
      if (target) searchTargets.add(target);
      continue;
    }
    const command = shellCommand(observation);
    if (VERIFYING.test(command)) {
      if (observation.execution.succeeded) productive += 1;
      if (target) activeTargets.add(target);
      continue;
    }
    if (observation.execution.succeeded) productive += 0.5;
  }

  return {
    ...base,
    // Sorted so two snapshots of the same world are equal by value, which is
    // what makes a fingerprint comparison reproducible.
    activeTargets: [...activeTargets].sort(),
    searchTargets: [...searchTargets].sort(),
    failureSignatures,
    productiveActions: productive,
    totalActions: counted.length,
  };
}
