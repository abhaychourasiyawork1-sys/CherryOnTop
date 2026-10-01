/** What the governor has learned about intervening — not about the code.
 *
 *  Evidence memory (`evidence/store.ts`) remembers facts about a repository.
 *  This remembers *decisions*: which intervention, in which state pattern, at
 *  what timing, avoided how much loss, and how sure we are of that. Three
 *  structures, all bounded, all derived from compact records:
 *
 *   - **causal experiences** with FOUND / NOT_FOUND / RULED_OUT and revision
 *     provenance, so a known dead end is not explored again and a stale
 *     finding about a different revision cannot pose as a current one;
 *   - **action motifs** — pairs of interventions that helped together in a
 *     state pattern, kept top-K per pattern, decayed with age, evicted when
 *     their marginal value is negligible. A motif is a *conditional* prior
 *     P(beneficial | pattern) that makes a candidate cheap to propose; it is
 *     never an "always do this";
 *   - **calibration** of the governor's own probabilities, by estimator
 *     provenance, capability, regime and bucket.
 *
 *  Learning weights follow evidence strength: a validated counterfactual
 *  (replay) moves beliefs fully, a supported one (historical estimate with an
 *  interval excluding zero) partially, a weak one (post-hoc association) a
 *  little. An LLM is never asked whether something caused something. */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memory as memoryTable } from '../db/schema.js';
import { clamp01 } from '../efficiency/policy-types.js';
import type { EconomicState, UncertaintyKind } from '../decision/state.js';
import { UNCERTAINTY_KINDS } from '../decision/uncertainty.js';
import type { PreventionTiming } from './risk.js';

export type EvidenceLevel = 'weak' | 'supported' | 'validated';
export type ExperienceStatus = 'FOUND' | 'NOT_FOUND' | 'RULED_OUT';

/** Pseudo-observations one record is worth, by how it was established. */
export const EVIDENCE_WEIGHT: Record<EvidenceLevel, number> = { weak: 0.25, supported: 0.6, validated: 1 };
const LEVEL_RANK: Record<EvidenceLevel, number> = { weak: 0, supported: 1, validated: 2 };

export interface CausalExperience {
  id: string;
  /** Coarse state pattern (`statePattern`), the unit learning pools over. */
  statePattern: string;
  unresolvedUncertainty: UncertaintyKind[];
  /** Fingerprint of the intervention this is about. */
  intervention: string;
  addresses: UncertaintyKind[];
  timing: PreventionTiming | 'post_hoc';
  observedFailureRisk: number;
  /** Tokens of downstream loss the intervention avoided (negative: it cost). */
  lossAvoided: number;
  interventionCost: number;
  /** Signed effect on P(failure): positive means it helped. */
  preventionEffect: number;
  optionEffect: number;
  evidenceLevel: EvidenceLevel;
  confidence: number;
  status: ExperienceStatus;
  repository: string | null;
  repositoryRevision: string | null;
  /** Monotonic task sequence number; recency without a clock. */
  sequence: number;
  taskId: string;
}

/** The pattern learning pools over: which doubt dominates, how far along the
 *  run is, whether it is failing, and validation status. Coarse on purpose — a
 *  benchmark of a hundred tasks cannot fill a fine grid, and an empty cell
 *  teaches nothing. */
export function statePattern(state: Pick<EconomicState, 'uncertainty' | 'trajectory' | 'validation'>): string {
  const u = state.uncertainty;
  const top = UNCERTAINTY_KINDS.reduce((best, k) => (u[k] > u[best] ? k : best), 'target' as UncertaintyKind);
  const phase = state.trajectory.progress < 0.34 ? 'early' : state.trajectory.progress < 0.67 ? 'mid' : 'late';
  const failing = state.trajectory.failurePressure > 0 ? 'failing' : 'steady';
  return `${top}|${phase}|${failing}|${state.validation.status}`;
}

/** The pattern one level up, for shrinkage when the exact one is thin. */
export function coarsePattern(pattern: string): string {
  const [top, phase] = pattern.split('|');
  return `${top}|${phase}`;
}

export interface ExperienceStore {
  put(experience: CausalExperience): void;
  all(): CausalExperience[];
}

export function memoryExperienceStore(): ExperienceStore {
  const rows: CausalExperience[] = [];
  return { put: (e) => { rows.push(structuredClone(e)); }, all: () => rows.map((e) => structuredClone(e)) };
}

export const EXPERIENCE_KIND = 'causal_experience';

export function dbExperienceStore(db: Db): ExperienceStore {
  return {
    put(e) {
      db.insert(memoryTable).values({
        id: e.id, kind: EXPERIENCE_KIND, key: e.statePattern, value: e,
        confidence: e.confidence, nodeId: e.taskId, createdAt: new Date().toISOString(),
      }).onConflictDoNothing().run();
    },
    all() {
      return db.select().from(memoryTable).where(eq(memoryTable.kind, EXPERIENCE_KIND)).all()
        .map((row) => row.value as CausalExperience);
    },
  };
}

// ---------------------------------------------------------------------------
// The model learned from experiences
// ---------------------------------------------------------------------------

/** Older experience counts for less: weight halves every this many tasks. */
export const EXPERIENCE_HALF_LIFE_TASKS = 50;

interface Beta { a: number; b: number }

export interface CausalModel {
  /** P(this intervention helps | pattern), shrunk exact → coarse → global. */
  benefit(pattern: string, intervention: string): { mean: number; n: number };
  /** How well an intervention removes doubt in one dimension, relative to what
   *  it declares (1 = as declared). */
  effectiveness(intervention: string, kind: UncertaintyKind): number;
  /** Times a state like this has been seen. */
  seen(pattern: string): number;
  /** Shrunk rate of confirmed candidate-space misses in this pattern. */
  generationMissRate(pattern: string): number;
  /** Interventions ruled out for this pattern at this revision. */
  ruledOut(pattern: string, revision: string | null): Set<string>;
  /** What memory recommends here, best first. */
  recommended(pattern: string, limit: number): string[];
  experiences: number;
}

/** Prior pseudo-counts: one success and one failure. Neutral and weak. */
const PRIOR: Beta = { a: 1, b: 1 };
/** How many observations a level needs before it outweighs its parent. */
const SHRINKAGE = 4;

function shrink(child: Beta, parent: { mean: number }): { mean: number; n: number } {
  const n = child.a + child.b - PRIOR.a - PRIOR.b;
  const own = child.a / (child.a + child.b);
  const w = n / (n + SHRINKAGE);
  return { mean: w * own + (1 - w) * parent.mean, n };
}

/** Which records count: for one (pattern, intervention, repository), a newer
 *  record at the same or a stronger evidence level supersedes every older one
 *  at a weaker-or-equal level that disagrees with it. Stale evidence cannot
 *  override newer evidence; it can only be outweighed by it. */
export function effectiveExperiences(experiences: CausalExperience[]): CausalExperience[] {
  const sorted = [...experiences].sort((x, y) => y.sequence - x.sequence);
  const keep: CausalExperience[] = [];
  const strongest = new Map<string, { rank: number; helped: boolean }>();
  for (const e of sorted) {
    const key = `${e.statePattern}|${e.intervention}|${e.repository ?? '-'}`;
    const helped = e.status === 'FOUND' && e.preventionEffect > 0;
    const newer = strongest.get(key);
    if (newer && newer.rank >= LEVEL_RANK[e.evidenceLevel] && newer.helped !== helped) continue;
    keep.push(e);
    if (!newer || LEVEL_RANK[e.evidenceLevel] > newer.rank) strongest.set(key, { rank: LEVEL_RANK[e.evidenceLevel], helped });
  }
  return keep;
}

export function buildCausalModel(experiences: CausalExperience[], currentSequence = Number.POSITIVE_INFINITY): CausalModel {
  const effective = effectiveExperiences(experiences);
  const latest = Number.isFinite(currentSequence) ? currentSequence : Math.max(0, ...effective.map((e) => e.sequence));
  const decay = (e: CausalExperience) => 0.5 ** (Math.max(0, latest - e.sequence) / EXPERIENCE_HALF_LIFE_TASKS);

  const exact = new Map<string, Beta>();
  const coarse = new Map<string, Beta>();
  const global = new Map<string, Beta>();
  const effect = new Map<string, { sum: number; w: number }>();
  const seenCount = new Map<string, number>();
  const missByPattern = new Map<string, { miss: number; n: number }>();
  const ruled = new Map<string, Set<string>>();

  const add = (map: Map<string, Beta>, key: string, helped: number, w: number) => {
    const cur = map.get(key) ?? { ...PRIOR };
    map.set(key, { a: cur.a + helped * w, b: cur.b + (1 - helped) * w });
  };

  for (const e of effective) {
    const w = EVIDENCE_WEIGHT[e.evidenceLevel] * clamp01(e.confidence) * decay(e);
    seenCount.set(e.statePattern, (seenCount.get(e.statePattern) ?? 0) + 1);
    if (e.intervention === '__state__') continue;
    if (e.status === 'RULED_OUT') {
      const key = `${e.statePattern}|${e.repositoryRevision ?? '-'}`;
      ruled.set(key, (ruled.get(key) ?? new Set()).add(e.intervention));
    }
    const miss = missByPattern.get(e.statePattern) ?? { miss: 0, n: 0 };
    missByPattern.set(e.statePattern, { miss: miss.miss + (e.status === 'NOT_FOUND' ? w : 0), n: miss.n + w });
    if (e.status === 'NOT_FOUND') continue;
    const helped = e.status === 'FOUND' && e.preventionEffect > 0 ? 1 : 0;
    add(exact, `${e.statePattern}|${e.intervention}`, helped, w);
    add(coarse, `${coarsePattern(e.statePattern)}|${e.intervention}`, helped, w);
    add(global, e.intervention, helped, w);
    for (const kind of e.addresses) {
      const k = `${e.intervention}|${kind}`;
      const cur = effect.get(k) ?? { sum: 0, w: 0 };
      // Realized effect relative to declared: a helping intervention earns
      // its declaration, a non-helping one loses it.
      effect.set(k, { sum: cur.sum + w * (helped ? 1 : 0), w: cur.w + w });
    }
  }

  const betaMean = (b: Beta | undefined) => (b ? b.a / (b.a + b.b) : PRIOR.a / (PRIOR.a + PRIOR.b));
  return {
    experiences: effective.length,
    benefit(pattern, intervention) {
      const g = { mean: betaMean(global.get(intervention)) };
      const c = shrink(coarse.get(`${coarsePattern(pattern)}|${intervention}`) ?? { ...PRIOR }, g);
      return shrink(exact.get(`${pattern}|${intervention}`) ?? { ...PRIOR }, c);
    },
    effectiveness(intervention, kind) {
      const e = effect.get(`${intervention}|${kind}`);
      if (!e || e.w <= 0) return 1;
      // Shrunk towards "as declared" (1) by the same rule as benefit.
      const w = e.w / (e.w + SHRINKAGE);
      return clamp01(w * (e.sum / e.w) + (1 - w) * 1);
    },
    seen: (pattern) => seenCount.get(pattern) ?? 0,
    generationMissRate(pattern) {
      const m = missByPattern.get(pattern) ?? { miss: 0, n: 0 };
      return (m.miss + 0) / (m.n + SHRINKAGE);
    },
    ruledOut: (pattern, revision) => new Set(ruled.get(`${pattern}|${revision ?? '-'}`) ?? []),
    recommended(pattern, limit) {
      const out: Array<{ id: string; mean: number }> = [];
      for (const key of exact.keys()) {
        const [p1, p2, p3, p4, id] = key.split('|');
        if (`${p1}|${p2}|${p3}|${p4}` !== pattern) continue;
        const b = this.benefit(pattern, id);
        if (b.n > 0 && b.mean > 0.5) out.push({ id, mean: b.mean });
      }
      return out.sort((a, b) => b.mean - a.mean || (a.id < b.id ? -1 : 1)).slice(0, limit).map((x) => x.id);
    },
  };
}

// ---------------------------------------------------------------------------
// Action motifs
// ---------------------------------------------------------------------------

export interface ActionMotif {
  motifFingerprint: string;
  stateSignaturePattern: string;
  actionSequence: [string, string];
  observations: number;
  successRate: number;
  expectedLossAvoided: number;
  cost: number;
  causalConfidence: number;
  lastSequence: number;
}

/** Motifs kept per state pattern. */
export const MOTIFS_PER_PATTERN = 5;
/** A motif whose decayed net value falls below this many tokens is evicted. */
export const MOTIF_EVICTION_TOKENS = 1;

export interface MotifObservation {
  pattern: string;
  sequence: [string, string];
  helped: boolean;
  lossAvoided: number;
  cost: number;
  confidence: number;
  taskSequence: number;
}

/** Folds observations into the motif table and returns it compressed: top-K
 *  per pattern by decayed net value, negligible ones evicted. */
export function updateMotifs(motifs: ActionMotif[], observations: MotifObservation[], currentSequence: number): ActionMotif[] {
  const table = new Map(motifs.map((m) => [m.motifFingerprint, { ...m }]));
  for (const o of observations) {
    const fp = `motif:${o.pattern}:${o.sequence.join('>')}`;
    const m = table.get(fp) ?? {
      motifFingerprint: fp, stateSignaturePattern: o.pattern, actionSequence: o.sequence,
      observations: 0, successRate: 0, expectedLossAvoided: 0, cost: 0, causalConfidence: 0, lastSequence: o.taskSequence,
    };
    const n = m.observations + 1;
    m.successRate = (m.successRate * m.observations + (o.helped ? 1 : 0)) / n;
    m.expectedLossAvoided = (m.expectedLossAvoided * m.observations + o.lossAvoided) / n;
    m.cost = (m.cost * m.observations + o.cost) / n;
    m.causalConfidence = (m.causalConfidence * m.observations + clamp01(o.confidence)) / n;
    m.observations = n;
    m.lastSequence = Math.max(m.lastSequence, o.taskSequence);
    table.set(fp, m);
  }
  const net = (m: ActionMotif) => (m.successRate * m.expectedLossAvoided - m.cost)
    * 0.5 ** (Math.max(0, currentSequence - m.lastSequence) / EXPERIENCE_HALF_LIFE_TASKS);
  const byPattern = new Map<string, ActionMotif[]>();
  for (const m of table.values()) {
    if (net(m) < MOTIF_EVICTION_TOKENS) continue;
    byPattern.set(m.stateSignaturePattern, [...(byPattern.get(m.stateSignaturePattern) ?? []), m]);
  }
  return [...byPattern.values()].flatMap((list) => list.sort((a, b) => net(b) - net(a)).slice(0, MOTIFS_PER_PATTERN));
}

/** P(motif beneficial | pattern): the motif's own rate, shrunk to neutral by
 *  how little it has been seen and how weakly its evidence was established. */
export function motifPrior(m: ActionMotif): number {
  const w = (m.observations * m.causalConfidence) / (m.observations * m.causalConfidence + SHRINKAGE);
  return clamp01(w * m.successRate + (1 - w) * 0.5);
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

export type CalibrationTarget =
  | 'success' | 'failure' | 'prevention' | 'discovery' | 'counterfactual_effect' | 'intervention_value' | 'candidate_recall';

export interface CalibrationObservation {
  target: CalibrationTarget;
  /** Free-form group: provenance, capability, regime, bucket, fingerprint. */
  group: Record<string, string>;
  predicted: number;
  /** 0/1 for probabilities; a number for values (MAE uses it). */
  observed: number;
}

export interface CalibrationSummary {
  n: number;
  brier: number | null;
  ece: number | null;
  slope: number | null;
  intercept: number | null;
  mae: number | null;
}

const BINS = 10;

export function summarizeCalibration(observations: CalibrationObservation[]): CalibrationSummary {
  const n = observations.length;
  if (n === 0) return { n, brier: null, ece: null, slope: null, intercept: null, mae: null };
  const brier = observations.reduce((s, o) => s + (o.predicted - o.observed) ** 2, 0) / n;
  const mae = observations.reduce((s, o) => s + Math.abs(o.predicted - o.observed), 0) / n;
  const bins = Array.from({ length: BINS }, () => ({ p: 0, y: 0, n: 0 }));
  for (const o of observations) {
    const b = bins[Math.min(BINS - 1, Math.floor(clamp01(o.predicted) * BINS))];
    b.p += o.predicted; b.y += o.observed; b.n += 1;
  }
  const ece = bins.reduce((s, b) => s + (b.n === 0 ? 0 : (b.n / n) * Math.abs(b.p / b.n - b.y / b.n)), 0);
  // Calibration slope/intercept: least squares of observed on predicted. A
  // slope below one is over-confidence; above one, under-confidence.
  const mp = observations.reduce((s, o) => s + o.predicted, 0) / n;
  const my = observations.reduce((s, o) => s + o.observed, 0) / n;
  const sxx = observations.reduce((s, o) => s + (o.predicted - mp) ** 2, 0);
  const sxy = observations.reduce((s, o) => s + (o.predicted - mp) * (o.observed - my), 0);
  const slope = sxx > 1e-12 ? sxy / sxx : null;
  return { n, brier, ece, slope, intercept: slope === null ? null : my - slope * mp, mae };
}

/** Groups observations by one group key and summarizes each group. */
export function calibrationBy(
  observations: CalibrationObservation[], target: CalibrationTarget, key: string,
): Record<string, CalibrationSummary> {
  const groups = new Map<string, CalibrationObservation[]>();
  for (const o of observations) {
    if (o.target !== target) continue;
    const g = o.group[key] ?? '-';
    groups.set(g, [...(groups.get(g) ?? []), o]);
  }
  return Object.fromEntries([...groups.entries()].map(([g, list]) => [g, summarizeCalibration(list)]));
}

/** Observations a bin needs before its correction outweighs the raw number. */
const RECALIBRATION_SHRINKAGE = 10;

/** A recalibration map for one target: histogram binning, each bin's observed
 *  rate shrunk to the raw prediction by how few observations it holds. The
 *  identity until there is data — learning that has not happened changes
 *  nothing. */
export function recalibrator(observations: CalibrationObservation[], target: CalibrationTarget): (p: number) => number {
  const bins = Array.from({ length: BINS }, () => ({ y: 0, n: 0 }));
  for (const o of observations) {
    if (o.target !== target) continue;
    const b = bins[Math.min(BINS - 1, Math.floor(clamp01(o.predicted) * BINS))];
    b.y += o.observed; b.n += 1;
  }
  return (p) => {
    const raw = clamp01(p);
    const b = bins[Math.min(BINS - 1, Math.floor(raw * BINS))];
    if (b.n === 0) return raw;
    const w = b.n / (b.n + RECALIBRATION_SHRINKAGE);
    return clamp01(w * (b.y / b.n) + (1 - w) * raw);
  };
}

export const CALIBRATION_KIND = 'governor_calibration';
export const MOTIF_KIND = 'action_motif';

/** The governor's whole learned state, in one place the cycle reads from. */
export interface GovernorMemory {
  experiences: ExperienceStore;
  motifs: ActionMotif[];
  calibration: CalibrationObservation[];
  /** Monotonic count of tasks learned from. */
  sequence: number;
  model: CausalModel;
  /** Average intervention regret per governor look, in tokens, learned from
   *  finished tasks: what a look risks besides its own arithmetic. */
  regretPerLook: number;
}

export function emptyGovernorMemory(experiences: ExperienceStore = memoryExperienceStore()): GovernorMemory {
  return { experiences, motifs: [], calibration: [], sequence: 0, model: buildCausalModel([]), regretPerLook: 0 };
}

/** Rebuilds the derived model after new experiences landed. */
export function refreshModel(mem: GovernorMemory): void {
  mem.model = buildCausalModel(mem.experiences.all(), mem.sequence);
}

/** Persists the parts of governor memory that are not experiences. */
export function saveGovernorMemory(db: Db, mem: GovernorMemory): void {
  for (const [kind, value] of [[MOTIF_KIND, mem.motifs], [CALIBRATION_KIND, mem.calibration.slice(-5_000)]] as const) {
    db.delete(memoryTable).where(and(eq(memoryTable.kind, kind), eq(memoryTable.key, 'governor'))).run();
    db.insert(memoryTable).values({
      id: `${kind}:governor`, kind, key: 'governor', value: { value, sequence: mem.sequence, regretPerLook: mem.regretPerLook },
      confidence: null, nodeId: null, createdAt: new Date().toISOString(),
    }).run();
  }
}

export function loadGovernorMemory(db: Db): GovernorMemory {
  const mem = emptyGovernorMemory(dbExperienceStore(db));
  try {
    for (const kind of [MOTIF_KIND, CALIBRATION_KIND]) {
      const row = db.select().from(memoryTable).where(and(eq(memoryTable.kind, kind), eq(memoryTable.key, 'governor'))).get();
      const stored = row?.value as { value: unknown[]; sequence: number; regretPerLook?: number } | undefined;
      if (!stored) continue;
      if (Number.isFinite(stored.regretPerLook)) mem.regretPerLook = stored.regretPerLook as number;
      if (kind === MOTIF_KIND) mem.motifs = stored.value as ActionMotif[];
      else mem.calibration = stored.value as CalibrationObservation[];
      mem.sequence = Math.max(mem.sequence, stored.sequence ?? 0);
    }
  } catch (err) {
    console.error('Could not load governor memory; starting cold:', err);
  }
  refreshModel(mem);
  return mem;
}
