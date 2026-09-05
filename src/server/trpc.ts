import { initTRPC } from '@trpc/server';
import type { Db } from '../db/client.js';

export interface TrpcContext {
  db: Db;
  /** Starting a node dispatches real Kubernetes work. It lives on the context so a
   *  test can build a server without a cluster — never call startNodeActor directly
   *  from a procedure. */
  startNode: (db: Db, nodeId: string, goal: string) => void;
}

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
