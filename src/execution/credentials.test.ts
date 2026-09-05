import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCredentials, oauthCredentialsPath } from './credentials.js';

describe('resolveCredentials', () => {
  it('prefers the subscription OAuth file when present, over an API key', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'org-creds-'));
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(oauthCredentialsPath(home), '{"claudeAiOauth":{"accessToken":"tok"}}');
    try {
      const creds = resolveCredentials(home, 'sk-ant-should-be-ignored');
      expect(creds).toEqual({ CLAUDE_CREDENTIALS_JSON: '{"claudeAiOauth":{"accessToken":"tok"}}' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls back to ANTHROPIC_API_KEY when no OAuth file exists', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'org-creds-'));
    try {
      expect(resolveCredentials(home, 'sk-ant-real')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-real' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns no credentials when neither is available', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'org-creds-'));
    try {
      expect(resolveCredentials(home, undefined)).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
