#!/usr/bin/env python3
"""Supporting arithmetic for the report, from analysis/records.jsonl and the
preserved databases. Prints markdown; writes analysis/extra.json.

 1. Where each arm's money went (Haiku list price, the CLI's own 1h cache-write rate).
 2. The most the Context Runtime's own surface could save: the cost of carrying
    the repo-context block (written once, re-read every turn), if it were free.
 3. First-turn provider-cache behaviour per run, in schedule order.
 4. The planner arithmetic behind the T3 'no feasible candidate' failures.
"""
import json, os, sqlite3, statistics as st

ROOT = os.path.expanduser('~/Desktop/CherryOnTop-bench')
recs = [json.loads(l) for l in open(f'{ROOT}/analysis/records.jsonl')]
sched = json.load(open(f'{ROOT}/schedule.json'))['schedule']
# Haiku 4.5 list price $/token; cache write is the 1h tier the CLI bills (verified: reproduces total_cost_usd).
P = dict(inp=1e-6, out=5e-6, read=0.1e-6, write=2e-6)
out = {'decomposition': {}, 'carry': [], 'first_turn': [], 'planner': []}

def comp(r):
    return dict(
        fresh=(r['input_tokens'] or 0) * P['inp'], output=(r['output_tokens'] or 0) * P['out'],
        cache_read=(r['cache_read_tokens'] or 0) * P['read'], cache_write=(r['cache_creation_tokens'] or 0) * P['write'])

print('### 1. Where the money went (Haiku list price; sum over runs)')
print('| arm | runs | fresh input | output | cache read | cache write | total (recomputed) | recorded cost |')
print('|---|---|---|---|---|---|---|---|')
for arm in ('baseline', 'candidate'):
    rs = [r for r in recs if r['arm'] == arm]
    c = {k: sum(comp(r)[k] for r in rs) for k in ('fresh', 'output', 'cache_read', 'cache_write')}
    tot = sum(c.values()); rec = sum(r['cost_usd'] for r in rs)
    out['decomposition'][arm] = {**c, 'recomputed': tot, 'recorded': rec}
    print(f"| {arm} | {len(rs)} | ${c['fresh']:.3f} ({c['fresh']/tot:.0%}) | ${c['output']:.3f} ({c['output']/tot:.0%}) | ${c['cache_read']:.3f} ({c['cache_read']/tot:.0%}) | ${c['cache_write']:.3f} ({c['cache_write']/tot:.0%}) | ${tot:.3f} | ${rec:.3f} |")

print('\n### 2. Ceiling on what shrinking the repo-context block could save (candidate runs that executed)')
print('Carry cost = block tokens x ($write once + $read x (turns-1)), i.e. the block priced as if it were removed entirely.\n')
print('| run | repo-context tokens | turns | carry cost | share of run cost |')
print('|---|---|---|---|---|')
for r in recs:
    if r['arm'] != 'candidate' or not r['num_turns'] or r['dispatch_count'] < 1:
        continue
    blk = r['repo_context_tokens_compile_block'] or 0
    carry = blk * (P['write'] + P['read'] * max(0, (r['num_turns'] or 1) - 1))
    out['carry'].append({'run': r['run_id'], 'block_tokens': blk, 'turns': r['num_turns'], 'carry_usd': carry, 'share': carry / r['cost_usd']})
    print(f"| {r['run_id']} | {blk} | {r['num_turns']} | ${carry:.4f} | {carry / r['cost_usd']:.1%} |")

print('\n### 3. First turn of the first dispatch, in schedule order (provider prompt cache is shared across runs, 1h TTL)')
print('| slot | run | first-turn visible | cache read | cache write | read share |')
print('|---|---|---|---|---|---|')
byid = {r['run_id']: r for r in recs}
for s in sched:
    r = byid[s['runId']]
    f = (r['per_dispatch_first_turn'] or [None])[0]
    if not f:
        print(f"| {s['slot']} | {s['runId']} | (no execute dispatch) | | | |"); continue
    out['first_turn'].append({'slot': s['slot'], 'run': s['runId'], **{k: f[k] for k in ('firstVisible', 'cacheRead', 'cacheCreate')}})
    print(f"| {s['slot']} | {s['runId']} | {f['firstVisible']} | {f['cacheRead']} | {f['cacheCreate']} | {f['cacheReadFraction']:.0%} |")

print('\n### 4. Planner arithmetic behind the T3 failures')
print('Execute budget = ORG_MAX_TURNS_EXECUTE(80) x (tokens the node has used / turns it has taken). The execute reservation was 47,523-47,598 tokens when it committed (baseline r1, candidate r2).\n')
print('| run | planner turns | planner subtype | planner in+out tokens | tokens/turn | x80 budget | enough for a 47.5k reservation? | outcome |')
print('|---|---|---|---|---|---|---|---|')
for r in recs:
    if r['task_id'] != 'T3':
        continue
    db = sqlite3.connect(f"{ROOT}/runs/{r['run_id']}/state.db")
    pr = [json.loads(p) for (p,) in db.execute("select payload from events where type='plan.result'")]
    if not pr:
        continue
    x = pr[0]; u = x.get('usage', {}); tok = u.get('input_tokens', 0) + u.get('output_tokens', 0); turns = x.get('num_turns') or 1
    budget = 80 * tok / turns
    out['planner'].append({'run': r['run_id'], 'turns': turns, 'subtype': x.get('subtype'), 'tokens': tok, 'budget': budget, 'node_state': r['node_state']})
    print(f"| {r['run_id']} | {turns} | {x.get('subtype')} | {tok} | {tok/turns:.0f} | {budget:,.0f} | {'yes' if budget >= 47523 else 'NO'} | {r['node_state']} |")

json.dump(out, open(f'{ROOT}/analysis/extra.json', 'w'), indent=1)
