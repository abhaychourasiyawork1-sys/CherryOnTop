import { createDaemonClient } from '../daemon/client.js';

// One client for the whole TUI process. Every screen and keybinding shares it —
// building one per render (or per keypress) would open a fresh WebSocket each
// time and leak sockets for the life of the session.
let client: ReturnType<typeof createDaemonClient> | null = null;

export function tuiClient() {
  client ??= createDaemonClient();
  return client;
}
