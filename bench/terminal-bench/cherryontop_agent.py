"""CherryOnTop as a Harbor agent, for Terminal-Bench.

The task container is the sandbox. Harbor's own Claude Code installer puts the
same CLI in it that the stock `claude-code` arm uses; CherryOnTop's daemon then
runs on the host and dispatches into the container with `docker exec`
(src/execution/container-exec.ts), with its whole decision stack (execution
market, System-1, validation, information control) intact.

Configuration, from the environment of the `harbor run` process:

  CTO_ROOT         CherryOnTop checkout (dist/ must be built)       required
  CTO_STATE        directory for this arm's shared state.db         required
  CTO_IC_MODE      off | shadow | active                            default shadow
  CTO_IC_DISABLE   comma list of controller components to ablate    default none
  CTO_MODEL        model alias pinned for every role                default haiku
  CTO_BUDGET       task budget in USD                               default 5
  CTO_PORT         daemon port (hook listener = port + 100)         default 4400
  CTO_HOOK_HOST    address task containers reach the host at        default 172.17.0.1
  CTO_RUNTIME      claude-code | anthropic-owned                    default claude-code
                   anthropic-owned runs CherryOnTop's own agent loop on the
                   host against the API (ANTHROPIC_API_KEY in this process's
                   environment): nothing is installed in the task container
                   and no login or key is copied into it.

Delegation is off (max-children 1): a task has one container, and parallel
children would share its work directory. Every arm runs the same way.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment
from harbor.environments.docker.docker import _sanitize_docker_compose_project_name
from harbor.models.agent.context import AgentContext

TERMINAL = {"COMPLETE", "FAILED", "CANCELLED"}


def _owned() -> bool:
    return os.environ.get("CTO_RUNTIME", "claude-code") == "anthropic-owned"


def _login() -> bytes:
    """The account login both arms copy into the task container, checked first.

    A login file without a token, or one about to expire, would make every agent
    turn fail authentication: a trial that measures nothing but still counts.
    Refusing here turns that into an explicit, attributable error instead.
    """
    path = Path.home() / ".claude" / ".credentials.json"
    raw = path.read_bytes()
    oauth = json.loads(raw).get("claudeAiOauth") or {}
    if not oauth.get("accessToken"):
        raise RuntimeError("BENCH LOGIN INVALID: ~/.claude/.credentials.json holds no access token; sign in with `claude` and rerun")
    expires = oauth.get("expiresAt") or 0
    if expires and expires - time.time() * 1000 < 30 * 60_000:
        raise RuntimeError("BENCH LOGIN INVALID: the Claude login expires within 30 minutes; run `claude` to refresh it and rerun")
    return raw


def _env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None:
        raise RuntimeError(f"{name} is not set")
    return value


class _BenchEnvironment(ClaudeCode):
    """What both arms share: this host's environment fixes, nothing about the agent."""

    async def install(self, environment: BaseEnvironment) -> None:
        # This host's containers have no IPv6 route while DNS answers AAAA first,
        # so apt waits out an IPv6 timeout per mirror (>6 min for nodejs+npm).
        # Forcing IPv4 inside the task container fixes that without touching the host.
        await environment.exec(
            command="[ -d /etc/apt/apt.conf.d ] && echo 'Acquire::ForceIPv4 \"true\";' > /etc/apt/apt.conf.d/99force-ipv4 || true",
            user="root",
        )
        # Several containers installing at once intermittently fail DNS (curl
        # exit 6) or apt (exit 100). An install that never happened is not a
        # task result, so retry it before a trial is wasted; both arms alike.
        for attempt in range(3):
            try:
                await super().install(environment)
                return
            except Exception:
                if attempt == 2:
                    raise
                await asyncio.sleep(20 * (attempt + 1))

    async def _docker(self, *args: str, stdin: bytes | None = None, check: bool = True) -> str:
        proc = await asyncio.create_subprocess_exec(
            "docker", *args,
            stdin=asyncio.subprocess.PIPE if stdin is not None else None,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate(stdin)
        if check and proc.returncode != 0:
            raise RuntimeError(f"docker {' '.join(args[:3])} failed: {err.decode()[-500:]}")
        return out.decode()

    async def _container(self, environment: BaseEnvironment) -> str:
        project = _sanitize_docker_compose_project_name(environment.session_id)
        out = await self._docker(
            "ps", "-q",
            "--filter", f"label=com.docker.compose.project={project}",
            "--filter", "label=com.docker.compose.service=main",
        )
        ids = out.split()
        if not ids:
            raise RuntimeError(f"no running container for compose project {project}")
        return ids[0]

class CherryOnTop(_BenchEnvironment):
    @staticmethod
    def name() -> str:
        return "cherryontop"

    async def install(self, environment: BaseEnvironment) -> None:
        if not _owned():
            return await super().install(environment)
        # The owned loop needs no agent in the container: only the host fix.
        await environment.exec(
            command="[ -d /etc/apt/apt.conf.d ] && echo 'Acquire::ForceIPv4 \"true\";' > /etc/apt/apt.conf.d/99force-ipv4 || true",
            user="root",
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        # run() fills the context from CherryOnTop's own ledger.
        return None

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        root = Path(_env("CTO_ROOT"))
        state = Path(_env("CTO_STATE"))
        state.mkdir(parents=True, exist_ok=True)
        cli = root / "dist" / "cli" / "index.js"
        port = int(_env("CTO_PORT", "4400"))
        model = _env("CTO_MODEL", "haiku")
        trial = self.logs_dir / "cherryontop"
        trial.mkdir(parents=True, exist_ok=True)
        log = (trial / "driver.log").open("a")

        def note(message: str) -> None:
            log.write(f"[{time.strftime('%H:%M:%S')}] {message}\n")
            log.flush()

        container = await self._container(environment)
        async def shell(command: str) -> str:
            return ((await environment.exec(command=command)).stdout or "").strip()

        workdir = await shell("pwd") or "/app"
        # Harbor installed the CLI as the task's agent user; run as that user, with
        # the CLI's directory on PATH (a non-login exec reads no profile, and some
        # images' login profile does not add the install directory either).
        user = await shell("id -un") or "root"
        if _owned():
            if not os.environ.get("ANTHROPIC_API_KEY"):
                raise RuntimeError("CTO_RUNTIME=anthropic-owned needs ANTHROPIC_API_KEY in the harbor process environment")
            path = await shell('bash -lc \'echo "$PATH"\' 2>/dev/null || echo "$PATH"')
            note(f"container {container} workdir {workdir} user {user} runtime anthropic-owned")
        else:
            claude = await shell(
                "bash -lc 'command -v claude' 2>/dev/null || "
                "for c in \"$HOME/.local/bin/claude\" /usr/local/bin/claude /usr/bin/claude; do [ -x \"$c\" ] && echo \"$c\" && break; done"
            )
            claude = claude.splitlines()[-1] if claude else ""
            if not claude:
                raise RuntimeError("claude is not installed for the agent user")
            path = await shell('bash -lc \'echo "$PATH"\' 2>/dev/null || echo "$PATH"')
            path = f"{os.path.dirname(claude)}:{path}"
            note(f"container {container} workdir {workdir} user {user} claude {claude}")

            # The account's login, as the Kubernetes path mounts it: a copy the
            # sandbox can use and cannot refresh.
            await self._docker(
                "exec", "-i", "-u", user, container, "sh", "-c",
                'mkdir -p "$HOME/.claude" && cat > "$HOME/.claude/.credentials.json" && chmod 600 "$HOME/.claude/.credentials.json"',
                stdin=_login(),
            )

        # The host mirror the lifecycle's git bookkeeping reads.
        mirror = trial / "mirror"
        if mirror.exists():
            shutil.rmtree(mirror)
        mirror.mkdir()
        await self._docker("cp", f"{container}:{workdir}/.", str(mirror))
        git = lambda *a: subprocess.run(["git", *a], cwd=mirror, capture_output=True, text=True)  # noqa: E731
        git("init", "-q")
        git("add", "-A")
        git("-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-qm", "task start", "--allow-empty")

        env = {
            **os.environ,
            "ORG_DB_PATH": str(state / "state.db"),
            "ORG_DAEMON_PORT": str(port),
            "ORG_DAEMON_NAME": f"cto-tb-{port}",
            "ORG_LAYA_PORT": str(port + 4000),
            "ORG_EXEC_CONTAINER": container,
            "ORG_SANDBOX_WORKDIR": workdir,
            "ORG_EXEC_MIRROR": str(mirror),
            "ORG_EXEC_PATH": path,
            "ORG_EXEC_USER": user,
            "ORG_IC_MODE": _env("CTO_IC_MODE", "shadow"),
            "ORG_IC_DISABLE": _env("CTO_IC_DISABLE", ""),
            "ORG_IC_HOOK_HOST": _env("CTO_HOOK_HOST", "172.17.0.1"),
            "ORG_IC_HOOK_PORT": str(port + 100),
            "ORG_TASK_SPEND_CAP_USD": _env("CTO_BUDGET", "5"),
            "ORG_RUNTIME": "anthropic-owned" if _owned() else "claude-code",
            # Stock Claude Code has no turn cap; the task's spend cap is the
            # bound. 0 is the documented "uncapped" (src/config/efficiency.ts).
            # Left at the default, the execute cap (60, lowered further by the
            # complexity band) cut build-pov-ray off mid-build.
            "ORG_MAX_TURNS_EXECUTE": _env("CTO_MAX_TURNS_EXECUTE", "0"),
            "ORG_RESULT_CACHE_TTL_HOURS": "0",
            "ORG_PLAN_CACHE_TTL_HOURS": "0",
            **{f"ORG_MODEL_{role}": model for role in ("EXECUTE", "PLAN", "SYNTHESIZE", "FAST", "STANDARD", "DEEP")},
        }

        def org(*args: str, timeout: int = 120) -> str:
            done = subprocess.run(["node", str(cli), *args], env=env, capture_output=True, text=True, timeout=timeout)
            if done.returncode != 0:
                raise RuntimeError(f"org {args[0]} failed: {done.stderr[-800:]}")
            return done.stdout

        started = time.time()
        node_id = None
        try:
            org("daemon", "start")
            deadline = time.time() + 300
            while True:
                try:
                    import urllib.request
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/trpc/daemon.ping", timeout=2) as r:
                        ping = json.loads(r.read()).get("result", {}).get("data") or {}
                    if ping.get("system1", {}).get("ready") or ping.get("system1", {}).get("mode") == "off":
                        break
                except Exception:
                    pass
                if time.time() > deadline:
                    raise RuntimeError("daemon/System-1 not ready in 5 minutes")
                await asyncio.sleep(1.5)
            note(f"daemon ready in {time.time() - started:.1f}s")

            out = org("run", instruction, "--repo", str(mirror), "--spawn", "--max-children", "1",
                      "--budget", _env("CTO_BUDGET", "5"))
            node_id = next((line.split()[-1] for line in out.splitlines() if line.startswith("Root node created:")), None)
            if not node_id:
                raise RuntimeError(f"no node id in: {out[-500:]}")
            note(f"root node {node_id}")

            state_name = ""
            while state_name not in TERMINAL:
                await asyncio.sleep(5)
                try:
                    line = next((l for l in org("tree").splitlines() if l.startswith(node_id)), "")
                    state_name = (line.split() + ["", ""])[1]
                except Exception as exc:  # the tree is informational; keep waiting
                    note(f"tree failed: {exc}")
            note(f"state {state_name} after {time.time() - started:.0f}s")
            await asyncio.sleep(5)  # trailing usage and validation events
        finally:
            if node_id:
                # A run the subscription refused is not a task result: say so where
                # sweep.sh looks, so the task is retried after the window resets.
                try:
                    import sqlite3
                    with sqlite3.connect(str(state / "state.db")) as db:
                        refused = db.execute(
                            "select count(*) from events where node_id = ? and type = 'exec.rate_limit_event' "
                            # The request's own status; every event also carries an
                            # unrelated "overageStatus":"rejected".
                            "and payload like '%\"rate_limit_info\":{\"status\":\"rejected\"%'", (node_id,)).fetchone()[0]
                    if refused:
                        note(f"RATE LIMITED ({refused} rejected requests)")
                except Exception as exc:
                    note(f"rate-limit check failed: {exc}")
                try:
                    tokens = json.loads(org("tokens", node_id, "--json", "--economic"))
                    (trial / "tokens.json").write_text(json.dumps(tokens, indent=1))
                    rows = tokens.get("rows", [])
                    cache = sum(r.get("cacheReadTokens", 0) + r.get("cacheCreationTokens", 0) for r in rows)
                    context.n_input_tokens = sum(r.get("inputTokens", 0) for r in rows) + cache
                    context.n_cache_tokens = cache
                    context.n_output_tokens = sum(r.get("outputTokens", 0) for r in rows)
                    context.cost_usd = sum(r.get("costUsd", 0.0) for r in rows)
                    context.metadata = {"cherryontop_node": node_id, "ic_mode": env["ORG_IC_MODE"], "ic_disable": env["ORG_IC_DISABLE"], "runtime": env["ORG_RUNTIME"]}
                except Exception as exc:
                    note(f"tokens failed: {exc}")
            try:
                org("daemon", "stop")
            except Exception as exc:
                note(f"daemon stop failed: {exc}")
            # The supervised Laya's key lands beside the database: a credential, not evidence.
            (state / "laya.key").unlink(missing_ok=True)
            log.close()


class StockClaudeCode(_BenchEnvironment):
    """Harbor's own Claude Code agent, unchanged, on the same subscription login.

    The comparison arm. Everything about the agent (command, flags, prompt,
    model, effort, transcript capture) is Harbor's `claude-code`; the only
    additions are the environment fixes both arms share and the login: the same
    ~/.claude/.credentials.json the CherryOnTop arm copies in, placed in the
    CLAUDE_CONFIG_DIR Harbor's run uses, and deleted afterwards (that directory
    is mirrored into the job's logs).
    """

    @staticmethod
    def name() -> str:
        return "claude-code-stock"

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        container = await self._container(environment)
        config = (self.environment_logs_dir / "sessions").as_posix()
        login = _login()
        await self._docker(
            "exec", "-i", container, "sh", "-c",
            'mkdir -p "$1" && cat > "$1/.credentials.json" && chmod 600 "$1/.credentials.json"', "sh", config,
            stdin=login,
        )
        try:
            await super().run(instruction, environment, context)
        finally:
            await self._docker("exec", container, "rm", "-f", f"{config}/.credentials.json", check=False)
            (self.logs_dir / "sessions" / ".credentials.json").unlink(missing_ok=True)


class ClaudeCodeApi(_BenchEnvironment):
    """Harbor's own Claude Code agent, installed fresh from the web into the
    task container, unchanged, billed on ANTHROPIC_API_KEY from the harbor
    process (Harbor passes it through). No subscription login is copied, so
    both arms of an owned-runtime comparison pay the same API price list."""

    @staticmethod
    def name() -> str:
        return "claude-code-api"
