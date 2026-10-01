/** Where a sandbox's hooks reach the daemon, and how a dispatch gets a session.
 *
 *  The sandbox's Claude Code posts each hook event to `/ic/hook/<token>` using
 *  its built-in `http` hook type, so nothing new runs in the sandbox apart from
 *  the one-line spill hook. The token is random per dispatch and is the only
 *  thing a request can name, so a sandbox can reach its own session and no
 *  other. An unknown token, a malformed body or a thrown error all answer `{}`,
 *  the no-op: the agent proceeds exactly as without a controller.
 *
 *  The listener is separate from the API. The tRPC API stays on loopback, and
 *  this one serves a single route on the interface the sandbox network can
 *  reach (the kind network's gateway).
 */
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { execa } from 'execa';
import type { Db } from '../db/client.js';
import { appendEvent } from '../db/queries/events.js';
import { perTokenRates } from '../execution/pricing.js';
import { compileHarnessRequest } from '../system1/compiler.js';
import { system1 } from '../system1/guard.js';
import { InfoSession, COMPONENTS, SPILL_DIR, type Component, type Judge, type Mode, type SessionResult } from './controller.js';
import {
  admitNegative, finishBelief, negativeFindings, recordFinish, recordRefetch, recordRefetchObservation, recordTurns,
  refetchBeliefs, refetchObservations, turnHistory,
} from './memory.js';
import { fitRefetchModel } from './refetch-model.js';

export interface IcEnv {
  mode: Mode;
  disabled: Set<Component>;
}

export function icEnv(env: NodeJS.ProcessEnv = process.env): IcEnv {
  const raw = (env.ORG_IC_MODE ?? 'shadow').trim().toLowerCase();
  const mode: Mode = raw === 'off' || raw === 'active' ? raw : 'shadow';
  const disabled = new Set((env.ORG_IC_DISABLE ?? '').split(',').map((s) => s.trim()).filter((s): s is Component => (COMPONENTS as readonly string[]).includes(s)));
  return { mode, disabled };
}

interface Live {
  session: InfoSession;
  nodeId: string;
  role: string;
  hookMs: number;
}

const sessions = new Map<string, Live>();
/** Nodes whose last dispatch finished unverified, waiting for validation's verdict. */
const pendingFinish = new Set<string>();
let advertised: { host: string; port: number } | null = null;

/** The address a sandbox pod uses to reach this host: the kind network's
 *  gateway, which is the node's address with the host part set to 1. */
export async function kindGatewayIp(): Promise<string | null> {
  try {
    const { stdout } = await execa('kubectl', ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'], { timeout: 5000 });
    const ip = stdout.trim().split(/\s+/)[0] ?? '';
    const parts = ip.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.1` : null;
  } catch {
    return null;
  }
}

/** Builds the listener. Separate from `startHookListener` so tests can inject. */
export function buildHookApp(): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  app.post('/ic/hook/:token', async (req) => {
    const live = sessions.get((req.params as { token: string }).token);
    if (!live || typeof req.body !== 'object' || req.body === null) return {};
    const started = Date.now();
    try {
      return await live.session.handle(req.body as Record<string, unknown>);
    } catch (err) {
      console.error(`Information control: hook failed for node ${live.nodeId}:`, err);
      return {};
    } finally {
      live.hookMs += Date.now() - started;
    }
  });
  return app;
}

export async function startHookListener(port: number, host?: string): Promise<{ host: string; port: number } | null> {
  const bindHost = host ?? (await kindGatewayIp());
  if (!bindHost) {
    console.error('Information control: no sandbox-reachable address found; hooks stay off for this daemon');
    return null;
  }
  try {
    await buildHookApp().listen({ port, host: bindHost });
    advertised = { host: bindHost, port };
    return advertised;
  } catch (err) {
    console.error(`Information control: could not listen on ${bindHost}:${port}; hooks stay off for this daemon:`, err);
    return null;
  }
}

/** For tests and for an embedding that runs its own listener. */
export function setAdvertisedHookAddress(address: { host: string; port: number } | null): void {
  advertised = address;
}

export function hookAddress(): { host: string; port: number } | null {
  return advertised;
}

/** The `--settings` a dispatch's runtime is started with. `spill` adds the
 *  command hook that keeps every shapeable output's full text in the sandbox,
 *  so a shaped observation is always one `Read` away from complete. */
export function hookSettings(url: string, spill: boolean): Record<string, unknown> {
  const http = [{ type: 'http', url, timeout: 15 }];
  const post: Array<Record<string, unknown>> = [{ matcher: 'Read|Bash|Grep|Glob|WebFetch|Edit|Write|MultiEdit|NotebookEdit', hooks: http }];
  if (spill) {
    post.push({ matcher: 'Bash|Grep|Glob|WebFetch', hooks: [{ type: 'command', command: SPILL_COMMAND, timeout: 15 }] });
  }
  return {
    hooks: {
      PreToolUse: [{ matcher: 'Read|Bash|Grep|Glob', hooks: http }],
      PostToolUse: post,
      Stop: [{ hooks: http }],
      PostCompact: [{ hooks: http }],
    },
  };
}

/** Writes the tool's text to `${SPILL_DIR}/<tool_use_id>.out`, with the same
 *  extraction `shape.extractText` uses, so the line numbers in a shaped view's
 *  footer refer to this file. Silent on any error: it must never fail a tool. */
export const SPILL_COMMAND = `node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d),r=j.tool_response,fs=require("fs");`
  + `const t=typeof r=="string"?r:r&&(typeof r.stdout=="string"||typeof r.stderr=="string")?[r.stdout,r.stderr].filter(Boolean).join("\\n")`
  + `:r&&typeof r.text=="string"?r.text:r&&Array.isArray(r.filenames)?r.filenames.join("\\n"):r&&typeof r.content=="string"?r.content`
  + `:r&&typeof r.result=="string"?r.result:JSON.stringify(r);fs.mkdirSync("${SPILL_DIR}",{recursive:true});`
  + `fs.writeFileSync("${SPILL_DIR}/"+String(j.tool_use_id).replace(/[^A-Za-z0-9_-]/g,"")+".out",t)}catch(e){}})'`;

export interface OpenSessionInput {
  db: Db;
  nodeId: string;
  taskRootId: string;
  role: string;
  goal: string;
  model: string | undefined;
  confidence: number;
  taskValueUsd: number;
  revision: string | null;
  env?: IcEnv;
}

export interface OpenedSession {
  token: string;
  /** `--settings` JSON for the runtime. */
  settings: string;
  /** The daemon address the sandbox's egress policy must allow. */
  egress: { host: string; port: number };
  observeEvent(event: { type: string; payload: unknown }): void;
  /** Closes the session and writes what it learned. */
  close(): SessionResult;
}

/** A controller session for one dispatch, or null when information control is
 *  off or has no reachable listener: the dispatch then runs as baseline. */
export function openSession(input: OpenSessionInput): OpenedSession | null {
  const env = input.env ?? icEnv();
  const address = advertised;
  if (env.mode === 'off' || !address) return null;
  const { db, nodeId } = input;
  const emit = (type: string, payload: Record<string, unknown>) => {
    try {
      appendEvent(db, { nodeId, type, payload, createdAt: new Date().toISOString() });
    } catch (err) {
      console.error(`Information control: could not record ${type}:`, err);
    }
  };
  const judge: Judge = async (surface, facts, stateVersion) => {
    const s1 = system1();
    if (!s1.ready()) return null;
    const request = compileHarnessRequest({ surface, goal: input.goal, facts, stateVersion });
    const [outcome] = await s1.judge(`ic:${nodeId}`, [request], { orchestration: 1 });
    const p = outcome?.judgment?.result.probability;
    emit('ic.system1', { surface, requestId: request.id, probability: p ?? null, failure: outcome?.failure ?? null, cached: outcome?.cached ?? false, latencyMs: outcome?.latencyMs ?? 0 });
    return typeof p === 'number' ? p : null;
  };
  const session = new InfoSession({
    nodeId, taskRootId: input.taskRootId, role: input.role, goal: input.goal, mode: env.mode, disabled: env.disabled,
    prices: perTokenRates(input.model), confidence: input.confidence, taskValueUsd: input.taskValueUsd,
    beliefs: refetchBeliefs(db), refetchModel: fitRefetchModel(refetchObservations(db)), pastTurns: turnHistory(db, input.role), finish: finishBelief(db),
    negatives: negativeFindings(db, input.taskRootId), revision: input.revision,
  }, {
    emit,
    judge,
    admitNegative: env.disabled.has('memory') ? undefined : (finding) => {
      try { admitNegative(db, input.taskRootId, finding); } catch { /* memory is an optimisation */ }
    },
  });
  const token = randomBytes(18).toString('base64url');
  const live: Live = { session, nodeId, role: input.role, hookMs: 0 };
  sessions.set(token, live);
  const url = `http://${address.host}:${address.port}/ic/hook/${token}`;
  return {
    token,
    settings: JSON.stringify(hookSettings(url, env.mode === 'active' && !env.disabled.has('shape'))),
    egress: address,
    observeEvent: (event) => session.observeEvent(event),
    close: () => {
      sessions.delete(token);
      const result = session.close();
      try {
        if (env.mode === 'active') {
          for (const [cell, belief] of result.refetch) recordRefetch(db, cell, belief, nodeId);
          for (const row of result.observations) recordRefetchObservation(db, 'live', row, nodeId);
        }
        recordTurns(db, input.role, result.turns, nodeId);
      } catch (err) {
        console.error('Information control: could not record what the session learned:', err);
      }
      if (result.unverifiedFinish) pendingFinish.add(nodeId);
      else pendingFinish.delete(nodeId);
      emit('ic.session', { mode: env.mode, disabled: [...env.disabled], hookMs: live.hookMs, unverifiedFinish: result.unverifiedFinish, ...result.summary });
      return result;
    },
  };
}

/** The finish gate's label: the node's last dispatch finished unverified, and
 *  this is whether validation then failed it. A no-op for any other node. */
export function settleFinish(db: Db, nodeId: string, validationFailed: boolean): void {
  if (!pendingFinish.delete(nodeId)) return;
  const unverifiedFinish = true;
  try {
    recordFinish(db, validationFailed, nodeId);
    appendEvent(db, { nodeId, type: 'ic.outcome', payload: { kind: 'finish', unverifiedFinish, validationFailed }, createdAt: new Date().toISOString() });
  } catch (err) {
    console.error('Information control: could not record the finish outcome:', err);
  }
}

export function activeSessionCount(): number {
  return sessions.size;
}
