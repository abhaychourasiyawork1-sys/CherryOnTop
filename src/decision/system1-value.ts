/** What System-1 was worth on a run, read from the record it already leaves.
 *
 *  The decision layer already does the two things a "decision packet" would be
 *  built for: `semanticRefinementValue` asks only about the *winner*, only when
 *  answering could change which action wins (`helpfulnessMatters`), and only when
 *  the expected saving exceeds the call's own cost (meta-VOI) — at most one
 *  question per routing epoch — and every refinement is written to the log with
 *  its expected value, its actual cost and whether it moved the decision
 *  (`market.system1`).
 *
 *  What was missing was the aggregate: without it "System-1 calls per task" and
 *  "how often did asking change anything" cannot be put in a benchmark table, and
 *  a call that changed nothing is exactly the cost this layer exists to remove.
 *  Pure: a fold over events. Nothing here asks System-1 anything. */
export interface Sys1Event { type: string; payload: unknown }

export interface System1Value {
  /** Routing epochs in which the question was considered. */
  decisions: number;
  /** Of those, how many actually paid for an answer. */
  calls: number;
  skipped: number;
  callRate: number;
  costUsd: number;
  /** What the calls were expected to be worth when they were made. */
  expectedValueUsd: number;
  changedDecision: number;
  /** Calls that changed nothing: cost with no effect on the outcome. */
  avoidableCalls: number;
  avoidableRate: number;
}

export function summarizeSystem1Value(events: Sys1Event[]): System1Value {
  let decisions = 0;
  let calls = 0;
  let costUsd = 0;
  let expectedValueUsd = 0;
  let changedDecision = 0;
  let avoidableCalls = 0;
  for (const event of events) {
    if (event.type !== 'market.system1') continue;
    const p = event.payload as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') continue;
    decisions++;
    if (p.invoked !== true) continue;
    calls++;
    costUsd += typeof p.actualCostUsd === 'number' ? p.actualCostUsd : 0;
    expectedValueUsd += typeof p.valueUsd === 'number' ? p.valueUsd : 0;
    if (p.decisionChanged === true) changedDecision++;
    if (p.avoidable === true) avoidableCalls++;
  }
  return {
    decisions, calls, skipped: decisions - calls,
    callRate: decisions === 0 ? 0 : calls / decisions,
    costUsd, expectedValueUsd, changedDecision, avoidableCalls,
    avoidableRate: calls === 0 ? 0 : avoidableCalls / calls,
  };
}
