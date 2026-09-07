/** Which events mean the organization itself changed, as opposed to the runtime
 *  narrating what it is doing.
 *
 *  This is the whole difference between a live window and a snapshot. The
 *  `exec.*` firehose is one event per chunk of runtime output and must never
 *  trigger a re-read — that would be a database query per token. But the events
 *  below change something a panel is showing, so every one of them has to.
 *
 *  `exec.result` is the subtle one: it is the *final* event of a dispatch, not
 *  part of the firehose, and it carries what the run cost. Leaving it out is why
 *  a running node's spend sat still until its state happened to change. */
const ORG_CHANGING = new Set([
  'state.transition',
  'decision.made',
  'exec.result',
  'authority.denied',
  'node.interrupted',
  'node.answer',
]);

export function changesOrg(eventType: string): boolean {
  return ORG_CHANGING.has(eventType);
}
