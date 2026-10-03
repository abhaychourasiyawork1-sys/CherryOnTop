#!/usr/bin/env python3
"""Per-task cost and tokens: CherryOnTop vs stock Claude Code, same Terminal-Bench tasks.

Both arms run the same Claude Code binary (Harbor's install in the task
container) on Claude Haiku 4.5 with the same login, and both are measured by
that CLI's own accounting, so the numbers are directly comparable:

  CherryOnTop   agent/cherryontop/tokens.json  (its ledger: every dispatch the task took)
  stock         agent/claude-code.txt          (the CLI's final stream-json `result`)

A run the task's time limit killed has no final account in either arm. Its
usage is then summed from the per-message usage the model API reported
(deduplicated by message id), priced at list rates with the API's own 5-minute /
1-hour cache-write split. Checked against finished runs: input, cache reads and
cache writes match exactly, but streamed output counts are placeholders, so
such a cost is a lower bound ("≥", "*"). Headline totals use only tasks where
both arms have a final account.

Usage: python3 compare.py [--json out.json] [--md out.md]
"""
import glob
import json
import os
import sys

B = os.path.expanduser("~/Desktop/CherryOnTop-bench/terminal-bench")
TASKS = open(f"{B}/ten-tasks.txt").read().split()
ARG = lambda flag: sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else None  # noqa: E731


def trial_dir(arm, task):
    # One job per task (jobs/<arm>/<task>/<trial>) or one job for all (jobs/<arm>/<job>/<task>__<id>).
    dirs = [d for d in glob.glob(f"{B}/jobs/{arm}/**/{task}__*/", recursive=True) if os.path.exists(d + "result.json")]
    return dirs[0] if dirs else None


def reward_of(d):
    r = json.load(open(d + "result.json"))
    rewards = (r.get("verifier_result") or {}).get("rewards") or {}
    exc = (r.get("exception_info") or {}).get("exception_type")
    secs = None
    if r.get("started_at") and r.get("finished_at"):
        from datetime import datetime
        f = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))  # noqa: E731
        secs = (f(r["finished_at"]) - f(r["started_at"])).total_seconds()
    return float(rewards.get("reward", 0.0) or 0.0), exc, secs


import sqlite3

# Claude Haiku 4.5 list prices, USD per token.
PRICE = {"input": 1e-6, "output": 5e-6, "read": 0.1e-6, "write_5m": 1.25e-6, "write_1h": 2e-6}


def from_messages(messages):
    """Usage and cost from per-message API usage, each message counted once."""
    best = {}
    for m in messages:
        mid, u = m.get("id"), m.get("usage") or {}
        if not mid:
            continue
        cur = best.setdefault(mid, {})
        for key in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
            cur[key] = max(cur.get(key, 0), u.get(key, 0) or 0)
        cc = u.get("cache_creation") or {}
        for key in ("ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"):
            cur[key] = max(cur.get(key, 0), cc.get(key, 0) or 0)
    agg = lambda key: sum(m.get(key, 0) for m in best.values())  # noqa: E731
    write = agg("cache_creation_input_tokens")
    w1h, w5m = agg("ephemeral_1h_input_tokens"), agg("ephemeral_5m_input_tokens")
    if w1h + w5m == 0:
        w1h = write  # no split reported: the CLI writes its cache with the 1-hour TTL
    cost = (agg("input_tokens") * PRICE["input"] + agg("output_tokens") * PRICE["output"]
            + agg("cache_read_input_tokens") * PRICE["read"] + w1h * PRICE["write_1h"] + w5m * PRICE["write_5m"])
    return {"fresh": agg("input_tokens"), "cache_read": agg("cache_read_input_tokens"), "cache_write": write,
            "output": agg("output_tokens"), "turns": len(best), "cost": cost, "estimated": True}


def cherryontop(d):
    p = d + "agent/cherryontop/tokens.json"
    if not os.path.exists(p):
        return None
    rows = json.load(open(p)).get("rows", [])
    if not rows:
        # Killed mid-dispatch: the ledger records usage when a dispatch ends.
        r = json.load(open(d + "result.json"))
        node = ((r.get("agent_result") or {}).get("metadata") or {}).get("cherryontop_node")
        db_path = f"{B}/state/active/state.db"
        if not node or not os.path.exists(db_path):
            return None
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        msgs = [json.loads(p).get("message") or {} for (p,) in db.execute(
            "select payload from events where node_id = ? and type in ('exec.assistant', 'plan.assistant', 'synth.assistant')", (node,))]
        return {**from_messages(msgs), "dispatches": None}
    return {
        "fresh": sum(r.get("inputTokens", 0) for r in rows),
        "cache_read": sum(r.get("cacheReadTokens", 0) for r in rows),
        "cache_write": sum(r.get("cacheCreationTokens", 0) for r in rows),
        "output": sum(r.get("outputTokens", 0) for r in rows),
        "turns": sum(r.get("turns", 0) for r in rows),
        "dispatches": sum(r.get("dispatches", 0) for r in rows),
        "cost": sum(r.get("costUsd", 0.0) for r in rows),
    }


def stock(d):
    p = d + "agent/claude-code.txt"
    if not os.path.exists(p):
        return None
    result = None
    for line in open(p, errors="replace"):
        line = line.strip()
        if line.startswith("{") and '"type":"result"' in line.replace(" ", ""):
            try:
                result = json.loads(line)
            except ValueError:
                pass
    if not result:
        # Killed by the time limit: no final account, so count the messages.
        msgs = []
        for line in open(p, errors="replace"):
            if '"type":"assistant"' in line.replace(" ", ""):
                try:
                    msgs.append(json.loads(line).get("message") or {})
                except ValueError:
                    pass
        return {**from_messages(msgs), "dispatches": 1} if msgs else None
    u = result.get("usage") or {}
    return {
        "fresh": u.get("input_tokens", 0),
        "cache_read": u.get("cache_read_input_tokens", 0),
        "cache_write": u.get("cache_creation_input_tokens", 0),
        "output": u.get("output_tokens", 0),
        "turns": result.get("num_turns", 0),
        "dispatches": 1,
        "cost": result.get("total_cost_usd", 0.0) or 0.0,
    }


rows = []
for task in TASKS:
    row = {"task": task}
    for arm, read in (("cto", cherryontop), ("cc", stock)):
        d = trial_dir("active" if arm == "cto" else "stock", task)
        if d:
            reward, exc, secs = reward_of(d)
            row[arm] = {"reward": reward, "exception": exc, "seconds": secs, **(read(d) or {})}
    rows.append(row)

tot = lambda r: r.get("fresh", 0) + r.get("cache_read", 0) + r.get("cache_write", 0) + r.get("output", 0)  # noqa: E731
k = lambda n: f"{n / 1000:,.0f}k" if n >= 1000 else str(n)  # noqa: E731
lines = []
w = lines.append
w("## Per task: CherryOnTop vs stock Claude Code (Haiku 4.5, Terminal-Bench 2.0)\n")
w("| task | solved CoT / CC | cost CoT | cost CC | Δ cost | tokens CoT | tokens CC | turns CoT / CC |")
w("|---|---|---|---|---|---|---|---|")
both = [r for r in rows if "cost" in r.get("cto", {}) and "cost" in r.get("cc", {})
        and not r["cto"].get("estimated") and not r["cc"].get("estimated")]
for r in rows:
    a, b = r.get("cto"), r.get("cc")
    mark = lambda x: ("✅" if x["reward"] >= 1 else "❌") + (f" ({x['exception']})" if x.get("exception") else "") if x else "…"  # noqa: E731
    star = lambda x: "*" if x.get("estimated") else ""  # noqa: E731
    money = lambda x: (f"≥${x['cost']:.3f}*" if x.get("estimated") else f"${x['cost']:.3f}")  # noqa: E731
    ca = money(a) if a and "cost" in a else "—"
    cb = money(b) if b and "cost" in b else "—"
    dc = (f"{100 * (a['cost'] - b['cost']) / b['cost']:+.0f}%" if a and b and "cost" in a and "cost" in b and b["cost"]
          and not a.get("estimated") and not b.get("estimated") else "—")
    ta = k(tot(a)) if a and "cost" in a else "—"
    tb = k(tot(b)) if b and "cost" in b else "—"
    tu = f"{a.get('turns', '—') if a else '—'} / {b.get('turns', '—') if b else '—'}"
    w(f"| {r['task']} | {mark(a)} / {mark(b)} | {ca} | {cb} | {dc} | {ta} | {tb} | {tu} |")


def agg(arm, subset):
    xs = [r[arm] for r in subset if arm in r and "cost" in r[arm]]
    solved = sum(1 for x in xs if x["reward"] >= 1)
    cost = sum(x["cost"] for x in xs)
    return {
        "tasks": len(xs), "solved": solved, "cost": cost, "cost_per_solved": cost / solved if solved else None,
        "tokens": sum(tot(x) for x in xs), "fresh": sum(x["fresh"] for x in xs), "cache_read": sum(x["cache_read"] for x in xs),
        "cache_write": sum(x["cache_write"] for x in xs), "output": sum(x["output"] for x in xs), "turns": sum(x["turns"] for x in xs),
    }


A, C = agg("cto", both), agg("cc", both)
w("\n\\* hit the task's time limit, so there is no final account: input and cache usage are exact, output is not counted (a lower bound).")
w(f"\n## Totals over the {len(both)} tasks where both arms have a final account\n")
w("| | CherryOnTop | Claude Code | difference |")
w("|---|---|---|---|")
pct = lambda x, y: f"{100 * (x - y) / y:+.0f}%" if y else "—"  # noqa: E731
w(f"| tasks solved | {A['solved']} / {A['tasks']} | {C['solved']} / {C['tasks']} | {A['solved'] - C['solved']:+d} |")
w(f"| total cost | ${A['cost']:.2f} | ${C['cost']:.2f} | {pct(A['cost'], C['cost'])} |")
cps = lambda x: f"${x:.3f}" if x else "— (none solved)"  # noqa: E731
w(f"| cost per solved task | {cps(A['cost_per_solved'])} | {cps(C['cost_per_solved'])} | "
  f"{pct(A['cost_per_solved'], C['cost_per_solved']) if A['cost_per_solved'] and C['cost_per_solved'] else '—'} |")
for label, key in (("total tokens", "tokens"), ("  cache reads", "cache_read"), ("  cache writes", "cache_write"),
                   ("  output", "output"), ("  fresh input", "fresh"), ("model turns", "turns")):
    w(f"| {label} | {k(A[key])} | {k(C[key])} | {pct(A[key], C[key])} |")

print("\n".join(lines))
if ARG("--md"):
    open(ARG("--md"), "w").write("\n".join(lines) + "\n")
if ARG("--json"):
    json.dump({"rows": rows, "totals": {"cherryontop": A, "claude_code": C}}, open(ARG("--json"), "w"), indent=1)
