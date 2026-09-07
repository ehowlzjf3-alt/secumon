"""AgentTool — generic sub-agent spawn 도구 (v3.12-E, v3.81 T1b subprocess).

`AgentTool(subagent_type=..., input={...})` 호출 시:
1. agents/<subagent_type>.md 에서 정의 로드 (없으면 not_found)
2. spec build: {task_id, task_type, charter_ref, target: {input fields}}
3. evidence_dir/sub-<ts>-<name>/ 만들고 task_spec.json 영속화
4. WorkerPool(k=1) 로 `python -m secu_agent.agent <sub_evidence>` subprocess 실행
5. worker_result.json (fail-closed 유일 채널) 판정 + agent_result.json
   (fail-open 보조 채널) 있으면 본문 동봉

v3.81 T1b: 백엔드를 thread(`spawn_subagent` — kill 불가·병렬 없음)에서
WorkerPool subprocess 로 교체 — 취소/backstop 시 SIGTERM→grace→SIGKILL 로
실제 종료되고(좀비 thread 없음), 부모 ESC/turn 취소가 워커까지 전파된다.
재귀 깊이는 `SA_AGENT_DEPTH`(워커 env 로 +1 상속) / `SA_AGENT_MAX_DEPTH`
(기본 2)로 제한 — 무한 self-spawn 차단.

운영팀이 새 sub-agent 추가 = agents/<name>.md 파일 하나만 작성.
"""
from __future__ import annotations

import asyncio
import contextlib
import json as _json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field

import secu_agent
from secu_agent.agent.agents import AgentDef, get_agent, load_agents
from secu_agent.agent.schema.worker_result import (
    WorkerResult, WorkerResultInvalid,
)
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
    inherit_charter_ref, make_sub_evidence_dir, subagent_timeout_sec,
)
from secu_agent.agent.worker_pool import (
    WorkerCompletion, WorkerPool, WorkerSpec,
)

log = logging.getLogger("secu_agent.agent_tool")

# ── #32: 자식의 생존을 부모 타이머에 되먹인다 ──────────────────────────────
#
# 위임은 부모 하네스에 이벤트를 하나도 안 낸다. 그래서 `AgentActivityTracker` 가
# "관측 가능한 진척 없음" 으로 읽고 런을 죽였다 — 자식은 멀쩡히 일하고 있었다.
# 실측(2026-08-22 github 리드): 자식은 turn 30 에서 web_fetch 를 성공시키며
# 스냅샷 디렉터리를 계속 갱신하는 중이었는데 부모가 300.3s 에 런을 abort 했다.
#
# ★ 이건 heartbeat 이 아니다. "살아있다" 를 무조건 찍으면 진짜 hang 도 안 잡힌다.
#   자식 증거 트리의 지문이 **실제로 바뀌었을 때만** 보고한다. 안 바뀌면 아무 말도
#   하지 않고, 그러면 부모 idle 이 예전처럼 발동한다.
PROGRESS_INTERVAL_ENV = "SA_SUBAGENT_PROGRESS_INTERVAL_SEC"
_PROGRESS_INTERVAL_DEFAULT = 10.0
SILENCE_SEC_ENV = "SA_SUBAGENT_SILENCE_SEC"
_SILENCE_RATIO = 0.8      # 부모 idle 예산의 이 비율만큼 조용하면 위임을 포기한다
_SILENCE_FLOOR_SEC = 30.0
# ★ 바닥값이 예산을 넘어설 수 있다(예산 20s → 바닥 30s). 그러면 런이 **먼저** 죽어
#   불변식이 뒤집힌다. 그래서 바닥을 올린 뒤 반드시 이 천장으로 다시 자른다.
_SILENCE_CEIL_RATIO = 0.9
# 지문 계산 비용 상한 — 스냅샷이 쌓인 트리에서 매 tick 전수 walk 를 돌지 않는다.
_LIVENESS_MAX_ENTRIES = 20_000


def _liveness_fingerprint(root: Path) -> tuple[int, int, int]:
    """자식 증거 트리의 (파일 수, 총 바이트, 최대 mtime_ns).

    셋 중 하나라도 바뀌면 자식이 뭔가 썼다는 뜻이다 — 새 파일(수), 추가 기록(바이트),
    같은 크기 덮어쓰기(mtime) 를 각각 잡는다. 읽기 실패는 조용히 건너뛴다:
    관측이 실행을 죽이면 안 된다.
    """
    files = 0
    total = 0
    newest = 0
    stack: list[Path] = [root]
    while stack and files < _LIVENESS_MAX_ENTRIES:
        cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            stack.append(Path(e.path))
                            continue
                        st = e.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    files += 1
                    total += st.st_size
                    if st.st_mtime_ns > newest:
                        newest = st.st_mtime_ns
                    if files >= _LIVENESS_MAX_ENTRIES:
                        break
        except OSError:
            continue
    return (files, total, newest)


def _progress_interval_sec() -> float:
    raw = (os.environ.get(PROGRESS_INTERVAL_ENV) or "").strip()
    try:
        v = float(raw)
        if v > 0:
            return v
    except ValueError:
        pass
    return _PROGRESS_INTERVAL_DEFAULT


def _silence_limit_sec(ctx: ToolContext) -> float:
    """자식이 이만큼 조용하면 **위임만** 포기한다(런은 안 죽인다). 0 = 끔.

    부모 idle 예산보다 반드시 작아야 한다 — 그래야 런이 abort 되기 전에 ToolError
    가 리드에게 돌아가고, 리드가 다음 수를 둘 수 있다. `subagent_timeout_sec`
    docstring 이 "부모 잔여 예산은 ToolContext 에 노출 안 돼 있다" 고 적어 둔
    그 구멍을 `ctx.idle_budget_sec` 이 메운다.
    """
    raw = (os.environ.get(SILENCE_SEC_ENV) or "").strip()
    if raw:
        try:
            v = float(raw)
            if v >= 0:
                return v
        except ValueError:
            pass
    budget = float(getattr(ctx, "idle_budget_sec", 0.0) or 0.0)
    if budget <= 0:
        # 부모가 idle 을 안 재면 우리도 재지 않는다 — backstop 이 마지막 방어선.
        return 0.0
    return min(
        max(_SILENCE_FLOOR_SEC, budget * _SILENCE_RATIO),
        budget * _SILENCE_CEIL_RATIO,
    )


async def _watch_subagent(
    sub_evidence: Path,
    ctx: ToolContext,
    *,
    label: str,
    on_silence: Any,
) -> None:
    """자식이 쓰는 동안 부모 타이머를 살려 두고, 조용해지면 포기를 알린다."""
    interval = _progress_interval_sec()
    silence_limit = _silence_limit_sec(ctx)
    last = await asyncio.to_thread(_liveness_fingerprint, sub_evidence)
    last_change = time.monotonic()
    while True:
        await asyncio.sleep(interval)
        try:
            fp = await asyncio.to_thread(_liveness_fingerprint, sub_evidence)
        except Exception:  # noqa: BLE001 — 관측 실패로 위임을 죽이지 않는다
            continue
        if fp != last:
            last = fp
            last_change = time.monotonic()
            ctx.report_progress("subagent_progress")
            continue
        quiet = time.monotonic() - last_change
        if silence_limit > 0 and quiet >= silence_limit:
            log.warning(
                "%s 무진척 %.0fs (한도 %.0fs) — 위임을 포기한다", label, quiet,
                silence_limit,
            )
            on_silence(quiet)
            return


AGENT_DEPTH_ENV = "SA_AGENT_DEPTH"
AGENT_MAX_DEPTH_ENV = "SA_AGENT_MAX_DEPTH"
_AGENT_MAX_DEPTH_DEFAULT = 2


def _agent_depth() -> int:
    """이 프로세스의 spawn 깊이 — operator/web=0, 워커는 부모가 +1 주입."""
    raw = (os.environ.get(AGENT_DEPTH_ENV) or "").strip()
    try:
        return max(0, int(raw))
    except ValueError:
        return 0


def _agent_max_depth() -> int:
    raw = (os.environ.get(AGENT_MAX_DEPTH_ENV) or "").strip()
    try:
        v = int(raw)
    except ValueError:
        return _AGENT_MAX_DEPTH_DEFAULT
    return max(0, v)


def _worker_argv(sub_evidence: Path) -> list[str]:
    """워커 subprocess 명령 — monkeypatch 가능하게 module-level."""
    return [sys.executable, "-m", "secu_agent.agent", str(sub_evidence)]


def _src_dir() -> Path:
    """부모가 실제 import 한 secu_agent 의 src 루트 — 워커가 (editable
    install 이 다른 체크아웃을 가리켜도) 부모와 같은 코드를 돌게 한다."""
    return Path(secu_agent.__file__).resolve().parents[1]


def _worker_env(depth: int) -> dict[str, str]:
    src = str(_src_dir())
    existing = os.environ.get("PYTHONPATH", "")
    pythonpath = src if not existing else src + os.pathsep + existing
    return {
        AGENT_DEPTH_ENV: str(depth + 1),
        "PYTHONPATH": pythonpath,
    }


class AgentInput(BaseModel):
    action: Literal["run", "list"] = Field(
        "run",
        description="list: 사용 가능한 sub-agent 확인, run: sub-agent 실행",
    )
    subagent_type: str | None = Field(
        None,
        max_length=64,
        description="action='run' 시 agents/<name>.md 의 name",
    )
    input: dict[str, Any] = Field(default_factory=dict,
                                  description="sub-agent target spec — input_keys 와 매칭")


def _resolve_agents_dir(ctx: ToolContext) -> Path | None:
    explicit = ctx.metadata.get("agents_dir") if ctx.metadata else None
    if isinstance(explicit, (str, Path)):
        return Path(explicit)
    return None


def _active_agents(agents_dir: Path | None) -> list[AgentDef]:
    agents = load_agents(agents_dir=agents_dir)
    return [a for a in agents if "[DEPRECATED" not in a.description]


def _format_available_agents(agents_dir: Path | None) -> str:
    agents = _active_agents(agents_dir)
    if not agents:
        return (
            f"available sub-agents: (none) "
            f"(agents_dir={agents_dir or 'default'})"
        )
    lines = [
        f"available sub-agents (총 {len(agents)}, agents_dir={agents_dir or 'default'}):"
    ]
    for agent in agents:
        keys = ", ".join(agent.input_keys) if agent.input_keys else "(none)"
        when = f" — when: {agent.when_to_use}" if agent.when_to_use else ""
        lines.append(
            f"  - {agent.name}: {agent.description}{when}; "
            f"input_keys: {keys}"
        )
    return "\n".join(lines)


class AgentTool(Tool[AgentInput]):
    name: ClassVar[str] = "agent"
    description: ClassVar[str] = (
        "Generic sub-agent spawn/list — agents/<subagent_type>.md 에 정의된 agent 호출.\n"
        "- action='list': 현재 사용 가능한 non-deprecated sub-agent 목록 확인\n"
        "- action='run': subagent_type + input 으로 sub-agent 실행\n"
        "- subagent_type: agents/ 디렉토리에서 로드 (skill_view 처럼 markdown 외부화)\n"
        "- input: sub-agent target spec (input_keys 와 매칭)\n"
        "새 sub-agent 가 등록되면 여기로 호출."
    )
    input_model: ClassVar[type[BaseModel]] = AgentInput
    is_read_only: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "sub-agent 호출", "agent spawn",
    )
    prompt_section: ClassVar[str] = (
        "### agent(action, subagent_type, input)\n"
        "Generic sub-agent 호출 — context isolation 이 진짜 필요할 때만. "
        "`agent(action='list')` 로 현재 사용 가능한 non-deprecated agent 이름을 확인한 뒤, "
        "목록에 있는 `agents/<name>.md` 정의만 호출. 없는 이름을 추측 호출하지 마라. "
        "사용 시점: operator 가 직접 처리하면 context 가 폭주할 만큼 긴 단순 반복 작업. "
        "짧은 작업 / 운영자 의도 파악 / complex routing 은 operator 가 직접."
    )

    async def execute(self, vi: AgentInput, ctx: ToolContext) -> ToolResult:
        agents_dir = _resolve_agents_dir(ctx)
        if vi.action == "list":
            return ToolSuccess(content=_format_available_agents(agents_dir))

        # v3.81 T1b: 재귀 깊이 제한 — 무한 self-spawn 차단 (fail-closed).
        depth = _agent_depth()
        max_depth = _agent_max_depth()
        if depth >= max_depth:
            return ToolError(
                kind="permission",
                message=(
                    f"sub-agent 재귀 깊이 한도 도달 (depth={depth} >= "
                    f"max={max_depth}, {AGENT_MAX_DEPTH_ENV}) — 추가 spawn 금지. "
                    f"이 작업은 직접 처리하라."
                ),
            )

        if not vi.subagent_type:
            return ToolError(
                kind="validation",
                message=(
                    "action='run' 은 subagent_type 필수. "
                    "사용 가능한 이름은 agent(action='list') 로 확인."
                ),
            )

        agent: AgentDef | None = get_agent(vi.subagent_type, agents_dir=agents_dir)
        if agent is None or "[DEPRECATED" in agent.description:
            return ToolError(
                kind="not_found",
                message=(
                    f"sub-agent '{vi.subagent_type}' not found or unavailable. "
                    f"Use only names from agent(action='list'); do not invent agent names.\n"
                    f"{_format_available_agents(agents_dir)}"
                ),
            )

        # input_keys 검증 (있는 거만 확인 — 추가 key 는 무시 안 함, 통과)
        missing = [k for k in agent.input_keys if k not in vi.input]
        if missing:
            return ToolError(
                kind="validation",
                message=(
                    f"agent '{agent.name}' 호출에 필수 input 키 누락: {missing}. "
                    f"기대: {list(agent.input_keys)}"
                ),
            )

        suffix = "-".join(
            str(v) for v in vi.input.values() if isinstance(v, (str, int))
        )[:60].replace("/", "_")
        # v3.80 Slice0a: ts+nonce dir — 같은 초 spawn 충돌(증거 혼입) 제거.
        sub_evidence = make_sub_evidence_dir(
            ctx.evidence_dir, f"{agent.name}-{suffix or 'spawn'}",
        )
        # task_id 도 같은 초 spawn 이면 중복이었음 — dir 의 ts-nonce 를 그대로 공유.
        ts_nonce = "-".join(sub_evidence.name.split("-")[1:3])

        spec = {
            "task_id": f"{agent.name}-{ts_nonce}",
            "task_type": agent.task_type,
            # v3.80 Slice0c: 부모 charter 상속 — env 기본값은 감사추적을 끊는다.
            "charter_ref": inherit_charter_ref(ctx),
            "target": dict(vi.input),
        }
        (sub_evidence / "task_spec.json").write_text(
            _json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8",
        )

        # v3.81 T1b: WorkerPool(k=1) subprocess — 취소/backstop 시 실제 kill.
        # 부모 turn 취소(CancelledError)는 aclosing → emergency shutdown 으로
        # 워커까지 전파된다 (thread 백엔드의 '좀비 워커' 제거).
        argv = list(_worker_argv(sub_evidence))
        if agent.profile:
            # v3.81 T1c: sub-agent 별 모델 라우팅 — frontmatter `profile:` 이
            # 워커 기본 선택(SA_CHAT_PROFILE > YAML 첫 프로파일)보다 우선.
            argv += ["--profile-name", agent.profile]
        worker_spec = WorkerSpec(
            label=f"agent:{agent.name}",
            argv=tuple(argv),
            evidence_dir=sub_evidence,
            env=_worker_env(depth),
            cwd=_src_dir().parent,  # 프로젝트 루트 — cli 기본 --profile 상대경로
        )
        pool = WorkerPool(1, pid_registry=sub_evidence / "worker_pids.json")
        spec_iter = iter([worker_spec])
        completion: WorkerCompletion | None = None
        # #32: 자식이 쓰는 동안 부모 idle 타이머를 살려 둔다. 포기는 `pool.cancel()`
        # 하나로 끝난다 — 완료는 그래도 yield 되므로 아래 `async for` 는 그대로 두고,
        # 부모 turn 취소 전파 경로(aclosing → 비상종료)도 건드리지 않는다.
        silence_sec: float | None = None

        def _on_silence(sec: float) -> None:
            nonlocal silence_sec
            silence_sec = sec
            pool.cancel()

        watch = asyncio.create_task(_watch_subagent(
            sub_evidence, ctx, label=f"agent:{agent.name}", on_silence=_on_silence,
        ))
        try:
            async with contextlib.aclosing(
                pool.run(lambda: next(spec_iter, None))
            ) as gen:
                async for c in gen:
                    completion = c
        except Exception as e:
            return ToolError(
                kind="execution",
                message=f"agent '{agent.name}' worker pool 오류: {e!r}",
            )
        finally:
            watch.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watch
        if silence_sec is not None:
            # 런을 죽이는 대신 **위임만** 실패시킨다 — 리드는 이걸 받고 다음 수를 둔다.
            return ToolError(
                kind="timeout",
                message=(
                    f"agent '{agent.name}' 무진척 중단 — 자식이 {silence_sec:.0f}초 동안 "
                    f"증거 디렉터리에 아무것도 쓰지 않았다 (부모 idle 예산 "
                    f"{float(getattr(ctx, 'idle_budget_sec', 0.0)):.0f}s 보다 먼저 포기). "
                    f"워커는 SIGTERM→SIGKILL 로 종료됨. evidence={sub_evidence}"
                ),
            )
        if completion is None:
            return ToolError(
                kind="execution",
                message=f"agent '{agent.name}' 완료 보고 없음 (pool 오류) — "
                        f"evidence={sub_evidence}",
            )

        if completion.outcome == "backstop_timeout":
            return ToolError(
                kind="timeout",
                message=(
                    f"agent '{agent.name}' 부모측 backstop timeout "
                    f"({subagent_timeout_sec():.0f}s) — 워커 프로세스는 "
                    f"SIGTERM→SIGKILL 로 종료됨 (pid={completion.pid}). "
                    f"evidence={sub_evidence}"
                ),
            )
        if completion.outcome in ("spawn_failed", "pool_error", "cancelled"):
            detail = (
                completion.result.detail
                if isinstance(completion.result, WorkerResultInvalid) else ""
            )
            return ToolError(
                kind="execution",
                message=(
                    f"agent '{agent.name}' {completion.outcome}: {detail} — "
                    f"evidence={sub_evidence}"
                ),
            )

        # outcome == "exited" — worker_result.json 이 유일 판정 채널 (fail-closed)
        wr = completion.result
        if isinstance(wr, WorkerResultInvalid):
            return ToolError(
                kind="execution",
                message=(
                    f"agent '{agent.name}' 결과 누락/위반 (fail-closed, "
                    f"{wr.reason}): {wr.detail} — rc={completion.rc}, "
                    f"evidence={sub_evidence}"
                ),
            )
        assert isinstance(wr, WorkerResult)
        stats = (
            f"turns={wr.turns_used}, tokens={wr.tokens_in}/{wr.tokens_out}, "
            f"{completion.duration_sec:.1f}s"
        )
        if wr.status != "ok":
            return ToolError(
                kind="execution",
                message=(
                    f"agent '{agent.name}' 실패 (status={wr.status}, "
                    f"rc={completion.rc}): {wr.summary} — {stats}, "
                    f"evidence={sub_evidence}"
                ),
            )

        # 성공 — agent_result.json (fail-open 보조 채널) 있으면 본문 동봉
        result_path = sub_evidence / "agent_result.json"
        if result_path.exists():
            try:
                payload = _json.loads(result_path.read_text(encoding="utf-8"))
            except Exception:
                payload = None
            if isinstance(payload, dict):
                summary = payload.get("summary") or ""
                if summary:
                    return ToolSuccess(content=(
                        f"[{agent.name} result] ({stats})\n"
                        f"summary: {summary}\n"
                        f"raw: {_json.dumps(payload, ensure_ascii=False)[:1500]}"
                    ))
                return ToolSuccess(content=_json.dumps(payload, ensure_ascii=False))

        return ToolSuccess(content=(
            f"agent '{agent.name}' 완료 ({wr.summary}; {stats}; "
            f"evidence={sub_evidence}). agent_result.json 미생성 — "
            f"결과 확인은 DB 쿼리 필요."
        ))
