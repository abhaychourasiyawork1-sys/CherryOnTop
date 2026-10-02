/** The H2.6 tagged-build invariant (bench/governor/h26/DESIGN.md §4).
 *
 *  An assignment may be drawn only from the exact build the pre-registration
 *  froze. Six checks, every one required, in the design's order:
 *
 *   1. tagged-commit     HEAD is exactly `<preregTag>^{commit}` (`h26-prereg`)
 *   2. clean-tree        `git status --porcelain --untracked-files=all` is empty
 *   3. config-hash       SHA-256(config) = the tag's `configSha256`
 *   4. dependency-state  SHA-256(package-lock.json) = `lockfileSha256` and
 *                        SHA-256(node_modules/.package-lock.json) = `installedTreeSha256`
 *   5. build-fingerprint the recomputed dist/ + Node.js fingerprint = `buildFingerprint`
 *   6. key-commitment    SHA-256(key) = `keyCommitment` (tag and config agree)
 *
 *  The fingerprints live in the annotated tag's message, `name = hex` per line;
 *  the key lives outside git. Every input is injected, so each check can be
 *  violated alone in a test. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const DEFAULT_TAG = 'h26-prereg';

export type IntegrityCheck =
  | 'tagged-commit' | 'clean-tree' | 'config-hash' | 'dependency-state' | 'build-fingerprint' | 'key-commitment';

export interface IntegrityDeps {
  repoRoot: string;
  configPath: string;
  keyFile: string | undefined;
  /** Runs git in the repository; throws on a non-zero exit. */
  git: (args: string[]) => string;
  readFile: (path: string) => Buffer;
  /** Every file under a directory, recursively. */
  listFiles: (dir: string) => string[];
  nodeVersion: string;
}

export interface TagFingerprints {
  configSha256: string;
  lockfileSha256: string;
  installedTreeSha256: string;
  buildFingerprint: string;
  keyCommitment: string;
}

export type IntegrityVerdict =
  | { ok: true; commit: string; fingerprints: TagFingerprints }
  | { ok: false; check: IntegrityCheck; detail: string };

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** SHA-256 over the sorted `path\0sha256(file)\n` lines of every file under
 *  dist/, then the Node.js version string. */
export function computeBuildFingerprint(deps: Pick<IntegrityDeps, 'repoRoot' | 'readFile' | 'listFiles' | 'nodeVersion'>): string {
  const dist = join(deps.repoRoot, 'dist');
  const lines = deps.listFiles(dist)
    .map((file) => `${relative(dist, file).split(sep).join('/')}\0${sha256(deps.readFile(file))}\n`)
    .sort();
  const h = createHash('sha256');
  for (const line of lines) h.update(line);
  h.update(deps.nodeVersion);
  return h.digest('hex');
}

export function parseTagMessage(raw: string): Partial<TagFingerprints> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = /^(configSha256|lockfileSha256|installedTreeSha256|buildFingerprint|keyCommitment) = ([0-9a-f]{64})$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out as Partial<TagFingerprints>;
}

/** Every check, in order; the first that fails is the verdict. */
export function checkBuildIntegrity(deps: IntegrityDeps): IntegrityVerdict {
  const fail = (check: IntegrityCheck, detail: string): IntegrityVerdict => ({ ok: false, check, detail });
  const tryGit = (args: string[]): string | null => { try { return deps.git(args).trim(); } catch { return null; } };
  // The tag the configuration names (`h26-prereg` for the experiment).
  let PREREG_TAG = DEFAULT_TAG;
  try { PREREG_TAG = JSON.parse(deps.readFile(deps.configPath).toString('utf8')).preregTag ?? DEFAULT_TAG; } catch { return fail('config-hash', 'config unreadable'); }
  if (!/^h26-[a-z0-9-]+$/.test(PREREG_TAG)) return fail('config-hash', 'config names an invalid tag');

  // 1. The exact tagged commit.
  const tagged = tryGit(['rev-parse', `${PREREG_TAG}^{commit}`]);
  const head = tryGit(['rev-parse', 'HEAD']);
  if (!tagged) return fail('tagged-commit', `tag ${PREREG_TAG} not found`);
  if (head !== tagged) return fail('tagged-commit', `HEAD ${head} is not ${PREREG_TAG} (${tagged})`);
  const message = tryGit(['cat-file', 'tag', PREREG_TAG]);
  const fp = parseTagMessage(message ?? '');
  const missing = (['configSha256', 'lockfileSha256', 'installedTreeSha256', 'buildFingerprint', 'keyCommitment'] as const)
    .filter((k) => !fp[k]);
  if (missing.length > 0) return fail('tagged-commit', `${PREREG_TAG} is not an annotated tag carrying ${missing.join(', ')}`);
  const f = fp as TagFingerprints;

  // 2. A clean working tree.
  const status = tryGit(['status', '--porcelain', '--untracked-files=all']);
  if (status === null || status.length > 0) return fail('clean-tree', status === null ? 'git status failed' : 'working tree is not clean');

  const hashOf = (path: string): string | null => { try { return sha256(deps.readFile(path)); } catch { return null; } };

  // 3. The frozen experiment configuration.
  if (hashOf(deps.configPath) !== f.configSha256) return fail('config-hash', 'config does not match configSha256');

  // 4. The frozen dependency state: the lockfile, and what `npm ci` installed.
  if (hashOf(join(deps.repoRoot, 'package-lock.json')) !== f.lockfileSha256) return fail('dependency-state', 'package-lock.json does not match lockfileSha256');
  if (hashOf(join(deps.repoRoot, 'node_modules', '.package-lock.json')) !== f.installedTreeSha256) return fail('dependency-state', 'installed tree does not match installedTreeSha256');

  // 5. The build itself, and the runtime that runs it.
  let build: string;
  try { build = computeBuildFingerprint(deps); } catch { return fail('build-fingerprint', 'dist/ could not be read'); }
  if (build !== f.buildFingerprint) return fail('build-fingerprint', 'dist/ or the Node.js version does not match buildFingerprint');

  // 6. The key, against the commitment the tag and the config both carry.
  let configCommitment: unknown;
  try { configCommitment = JSON.parse(deps.readFile(deps.configPath).toString('utf8')).keyCommitment; } catch { configCommitment = null; }
  if (configCommitment !== f.keyCommitment) return fail('key-commitment', 'config keyCommitment differs from the tag');
  if (!deps.keyFile) return fail('key-commitment', 'ORG_EXPERIMENT_KEY_FILE is not set');
  let key: Buffer;
  try { key = Buffer.from(deps.readFile(deps.keyFile).toString('utf8').trim(), 'hex'); } catch { return fail('key-commitment', 'key file unreadable'); }
  if (key.length !== 32 || sha256(key) !== f.keyCommitment) return fail('key-commitment', 'key does not match keyCommitment');

  return { ok: true, commit: tagged, fingerprints: f };
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFilesRecursive(path));
    else out.push(path);
  }
  return out;
}

/** The real filesystem and git, for production. */
export function systemIntegrityDeps(repoRoot: string, configPath: string, keyFile: string | undefined): IntegrityDeps {
  return {
    repoRoot, configPath, keyFile,
    git: (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    readFile: (path) => readFileSync(path),
    listFiles: listFilesRecursive,
    nodeVersion: process.version,
  };
}

/** The annotated tag's message for the build in `repoRoot`, for Phase 11:
 *  `node dist/experiment/build-integrity.js --tag-message <config>`. */
export function tagMessage(deps: IntegrityDeps): string {
  const config = deps.readFile(deps.configPath);
  const keyCommitment = JSON.parse(config.toString('utf8')).keyCommitment;
  return [
    'H2.6 recover-eligibility pre-registration (bench/governor/h26/DESIGN.md)',
    '',
    `configSha256 = ${sha256(config)}`,
    `lockfileSha256 = ${sha256(deps.readFile(join(deps.repoRoot, 'package-lock.json')))}`,
    `installedTreeSha256 = ${sha256(deps.readFile(join(deps.repoRoot, 'node_modules', '.package-lock.json')))}`,
    `buildFingerprint = ${computeBuildFingerprint(deps)}`,
    `keyCommitment = ${keyCommitment}`,
  ].join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('build-integrity.js') && process.argv[2] === '--tag-message') {
  const repoRoot = process.cwd();
  console.log(tagMessage(systemIntegrityDeps(repoRoot, process.argv[3] ?? 'bench/governor/h26/config.json', undefined)));
}
