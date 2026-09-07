"""General foreground terminal tool.

Claude Code exposes Bash and Hermes exposes terminal/process. This tool covers
the P0 foreground shell use case for an operator-owned enterprise security
agent: builds, installs, git, filesystem commands, package managers, and
ad-hoc Linux inspection.

Background process management is intentionally separate follow-up work.
"""
from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path
from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool,
    ToolContext,
    ToolError,
    ToolResult,
    ToolSuccess,
)


_MAX_OUTPUT_BYTES = 128 * 1024
_MAX_COMMAND_CHARS = 20_000
# 스트리밍 read 단위. output_limit_bytes 는 per-call 필드라 여기서 새 hard cap 을
# 만들지 않는다 — 이건 내부 chunk 크기(메모리 상한 = limit + 이 값)일 뿐.
_READ_CHUNK_BYTES = 64 * 1024

_HARD_BLOCKS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\brm\s+-[^\n;&|]*[rf][^\n;&|]*\s+/(?:\s|$)", re.I),
     "recursive delete of filesystem root"),
    (re.compile(r"\brm\s+-[^\n;&|]*[rf][^\n;&|]*\s+~(?:\s|/|$)", re.I),
     "recursive delete of home directory"),
    (re.compile(r"\bsudo\b", re.I), "sudo is not available through agent terminal"),
    (re.compile(r"\b(?:mkfs|fdisk|parted|shutdown|reboot|halt)\b", re.I),
     "host destructive system command"),
    (re.compile(r"\bdd\s+if=.*\bof=/dev/", re.I), "raw device write"),
    (re.compile(r"\bchmod\s+-R\s+777\s+/(?:\s|$)", re.I),
     "recursive world-writable permission change on root"),
    (re.compile(r"\b(?:curl|wget)\b[^\n;&|]*\|\s*(?:sh|bash)\b", re.I),
     "remote script piped into shell"),
    (re.compile(r":\s*\(\)\s*\{\s*:\s*\|\s*:", re.I), "fork bomb pattern"),
)


class TerminalInput(BaseModel):
    command: str = Field(
        min_length=1,
        max_length=_MAX_COMMAND_CHARS,
        description="Shell command to run in foreground.",
    )
    cwd: str | None = Field(
        default=None,
        description=(
            "Working directory. Absolute or relative to the server process cwd. "
            "Default: current process cwd."
        ),
    )
    timeout_seconds: float = Field(
        default=30.0,
        ge=0.05,
        le=600.0,
        description="Foreground timeout in seconds. Use short commands; background is not supported yet.",
    )
    output_limit_bytes: int = Field(
        default=_MAX_OUTPUT_BYTES,
        ge=1024,
        le=512 * 1024,
        description="Maximum combined stdout/stderr bytes returned to the model.",
    )


def _resolve_cwd(raw: str | None) -> Path | ToolError:
    if raw is None or not raw.strip():
        return Path.cwd().resolve()
    if "\x00" in raw:
        return ToolError(kind="validation", message="cwd contains null byte")
    p = Path(raw).expanduser()
    if not p.is_absolute():
        p = Path.cwd() / p
    try:
        resolved = p.resolve()
    except OSError as e:
        return ToolError(kind="io_error", message=f"cwd resolve failed: {e}")
    if not resolved.exists():
        return ToolError(kind="not_found", message=f"cwd does not exist: {resolved}")
    if not resolved.is_dir():
        return ToolError(kind="not_file", message=f"cwd is not a directory: {resolved}")
    return resolved


def _hard_block_reason(command: str) -> str | None:
    if "\x00" in command:
        return "command contains null byte"
    for pattern, reason in _HARD_BLOCKS:
        if pattern.search(command):
            return f"{reason} ({pattern.pattern})"
    return None


class TerminalTool(Tool[TerminalInput]):
    name: ClassVar[str] = "terminal"
    description: ClassVar[str] = (
        "General host terminal command execution, foreground only. Use for Linux "
        "shell work such as builds, tests, git, package managers, file copy/move, "
        "archive creation, and ad-hoc inspection. Returns exit code, cwd, duration, "
        "and capped combined stdout/stderr. Hard-blocks obvious host-destructive "
        "commands (sudo, rm -rf /, raw disk writes, reboot, remote script pipe)."
    )
    input_model: ClassVar[type[BaseModel]] = TerminalInput
    is_read_only: ClassVar[bool] = False
    is_destructive: ClassVar[bool] = True
    deferred: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    search_hint: ClassVar[str] = "terminal bash shell command build test git cp mv tar linux"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "terminal", "bash", "shell", "command", "명령", "git", "pytest", "cp", "mv", "tar",
    )
    prompt_section: ClassVar[str] = (
        "### terminal(command, cwd=None, timeout_seconds=30)\n"
        "일반 host shell 실행. Claude Bash / Hermes terminal 역할. build/test/git/"
        "package manager/파일 복사·이동/tar 같은 일반 Linux 작업에 사용. foreground only "
        "(장기 서버/워처는 아직 process 도구가 없으니 실행하지 말고 보고). 결과에는 "
        "exit/cwd/duration/output 이 포함된다. rm -rf /, sudo, reboot, curl|sh 같은 "
        "명백한 위험 명령은 도구 내부에서 차단. schedule wakeup 에서는 destructive tool "
        "차단 정책 때문에 실행 불가."
    )

    async def execute(self, vi: TerminalInput, ctx: ToolContext) -> ToolResult:
        cmd = vi.command.strip()
        if not cmd:
            return ToolError(kind="validation", message="command 비어있음")
        blocked = _hard_block_reason(cmd)
        if blocked is not None:
            return ToolError(kind="forbidden", message=f"blocked terminal command: {blocked}")

        cwd = _resolve_cwd(vi.cwd)
        if isinstance(cwd, ToolError):
            return cwd

        kwargs: dict[str, object] = {}
        bash = Path("/bin/bash")
        if bash.exists():
            kwargs["executable"] = str(bash)

        start = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                cwd=str(cwd),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                **kwargs,
            )
        except OSError as e:
            return ToolError(kind="io_error", message=f"subprocess launch failed: {e}")

        # 스트리밍 read: proc.communicate() 는 자식 출력 전체를 메모리에 올린 뒤에야
        # len()>limit 절단이 걸려, 기가바이트를 뿜는 명령이 output_limit_bytes 만
        # 반환하면서도 agent 를 OOM 시킨다. 여기서는 읽으면서 byte 예산을 강제 —
        # 예산 초과 즉시 read 중단 + 프로세스 kill. 메모리 상한 = limit + chunk.
        limit = vi.output_limit_bytes
        deadline = start + vi.timeout_seconds
        stream = proc.stdout
        chunks: list[bytes] = []
        total = 0
        truncated = False

        async def _reap() -> None:
            # kill 후 좀비 방지용 drain. SIGKILL 은 무시 불가라 hang 없음.
            proc.kill()
            try:
                await proc.wait()
            except Exception:
                pass

        try:
            if stream is None:  # PIPE 라 정상적으론 None 아님 — 방어.
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise asyncio.TimeoutError
                await asyncio.wait_for(proc.wait(), timeout=remaining)
            else:
                while True:
                    if ctx.aborted:
                        await _reap()
                        return ToolError(kind="cancelled", message="terminal aborted by signal")
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise asyncio.TimeoutError
                    chunk = await asyncio.wait_for(
                        stream.read(_READ_CHUNK_BYTES), timeout=remaining,
                    )
                    if not chunk:
                        break  # EOF
                    chunks.append(chunk)
                    total += len(chunk)
                    if total > limit:
                        # 예산 초과 — 더 읽지 않고 프로세스를 죽여 gigabyte 유출 차단.
                        truncated = True
                        await _reap()
                        break
                if not truncated:
                    # EOF 도달 — returncode 확정.
                    remaining = deadline - time.monotonic()
                    try:
                        if remaining > 0:
                            await asyncio.wait_for(proc.wait(), timeout=remaining)
                        else:
                            raise asyncio.TimeoutError
                    except asyncio.TimeoutError:
                        await _reap()
                        return ToolError(
                            kind="timeout", message=f"timed out after {vi.timeout_seconds}s",
                        )
        except asyncio.TimeoutError:
            await _reap()
            return ToolError(kind="timeout", message=f"timed out after {vi.timeout_seconds}s")

        duration = time.monotonic() - start
        raw = b"".join(chunks)
        if len(raw) > limit:
            raw = raw[:limit]
        out = raw.decode("utf-8", errors="replace")
        if truncated:
            out += f"\n... (truncated at {vi.output_limit_bytes} bytes)"
        header = (
            f"exit={proc.returncode} duration={duration:.2f}s cwd={cwd}"
            + (" truncated" if truncated else "")
        )
        return ToolSuccess(content=f"{header}\n---\n{out}")


__all__ = ["TerminalTool", "TerminalInput"]
