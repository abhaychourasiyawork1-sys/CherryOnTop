import { describe, it, expect } from 'vitest';
import { runChecks } from '../../doctor/checks.js';
import { CHECKS, nodeVersionCheck } from './doctor.js';

describe('doctor Node version check (corrected floor)', () => {
  it('passes for Node 22', async () => {
    expect(await runChecks([nodeVersionCheck('22.22.2')])).toBe(true);
  });

  it('fails for Node 20 — this is the bug found in Phase 1 review: it used to pass', async () => {
    expect(await runChecks([nodeVersionCheck('20.11.0')])).toBe(false);
  });
});

describe('doctor check list', () => {
  it('checks Node, Docker, kind, kubectl and the cluster', () => {
    expect(CHECKS.map((c) => c.name)).toEqual([
      'Node.js version', 'Docker', 'kind', 'kubectl', 'Kubernetes cluster',
    ]);
  });
});
