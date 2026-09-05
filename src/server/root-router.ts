import { router } from './trpc.js';
import { nodeRouter } from './routers/node.js';
import { eventsRouter } from './routers/events.js';
import { daemonRouter } from './routers/daemon.js';
import { commitmentRouter } from './routers/commitment.js';
import { decisionRouter } from './routers/decision.js';

export const appRouter = router({
  node: nodeRouter,
  events: eventsRouter,
  daemon: daemonRouter,
  commitment: commitmentRouter,
  decision: decisionRouter,
});

export type AppRouter = typeof appRouter;
