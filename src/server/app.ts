import Fastify from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { appRouter } from './root-router.js';
import { createDb } from '../db/client.js';

export function buildServer(dbPath: string) {
  const db = createDb(dbPath);
  const app = Fastify({ logger: false });

  app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: () => ({ db }),
    },
  });

  return app;
}
