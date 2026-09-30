/** What is already known about whether a model can run on this account, learned
 *  from what happened the last time it was tried.
 *
 *  "Preflight" is usually a probe: ask the provider before spending anything.
 *  Here that would be a paid model call (or a sandbox) made to avoid a paid
 *  model call, so the cheap and honest version is the passive one — remember
 *  the refusal the runtime already gave, process-wide, for as long as it is
 *  likely to stay true. The runtime tells us "model X is not available on your
 *  plan" at the price of one wasted sandbox; this makes sure that is paid once
 *  per cooldown instead of once per node.
 *
 *  Three properties keep it from becoming an outage of its own:
 *
 *   - **Everything expires.** A block carries the time it stops being believed,
 *     and an expired one is forgotten rather than consulted: a plan upgrade, a
 *     quota reset or a transient outage must not turn into permanent
 *     disablement.
 *   - **Unknown means available.** Nothing observed, nothing blocked.
 *   - **It advises; it does not have the last word.** The market treats a block
 *     as soft (see `execution-market.ts`): if it would leave no candidate at all
 *     it is set aside, and the runtime's own fallback decides — so a stale block
 *     costs at most the sandbox it was trying to save.
 */
import { homedir } from 'node:os';
import { shouldRetryWithoutModel } from './tokens.js';
import { hasOauthCredentials } from './credentials.js';
import type { StructuredEvent } from '../adapters/adapter.js';

export type CapabilityFailure = 'model_unavailable' | 'auth' | 'rate_limited' | 'transient';

/** Stands for every model of a provider on an account (an auth failure is not
 *  about one model). */
export const ALL_MODELS = '*';

export interface CapabilityKey {
  provider: string;
  model: string;
  /** The kind of credential the run was billed to — see `accountKeyFor`. A model
   *  can be available on one account and not another. */
  account: string;
}

export interface ModelCapabilityState extends CapabilityKey {
  available: boolean;
  failureClass?: CapabilityFailure;
  checkedAt: string;
  cooldownUntil?: string;
  consecutiveFailures: number;
}

/** How long each failure is believed. A missing model entitlement is the
 *  longest, because nothing about a minute passing changes it; an unclassified
 *  transient error is the shortest and backs off if it keeps happening. */
export const COOLDOWN_MS = {
  model_unavailable: 30 * 60_000,
  auth: 10 * 60_000,
  rate_limited: 5 * 60_000,
  transient: 60_000,
  transientMax: 10 * 60_000,
} as const;

export interface CapabilityRegistry {
  observeFailure(key: CapabilityKey, failure: CapabilityFailure, untilMs?: number): ModelCapabilityState;
  observeSuccess(key: CapabilityKey): void;
  /** The live block that applies to this key (its own, or its provider's
   *  all-models one), or undefined. Expired entries are forgotten here. */
  state(key: CapabilityKey): ModelCapabilityState | undefined;
  isAvailable(key: CapabilityKey): boolean;
  clear(): void;
}

const idOf = (k: CapabilityKey): string => `${k.provider}\u0000${k.account}\u0000${k.model}`;

/** How long repeated failures are remembered for backoff after their block has
 *  lapsed. A model that failed, was retried the moment its cooldown ended and
 *  failed again is not a fresh case, so the second block is longer than the
 *  first — but a failure half an hour ago is history. */
const STRIKE_MEMORY_MS = 30 * 60_000;

export function createCapabilityRegistry(now: () => number = Date.now): CapabilityRegistry {
  const entries = new Map<string, ModelCapabilityState>();
  const strikes = new Map<string, { count: number; lastMs: number }>();

  const live = (id: string): ModelCapabilityState | undefined => {
    const entry = entries.get(id);
    if (!entry) return undefined;
    if (entry.cooldownUntil !== undefined && Date.parse(entry.cooldownUntil) <= now()) {
      entries.delete(id);
      return undefined;
    }
    return entry;
  };

  return {
    observeFailure(key, failure, untilMs) {
      const id = idOf(key);
      const earlier = strikes.get(id);
      const consecutiveFailures = earlier && now() - earlier.lastMs < STRIKE_MEMORY_MS ? earlier.count + 1 : 1;
      strikes.set(id, { count: consecutiveFailures, lastMs: now() });
      const base = failure === 'transient'
        ? Math.min(COOLDOWN_MS.transientMax, COOLDOWN_MS.transient * 2 ** (consecutiveFailures - 1))
        : COOLDOWN_MS[failure];
      const until = untilMs !== undefined && untilMs > now() ? untilMs : now() + base;
      const state: ModelCapabilityState = {
        ...key, available: false, failureClass: failure,
        checkedAt: new Date(now()).toISOString(), cooldownUntil: new Date(until).toISOString(),
        consecutiveFailures,
      };
      entries.set(id, state);
      return state;
    },
    observeSuccess(key) {
      entries.delete(idOf(key));
      strikes.delete(idOf(key));
    },
    state(key) {
      return live(idOf(key)) ?? live(idOf({ ...key, model: ALL_MODELS }));
    },
    isAvailable(key) {
      return this.state(key) === undefined;
    },
    clear() {
      entries.clear();
      strikes.clear();
    },
  };
}

/** The process-wide registry: quota and entitlement are per account, not per
 *  node, so every node in the daemon learns from every other's refusals. */
export const modelCapabilities: CapabilityRegistry = createCapabilityRegistry();

const AUTH_FAILURE =
  /invalid api key|authentication[_ ]error|oauth token (?:has )?expired|please run \/login|unauthori[sz]ed|\b401\b|credit balance is too low/i;

function lastResultText(events: StructuredEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'result') continue;
    const payload = events[i].payload as { is_error?: boolean; result?: unknown; subtype?: unknown } | null;
    if (payload?.is_error !== true) return null;
    return typeof payload.result === 'string' ? payload.result : String(payload.subtype ?? '');
  }
  return null;
}

/** What a failed run says about the model or the account, if anything. Only what
 *  the runtime *said* — a timeout or a turn cap is a fact about the task, and
 *  learning "this model is unavailable" from it would be a false block. */
export function classifyRuntimeFailure(events: StructuredEvent[]): 'model_unavailable' | 'auth' | null {
  const text = lastResultText(events);
  if (text === null) return null;
  // An entitlement or credential refusal happens at the first request, before
  // the agent has said or done anything. A run that got as far as a turn failed
  // for a reason of its own — and its error text can mention "model not found"
  // or "401" as the *subject of the task* (fixing an auth bug, say). Believing
  // that would block a model, fleet-wide, over one task's vocabulary.
  if (events.some((event) => event.type === 'assistant')) return null;
  if (shouldRetryWithoutModel(events)) return 'model_unavailable';
  return AUTH_FAILURE.test(text) ? 'auth' : null;
}

/** Which account a set of credentials bills to, by kind. The credential itself
 *  never becomes a key: this is stored, logged and compared. */
export function accountKeyFor(credentials: Record<string, string>): string {
  if ('CLAUDE_CREDENTIALS_JSON' in credentials) return 'subscription';
  if ('ANTHROPIC_API_KEY' in credentials || 'OPENAI_API_KEY' in credentials) return 'api-key';
  return 'none';
}

/** The account the daemon would bill a dispatch to right now, by kind: a login
 *  is preferred over an API key, the same order `resolveCredentials` uses. A
 *  stat and an env read — cheap enough for the market to ask on every choice. */
export function currentAccount(): string {
  try {
    if (hasOauthCredentials(homedir())) return 'subscription';
  } catch { /* fall through to the environment */ }
  return process.env.ANTHROPIC_API_KEY ? 'api-key' : 'none';
}
