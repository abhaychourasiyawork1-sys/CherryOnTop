import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { runChecks } from '../../doctor/checks.js';
import { BINARY_PROBES, CHECKS, nodeVersionCheck, probe } from './doctor.js';

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

// Regression: kubectl rejects `--version`, so a shared probe flag reported an
// installed kubectl as "not found". Any binary on PATH must probe successfully.
describe('binary probes detect an installed binary', () => {
  for (const [bin, args] of Object.entries(BINARY_PROBES)) {
    it(`probes ${bin} with args it accepts`, async () => {
      const onPath = await execa('sh', ['-c', `command -v ${bin}`]).then(() => true).catch(() => false);
      if (!onPath) {
        console.log(`${bin} not on PATH — skipping its probe assertion`);
        return;
      }
      if (bin === 'docker') return; // `docker info` needs a reachable daemon, not just the binary
      expect(await probe(bin, args)).toBe(true);
    });
  }
});
