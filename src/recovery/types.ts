/** The record of a strategy that did not work.
 *
 *  Retrying is the most expensive thing a run can do and the easiest to do
 *  badly. Done badly it means starting again: the same files re-read, the same
 *  searches re-run, the same dead end walked back down — and the second attempt
 *  costs what the first did, for a worse chance, because nothing was learned.
 *
 *  A tombstone is what makes the second attempt cheaper than the first. It
 *  separates two things a failed attempt produced and that are usually thrown
 *  away together:
 *
 *   - **What it established.** The file really does contain that function; the
 *     test really does fail this way. A failed strategy does not make its
 *     observations untrue, and re-acquiring them is paying twice for the same
 *     fact.
 *   - **What it assumed.** The bug is in the parser; this config is the one
 *     being read. Those are what failed, and carrying them into the retry is
 *     how a run walks the same dead end twice.
 *
 *  Keeping the tombstone rather than the attempt is also what bounds the
 *  memory: a run that retries five times holds five small records of what was
 *  ruled out, not five transcripts. */

export interface RecoveryTombstone {
  id: string;
  /** The beliefs this attempt rested on, now disproven. */
  hypothesisIds: string[];
  /** Evidence that survives. Facts and validations: things observed rather than
   *  supposed. */
  retainedEvidenceIds: string[];
  /** Evidence that does not. Hypotheses, and anything derived from one. */
  invalidatedEvidenceIds: string[];
  /** What failed, in the stable form `decision/trajectory.ts` fingerprints
   *  failures with — so two attempts that died the same way are recognisable as
   *  such, and two that died differently are not conflated. */
  failureSignature: string;
  tokensSpent: number;
}

export interface RecoveryEvaluation {
  justified: boolean;
  /** [0,1]. How likely a retry is to get further than the attempt it follows. */
  expectedSuccessProbability: number;
  /** Tokens the retry is expected to need, net of what retained evidence saves
   *  it from re-acquiring. */
  expectedCost: number;
  retainedEvidenceIds: string[];
  invalidatedEvidenceIds: string[];
  /** Stable codes for why it came out this way. */
  reasonCodes: string[];
}
