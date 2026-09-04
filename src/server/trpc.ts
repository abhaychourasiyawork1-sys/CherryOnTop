import { initTRPC } from '@trpc/server';
import type { Db } from '../db/client.js';

export interface TrpcContext {
  db: Db;
}

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
