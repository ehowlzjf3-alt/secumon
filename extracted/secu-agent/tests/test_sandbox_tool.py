"""v3.18-B: RunInSandboxTool.

is_destructive=True (LLM 이 호출하면 ask). SandboxRunner 주입 — 테스트에선
StubSandboxRunner, 운영은 AiSandboxRunner.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess
from secu_agent.sandbox import SandboxResult, StubSandboxRunner


def _ctx(tmp_path: Path, runner) -> ToolContext:
    return ToolContext(
        evidence_dir=tmp_path,
        metadata={"sandbox_runner": runner},
    )


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def _write_file(tmp_path: Path) -> Path:
    p = tmp_path / "suspicious.sh"
    p.write_bytes(b"#!/bin/bash\necho evil\n")
    return p


# ─── 메타 ────────────────────────────────────────────────────


def test_tool_metadata_destructive_and_domain():
    from secu_agent.agent.tools.sandbox_tool import RunInSandboxTool

    assert RunInSandboxTool.is_destructive is True
    assert RunInSandboxTool.name == "run_in_sandbox"
    # 도메인 무관 — 어느 task 에서나 의심파일 격리 실행. core 로 둠.
    assert RunInSandboxTool.domain in {"core", "sandbox"}


# ─── v3.18.1: verdict / result_dir 노출 ────────────────────


def test_summary_surfaces_verdict_when_present(tmp_path):
    """SandboxResult.verdict 가 있으면 summary 에 risk_level/confidence/paths 포함."""
    from secu_agent.agent.tools.sandbox_tool import RunInSandboxTool

    rd = tmp_path / "results" / "x_1"
    rd.mkdir(parents=True)
    canned = SandboxResult(
        exit_code=0,
        stdout="[*] Pipeline phase done. Results in: ./results/x_1\n",
        duration_sec=12.3,
        result_dir=rd,
        verdict={
            "risk_level": "malicious",
            "confidence": 0.92,
            "evidence_paths": ["source/payload.py:1-12", "install_trace.log:42"],
            "summary": "outbound connect to attacker-controlled IP",
        },
    )
    runner = StubSandboxRunner(canned=canned)
    res = _run(RunInSandboxTool(), {
        "file_path": str(_write_file(tmp_path)),
        "command": "bash /tmp/x",
        "timeout_sec": 60,
        "rationale": "test",
    }, _ctx(tmp_path, runner))
    assert isinstance(res, ToolSuccess)
    assert "risk_level=malicious" in res.content
    assert "confidence=0.92" in res.content
    assert "source/payload.py:1-12" in res.content
    assert str(rd) in res.content


def test_summary_falls_back_to_stdout_when_no_verdict(tmp_path):
    """verdict 없으면 기존 stdout 요약 흐름 유지 (회귀)."""
    from secu_agent.agent.tools.sandbox_tool import RunInSandboxTool

    canned = SandboxResult(
        exit_code=0, stdout="plain stdout from VM", duration_sec=1.0,
    )
    runner = StubSandboxRunner(canned=canned)
    res = _run(RunInSandboxTool(), {
        "file_path": str(_write_file(tmp_path)),
        "command": "bash /tmp/x",
        "timeout_sec": 60,
        "rationale": "test",
    }, _ctx(tmp_path, runner))
    assert isinstance(res, ToolSuccess)
    assert "plain stdout from VM" in res.content
    assert "risk_level=" not in res.content


def test_artifact_includes_verdict_and_result_dir(tmp_path):
    """evidence_dir/sandbox/run_*.json 에 verdict + result_dir 영속."""
    import json

    from secu_agent.agent.tools.sandbox_tool import RunInSandboxTool

    rd = tmp_path / "results" / "y_2"
    rd.mkdir(parents=True)
    verdict = {"risk_level": "suspicious", "confidence": 0.7, "evidence_paths": []}
    canned = SandboxResult(
        exit_code=0, stdout="ok", duration_sec=2.0,
        result_dir=rd, verdict=verdict,
    )
    runner = StubSandboxRunner(canned=canned)
    _run(RunInSandboxTool(), {
        "file_path": str(_write_file(tmp_path)),
        "command": "bash /tmp/x",
        "timeout_sec": 60,
        "rationale": "test",
    }, _ctx(tmp_path, runner))

    artifacts = list((tmp_path / "sandbox").glob("run_*.json"))
    assert len(artifacts) == 1
    payload = json.loads(artifacts[0].read_text(encoding="utf-8"))
    assert payload["verdict"] == verdict
    assert payload["result_dir"] == str(rd)


def test_tool_permission_asks_when_destructive(tmp_path):
    from secu_agent.agent.tools.sandbox_tool import RunInSandboxTool

    tool = RunInSandboxTool()
    payload = tool.input_model(file_path=str(_write_file(tmp_path)), command="bash /tmp/x")
    ctx = _ctx(tmp_path, StubSandboxRunner())
    decision = asyncio.run(tool.check_permission(payload, ctx))
    assert decision.behavior == "ask"


# ─── 정상 호출 ─────────────────────────────────────────────


def test_success_returns_tool_success_with_summary(tmp_path):
    from secu_agent.agent.tools.sandbox_tool import RunInSandboxTool

    f = _write_file(tmp_path)
    runner = StubSandboxRunner(canned=SandboxResult(
        exit_code=0, stdout="hello from VM", stderr="", duration_sec=2.5,
    ))
    res = _run(RunInSandboxTool(), {
        "file_path": str(f), "command": "bash /tmp/x", "timeout_sec": 30,
    }, _ctx(tmp_path, runner))
    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    assert "exit_code" in res.content
    assert "hello from VM" in res.content


def test_writes_evidence_artifact(tmp_path):
    """sandbox 결과 raw 가 evidence_dir/sandbox/*.json 에 저장."""
    from secu_agent.agent.tools.sandbox_tool import RunInSandboxTool

    f = _write_file(tmp_path)
    runner = StubSandboxRunner(canned=SandboxResult(
        exit_code=1, stdout="x", stderr="y", duration_sec=0.5,
    ))
    res = _run(RunInSandboxTool(), {
        "file_path": str(f), "command": "run", "timeout_sec": 10,
    }, _ctx(tmp_path, runner))
    assert isinstance(res, ToolSuccess)
    # evidence artifact 만들었는지
    artifacts = list((tmp_path / "sandbox").glob("*.json"))
    assert len(artifacts) == 1


# ─── 에러 케이스 ───────────────────────────────────────────


def test_missing_file_returns_validation_error(tmp_path):
    from secu_agent.agent.tools.sandbox_tool import RunInSandboxTool

    res = _run(RunInSandboxTool(), {
        "file_path": str(tmp_path / "nope.bin"), "command": "run", "timeout_sec": 5,
    }, _ctx(tmp_path, StubSandboxRunner()))
    assert isinstance(res, ToolError)
    assert res.kind in {"validation", "not_found"}


def test_sandbox_disabled_returns_forbidden(tmp_path):
    """SandboxDisabledError 던지면 ToolError(kind='forbidden') 로 매핑."""
    from secu_agent.agent.tools.sandbox_tool import RunInSandboxTool
    from secu_agent.sandbox import SandboxDisabledError

    class _DisabledRunner:
        async def run(self, **kw):
            raise SandboxDisabledError("ai-sandbox not installed")

    f = _write_file(tmp_path)
    res = _run(RunInSandboxTool(), {
        "file_path": str(f), "command": "run", "timeout_sec": 5,
    }, _ctx(tmp_path, _DisabledRunner()))
    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"
    assert "ai-sandbox" in res.message


def test_timeout_returns_timeout_error(tmp_path):
    from secu_agent.agent.tools.sandbox_tool import RunInSandboxTool

    runner = StubSandboxRunner(canned=SandboxResult(
        exit_code=-1, stdout="", stderr="timed out", duration_sec=10.0,
        timed_out=True,
    ))
    f = _write_file(tmp_path)
    res = _run(RunInSandboxTool(), {
        "file_path": str(f), "command": "run", "timeout_sec": 1,
    }, _ctx(tmp_path, runner))
    assert isinstance(res, ToolError)
    assert res.kind == "timeout"


def test_cancelled_signal_propagates(tmp_path):
    from secu_agent.agent.tools.sandbox_tool import RunInSandboxTool

    runner = StubSandboxRunner()
    ctx = _ctx(tmp_path, runner)
    ctx.signal.set()  # pre-abort

    f = _write_file(tmp_path)
    res = _run(RunInSandboxTool(), {
        "file_path": str(f), "command": "run", "timeout_sec": 5,
    }, ctx)
    assert isinstance(res, ToolError)
    assert res.kind == "cancelled"


# ─── runner 미주입 ─────────────────────────────────────────


def test_no_runner_in_context_falls_back_to_env_or_disabled(tmp_path, monkeypatch):
    """context.metadata 에 runner 없으면 SandboxConfig.from_env() 로 자동
    AiSandboxRunner. env 도 disabled 면 ToolError(forbidden)."""
    from secu_agent.agent.tools.sandbox_tool import RunInSandboxTool

    monkeypatch.delenv("AI_SANDBOX_DIR", raising=False)
    f = _write_file(tmp_path)
    ctx = ToolContext(evidence_dir=tmp_path)  # runner 없음
    res = _run(RunInSandboxTool(), {
        "file_path": str(f), "command": "run", "timeout_sec": 5,
    }, ctx)
    assert isinstance(res, ToolError)
    assert res.kind == "forbidden"
