// Usage: npm run marketing:prune-telemetry -- <retentionDays> [dbPath]
// Deletes marketing_events rows older than the retention window. Never touches the waitlist.
import { loadMarketingConfig } from '../src/marketing/config.js';
import { createMarketingDb } from '../src/marketing/db.js';
import { createTelemetryStore } from '../src/marketing/telemetry.js';

const [daysArg, dbPathArg] = process.argv.slice(2);
const retentionDays = Number(daysArg);
if (!daysArg || !Number.isFinite(retentionDays) || retentionDays <= 0) {
  console.error('usage: prune-marketing-telemetry <retentionDays> [dbPath]');
  process.exit(2);
}

const db = createMarketingDb(dbPathArg ?? loadMarketingConfig(process.env).dbPath);
try {
  const deleted = createTelemetryStore(db).deleteOlderThan(retentionDays);
  console.log(`deleted ${deleted} telemetry events older than ${retentionDays} days`);
} finally {
  db.close();
}
