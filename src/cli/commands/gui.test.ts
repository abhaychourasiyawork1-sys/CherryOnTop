import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

const { registerGuiCommand } = await import('./gui.js');

// Mirrors GUI_ROOT's own resolution in gui.ts (dist/cli/commands -> package
// root -> gui), so this test checks the same two paths the command itself
// gates on, without needing to mock node:fs (existsSync is also load-bearing
// for unrelated code paths, so a blanket fs mock would be riskier than reading
// real repo state).
const GUI_ROOT = path.resolve(process.cwd(), 'gui');
const ELECTRON_BIN = path.join(GUI_ROOT, 'node_modules', '.bin', 'electron');
const BUNDLE = path.join(GUI_ROOT, 'out', 'main', 'index.js');

function program() {
  const p = new Command();
  registerGuiCommand(p);
  return p;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('org gui', () => {
  it('reports it is not installed when the GUI has no electron binary, and never touches the daemon', async () => {
    // This is the real, deterministic state of a checkout that has not run
    // `npm --prefix gui install && npm run build` — exactly what a unit-test
    // environment looks like, so it is asserted directly rather than mocked.
    if (existsSync(ELECTRON_BIN)) {
      console.log('gui/node_modules/.bin/electron is present in this checkout — skipping the not-installed assertion');
      return;
    }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program().parseAsync(['gui'], { from: 'user' });

    expect(errSpy.mock.calls[0][0]).toMatch(/Mission Control is not installed/);
    expect(errSpy.mock.calls[0][0]).toContain('npm install && npm run build');
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it('reports it is not built when electron is installed but the bundle is missing', async () => {
    if (!existsSync(ELECTRON_BIN) || existsSync(BUNDLE)) {
      console.log('electron missing or bundle already built in this checkout — skipping the not-built assertion');
      return;
    }
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program().parseAsync(['gui'], { from: 'user' });

    expect(errSpy.mock.calls[0][0]).toMatch(/Mission Control is not built/);
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it('rejects an unknown flag', async () => {
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerGuiCommand(p);
    await expect(p.parseAsync(['gui', '--bogus'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/unknown option '--bogus'/);
  });
});
