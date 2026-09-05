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

// Three states, not two: "I looked and it is absent" is a reason to recreate the
// cluster, but "I could not look" (docker socket permission denied, daemon
// restarting) must never be — the caller's response to `false` is deletion.
// Source is checked too: a cluster mounting a *different* home would satisfy a
// destination-only check while producing a silently broken /host mapping.
async function hasHostMount(): Promise<boolean | 'unknown'> {
  try {
    const { stdout } = await execa('docker', ['inspect', `${CLUSTER_NAME}-control-plane`, '--format', '{{json .Mounts}}']);
    const mounts = JSON.parse(stdout) as { Source: string; Destination: string }[];
    return mounts.some((m) => m.Destination === HOST_MOUNT_PATH && m.Source === os.homedir());
  } catch {
    return 'unknown';
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
  // '' means hostPath IS the home directory. Mounting it would hand the runner
  // write access to every file the user owns — SSH keys included — which is one
  // forgotten `cd` away from happening by accident.
  if (relative === '') {
    throw new Error(`${hostPath} is your entire home directory — refusing to mount it into the sandbox. cd into the repository you want worked on, or pass --repo <path>.`);
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${hostPath} is outside the home directory — it is not visible inside the cluster. Move your repository under ${os.homedir()}, or pass --repo with a path under it.`);
  }
  return path.posix.join(HOST_MOUNT_PATH, relative);
}

export async function ensureLocalCluster(): Promise<void> {
  const alreadyUp = (await hasExistingKubeconfigContext()) && (await isClusterReachable());
  const mount = await hasHostMount();

  if (mount === 'unknown' && alreadyUp) {
    // Could not inspect the node container, but the cluster answers — leave it
    // alone rather than deleting something we cannot even look at.
    console.warn(`Could not verify the ${HOST_MOUNT_PATH} mount on ${CLUSTER_NAME} (is Docker reachable?) — leaving the cluster as it is.`);
  } else if (alreadyUp && mount === false) {
    // kind cannot add extraMounts to a running cluster, so recreation is the
    // only fix. Scoped to our own disposable `org-local` cluster, and only when
    // we positively determined the mount is absent.
    console.log(`Existing kind cluster "${CLUSTER_NAME}" lacks the ${HOST_MOUNT_PATH} mount — recreating it...`);
    await execa('kind', ['delete', 'cluster', '--name', CLUSTER_NAME]).catch(() => {});
    await createClusterWithHostMount();
  } else if (!alreadyUp) {
    const { stdout } = await execa('kind', ['get', 'clusters']).catch(() => ({ stdout: '' }));
    const exists = stdout.split('\n').includes(CLUSTER_NAME);
    if (exists && mount === true) {
      // Present and correctly mounted, just missing from the kubeconfig —
      // re-exporting the context is the non-destructive fix.
      await execa('kind', ['export', 'kubeconfig', '--name', CLUSTER_NAME]);
    } else {
      if (exists) await execa('kind', ['delete', 'cluster', '--name', CLUSTER_NAME]).catch(() => {});
      await createClusterWithHostMount();
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

// Only knowable once a cluster exists, so it can't be a module-level constant.
export async function getKubeDnsClusterIp(): Promise<string> {
  const { stdout } = await execa('kubectl', [
    'get', 'svc', 'kube-dns', '-n', 'kube-system', '-o', 'jsonpath={.spec.clusterIP}',
  ]);
  const ip = stdout.trim();
  // An empty or non-IP result would otherwise become the CIDR "/32", failing
  // deep inside the k8s client with a message no user can act on.
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    throw new Error(`Could not read the cluster's kube-dns IP (got "${ip}") — is kubectl pointed at the ${CLUSTER_NAME} kind cluster?`);
  }
  return ip;
}
