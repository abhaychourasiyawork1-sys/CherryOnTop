import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isBuildStale } from './gui.js';

describe('isBuildStale', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function layout(sourceAt: number, builtAt: number) {
    root = mkdtempSync(path.join(os.tmpdir(), 'gui-'));
    mkdirSync(path.join(root, 'src', 'renderer'), { recursive: true });
    mkdirSync(path.join(root, 'out', 'renderer'), { recursive: true });
    const source = path.join(root, 'src', 'renderer', 'App.tsx');
    const built = path.join(root, 'out', 'renderer', 'index.html');
    writeFileSync(source, 'x');
    writeFileSync(built, 'x');
    utimesSync(source, sourceAt, sourceAt);
    utimesSync(built, builtAt, builtAt);
  }

  it('is stale when any source file is newer than the build', () => {
    layout(2_000, 1_000);
    expect(isBuildStale(root)).toBe(true);
  });

  it('is fresh when the build is newer', () => {
    layout(1_000, 2_000);
    expect(isBuildStale(root)).toBe(false);
  });
});
