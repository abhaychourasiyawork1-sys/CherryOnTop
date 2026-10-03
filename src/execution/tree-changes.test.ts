import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { treeState, treeChanges, withoutInstalledDependencies } from './tree-changes.js';

describe('treeChanges', () => {
  it('reports what a run changed by any means, and nothing that was already dirty and left alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    sh('init', '-q'); sh('config', 'user.email', 't@t'); sh('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'a.ts'), 'one\n');
    fs.writeFileSync(path.join(dir, 'gone.ts'), 'bye\n');
    sh('add', '.'); sh('commit', '-qm', 'init');
    fs.writeFileSync(path.join(dir, 'mine.ts'), 'user work\n');

    const before = treeState(dir)!;
    fs.writeFileSync(path.join(dir, 'a.ts'), 'two\n'); // e.g. `sed -i`
    fs.writeFileSync(path.join(dir, 'new.ts'), 'fresh\n');
    fs.rmSync(path.join(dir, 'gone.ts'));
    const changes = treeChanges(dir, before, treeState(dir)!);

    expect(changes.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'a.ts', before: 'one\n', after: 'two\n' },
      { path: 'gone.ts', before: 'bye\n', after: '' },
      { path: 'new.ts', before: '', after: 'fresh\n' },
    ]);
  });

  it('is null outside a git repository', () => {
    expect(treeState(fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-')))).toBeNull();
  });
});

describe('withoutInstalledDependencies', () => {
  it('drops a virtualenv (by its pyvenv.cfg, any name) and node_modules, keeps the work', () => {
    expect(withoutInstalledDependencies([
      'learned_dag.csv', 'venv/pyvenv.cfg', 'venv/lib/python3.12/site-packages/x.py', 'env2/pyvenv.cfg', 'env2/bin/python',
      'web/node_modules/a/index.js', 'src/venv_notes.md',
    ])).toEqual(['learned_dag.csv', 'src/venv_notes.md']);
  });
});
