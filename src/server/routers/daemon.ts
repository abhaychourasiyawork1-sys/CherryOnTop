import { router, publicProcedure } from '../trpc.js';

export const daemonRouter = router({
  ping: publicProcedure.query(() => ({ ok: true as const, pid: process.pid })),
});
