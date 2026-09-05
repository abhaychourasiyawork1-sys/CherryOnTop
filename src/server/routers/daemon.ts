import { router, publicProcedure } from '../trpc.js';

export const daemonRouter = router({
  // hasApiKey reports the *daemon's* env, not the CLI's. They diverge whenever
  // the daemon was started before the key was exported, and the only visible
  // symptom is every run failing authentication minutes later.
  ping: publicProcedure.query(() => ({
    ok: true as const,
    pid: process.pid,
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
  })),
});
