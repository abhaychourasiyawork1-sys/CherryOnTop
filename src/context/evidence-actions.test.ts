import { describe, it, expect, vi } from 'vitest';
import {
  requestEvidenceAtBoundary, renderAcquiredEvidence, MAX_ARTIFACT_BYTES,
  type EvidenceRequest, type EvidenceAcquisitionDeps,
} from './evidence-actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from '../decision/state.js';

const WORKTREE = '/repo';

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: 100_000, qualityFloor: 0.7 });
  return normalizeEconomicState({ ...base, ...over });
}

const request = (over: Partial<EvidenceRequest> = {}): EvidenceRequest => ({
  candidateId: 'src/auth/session.ts',
  evidenceLevel: 'L3',
  expectedBenefit: 6_000,
  acquisitionCost: 400,
  qualityRisk: 0,
  reasonCodes: ['selector:worth_opening'],
  ...over,
});

function deps(over: Partial<EvidenceAcquisitionDeps> = {}): EvidenceAcquisitionDeps {
  return {
    sizeOf: vi.fn(() => 1_600),
    read: vi.fn(() => 'export function refreshSession() {}'),
    ...over,
  };
}

const acquire = (over: Partial<Parameters<typeof requestEvidenceAtBoundary>[0]> = {}, d = deps()) =>
  requestEvidenceAtBoundary(
    { state: state(), request: request(), worktreePath: WORKTREE, repositoryRevision: 'abc123', ...over },
    d,
  );

describe('acquisition that pays for itself', () => {
  it('acquires an artifact whose expected benefit exceeds its cost', async () => {
    const result = await acquire();
    expect(result.acquired).toBe(true);
    expect(result.content).toContain('refreshSession');
    expect(result.reasonCodes).toContain('acquired');
  });

  it('measures what it actually cost rather than repeating the estimate', async () => {
    const result = await acquire({}, deps({ read: () => 'x'.repeat(4_000) }));
    expect(result.tokens).toBe(1_000);
    expect(result.tokens).not.toBe(request().acquisitionCost);
  });

  it('records provenance a later run can check the freshness of', async () => {
    const result = await acquire();
    expect(result.evidence).toMatchObject({
      kind: 'fact',
      source: 'read:L3:src/auth/session.ts',
      repositoryRevision: 'abc123',
    });
    expect(result.evidence!.tokenCost).toBe(result.tokens);
  });

  it('is less confident about evidence it cannot tie to a revision', async () => {
    const tied = await acquire();
    const loose = await acquire({ repositoryRevision: undefined });
    expect(loose.evidence!.confidence).toBeLessThan(tied.evidence!.confidence);
  });

  it('gives one artifact one stable id per revision', async () => {
    const a = await acquire();
    const b = await acquire();
    expect(a.evidence!.id).toBe(b.evidence!.id);
  });
});

describe('acquisition that does not', () => {
  it('refuses a request whose benefit does not cover its cost', async () => {
    const result = await acquire({ request: request({ expectedBenefit: 100, acquisitionCost: 400 }) });
    expect(result.acquired).toBe(false);
    expect(result.tokens).toBe(0);
    expect(result.reasonCodes).toContain('negative_net_value');
  });

  it('refuses a request that would breach the quality floor, however much it saves', async () => {
    const result = await acquire({
      request: request({ expectedBenefit: 1_000_000, qualityRisk: 0.5 }),
    });
    expect(result.acquired).toBe(false);
    expect(result.reasonCodes).toContain('quality_floor');
  });

  it('refuses to spend tokens the task does not have', async () => {
    const nearlySpent = state({ resources: { ...state().resources, consumedTokens: 99_900 } });
    const result = await acquire({ state: nearlySpent });
    expect(result.acquired).toBe(false);
    expect(result.reasonCodes).toContain('insufficient_budget');
  });

  it('will not eat the recovery reserve', async () => {
    const reserved = state({
      resources: { ...state().resources, consumedTokens: 99_000, recoveryReserve: 800 },
    });
    const result = await acquire({ state: reserved });
    expect(result.acquired).toBe(false);
    expect(result.reasonCodes).toContain('insufficient_budget');
  });

  it('acquires nothing once the task is over', async () => {
    const done = state({ constraints: { qualityFloor: 0.7, hardStop: true } });
    expect((await acquire({ state: done })).reasonCodes).toContain('hard_stop');
  });

  it('keeps the reasons the request arrived with, so a refusal is traceable', async () => {
    const result = await acquire({ request: request({ expectedBenefit: 0 }) });
    expect(result.reasonCodes).toContain('selector:worth_opening');
  });
});

describe('the bounds that stop this becoming expensive', () => {
  it('refuses a file above the ceiling rather than truncating it', async () => {
    const d = deps({ sizeOf: () => MAX_ARTIFACT_BYTES + 1 });
    const result = await acquire({}, d);
    expect(result.acquired).toBe(false);
    expect(result.reasonCodes).toContain('artifact_too_large');
    // And never opened it: the size check is what avoids loading it at all.
    expect(d.read).not.toHaveBeenCalled();
  });

  it('reads exactly one artifact and follows nothing', async () => {
    const d = deps({ read: vi.fn(() => "import './neighbour.js';\nimport './other.js';") });
    const result = await acquire({}, d);
    expect(result.acquired).toBe(true);
    expect(d.read).toHaveBeenCalledTimes(1);
  });

  it('takes one request, not a list — the cascade is closed off by the signature', () => {
    // A compile-time property, asserted here so a future widening of the
    // parameter is a failing test rather than a quiet change of contract.
    expect(requestEvidenceAtBoundary.length).toBeLessThanOrEqual(2);
  });
});

describe('reading stays inside the worktree', () => {
  it('refuses an absolute path', async () => {
    const d = deps();
    const result = await acquire({ request: request({ candidateId: '/etc/passwd' }) }, d);
    expect(result.reasonCodes).toContain('path_outside_worktree');
    expect(d.sizeOf).not.toHaveBeenCalled();
  });

  it('refuses a path that climbs out of the tree', async () => {
    const result = await acquire({ request: request({ candidateId: '../../etc/passwd' }) });
    expect(result.reasonCodes).toContain('path_outside_worktree');
  });

  it('refuses an empty path', async () => {
    expect((await acquire({ request: request({ candidateId: '' }) })).reasonCodes)
      .toContain('path_outside_worktree');
  });

  it('reads relative to the worktree it was given', async () => {
    const d = deps();
    await acquire({}, d);
    expect(d.sizeOf).toHaveBeenCalledWith('/repo/src/auth/session.ts');
  });
});

describe('failure is a refusal, never a thrown dispatch', () => {
  it('refuses an unreadable path', async () => {
    expect((await acquire({}, deps({ sizeOf: () => null }))).reasonCodes).toContain('unreadable');
  });

  it('refuses when the read itself throws', async () => {
    const result = await acquire({}, deps({ read: () => { throw new Error('EACCES'); } }));
    expect(result.acquired).toBe(false);
    expect(result.reasonCodes).toContain('read_failed');
  });
});

describe('renderAcquiredEvidence', () => {
  it('labels the block with where it came from', () => {
    const rendered = renderAcquiredEvidence('src/a.ts', 'const a = 1;');
    expect(rendered).toContain('src/a.ts');
    expect(rendered).toContain('const a = 1;');
    expect(rendered).toContain('```');
  });
});
