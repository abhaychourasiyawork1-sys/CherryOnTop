// tsc emits .js only; the Drizzle migrator needs the .sql/.json files at runtime.
import { chmodSync, cpSync, existsSync } from 'node:fs';

if (existsSync('src/db/migrations')) {
  cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
}

// tsc drops the source file's mode, so the shebanged CLI entrypoint comes out
// non-executable and `npm link` yields an `org` that fails with EACCES.
// chmodSync rather than a `chmod` in the npm script, to stay cross-platform.
if (existsSync('dist/cli/index.js')) {
  chmodSync('dist/cli/index.js', 0o755);
}
