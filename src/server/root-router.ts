import { router } from './trpc.js';
import { nodeRouter } from './routers/node.js';
import { eventsRouter } from './routers/events.js';
import { daemonRouter } from './routers/daemon.js';

export const appRouter = router({
  node: nodeRouter,
  events: eventsRouter,
  daemon: daemonRouter,
});

export type AppRouter = typeof appRouter;
