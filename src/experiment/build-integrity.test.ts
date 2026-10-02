import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { checkBuildIntegrity, computeBuildFingerprint, sha256, tagMessage, type IntegrityDeps } from './build-integrity.js';

const ROOT = '/repo';
const CONFIG = '/repo/bench/governor/h26/config.json';
const KEYFILE = '/secret/h26.key';

/** A fully valid frozen build, as files and git answers; each test breaks one thing. */
function world() {
  const key = randomBytes(32);
  const files = new Map<string, Buffer>([
    [CONFIG, Buffer.from(JSON.stringify({ experimentId: 'x', keyCommitment: sha256(key) }))],
    [join(ROOT, 'package-lock.json'), Buffer.from('{"lockfileVersion":3}')],
    [join(ROOT, 'node_modules', '.package-lock.json'), Buffer.from('{"installed":true}')],
    [join(ROOT, 'dist', 'a.js'), Buffer.from('export const a = 1;')],
    [join(ROOT, 'dist', 'sub', 'b.js'), Buffer.from('export const b = 2;')],
    [KEYFILE, Buffer.from(key.toString('hex') + '\n')],
  ]);
  const state = { head: 'c0ffee', tagCommit: 'c0ffee', status: '', node: 'v22.22.2', tagMessage: '' };
  const deps = (): IntegrityDeps => ({
    repoRoot: ROOT, configPath: CONFIG, keyFile: KEYFILE, nodeVersion: state.node,
    readFile: (p) => { const f = files.get(p); if (!f) throw new Error(`ENOENT ${p}`); return f; },
    listFiles: (dir) => [...files.keys()].filter((p) => p.startsWith(dir + '/')),
    git: (args) => {
      const cmd = args.join(' ');
      if (cmd === 'rev-parse h26-prereg^{commit}') return state.tagCommit + '\n';
      if (cmd === 'rev-parse HEAD') return state.head + '\n';
      if (cmd === 'cat-file tag h26-prereg') return `object ${state.tagCommit}\ntype commit\ntag h26-prereg\n\n${state.tagMessage}\n`;
      if (cmd.startsWith('status')) return state.status;
      throw new Error(`unexpected git ${cmd}`);
    },
  });
  state.tagMessage = tagMessage(deps());
  return { files, state, deps, key };
}

describe('the tagged-build invariant', () => {
  it('passes on the exact frozen build', () => {
    const w = world();
    const v = checkBuildIntegrity(w.deps());
    expect(v.ok).toBe(true);
  });

  const cases: Array<[string, (w: ReturnType<typeof world>) => void]> = [
    ['tagged-commit', (w) => { w.state.head = 'deadbeef'; }],
    ['clean-tree', (w) => { w.state.status = '?? stray.txt\n'; }],
    ['config-hash', (w) => { w.files.set(CONFIG, Buffer.from(w.files.get(CONFIG)!.toString().replace('"x"', '"y"'))); }],
    ['dependency-state', (w) => { w.files.set(join(ROOT, 'package-lock.json'), Buffer.from('{"lockfileVersion":2}')); }],
    ['dependency-state', (w) => { w.files.set(join(ROOT, 'node_modules', '.package-lock.json'), Buffer.from('{"installed":false}')); }],
    ['build-fingerprint', (w) => { w.files.set(join(ROOT, 'dist', 'a.js'), Buffer.from('export const a = 2;')); }],
    ['build-fingerprint', (w) => { w.state.node = 'v20.11.0'; }],
    ['key-commitment', (w) => { w.files.set(KEYFILE, Buffer.from(randomBytes(32).toString('hex'))); }],
  ];
  for (const [check, breakIt] of cases) {
    it(`refuses when only ${check} is violated (${breakIt.toString().slice(8, 60)}…)`, () => {
      const w = world();
      breakIt(w);
      const v = checkBuildIntegrity(w.deps());
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.check).toBe(check);
    });
  }

  it('refuses a lightweight tag (no fingerprints in its message)', () => {
    const w = world();
    w.state.tagMessage = '';
    const v = checkBuildIntegrity(w.deps());
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.check).toBe('tagged-commit');
  });

  it('refuses when the key file is missing', () => {
    const w = world();
    const v = checkBuildIntegrity({ ...w.deps(), keyFile: undefined });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.check).toBe('key-commitment');
  });

  it('the build fingerprint covers every dist file and the Node version, independent of listing order', () => {
    const w = world();
    const a = computeBuildFingerprint(w.deps());
    const reversed = { ...w.deps(), listFiles: (d: string) => w.deps().listFiles(d).reverse() };
    expect(computeBuildFingerprint(reversed)).toBe(a);
    w.files.set(join(ROOT, 'dist', 'c.js'), Buffer.from(''));
    expect(computeBuildFingerprint(w.deps())).not.toBe(a);
  });
});
