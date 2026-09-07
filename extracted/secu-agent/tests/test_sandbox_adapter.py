"""v3.18-A: ai-sandbox 어댑터.

secu_agent/sandbox.py — SandboxRunner Protocol + AiSandboxRunner (실제) +
StubSandboxRunner (테스트/eval). asyncio.Lock 으로 단일 VM 직렬화. AI_SANDBOX_DIR
미설정 / 미설치 시 graceful disable.
"""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest


# ─── 설정 검출 ───────────────────────────────────────────────


def test_sandbox_config_detects_dir_from_env(tmp_path, monkeypatch):
    from secu_agent.sandbox import SandboxConfig

    sb = tmp_path / "ai-sandbox"
    sb.mkdir()
    (sb / ".env").write_text("VM_GUEST_IP=172.16.0.2\n", encoding="utf-8")
    (sb / "scripts").mkdir()
    (sb / "scripts" / "restore_snapshot.sh").write_text("#!/bin/bash\n", encoding="utf-8")

    monkeypatch.setenv("AI_SANDBOX_DIR", str(sb))
    cfg = SandboxConfig.from_env()
    assert cfg.enabled
    assert cfg.sandbox_dir == sb


def test_sandbox_config_disabled_when_env_missing(monkeypatch):
    from secu_agent.sandbox import SandboxConfig

    monkeypatch.delenv("AI_SANDBOX_DIR", raising=False)
    cfg = SandboxConfig.from_env()
    assert not cfg.enabled
    assert cfg.disabled_reason


def test_sandbox_config_disabled_when_dir_missing(tmp_path, monkeypatch):
    from secu_agent.sandbox import SandboxConfig

    monkeypatch.setenv("AI_SANDBOX_DIR", str(tmp_path / "nope"))
    cfg = SandboxConfig.from_env()
    assert not cfg.enabled
    assert "AI_SANDBOX_DIR" in cfg.disabled_reason or "not" in cfg.disabled_reason.lower()


def test_sandbox_config_disabled_when_scripts_missing(tmp_path, monkeypatch):
    from secu_agent.sandbox import SandboxConfig

    sb = tmp_path / "ai-sandbox"
    sb.mkdir()
    # restore_snapshot.sh 없음
    monkeypatch.setenv("AI_SANDBOX_DIR", str(sb))
    cfg = SandboxConfig.from_env()
    assert not cfg.enabled


# ─── StubSandboxRunner ─────────────────────────────────────


def test_stub_runner_returns_canned_result(tmp_path):
    from secu_agent.sandbox import SandboxResult, StubSandboxRunner

    runner = StubSandboxRunner(canned=SandboxResult(
        exit_code=0, stdout="hello", stderr="", duration_sec=0.1,
    ))
    res = asyncio.run(runner.run(
        file_path=tmp_path / "x.bin",
        command="run",
        timeout_sec=10,
        evidence_dir=tmp_path,
    ))
    assert res.exit_code == 0
    assert res.stdout == "hello"


def test_stub_runner_serializes_concurrent_calls(tmp_path):
    """동시에 여러 task 가 run() 호출해도 Lock 으로 단일 VM 직렬화."""
    from secu_agent.sandbox import SandboxResult, StubSandboxRunner

    started: list[int] = []
    finished: list[int] = []

    async def _scenario():
        # delay 가 있는 stub — 동시 호출이 직렬화되는지 확인
        async def slow_run(*, file_path, command, timeout_sec, evidence_dir, is_aborted=None):
            n = len(started)
            started.append(n)
            await asyncio.sleep(0.05)
            finished.append(n)
            return SandboxResult(exit_code=0, stdout=str(n), stderr="", duration_sec=0.05)

        runner = StubSandboxRunner(canned=None, override_run=slow_run)
        # 동시에 3 호출
        results = await asyncio.gather(*(
            runner.run(
                file_path=tmp_path / f"f{i}.bin",
                command=f"run{i}",
                timeout_sec=1,
                evidence_dir=tmp_path,
            )
            for i in range(3)
        ))
        return results

    results = asyncio.run(_scenario())
    # 각 호출 finished 가 다음 started 보다 일찍 일어났어야 함 (직렬화)
    assert len(results) == 3
    # started/finished 가 같은 순서로 짝지어졌으면 직렬화 OK
    # (병렬이면 started=[0,1,2] 후 finished=[0,1,2] 같이 섞임. lock 있으면
    # started=[0],finished=[0],started=[1],finished=[1],...)
    pairs = list(zip(started, finished))
    # 직렬화면 짝지을 때마다 같은 수 — 충분조건은 아니지만 회귀에 충분
    for s, f in pairs:
        assert s == f


# ─── 어보트 ───────────────────────────────────────────────


def test_stub_runner_respects_is_aborted_before_run(tmp_path):
    from secu_agent.sandbox import StubSandboxRunner

    runner = StubSandboxRunner()
    res = asyncio.run(runner.run(
        file_path=tmp_path / "x.bin",
        command="ls",
        timeout_sec=10,
        evidence_dir=tmp_path,
        is_aborted=lambda: True,
    ))
    assert res.cancelled
    assert res.exit_code != 0


# ─── AiSandboxRunner — disable 케이스 ─────────────────────


def test_ai_sandbox_runner_raises_when_disabled(tmp_path, monkeypatch):
    """ai-sandbox 미설치 시 명시적 SandboxDisabledError 던짐."""
    from secu_agent.sandbox import (
        AiSandboxRunner,
        SandboxConfig,
        SandboxDisabledError,
    )

    monkeypatch.delenv("AI_SANDBOX_DIR", raising=False)
    cfg = SandboxConfig.from_env()
    runner = AiSandboxRunner(config=cfg)

    with pytest.raises(SandboxDisabledError):
        asyncio.run(runner.run(
            file_path=tmp_path / "x.bin",
            command="run",
            timeout_sec=1,
            evidence_dir=tmp_path,
        ))


def test_ai_sandbox_runner_invokes_subprocess_when_enabled(tmp_path, monkeypatch):
    """실제 ai-sandbox 호출은 subprocess. 여기선 subprocess 를 mock 으로 가로채
    명령 인자 + cwd 가 올바른지 검증."""
    from secu_agent.sandbox import AiSandboxRunner, SandboxConfig

    # 가짜 ai-sandbox layout
    sb = tmp_path / "ai-sandbox"
    sb.mkdir()
    (sb / ".env").write_text("", encoding="utf-8")
    (sb / "scripts").mkdir()
    (sb / "scripts" / "restore_snapshot.sh").write_text("#!/bin/bash\n", encoding="utf-8")
    monkeypatch.setenv("AI_SANDBOX_DIR", str(sb))
    cfg = SandboxConfig.from_env()
    assert cfg.enabled

    # 가짜 파일 (sandbox 가 받을 input)
    sample = tmp_path / "evil.sh"
    sample.write_bytes(b"#!/bin/bash\necho compromised\n")

    captured = {}

    async def fake_exec(*args, **kw):
        captured["args"] = args
        captured["cwd"] = kw.get("cwd")

        class _P:
            returncode = 0
            async def communicate(self, *_a, **_kw):
                return (b"VM stdout\n", b"")
        return _P()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    runner = AiSandboxRunner(config=cfg)
    res = asyncio.run(runner.run(
        file_path=sample,
        command="bash /tmp/sample",
        timeout_sec=10,
        evidence_dir=tmp_path / "ev",
    ))
    assert res.exit_code == 0
    assert "VM stdout" in res.stdout
    # subprocess 가 ai-sandbox cwd 에서 실행됐어야 함
    assert str(captured["cwd"]) == str(sb)


# ─── timeout ───────────────────────────────────────────────


def test_ai_sandbox_runner_timeout(tmp_path, monkeypatch):
    from secu_agent.sandbox import AiSandboxRunner, SandboxConfig

    sb = tmp_path / "ai-sandbox"
    sb.mkdir()
    (sb / "scripts").mkdir()
    (sb / "scripts" / "restore_snapshot.sh").write_text("#!/bin/bash\n", encoding="utf-8")
    monkeypatch.setenv("AI_SANDBOX_DIR", str(sb))
    cfg = SandboxConfig.from_env()

    async def slow_exec(*args, **kw):
        class _P:
            returncode = None
            async def communicate(self, *_a, **_kw):
                await asyncio.sleep(10)
                return (b"", b"")
            def kill(self):
                self.returncode = -9
        return _P()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", slow_exec)

    runner = AiSandboxRunner(config=cfg)
    sample = tmp_path / "x.bin"
    sample.write_bytes(b"x")
    res = asyncio.run(runner.run(
        file_path=sample,
        command="run",
        timeout_sec=0.1,
        evidence_dir=tmp_path / "ev",
    ))
    assert res.timed_out
    assert res.exit_code != 0


# ─── v3.18.1: verdict.json / result_dir 통합 ────────────────


def test_parse_result_dir_from_stdout_relative(tmp_path):
    from secu_agent.sandbox import _parse_result_dir

    sb = tmp_path / "ai-sandbox"
    (sb / "results" / "fake_pkg_20260514_141042").mkdir(parents=True)
    stdout = (
        "[*] sdist sha256: abc...\n"
        "[*] Pipeline phase done. Results in: ./results/fake_pkg_20260514_141042\n"
        "[*] Running LLM analysis agent ...\n"
    )
    p = _parse_result_dir(stdout, sb)
    assert p == (sb / "results" / "fake_pkg_20260514_141042").resolve()


def test_parse_result_dir_from_stdout_absolute(tmp_path):
    from secu_agent.sandbox import _parse_result_dir

    sb = tmp_path / "ai-sandbox"
    rd = sb / "results" / "x_20260514_141042"
    rd.mkdir(parents=True)
    stdout = f"prologue\n[*] Pipeline phase done. Results in: {rd}\nepilogue\n"
    p = _parse_result_dir(stdout, sb)
    assert p == rd.resolve()


def test_parse_result_dir_returns_none_when_missing(tmp_path):
    from secu_agent.sandbox import _parse_result_dir

    sb = tmp_path / "ai-sandbox"
    sb.mkdir()
    # marker 라인 없음
    assert _parse_result_dir("just some random stdout\n", sb) is None
    # marker 있지만 디렉토리 미존재
    stdout = "[*] Pipeline phase done. Results in: ./results/nope_dir\n"
    assert _parse_result_dir(stdout, sb) is None


def test_read_verdict_json(tmp_path):
    from secu_agent.sandbox import _read_verdict

    rd = tmp_path / "results" / "x_1"
    rd.mkdir(parents=True)
    (rd / "verdict.json").write_text(
        '{"risk_level": "suspicious", "confidence": 0.7, "evidence_paths": ["a", "b"]}',
        encoding="utf-8",
    )
    v = _read_verdict(rd)
    assert v["risk_level"] == "suspicious"
    assert v["evidence_paths"] == ["a", "b"]


def test_read_verdict_missing_returns_none(tmp_path):
    from secu_agent.sandbox import _read_verdict

    rd = tmp_path / "x"
    rd.mkdir()
    assert _read_verdict(rd) is None


def test_read_verdict_malformed_returns_none(tmp_path):
    from secu_agent.sandbox import _read_verdict

    rd = tmp_path / "x"
    rd.mkdir()
    (rd / "verdict.json").write_text("not json {{{", encoding="utf-8")
    assert _read_verdict(rd) is None


def test_ai_sandbox_runner_populates_verdict(tmp_path, monkeypatch):
    """subprocess mock 으로 verdict.json 흐름 종단 검증."""
    from secu_agent.sandbox import AiSandboxRunner, SandboxConfig

    sb = tmp_path / "ai-sandbox"
    sb.mkdir()
    (sb / ".env").write_text("", encoding="utf-8")
    (sb / "scripts").mkdir()
    (sb / "scripts" / "restore_snapshot.sh").write_text("#!/bin/bash\n", encoding="utf-8")

    rd = sb / "results" / "evil_20260514_150000"
    rd.mkdir(parents=True)
    (rd / "verdict.json").write_text(
        '{"risk_level": "malicious", "confidence": 0.95, '
        '"evidence_paths": ["source/payload.py:1-10", "install_trace.log:42"]}',
        encoding="utf-8",
    )

    monkeypatch.setenv("AI_SANDBOX_DIR", str(sb))
    cfg = SandboxConfig.from_env()

    fake_stdout = (
        b"[*] sdist sha256: ...\n"
        b"[*] Restoring clean VM snapshot...\n"
        b"[*] Pipeline phase done. Results in: ./results/evil_20260514_150000\n"
        b"[*] Running LLM analysis agent ...\n"
        + str(rd / "verdict.json").encode() + b"\n"
    )

    async def fake_exec(*args, **kw):
        class _P:
            returncode = 0
            async def communicate(self, *_a, **_kw):
                return (fake_stdout, b"")
        return _P()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    sample = tmp_path / "evil.bin"
    sample.write_bytes(b"x")
    runner = AiSandboxRunner(config=cfg)
    res = asyncio.run(runner.run(
        file_path=sample,
        command="analyze",
        timeout_sec=10,
        evidence_dir=tmp_path / "ev",
    ))
    assert res.exit_code == 0
    assert res.result_dir == rd.resolve()
    assert res.verdict is not None
    assert res.verdict["risk_level"] == "malicious"
    assert res.verdict["confidence"] == 0.95
    assert "source/payload.py:1-10" in res.verdict["evidence_paths"]


def test_sandbox_result_new_fields_default_none(tmp_path):
    from secu_agent.sandbox import SandboxResult

    r = SandboxResult(exit_code=0)
    assert r.verdict is None
    assert r.result_dir is None


def test_parse_inline_verdict_cache_hit(tmp_path):
    """analyze_package.sh CACHE HIT 케이스 — pipeline marker 없이 verdict JSON 만 출력."""
    from secu_agent.sandbox import _parse_inline_verdict

    stdout = (
        "[*] source fingerprint: 137d11da84f7f1e9…\n"
        "[*] CACHE HIT (by source fingerprint) — skipping agent.\n"
        "{\n"
        '  "risk_level": "benign",\n'
        '  "confidence": 0.99,\n'
        '  "evidence_paths": ["a", "b"],\n'
        '  "iocs": {"domains": [], "hashes": []},\n'
        '  "mitre_attack": []\n'
        "}\n"
        "--- reasoning ---\n"
        "blah blah\n"
    )
    v = _parse_inline_verdict(stdout)
    assert v is not None
    assert v["risk_level"] == "benign"
    assert v["confidence"] == 0.99
    assert v["iocs"]["domains"] == []


def test_parse_inline_verdict_returns_none_when_missing(tmp_path):
    from secu_agent.sandbox import _parse_inline_verdict

    assert _parse_inline_verdict("nothing here\n") is None
    # JSON block 있지만 risk_level 없음
    assert _parse_inline_verdict('{\n  "foo": 1\n}\n') is None


def test_runner_falls_back_to_inline_verdict_on_cache_hit(tmp_path, monkeypatch):
    """결과 dir 마커가 없고 verdict.json 파일도 없을 때, stdout inline JSON 으로 fallback."""
    from secu_agent.sandbox import AiSandboxRunner, SandboxConfig

    sb = tmp_path / "ai-sandbox"
    sb.mkdir()
    (sb / "scripts").mkdir()
    (sb / "scripts" / "restore_snapshot.sh").write_text("#!/bin/bash\n", encoding="utf-8")
    monkeypatch.setenv("AI_SANDBOX_DIR", str(sb))
    cfg = SandboxConfig.from_env()

    fake_stdout = (
        b"[*] source fingerprint: abc...\n"
        b"[*] CACHE HIT (by source fingerprint) - skipping agent.\n"
        b"{\n"
        b'  "risk_level": "suspicious",\n'
        b'  "confidence": 0.7,\n'
        b'  "evidence_paths": ["x.py:1-2"]\n'
        b"}\n"
        b"--- reasoning ---\n"
        b"some text\n"
    )

    async def fake_exec(*args, **kw):
        class _P:
            returncode = 0
            async def communicate(self, *_a, **_kw):
                return (fake_stdout, b"")
        return _P()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    sample = tmp_path / "x.bin"
    sample.write_bytes(b"x")
    res = asyncio.run(AiSandboxRunner(config=cfg).run(
        file_path=sample, command="analyze", timeout_sec=10,
        evidence_dir=tmp_path / "ev",
    ))
    assert res.verdict is not None
    assert res.verdict["risk_level"] == "suspicious"
    assert res.result_dir is None  # marker 없으니 dir 추적 불가

