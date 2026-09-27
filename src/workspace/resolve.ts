import { toContainerPath, fromContainerPath } from '../k8s/kind.js';
import { resolveRepoPath } from '../cli/validation.js';

export type ResolvedRepo =
  | { ok: true; hostPath: string; containerPath: string }
  | { ok: false; error: string };

/** Where a Workspace's work would run, decided on the host that owns the
 *  files. Accepts either a host path (a folder the person picked) or a sandbox
 *  path (a Workspace known from earlier runs), and applies the same two rules
 *  `org run` and `org gui` do: it must be a git repository, and it must be
 *  visible inside the sandbox mount. Anything else is refused with a sentence
 *  saying why, rather than a run that hangs on a path that does not exist. */
export function resolveWorkspaceRepo(input: string): ResolvedRepo {
  try {
    const raw = input.trim();
    if (!raw) return { ok: false, error: 'No folder was given.' };
    const host = raw.startsWith('/host/') || raw === '/host' ? fromContainerPath(raw) : raw;
    if (!host) return { ok: false, error: `${raw} is not a folder this machine can work in.` };
    const hostPath = resolveRepoPath(host);
    return { ok: true, hostPath, containerPath: toContainerPath(hostPath) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
