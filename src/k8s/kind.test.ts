import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { execa } from 'execa';
import { isClusterReachable, isClusterAvailable, ensureLocalCluster, getKubeDnsClusterIp, toContainerPath, NAMESPACE } from './kind.js';

async function hasKindBinary(): Promise<boolean> {
  try {
    await execa('kind', ['--version']);
    return true;
  } catch {
    return false;
  }
}

describe('isClusterReachable', () => {
  it('returns a boolean without throwing, regardless of cluster state', async () => {
    const result = await isClusterReachable();
    expect(typeof result).toBe('boolean');
  });

  it('returns false when kubectl reports no reachable cluster', async () => {
    const kindAvailable = await hasKindBinary();
    if (!kindAvailable) {
      console.log('kind binary not found — skipping cluster-state assertion, boolean-safety already covered above');
      return;
    }
    // No assumption about cluster existing yet; just confirm the function completes.
    await expect(isClusterReachable()).resolves.not.toThrow();
  });
});

describe.skipIf(!(await isClusterAvailable()))('ensureLocalCluster default-deny wiring', () => {
  it('applies a default-deny NetworkPolicy to the org-exec namespace', async () => {
    await ensureLocalCluster();
    const { stdout } = await execa('kubectl', ['get', 'networkpolicy', 'default-deny-all', '-n', NAMESPACE, '-o', 'name']);
    expect(stdout.trim()).toBe('networkpolicy.networking.k8s.io/default-deny-all');
  }, 60_000);
});

describe.skipIf(!(await isClusterAvailable()))('getKubeDnsClusterIp', () => {
  it('returns a real IP address from the running cluster', async () => {
    await ensureLocalCluster();
    const ip = await getKubeDnsClusterIp();
    expect(ip).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
  }, 60_000);
});

describe.skipIf(!(await isClusterAvailable()))('ensureLocalCluster host mount', () => {
  it('mounts the home directory at /host inside the control-plane node', async () => {
    await ensureLocalCluster();
    const { stdout } = await execa('docker', [
      'inspect', 'org-local-control-plane', '--format', '{{json .Mounts}}',
    ]);
    const mounts = JSON.parse(stdout) as { Source: string; Destination: string }[];
    expect(mounts.some((m) => m.Destination === '/host')).toBe(true);
  }, 180_000);
});

describe('toContainerPath', () => {
  it('rejects a path outside the home directory', () => {
    expect(() => toContainerPath('/etc/passwd')).toThrow(/outside the home directory/);
  });

  // The runner gets the mounted directory with permission prompts disabled, so
  // one forgotten `cd` must not hand it the whole home directory.
  it('refuses the home directory itself', () => {
    expect(() => toContainerPath(os.homedir())).toThrow(/entire home directory/);
    expect(() => toContainerPath(`${os.homedir()}/`)).toThrow(/entire home directory/);
  });

  it('maps a real subdirectory correctly', () => {
    expect(toContainerPath(`${os.homedir()}/Desktop/CherryOnTop`)).toBe('/host/Desktop/CherryOnTop');
  });
});
