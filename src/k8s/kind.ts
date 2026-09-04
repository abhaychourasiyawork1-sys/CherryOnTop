import { execa } from 'execa';

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

export async function ensureLocalCluster(): Promise<void> {
  if (await hasExistingKubeconfigContext()) {
    if (await isClusterReachable()) return;
  }

  const { stdout } = await execa('kind', ['get', 'clusters']).catch(() => ({ stdout: '' }));
  if (!stdout.split('\n').includes(CLUSTER_NAME)) {
    await execa('kind', ['create', 'cluster', '--name', CLUSTER_NAME], { timeout: 120_000 });
  }

  await ensureNamespace('org-exec');
}

// kubectl rather than the API client: `create --dry-run | apply` is the one-liner
// for "create if absent", and this only runs at bootstrap.
async function ensureNamespace(namespace: string): Promise<void> {
  const { stdout } = await execa('kubectl', ['create', 'namespace', namespace, '--dry-run=client', '-o', 'yaml']);
  await execa('kubectl', ['apply', '-f', '-'], { input: stdout });
}
