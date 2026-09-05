import os from 'node:os';
import path from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { execa } from 'execa';
import { applyDefaultDenyPolicy } from './network-policy.js';

// G5 fix: a Job's hostPath resolves inside the kind node's own filesystem, not
// on the real host, so nothing under $HOME was visible to a runner until the
// cluster itself bind-mounts it. $HOME is broad, but extraMounts are fixed at
// cluster-creation time — a narrower per-repo mount would mean recreating the
// cluster per `org run`. This is a disposable local cluster on your own machine.
const HOST_MOUNT_PATH = '/host';

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

async function hasHostMount(): Promise<boolean> {
  try {
    const { stdout } = await execa('docker', ['inspect', `${CLUSTER_NAME}-control-plane`, '--format', '{{json .Mounts}}']);
    const mounts = JSON.parse(stdout) as { Destination: string }[];
    return mounts.some((m) => m.Destination === HOST_MOUNT_PATH);
  } catch {
    return false;
  }
}

async function createClusterWithHostMount(): Promise<void> {
  const configPath = path.join(os.tmpdir(), `org-kind-config-${Date.now()}.yaml`);
  const config = [
    'kind: Cluster',
    'apiVersion: kind.x-k8s.io/v1alpha4',
    'nodes:',
    '- role: control-plane',
    '  extraMounts:',
    `  - hostPath: ${os.homedir()}`,
    `    containerPath: ${HOST_MOUNT_PATH}`,
  ].join('\n');
  writeFileSync(configPath, config);
  try {
    await execa('kind', ['create', 'cluster', '--name', CLUSTER_NAME, '--config', configPath], { timeout: 180_000 });
  } finally {
    unlinkSync(configPath);
  }
}

/** Translates a real host path into the path a Job sees, via the /host mount. */
export function toContainerPath(hostPath: string): string {
  const relative = path.relative(os.homedir(), hostPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${hostPath} is outside the home directory — it is not visible inside the cluster. Move your repository under ${os.homedir()}, or pass --repo with a path under it.`);
  }
  return path.posix.join(HOST_MOUNT_PATH, relative);
}

export async function ensureLocalCluster(): Promise<void> {
  const alreadyUp = (await hasExistingKubeconfigContext()) && (await isClusterReachable());

  if (alreadyUp && !(await hasHostMount())) {
    // A disposable local dev cluster — recreating it is the correct fix, not a
    // workaround. kind cannot add extraMounts to a cluster after creation.
    console.log('Existing kind cluster lacks the /host mount — recreating it...');
    await execa('kind', ['delete', 'cluster', '--name', CLUSTER_NAME]).catch(() => {});
    await createClusterWithHostMount();
  } else if (!alreadyUp) {
    const { stdout } = await execa('kind', ['get', 'clusters']).catch(() => ({ stdout: '' }));
    if (stdout.split('\n').includes(CLUSTER_NAME)) {
      await execa('kind', ['delete', 'cluster', '--name', CLUSTER_NAME]).catch(() => {});
    }
    await createClusterWithHostMount();
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

// Only knowable once a cluster exists, so it can't be a module-level constant.
export async function getKubeDnsClusterIp(): Promise<string> {
  const { stdout } = await execa('kubectl', [
    'get', 'svc', 'kube-dns', '-n', 'kube-system', '-o', 'jsonpath={.spec.clusterIP}',
  ]);
  return stdout.trim();
}
