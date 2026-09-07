import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkCredentials } from './credentials.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });

function home(credentials?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cred-'));
  dirs.push(dir);
  if (credentials !== undefined) {
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', '.credentials.json'), JSON.stringify(credentials));
  }
  return dir;
}

const NOW = 1_800_000_000_000;

describe('checkCredentials', () => {
  it('accepts a subscription token that has not expired', () => {
    expect(checkCredentials(home({ claudeAiOauth: { expiresAt: NOW + 60_000 } }), undefined, NOW))
      .toEqual({ ok: true });
  });

  it('refuses an expired one before a sandbox is spent on it', () => {
    // The real failure mode: the sandbox gets a copy of the token and no route
    // to refresh it, so it burns a full run to come back with a 401.
    const status = checkCredentials(home({ claudeAiOauth: { expiresAt: NOW - 60_000 } }), undefined, NOW);
    expect(status.ok).toBe(false);
    expect(status.reason).toContain('claude login');
  });

  it('falls back to an API key when the subscription token has expired', () => {
    expect(checkCredentials(home({ claudeAiOauth: { expiresAt: NOW - 60_000 } }), 'sk-ant-x', NOW))
      .toEqual({ ok: true });
  });

  it('does not invent a problem when no expiry was recorded', () => {
    // Older CLI versions wrote no expiresAt. Refusing on that would block a
    // perfectly good login.
    expect(checkCredentials(home({ claudeAiOauth: {} }), undefined, NOW)).toEqual({ ok: true });
  });

  it('reports an unreadable credentials file rather than dispatching blind', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cred-'));
    dirs.push(dir);
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', '.credentials.json'), 'not json');
    expect(checkCredentials(dir, undefined, NOW).ok).toBe(false);
  });

  it('refuses when there are no credentials at all', () => {
    const status = checkCredentials(home(), undefined, NOW);
    expect(status.ok).toBe(false);
    expect(status.reason).toContain('ANTHROPIC_API_KEY');
  });
});
