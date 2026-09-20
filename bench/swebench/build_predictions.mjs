#!/usr/bin/env node
/** Builds one official-harness predictions.jsonl per arm from a results
 *  JSONL + the patches/ directory. Only the newest repetition per
 *  instance+arm is graded when duplicates exist (a variance-probe
 *  repetition supersedes the main run's row for that same instance+arm).
 *
 *  Usage: node build_predictions.mjs <results.jsonl...>
 *  Writes predictions/direct.jsonl and predictions/cherryontop.jsonl. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const resultsFiles = process.argv.slice(2);
if (resultsFiles.length === 0) {
  console.error('usage: build_predictions.mjs <results.jsonl...>');
  process.exit(2);
}

const rows = resultsFiles.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));

// Latest row per (arm, instance_id), by recordedAt.
const latest = new Map();
for (const row of rows) {
  const key = `${row.arm}:${row.instance_id}`;
  const prior = latest.get(key);
  if (!prior || row.recordedAt > prior.recordedAt) latest.set(key, row);
}

const byArm = { direct: [], cherryontop: [] };
for (const row of latest.values()) {
  const patchFile = join('bench/swebench/patches', `${row.instance_id}.${row.arm}.${row.repetition}.patch`);
  const patch = readFileSync(patchFile, 'utf8');
  byArm[row.arm].push({
    instance_id: row.instance_id,
    model_patch: patch,
    model_name_or_path: row.arm === 'direct' ? 'claude-code-direct' : 'cherryontop',
  });
}

mkdirSync('bench/swebench/predictions', { recursive: true });
for (const [arm, preds] of Object.entries(byArm)) {
  if (preds.length === 0) continue;
  writeFileSync(`bench/swebench/predictions/${arm}.jsonl`, preds.map((p) => JSON.stringify(p)).join('\n') + '\n');
  console.log(`${arm}: ${preds.length} predictions`);
}
