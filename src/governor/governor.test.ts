import { describe, it, expect, afterEach } from 'vitest';
import { actionCandidate, type ActionCandidate } from '../decision/actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from '../decision/state.js';
import { chooseEconomicAction } from '../decision/engine.js';
import { runDecisionCycle } from '../decision/orchestration-loop.js';
import { registerCandidateSource } from '../decision/deep-path.js';
import { buildDecisionPacket, memoryPacketStore, packetMatchesState, stateFromPacket } from './packet.js';
import {
  actionSpaceUncertainty, discoveryCandidate, normalizeProposals, extractProposals, createDormantPool,
  DORMANT_REGISTRY, MAX_PROPOSALS,
} from './coverage.js';
import { autonomyHorizon, materialTransition, premiseOf } from './horizon.js';
import { riskSnapshot } from './risk.js';
import { analyzeTask, type TaskTrace, type TraceEvent } from './miss.js';
import { diagnose } from './ladder.js';
import {
  buildCausalModel, effectiveExperiences, updateMotifs, summarizeCalibration, recalibrator, emptyGovernorMemory,
  MOTIFS_PER_PATTERN, type CausalExperience,
} from './memory.js';
import {
  createGovernorContext, newGovernorNodeState, learnFromTask, VARIANTS, adviceFor, governDecision,
} from './governor.js';

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'fix the thing', totalTokenBudget: 200_000 });
  return normalizeEconomicState({
    ...base, version: 10,
    uncertainty: { target: 0.3, structural: 0.6, behavioral: 0.7, validation: 0.9 },
    trajectory: { ...base.trajectory, progress: 0.5, orchestrationConfidence: 0.9, failurePressure: 0.3 },
    ...over,
  });
}

const healthy = (over: Partial<EconomicState> = {}) => state({
  uncertainty: { target: 0, structural: 0, behavioral: 0, validation: 0 },
  trajectory: { ...state().trajectory, failurePressure: 0, progress: 0.4 },
  ...over,
});

function decisionWith(s: EconomicState, candidates: ActionCandidate[] = []) {
  return chooseEconomicAction({ state: s, candidates, decisionId: `d-${s.version}` });
}

// ---------------------------------------------------------------------------

describe('DecisionPacket', () => {
  it('keeps every candidate with provenance, and never a context body', () => {
    const s = state({ evidence: [{ id: 'observed:src/a.ts', kind: 'fact', source: 'run:src/a.ts', confidence: 0.9 }] });
    const secret = 'FILE CONTENTS THAT MUST NOT BE COPIED';
    const reuse = actionCandidate({ id: 'historical:k1', kind: 'reuse_evidence', capability: 'evidence.store', tokenCost: 10,
      metadata: { content: secret, candidateSource: 'historical-evidence' } });
    const d = decisionWith(s, [reuse]);
    const p = buildDecisionPacket({
      taskId: 't', state: s, decision: d, coverage: [], risk: riskSnapshot(s), commitmentDepth: 0.1, horizon: 2,
      features: ['risk'], actionSpaceUncertainty: 0, discovery: null, compositions: 0, prevention: {},
    });
    const json = JSON.stringify(p);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('fix the thing');
    expect(p.candidates.map((c) => c.id).sort()).toEqual(['continue', 'historical:k1']);
    expect(p.candidates.find((c) => c.id === 'historical:k1')?.source).toBe('historical-evidence');
    expect(p.evidenceRefs).toEqual(['observed:src/a.ts']);
  });

  it('refuses to describe a state that has moved on', () => {
    const s = state();
    const p = buildDecisionPacket({
      taskId: 't', state: s, decision: decisionWith(s), coverage: [], risk: null, commitmentDepth: 0, horizon: 1,
      features: [], actionSpaceUncertainty: 0, discovery: null, compositions: 0, prevention: {},
    });
    expect(packetMatchesState(p, s)).toBe(true);
    expect(packetMatchesState(p, { ...s, version: 11 })).toBe(false);
    expect(packetMatchesState(p, { ...s, repositoryRevision: 'other' })).toBe(false);
    expect(stateFromPacket(p).uncertainty).toEqual(s.uncertainty);
  });

  it('is answerable by id and by task, as copies', () => {
    const store = memoryPacketStore();
    const s = state();
    const p = buildDecisionPacket({ taskId: 't', state: s, decision: decisionWith(s), coverage: [], risk: null,
      commitmentDepth: 0, horizon: 1, features: [], actionSpaceUncertainty: 0, discovery: null, compositions: 0, prevention: {} });
    store.put(p);
    const got = store.get(p.decisionId)!;
    got.chosen.id = 'mutated';
    expect(store.get(p.decisionId)!.chosen.id).toBe(p.chosen.id);
    expect(store.list('t')).toHaveLength(1);
  });
});

describe('candidate coverage and discovery', () => {
  it('scores a familiar, healthy state with working sources as zero action-space doubt', () => {
    expect(actionSpaceUncertainty({ state: healthy(), coverage: [{ source: 'a', version: '1', invoked: true, proposed: 1, feasible: 1, rejected: 0 }], novelty: 1, generationMissRate: 0 })).toBe(0);
  });

  it('rises when a source fails, without crashing anything', () => {
    const u = actionSpaceUncertainty({ state: healthy(), novelty: 0, generationMissRate: 0, coverage: [
      { source: 'a', version: '1', invoked: true, proposed: 0, feasible: 0, rejected: 0, error: 'boom' },
      { source: 'b', version: '1', invoked: true, proposed: 1, feasible: 1, rejected: 0 },
    ] });
    expect(u).toBeCloseTo(0.5);
  });

  it('is never offered when there is nothing to lose', () => {
    const s = healthy();
    const risk = { ...riskSnapshot(s), actionSpaceUncertainty: 1 };
    expect(discoveryCandidate({ state: s, risk, known: [], poolPrior: 0.9, tiers: ['registry'] })).toBeNull();
  });

  it('is offered as a priced candidate when exposure and doubt are real', () => {
    const s = state();
    const risk = { ...riskSnapshot(s), actionSpaceUncertainty: 0.8 };
    const d = discoveryCandidate({ state: s, risk, known: [], poolPrior: 0.5, tiers: ['registry'] });
    expect(d?.capability).toBe('governor.discover');
  });

  it('activates only compatible dormant entries not already on the table', () => {
    const pool = createDormantPool();
    const s = state();
    const all = pool.activate(s, new Set(), 10);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((c) => typeof c.metadata.advice === 'string')).toBe(true);
    const exclude = new Set(all.map((c) => c.id));
    expect(pool.activate(s, exclude, 10)).toHaveLength(0);
    // Nothing to address and no progress: nothing is compatible.
    expect(pool.activate(healthy({ trajectory: { ...healthy().trajectory, progress: 0 } }), new Set(), 10)).toHaveLength(0);
  });

  it('normalizes at most three proposals, deduplicated by meaning-preserving fingerprint', () => {
    const raw = [
      { description: 'Inspect historical callers of this symbol before modifying it', addresses: ['behavioral'] },
      { description: 'inspect historical callers of this symbol   before modifying it' },
      { description: 'Read the migration notes first', addresses: ['structural'] },
      { description: 'Run the parser tests', addresses: ['validation'], kind: 'validate' },
      { description: 'One too many proposals here' },
      { nonsense: true },
    ];
    const out = normalizeProposals(raw, state(), 'agent');
    expect(out).toHaveLength(MAX_PROPOSALS);
    expect(new Set(out.map((c) => c.id)).size).toBe(3);
    expect(out[2].kind).toBe('validate');
    expect(extractProposals('text\n```intervention-proposals\n[{"description":"x y z w q"}]\n```')).toHaveLength(1);
    expect(extractProposals('no block')).toEqual([]);
  });
});

describe('the autonomy horizon', () => {
  it('leaves a healthy run alone for long and looks at a risky one soon', () => {
    const calm = healthy();
    const calmH = autonomyHorizon({ state: calm, risk: riskSnapshot(calm) });
    const hotState = state();
    const prev = riskSnapshot(state({ version: 8, trajectory: { ...state().trajectory, failurePressure: 0 } }));
    const hotH = autonomyHorizon({ state: hotState, risk: riskSnapshot(hotState, prev) });
    expect(calmH.horizon).toBeGreaterThan(hotH.horizon);
    expect(hotH.horizon).toBeGreaterThanOrEqual(1);
  });

  it('treats a new failure or a validation result as a changed premise', () => {
    const s = state();
    const premise = premiseOf(s);
    expect(materialTransition(premise, s)).toBe(false);
    expect(materialTransition(premise, { ...s, trajectory: { ...s.trajectory, failurePressure: 0.6 } })).toBe(true);
    expect(materialTransition(premise, { ...s, validation: { ...s.validation, status: 'failed' } })).toBe(true);
  });
});

// ---------------------------------------------------------------------------

function packetAt(s: EconomicState, candidates: ActionCandidate[] = [], taskId = 't') {
  return buildDecisionPacket({ taskId, state: s, decision: decisionWith(s, candidates), coverage: [], risk: riskSnapshot(s),
    commitmentDepth: 0, horizon: 1, features: ['risk'], actionSpaceUncertainty: 0, discovery: null, compositions: 0, prevention: {} });
}

const pool = [...DORMANT_REGISTRY];

describe('the miss engine', () => {
  it('calls a run with no trouble a clean success', () => {
    const a = analyzeTask({ taskId: 't', packets: [packetAt(state())], events: [], pool, outcome: { succeeded: true, totalTokens: 1000, reworkTokens: 0 } });
    expect(a.outcomeClass).toBe('CLEAN_SUCCESS');
    expect(a.misses).toHaveLength(0);
  });

  it('does not infer a miss from failure alone: nothing feasible means unavoidable', () => {
    const a = analyzeTask({ taskId: 't', packets: [], events: [{ version: 3, kind: 'failure', signature: 'x', tokens: 0 }],
      pool: [], outcome: { succeeded: false, totalTokens: 1000, reworkTokens: 0, capabilityMissing: true } });
    expect(a.outcomeClass).toBe('FAILURE_UNAVOIDABLE');
    expect(a.misses).toHaveLength(0);
  });

  it('finds a feasible earlier remedy as a near miss, and picks the boundary where it paid most', () => {
    const early = packetAt(state({ version: 2 }));
    const late = packetAt(state({ version: 6, uncertainty: { target: 0, structural: 0, behavioral: 0, validation: 0.95 } }));
    const events: TraceEvent[] = [
      { version: 8, kind: 'validation', passed: false, tokens: 0 },
      { version: 9, kind: 'recovery', fingerprint: 'dormant:narrow-check', capability: 'validation.narrow', addresses: ['validation'], tokens: 500 },
      { version: 12, kind: 'validation', passed: true, tokens: 0 },
    ];
    const a = analyzeTask({ taskId: 't', packets: [early, late], events, pool, outcome: { succeeded: true, totalTokens: 50_000, reworkTokens: 20_000 } });
    expect(a.outcomeClass).toBe('NEAR_MISS');
    const top = a.hindsight[0];
    expect(top.feasibleAtBoundary).toBe(true);
    expect(top.boundary?.stateVersion).toBe(6);
    expect(a.preventionDebt).toBeGreaterThan(0);
    expect(a.misses[0].label).toBe('RETRIEVAL_MISS');
  });

  it('labels a candidate that was on the table and lost as a decision miss, not a generation miss', () => {
    const s = state({ version: 4 });
    // Cheap enough to be feasible, believed too little to win.
    const check = actionCandidate({ id: 'dormant:narrow-check', kind: 'validate', capability: 'validation.narrow', tokenCost: 2_000,
      expectedInformationGain: 0.6, confidence: 0.05, metadata: { fingerprint: 'dormant:narrow-check', addresses: ['validation'] } });
    const p = packetAt(s, [check]);
    const a = analyzeTask({ taskId: 't', packets: [p], pool,
      events: [{ version: 6, kind: 'failure', signature: 'x', tokens: 0 },
        { version: 7, kind: 'recovery', fingerprint: 'dormant:narrow-check', capability: 'validation.narrow', addresses: ['validation'], tokens: 0 }],
      outcome: { succeeded: false, totalTokens: 400_000, reworkTokens: 0 } });
    expect(a.outcomeClass).toBe('MISSED_OPPORTUNITY');
    expect(['ESTIMATION_MISS', 'RANKING_MISS', 'PRUNING_MISS']).toContain(a.misses[0].label);
  });

  it('flags a validated success that ground truth disagrees with as a validation miss', () => {
    const a = analyzeTask({ taskId: 't', packets: [packetAt(state())], events: [], pool,
      outcome: { succeeded: true, hiddenFailure: true, totalTokens: 10_000, reworkTokens: 0 } });
    expect(a.misses.map((m) => m.label)).toContain('VALIDATION_MISS');
  });

  it('counts an intervention nothing needed as regret', () => {
    const s = healthy();
    const check = actionCandidate({ id: 'x', kind: 'validate', capability: 'v', tokenCost: 100, expectedQualityBenefit: 0.9, confidence: 1 });
    const p = packetAt(s, [check]);
    const forced = { ...p, chosen: { ...p.chosen, kind: 'validate', id: 'x', fingerprint: 'validate:v:x' },
      candidates: p.candidates.map((c) => ({ ...c, status: c.id === 'x' ? 'chosen' as const : 'ranked' as const })) };
    const carried: TraceEvent = { version: s.version, kind: 'intervention', fingerprint: 'validate:v:x', capability: 'v', tokens: 100 };
    const a = analyzeTask({ taskId: 't', packets: [forced], events: [carried], pool, outcome: { succeeded: true, totalTokens: 1000, reworkTokens: 0 } },
      { helpedProbability: () => 0 });
    expect(a.interventionRegret).toBeGreaterThan(0);
    expect(a.unnecessaryInterventions).toBe(1);
    // Chosen but never carried out: it spent nothing, so it costs no regret.
    const recorded = analyzeTask({ taskId: 't', packets: [forced], events: [], pool, outcome: { succeeded: true, totalTokens: 1000, reworkTokens: 0 } },
      { helpedProbability: () => 0 });
    expect(recorded.interventionRegret).toBe(0);
  });
});

describe('the diagnostic ladder', () => {
  const trace = (): TaskTrace => ({
    taskId: 't', pool,
    packets: [packetAt(state({ version: 6, uncertainty: { target: 0, structural: 0, behavioral: 0, validation: 0.95 } }))],
    events: [{ version: 8, kind: 'validation', passed: false, tokens: 0 },
      { version: 9, kind: 'recovery', fingerprint: 'dormant:narrow-check', capability: 'validation.narrow', addresses: ['validation'], tokens: 500 }],
    outcome: { succeeded: false, totalTokens: 50_000, reworkTokens: 0 },
  });

  it('buys no replay when the stake cannot pay for one, and never asks a model', () => {
    const t = trace();
    const finding = analyzeTask(t).misses[0];
    let replays = 0;
    const r = diagnose({ finding, trace: t, model: buildCausalModel([]), stakeTokens: 100, priorEvidence: 0,
      replayCostTokens: 50_000, usdPerToken: 3e-6, observed: { succeeded: false, tokens: 50_000 },
      replay: () => { replays += 1; return [{ succeeded: true, tokens: 1 }]; } });
    expect(replays).toBe(0);
    expect(['NO_DIAGNOSIS', 'CHEAP_DIAGNOSIS', 'EMPIRICAL_ESTIMATE']).toContain(r.option);
  });

  it('replays when the stake justifies it, on a frozen copy, and validates only on agreement', () => {
    const t = trace();
    const before = JSON.stringify(t.packets);
    const finding = analyzeTask(t).misses[0];
    const r = diagnose({ finding, trace: t, model: buildCausalModel([]), stakeTokens: 10_000_000, priorEvidence: 0,
      replayCostTokens: 1_000, usdPerToken: 3e-6, observed: { succeeded: false, tokens: 50_000 },
      replay: ({ packet, replays }) => {
        expect(Object.isFrozen(packet)).toBe(true);
        expect(() => { (packet as { stateVersion: number }).stateVersion = 99; }).toThrow();
        return Array.from({ length: replays }, () => ({ succeeded: true, tokens: 20_000 }));
      } });
    expect(r.option).toBe('REPLAY_MULTIPLE');
    expect(r.evidence?.evidenceLevel).toBe('validated');
    expect(r.evidence?.effectEstimate).toBeGreaterThan(0);
    expect(JSON.stringify(t.packets)).toBe(before);
  });

  it('calls a single replay supported, never validated', () => {
    const t = trace();
    const finding = analyzeTask(t).misses[0];
    const r = diagnose({ finding, trace: t, model: buildCausalModel([]), stakeTokens: 2_000, priorEvidence: 0,
      replayCostTokens: 1_000, usdPerToken: 3e-6, observed: { succeeded: false, tokens: 50_000 },
      replay: () => [{ succeeded: true, tokens: 20_000 }] });
    if (r.option === 'REPLAY_ONE') expect(r.evidence?.evidenceLevel).toBe('supported');
  });
});

describe('causal memory', () => {
  const exp = (over: Partial<CausalExperience>): CausalExperience => ({
    id: Math.random().toString(36), statePattern: 'validation|mid|failing|unknown', unresolvedUncertainty: [], intervention: 'i',
    addresses: ['validation'], timing: 'now', observedFailureRisk: 0.5, lossAvoided: 100, interventionCost: 10,
    preventionEffect: 1, optionEffect: 0, evidenceLevel: 'weak', confidence: 1, status: 'FOUND', repository: null,
    repositoryRevision: null, sequence: 1, taskId: 't', ...over,
  });

  it('lets newer evidence supersede older, never the reverse', () => {
    const older = exp({ sequence: 1, evidenceLevel: 'supported', preventionEffect: 1 });
    const newer = exp({ sequence: 5, evidenceLevel: 'validated', preventionEffect: -1, status: 'RULED_OUT' });
    const kept = effectiveExperiences([older, newer]);
    expect(kept.map((e) => e.sequence)).toEqual([5]);
    // A stale strong record cannot override a newer one.
    const staleStrong = exp({ sequence: 1, evidenceLevel: 'validated', preventionEffect: 1 });
    const newerWeak = exp({ sequence: 5, evidenceLevel: 'weak', preventionEffect: -1, status: 'RULED_OUT' });
    expect(effectiveExperiences([staleStrong, newerWeak]).map((e) => e.sequence).sort()).toEqual([1, 5]);
  });

  it('learns benefit by pattern and remembers dead ends', () => {
    const m = buildCausalModel([
      ...Array.from({ length: 10 }, (_, i) => exp({ sequence: i, evidenceLevel: 'validated' })),
      exp({ intervention: 'dead', status: 'RULED_OUT', preventionEffect: -1, sequence: 11 }),
    ]);
    expect(m.benefit('validation|mid|failing|unknown', 'i').mean).toBeGreaterThan(0.8);
    expect(m.ruledOut('validation|mid|failing|unknown', null).has('dead')).toBe(true);
    expect(m.recommended('validation|mid|failing|unknown', 3)).toContain('i');
  });

  it('keeps motifs bounded per pattern and evicts negligible ones', () => {
    const obs = Array.from({ length: 12 }, (_, i) => ({ pattern: 'p', sequence: [`a${i}`, `b${i}`] as [string, string],
      helped: true, lossAvoided: 1000 + i, cost: 10, confidence: 1, taskSequence: 1 }));
    const motifs = updateMotifs([], [...obs, { pattern: 'p', sequence: ['x', 'y'], helped: false, lossAvoided: 0, cost: 10, confidence: 1, taskSequence: 1 }], 1);
    expect(motifs.length).toBeLessThanOrEqual(MOTIFS_PER_PATTERN);
    expect(motifs.some((m) => m.actionSequence[0] === 'x')).toBe(false);
  });

  it('measures and corrects calibration, and is the identity with no data', () => {
    const obs = Array.from({ length: 100 }, (_, i) => ({ target: 'failure' as const, group: {}, predicted: 0.9, observed: i < 30 ? 1 : 0 }));
    const sum = summarizeCalibration(obs);
    expect(sum.brier).toBeGreaterThan(0.3);
    expect(sum.ece).toBeCloseTo(0.6, 1);
    expect(recalibrator(obs, 'failure')(0.9)).toBeLessThan(0.5);
    expect(recalibrator([], 'failure')(0.42)).toBe(0.42);
  });
});

// ---------------------------------------------------------------------------

describe('invariants of the governed cycle', () => {
  let unregister: (() => void) | null = null;
  afterEach(() => { unregister?.(); unregister = null; });

  const governor = (variant: keyof typeof VARIANTS = 'H4') => ({
    ctx: createGovernorContext({ taskId: 'task', features: VARIANTS[variant]!, packets: memoryPacketStore() }),
    node: newGovernorNodeState(),
  });

  it('keeps continue available and chosen on a healthy run, with no deep look', () => {
    const g = governor();
    const r = runDecisionCycle(healthy(), { governor: g });
    expect(r.decision?.action.kind).toBe('continue');
    expect(r.skippedDeepEvaluation).toBe(true);
    expect(g.node.stats.discoveries).toBe(0);
  });

  it('leaves a healthy agent alone for a priced horizon, not every boundary', () => {
    const g = governor();
    let s = healthy({ version: 1 });
    let evaluated = 0;
    for (let v = 1; v <= 30; v++) {
      s = { ...s, version: v, trajectory: { ...s.trajectory, progress: Math.min(0.95, v / 32) } };
      const r = runDecisionCycle(s, { governor: g });
      if (r.cost.reason !== 'not_due') evaluated += 1;
    }
    expect(evaluated).toBeLessThan(15);
    expect(g.node.stats.autonomousBoundaries).toBeGreaterThan(15);
  });

  it('survives a candidate source that throws, recording it in coverage', () => {
    unregister = registerCandidateSource('broken-test-source', () => { throw new Error('down'); });
    const g = governor();
    const r = runDecisionCycle(state(), { governor: g });
    expect(r.decision).toBeDefined();
    const packet = g.ctx.packets!.list('task')[0];
    expect(packet.candidateSources.find((c) => c.source === 'broken-test-source')?.error).toBe('down');
  });

  it('runs discovery as a priced candidate, expands, and lets the market rerun', () => {
    const g = governor('H3a');
    const d = governDecision({ state: state(), candidates: [], coverage: [], risk: { ...riskSnapshot(state()) }, ctx: g.ctx, node: g.node });
    if (d.discovery) {
      expect(g.node.stats.marketRuns).toBe(2);
      expect(d.discovery.activated.length + (d.discovery.tier === 'agent_proposal' ? 1 : 0)).toBeGreaterThan(0);
    } else {
      expect(g.node.stats.marketRuns).toBe(1);
    }
  });

  it('never lets System-1 or a proposer choose: proposals are priced and may lose', () => {
    const g = governor('H3a');
    g.node.pendingProposals = [{ description: 'Rewrite the whole module from scratch', estimatedTokens: 190_000 }];
    const d = governDecision({ state: state(), candidates: [], coverage: [], risk: riskSnapshot(state()), ctx: g.ctx, node: g.node });
    expect(d.candidates.some((c) => c.id.startsWith('proposal:'))).toBe(true);
    expect(d.decision.action.id.startsWith('proposal:')).toBe(false);
  });

  it('under H1 behaves exactly like the plain market', () => {
    const s = state();
    const plain = runDecisionCycle(s, {});
    const h1 = runDecisionCycle(s, { governor: governor('H1') });
    expect(h1.decision?.action.id).toBe(plain.decision?.action.id);
    expect(h1.decision?.utility).toBeCloseTo(plain.decision?.utility ?? 0, 12);
  });

  it('does not re-offer advice already given until the premise changes', () => {
    const g = governor('H3a');
    const s = state();
    const dormant = createDormantPool().activate(s, new Set(), 1)[0];
    g.node.advised.set(dormant.id, s.version);
    g.node.lastMaterialVersion = s.version;
    const again = governDecision({ state: s, candidates: [dormant], coverage: [], risk: riskSnapshot(s), ctx: g.ctx, node: g.node });
    expect(again.candidates.some((c) => c.id === dormant.id)).toBe(false);
    g.node.lastMaterialVersion = s.version + 1;
    const later = governDecision({ state: { ...s, version: s.version + 2 }, candidates: [dormant], coverage: [], risk: riskSnapshot(s), ctx: g.ctx, node: g.node });
    expect(later.candidates.some((c) => c.id === dormant.id)).toBe(true);
  });

  it('renders governor interventions as advice the agent may ignore', () => {
    const s = state();
    const dormant = createDormantPool().activate(s, new Set(), 1)[0];
    const d = { ...decisionWith(s), action: dormant };
    expect(adviceFor(d)).toMatch(/you decide whether it applies/);
    expect(adviceFor(decisionWith(s))).toBe('');
  });
});

describe('learning changes future estimates and nothing else', () => {
  it('moves the prior for an intervention that a replay validated', () => {
    const memory = emptyGovernorMemory();
    const s = state({ version: 6, uncertainty: { target: 0, structural: 0, behavioral: 0, validation: 0.95 } });
    const t: TaskTrace = {
      taskId: 't1', pool, packets: [packetAt(s, [], 't1')],
      events: [{ version: 8, kind: 'validation', passed: false, tokens: 0 },
        { version: 9, kind: 'recovery', fingerprint: 'dormant:narrow-check', capability: 'validation.narrow', addresses: ['validation'], tokens: 500 }],
      outcome: { succeeded: false, totalTokens: 500_000, reworkTokens: 0 },
    };
    const before = memory.model.benefit('validation|mid|failing|unknown', 'dormant:narrow-check').mean;
    const r = learnFromTask({ trace: t, memory, replay: ({ replays }) => Array.from({ length: replays }, () => ({ succeeded: true, tokens: 1000 })) });
    expect(r.analysis.misses.length).toBeGreaterThan(0);
    const pattern = r.analysis.hindsight[0] ? 'validation|mid|failing|unknown' : '';
    const after = memory.model.benefit(pattern, 'dormant:narrow-check').mean;
    expect(after).toBeGreaterThan(before);
    expect(memory.sequence).toBe(1);
  });
});
