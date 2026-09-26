import { router, publicProcedure } from '../trpc.js';
import { getOrgStats } from '../../db/queries/stats.js';
import { sandboxLimiter, maxConcurrentFromEnv } from '../../execution/dispatch-limit.js';
import { orgEnvDigest } from '../../daemon/manager.js';
import { system1Config } from '../../config/system1.js';
import { system1 } from '../../system1/guard.js';

/** When this daemon process started, so a caller can tell it predates a build. */
const STARTED_AT = Date.now();

export const daemonRouter = router({
  // hasApiKey reports the *daemon's* env, not the CLI's. They diverge whenever
  // the daemon was started before the key was exported, and the only visible
  // symptom is every run failing authentication minutes later.
  ping: publicProcedure.query(({ ctx }) => ({
    ok: true as const,
    pid: process.pid,
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    /** What this daemon actually serves.
     *
     *  The window and the daemon are built and started separately, and `org gui`
     *  reuses whatever daemon is already running — so a window from today
     *  talking to a daemon from last week is a completely ordinary accident.
     *  Reporting the router names lets the window say "your daemon is older than
     *  this window" once, instead of 404ing call by call and reporting the
     *  daemon as unreachable.
     *
     *  Names rather than a version number, so nobody has to remember to bump
     *  anything: adding a router is the only step. */
    routers: ctx.routerNames,
    /** Whether *this* daemon's System-1 can answer. The CLI's own PATH says
     *  nothing about it: a benchmark ran with "laya-serve ENOENT" in the
     *  daemon log while everything else looked fine. */
    system1: { mode: system1Config().mode, ready: system1().ready() },
    envDigest: orgEnvDigest(process.env),
    startedAt: STARTED_AT,
  })),

  stats: publicProcedure.query(({ ctx }) => getOrgStats(ctx.db)),

  /** How many sandboxes are running and how many are waiting for a slot. Pod
   *  counts cannot answer this — a pod outlives the job that owned it — so
   *  without this "queued" and "stuck" look identical from outside. */
  sandboxes: publicProcedure.query(() => ({
    active: sandboxLimiter().active(),
    queued: sandboxLimiter().queued(),
    max: maxConcurrentFromEnv(),
  })),
});
