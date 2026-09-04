import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../server/root-router.js';

const DAEMON_PORT = Number(process.env.ORG_DAEMON_PORT ?? 4177);

export function createDaemonClient() {
  return createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `http://127.0.0.1:${DAEMON_PORT}/trpc` })],
  });
}
