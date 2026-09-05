import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { appRouter } from './root-router.js';
import { createDb } from '../db/client.js';
import { startNodeActor } from '../lifecycle/node-actor-manager.js';
import type { TrpcContext } from './trpc.js';

export function buildServer(dbPath: string, startNode: TrpcContext['startNode'] = startNodeActor) {
  const db = createDb(dbPath);
  const app = Fastify({ logger: false });

  app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: () => ({ db, startNode }),
    },
  });

  return app;
}
