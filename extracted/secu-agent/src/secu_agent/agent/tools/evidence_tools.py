"""v3.15: evidence_dir 한정 정적 분석 도구 — Read / Grep / Bash.

이미 sandbox 거쳐 evidence_dir 에 떨어진 산물 (strace log, 의심파일 사본,
스크린샷 등) 을 agent 가 직접 분석. 진짜 sandbox 와는 무관 — read-only 정적 분석.

가드:
- 모든 경로 safe_path() → evidence_dir 밖 접근 거부.
- Bash 는 is_destructive=True + 위험 패턴 사전 차단.
- 사이즈 / timeout cap.
"""
from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path
from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.harness.path import PathEscapeError, safe_path
from secu_agent.agent.tools.base import (
    Tool,
    ToolContext,
    ToolError,
    ToolResult,
    ToolSuccess,
)


_MAX_READ_BYTES = 2 * 1024 * 1024  # 2MB
_MAX_BASH_OUT_BYTES = 50 * 1024
# v3.48: read_evidence_file / grep_evidence output cap — stash 무한 loop 회피.
# stash 의 TOOL_RESULT_INLINE_MAX (50K) 보다 작아야 다시 stash 안 됨.
_MAX_OUTPUT_CHARS = 30_000
_DEFAULT_BASH_TIMEOUT = 30.0

# 라이브러리 / shell 형식 무관, **명령어 단어 단위로 차단**.
_BASH_DANGEROUS = (
    re.compile(r"\brm\s+-rf?\b.*\s/"),     # rm -rf /
    re.compile(r"\bsudo\b"),
    re.compile(r"\bcurl\b"),
    re.compile(r"\bwget\b"),
    re.compile(r"\bnc\b\s+-"),
    re.compile(r":\(\)\s*\{.*\|.*&.*\};"),  # fork bomb
    re.compile(r"\bdd\s+if="),               # disk dump
    re.compile(r">\s*/dev/sd[a-z]"),        # raw disk write
)


# ─── ReadEvidenceFileTool ──────────────────────────────────


class ReadEvidenceInput(BaseModel):
    path: str = Field(description="evidence_dir 기준 상대 경로.")
    offset: int = Field(default=0, ge=0, description="시작 line 번호 (0-based).")
    limit: int = Field(default=2000, ge=1, le=10000,
                       description="읽을 line 수 (기본 2000).")


class ReadEvidenceFileTool(Tool[ReadEvidenceInput]):
    name: ClassVar[str] = "read_evidence_file"
    description: ClassVar[str] = (
        "evidence_dir 안의 텍스트 파일을 읽음 (line 기준 offset/limit). 2MB cap. "
        "hidden file (.git 등) 거부. 호스트 다른 위치 접근 불가."
    )
    input_model: ClassVar[type[BaseModel]] = ReadEvidenceInput
    is_read_only: ClassVar[bool] = True
    is_destructive: ClassVar[bool] = False
    domain: ClassVar[str] = "core"

    async def execute(self, payload: ReadEvidenceInput, context: ToolContext) -> ToolResult:
        try:
            resolved = safe_path(payload.path, context.evidence_dir)
        except PathEscapeError as e:
            return ToolError(kind="path_escape", message=str(e))

        if not resolved.exists():
            return ToolError(kind="not_found", message=f"{payload.path} 미존재")
        if not resolved.is_file():
            return ToolError(kind="not_file", message=f"{payload.path} not a file")
        if resolved.stat().st_size > _MAX_READ_BYTES:
            return ToolError(
                kind="too_large",
                message=f"{payload.path}: {resolved.stat().st_size} bytes > 2MB cap",
            )

        try:
            text = resolved.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            return ToolError(kind="io_error", message=str(e))

        lines = text.splitlines()
        start = payload.offset
        end = start + payload.limit
        window = lines[start:end]
        body = "\n".join(window)
        header = f"# {payload.path} (lines {start+1}-{start+len(window)} / {len(lines)})\n"
        # v3.48: output 30K cap — stash 무한 loop 방지. 초과 시 잘라서 안내.
        result = header + body
        if len(result) > _MAX_OUTPUT_CHARS:
            result = (
                result[:_MAX_OUTPUT_CHARS]
                + f"\n\n... (truncated at {_MAX_OUTPUT_CHARS:,} chars. "
                + f"line {start+1}+ 본 결과. 더 보려면 offset 늘려서 재호출. "
                + f"총 {len(lines)} lines)"
            )
        return ToolSuccess(content=result)


# ─── GrepEvidenceTool ──────────────────────────────────────


class GrepEvidenceInput(BaseModel):
    pattern: str = Field(description="정규표현식 또는 리터럴 문자열.")
    path: str = Field(default=".", description="evidence_dir 기준 검색 시작 경로 (기본 root).")
    ignore_case: bool = Field(default=False)
    max_matches: int = Field(default=200, ge=1, le=2000)


class GrepEvidenceTool(Tool[GrepEvidenceInput]):
    name: ClassVar[str] = "grep_evidence"
    description: ClassVar[str] = (
        "evidence_dir 안에서 패턴 검색. 정규식 지원. 결과: 파일:line:내용. max_matches cap."
    )
    input_model: ClassVar[type[BaseModel]] = GrepEvidenceInput
    is_read_only: ClassVar[bool] = True
    is_destructive: ClassVar[bool] = False
    domain: ClassVar[str] = "core"

    async def execute(self, payload: GrepEvidenceInput, context: ToolContext) -> ToolResult:
        try:
            root = safe_path(payload.path, context.evidence_dir)
        except PathEscapeError as e:
            return ToolError(kind="path_escape", message=str(e))

        flags = re.IGNORECASE if payload.ignore_case else 0
        try:
            pat = re.compile(payload.pattern, flags)
        except re.error as e:
            return ToolError(kind="validation", message=f"bad regex: {e}")

        hits: list[str] = []
        scanned = 0
        if root.is_file():
            paths = [root]
        else:
            paths = [p for p in root.rglob("*") if p.is_file()]

        for fp in paths:
            scanned += 1
            try:
                rel = fp.relative_to(context.evidence_dir)
            except ValueError:
                continue
            try:
                text = fp.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for i, line in enumerate(text.splitlines(), 1):
                if pat.search(line):
                    hits.append(f"{rel}:{i}: {line.rstrip()}")
                    if len(hits) >= payload.max_matches:
                        break
            if len(hits) >= payload.max_matches:
                break

        if not hits:
            return ToolSuccess(content=f"0 match (scanned {scanned} file)")
        body = "\n".join(hits)
        suffix = "\n... (cap)" if len(hits) >= payload.max_matches else ""
        result = f"{len(hits)} match / {scanned} file:\n{body}{suffix}"
        # v3.48: output 30K cap — stash 무한 loop 방지
        if len(result) > _MAX_OUTPUT_CHARS:
            result = (
                result[:_MAX_OUTPUT_CHARS]
                + f"\n... (truncated at {_MAX_OUTPUT_CHARS:,} chars. "
                + "max_matches 줄이거나 pattern 더 좁히기.)"
            )
        return ToolSuccess(content=result)


# ─── BashEvidenceTool ──────────────────────────────────────


class BashEvidenceInput(BaseModel):
    command: str = Field(description="evidence_dir cwd 에서 실행할 명령. 단일 명령 권장.")
    timeout_sec: float = Field(default=_DEFAULT_BASH_TIMEOUT, ge=0.05, le=300.0)


class BashEvidenceTool(Tool[BashEvidenceInput]):
    name: ClassVar[str] = "bash_evidence"
    description: ClassVar[str] = (
        "evidence_dir cwd 에서 read-only 명령 실행. is_destructive=True → 사용자 ask. "
        "rm -rf / sudo / curl / wget / nc / fork bomb 등 위험 패턴 사전 차단. timeout cap."
    )
    input_model: ClassVar[type[BaseModel]] = BashEvidenceInput
    is_destructive: ClassVar[bool] = True
    deferred: ClassVar[bool] = True  # v3.17: 위험 last-resort — tool_search 로 unlock.
    domain: ClassVar[str] = "core"
    prompt_section: ClassVar[str] = (
        "**bash_evidence** — evidence_dir 한정 명령 실행. 위험 명령 (rm/sudo/curl/wget) "
        "사전 차단. 호스트 외부 접근 불가. 일반 분석에는 read_evidence_file / grep_evidence "
        "선호 — bash 는 file/awk/sort 같은 ad-hoc pipe 필요할 때만."
    )

    async def execute(self, payload: BashEvidenceInput, context: ToolContext) -> ToolResult:
        cmd = payload.command.strip()
        if not cmd:
            return ToolError(kind="validation", message="command 비어있음")

        for pat in _BASH_DANGEROUS:
            if pat.search(cmd):
                return ToolError(
                    kind="forbidden",
                    message=f"위험 패턴 매치 — 차단됨: {pat.pattern}",
                )

        start = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                cwd=str(context.evidence_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except OSError as e:
            return ToolError(kind="io_error", message=f"subprocess launch failed: {e}")

        try:
            stdout, _ = await asyncio.wait_for(
                proc.communicate(), timeout=payload.timeout_sec,
            )
        except TimeoutError:
            proc.kill()
            try:
                await proc.wait()
            except Exception:
                pass
            return ToolError(
                kind="timeout",
                message=f"timed out after {payload.timeout_sec}s",
            )

        duration = time.monotonic() - start
        out = (stdout or b"").decode("utf-8", errors="replace")
        truncated = False
        if len(out) > _MAX_BASH_OUT_BYTES:
            out = out[:_MAX_BASH_OUT_BYTES] + "\n... (truncated)"
            truncated = True

        from secu_agent.agent.secret_redact import redact_secrets
        header = (
            f"exit={proc.returncode} duration={duration:.2f}s"
            + (" truncated" if truncated else "")
        )
        return ToolSuccess(content=redact_secrets(f"{header}\n---\n{out}"))
