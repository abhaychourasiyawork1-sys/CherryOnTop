import { router } from './trpc.js';
import { nodeRouter } from './routers/node.js';
import { eventsRouter } from './routers/events.js';
import { daemonRouter } from './routers/daemon.js';
import { commitmentRouter } from './routers/commitment.js';
import { decisionRouter } from './routers/decision.js';
import { artifactRouter } from './routers/artifact.js';
import { approvalRouter } from './routers/approval.js';
import { memoryRouter } from './routers/memory.js';
import { askRouter } from './routers/ask.js';
import { mandateRouter } from './routers/mandate.js';
import { caseRouter } from './routers/case.js';

export const appRouter = router({
  node: nodeRouter,
  events: eventsRouter,
  daemon: daemonRouter,
  commitment: commitmentRouter,
  decision: decisionRouter,
  artifact: artifactRouter,
  approval: approvalRouter,
  memory: memoryRouter,
  mandate: mandateRouter,
  case: caseRouter,
  org: askRouter,
});

export type AppRouter = typeof appRouter;
