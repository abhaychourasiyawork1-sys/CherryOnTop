import { createTRPCClient, httpBatchLink, splitLink, wsLink, createWSClient } from '@trpc/client';
import type { AppRouter } from '../server/root-router.js';

const DAEMON_PORT = Number(process.env.ORG_DAEMON_PORT ?? 4177);

export function createDaemonClient() {
  // The WebSocket is opened lazily by createWSClient, so a plain one-shot CLI
  // command that never subscribes still exits without a lingering socket.
  const wsClient = createWSClient({ url: `ws://127.0.0.1:${DAEMON_PORT}/trpc`, lazy: { enabled: true, closeMs: 0 } });
  const client = createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: wsLink({ client: wsClient }),
        false: httpBatchLink({ url: `http://127.0.0.1:${DAEMON_PORT}/trpc` }),
      }),
    ],
  });
  return client;
}
