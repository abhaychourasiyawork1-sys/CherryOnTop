// Part of the unit suite (vitest); needs `npm run build` for dist/.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runTask } from '../sim.mjs';
import { cfg, taskSet, runConfig, makeGate, metrics } from './evaluate.mjs';

const tasks = taskSet(30).slice(0, 12);
const one = { reps: 1, oracleK: 3, split: { train: 6, adapt: 3, heldOut: 3 } };
// Each test runs the simulator for real; under the parallel suite that is slow.
const SIM = 60_000;

// The frozen v1 raw results are kept out of git (8 MB); without them there is
// nothing to reproduce against, so the check is skipped rather than failed.
const V1 = new URL('../results/passB.jsonl', import.meta.url);
test.skipIf(!existsSync(V1))('an unchanged threshold reproduces the frozen v1 run exactly', () => {
  const frozen = new Map(readFileSync(V1, 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l)).filter((r) => r.variant === 'H2' && r.rep === 0).map((r) => [r.taskId, r]));
  for (const r of runConfig({ variant: 'H2' }, tasks, one)) {
    const v1 = frozen.get(r.taskId);
    assert.equal(r.success, v1.success, r.taskId);
    assert.ok(Math.abs(r.tokens - v1.tokens) < 1e-6, `${r.taskId} ${r.tokens} vs ${v1.tokens}`);
    assert.equal(r.carried, v1.interventions);
  }
}, SIM);

test('raising the intervention threshold suppresses intervention; continue wins', () => {
  const base = metrics(runConfig({ variant: 'H2' }, tasks, one));
  const mid = metrics(runConfig({ variant: 'H2', gate: { intervention: 3 } }, tasks, one));
  const off = metrics(runConfig({ variant: 'H2', gate: { intervention: Infinity } }, tasks, one));
  assert.ok(mid.interventionsPerTask < base.interventionsPerTask);
  assert.equal(off.interventionsPerTask, 0);
  assert.equal(off.abstainedPerTask, off.selectedPerTask);
}, SIM);

test('the replay gate can suppress replay entirely', () => {
  const asIs = metrics(runConfig({ variant: 'H4' }, tasks, one));
  const none = metrics(runConfig({ variant: 'H4', replay: { mode: 'none' } }, tasks, one));
  const gated = metrics(runConfig({ variant: 'H4', replay: { mode: 'gated', theta: 1e9 } }, tasks, one));
  assert.ok(asIs.replayTokensPerTask > 0, 'fixture must contain a replay');
  assert.equal(none.replayTokensPerTask, 0);
  assert.equal(gated.replayTokensPerTask, 0);
}, SIM);

test('a gate never sees ground truth', () => {
  const forbidden = ['modes', 'onset', 'severity', 'hidden', 'special', 'trueEffects', 'unavoidable', 'needUnits', 'selfCatch'];
  const gate = makeGate({ preventability: 0 });
  let seen = 0;
  for (const task of tasks) {
    runTask(task, cfg, { variant: 'H2', rep: 0, gate: (view) => {
      seen += 1;
      const walk = (o, path, depth) => {
        if (!o || typeof o !== 'object' || depth > 6) return;
        for (const [k, v] of Object.entries(o)) {
          assert.ok(!forbidden.includes(k), `ground-truth key ${path}.${k} reached the gate`);
          walk(v, `${path}.${k}`, depth + 1);
        }
      };
      walk(view, 'view', 0);
      return gate(view);
    } });
  }
  assert.ok(seen > 0);
}, SIM);

test('selected, carried out and effective are distinct counts', () => {
  const runs = runConfig({ variant: 'H2' }, tasks, one);
  const selected = runs.reduce((s, r) => s + r.selected, 0);
  const carried = runs.reduce((s, r) => s + r.carried, 0);
  const labelled = runs.flatMap((r) => r.truth);
  const effective = labelled.filter((t) => t.savings > 0).length;
  assert.ok(carried <= selected);
  assert.ok(selected > carried, 'the market selects deep:validate, which production does not carry out');
  assert.ok(effective < labelled.length);
}, SIM);
