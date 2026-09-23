#!/usr/bin/env node
/** Builds one predictions.jsonl per (arm, repetition) for the variance probe
 *  — unlike build_predictions.mjs (which collapses to one row per instance+
 *  arm for the main paired comparison), each repetition must be graded
 *  separately to compute the resolve-rate flip count Step 6 asks for.
 *
 *  Usage: node build_predictions_variance.mjs <results.jsonl...>
 *  Writes predictions/variance/<arm>-rep<N>.jsonl */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const resultsFiles = process.argv.slice(2);
if (resultsFiles.length === 0) {
  console.error('usage: build_predictions_variance.mjs <results.jsonl...>');
  process.exit(2);
}

const varianceIds = new Set(JSON.parse(readFileSync('bench/swebench/instances.json', 'utf8')).variance_probe_instance_ids);
const rows = resultsFiles.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  .filter((r) => varianceIds.has(r.instance_id));

const byArmRep = new Map();
for (const row of rows) {
  const key = `${row.arm}-rep${row.repetition}`;
  if (!byArmRep.has(key)) byArmRep.set(key, []);
  const patchFile = join('bench/swebench/patches', `${row.instance_id}.${row.arm}.${row.repetition}.patch`);
  const patch = readFileSync(patchFile, 'utf8');
  byArmRep.get(key).push({
    instance_id: row.instance_id,
    model_patch: patch,
    model_name_or_path: key,
  });
}

mkdirSync('bench/swebench/predictions/variance', { recursive: true });
for (const [key, preds] of byArmRep) {
  writeFileSync(`bench/swebench/predictions/variance/${key}.jsonl`, preds.map((p) => JSON.stringify(p)).join('\n') + '\n');
  console.log(`${key}: ${preds.length} predictions`);
}
