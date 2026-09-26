import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const WAITLIST_CSV_COLUMNS = ['email', 'intent', 'consent_version', 'created_at'] as const;

/** RFC 4180 quoting plus a guard against spreadsheet formula injection. */
export function csvCell(value: string | null): string {
  if (value === null) return '';
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/**
 * Writes the waitlist (and only the waitlist — never telemetry) to a CSV file.
 * Requires local filesystem access to the marketing DB; there is deliberately no HTTP export.
 */
export async function exportWaitlist(dbPath: string, outputPath: string): Promise<void> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT ${WAITLIST_CSV_COLUMNS.join(', ')} FROM waitlist_signups ORDER BY created_at ASC, email ASC`,
      )
      .all() as Array<Record<(typeof WAITLIST_CSV_COLUMNS)[number], string | null>>;
    const lines = [
      WAITLIST_CSV_COLUMNS.join(','),
      ...rows.map((row) => WAITLIST_CSV_COLUMNS.map((column) => csvCell(row[column])).join(',')),
    ];
    await fs.promises.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    // Owner-only permissions: the export contains email addresses.
    await fs.promises.writeFile(outputPath, `${lines.join('\r\n')}\r\n`, { encoding: 'utf8', mode: 0o600 });
  } finally {
    db.close();
  }
}
