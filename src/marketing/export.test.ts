import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMarketingDb } from './db.js';
import { csvCell, exportWaitlist } from './export.js';
import { createTelemetryStore } from './telemetry.js';
import { addToWaitlist } from './waitlist.js';

describe('exportWaitlist', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-export-'));
    dbPath = path.join(dir, 'marketing.db');
    const db = createMarketingDb(dbPath);
    addToWaitlist(db, { email: 'first@example.com', intent: 'Research', consentVersion: 'v1' });
    addToWaitlist(db, { email: 'second@example.com' });
    createTelemetryStore(db).insertBatch('session-telemetry-marker', [
      { event: 'hero_cta_clicked', path: '/telemetry-only-path', timestamp: new Date().toISOString(), metadata: { location: 'hero' } },
    ]);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes email, intent, consent version and created timestamp columns', async () => {
    const out = path.join(dir, 'out', 'waitlist.csv');
    await exportWaitlist(dbPath, out);
    const lines = fs.readFileSync(out, 'utf8').trimEnd().split('\r\n');
    expect(lines[0]).toBe('email,intent,consent_version,created_at');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^first@example\.com,Research,v1,\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(lines[2]).toMatch(/^second@example\.com,,,\d{4}-\d{2}-\d{2}T/);
  });

  it('contains no telemetry data', async () => {
    const out = path.join(dir, 'waitlist.csv');
    await exportWaitlist(dbPath, out);
    const csv = fs.readFileSync(out, 'utf8');
    expect(csv).not.toMatch(/session-telemetry-marker|telemetry-only-path|hero_cta_clicked/);
  });

  it('refuses to create a database that does not exist', async () => {
    await expect(exportWaitlist(path.join(dir, 'missing.db'), path.join(dir, 'x.csv'))).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, 'missing.db'))).toBe(false);
  });

  it('quotes CSV specials and neutralises spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell(null)).toBe('');
  });
});
