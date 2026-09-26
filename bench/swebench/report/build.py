"""Fills report/template.html with results/matrix-analysis.json and
report/findings.json ({meta, findings}) -> report/matrix-report.html."""
import json, os
H = os.path.dirname(os.path.abspath(__file__))
t = open(os.path.join(H, 'template.html')).read()
data = json.load(open(os.path.join(H, '..', 'results', 'matrix-analysis.json')))
f = json.load(open(os.path.join(H, 'findings.json'))) if os.path.exists(os.path.join(H, 'findings.json')) else {'meta': {}, 'findings': []}
safe = lambda o: json.dumps(o).replace('</', '<\\/')
out = t.replace('/*DATA*/null', safe(data)).replace('/*FINDINGS*/[]', safe(f['findings'])).replace('/*META*/{}', safe(f['meta']))
open(os.path.join(H, 'matrix-report.html'), 'w').write(out)
print('wrote', os.path.join(H, 'matrix-report.html'))
