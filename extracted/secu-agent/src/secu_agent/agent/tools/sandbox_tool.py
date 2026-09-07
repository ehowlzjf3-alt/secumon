"""RunInSandboxTool — ai-sandbox microVM 격리 실행.

is_destructive=True — LLM 호출 시 사용자 승인 (ask). 외부에서 가져온 의심
파일을 호스트에서 직접 안 까보고 ai-sandbox VM 안에서 실행 + strace.

SandboxRunner 주입:
  ctx.metadata["sandbox_runner"] = StubSandboxRunner(...) 또는 AiSandboxRunner()
없으면 SandboxConfig.from_env() 로 AiSandboxRunner 자동 생성 (disabled 시 forbidden).
"""
from __future__ import annotations

import json
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
from secu_agent.sandbox import (
    AiSandboxRunner,
    SandboxConfig,
    SandboxDisabledError,
    SandboxRunner,
)


class RunInSandboxInput(BaseModel):
    file_path: str = Field(description="격리 실행할 의심 파일의 호스트 경로.")
    command: str = Field(description="VM 안에서 실행할 명령 (예: 'bash /tmp/sample').")
    timeout_sec: float = Field(default=120.0, ge=1.0, le=600.0,
                                description="VM 실행 timeout (초). 기본 120, 최대 600.")
    rationale: str = Field(default="", description="왜 격리 실행이 필요한지 — audit.")


class RunInSandboxTool(Tool[RunInSandboxInput]):
    name: ClassVar[str] = "run_in_sandbox"
    description: ClassVar[str] = (
        "ai-sandbox microVM 안에서 의심 파일을 격리 실행 + strace. "
        "호스트에서 절대 직접 까보지 말 것. 의심 ELF / 스크립트 / archive 1차 triage 전용."
    )
    input_model: ClassVar[type[BaseModel]] = RunInSandboxInput
    is_destructive: ClassVar[bool] = True
    deferred: ClassVar[bool] = True  # v3.17: 무거운 도구 — tool_search 로 unlock.
    domain: ClassVar[str] = "sandbox"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "sandbox", "샌드박스", "격리 실행", "악성 의심 파일", "ELF", "strace",
    )
    prompt_section: ClassVar[str] = (
        "**run_in_sandbox** — 의심 파일 (ELF / 스크립트 / archive 등) 1차 triage. "
        "호스트에서 직접 cat / 실행 절대 금지. 항상 이 도구 거쳐 microVM 안에서 실행. "
        "is_destructive=True → 사용자 승인 필요."
    )

    async def execute(self, payload: RunInSandboxInput, context: ToolContext) -> ToolResult:
        if context.aborted:
            return ToolError(kind="cancelled", message="aborted before sandbox call")

        file_path = Path(payload.file_path).expanduser()
        if not file_path.is_file():
            return ToolError(
                kind="not_found",
                message=f"file_path 미존재 또는 파일 아님: {file_path}",
            )

        runner = self._resolve_runner(context)
        sandbox_dir = context.evidence_dir / "sandbox"
        sandbox_dir.mkdir(parents=True, exist_ok=True)

        try:
            result = await runner.run(
                file_path=file_path,
                command=payload.command,
                timeout_sec=payload.timeout_sec,
                evidence_dir=sandbox_dir,
                is_aborted=lambda: context.signal.is_set(),
            )
        except SandboxDisabledError as e:
            return ToolError(
                kind="forbidden",
                message=f"ai-sandbox 사용 불가: {e}. AI_SANDBOX_DIR 환경변수 확인.",
            )

        if result.cancelled:
            return ToolError(kind="cancelled", message="sandbox aborted")
        if result.timed_out:
            return ToolError(
                kind="timeout",
                message=f"sandbox timed out after {payload.timeout_sec}s",
            )

        artifact = self._persist_artifact(sandbox_dir, payload, result)

        summary_lines = [
            f"exit_code={result.exit_code}",
            f"duration_sec={result.duration_sec:.2f}",
        ]
        if result.verdict:
            summary_lines += [
                "",
                "--- verdict ---",
                f"risk_level={result.verdict.get('risk_level')}",
                f"confidence={result.verdict.get('confidence')}",
            ]
            paths = result.verdict.get("evidence_paths") or []
            if paths:
                summary_lines.append(f"evidence_paths ({len(paths)}):")
                for p in paths[:10]:
                    summary_lines.append(f"  - {p}")
            v_summary = result.verdict.get("summary") or result.verdict.get("rationale")
            if v_summary:
                summary_lines += ["", "verdict_summary:", str(v_summary)[:600]]
        if result.result_dir is not None:
            summary_lines.append(f"result_dir={result.result_dir}")
        summary_lines += [
            f"stdout_len={len(result.stdout)}",
            f"stderr_len={len(result.stderr)}",
            f"artifact={artifact.relative_to(context.evidence_dir)}",
            "",
            "--- stdout (앞 800 chars) ---",
            result.stdout[:800],
        ]
        if result.stderr:
            summary_lines += ["", "--- stderr (앞 400 chars) ---", result.stderr[:400]]
        return ToolSuccess(content="\n".join(summary_lines))

    def _resolve_runner(self, context: ToolContext) -> SandboxRunner:
        injected = context.metadata.get("sandbox_runner") if context.metadata else None
        if injected is not None:
            return injected  # type: ignore[return-value]
        return AiSandboxRunner(config=SandboxConfig.from_env())

    @staticmethod
    def _persist_artifact(sandbox_dir: Path, payload: RunInSandboxInput, result) -> Path:
        ts = int(time.time() * 1000)
        target = sandbox_dir / f"run_{ts}.json"
        target.write_text(
            json.dumps({
                "file_path": payload.file_path,
                "command": payload.command,
                "timeout_sec": payload.timeout_sec,
                "rationale": payload.rationale,
                "exit_code": result.exit_code,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "duration_sec": result.duration_sec,
                "timed_out": result.timed_out,
                "cancelled": result.cancelled,
                "result_dir": str(result.result_dir) if result.result_dir else None,
                "verdict": result.verdict,
            }, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        return target
