#!/usr/bin/env python3
"""Full per-task statistics for the Terminal-Bench owned-runtime benchmark:
every CherryOnTop run (run1/run2/run3 job folders) and Claude Code's run, from
the raw records — CherryOnTop's per-turn receipts (exact usage, timeouts
included), Claude Code's own stream, the verifier's per-test output, and trial
timing. Writes bench/agent-owned/STATS.md and prints a one-line digest per run.

Usage: python3 bench/agent-owned/collect-stats.py
"""
import json, glob, os, sqlite3, collections, datetime
B = os.path.expanduser('~/Desktop/CherryOnTop-bench/terminal-bench')
TASKS = ['adaptive-rejection-sampler', 'bn-fit-modify', 'build-pov-ray', 'break-filter-js-from-html']
P = {'in': 1e-6, 'out': 5e-6, 'read': 0.1e-6, 'w5': 1.25e-6, 'w1h': 2e-6}  # Haiku 4.5
db = sqlite3.connect(f"file:{B}/state/owned/state.db?mode=ro", uri=True)

def trial(path_glob):
    g = [d for d in glob.glob(path_glob) if os.path.exists(d + 'result.json')]
    return g[0] if g else None

def verifier(d):
    out = {'passed': 0, 'failed': 0, 'failing': []}
    for f in glob.glob(d + 'verifier/test-stdout.txt'):
        for l in open(f, errors='replace'):
            if l.startswith('PASSED'): out['passed'] += 1
            elif l.startswith('FAILED'):
                out['failed'] += 1; out['failing'].append(l.split('::')[-1].split(' ')[0].strip())
    return out

def timing(d):
    r = json.load(open(d + 'result.json'))
    f = lambda s: datetime.datetime.fromisoformat(s.replace('Z', '+00:00'))
    secs = (f(r['finished_at']) - f(r['started_at'])).total_seconds() if r.get('started_at') and r.get('finished_at') else None
    ae = r.get('agent_execution') or {}
    agent_secs = (f(ae['finished_at']) - f(ae['started_at'])).total_seconds() if ae.get('started_at') and ae.get('finished_at') else None
    reward = ((r.get('verifier_result') or {}).get('rewards') or {}).get('reward')
    exc = (r.get('exception_info') or {}).get('exception_type')
    return r, secs, agent_secs, reward, exc

def owned(run, task):
    d = trial(f"{B}/{run}/owned/{task}/{task}__*/")
    if not d: return None
    r, secs, agent_secs, reward, exc = timing(d)
    node = (r.get('agent_result') or {}).get('metadata', {}).get('cherryontop_node')
    s = dict(arm='CherryOnTop', run=run, task=task, reward=reward, exception=exc, wall_s=secs, agent_s=agent_secs, **verifier(d))
    u = collections.Counter(); turns = 0; ctxs = []; tools = collections.Counter(); think = 0; tool_err = 0; refused = collections.Counter()
    proj = 0; spilled = 0; web = 0; disp = 0; stops = []; val = []; ev = collections.Counter(); w1h = 0; ic = collections.Counter()
    for typ, p in db.execute("select type,payload from events where node_id=? order by id", (node,)):
        p = json.loads(p)
        if typ == 'exec.owned.turn':
            turns += 1; x = p['usage']
            for k in ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'): u[k] += x.get(k) or 0
            w1h += ((x.get('cache_creation') or {}).get('ephemeral_1h_input_tokens') or 0)
            web += ((x.get('server_tool_use') or {}).get('web_search_requests') or 0)
            ctxs.append((x.get('input_tokens') or 0) + (x.get('cache_read_input_tokens') or 0) + (x.get('cache_creation_input_tokens') or 0))
            for t in p.get('tools', []):
                if t.get('refusal'): refused[t['refusal']] += 1
                if t.get('isError') and not t.get('refusal'): tool_err += 1
                if t.get('projected'): proj += 1
                if t.get('spilledTo'): spilled += 1
        elif typ == 'exec.assistant':
            for b in p['message']['content']:
                if b['type'] in ('thinking', 'redacted_thinking'): think += 1
                if b['type'] in ('tool_use', 'server_tool_use'): tools[b['name']] += 1
        elif typ == 'exec.result': disp += 1; stops.append(p.get('stop_reason'))
        elif typ == 'validation.result': val.append(f"{p.get('level')}:{'pass' if p.get('passed') else 'fail'}")
        elif typ.startswith('exec.owned.') and typ != 'exec.owned.turn': ev[typ.split('.')[-1]] += 1
        elif typ == 'ic.decision': ic[p.get('action')] += 1
    w5 = u['cache_creation_input_tokens'] - w1h
    cost = u['input_tokens'] * P['in'] + u['output_tokens'] * P['out'] + u['cache_read_input_tokens'] * P['read'] + w5 * P['w5'] + w1h * P['w1h'] + web * 0.01
    total = sum(u.values())
    s.update(dispatches=disp, turns=turns, fresh_in=u['input_tokens'], cache_read=u['cache_read_input_tokens'], cache_write=u['cache_creation_input_tokens'],
             output=u['output_tokens'], total_tokens=total, avg_tokens_per_turn=round(total / turns) if turns else 0,
             avg_context_per_turn=round(sum(ctxs) / len(ctxs)) if ctxs else 0, peak_context=max(ctxs) if ctxs else 0,
             first_context=ctxs[0] if ctxs else 0, cost=round(cost, 4), cost_per_turn=round(cost / turns, 5) if turns else 0,
             thinking_blocks=think, tool_calls=sum(tools.values()), tools=dict(tools), tool_errors=tool_err, refused=dict(refused),
             projected=proj, spilled=spilled, web_searches=web, stop_reasons=stops, validation=val, events=dict(ev),
             cache_hit_rate=round(u['cache_read_input_tokens'] / max(1, sum(ctxs)), 3), ic_decisions=dict(ic))
    return s

def claude_code(task):
    d = trial(f"{B}/jobs-run1/cc-api/{task}/{task}__*/")
    if not d: return None
    r, secs, agent_secs, reward, exc = timing(d)
    s = dict(arm='Claude Code', run='run1', task=task, reward=reward, exception=exc, wall_s=secs, agent_s=agent_secs, **verifier(d))
    msgs = {}; tools = collections.Counter(); think = 0; tool_err = 0; result = None; web = 0
    for line in open(d + 'agent/claude-code.txt', errors='replace'):
        if not line.startswith('{'): continue
        try: e = json.loads(line)
        except ValueError: continue
        if e.get('type') == 'assistant' and not e.get('parent_tool_use_id'):
            m = e['message']; cur = msgs.setdefault(m['id'], {})
            for k, v in (m.get('usage') or {}).items():
                if isinstance(v, (int, float)): cur[k] = max(cur.get(k, 0), v)
            cc = (m.get('usage') or {}).get('cache_creation') or {}
            cur['w1h'] = max(cur.get('w1h', 0), cc.get('ephemeral_1h_input_tokens') or 0)
            for b in m['content']:
                if b['type'] in ('thinking', 'redacted_thinking'): think += 1
                if b['type'] in ('tool_use', 'server_tool_use'): tools[b['name']] += 1
        elif e.get('type') == 'user':
            for b in (e.get('message') or {}).get('content') or []:
                if isinstance(b, dict) and b.get('type') == 'tool_result' and b.get('is_error'): tool_err += 1
        elif e.get('type') == 'result': result = e
    turns = len(msgs)
    ctxs = [m.get('input_tokens', 0) + m.get('cache_read_input_tokens', 0) + m.get('cache_creation_input_tokens', 0) for m in msgs.values()]
    agg = lambda k: sum(m.get(k, 0) for m in msgs.values())
    if result:
        ru = result.get('usage') or {}
        fresh, out, read, write = ru.get('input_tokens', 0), ru.get('output_tokens', 0), ru.get('cache_read_input_tokens', 0), ru.get('cache_creation_input_tokens', 0)
        cost = result.get('total_cost_usd') or 0; final = True; turns = result.get('num_turns') or turns
    else:
        fresh, out, read, write = agg('input_tokens'), agg('output_tokens'), agg('cache_read_input_tokens'), agg('cache_creation_input_tokens')
        w1h = agg('w1h'); cost = fresh * P['in'] + out * P['out'] + read * P['read'] + (write - w1h) * P['w5'] + w1h * P['w1h']; final = False
    total = fresh + out + read + write
    s.update(dispatches=1, turns=turns, fresh_in=fresh, cache_read=read, cache_write=write, output=out, total_tokens=total,
             avg_tokens_per_turn=round(total / turns) if turns else 0, avg_context_per_turn=round(sum(ctxs) / len(ctxs)) if ctxs else 0,
             peak_context=max(ctxs) if ctxs else 0, first_context=ctxs[0] if ctxs else 0, cost=round(cost, 4), cost_final=final,
             cost_per_turn=round(cost / turns, 5) if turns else 0, thinking_blocks=think, tool_calls=sum(tools.values()), tools=dict(tools),
             tool_errors=tool_err, cache_hit_rate=round(read / max(1, sum(ctxs)), 3))
    return s

rows = []
for t in TASKS:
    c = claude_code(t)
    if c: rows.append(c)
    for run in ('jobs-run1', 'jobs-run2', 'jobs'):
        o = owned(run, t)
        if o: o['run'] = {'jobs-run1': 'run1', 'jobs-run2': 'run2', 'jobs': 'run3'}[run]; rows.append(o)
json.dump(rows, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'stats.json'), 'w'), indent=1)
md = []; w = md.append
k = lambda n: f"{n/1e6:.2f}M" if n >= 1e6 else f"{n/1e3:.0f}k" if n >= 1e3 else str(n)
label = lambda r: 'Claude Code' if r['arm'] == 'Claude Code' else f"CherryOnTop {r['run']}"
ARMS = [('Claude Code', 'run1'), ('CherryOnTop', 'run1'), ('CherryOnTop', 'run2'), ('CherryOnTop', 'run3')]
pick = lambda arm, run: [r for r in rows if r['arm'] == arm and r['run'] == run]
w('# Terminal-Bench 2.0: CherryOnTop owned runtime vs Claude Code (Claude Haiku 4.5)\n')
w('All numbers from raw records: CherryOnTop per-turn receipts (exact usage, timeouts included), Claude Code stream-json, verifier test output, trial timing. Haiku 4.5 list prices ($1 in / $5 out / $0.10 cache read / $1.25 5-min write / $2 1-h write), web search $0.01. One run per task per arm.\n')
w('## Totals per run (all 4 tasks)\n')
w('| run | solved | hidden tests passed | cost | cost per solved task | total tokens | turns | avg tokens/turn | output tokens | thinking blocks | tool calls | tool errors | wall time |')
w('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for arm, run in ARMS:
    xs = pick(arm, run)
    if not xs: continue
    solved = sum(1 for x in xs if (x['reward'] or 0) >= 1); cost = sum(x['cost'] for x in xs); tok = sum(x['total_tokens'] for x in xs); turns = sum(x['turns'] for x in xs)
    tp = sum(x['passed'] for x in xs); tt = sum(x['passed'] + x['failed'] for x in xs)
    w(f"| {label(xs[0])} | {solved}/4 | {tp}/{tt} | ${cost:.2f} | {('$%.2f' % (cost/solved)) if solved else '—'} | {k(tok)} | {turns} | {k(tok//max(1,turns))} | {k(sum(x['output'] for x in xs))} | {sum(x['thinking_blocks'] for x in xs)} | {sum(x['tool_calls'] for x in xs)} | {sum(x['tool_errors'] for x in xs)} | {sum((x['wall_s'] or 0) for x in xs)/60:.0f} min |")
for t in TASKS:
    xs = [r for r in rows if r['task'] == t]
    w(f"\n## {t}\n")
    w('| run | result | hidden tests | dispatches | turns | wall | total tokens | avg tokens/turn | avg context | peak context | output (per turn) | cache hit | cost | cost/turn | thinking | tool calls | tool errors |')
    w('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for x in xs:
        res = '✅' if (x['reward'] or 0) >= 1 else '❌'
        timeout = ' (time limit)' if not x.get('stop_reasons', [1]) and x['arm'] != 'Claude Code' else (' (time limit)' if x['arm'] == 'Claude Code' and not x.get('cost_final', True) else '')
        w(f"| {label(x)} | {res}{timeout} | {x['passed']}/{x['passed']+x['failed']} | {x['dispatches']} | {x['turns']} | {(x['wall_s'] or 0)/60:.1f} min | {k(x['total_tokens'])} | {k(x['avg_tokens_per_turn'])} | {k(x['avg_context_per_turn'])} | {k(x['peak_context'])} | {k(x['output'])} ({x['output']//max(1,x['turns'])}) | {x['cache_hit_rate']:.0%} | ${x['cost']:.3f} | ${x['cost_per_turn']:.4f} | {x['thinking_blocks']} | {x['tool_calls']} | {x['tool_errors']} |")
    w('\nCost by component (USD):\n')
    w('| run | output | cache reads | cache writes | fresh input | web search |')
    w('|---|---|---|---|---|---|')
    for x in xs:
        out, rd, fr = x['output']*5e-6, x['cache_read']*0.1e-6, x['fresh_in']*1e-6; web = (x.get('web_searches') or 0)*0.01
        w(f"| {label(x)} | ${out:.3f} | ${rd:.3f} | ${max(0, x['cost']-out-rd-fr-web):.3f} | ${fr:.3f} | ${web:.2f} |")
    w('\nHarness detail:\n')
    w('| run | validation verdicts | harness events | tools used | failing tests |')
    w('|---|---|---|---|---|')
    for x in xs:
        ev = ', '.join(f"{a}×{b}" for a, b in (x.get('events') or {}).items()) or '—'
        if x.get('projected'): ev += f", projected×{x['projected']}"
        if x.get('web_searches'): ev += f", web search×{x['web_searches']}"
        tools = ', '.join(f"{a} {b}" for a, b in sorted(x['tools'].items(), key=lambda kv: -kv[1]))
        w(f"| {label(x)} | {', '.join(x.get('validation') or []) or '—'} | {ev} | {tools} | {', '.join(x['failing']) or '—'} |")
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'STATS.md'), 'w').write('\n'.join(md) + '\n')
for r in rows:
    print(f"{r['task'][:22]:22} {r['arm'][:11]:11} {r['run']} reward={r['reward']} tests={r['passed']}/{r['passed']+r['failed']} turns={r['turns']} tok={r['total_tokens']} avg/turn={r['avg_tokens_per_turn']} ctx={r['avg_context_per_turn']}/{r['peak_context']} cost=${r['cost']} think={r['thinking_blocks']} calls={r['tool_calls']} err={r['tool_errors']} wall={r['wall_s'] and round(r['wall_s'])}s")
