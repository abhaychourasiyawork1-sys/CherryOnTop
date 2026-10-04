/** H2.6 — randomized recover eligibility (bench/governor/h26/DESIGN.md).
 *
 *  At a task's first recover-eligible boundary b*, a deterministic HMAC coin
 *  decides whether recover stays on the market's menu or is withheld from it.
 *  That is all this module does. It never forces an action, never touches
 *  `continue`, never acts at any other boundary, and never feeds anything back
 *  into a runtime decision. The Economic Action Market still chooses, over the
 *  menu it is given.
 *
 *  Order at b* (§4), inside `chooseEconomicAction`'s mask hook:
 *    1. the §5 rules, on the unmasked state and menu
 *    2. the menu priced once, unmasked (done by the market before the hook)
 *    3. snapshotDigest, W, recover's rank and margin, from that pricing alone
 *    4. u(τ) and Z(τ)
 *    5. one complete, immutable record, written atomically
 *    6. only after the commit: if masked, recover is refused, and the market
 *       chooses among the rest. */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Db } from '../db/client.js';
import type { ActionCandidate } from '../decision/actions.js';
import type { UnmaskedMenu, UnmaskedEntry, EconomicDecisionInput } from '../decision/engine.js';
import type { EconomicState } from '../decision/state.js';
import { usdPerToken } from '../decision/utility.js';
import { partsOf } from '../governor/contracts.js';
import { commitmentDepth } from '../governor/risk.js';
import { statePattern } from '../governor/memory.js';
import { governorVariantFromEnv } from '../governor/governor.js';
import { candidateFingerprint } from '../decision/transition.js';
import { isExecutable } from '../lifecycle/executable.js';
import { recoverIneligibility } from '../lifecycle/boundary-eligibility.js';
import { appendEvent } from '../db/queries/events.js';
import { openLedger, type Ledger, type LedgerRow } from './ledger.js';
import { checkBuildIntegrity, systemIntegrityDeps, sha256, type IntegrityDeps, type IntegrityVerdict } from './build-integrity.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ExperimentConfig {
  experimentId: string;
  phase: 'pilot' | 'main';
  epsilon: number;
  hmacPrefix: string;
  keyCommitment: string | null;
  nMax: number;
  cMask: number;
  /** The annotated tag the build must be (`h26-prereg` for the experiment). */
  preregTag: string;
}

/** The design fixes these; a config that differs is not this experiment. */
export const H26 = { epsilon: 0.5, hmacPrefix: 'h26-recover-eligibility-v1', nMax: 3035, cMask: 3400 } as const;

export function parseConfig(raw: unknown): ExperimentConfig {
  const c = raw as Record<string, unknown>;
  const fail = (what: string): never => { throw new Error(`h26 config: ${what}`); };
  if (typeof c?.experimentId !== 'string' || !c.experimentId) fail('experimentId');
  if (c.phase !== 'pilot' && c.phase !== 'main') fail('phase must be pilot or main');
  if (c.epsilon !== H26.epsilon) fail('epsilon must be 0.5');
  if (c.hmacPrefix !== H26.hmacPrefix) fail('hmacPrefix');
  if (c.nMax !== H26.nMax) fail('nMax must be 3035');
  if (c.cMask !== H26.cMask) fail('cMask must be 3400');
  if (c.keyCommitment !== null && !(typeof c.keyCommitment === 'string' && /^[0-9a-f]{64}$/.test(c.keyCommitment))) fail('keyCommitment');
  const preregTag = c.preregTag ?? 'h26-prereg';
  if (typeof preregTag !== 'string' || !/^h26-[a-z0-9-]+$/.test(preregTag)) fail('preregTag');
  return {
    experimentId: c.experimentId as string, phase: c.phase as ExperimentConfig['phase'], epsilon: H26.epsilon,
    hmacPrefix: H26.hmacPrefix, keyCommitment: (c.keyCommitment as string | null) ?? null, nMax: H26.nMax, cMask: H26.cMask,
    preregTag: preregTag as string,
  };
}

/** The running experiment. `ORG_EXPERIMENT=off` is the kill switch: an
 *  experiment task started with it set assigns nothing (DESIGN.md §5). */
export interface ActiveExperiment {
  config: ExperimentConfig;
  /** The experiment's shared ledger (assignments, masked count, stops). */
  ledger: Ledger;
  /** Re-run before every assignment (§4); must agree with the start-up
   *  verdict. Injectable for tests. */
  integrity: () => IntegrityVerdict;
  /** The key bytes; read only after the integrity checks pass. */
  key: () => Buffer;
}

/** The repository the *running* code was built from: dist/experiment/ → ../..
 *  Never taken from the environment, so a modified build cannot point the
 *  checks at a pristine checkout. */
export const RUNNING_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The tagged-build verdict taken when this module loaded, i.e. when the
 *  daemon started (§4 "at start-up"). Every per-assignment recheck must reach
 *  the same build fingerprint, so a dist/ swapped under a running daemon is
 *  refused. Null when no experiment is configured. */
let startupVerdict: IntegrityVerdict | null = null;
function integrityFor(configPath: string, keyFile: string | undefined): IntegrityVerdict {
  try {
    return checkBuildIntegrity(systemIntegrityDeps(RUNNING_REPO_ROOT, configPath, keyFile));
  } catch (err) {
    return { ok: false, check: 'tagged-commit', detail: `integrity check failed: ${String(err)}` };
  }
}
// The tag name is in the config; read it the same way the per-assignment check will.
if (process.env.ORG_EXPERIMENT_CONFIG && process.env.ORG_EXPERIMENT !== 'off') {
  startupVerdict = integrityFor(process.env.ORG_EXPERIMENT_CONFIG, process.env.ORG_EXPERIMENT_KEY_FILE);
}

let ledgers = new Map<string, Ledger>();

/** The experiment this process runs, 'off' under the kill switch, or null
 *  when none is configured. Refuses (throws) when configured unsafely: no
 *  ledger, or a governor variant whose market can run twice per boundary
 *  (discovery, composition, proposals), which the once-per-boundary mask
 *  does not cover. */
export function experimentFromEnv(env: NodeJS.ProcessEnv = process.env): ActiveExperiment | 'off' | null {
  const configPath = env.ORG_EXPERIMENT_CONFIG;
  if (!configPath) return null;
  if (env.ORG_EXPERIMENT === 'off') return 'off';
  const config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  const ledgerPath = env.ORG_EXPERIMENT_LEDGER;
  if (!ledgerPath) throw new Error('h26: ORG_EXPERIMENT_LEDGER is not set');
  const features = governorVariantFromEnv().features;
  if (features && (features.discovery || features.composition || features.proposals)) {
    throw new Error('h26: the governor variant runs discovery/composition/proposals; the experiment requires a single market run per boundary');
  }
  let ledger = ledgers.get(ledgerPath);
  if (!ledger) { ledger = openLedger(ledgerPath); ledgers.set(ledgerPath, ledger); }
  const keyFile = env.ORG_EXPERIMENT_KEY_FILE;
  return {
    config, ledger,
    integrity: () => {
      const now = integrityFor(configPath, keyFile);
      if (!startupVerdict) return { ok: false, check: 'tagged-commit', detail: 'no start-up verdict: the experiment was not configured when the daemon started' };
      if (!startupVerdict.ok) return startupVerdict;
      if (now.ok && now.fingerprints.buildFingerprint !== startupVerdict.fingerprints.buildFingerprint) {
        return { ok: false, check: 'build-fingerprint', detail: 'dist/ changed since the daemon started' };
      }
      return now;
    },
    key: () => Buffer.from(readFileSync(keyFile!, 'utf8').trim(), 'hex'),
  };
}

/** For tests: reset the module's process-level state. */
export function __resetForTests(): void {
  for (const l of ledgers.values()) l.close();
  ledgers = new Map();
  writeFailedInProcess.clear();
}

// ---------------------------------------------------------------------------
// The coin
// ---------------------------------------------------------------------------

const TWO_POW_63 = 1n << 63n;

/** h(τ) = HMAC-SHA256(key, prefix ‖ 0x00 ‖ τ); u = first 8 bytes big-endian
 *  / 2^64; masked iff u < ε. With ε = 0.5 that is exactly "the 64-bit
 *  integer is below 2^63", compared as an integer so no rounding can move a
 *  task across the line; u is reported, never compared. */
export function assign(key: Buffer, rootTaskId: string, prefix: string = H26.hmacPrefix, epsilon: number = H26.epsilon): {
  message: string; u: number; u64: string; z: 'masked' | 'available';
} {
  if (epsilon !== 0.5) throw new Error('h26: ε is 0.5');
  const message = Buffer.concat([Buffer.from(prefix, 'utf8'), Buffer.from([0x00]), Buffer.from(rootTaskId, 'utf8')]);
  const h = createHmac('sha256', key).update(message).digest();
  const u64 = h.readBigUInt64BE(0);
  return { message: message.toString('hex'), u: Number(u64) / 2 ** 64, u64: u64.toString(), z: u64 < TWO_POW_63 ? 'masked' : 'available' };
}

// ---------------------------------------------------------------------------
// The unmasked snapshot
// ---------------------------------------------------------------------------

/** JSON with object keys sorted at every level: one byte string per value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Recover, alone or inside a composite: every candidate that would carry it out. */
export function carriesRecover(candidate: ActionCandidate): boolean {
  return partsOf(candidate).some((p) => p.kind === 'recover');
}

function snapshotEntry(e: UnmaskedEntry) {
  return {
    id: e.candidate.id, kind: e.candidate.kind, capability: e.candidate.capability,
    fingerprint: candidateFingerprint(e.candidate), feasible: e.feasible,
    expectedCostUsd: e.expectedCostUsd, conservativeCostUsd: e.conservativeCostUsd,
    successLowerBound: e.successLowerBound, confidence: e.confidence, provenance: e.provenance,
    reasonCodes: [...e.reasonCodes].sort(),
  };
}

/** The unmasked priced menu as recorded: enough to recompute W, rank and
 *  margin offline, and what the digest is taken over. */
export function snapshotEntries(menu: UnmaskedMenu) {
  return menu.entries.map(snapshotEntry).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function snapshotDigest(menu: UnmaskedMenu): string {
  return createHash('sha256').update(canonicalJson(snapshotEntries(menu))).digest('hex');
}

/** W, recover's rank among feasible candidates and its margin over continue,
 *  from the unmasked pricing alone (§3, §4 step 3). */
export function wouldSelect(menu: UnmaskedMenu): { W: boolean; rank: number | null; marginUsd: number | null; marginShare: number | null } {
  const order = menu.feasibleInOrder;
  const at = order.findIndex((e) => carriesRecover(e.candidate));
  const cont = menu.entries.find((e) => e.candidate.kind === 'continue');
  const best = at >= 0 ? order[at] : null;
  const marginUsd = best && cont ? cont.conservativeCostUsd - best.conservativeCostUsd : null;
  const budgetUsd = menu.state.resources.totalTokenBudget * usdPerToken(menu.state);
  return {
    W: at === 0, rank: at >= 0 ? at + 1 : null, marginUsd,
    marginShare: marginUsd !== null && budgetUsd > 0 ? marginUsd / budgetUsd : null,
  };
}

// ---------------------------------------------------------------------------
// §5 rules
// ---------------------------------------------------------------------------

export interface BoundaryFacts {
  db: Db;
  nodeId: string;
  rootTaskId: string;
  state: EconomicState;
  /** Execute dispatches this node has finished. */
  completedDispatches: number;
  /** The failure signature the boundary snapshot holds, or null. */
  failureSignature: string | null;
  /** Total turns this node has spent, for the D2 diagnostics. */
  turnsUsed: number;
  /** The boundary only runs after the spend guard let the dispatch proceed;
   *  passed explicitly so the rule is checked, not assumed. */
  spendHardStop: boolean;
  nowIso?: () => string;
}

/** The first §5 rule a boundary fails, or null when it is recover-eligible. */
export function eligibilityFailure(facts: BoundaryFacts, menu: UnmaskedMenu): string | null {
  const candidates = menu.entries.map((e) => e.candidate);
  const d1 = recoverIneligibility({ state: facts.state, completedDispatches: facts.completedDispatches, failureSignature: facts.failureSignature, candidates });
  if (d1) return d1;
  const recovers = candidates.filter(carriesRecover);
  if (!recovers.every(isExecutable)) return 'executable';
  // Reversible: recover's carry-out (`carryOutRecovery`) writes a tombstone and
  // guidance text and changes no workspace state. Holds for every candidate
  // whose parts are all recover or advice.
  if (!recovers.every((c) => partsOf(c).every((p) => p.kind === 'recover' || typeof p.metadata.advice === 'string'))) return 'reversible';
  if (facts.state.constraints.hardStop || facts.spendHardStop) return 'never-under-a-hard-stop';
  if (commitmentDepth(facts.state) >= 0.5) return 'never-in-an-irreversible-state';
  // Masking must leave a feasible non-recover path forward (continue, or any
  // other feasible intervention): the next dispatch, and the validation that
  // follows it, must stay reachable.
  if (!menu.entries.some((e) => e.feasible && !carriesRecover(e.candidate))) return 'never-the-sole-required-validation-path';
  return null;
}

// ---------------------------------------------------------------------------
// The per-boundary mask
// ---------------------------------------------------------------------------

export type BoundaryRole =
  | { role: 'none' }
  | { role: 'bstar'; z: 'masked' | 'available'; record: Record<string, unknown> }
  | { role: 'later' | 'excluded' | 'refused' | 'not_enrolled'; reason: string };

type Mask = { refuse: string[]; reason: string } | null;

/** A failure on the assignment path stops assignment for the life of this
 *  process even when the ledger itself could not record the stop. */
const writeFailedInProcess = new Set<string>();

/** The fields that *are* the assignment. A re-evaluation of b* (after a crash)
 *  must reproduce these exactly; the snapshot-derived fields (W, digest,
 *  margin) are recorded once, at the first evaluation, and are authoritative
 *  from then on — a re-evaluation rebuilds in-memory trajectory and risk state
 *  and is not expected to price identically. */
export const ASSIGNMENT_IDENTITY = ['experimentId', 'phase', 'rootTaskId', 'boundaryKey', 'preregTag', 'hmacMessage', 'u64', 'Z', 'buildFingerprint'] as const;
const identityOf = (rec: Record<string, unknown>) => canonicalJson(Object.fromEntries(ASSIGNMENT_IDENTITY.map((k) => [k, rec[k]])));

/** A fresh mask for one boundary evaluation. With a single market run per
 *  boundary (enforced by `experimentFromEnv`) the hook is called once; a
 *  repeated call answers the same. */
export function boundaryMask(experiment: ActiveExperiment | 'off', facts: BoundaryFacts): {
  mask: NonNullable<EconomicDecisionInput['experimentMask']>;
  outcome: () => BoundaryRole;
  /** Milliseconds this boundary spent in the experiment path. */
  elapsedMs: () => number;
} {
  let decided: Mask | undefined;
  let role: BoundaryRole = { role: 'none' };
  let elapsed = 0;
  const now = facts.nowIso ?? (() => new Date().toISOString());
  const boundaryKey = `${facts.nodeId}#${facts.state.version}`;
  const log = (type: string, payload: Record<string, unknown>) => {
    try {
      appendEvent(facts.db, { nodeId: facts.nodeId, type, createdAt: now(), payload });
    } catch { /* logging must not break the boundary */ }
  };

  const decide = (menu: UnmaskedMenu): Mask => {
    const recovers = menu.entries.filter((e) => carriesRecover(e.candidate));
    if (recovers.length === 0) return null;
    const base = {
      rootTaskId: facts.rootTaskId, nodeId: facts.nodeId, stateVersion: facts.state.version,
      recoverCandidates: recovers.map((e) => e.candidate.id),
    };
    if (experiment === 'off') {
      role = { role: 'refused', reason: 'kill_switch' };
      log('experiment.boundary', { ...base, role: 'refused', reason: 'kill_switch' });
      return null;
    }
    const { config, ledger } = experiment;
    const ids = { experimentId: config.experimentId, phase: config.phase };
    const refuseWith = (r: BoundaryRole & { reason: string }, extra: Record<string, unknown> = {}): Mask => {
      role = r;
      log('experiment.boundary', { ...ids, ...base, role: r.role, reason: r.reason, ...extra });
      return null;
    };
    const masked = (z: 'masked' | 'available', stored: Record<string, unknown>): Mask => {
      role = { role: 'bstar', z, record: stored };
      return z === 'masked' ? { refuse: recovers.map((e) => e.candidate.id), reason: 'experiment:masked' } : null;
    };
    const stopAll = (reason: string, detail: string) => {
      writeFailedInProcess.add(config.experimentId);
      try { ledger.stop(config.experimentId, reason, detail, now()); } catch { /* the process flag still holds */ }
    };
    const recordFor = (verdict: Extract<IntegrityVerdict, { ok: true }>) => {
      const sel = wouldSelect(menu);
      const coin = assign(experiment.key(), facts.rootTaskId, config.hmacPrefix, config.epsilon);
      return {
        experimentId: config.experimentId, phase: config.phase, preregTag: config.preregTag,
        buildCommit: verdict.commit, ...verdict.fingerprints,
        rootTaskId: facts.rootTaskId, nodeId: facts.nodeId, stateVersion: facts.state.version, boundaryKey,
        unmaskedSnapshot: snapshotEntries(menu), snapshotDigest: snapshotDigest(menu),
        W: sel.W, recoverRank: sel.rank, marginUsd: sel.marginUsd, marginShare: sel.marginShare,
        hmacMessage: coin.message, u: coin.u, u64: coin.u64, epsilon: config.epsilon, Z: coin.z,
        recoverCandidates: recovers.map((e) => ({
          id: e.candidate.id, kind: e.candidate.kind, capability: e.candidate.capability, fingerprint: candidateFingerprint(e.candidate),
        })),
        stateSignature: statePattern(facts.state),
        regime: `${facts.state.trajectory.failurePressure > 0 ? 'failing' : 'steady'}|${facts.state.validation.status}`,
        progressPhase: statePattern(facts.state).split('|')[1],
        completedDispatchesToBstar: facts.completedDispatches, turnsUsedAtBstar: facts.turnsUsed,
      };
    };
    // b* evaluated again (a crash after commit, or a concurrent evaluation of
    // the same boundary): the stored record *is* the assignment and its Z is
    // always honoured. An assignment-identity mismatch is fatal for the
    // experiment: all further assignment stops.
    const honour = (stored: LedgerRow): Mask => {
      const verdict = experiment.integrity();
      if (!verdict.ok) {
        log('experiment.boundary', { ...ids, ...base, role: 'integrity_stop', reason: `recheck_refused:${verdict.check}` });
        stopAll(`recheck_refused:${verdict.check}`, verdict.detail);
      } else if (identityOf(recordFor(verdict)) !== identityOf(JSON.parse(stored.record))) {
        log('experiment.boundary', { ...ids, ...base, role: 'integrity_stop', reason: 'differing_assignment_for_bstar' });
        stopAll('differing_assignment_for_bstar', boundaryKey);
      }
      return masked(stored.z, JSON.parse(stored.record));
    };

    // Already enrolled: the same boundary again, or a later one.
    const existing = ledger.get(config.experimentId, config.phase, facts.rootTaskId);
    if (existing) {
      if (existing.boundaryKey === boundaryKey) return honour(existing);
      return refuseWith({ role: 'later', reason: 'after_bstar' });
    }
    const stopReason = writeFailedInProcess.has(config.experimentId) ? 'integrity_stop' : ledger.stopped(config.experimentId);
    if (stopReason) return refuseWith({ role: 'refused', reason: 'integrity_stop' }, { stop: stopReason });
    // Step 1: the §5 rules, on the unmasked state and menu.
    const rule = eligibilityFailure(facts, menu);
    if (rule) return refuseWith({ role: 'excluded', reason: `excluded:${rule}` });
    if (config.phase === 'main' && ledger.countMasked(config.experimentId, 'main') >= config.cMask) {
      return refuseWith({ role: 'refused', reason: 'c_mask' });
    }
    // §4: the tagged-build invariant, before every assignment.
    const verdict = experiment.integrity();
    if (!verdict.ok) return refuseWith({ role: 'refused', reason: `refused:${verdict.check}` }, { detail: verdict.detail });

    // Steps 3–4: from the unmasked pricing alone, then the coin.
    const record = recordFor(verdict);
    const canonical = canonicalJson(record);
    // Step 5: one complete record, atomically, in the shared ledger.
    const row: LedgerRow = {
      experimentId: config.experimentId, phase: config.phase, rootTaskId: facts.rootTaskId, boundaryKey,
      z: record.Z, record: canonical, recordSha256: sha256(canonical), createdAt: now(),
    };
    const written = ledger.insert(row);
    if (written.kind === 'conflict') {
      // Another evaluation enrolled the task first; its boundary is b*.
      if (written.existing.boundaryKey !== boundaryKey) return refuseWith({ role: 'later', reason: 'lost_race_to_bstar' });
      return honour(written.existing);
    }
    if (written.kind === 'failed') {
      // No valid record: not enrolled, no mask, and all assignment stops.
      stopAll('write_failure', written.error);
      role = { role: 'not_enrolled', reason: 'write_failure' };
      log('experiment.write_failure', { ...ids, ...base, error: written.error });
      return null;
    }
    // Step 6, after the commit. The run's own event stream gets a copy.
    log('experiment.assignment', record);
    return masked(row.z, record);
  };

  const mask = (menu: UnmaskedMenu) => {
    if (decided !== undefined) return decided;
    const started = performance.now();
    try {
      decided = decide(menu);
    } catch (err) {
      // Anything failing on the assignment path before a record committed (a
      // key read, a ledger read): no valid record, so no enrolment and no
      // mask; the boundary runs unmasked and assignment stops.
      decided = null;
      if (experiment !== 'off') {
        const detail = String((err as Error)?.message ?? err);
        writeFailedInProcess.add(experiment.config.experimentId);
        try { experiment.ledger.stop(experiment.config.experimentId, 'assignment_error', detail, now()); } catch { /* flag holds */ }
        role = { role: 'not_enrolled', reason: 'assignment_error' };
        log('experiment.write_failure', {
          experimentId: experiment.config.experimentId, phase: experiment.config.phase, rootTaskId: facts.rootTaskId,
          nodeId: facts.nodeId, stateVersion: facts.state.version, kind: 'assignment_error', error: detail,
        });
      }
    } finally {
      elapsed += performance.now() - started;
    }
    return decided;
  };
  return { mask, outcome: () => role, elapsedMs: () => elapsed };
}

export { sha256 };
export type { IntegrityDeps };
