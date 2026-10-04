#!/usr/bin/env node
/** Derives one structured record per run from what run-one.mjs preserved
 *  (state.db, tokens.json, jobs/*.json, model.patch, meta.json, grade.json).
 *
 *  Nothing here talks to a model or the cluster: it can be rerun, and fixed,
 *  without paying for a run again. A value that was not measured is `null` and
 *  the reason is in `unmeasured` — never a zero standing in for "unknown".
 *
 *  Usage: node collect.mjs [--out <dir>]   (reads every p-* run under benchRoot)
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG = JSON.parse(readFileSync(join(import.meta.dirname, 'config.json'), 'utf8'));
const ROOT = CONFIG.benchRoot.replace('~', homedir());
const REDUCTION_RATIO = 0.7; // src/execution/tokens.ts CONTEXT_REDUCTION_RATIO, the candidate's own definition

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const readJson = (f) => (existsSync(f) ? parse(readFileSync(f, 'utf8')) : null);

function loadRun(runId) {
  const dir = join(ROOT, 'runs', runId);
  const meta = readJson(join(dir, 'meta.json'));
  if (!meta) return null;
  const db = new Database(join(dir, 'state.db'), { readonly: true, fileMustExist: true });
  const events = db.prepare('select id,node_id,type,payload,created_at from events order by id').all()
    .map((e) => ({ ...e, p: parse(e.payload) }));
  const nodes = db.prepare('select id,parent_id,goal,state,created_at,updated_at from nodes').all();
  db.close();
  const jobs = existsSync(join(dir, 'jobs')) ? readdirSync(join(dir, 'jobs')).map((f) => readJson(join(dir, 'jobs', f))).filter(Boolean) : [];
  return { dir, meta, events, nodes, jobs, tokens: readJson(join(dir, 'tokens.json')), grade: readJson(join(dir, 'grade.json')) };
}

/** Tool calls in order, de-duplicated by tool_use id (a streamed message repeats). */
function toolCalls(events) {
  const seen = new Set(); const calls = [];
  for (const e of events) {
    if (e.type !== 'exec.assistant' || !e.p?.message?.content) continue;
    for (const b of e.p.message.content) {
      if (b.type !== 'tool_use' || seen.has(b.id)) continue;
      seen.add(b.id);
      calls.push({ eventId: e.id, nodeId: e.node_id, at: e.created_at, name: b.name, input: b.input ?? {} });
    }
  }
  return calls;
}

const EDIT = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const canon = (c) => `${c.name}:${JSON.stringify(c.input, Object.keys(c.input).sort())}`;
const touches = (c, path) => {
  const i = c.input ?? {};
  const hay = [i.file_path, i.path, i.pattern, i.command, i.glob].filter((x) => typeof x === 'string').join(' ');
  return hay.includes(path);
};
const fileOf = (c) => {
  const i = c.input ?? {};
  if (c.name === 'Read' && typeof i.file_path === 'string') return i.file_path.replace(/^\/workspace\//, '');
  if (c.name === 'Bash' && typeof i.command === 'string') {
    const m = i.command.match(/\b(?:cat|head|tail|sed(?: -n '[^']*')?|less)\s+(?:-\w+\s+)*(\S+\.\w+)/);
    return m ? m[1].replace(/^\/workspace\//, '') : null;
  }
  return null;
};

/** One dispatch = one node's exec stream. Per-message context size, de-duplicated by message id. */
function visibleSeries(events, nodeId) {
  const seen = new Set(); const sizes = []; const firstTurn = { input: 0, cacheRead: 0, cacheCreate: 0 };
  for (const e of events) {
    if (e.type !== 'exec.assistant' || e.node_id !== nodeId) continue;
    const m = e.p?.message; const id = m?.id;
    if (e.p?.parent_tool_use_id || typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const u = m.usage ?? {};
    const size = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    if (sizes.length === 0) { firstTurn.input = num(u.input_tokens); firstTurn.cacheRead = num(u.cache_read_input_tokens); firstTurn.cacheCreate = num(u.cache_creation_input_tokens); }
    sizes.push(size);
  }
  const reductions = [];
  for (let i = 1; i < sizes.length; i++) if (sizes[i] <= sizes[i - 1] * REDUCTION_RATIO) reductions.push({ from: sizes[i - 1], to: sizes[i] });
  return { sizes, reductions, firstTurn };
}

function promptFromLedger(events) {
  const out = [];
  for (const e of events.filter((x) => x.type === 'context.ledger')) {
    const recs = e.p?.records ?? [];
    const compile = recs.filter((r) => r.phase === 'compile');
    const summary = compile.find((r) => r.fingerprint);
    const m = (summary?.reason ?? '').match(/^(\w+) total=(\d+) channels=(\d+)\+(\d+)B pressure=(\w+)/);
    out.push({
      dispatchId: e.p?.dispatchId, nodeId: e.node_id,
      status: m?.[1] ?? (compile.find((r) => r.reason?.startsWith('refused')) ? 'refused' : null),
      totalTokens: m ? Number(m[2]) : null, bytesSystem: m ? Number(m[3]) : null, bytesUser: m ? Number(m[4]) : null, pressure: m?.[5] ?? null,
      fingerprint: summary?.fingerprint ?? null,
      blocks: compile.filter((r) => r.kind).map((r) => ({ kind: r.kind, tokens: r.tokens ?? 0, cacheClass: r.cacheClass, level: r.reason })),
      dropped: compile.filter((r) => r.reason?.startsWith('dropped:')).length,
      demoted: compile.filter((r) => r.reason?.startsWith('demoted:')).length,
      materialize: recs.filter((r) => r.phase === 'materialize').map((r) => ({ path: r.sourceRef, representation: r.representation, tokens: r.tokens ?? 0 })),
      reuse: recs.filter((r) => r.phase === 'reuse').map((r) => ({ ref: r.sourceRef, tokens: r.tokens ?? 0, reason: r.reason })),
      visible: recs.find((r) => r.phase === 'visible') ?? null,
      select: recs.find((r) => r.phase === 'select') ?? null,
      retain: recs.filter((r) => r.phase === 'retain').map((r) => r.reason),
    });
  }
  return out;
}

function argvFacts(jobs) {
  return jobs.map(({ job }) => {
    const cmd = job.spec?.template?.spec?.containers?.[0]?.command ?? [];
    const at = (flag) => { const i = cmd.indexOf(flag); return i >= 0 ? cmd[i + 1] : null; };
    const sys = at('--append-system-prompt') ?? at('--system-prompt');
    return {
      job: job.metadata?.name, model: at('--model'), effort: at('--effort'), maxTurns: at('--max-turns'),
      bytesSystem: sys == null ? null : Buffer.byteLength(sys), argvBytes: Buffer.byteLength(cmd.join('\0')),
      promptInArgv: cmd.some((a) => !a.startsWith('-') && a.length > 3000 && a !== sys),
    };
  });
}

function buildRecord(run) {
  const { meta, events, nodes, tokens, grade } = run;
  const unmeasured = {};
  const root = nodes.find((n) => !n.parent_id);
  const children = nodes.filter((n) => n.parent_id);
  const rows = tokens?.rows ?? [];
  const econ = tokens?.economic ?? [];
  const resultEvents = events.filter((e) => /^(exec|plan|synth)\.result$/.test(e.type));
  const crossCost = sum(resultEvents.map((e) => num(e.p?.total_cost_usd)));

  const execNodes = [...new Set(events.filter((e) => e.type === 'exec.assistant').map((e) => e.node_id))];
  const dispatches = execNodes.map((id) => ({ nodeId: id, ...visibleSeries(events, id) }));
  const allSizes = dispatches.flatMap((d) => d.sizes);
  const calls = toolCalls(events);
  const ledgers = promptFromLedger(events);
  const argv = argvFacts(run.jobs);

  // --- tool use / exploration / rediscovery (arm-neutral, from the model's own tool calls)
  const firstEdit = calls.findIndex((c) => EDIT.has(c.name));
  const exploration = (firstEdit < 0 ? calls : calls.slice(0, firstEdit)).length;
  const dupMap = new Map(); for (const c of calls) dupMap.set(canon(c), (dupMap.get(canon(c)) ?? 0) + 1);
  const duplicateCalls = sum([...dupMap.values()].map((n) => Math.max(0, n - 1)));
  const readCounts = new Map(); for (const c of calls) { const f = fileOf(c); if (f) readCounts.set(f, (readCounts.get(f) ?? 0) + 1); }
  const repeatFileReads = sum([...readCounts.values()].map((n) => Math.max(0, n - 1)));

  const evidenceEvents = events.filter((e) => e.type === 'economic.evidence' && e.p?.acquired);
  const materialized = [
    ...ledgers.flatMap((l) => l.materialize),
    ...(ledgers.length ? [] : evidenceEvents.map((e) => ({ path: e.p.path, representation: e.p.representation ?? 'full', tokens: e.p.tokens ?? 0 }))),
  ];
  let rediscovery = null;
  if (materialized.length) {
    rediscovery = sum(materialized.map((m) => calls.filter((c) => !EDIT.has(c.name) && m.path && touches(c, m.path)).length));
  } else unmeasured.rediscovery_after_materialization = 'no evidence was materialized in this run, so there is nothing to rediscover (the test was not exercised)';

  // --- prompt/compiler: the compile receipt exists only on the candidate
  const hasLedger = ledgers.length > 0;
  const roleOf = (l) => String(l.dispatchId ?? '').split('/')[1] ?? 'unknown';
  const execLedgers = ledgers.filter((l) => roleOf(l) === 'execute');
  const planLedgers = ledgers.filter((l) => roleOf(l) === 'plan');
  const kindTokens = (kind) => (hasLedger ? sum(execLedgers.flatMap((l) => l.blocks.filter((b) => b.kind === kind).map((b) => b.tokens))) : null);
  const receipts = events.filter((e) => e.type === 'context.receipt').map((e) => e.p);
  if (!hasLedger) for (const k of ['prompt_tokens', 'prompt_bytes_user', 'conversation_tokens', 'handoff_tokens', 'evidence_tokens', 'prompt_demotions', 'prompt_drops', 'stable_prefix_fingerprint', 'working_set_reuse']) {
    unmeasured[k] = 'baseline has no prompt compiler / context ledger: no compile receipt exists to read';
  }
  const fps = execLedgers.map((l) => l.fingerprint).filter(Boolean);
  const stableReuse = fps.length > 1 ? (fps.length - new Set(fps).size) / (fps.length - 1) : null;
  if (stableReuse === null) unmeasured.stable_prefix_reuse_rate = hasLedger ? 'fewer than two compiled dispatches' : 'no fingerprints in baseline';

  // --- failures / reliability
  const stepOutcomes = events.filter((e) => e.type === 'step.outcome').map((e) => e.p);
  const failedMessages = stepOutcomes.filter((o) => o && o.succeeded === false).map((o) => String(o.message ?? ''));
  const allText = [...failedMessages, ...resultEvents.map((e) => `${e.p?.subtype ?? ''} ${e.p?.result ?? ''}`)].join('\n');
  const reliability = {
    transport_failure: /E2BIG|spawn .* ENAMETOOLONG|argument list too long/i.test(allText),
    timeout: /timed out|timeout/i.test(allText) || meta.outcome?.state === 'TIMEOUT',
    model_rejection: /model.*(not found|rejected|unavailable)|invalid model/i.test(allText),
    rate_limited: events.some((e) => e.type === 'step.outcome' && /usage limit/i.test(String(e.p?.message ?? ''))) || events.some((e) => /rate_limit_event$/.test(e.type) && e.p?.rate_limit_info?.status === 'rejected'),
    max_turns: resultEvents.some((e) => /max_turns/.test(e.p?.subtype ?? '')),
    spend_cap: events.some((e) => e.type === 'step.progress' && /Spend cap reached/.test(String(e.p?.message ?? ''))),
    synthesis_failure: events.some((e) => e.type === 'synth.result' && e.p?.is_error),
    validation_failure: events.filter((e) => e.type === 'validation.result').at(-1)?.p?.passed === false,
  };
  const validationEvents = events.filter((e) => e.type === 'validation.result').map((e) => ({ level: e.p?.level, passed: e.p?.passed, reasonCodes: e.p?.reasonCodes }));
  const modelsSeen = [...new Set(events.filter((e) => /^(exec|plan|synth)\.system$/.test(e.type) && e.p?.model).map((e) => e.p.model))];
  const system1Cost = events.filter((e) => e.type === 'market.system1').map((e) => num(e.p?.actualCostUsd));

  const record = {
    experiment: meta.experiment, run_id: meta.run_id, task_id: meta.task_id, instance_id: meta.instance_id, arm: meta.arm, rep: meta.rep,
    commit_sha: meta.commit_sha,
    provider: 'anthropic (Claude Code CLI 2.1.280 in runner image, subscription auth)',
    model: modelsSeen.length ? modelsSeen.join(',') : null, model_alias_pinned: meta.model_alias,
    effort: argv[0]?.effort ?? meta.effort, credential_kind: meta.credential_kind,
    started_at: meta.startedAt, submitted_at: meta.submittedAt, finished_at: meta.finishedAt,
    node_state: meta.outcome?.state,
    succeeded: root ? root.state === 'COMPLETE' : false,
    validated: grade ? grade.resolved === true : null,
    ...(grade ? {} : { validated_note: 'not graded yet' }),

    cost_usd: rows.length ? sum(rows.map((r) => num(r.costUsd))) : null,
    cost_usd_cross_check_result_events: crossCost,
    input_tokens: rows.length ? sum(rows.map((r) => num(r.inputTokens))) : null,
    output_tokens: rows.length ? sum(rows.map((r) => num(r.outputTokens))) : null,
    cache_read_tokens: rows.length ? sum(rows.map((r) => num(r.cacheReadTokens))) : null,
    cache_creation_tokens: rows.length ? sum(rows.map((r) => num(r.cacheCreationTokens))) : null,
    num_turns: rows.length ? sum(rows.map((r) => num(r.turns))) : null,
    tokens_by_role: rows.map((r) => ({ role: r.role, model: r.model, dispatches: r.dispatches, turns: r.turns, in: r.inputTokens, out: r.outputTokens, cacheRead: r.cacheReadTokens, cacheCreate: r.cacheCreationTokens, costUsd: r.costUsd })),

    startup_ms: econ.length ? sum(econ.map((r) => num(r.startupMs))) : null,
    queue_ms: econ.length ? sum(econ.map((r) => num(r.queueMs))) : null,
    dispatch_ms: econ.length ? sum(econ.map((r) => num(r.dispatchMs))) : null,
    end_to_end_ms: meta.wallMs ?? null,
    daemon_startup_ms: meta.startupMs ?? null,

    peak_visible_tokens: allSizes.length ? Math.max(...allSizes) : null,
    average_visible_tokens: allSizes.length ? Math.round(sum(allSizes) / allSizes.length) : null,
    first_visible_tokens: dispatches[0]?.sizes[0] ?? null,
    last_visible_tokens: dispatches.at(-1)?.sizes.at(-1) ?? null,
    context_reductions: sum(dispatches.map((d) => d.reductions.length)),

    // Real tokenizer, both arms: everything the model could see on its first turn of the first dispatch.
    opening_visible_tokens: dispatches[0]?.sizes[0] ?? null,
    prompt_tokens: execLedgers.length ? sum(execLedgers.map((l) => l.totalTokens ?? 0)) : null,
    plan_prompt_tokens: hasLedger ? sum(planLedgers.map((l) => l.totalTokens ?? 0)) : null,
    prompt_bytes_system: argv[0]?.bytesSystem ?? null,
    prompt_bytes_user: execLedgers.length ? sum(execLedgers.map((l) => l.bytesUser ?? 0)) : null,
    prompt_status: ledgers.map((l) => `${roleOf(l)}:${l.status}`),

    repo_context_tokens: receipts.length ? sum(receipts.map((r) => num(r.tokens))) : null,
    repo_context_tokens_compile_block: kindTokens('repo-context'),
    conversation_tokens: kindTokens('conversation'),
    handoff_tokens: kindTokens('handoff'),
    evidence_tokens: hasLedger ? sum(materialized.map((m) => m.tokens)) : (evidenceEvents.length ? sum(evidenceEvents.map((e) => num(e.p.tokens))) : 0),

    targeted_materializations: materialized.filter((m) => m.representation && m.representation !== 'full').length,
    whole_file_materializations: materialized.filter((m) => m.representation === 'full').length,
    materialization_tokens: sum(materialized.map((m) => m.tokens)),
    materialization_source: hasLedger ? 'context.ledger materialize rows' : 'economic.evidence events (acquired)',

    working_set_reuse: hasLedger ? sum(ledgers.map((l) => l.reuse.length)) : null,
    stable_prefix_fingerprint: fps.length ? fps[0] : null,
    stable_prefix_fingerprints: fps,
    stable_prefix_reuse_rate: stableReuse,

    prompt_demotions: hasLedger ? sum(ledgers.map((l) => l.demoted)) : null,
    prompt_drops: hasLedger ? sum(ledgers.map((l) => l.dropped)) : null,

    system1_calls: econ.length ? sum(econ.map((r) => num(r.system1Calls))) : null,
    system1_cost: system1Cost.length ? sum(system1Cost) : null,
    synthesis_calls: econ.length ? sum(econ.map((r) => num(r.synthesisCalls))) : null,
    plan_calls: econ.length ? sum(econ.map((r) => num(r.planningCalls))) : null,
    execution_calls: econ.length ? sum(econ.map((r) => num(r.executionCalls))) : null,

    retries: econ.length ? sum(econ.map((r) => num(r.retries))) : null,
    fallbacks: events.filter((e) => e.type === 'economic.fallback').length,

    // delegation / siblings (H3)
    child_nodes: children.length,
    dispatch_count: execNodes.length,
    decision_outcome: events.find((e) => e.type === 'decision.made')?.p?.outcome ?? null,
    delegation_events: events.filter((e) => e.type.startsWith('delegation.')).map((e) => ({ type: e.type, topology: e.p?.topology, groups: e.p?.groups })),
    per_dispatch_first_turn: dispatches.map((d) => ({ nodeId: d.nodeId, ...d.firstTurn, firstVisible: d.sizes[0], cacheReadFraction: d.sizes[0] ? d.firstTurn.cacheRead / d.sizes[0] : null })),

    // tool use / rediscovery (arm-neutral)
    tool_calls: calls.length,
    tool_calls_by_name: Object.fromEntries([...new Set(calls.map((c) => c.name))].map((n) => [n, calls.filter((c) => c.name === n).length])),
    exploration_calls_before_first_edit: exploration,
    duplicate_tool_calls: duplicateCalls,
    repeat_file_reads: repeatFileReads,
    rediscovery_after_materialization: rediscovery,

    files_changed: meta.changed_files,
    patch_bytes: meta.patch_bytes,
    validation_results: validationEvents,
    swebench_grade: grade ?? null,
    reliability,
    failure_reason: failedMessages.length ? failedMessages.join(' | ').slice(0, 500) : (meta.outcome?.error ? String(meta.outcome.error).slice(0, 500) : null),
    unmeasured,
  };
  const detail = {
    run_id: meta.run_id, jobs: argv, ledgers, receipts,
    visible_series: dispatches.map((d) => ({ nodeId: d.nodeId, sizes: d.sizes, reductions: d.reductions })),
    tool_sequence: calls.map((c) => ({ n: c.name, i: JSON.stringify(c.input).slice(0, 160) })),
    materialized, nodes: nodes.map((n) => ({ id: n.id, parent: n.parent_id, state: n.state })),
    market: events.filter((e) => /^market\./.test(e.type)).map((e) => ({ type: e.type, p: e.p })),
    economic: events.filter((e) => /^economic\./.test(e.type)).map((e) => ({ type: e.type, p: e.p })),
  };
  return { record, detail };
}

const outDir = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(ROOT, 'analysis');
mkdirSync(outDir, { recursive: true });
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const runIds = readdirSync(join(ROOT, 'runs')).filter((r) => (only ? r.startsWith(only) : r.startsWith('p-'))).sort();
const records = [];
for (const id of runIds) {
  const run = loadRun(id);
  if (!run) continue;
  const { record, detail } = buildRecord(run);
  records.push(record);
  writeFileSync(join(outDir, `${id}.detail.json`), JSON.stringify(detail, null, 1));
}
writeFileSync(join(outDir, 'records.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
console.log(`${records.length} records -> ${join(outDir, 'records.jsonl')}`);
