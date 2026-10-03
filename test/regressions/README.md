# Regression index

One line per test in the codebase that exists to keep a specific, previously-real
bug from coming back. Found by grepping `src/**/*.test.ts` for a `Regression:`
comment plus the same "this used to be wrong" pattern under other wording
(`the bug found in...`, `the real case:...`). This is not every test that
happens to guard something — it is the ones that name a bug class explicitly.

| Test | Bug class it prevents |
| --- | --- |
| `src/adapters/claude-code.test.ts:24` (`builds the headless streaming command for a goal`) | Missing `--verbose`/`--dangerously-skip-permissions` flags: the real `claude` binary rejects `--print --output-format stream-json` without `--verbose`, and auto-denies every edit with no permission mode — a command that looked right in isolation but failed against the real binary. |
| `src/adapters/claude-code.test.ts:6-18` (`REAL_FIXTURE_LINES`, gap G8) | Adapter parser silently discarding every real event: the old parser validated raw lines directly against `{type, payload}` and rejected real `claude` output because real lines carry no `payload` field — they *are* the payload, with `type` as a sibling key. |
| `src/cli/commands/doctor.test.ts:27-41` (`binary probes detect an installed binary`) | False-negative health check: `kubectl` rejects `--version`, so a probe flag shared across all binaries reported an installed `kubectl` as "not found". |
| `src/cli/commands/doctor.test.ts:14` (`fails for Node 20`) | Wrong version floor: the Node-version check used to pass on Node 20 despite the repo's Node 22 floor. |
| `src/execution/runtime-error.test.ts:25-33` (`prefers the runtime's own reason over "see pod logs"`) | Misleading generic failure message: a real runtime failure reason (e.g. "Request timed out") was discarded in favor of the generic "Job failed — see pod logs", sending the reader to `kubectl` for something the runtime had already explained. |
| `src/execution/runtime-error.test.ts:52-63` (`reports an exhausted quota as a quota problem, not a timeout`) | Wrong error classification: the runtime reports "Request timed out" when its usage window is actually spent; without checking for a `rate_limit_event` in the same stream, an exhausted quota was misreported as a timeout, pointing the user at the wrong remediation (retrying, which only burns more of an already-empty quota). |
| `test/unit/vitest-project-classification.test.ts` (Task 3) | Test-suite misclassification: a `src/lifecycle/*.integration.test.ts` file that needs a real cluster must land in the `k8s` Vitest project, never `integration`, and vice versa for one that fully mocks the cluster boundary — getting this wrong either skips real-cluster coverage silently or makes a mocked test falsely require a cluster. |
