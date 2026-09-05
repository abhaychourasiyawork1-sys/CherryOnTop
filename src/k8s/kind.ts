import { execa } from 'execa';
import { applyDefaultDenyPolicy } from './network-policy.js';

const CLUSTER_NAME = 'org-local';

export async function isClusterReachable(): Promise<boolean> {
  try {
    await execa('kubectl', ['cluster-info'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function commandSucceeds(bin: string, args: string[]): Promise<boolean> {
  try {
    await execa(bin, args, { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

// The guard integration tests skip on. Binary presence is not enough: kind is
// useless without a Docker daemon this user may actually talk to, so `docker
// info` (not `docker --version`) is what decides it.
export async function isClusterAvailable(): Promise<boolean> {
  if (await isClusterReachable()) return true;
  return (
    (await commandSucceeds('kind', ['--version'])) &&
    (await commandSucceeds('kubectl', ['version', '--client'])) &&
    (await commandSucceeds('docker', ['info']))
  );
}

async function hasExistingKubeconfigContext(): Promise<boolean> {
  try {
    const { stdout } = await execa('kubectl', ['config', 'current-context']);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export const NAMESPACE = 'org-exec';

export async function ensureLocalCluster(): Promise<void> {
  const alreadyUp = (await hasExistingKubeconfigContext()) && (await isClusterReachable());

  if (!alreadyUp) {
    const { stdout } = await execa('kind', ['get', 'clusters']).catch(() => ({ stdout: '' }));
    if (!stdout.split('\n').includes(CLUSTER_NAME)) {
      await execa('kind', ['create', 'cluster', '--name', CLUSTER_NAME], { timeout: 120_000 });
    }
  }

  // Always, never only on the create path: an existing cluster still needs the
  // namespace, and skipping it here left every executeStep failing on a
  // machine that already had a cluster.
  await ensureNamespace(NAMESPACE);
  // G1 fix: built and tested in Phase 2 but never actually called. The per-node
  // egress policy already implies deny-by-default for pods it selects; this is
  // the namespace-wide backstop for anything reaching org-exec another way.
  await applyDefaultDenyPolicy(NAMESPACE);
}

// kubectl rather than the API client: `create --dry-run | apply` is the one-liner
// for "create if absent", and this only runs at bootstrap.
async function ensureNamespace(namespace: string): Promise<void> {
  const { stdout } = await execa('kubectl', ['create', 'namespace', namespace, '--dry-run=client', '-o', 'yaml']);
  await execa('kubectl', ['apply', '-f', '-'], { input: stdout });
}
