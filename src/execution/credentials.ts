import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Where Claude Code's own CLI keeps a logged-in subscription's OAuth tokens.
 *  Undocumented, but stable across recent CLI versions; relaying this file is
 *  the whole trick — it needs no OAuth flow of our own. */
export function oauthCredentialsPath(homeDir: string): string {
  return path.join(homeDir, '.claude', '.credentials.json');
}

export function hasOauthCredentials(homeDir: string): boolean {
  return existsSync(oauthCredentialsPath(homeDir));
}

/** A subscription (via `claude login`) is preferred over an API key: it costs
 *  the user nothing extra, and unlike ANTHROPIC_API_KEY it is read fresh from
 *  disk on every dispatch, so there's no daemon-restart staleness to manage. */
export function resolveCredentials(homeDir: string, apiKeyEnv: string | undefined): Record<string, string> {
  if (hasOauthCredentials(homeDir)) {
    return { CLAUDE_CREDENTIALS_JSON: readFileSync(oauthCredentialsPath(homeDir), 'utf8') };
  }
  if (apiKeyEnv) return { ANTHROPIC_API_KEY: apiKeyEnv };
  return {};
}
