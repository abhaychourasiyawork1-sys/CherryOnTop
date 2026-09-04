import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { buildServer } from './app.js';

const DAEMON_PORT = Number(process.env.ORG_DAEMON_PORT ?? 4177);
const DB_PATH = process.env.ORG_DB_PATH ?? path.join(os.homedir(), '.org', 'state.db');

mkdirSync(path.dirname(DB_PATH), { recursive: true });

const app = buildServer(DB_PATH);

app.listen({ port: DAEMON_PORT, host: '127.0.0.1' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
