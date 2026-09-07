import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { appRouter } from './root-router.js';
import { createDb } from '../db/client.js';
import { startNodeActor } from '../lifecycle/node-actor-manager.js';
import { recoverNodes } from '../lifecycle/rehydrate.js';
import { seedBuiltinMandates } from '../db/queries/mandates.js';
import type { TrpcContext } from './trpc.js';

export function buildServer(dbPath: string, startNode: TrpcContext['startNode'] = startNodeActor) {
  const db = createDb(dbPath);

  seedBuiltinMandates(db);

  // Actors live in this process's memory, so a restart leaves every run in
  // flight with nothing driving it. Put back what can be put back — above all a
  // node parked on someone's approval, which must never lose their decision to
  // a restart — and park the rest as resumable rather than killing them.
  const recovered = recoverNodes(db);
  if (recovered.resumed.length > 0) {
    console.error(`Resumed ${recovered.resumed.length} node(s) that were waiting when the daemon stopped.`);
  }
  if (recovered.interrupted.length > 0) {
    console.error(`${recovered.interrupted.length} node(s) were interrupted mid-work and can be resumed.`);
  }
  if (recovered.stranded.length > 0) {
    console.error(`Closed ${recovered.stranded.length} node(s) with no saved state to resume from.`);
  }

  // tRPC's fastify adapter routes every call through one `/trpc/:path` param,
  // and a batched call puts every procedure name in that param. Fastify's
  // default limit is 100 characters, which a batch of four or five procedures
  // passes straight through — the client then sees a 414 and reports the daemon
  // as unreachable, which is a spectacularly misleading way to say "your URL
  // was long".
  // Derived from the composed router, so adding a router is the only thing
  // anyone has to do for the window's compatibility check to know about it.
  const routerNames = [...new Set(
    Object.keys(appRouter._def.procedures).map((path) => path.split('.')[0]),
  )];

  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 5000 } });

  app.register(fastifyWebsocket);
  app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    // Subscriptions ride the same /trpc prefix over WebSocket; queries and
    // mutations keep using plain HTTP.
    useWSS: true,
    trpcOptions: {
      router: appRouter,
      createContext: () => ({ db, startNode, routerNames }),
    },
  });

  return app;
}
