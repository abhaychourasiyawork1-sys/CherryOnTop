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

/** When the relayed subscription token stops being usable, and why that matters:
 *  the sandbox receives a *copy* of the credentials file and runs behind a
 *  default-deny egress policy, so it cannot refresh an expired token the way the
 *  host CLI would. Dispatching with one spends a full sandbox run to fail on a
 *  401 several minutes later. */
export interface CredentialStatus {
  ok: boolean;
  reason?: string;
}

export function checkCredentials(
  homeDir: string,
  apiKeyEnv: string | undefined,
  now: number = Date.now(),
): CredentialStatus {
  if (hasOauthCredentials(homeDir)) {
    let expiresAt: number | undefined;
    try {
      const raw = JSON.parse(readFileSync(oauthCredentialsPath(homeDir), 'utf8')) as
        { claudeAiOauth?: { expiresAt?: unknown } };
      const value = raw.claudeAiOauth?.expiresAt;
      if (typeof value === 'number') expiresAt = value;
    } catch {
      return { ok: false, reason: 'Your Claude login file could not be read. Run `claude login` to sign in again.' };
    }
    // An unparseable or absent expiry is not evidence of a problem — older CLI
    // versions did not record one. Dispatch and let the run report the truth.
    if (expiresAt === undefined) return { ok: true };
    if (expiresAt > now) return { ok: true };
    if (apiKeyEnv) return { ok: true };
    return {
      ok: false,
      reason: `Your Claude login expired at ${new Date(expiresAt).toLocaleString()}. Run \`claude login\` to sign in again, then start this task once more. (The sandbox cannot refresh the token itself — it has no network route to do it.)`,
    };
  }
  if (apiKeyEnv) return { ok: true };
  return {
    ok: false,
    reason: 'No Claude credentials found. Run `claude login` to use your subscription, or export ANTHROPIC_API_KEY.',
  };
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
