"""Background process lifecycle tool.

Hermes separates `terminal` from `process`: terminal starts commands, process
polls/waits/closes long-running work. This module adds the same split for the
web operator harness without durable restart recovery yet.

v3.43-P4: bg watcher 가 proc.wait() 종료 시 chat_message system role 영속 +
evidence_dir/processes/<id>.completion.json drop. ChatSession 의 다음 turn 이
컨텍스트 brief 로 흡수 (F3) + WS 가 frontend 로 push.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar, Literal

from pydantic import BaseModel, Field

from secu_agent import state
from secu_agent.agent.tools.base import (
    PermissionDecision,
    Tool,
    ToolContext,
    ToolError,
    ToolResult,
    ToolSuccess,
)
from secu_agent.agent.tools.terminal_tool import _hard_block_reason, _resolve_cwd


ProcessAction = Literal["start", "list", "poll", "wait", "tail", "close"]


@dataclass(slots=True)
class ProcessRecord:
    process_id: str
    command: str
    cwd: Path
    output_path: Path
    proc: subprocess.Popen
    output_handle: object
    started_at: float
    closed_at: float | None = None
    # v3.43-P4: bg watcher + 영속 metadata
    watcher_task: asyncio.Task | None = None
    session_id: int | None = None
    completion_emitted: bool = False


_PROCESS_REGISTRY: dict[str, ProcessRecord] = {}
_PROCESS_LOCK = asyncio.Lock()

_PROCESS_REGISTRY_MAX_DEFAULT = 64


def _registry_max() -> int:
    """레지스트리 상한 — SA_PROCESS_REGISTRY_MAX 로 조정(안전 기본 64, 최소 1).

    무제한 증가 방지: 종료된 프로세스 레코드가 계속 쌓이지 않도록 상한을 둔다.
    """
    raw = os.environ.get("SA_PROCESS_REGISTRY_MAX")
    if raw is None:
        return _PROCESS_REGISTRY_MAX_DEFAULT
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return _PROCESS_REGISTRY_MAX_DEFAULT
    return value if value >= 1 else 1


def _evict_terminated_locked() -> int:
    """종료된(exited) 프로세스 레코드만 제거. 실행 중인 것은 절대 건드리지 않는다.

    호출부는 반드시 _PROCESS_LOCK 을 잡은 상태여야 한다. 제거 개수를 반환.
    """
    dead = [pid for pid, r in _PROCESS_REGISTRY.items() if r.proc.poll() is not None]
    for pid in dead:
        _PROCESS_REGISTRY.pop(pid, None)
    return len(dead)


class ProcessInput(BaseModel):
    action: ProcessAction
    process_id: str | None = Field(default=None)
    command: str | None = Field(default=None, max_length=20_000)
    cwd: str | None = None
    timeout_seconds: float = Field(default=30.0, ge=0.05, le=600.0)
    tail_bytes: int = Field(default=16 * 1024, ge=0, le=256 * 1024)
    kill: bool = Field(default=False, description="action=close 에서 즉시 kill 사용.")


def _require_process_id(payload: ProcessInput) -> str | ToolError:
    if not payload.process_id:
        return ToolError(kind="validation", message="process_id 필요")
    return payload.process_id


def _tail_file(path: Path, limit: int) -> str:
    if limit <= 0 or not path.exists():
        return ""
    size = path.stat().st_size
    with path.open("rb") as f:
        if size > limit:
            f.seek(size - limit)
        raw = f.read(limit)
    text = raw.decode("utf-8", errors="replace")
    if size > limit:
        text = f"... (last {limit} bytes)\n" + text
    return text


def _status(record: ProcessRecord) -> tuple[str, int | None]:
    rc = record.proc.poll()
    if rc is not None:
        return "exited", rc
    return "running", None


def _flush_output(record: ProcessRecord) -> None:
    handle = record.output_handle
    try:
        flush = getattr(handle, "flush", None)
        if callable(flush):
            flush()
    except Exception:
        pass


def _close_output(record: ProcessRecord) -> None:
    handle = record.output_handle
    try:
        close = getattr(handle, "close", None)
        if callable(close) and not getattr(handle, "closed", False):
            close()
    except Exception:
        pass


_COMPLETION_TAIL_BYTES = 4 * 1024
_BG_COMPLETION_SUBSCRIBERS: list[callable] = []


def subscribe_bg_completion(callback) -> None:
    """v3.43-P4: bg watcher 완료 시 호출될 콜백 등록.

    callback signature: (record: ProcessRecord, payload: dict) -> None
    WS handler / chat session 이 process 완료 push 받을 때 사용.
    """
    _BG_COMPLETION_SUBSCRIBERS.append(callback)


def unsubscribe_bg_completion(callback) -> None:
    try:
        _BG_COMPLETION_SUBSCRIBERS.remove(callback)
    except ValueError:
        pass


async def _watch_to_completion(record: ProcessRecord) -> None:
    """proc.wait() 를 background 에서 기다리고, 끝나면 completion 영속/broadcast.

    v3.79-perf: 100ms 고정 busy-poll(10Hz spin) 도, blocking proc.wait() 를 프로세스
    수명 내내 공유 to_thread executor 에 1스레드/프로세스로 park 하는 것도 피한다 —
    후자는 registry cap(기본 64) > executor(~min(32,cpu+4))에서 전역 executor 를
    고갈시켜 다른 to_thread 호출까지 굶긴다. 대신 backoff poll(50ms→1s): 장기
    프로세스는 초당 ~1회만 poll(스레드 0개), 단기 프로세스는 50ms 안에 감지하고,
    watcher_task 취소는 즉시 반영된다. 출력은 stdout=output_handle 로 파일에 직접
    쓰이므로 draining 루프가 필요 없다(폴링이 draining 을 구동하지 않음).
    """
    delay = 0.05
    try:
        while record.proc.poll() is None:
            await asyncio.sleep(delay)
            delay = min(delay * 1.5, 1.0)
    except asyncio.CancelledError:
        return
    except Exception:
        return
    _flush_output(record)
    _close_output(record)
    duration = time.time() - record.started_at
    tail = _tail_file(record.output_path, _COMPLETION_TAIL_BYTES)
    payload = {
        "event": "bg_task_completed",
        "process_id": record.process_id,
        "command": record.command,
        "exit_code": record.proc.returncode,
        "output_path": str(record.output_path),
        "output_tail": tail,
        "duration_sec": round(duration, 2),
        "completed_at": time.time(),
    }
    # 1) evidence_dir 에 completion.json drop
    try:
        comp_path = record.output_path.with_suffix(".completion.json")
        comp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    except OSError:
        pass
    # 2) session_id 있으면 chat_message system role 영속 (audit + brief 소스)
    if record.session_id is not None:
        try:
            state.chat_message_add(
                record.session_id, role="system", content=payload,
            )
        except Exception:
            pass
    # 3) subscribers (WS 등) 에 broadcast
    record.completion_emitted = True
    for cb in list(_BG_COMPLETION_SUBSCRIBERS):
        try:
            cb(record, payload)
        except Exception:
            continue


def _format_record(record: ProcessRecord, *, tail_bytes: int = 0) -> str:
    status, exit_code = _status(record)
    age = time.time() - record.started_at
    size = record.output_path.stat().st_size if record.output_path.exists() else 0
    lines = [
        f"process_id={record.process_id} status={status} exit_code={exit_code}",
        f"cwd={record.cwd}",
        f"age_sec={age:.2f} output_path={record.output_path} output_bytes={size}",
        f"command={record.command}",
    ]
    if tail_bytes > 0:
        lines += ["--- tail ---", _tail_file(record.output_path, tail_bytes)]
    return "\n".join(lines)


class ProcessTool(Tool[ProcessInput]):
    name: ClassVar[str] = "process"
    description: ClassVar[str] = (
        "Background process lifecycle. action=start runs a long command in the "
        "background and writes output to evidence_dir/processes/<id>.log. "
        "Use list/poll/wait/tail/close to manage it. This is the Hermes process "
        "equivalent for servers, watchers, long tests, crawls, and batch jobs."
    )
    input_model: ClassVar[type[BaseModel]] = ProcessInput
    is_read_only: ClassVar[bool] = False
    is_destructive: ClassVar[bool] = False
    deferred: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    search_hint: ClassVar[str] = "process background poll wait tail close server watcher long running"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "background", "process", "server", "watch", "long running", "poll", "tail",
    )
    prompt_section: ClassVar[str] = (
        "### process(action, ...)\n"
        "Hermes process 역할. `action='start'` 로 장기 명령을 background 실행하고 "
        "`process_id`를 받는다. 이후 `poll`, `wait`, `tail`, `close`, `list` 로 관리. "
        "output 은 evidence_dir/processes/*.log 에 저장. 짧은 명령은 terminal, 서버/"
        "watcher/긴 테스트는 process 사용."
    )

    async def check_permission(
        self, validated_input: ProcessInput, context: ToolContext,
    ) -> PermissionDecision:
        if validated_input.action in {"start", "close"}:
            if context.metadata.get("schedule_origin"):
                return PermissionDecision(
                    behavior="deny",
                    reason=f"scheduled execution cannot {validated_input.action} processes",
                )
            return PermissionDecision(
                behavior="ask",
                reason=f"process {validated_input.action} changes host process state",
            )
        return PermissionDecision(behavior="allow")

    async def execute(self, vi: ProcessInput, ctx: ToolContext) -> ToolResult:
        if vi.action == "start":
            return await self._start(vi, ctx)
        if vi.action == "list":
            return await self._list(vi)
        pid = _require_process_id(vi)
        if isinstance(pid, ToolError):
            return pid
        async with _PROCESS_LOCK:
            record = _PROCESS_REGISTRY.get(pid)
        if record is None:
            return ToolError(kind="not_found", message=f"unknown process_id: {pid}")
        if vi.action == "poll":
            return ToolSuccess(content=_format_record(record, tail_bytes=vi.tail_bytes))
        if vi.action == "wait":
            return await self._wait(record, vi)
        if vi.action == "tail":
            return ToolSuccess(content=_format_record(record, tail_bytes=vi.tail_bytes))
        if vi.action == "close":
            return await self._close(record, vi)
        return ToolError(kind="validation", message=f"unknown action: {vi.action}")

    async def _start(self, vi: ProcessInput, ctx: ToolContext) -> ToolResult:
        cmd = (vi.command or "").strip()
        if not cmd:
            return ToolError(kind="validation", message="action=start 는 command 필수")
        blocked = _hard_block_reason(cmd)
        if blocked is not None:
            return ToolError(kind="forbidden", message=f"blocked process command: {blocked}")
        cwd = _resolve_cwd(vi.cwd)
        if isinstance(cwd, ToolError):
            return cwd

        proc_id = f"proc_{secrets.token_hex(6)}"
        output_dir = ctx.evidence_dir / "processes"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{proc_id}.log"
        kwargs: dict[str, object] = {}
        bash = Path("/bin/bash")
        if bash.exists():
            kwargs["executable"] = str(bash)
        try:
            output_handle = output_path.open("ab")
            proc = subprocess.Popen(
                cmd,
                cwd=str(cwd),
                stdin=subprocess.PIPE,
                stdout=output_handle,
                stderr=subprocess.STDOUT,
                shell=True,
                text=False,
                **kwargs,
            )
        except OSError as e:
            return ToolError(kind="io_error", message=f"subprocess launch failed: {e}")

        # stdin PIPE 는 사용하지 않으므로 즉시 release/close — child 가 EOF 를 받고
        # fd 가 새지 않도록 한다.
        if proc.stdin is not None:
            try:
                proc.stdin.close()
            except Exception:
                pass

        sid = ctx.metadata.get("session_id") if ctx.metadata else None
        record = ProcessRecord(
            process_id=proc_id,
            command=cmd,
            cwd=cwd,
            output_path=output_path,
            proc=proc,
            output_handle=output_handle,
            started_at=time.time(),
            session_id=sid if isinstance(sid, int) else None,
        )
        # 레지스트리 상한 적용: cap 도달 시 종료된 레코드부터 evict, 그래도 자리가
        # 없으면(전부 실행 중) live process 를 조용히 버리지 않고 이번 spawn 을 거부한다.
        cap = _registry_max()
        async with _PROCESS_LOCK:
            if len(_PROCESS_REGISTRY) >= cap:
                _evict_terminated_locked()
            if len(_PROCESS_REGISTRY) >= cap:
                registered = False
            else:
                _PROCESS_REGISTRY[proc_id] = record
                registered = True
        if not registered:
            # 방금 띄운 프로세스는 추적하지 않을 것이므로 leak 방지를 위해 정리한다.
            try:
                proc.kill()
            except Exception:
                pass
            try:
                await asyncio.to_thread(proc.wait, timeout=5.0)
            except Exception:
                pass
            _close_output(record)
            return ToolError(
                kind="resource_exhausted",
                message=(
                    f"process registry full ({cap}); all tracked processes still "
                    "running. close one (action=close) before starting another, "
                    "or raise SA_PROCESS_REGISTRY_MAX."
                ),
            )
        # v3.43-P4: bg watcher — proc 종료되면 completion 영속 + chat_message inject
        try:
            loop = asyncio.get_running_loop()
            record.watcher_task = loop.create_task(_watch_to_completion(record))
        except RuntimeError:
            # 테스트 환경에서 loop 없으면 watcher 생략 — record 만 만든다
            pass
        return ToolSuccess(content=_format_record(record))

    async def _list(self, vi: ProcessInput) -> ToolResult:
        async with _PROCESS_LOCK:
            records = list(_PROCESS_REGISTRY.values())
        if not records:
            return ToolSuccess(content="0 process")
        lines = [f"{len(records)} process:"]
        for record in sorted(records, key=lambda r: r.started_at, reverse=True):
            lines.append(_format_record(record, tail_bytes=0))
        return ToolSuccess(content="\n\n".join(lines))

    async def _wait(self, record: ProcessRecord, vi: ProcessInput) -> ToolResult:
        try:
            await asyncio.to_thread(record.proc.wait, timeout=vi.timeout_seconds)
        except subprocess.TimeoutExpired:
            return ToolError(kind="timeout", message=f"process still running after {vi.timeout_seconds}s")
        _flush_output(record)
        _close_output(record)
        return ToolSuccess(content=_format_record(record, tail_bytes=vi.tail_bytes))

    async def _close(self, record: ProcessRecord, vi: ProcessInput) -> ToolResult:
        status, _ = _status(record)
        action = "already_exited"
        if status == "running":
            if vi.kill:
                record.proc.kill()
                action = "killed"
            else:
                record.proc.terminate()
                action = "terminated"
            try:
                await asyncio.to_thread(record.proc.wait, timeout=min(vi.timeout_seconds, 10.0))
            except subprocess.TimeoutExpired:
                record.proc.kill()
                await asyncio.to_thread(record.proc.wait)
                action = "killed"
        record.closed_at = time.time()
        _flush_output(record)
        _close_output(record)
        return ToolSuccess(content=f"{action}\n" + _format_record(record, tail_bytes=vi.tail_bytes))


__all__ = ["ProcessTool", "ProcessInput"]
