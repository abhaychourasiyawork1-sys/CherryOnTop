# Token and turn review: the whole task flow

Date: 2026-09-26. Goal: fewer tokens and fewer turns per task, so lower cost, with no loss of quality.
Evidence: every model call and tool output of 72 CherryOnTop runs and 18 Claude Code runs on SWE-bench
Verified, plus one-turn prefix measurements in the real sandbox.

## How the money is spent

Cost per run ≈ **turns × context re-read per turn** + cache writes + output. Context re-read is ~55% of
the bill, cache writes ~22%, output ~20%. So the two levers are the **number of turns** and the
**size of what every turn carries**. Everything below is judged on those two.

A typical CherryOnTop call carried 29k tokens on turn 1 and 50k by the last turn (+866 per turn). The
largest single part of every turn was the fixed prefix, and 8.6k of it was tool, skill and agent
descriptions the task never used.

## Stage by stage

| Stage | What it adds | Measured effect | Verdict |
|---|---|---|---|
| **INTELLIGENCE_GATE**: split question (Laya) | ~300 prompt tokens to Laya, no model tokens | Laya scores every single bug report 0.58–0.69 "splittable"; on seaborn the keyword rule rated the issue "high" complexity (it counts narrative words such as "also", "test", "created" as deliverables), which drops the split threshold to 0.20, so a $0.05 planner ran and answered "no" | Open. The keyword rule misreads prose; the fix is a better Laya question, not more keywords |
| **EXECUTION_DECISION**: economics | free | correct on all 72 runs | Keep |
| **DELEGATE**: planner, children, synthesis | planner ~6 haiku turns; each child pays the full prefix; one synthesis run | Not exercised by single-issue tasks. Earlier Tier-B run: children got ~83% of the budget and neither finished | Needs its own benchmark before any change |
| **SELF_EXECUTE**: prefix | Claude Code system prompt, tools, skills, agents, memory | 23.0k tokens on a trivial task; 17 tools, 15 skills, 5 agents advertised; none of the extra ones used in 72 runs | **Fixed**: exact tool set plus skills/memory/subagents off → 14.4k (−37%) |
| SELF_EXECUTE: role prompt | 500–900 tokens | Result block requested from every run, but only a parent ever parses it | **Fixed**: only child tasks are asked for it |
| SELF_EXECUTE: repo map | ~2k tokens every turn | CherryOnTop still explores as much as Claude Code (10 vs 7 exploration calls per run) | Tested: keep it. Off saves ~3.5k tokens per turn but raised turns on 4 of 6 issues |
| SELF_EXECUTE: "sending file X" evidence | 16–73 tokens | 10 injections, all near-empty `__init__.py`-type files, never opened by the agent. The selector's value estimate does not grow with file size while the cost does, so the smallest file always ranks first | **Fixed**: files under 128 tokens are never sent in full. Open: value should scale with relevance |
| SELF_EXECUTE: agent turns | one tool per turn | 0.94 tool calls per turn, and not one turn with two, in either harness | Tried and removed: telling it to batch changed nothing (0.94 → 0.95) |
| SELF_EXECUTE: tool output | re-read on every later turn | outputs over 8k characters are 24% of all output text, mostly whole-file `Read`s | Small (under 1% of cost). Not worth a rule |
| SELF_EXECUTE: environment | turns spent discovering the sandbox | sklearn: 9.8 → 5.0 environment calls after the environment notes; `git stash` attempts 2 → 0 | Fixed (previous round) |
| **VALIDATE** | free (reads the trace) | keyword test detection and full re-runs were the largest single loss | Fixed (previous round) |
| Retry / recovery | a fresh dispatch pays the full prefix again | proof-only pass ≤15 turns; identical failures stop | Fixed (previous round) |
| Caching | 5-minute prompt cache | mid-run cache writes match normal context growth; no expiry spikes seen | Fine |
| Output | ~370 tokens per turn in both harnesses | the final report is 5× longer than Claude Code's, but that is ~$0.006 a run | Fine |

## Changes made this round (all with tests; suite 193 files / 2190 tests green)

1. `--tools Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch` plus `--disable-slash-commands` for
   unrestricted runs, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `…_BUNDLED_SKILLS` and
   `…_EXPLORE_PLAN_AGENTS` in the sandbox (`adapters/claude-code.ts`, `k8s/sandbox-env.ts`).
2. ~~Batch instruction in the execute and plan prompts~~: measured no effect (0.94 → 0.95 tool calls
   per turn, 0% → 1% of turns batched), so it was removed. The model runs one tool per turn in both
   harnesses whatever it is told.
3. Result block only for delegated children (`prompts/roles.ts`, `node-actor-manager.ts`).
4. No full-file offers for stubs under 128 tokens (`context/candidates.ts`).
5. A `cherryontop-nomap` benchmark arm, to measure the repo map (`bench/swebench/run_instance.mjs`).

6. Found by the benchmark: **a delegated parent redid its children's work.** Its validation counted
   only its own files and checks, and the first automatic checklist ruling was stored as if a person had
   made it, so it never changed. Now a parent is judged on its whole subtree, and automatic checklist
   rulings are recomputed on every attempt; only a person's ruling is final (`node-actor-manager.ts`,
   `db/queries/dod.ts`). Tests reproduce both and fail on the old code.

## Results (graded by the SWE-bench harness, 18/18 resolved)

| | Runs | Mean $/run | Median | Turns | First-call context | $ per turn |
|---|---|---|---|---|---|---|
| Claude Code (matrix) | 18 | $0.463 | $0.379 | 17.4 | ~46k | $0.0266 |
| CherryOnTop + Laya, before | 18 | $0.518 | $0.498 | 28.3 | 28.3k | $0.0183 |
| **CherryOnTop + Laya, after** | 12 | **$0.429** | **$0.366** | 26.7 | **19.8k** | **$0.0161** |
| after, without the delegation-bug run (since fixed) | 11 | $0.335 | $0.285 | 20.8 | 19.8k | $0.0161 |
| after, repo map off | 6 | $0.414 | $0.463 | 29.5 | 16.3k | $0.0140 |

- The fixed prompt fell 30% in real runs (28.3k → 19.8k) and cost per turn 12%.
- Mean cost −17% against before and −7% against Claude Code, with the median below Claude Code's. One
  seaborn run cost $1.46 and 91 turns because of the delegation bug above, which is now fixed but not
  yet re-run. Without it the mean is $0.335 (−28% against Claude Code), but treat that as a projection.
- Repo map: switching it off saves ~3.5k tokens per turn but raised turns on 4 of 6 issues (requests
  49 vs 20, xarray 46 vs 24, sympy 15 vs 8). The mean cost is a wash and n=6 is small, so **keep the map**.
- Laya's split question: three wordings were measured on live Laya against the 49 labelled goals and
  the 6 held-out issues. None separates a long bug report from a real multi-part task (mean P(many)
  0.60 vs 0.64 for the shipped wording, 0.54 vs 0.55 for the best alternative), so the question is
  unchanged. The bad split came from the **planner**, which cut one bug into "investigate" and
  "implement". The planner is now told that one bug, feature or question is one unit and never to
  split a problem into dependent phases. Live check (haiku, real sandbox): the seaborn report stayed
  one unit 2/2, and a genuine three-job goal still split 2/2.
- Benchmark driver: the CLI only renews its login near expiry, so one early refresh did nothing and
  the runner refused to start. The driver now keeps nudging until the token is actually renewed, and
  logs the runner's real error line instead of stack frames.
