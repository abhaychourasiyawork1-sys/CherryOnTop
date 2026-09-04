// tsc emits .js only; the Drizzle migrator needs the .sql/.json files at runtime.
import { cpSync, existsSync } from 'node:fs';

if (existsSync('src/db/migrations')) {
  cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
}
