/** What a sandbox needs beyond the one mounted worktree to work the way the
 *  same agent works on the host: git history, the project's toolchain, and
 *  tests that run in the foreground. Each gap cost turns on SWE-bench
 *  (docs/superpowers/2026-09-25-swebench-cost-root-cause.md, RC1-RC3). */
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { toContainerPath } from './kind.js';

export interface ExtraMount {
  /** The path the kind node sees (`/host/...`). */
  hostPath: string;
  /** Where the pod sees it. */
  mountPath: string;
  readOnly: boolean;
}

/** A linked git worktree's `.git` is a *file* naming a directory inside the
 *  main repository, by its absolute host path. Only the worktree is mounted,
 *  so every git command in the pod failed with "not a git repository" and the
 *  agent explored its way to the original code instead of `git diff`.
 *
 *  Mounted at the same absolute path the file names. The shared repository
 *  (objects, refs) is read-only, so an agent cannot rewrite the user's branches
 *  from inside the sandbox; the worktree's own admin directory (index, HEAD)
 *  stays writable so status and diff can refresh it. */
export function gitMounts(worktreeHostPath: string): ExtraMount[] {
  const dotGit = path.join(worktreeHostPath, '.git');
  let pointer: string;
  try {
    if (!statSync(dotGit).isFile()) return []; // an ordinary repo: already inside the mount
    pointer = readFileSync(dotGit, 'utf8');
  } catch {
    return [];
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return [];
  const gitdir = path.resolve(worktreeHostPath, match[1].trim());
  let common = gitdir;
  try {
    common = path.resolve(gitdir, readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
  } catch {
    // No commondir: a standalone gitdir, mounted whole below.
  }
  try {
    return [
      { hostPath: toContainerPath(common), mountPath: common, readOnly: true },
      ...(gitdir === common ? [] : [{ hostPath: toContainerPath(gitdir), mountPath: gitdir, readOnly: false }]),
    ];
  } catch {
    return []; // outside $HOME: not visible to the cluster, git stays unavailable
  }
}

/** Host directories an operator lends the sandbox read-only
 *  (`ORG_SANDBOX_TOOLCHAIN`, comma-separated), e.g. a conda install that already
 *  has a project's dependencies. The runner image has a bare python and no
 *  project packages, so every run spent turns pip-installing before a single
 *  test would run, while the same agent on the host ran pytest once. Mounted at
 *  the same absolute path, so interpreters that locate their libraries from
 *  their own path keep working, and each `bin/` goes first on PATH — for the
 *  container and, through CLAUDE_ENV_FILE, for the agent's shell. */
export function toolchainMounts(env: NodeJS.ProcessEnv = process.env): { mounts: ExtraMount[]; env: { name: string; value: string }[] } {
  const dirs = (env.ORG_SANDBOX_TOOLCHAIN ?? '').split(',').map((d) => d.trim()).filter(Boolean);
  const mounts: ExtraMount[] = [];
  const bins: string[] = [];
  for (const dir of dirs) {
    // A hostPath of type Directory that does not exist leaves the pod in
    // ContainerCreating for good; a typo must cost the mount, not the run.
    if (!existsSync(dir)) {
      console.error(`ORG_SANDBOX_TOOLCHAIN: skipping ${dir}: it does not exist`);
      continue;
    }
    try {
      mounts.push({ hostPath: toContainerPath(dir), mountPath: dir, readOnly: true });
    } catch (err) {
      console.error(`ORG_SANDBOX_TOOLCHAIN: skipping ${dir}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    if (existsSync(path.join(dir, 'bin'))) bins.push(path.join(dir, 'bin'));
  }
  // A lent conda install is read-only, so `conda create` failed and the agent
  // built environments by hand (sklearn: 15-23 environment calls per run
  // against 4.7 on the host, where the same conda was writable). New envs and
  // downloads go to the sandbox's home; the lent package cache is still read
  // first, so most packages come from it instead of the network.
  const condaRoots = dirs.filter((dir) => existsSync(path.join(dir, 'bin', 'conda')));
  const conda = condaRoots.length === 0 ? [] : [
    { name: 'CONDA_ENVS_PATH', value: '/home/node/.conda/envs' },
    { name: 'CONDA_PKGS_DIRS', value: ['/home/node/.conda/pkgs', ...condaRoots.map((d) => path.join(d, 'pkgs'))].join(',') },
  ];
  return bins.length === 0 ? { mounts, env: conda } : {
    mounts,
    env: [
      // The container's own processes.
      { name: 'PATH', value: [...bins, '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'].join(':') },
      // Claude Code's Bash tool, which builds its own PATH and ignores the
      // container's; it sources this file (see the Dockerfile) instead.
      { name: 'ORG_TOOLCHAIN_PATH', value: bins.join(':') },
      { name: 'CLAUDE_ENV_FILE', value: '/etc/org-sandbox-env.sh' },
      ...conda,
    ],
  };
}

/** What the agent should be told about its sandbox, so it does not spend
 *  turns finding out. Measured on scikit-learn: an agent that did not know conda
 *  could create environments hand-built two venvs (~10 calls), and `git stash`
 *  failing on the read-only history cost three more. */
export function sandboxNotes(worktreeHostPath: string | null, env: NodeJS.ProcessEnv = process.env): string[] {
  const notes: string[] = [];
  const dirs = (env.ORG_SANDBOX_TOOLCHAIN ?? '').split(',').map((d) => d.trim()).filter((d) => d && existsSync(d));
  for (const dir of dirs) {
    const python = ['python3', 'python'].map((b) => path.join(dir, 'bin', b)).find((b) => existsSync(b));
    if (python) notes.push(`\`${python}\` is on PATH (read-only; \`pip install\` goes to your user site).`);
    if (existsSync(path.join(dir, 'bin', 'conda'))) {
      notes.push('To test against pinned or old dependencies, `conda create -y -n <name> python=<ver> <pkgs>` works and is fast (it reuses a local package cache); build the project inside that env.');
    }
  }
  if (worktreeHostPath && gitMounts(worktreeHostPath).length > 0) {
    notes.push('Git history is read-only: `git diff`, `git log` and `git show HEAD:<path>` work; `git stash`, `commit` and `checkout -b` do not. Compare against the original with `git show HEAD:<path>`.');
  }
  return notes;
}

/** Environment every sandboxed runtime gets.
 *
 *  Background tasks off: headless `--print` runs auto-backgrounded long test
 *  runs and then spent turns polling them (seaborn: 17 wait/poll calls, which
 *  is what pushed it over its turn cap). With them off, a test runs in the
 *  foreground under a timeout long enough for a real suite. */
export const SANDBOX_ENV: ReadonlyArray<{ name: string; value: string }> = [
  { name: 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', value: '1' },
  { name: 'CLAUDE_CODE_DISABLE_CRON', value: '1' },
  // Prompt weight nothing in a one-shot sandbox reads: auto-memory (written to
  // a home directory that is thrown away), the bundled skills, and the built-in
  // Explore/Plan subagents (CherryOnTop plans and delegates itself).
  { name: 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', value: '1' },
  { name: 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS', value: '1' },
  { name: 'CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS', value: '1' },
  { name: 'BASH_DEFAULT_TIMEOUT_MS', value: '600000' },
  { name: 'BASH_MAX_TIMEOUT_MS', value: '1800000' },
  // The mounted tree belongs to the host user; the pod's uid may not match.
  { name: 'GIT_CONFIG_COUNT', value: '1' },
  { name: 'GIT_CONFIG_KEY_0', value: 'safe.directory' },
  { name: 'GIT_CONFIG_VALUE_0', value: '*' },
];
