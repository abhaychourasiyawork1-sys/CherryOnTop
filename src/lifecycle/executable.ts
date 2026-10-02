/** What production can actually carry out — the mirror of `carryOut` in
 *  `node-actor-manager.ts`, kept beside it in spirit and here in code so the
 *  market and the benchmark read the same rule.
 *
 *  A candidate the runtime would only *record* (validate, constrain, a reuse
 *  the dispatch never sees) must not win the market: it displaces something
 *  that would have happened and reports an intervention that did not. Such
 *  candidates are refused as infeasible, with their price and reason kept in
 *  the decision receipt. `continue` is always executable: it is the agent
 *  carrying on. Change this together with `carryOut`. */
import type { ActionCandidate } from '../decision/actions.js';
import { partsOf } from '../governor/contracts.js';
import { DISCOVERY_ID } from '../governor/coverage.js';

function executablePart(c: ActionCandidate): boolean {
  if (c.kind === 'continue' || c.kind === 'stop' || c.kind === 'recover') return true;
  // Governor-originated advice: carried out as text the agent may ignore.
  if (typeof c.metadata.advice === 'string' && c.metadata.advice.length > 0) return true;
  // Discovery is bought and carried out inside the governor itself.
  if (c.id === DISCOVERY_ID) return true;
  return c.kind === 'acquire_evidence' && typeof c.metadata.path === 'string';
}

export function isExecutable(candidate: ActionCandidate): boolean {
  const parts = partsOf(candidate);
  // A composite is carried out as the advice of its parts; a part without
  // advice would be silently dropped, so every part must carry some.
  if (parts.length > 1) return parts.every((p) => typeof p.metadata.advice === 'string' && p.metadata.advice.length > 0);
  return executablePart(candidate);
}
