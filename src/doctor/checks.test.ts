import { describe, it, expect } from 'vitest';
import { runChecks, probeModels, type DoctorCheck } from './checks.js';

describe('runChecks', () => {
  it('returns true when all checks pass', async () => {
    const checks: DoctorCheck[] = [
      { name: 'always ok', run: async () => ({ ok: true, message: 'fine' }) },
    ];
    expect(await runChecks(checks)).toBe(true);
  });

  it('returns false when any check fails', async () => {
    const checks: DoctorCheck[] = [
      { name: 'ok', run: async () => ({ ok: true, message: 'fine' }) },
      { name: 'broken', run: async () => ({ ok: false, message: 'missing dependency' }) },
    ];
    expect(await runChecks(checks)).toBe(false);
  });
});

describe('probeModels', () => {
  it('reports a model callable when the probe command succeeds', () => {
    const ok = probeModels(() => 'ok');
    expect(ok).toEqual({ haiku: true, sonnet: true });
  });
  it('reports a model not callable when its probe throws', () => {
    const res = probeModels((args) => {
      if (args.includes('haiku')) throw new Error('no access');
      return 'ok';
    });
    expect(res).toEqual({ haiku: false, sonnet: true });
  });
});
