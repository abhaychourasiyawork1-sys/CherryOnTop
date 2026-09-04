import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { createEphemeralSecret, deleteSecret } from './secrets.js';
import { isClusterReachable } from './kind.js';

// These tests talk to whatever cluster is already up; they don't bootstrap one.
const CLUSTER_AVAILABLE = await isClusterReachable();
if (!CLUSTER_AVAILABLE) {
  console.log('no reachable cluster — skipping ephemeral secret integration tests');
}

describe.skipIf(!CLUSTER_AVAILABLE)('ephemeral secrets', () => {
  it('creates a secret with the given credentials, then deletes it', async () => {
    const name = await createEphemeralSecret('n1', { GIT_TOKEN: 'fake-token-value' }, 'default');
    expect(name).toMatch(/^org-secret-n1-/);

    const { stdout } = await execa('kubectl', ['get', 'secret', name, '-n', 'default', '-o', 'jsonpath={.data.GIT_TOKEN}']);
    expect(Buffer.from(stdout, 'base64').toString('utf-8')).toBe('fake-token-value');

    await deleteSecret(name, 'default');
    await expect(execa('kubectl', ['get', 'secret', name, '-n', 'default'])).rejects.toThrow();
  }, 30_000);
});
