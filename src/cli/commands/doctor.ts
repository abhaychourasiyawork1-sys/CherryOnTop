import type { Command } from 'commander';
import { execa } from 'execa';
import { runChecks, type DoctorCheck } from '../../doctor/checks.js';
import { isClusterReachable, ensureLocalCluster } from '../../k8s/kind.js';

async function binaryPresent(bin: string, versionFlag = '--version'): Promise<boolean> {
  try {
    await execa(bin, [versionFlag]);
    return true;
  } catch {
    return false;
  }
}

// Takes the version string so the floor is testable without spawning another Node.
// Corrected floor: package.json's engines.node is >=22 (execa/better-sqlite3
// require it — see the "ci: run on Node 22" commit) but this check said >=20
// until this fix, so it silently passed on unsupported versions.
export function nodeVersionCheck(version: string): DoctorCheck {
  return {
    name: 'Node.js version',
    run: async () => {
      const major = Number(version.split('.')[0]);
      return major >= 22
        ? { ok: true, message: `v${version}` }
        : { ok: false, message: `v${version} — need >= 22` };
    },
  };
}

export const CHECKS: DoctorCheck[] = [
  nodeVersionCheck(process.versions.node),
  {
    name: 'Docker',
    run: async () => (await binaryPresent('docker'))
      ? { ok: true, message: 'installed' }
      : { ok: false, message: 'not found — install Docker (required for the local kind cluster)' },
  },
  {
    name: 'kind',
    run: async () => (await binaryPresent('kind'))
      ? { ok: true, message: 'installed' }
      : { ok: false, message: 'not found — install kind: https://kind.sigs.k8s.io/docs/user/quick-start/' },
  },
  {
    name: 'kubectl',
    run: async () => (await binaryPresent('kubectl'))
      ? { ok: true, message: 'installed' }
      : { ok: false, message: 'not found — install kubectl: https://kubernetes.io/docs/tasks/tools/' },
  },
  {
    name: 'Kubernetes cluster',
    run: async () => {
      if (await isClusterReachable()) return { ok: true, message: 'reachable' };
      if (!(await binaryPresent('kind'))) {
        return { ok: false, message: 'no cluster, and kind is not installed to bootstrap one — fix the kind check above first' };
      }
      try {
        await ensureLocalCluster();
        return { ok: true, message: 'bootstrapped a local kind cluster' };
      } catch (err) {
        return { ok: false, message: `could not reach or bootstrap a cluster: ${String(err)}` };
      }
    },
  },
];

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check that required dependencies are present')
    .action(async () => {
      const ok = await runChecks(CHECKS);
      process.exitCode = ok ? 0 : 1;
    });
}
