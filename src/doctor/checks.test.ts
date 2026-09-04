import { describe, it, expect } from 'vitest';
import { runChecks, type DoctorCheck } from './checks.js';

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
