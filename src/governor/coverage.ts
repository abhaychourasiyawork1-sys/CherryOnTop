/** Is the market even looking at the right options — and is finding out
 *  worth paying for?
 *
 *  Two different doubts, and conflating them is how a governor learns the
 *  wrong lesson. Task uncertainty is "do we know enough about the work?";
 *  action-space uncertainty is "does the candidate set contain the
 *  intervention that would help?". A run can be perfectly understood and
 *  still be governed badly because nothing proposed the one useful action —
 *  and a later failure then gets blamed on *ranking* when the truth is that
 *  the option was never generated. So this module keeps:
 *
 *   - **coverage** — per decision, which sources ran, what each proposed, and
 *     which failed — so a miss can be traced to generation, not ranking;
 *   - **U_action** — a System-0 estimate of whether a useful intervention is
 *     missing, from novelty, source health and the history of generation
 *     misses in states like this one;
 *   - **the dormant pool** — generic, capability-facing interventions that are
 *     *not* proposed by default, activated by cheap compatibility, priced like
 *     everything else;
 *   - **discovery as a candidate** — "look for more options" is itself an
 *     action the market buys only when P(hidden useful) × loss it would avoid
 *     exceeds what looking costs. It is never unconditional;
 *   - **the proposal lane** — the frontier agent (or System-1) may propose up
 *     to three novel interventions. They are normalized, fingerprinted and
 *     priced by the same funnel; the proposer never chooses.
 *
 *  Nothing here encodes a task workflow. A dormant entry is a capability ("look
 *  at what depends on the code before changing it"), its carry-out is advice
 *  the agent is free to ignore, and whether it is worth offering is learned. */
import { createHash } from 'node:crypto';
import { clamp01 } from '../efficiency/policy-types.js';
import { actionCandidate, isActionKind, type ActionCandidate, type ActionKind } from '../decision/actions.js';
import type { EconomicState, UncertaintyKind } from '../decision/state.js';
import { UNCERTAINTY_KINDS } from '../decision/uncertainty.js';
import { meanUncertainty, usdPerToken } from '../decision/utility.js';
import { DEEP_EVALUATION_TOKEN_COST } from '../decision/fast-path.js';
import { candidateFingerprint } from '../decision/transition.js';
import { contractOf, unmetPreconditions, type ActionContract } from './contracts.js';
import type { SourceCoverage } from '../decision/deep-path.js';
import type { RiskSnapshot } from './risk.js';

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export type CandidateSourceCoverage = SourceCoverage;

/** Fills feasible/rejected from what the market did with each source's
 *  proposals. Pure. */
export function settleCoverage(
  coverage: CandidateSourceCoverage[],
  snapshots: Array<{ source: string; status: string }>,
): CandidateSourceCoverage[] {
  return coverage.map((c) => {
    const mine = snapshots.filter((s) => s.source === c.source);
    return { ...c, feasible: mine.filter((s) => s.status !== 'rejected').length, rejected: mine.filter((s) => s.status === 'rejected').length };
  });
}

// ---------------------------------------------------------------------------
// Action-space uncertainty
// ---------------------------------------------------------------------------

export interface ActionSpaceInputs {
  state: EconomicState;
  coverage: CandidateSourceCoverage[];
  /** How unfamiliar this state is: 1/(1 + times a state like it was seen). */
  novelty: number;
  /** Shrunk rate of confirmed candidate-space misses in states like this. */
  generationMissRate: number;
}

/** U_action, by noisy-OR of three independent reasons to doubt coverage:
 *  an unfamiliar state with real doubt in it, sources that failed to report,
 *  and a history of the useful option being absent here. Each reaches zero on
 *  its own when its reason is absent, so a familiar, healthy state with
 *  working sources scores zero and discovery stays dormant. */
export function actionSpaceUncertainty(input: ActionSpaceInputs): number {
  const invoked = input.coverage.filter((c) => c.invoked);
  const failed = invoked.filter((c) => c.error).length;
  const sourceFailure = invoked.length === 0 ? 0 : failed / invoked.length;
  const unfamiliar = clamp01(input.novelty) * meanUncertainty(input.state);
  return clamp01(1 - (1 - unfamiliar) * (1 - sourceFailure) * (1 - clamp01(input.generationMissRate)));
}

// ---------------------------------------------------------------------------
// The dormant pool
// ---------------------------------------------------------------------------

export interface DormantCandidate {
  fingerprint: string;
  kind: ActionKind;
  capability: string;
  /** What the agent is told if the market buys this — advice, never a step it
   *  must take. */
  advice: string;
  addresses: UncertaintyKind[];
  /** Share of the doubt in each addressed dimension it removes, declared;
   *  causal memory learns how true that is. */
  effect: number;
  /** Cost as a share of the remaining budget, so one entry prices sensibly on
   *  a small task and a large one. */
  costShare: number;
  preconditions?: ActionContract['preconditions'];
  reversibility?: number;
  origin: 'registry' | 'motif' | 'proposal';
}

/** Generic interventions in the harness's space that no default source
 *  proposes. Each names a *capability*, applies to any repository, and leaves
 *  every decision about the work to the agent. Their declared effects are
 *  priors that causal memory replaces with measured effectiveness. */
export const DORMANT_REGISTRY: readonly DormantCandidate[] = [
  {
    fingerprint: 'dormant:inspect-dependents', kind: 'acquire_evidence', capability: 'evidence.dependents',
    advice: 'Before changing shared code, look at what calls or depends on it, so the change does not break a caller you have not seen.',
    addresses: ['behavioral'], effect: 0.5, costShare: 0.03, origin: 'registry',
  },
  {
    fingerprint: 'dormant:reproduce-first', kind: 'validate', capability: 'validation.reproduce',
    advice: 'Reproduce the reported behaviour with the smallest command you can before changing code, and re-run that same command afterwards.',
    addresses: ['target', 'validation'], effect: 0.5, costShare: 0.05, origin: 'registry',
  },
  {
    fingerprint: 'dormant:read-design', kind: 'acquire_evidence', capability: 'evidence.design',
    advice: 'Read the module-level documentation or the nearest design notes for the area you are about to change before editing it.',
    addresses: ['structural'], effect: 0.5, costShare: 0.02, origin: 'registry',
  },
  {
    fingerprint: 'dormant:checkpoint', kind: 'constrain', capability: 'workspace.checkpoint',
    advice: 'Keep the next change small and self-contained so it can be undone cleanly if it turns out to be wrong.',
    addresses: [], effect: 0, costShare: 0.005, reversibility: 1, origin: 'registry',
    preconditions: [{ field: 'progress', op: '>=', value: 0.01 }],
  },
  {
    fingerprint: 'dormant:narrow-check', kind: 'validate', capability: 'validation.narrow',
    advice: 'Run the narrowest existing test that exercises what you changed before you report the work as done.',
    addresses: ['validation'], effect: 0.6, costShare: 0.04, origin: 'registry',
    preconditions: [{ field: 'progress', op: '>=', value: 0.01 }],
  },
];

/** The candidate a dormant entry becomes in this state. */
export function activateDormant(
  entry: DormantCandidate,
  state: EconomicState,
  learnedPrior = 0.5,
): ActionCandidate {
  const remaining = state.resources.remainingTokens;
  const uncertaintyEffects: Partial<Record<UncertaintyKind, number>> = {};
  for (const kind of entry.addresses) uncertaintyEffects[kind] = entry.effect;
  return actionCandidate({
    id: entry.fingerprint,
    kind: entry.kind,
    capability: entry.capability,
    expectedInformationGain: entry.addresses.length > 0 ? entry.effect : 0,
    tokenCost: Math.round(remaining * entry.costShare),
    latencyCost: 5_000,
    // What history says about whether this helps in states like this one; an
    // unproven entry is believed at the prior's middle, never more.
    confidence: clamp01(learnedPrior) * clamp01(state.trajectory.orchestrationConfidence, 0.5),
    metadata: {
      fingerprint: entry.fingerprint,
      addresses: entry.addresses,
      advice: entry.advice,
      candidateSource: `dormant:${entry.origin}`,
      ...(entry.reversibility === undefined ? {} : { reversibility: entry.reversibility }),
      contract: {
        preconditions: entry.preconditions ?? [],
        uncertaintyEffects,
        evidenceProduced: entry.addresses.map((k) => `doubt:${k}`),
        evidenceConsumed: [],
        effects: [],
        resourceEffects: [],
        reversibility: entry.reversibility ?? 1,
      },
    },
  });
}

/** Cheap compatibility: the entry's preconditions hold, it addresses doubt the
 *  state actually has (or reversibility the state actually needs), and the
 *  budget can carry it. A number on [0,1], not a verdict — the market decides. */
export function compatibility(entry: DormantCandidate, state: EconomicState): number {
  const contract = contractOf(activateDormant(entry, state));
  if (unmetPreconditions(contract, state).length > 0) return 0;
  if (entry.addresses.length === 0) return clamp01(state.trajectory.progress * (1 - state.validation.confidence));
  return Math.max(...entry.addresses.map((k) => state.uncertainty[k]));
}

export interface DormantPool {
  entries(): DormantCandidate[];
  add(entry: DormantCandidate): void;
  /** Compatible entries not already on the table, best first, at most `limit`. */
  activate(
    state: EconomicState,
    exclude: ReadonlySet<string>,
    limit: number,
    prior?: (fingerprint: string) => number,
  ): ActionCandidate[];
}

export function createDormantPool(seed: readonly DormantCandidate[] = DORMANT_REGISTRY): DormantPool {
  const byFingerprint = new Map(seed.map((e) => [e.fingerprint, e]));
  return {
    entries: () => [...byFingerprint.values()],
    add(entry) { if (!byFingerprint.has(entry.fingerprint)) byFingerprint.set(entry.fingerprint, entry); },
    activate(state, exclude, limit, prior = () => 0.5) {
      return [...byFingerprint.values()]
        .filter((e) => !exclude.has(e.fingerprint))
        .map((e) => ({ e, score: compatibility(e, state) * prior(e.fingerprint) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || (a.e.fingerprint < b.e.fingerprint ? -1 : 1))
        .slice(0, Math.max(0, limit))
        .map(({ e }) => activateDormant(e, state, prior(e.fingerprint)));
    },
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export type DiscoveryTier = 'registry' | 'semantic' | 'agent_proposal';

/** What each tier costs the run, in tokens. Registry retrieval is arithmetic
 *  over memory (the deep path's own price); a semantic expansion is one
 *  bounded System-1 question; inviting the agent to propose costs the prompt
 *  line plus the agent's answer. */
export function discoveryTierCost(tier: DiscoveryTier, state: EconomicState): number {
  if (tier === 'registry') return DEEP_EVALUATION_TOKEN_COST;
  if (tier === 'semantic') return Math.ceil(0.002 / usdPerToken(state));
  return 400;
}

export const DISCOVERY_ID = 'governor:discover';

/** The discovery candidate, or null when looking cannot pay.
 *
 *  DiscoveryValue = U_action × E[loss avoided if something useful is found]
 *  − cost. The loss a found option could avoid is bounded by the exposure no
 *  option on the table already covers; the cheapest available tier is
 *  offered, since a richer tier is only worth it once a cheaper one ran dry. */
export function discoveryCandidate(input: {
  state: EconomicState;
  risk: RiskSnapshot;
  known: ActionCandidate[];
  /** Mean learned P(beneficial) of what the pool could still offer. */
  poolPrior: number;
  tiers: DiscoveryTier[];
}): ActionCandidate | null {
  const { state, risk } = input;
  if (input.tiers.length === 0 || risk.actionSpaceUncertainty <= 0 || risk.riskExposure <= 0) return null;
  const tier = input.tiers[0];
  const cost = discoveryTierCost(tier, state);
  const gain = risk.actionSpaceUncertainty * clamp01(input.poolPrior) * risk.riskExposure;
  if (gain <= cost) return null;
  return actionCandidate({
    id: DISCOVERY_ID,
    kind: 'explore',
    capability: 'governor.discover',
    // Credited as work it may make unnecessary, at the market's own exchange
    // rate; it reduces no task doubt by itself, so it addresses nothing.
    expectedTokenBenefit: gain,
    tokenCost: tier === 'registry' ? 0 : cost,
    orchestrationCost: tier === 'registry' ? cost : 0,
    confidence: risk.confidence,
    metadata: { discovery: { tier, actionSpaceUncertainty: risk.actionSpaceUncertainty }, candidateSource: 'governor', addresses: [] },
  });
}

// ---------------------------------------------------------------------------
// The proposal lane
// ---------------------------------------------------------------------------

/** No more than this many proposals per decision, from anyone. */
export const MAX_PROPOSALS = 3;

export interface InterventionProposal {
  description: string;
  addresses?: string[];
  kind?: string;
  estimatedTokens?: number;
}

/** A proposal, normalized into a candidate the funnel can price. The
 *  fingerprint is a hash of the normalized description, so the same idea
 *  proposed twice is one candidate with one history. Unproven proposals are
 *  believed little; what they earn is learned. */
export function normalizeProposals(
  raw: unknown,
  state: EconomicState,
  source: 'agent' | 'system1',
  prior: (fingerprint: string) => number = () => 0.4,
): ActionCandidate[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: ActionCandidate[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (out.length >= MAX_PROPOSALS) break;
    const p = item as InterventionProposal;
    if (!p || typeof p.description !== 'string') continue;
    const description = p.description.replace(/\s+/g, ' ').trim().slice(0, 400);
    if (description.length < 8) continue;
    const fingerprint = `proposal:${createHash('sha256').update(description.toLowerCase()).digest('hex').slice(0, 12)}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const addresses = (Array.isArray(p.addresses) ? p.addresses : [])
      .filter((a): a is UncertaintyKind => (UNCERTAINTY_KINDS as readonly string[]).includes(a as string));
    const kind: ActionKind = typeof p.kind === 'string' && isActionKind(p.kind) && p.kind !== 'stop' && p.kind !== 'continue'
      ? p.kind : 'acquire_evidence';
    const tokens = Number.isFinite(p.estimatedTokens) && (p.estimatedTokens as number) > 0
      ? Math.min(p.estimatedTokens as number, state.resources.remainingTokens) : Math.round(state.resources.remainingTokens * 0.03);
    out.push(actionCandidate({
      id: fingerprint, kind, capability: `proposal.${source}`,
      expectedInformationGain: addresses.length > 0 ? 0.5 : 0,
      tokenCost: tokens,
      confidence: clamp01(prior(fingerprint)) * clamp01(state.trajectory.orchestrationConfidence, 0.5),
      metadata: { fingerprint, addresses, advice: description, candidateSource: `proposal:${source}` },
    }));
  }
  return out;
}

/** Proposals the agent wrote into its output, in a fenced
 *  ```intervention-proposals block holding a JSON array. A parser, not a
 *  judgement: anything else in the text is ignored. */
export function extractProposals(text: string): unknown[] {
  const match = /```intervention-proposals\s*\n([\s\S]*?)```/.exec(text ?? '');
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The one line added to a dispatch when the market bought the agent-proposal
 *  tier of discovery. Never present otherwise. */
export const PROPOSAL_INVITATION =
  'If you see an intervention the runtime could make that would prevent rework (for example, a check or a read you would want before committing), you may list up to three in a ```intervention-proposals JSON block: [{"description": "...", "addresses": ["structural"|"behavioral"|"validation"|"target"]}]. This is optional.';

export function fingerprintOf(candidate: ActionCandidate): string {
  return candidateFingerprint(candidate);
}
