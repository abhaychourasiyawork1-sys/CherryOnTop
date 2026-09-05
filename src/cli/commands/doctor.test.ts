import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  it('checks Node, Docker, kind, kubectl, the cluster, the runner image and the API key', () => {
    expect(CHECKS.map((c) => c.name)).toEqual([
      'Node.js version', 'Docker', 'kind', 'kubectl', 'Kubernetes cluster', 'Runner image', 'Claude authentication',
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

// os.homedir() respects $HOME on POSIX, so these override it to a scratch
// directory rather than touching the real machine's own ~/.claude — the dev
// box running this suite may have a genuine logged-in subscription.
describe('Claude authentication check', () => {
  it('passes when ANTHROPIC_API_KEY is set and no OAuth file exists', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    const originalHome = process.env.HOME;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-value';
    process.env.HOME = mkdtempSync(path.join(tmpdir(), 'org-doctor-'));
    try {
      const check = CHECKS.find((c) => c.name === 'Claude authentication');
      expect(check).toBeDefined();
      expect((await check!.run()).ok).toBe(true);
    } finally {
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
      rmSync(process.env.HOME!, { recursive: true, force: true });
      if (originalHome !== undefined) process.env.HOME = originalHome;
    }
  });

  it('passes on the OAuth file alone, with no API key set', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    const originalHome = process.env.HOME;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.HOME = mkdtempSync(path.join(tmpdir(), 'org-doctor-'));
    mkdirSync(path.join(process.env.HOME, '.claude'), { recursive: true });
    writeFileSync(path.join(process.env.HOME, '.claude', '.credentials.json'), '{}');
    try {
      const check = CHECKS.find((c) => c.name === 'Claude authentication');
      expect((await check!.run()).ok).toBe(true);
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
      rmSync(process.env.HOME!, { recursive: true, force: true });
      if (originalHome !== undefined) process.env.HOME = originalHome;
    }
  });

  it('fails when neither is available', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    const originalHome = process.env.HOME;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.HOME = mkdtempSync(path.join(tmpdir(), 'org-doctor-'));
    try {
      const check = CHECKS.find((c) => c.name === 'Claude authentication');
      expect((await check!.run()).ok).toBe(false);
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
      rmSync(process.env.HOME!, { recursive: true, force: true });
      if (originalHome !== undefined) process.env.HOME = originalHome;
    }
  });
});
