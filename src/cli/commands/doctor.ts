import type { Command } from 'commander';
import { execa } from 'execa';
import * as clack from '@clack/prompts';
import { runChecks, type DoctorCheck } from '../../doctor/checks.js';
import { isClusterReachable, ensureLocalCluster } from '../../k8s/kind.js';

// Probe args are per-binary on purpose: kubectl rejects `--version` (it wants
// `version --client`), so a shared flag would report an installed kubectl as
// missing.
export async function probe(bin: string, args: string[]): Promise<boolean> {
  try {
    await execa(bin, args, { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

// Execa errors are multi-line and carry the whole subprocess dump; a doctor line
// wants the first line of it, not the transcript.
function firstLine(err: unknown): string {
  return String(err instanceof Error ? err.message : err).split('\n')[0];
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

// The probe each binary check uses, exported so a test can assert an installed
// binary is actually detected as installed.
export const BINARY_PROBES: Record<string, string[]> = {
  docker: ['info'],
  kind: ['--version'],
  kubectl: ['version', '--client'],
};

export const CHECKS: DoctorCheck[] = [
  nodeVersionCheck(process.versions.node),
  {
    name: 'Docker',
    // `docker info`, not `docker --version`: a client binary whose daemon the
    // user cannot reach fails every kind operation, so reporting it as
    // "installed" would be a lie that costs an hour of debugging later.
    run: async () => (await probe('docker', BINARY_PROBES.docker))
      ? { ok: true, message: 'daemon reachable' }
      : { ok: false, message: 'no reachable daemon — install Docker, and ensure your user can access /var/run/docker.sock' },
  },
  {
    name: 'kind',
    run: async () => (await probe('kind', BINARY_PROBES.kind))
      ? { ok: true, message: 'installed' }
      : { ok: false, message: 'not found — install kind: https://kind.sigs.k8s.io/docs/user/quick-start/' },
  },
  {
    name: 'kubectl',
    run: async () => (await probe('kubectl', BINARY_PROBES.kubectl))
      ? { ok: true, message: 'installed' }
      : { ok: false, message: 'not found — install kubectl: https://kubernetes.io/docs/tasks/tools/' },
  },
  {
    name: 'Kubernetes cluster',
    run: async () => {
      const wasReachable = await isClusterReachable();
      if (!wasReachable && (!(await probe('kind', BINARY_PROBES.kind)) || !(await probe('docker', BINARY_PROBES.docker)))) {
        return { ok: false, message: 'no cluster, and no way to bootstrap one — fix the kind/Docker checks above first' };
      }
      try {
        // Called even when the cluster already answers: it is what reapplies the
        // org-exec namespace and its default-deny backstop, and what notices a
        // cluster missing the /host mount. Skipping it on the reachable path
        // meant a cluster could report green while lacking both.
        await ensureLocalCluster();
        return { ok: true, message: wasReachable ? 'reachable' : 'bootstrapped a local kind cluster' };
      } catch (err) {
        return { ok: false, message: `could not ${wasReachable ? 'verify' : 'bootstrap'} the cluster: ${firstLine(err)}` };
      }
    },
  },
  {
    name: 'Runner image',
    run: async () => {
      try {
        const { stdout } = await execa('sh', [
          '-c',
          'docker exec org-local-control-plane crictl images 2>/dev/null | grep -c cherryontop-runner || true',
        ]);
        return stdout.trim() !== '0' && stdout.trim() !== ''
          ? { ok: true, message: 'loaded into the cluster' }
          : { ok: false, message: 'not loaded — run ./scripts/build-runner-image.sh' };
      } catch (err) {
        return { ok: false, message: `could not check — run ./scripts/build-runner-image.sh (${firstLine(err)})` };
      }
    },
  },
  {
    name: 'Anthropic API key',
    run: async () => process.env.ANTHROPIC_API_KEY
      ? { ok: true, message: 'set' }
      : { ok: false, message: 'ANTHROPIC_API_KEY is not set — export it before `org run` (get one at https://console.anthropic.com/settings/keys)' },
  },
];

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check that required dependencies are present')
    .action(async () => {
      const ok = await runChecks(CHECKS);
      if (ok) {
        clack.log.success('All checks passed — ready to run `org run`.');
      } else {
        clack.log.warn('Some checks failed. Re-run `org doctor` after fixing them — each failing line above names the missing piece and, where applicable, an install link.');
      }
      process.exitCode = ok ? 0 : 1;
    });
}
