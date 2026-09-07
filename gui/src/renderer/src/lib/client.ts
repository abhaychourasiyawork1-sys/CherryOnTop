import { createTRPCClient, httpBatchLink, splitLink, wsLink, createWSClient } from '@trpc/client';
import type { AppRouter } from '../../../../../src/server/root-router.js';

// Same shape and same discipline as src/tui/client.ts: one client for the whole
// window. Building one per component would open a WebSocket per mount.
// Matches src/daemon/client.ts. Independent organizations run their own daemon
// on their own port; the GUI has to be able to reach the one you meant.
const PORT = Number(import.meta.env.VITE_ORG_DAEMON_PORT ?? 4177);

let client: ReturnType<typeof build> | null = null;

function build() {
  const wsClient = createWSClient({
    url: `ws://127.0.0.1:${PORT}/trpc`,
    lazy: { enabled: true, closeMs: 0 },
  });
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: wsLink({ client: wsClient }),
        false: httpBatchLink({ url: `http://127.0.0.1:${PORT}/trpc` }),
      }),
    ],
  });
}

export function daemon() {
  client ??= build();
  return client;
}
