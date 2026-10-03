/** Where an owned dispatch's tools run: a process boundary CherryOnTop
 *  crosses only with an argv and (optionally) stdin. Nothing else about the
 *  host — its environment, its API key, its files — reaches the far side.
 *
 *  Two substrates, the same two `executeStep` already dispatches to:
 *   - an existing container (`ORG_EXEC_CONTAINER`, a benchmark's task
 *     environment) via `docker exec`;
 *   - a Kubernetes pod the owned runtime starts for the dispatch and execs
 *     into with `kubectl exec`. */
import { execa } from 'execa';
import type { ContainerTarget } from '../execution/container-exec.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ExecOptions {
  stdin?: string;
  timeoutMs?: number;
}

export interface Sandbox {
  /** Absolute work directory inside the sandbox; every command starts there. */
  readonly workdir: string;
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
  close(): Promise<void>;
}

/** Runs `argv` from `workdir`, for transports with no working-directory flag. */
export function inWorkdir(workdir: string, argv: string[]): string[] {
  return ['sh', '-c', 'cd "$1" || exit 97; shift; exec "$@"', 'sh', workdir, ...argv];
}

/** Bytes kept from one stream of one command. A runaway `cat` of a log must not
 *  take the daemon's memory with it; the tool layer bounds what the model sees
 *  far below this. */
const STREAM_CAP = 8 * 1024 * 1024;

export async function runProcess(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const r = await execa(file, args, {
    reject: false,
    input: opts.stdin ?? '',
    maxBuffer: STREAM_CAP,
    stripFinalNewline: false,
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  });
  return {
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    exitCode: typeof r.exitCode === 'number' ? r.exitCode : (r.timedOut ? 124 : 1),
    timedOut: r.timedOut === true,
  };
}

export function containerSandbox(target: ContainerTarget): Sandbox {
  const env = [...(target.path ? ['-e', `PATH=${target.path}`] : []), ...(target.user ? ['-u', target.user] : [])];
  return {
    workdir: target.workdir,
    exec: (argv, opts) => runProcess(target.docker, ['exec', '-i', '-w', target.workdir, ...env, target.container, ...argv], opts),
    close: async () => {},
  };
}

export interface PodRef {
  name: string;
  namespace: string;
  container: string;
  workdir: string;
}

export function podSandbox(pod: PodRef, close: () => Promise<void>): Sandbox {
  return {
    workdir: pod.workdir,
    exec: async (argv, opts) => {
      const r = await runProcess('kubectl', ['exec', '-i', '-n', pod.namespace, pod.name, '-c', pod.container, '--', ...inWorkdir(pod.workdir, argv)], opts);
      // kubectl's own note about the exit status, not the command's output.
      return { ...r, stderr: r.stderr.replace(/command terminated with exit code \d+\n?$/, '') };
    },
    close,
  };
}

/** Runs on this machine, in `workdir`. For tests and offline replay only: it is
 *  no isolation at all, so nothing in the runtime constructs one. */
export function hostSandbox(workdir: string): Sandbox {
  return {
    workdir,
    exec: (argv, opts) => runProcess('sh', inWorkdir(workdir, argv).slice(1), opts),
    close: async () => {},
  };
}

/** What the work directory holds, for the first message: the top-level
 *  entries and, in a repository, its uncommitted state. Bounded; empty when
 *  the sandbox cannot say. Claude Code opens with the same orientation (a git
 *  status snapshot); without it an agent spends turns finding where it is. */
export async function workdirSnapshot(sandbox: Sandbox): Promise<string> {
  const r = await sandbox.exec(['sh', '-c', 'ls -Ap | head -60; if git rev-parse --git-dir >/dev/null 2>&1; then echo "--- git status --short (first 30)"; git status --short | head -30; fi'], { timeoutMs: 15_000 }).catch(() => null);
  const text = r?.exitCode === 0 ? r.stdout.trim() : '';
  return text ? `Contents of the work directory ${sandbox.workdir}:\n${text}` : '';
}
