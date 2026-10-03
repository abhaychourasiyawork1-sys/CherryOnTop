import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { Command } from 'commander';
import { createDb } from '../../db/client.js';
import { appendEvent } from '../../db/queries/events.js';
import { registerVerifyCommand } from './verify.js';

// Real sqlite files, exactly like events.chain.test.ts — verify.ts reads the
// database directly (see its own comment: asking the daemon whether it has
// been honest would defeat the exercise), so this is what "the CLI's actual
// contract" looks like without a live daemon.
const TEST_DB = './test-verify-cli.db';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  delete process.env.ORG_DB_PATH;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

function program() {
  const p = new Command();
  registerVerifyCommand(p);
  return p;
}

describe('org verify', () => {
  it('reports an intact chain and leaves the exit code untouched', async () => {
    const db = createDb(TEST_DB);
    appendEvent(db, { nodeId: 'n1', type: 'state.transition', payload: { state: 'CREATED' }, createdAt: 't0' });
    appendEvent(db, { nodeId: 'n1', type: 'state.transition', payload: { state: 'ORIENT' }, createdAt: 't1' });
    process.env.ORG_DB_PATH = TEST_DB;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['verify'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledWith('Intact — 2 event(s) verify against their hashes.');
    expect(logSpy).toHaveBeenCalledWith('This shows the log has not been quietly edited. It is not proof it cannot be.');
    expect(process.exitCode).toBeUndefined();
  });

  it('mentions unchained legacy events without treating them as a break', async () => {
    const db = createDb(TEST_DB);
    db.run(sql`INSERT INTO events (node_id, type, payload, created_at) VALUES ('n1','legacy','{}','t0')`);
    appendEvent(db, { nodeId: 'n1', type: 'new', payload: {}, createdAt: 't1' });
    process.env.ORG_DB_PATH = TEST_DB;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['verify'], { from: 'user' });

    expect(logSpy).toHaveBeenCalledWith('1 older event(s) predate hashing and could not be checked.');
    expect(process.exitCode).toBeUndefined();
  });

  it('names the broken event and sets a non-zero exit code on tampering', async () => {
    const db = createDb(TEST_DB);
    for (let i = 0; i < 4; i++) {
      appendEvent(db, { nodeId: 'n1', type: 'step.progress', payload: { message: `m${i}` }, createdAt: `t${i}` });
    }
    db.run(sql`UPDATE events SET payload = '{"message":"tampered"}' WHERE id = 2`);
    process.env.ORG_DB_PATH = TEST_DB;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program().parseAsync(['verify'], { from: 'user' });

    expect(errSpy).toHaveBeenCalledWith('Broken at event 2. Everything before it verifies; that row and after do not.');
    expect(process.exitCode).toBe(1);
    // The success-path lines belong on stdout only; a broken chain must not
    // also claim to be intact.
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown flag', async () => {
    const p = new Command();
    let err = '';
    p.exitOverride();
    p.configureOutput({ writeOut: () => {}, writeErr: (s) => { err += s; } });
    registerVerifyCommand(p);
    await expect(p.parseAsync(['verify', '--bogus'], { from: 'user' })).rejects.toMatchObject({ exitCode: 1 });
    expect(err).toMatch(/unknown option '--bogus'/);
  });
});
