/** Where a run is going, read off two snapshots of where it was.
 *
 *  The signal this exists to get right is the one every "is the agent stuck?"
 *  heuristic gets wrong. A run that greps twenty times and reads ten files is
 *  either an investigation doing its job or an agent lost in a repository, and
 *  *no count distinguishes them*. `searchCount > N` cannot: the productive
 *  investigation searches more, not less. Turn counts cannot: this repository's
 *  most expensive measured run took 42 turns and was genuinely working, while
 *  the 19-turn run before it was not.
 *
 *  What distinguishes them is whether the ground being covered is *new*. So the
 *  comparison is between two fingerprints of the run's world — which files it
 *  is in, what it is searching for, what is failing, what it knows, whether
 *  anything has been proven — and the two numbers that fall out are how much
 *  those overlap (`stateSimilarity`) and how much was learned
 *  (`informationGain`).
 *
 *  Similarity beyond information gain is the pathology. Similarity *with*
 *  information gain is careful work in one place, and must stay viable. */
import { clamp01 } from '../efficiency/policy-types.js';

/** `max(0, a - b)`, clamped.
 *
 *  The shape every pathology signal in this architecture takes, defined once.
 *  A difference reaches exactly zero when two dimensions agree, which is what
 *  lets a healthy run report *nothing* rather than a small number that then
 *  needs an arbitrary noise floor to suppress. */
export function signalGap(a: number, b: number): number {
  return clamp01(Math.max(0, a - b));
}

/** A fingerprint of the run's world at one moment.
 *
 *  Deliberately not "the last N tool calls". Exact call repetition is one way a
 *  run goes in circles and not the interesting one — an agent re-reading the
 *  same file with a different offset, or grepping three spellings of the same
 *  symbol, is just as stuck and looks completely different call-by-call. What
 *  repeats in that case is the *subject*, which is what these sets capture. */
export interface ExecutionSnapshot {
  /** Monotonic, so two snapshots can be ordered without a clock. */
  sequence: number;
  /** Tokens the task had consumed when this was taken. */
  tokensConsumed: number;
  /** Paths and symbols the run is working in. */
  activeTargets: string[];
  /** What it is looking for — patterns, queries, symbol names — rather than
   *  which tool was used to look. */
  searchTargets: string[];
  /** Stable signatures of what is failing, so two different errors read as two
   *  problems and the same error twice reads as one. */
  failureSignatures: string[];
  /** Evidence the run holds. The denominator of "did we learn anything?". */
  knownEvidence: string[];
  validationStatus: 'unknown' | 'pending' | 'passed' | 'failed';
  /** Actions that produced something durable: an edit, a command that ran
   *  green. */
  productiveActions: number;
  /** Every action counted, productive or not. */
  totalActions: number;
}

export const EMPTY_SNAPSHOT: ExecutionSnapshot = {
  sequence: 0, tokensConsumed: 0, activeTargets: [], searchTargets: [],
  failureSignatures: [], knownEvidence: [], validationStatus: 'unknown',
  productiveActions: 0, totalActions: 0,
};

export interface TrajectorySnapshot {
  progress: number;
  informationGain: number;
  explorationPressure: number;
  failurePressure: number;
  stateSimilarity: number;
  /** Tokens spent per action taken since the previous snapshot. A rate with
   *  units, deliberately not normalized to [0,1]: "this interval cost 4,000
   *  tokens an action" is a fact a reader can act on, and squashing it into a
   *  fraction of something would lose the magnitude that makes it actionable. */
  costVelocity: number;
}

/** Overlap between two sets, on [0,1]. Jaccard: shared over combined.
 *
 *  Empty on both sides is *not* similar — it is unknown — and answering 1 there
 *  would make a run that has done nothing look like a run repeating itself.
 *  Zero is the honest answer, and zero cannot trip anything. */
function overlap(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** What fraction of what is now known was not known before.
 *
 *  Against the *current* total rather than the previous one, so a run that
 *  knew nothing and now knows three things scores 1 rather than dividing by
 *  zero. */
function learned(previous: string[], current: string[]): number {
  const before = new Set(previous);
  const now = [...new Set(current)];
  if (now.length === 0) return 0;
  return now.filter((id) => !before.has(id)).length / now.length;
}

/** How much of this interval was the same failure over again.
 *
 *  Repetition among failures, weighted by how much of the interval was failing
 *  at all: two distinct failures are a run working through problems, the same
 *  one ten times is a loop, and one failure in a hundred actions is neither. */
function repeatedFailure(previous: ExecutionSnapshot, current: ExecutionSnapshot, newActions: number): number {
  const signatures = current.failureSignatures;
  if (signatures.length === 0) return 0;
  const distinct = new Set(signatures).size;
  const repetition = 1 - distinct / signatures.length;
  // A failure that was already there and is still there is the strongest form
  // of the same evidence: it survived whatever the run did in between.
  const persisted = overlap(previous.failureSignatures, signatures);
  const density = newActions <= 0 ? 1 : Math.min(1, signatures.length / newActions);
  return clamp01(Math.max(repetition, persisted) * density);
}

/** The trajectory between two snapshots.
 *
 *  Deterministic, total, and a pure function of its two arguments — no clock,
 *  no I/O, no model. Snapshots that arrive out of order are compared as given
 *  rather than rejected: a caller with a stale snapshot gets a reading about
 *  the interval it named, which is the honest answer to the question it asked. */
export function compareTrajectory(previous: ExecutionSnapshot, current: ExecutionSnapshot): TrajectorySnapshot {
  const prev = { ...EMPTY_SNAPSHOT, ...previous };
  const now = { ...EMPTY_SNAPSHOT, ...current };

  const newActions = Math.max(0, now.totalActions - prev.totalActions);
  const newProductive = Math.max(0, now.productiveActions - prev.productiveActions);
  const newTokens = Math.max(0, now.tokensConsumed - prev.tokensConsumed);

  // Progress over the *interval* when there was one, and over the run as a
  // whole when nothing happened in between — otherwise a decision cycle that
  // fires twice between two tool calls would read as a run that stopped
  // producing.
  const progress = newActions > 0
    ? newProductive / newActions
    : (now.totalActions > 0 ? now.productiveActions / now.totalActions : 0);

  const informationGain = learned(prev.knownEvidence, now.knownEvidence);

  // Exploration is measured against what the run is *doing*, not against a
  // target: searching is how work gets done, and a share is a description
  // rather than a verdict. `signalGap(explorationPressure, informationGain)` is
  // where it becomes one, and only in the layer that is allowed to judge.
  const searched = Math.max(0, now.searchTargets.length - prev.searchTargets.length);
  const explorationPressure = newActions > 0
    ? clamp01(searched / newActions)
    : clamp01(now.totalActions > 0 ? now.searchTargets.length / now.totalActions : 0);

  // The fingerprint: what the run is in, what it is looking for, what is
  // breaking. Compared as one set rather than three, because a run that moved
  // from failing in file A to searching for symbols in file A has not moved.
  const stateSimilarity = overlap(
    [...prev.activeTargets, ...prev.searchTargets, ...prev.failureSignatures],
    [...now.activeTargets, ...now.searchTargets, ...now.failureSignatures],
  );

  return {
    progress: clamp01(progress),
    informationGain: clamp01(informationGain),
    explorationPressure,
    failurePressure: repeatedFailure(prev, now, newActions),
    stateSimilarity,
    costVelocity: newActions > 0 ? newTokens / newActions : newTokens,
  };
}

/** Repetition that produced nothing.
 *
 *  The one derived verdict this module offers, and the reason the two terms are
 *  kept separate everywhere else: high similarity is not a problem, high
 *  similarity *beyond* what was learned is. A run reading the same file
 *  repeatedly and learning from it every time scores exactly zero here, which
 *  is what "productive exploration stays viable" means in code. */
export function unproductiveRepetition(snapshot: TrajectorySnapshot): number {
  return signalGap(snapshot.stateSimilarity, snapshot.informationGain);
}
