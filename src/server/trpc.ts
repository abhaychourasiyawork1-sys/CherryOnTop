import { initTRPC } from '@trpc/server';
import type { Db } from '../db/client.js';

export interface TrpcContext {
  db: Db;
  /** The top-level routers this daemon serves, so `daemon.ping` can tell a
   *  newer window that it is talking to an older daemon. Supplied by the server
   *  rather than read from the router here: daemon.ts importing the composed
   *  router would be a cycle, and it breaks type inference for every procedure
   *  in the tree. */
  routerNames: string[];
  /** Starting a node dispatches real Kubernetes work. It lives on the context so a
   *  test can build a server without a cluster — never call startNodeActor directly
   *  from a procedure. */
  startNode: (db: Db, nodeId: string, goal: string) => void;
}

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
