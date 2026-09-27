"""Analysis of the 6 x 3 x 3 matrix (bench/swebench/run_matrix.mjs).

Reads results/matrix.jsonl and the SWE-bench reports under
grading/logs/run_evaluation/matrix-<arm>-<rep>/, and writes
results/matrix-analysis.json: per-arm totals, per-instance cells, paired
differences with bootstrap intervals, and the System-1 (Laya) evidence.

Tokens include cache writes. A cell with no report counts as unresolved and is
flagged `graded: false`, so an ungraded run is never silently a pass.
"""
import json
import os
import random
import statistics as st
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ARMS = ['direct', 'cherryontop', 'cherryontop-nolaya', 'cherryontop-nomap']
LABEL = {'direct': 'Claude Code', 'cherryontop': 'CherryOnTop + Laya', 'cherryontop-nolaya': 'CherryOnTop, Laya off', 'cherryontop-nomap': 'CherryOnTop, no repo map'}

NAME = os.environ.get('MATRIX_NAME', 'matrix')
rows = [json.loads(l) for l in open(os.path.join(HERE, 'results', f'{NAME}.jsonl')) if l.strip()]
rows = [r for r in rows if not r.get('rateLimited')]


def graded(r):
    name = f"{r['arm']}-{r['repetition']}"
    path = os.path.join(HERE, 'grading', 'logs', 'run_evaluation', f'matrix-{name}', name, r['instance_id'], 'report.json')
    if not os.path.exists(path):
        return None
    return bool(json.load(open(path)).get(r['instance_id'], {}).get('resolved'))


cells = []
for r in rows:
    res = graded(r)
    tokens = r.get('inputTokens', 0) + r.get('outputTokens', 0) + r.get('cacheReadTokens', 0) + r.get('cacheCreationTokens', 0)
    cells.append({
        'instance': r['instance_id'], 'arm': r['arm'], 'rep': r['repetition'],
        'state': r['state'], 'selfReported': r['state'] == 'COMPLETE',
        'resolved': bool(res), 'graded': res is not None,
        'costUsd': round(r.get('costUsd') or 0, 4), 'turns': r.get('turns') or 0,
        'tokens': tokens, 'cacheWrite': r.get('cacheCreationTokens', 0), 'output': r.get('outputTokens', 0),
        'wallSeconds': r.get('wallSeconds'), 'dispatches': r.get('dispatches'),
        'models': r.get('models', ''), 'patchBytes': r.get('patchBytes', 0),
        'system1Judgments': r.get('system1Judgments'), 'system1Fallbacks': r.get('system1Fallbacks'),
        'system1Surfaces': r.get('system1Surfaces'), 'system1Available': r.get('system1Available'),
    })


def mean(xs):
    return round(st.mean(xs), 4) if xs else None


def boot_ci(diffs, n=4000, seed=7):
    if len(diffs) < 2:
        return None
    rnd = random.Random(seed)
    means = sorted(st.mean(rnd.choices(diffs, k=len(diffs))) for _ in range(n))
    return [round(means[int(0.025 * n)], 4), round(means[int(0.975 * n)], 4)]


arms = {}
for arm in ARMS:
    cs = [c for c in cells if c['arm'] == arm]
    if not cs:
        continue
    resolved = sum(c['resolved'] for c in cs)
    cost = sum(c['costUsd'] for c in cs)
    arms[arm] = {
        'label': LABEL[arm], 'runs': len(cs), 'graded': sum(c['graded'] for c in cs),
        'resolved': resolved, 'resolveRate': round(resolved / len(cs), 3),
        'selfReported': sum(c['selfReported'] for c in cs),
        'meanCost': mean([c['costUsd'] for c in cs]), 'medianCost': round(st.median(c['costUsd'] for c in cs), 4),
        'totalCost': round(cost, 3), 'costPerResolved': round(cost / resolved, 4) if resolved else None,
        'meanTurns': mean([c['turns'] for c in cs]), 'meanTokens': round(st.mean(c['tokens'] for c in cs)),
        'meanWallSeconds': mean([c['wallSeconds'] or 0 for c in cs]),
        'system1Judgments': sum(c['system1Judgments'] or 0 for c in cs),
        'system1Fallbacks': sum(c['system1Fallbacks'] or 0 for c in cs),
        'plannerRuns': sum('plan:' in (c['models'] or '') for c in cs),
    }

# Paired on (instance, rep): the same task, the same repetition slot.
key = lambda c: (c['instance'], c['rep'])
by = defaultdict(dict)
for c in cells:
    by[key(c)][c['arm']] = c
pairs = {}
for a, b in [('cherryontop', 'direct'), ('cherryontop-nolaya', 'direct'), ('cherryontop', 'cherryontop-nolaya'), ('cherryontop-nomap', 'cherryontop')]:
    both = [v for v in by.values() if a in v and b in v]
    if not both:
        continue
    out = {'n': len(both)}
    for metric in ['costUsd', 'turns', 'tokens']:
        d = [v[a][metric] - v[b][metric] for v in both]
        out[metric] = {'meanDiff': round(st.mean(d), 4), 'ci95': boot_ci(d),
                       'relative': round(st.mean(d) / st.mean([v[b][metric] for v in both]), 3) if st.mean([v[b][metric] for v in both]) else None}
    rd = [int(v[a]['resolved']) - int(v[b]['resolved']) for v in both]
    out['resolved'] = {'meanDiff': round(st.mean(rd), 3), 'ci95': boot_ci(rd)}
    pairs[f'{a}_vs_{b}'] = out

per_instance = defaultdict(dict)
for inst in sorted({c['instance'] for c in cells}):
    for arm in ARMS:
        cs = [c for c in cells if c['instance'] == inst and c['arm'] == arm]
        if cs:
            per_instance[inst][arm] = {
                'runs': len(cs), 'resolved': sum(c['resolved'] for c in cs),
                'meanCost': mean([c['costUsd'] for c in cs]), 'meanTurns': mean([c['turns'] for c in cs]),
                'meanTokens': round(st.mean(c['tokens'] for c in cs)),
            }

out = {'cells': cells, 'arms': arms, 'pairs': pairs, 'perInstance': per_instance,
       'expectedCells': 54, 'recordedCells': len(cells)}
path = os.path.join(HERE, 'results', f'{NAME}-analysis.json')
json.dump(out, open(path, 'w'), indent=1)
for arm, a in arms.items():
    print(f"{a['label']:24} runs {a['runs']:2} resolved {a['resolved']:2}/{a['runs']} (graded {a['graded']})  "
          f"mean ${a['meanCost']}  turns {a['meanTurns']}  $/resolved {a['costPerResolved']}  laya calls {a['system1Judgments']}")
for k, p in pairs.items():
    print(k, 'n', p['n'], 'cost', p['costUsd'], 'resolved', p['resolved'])
print('wrote', path)
