// Usage: npm run marketing:export -- <output.csv> [dbPath]
// dbPath defaults to MARKETING_DB_PATH (or ~/.cherryontop/marketing.db).
import { loadMarketingConfig } from '../src/marketing/config.js';
import { exportWaitlist } from '../src/marketing/export.js';

const [outputPath, dbPathArg] = process.argv.slice(2);
if (!outputPath) {
  console.error('usage: export-marketing-waitlist <output.csv> [dbPath]');
  process.exit(2);
}

const dbPath = dbPathArg ?? loadMarketingConfig(process.env).dbPath;
try {
  await exportWaitlist(dbPath, outputPath);
  console.log(`waitlist exported to ${outputPath}`);
} catch (error: unknown) {
  console.error('waitlist export failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
