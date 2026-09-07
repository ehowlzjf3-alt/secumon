"""ai-sandbox 어댑터 — subprocess + asyncio.Lock soft coupling.

설계:
- ai-sandbox 는 별도 프로젝트 (~/project/ai-sandbox). 우리는 import 안 함.
- AI_SANDBOX_DIR 환경변수로 위치 알림. 미설정/미설치 시 graceful disable.
- SandboxRunner Protocol — AiSandboxRunner (실제 subprocess) + StubSandboxRunner (테스트/eval).
- 단일 VM 가정 — asyncio.Lock 으로 직렬화. 부하 늘면 ai-sandbox 쪽 multi-instance 개조.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol


@dataclass(slots=True)
class SandboxConfig:
    sandbox_dir: Path | None
    enabled: bool
    disabled_reason: str = ""

    @classmethod
    def from_env(cls) -> "SandboxConfig":
        raw = os.environ.get("AI_SANDBOX_DIR")
        if not raw:
            return cls(sandbox_dir=None, enabled=False,
                       disabled_reason="AI_SANDBOX_DIR not set")
        p = Path(raw).expanduser()
        if not p.is_dir():
            return cls(sandbox_dir=p, enabled=False,
                       disabled_reason=f"AI_SANDBOX_DIR not a directory: {p}")
        restore = p / "scripts" / "restore_snapshot.sh"
        if not restore.is_file():
            return cls(sandbox_dir=p, enabled=False,
                       disabled_reason=f"missing {restore}")
        return cls(sandbox_dir=p, enabled=True)


@dataclass(slots=True)
class SandboxResult:
    exit_code: int
    stdout: str = ""
    stderr: str = ""
    duration_sec: float = 0.0
    timed_out: bool = False
    cancelled: bool = False
    strace_log_path: Path | None = None
    result_dir: Path | None = None
    verdict: dict[str, Any] | None = None


class SandboxDisabledError(RuntimeError):
    """ai-sandbox 인프라 미설치 / 미설정."""


# v3.18.1: analyze_package.sh 가 결과 디렉토리를 stdout 에 마커로 알려준다.
# 예: "[*] Pipeline phase done. Results in: ./results/fake_pkg_20260514_141042"
_RESULTS_RE = re.compile(r"Pipeline phase done\. Results in:\s*(\S+)")


# 타임아웃 kill 후 좀비 reap + stdout/stderr 파이프 drain/close 를 위한 bounded wait (초).
# D-state 등으로 SIGKILL 이 즉시 안 먹으면 이 시간 후 포기하고 진행 — unbounded wait 금지
# (한 파일이 자원 회수를 영구히 붙잡지 못하게). SA_SANDBOX_REAP_TIMEOUT_SEC 로 튜닝.
_DEFAULT_REAP_TIMEOUT_SEC = 2.0


def _reap_timeout_sec() -> float:
    """kill 후 reap/drain 에 허용할 최대 대기(초). 안전 기본 2s, 양수만 허용."""
    raw = os.environ.get("SA_SANDBOX_REAP_TIMEOUT_SEC")
    if raw is None:
        return _DEFAULT_REAP_TIMEOUT_SEC
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return _DEFAULT_REAP_TIMEOUT_SEC
    return v if v > 0 else _DEFAULT_REAP_TIMEOUT_SEC


async def _reap_process(
    proc: "asyncio.subprocess.Process", reap_timeout: float,
) -> None:
    """SIGKILL 후 좀비 reap + stdout/stderr 파이프 drain/close (bounded).

    - communicate() 가 남은 출력을 읽어 파이프를 닫고 wait() 로 좀비를 회수한다.
    - reap_timeout 안에 안 끝나면(예: D-state) 포기 — fd/zombie 는 프로세스 종료 시
      OS 가 정리하므로 여기서 무한 대기하지 않는다.
    """
    async def _drain_and_wait() -> None:
        try:
            # communicate(): 남은 stdout/stderr 소비 + 파이프 close + wait() 로 reap.
            await proc.communicate()
        except Exception:
            # 이미 부분 소비/전송 종료 등 — 최소한 wait() 로 좀비 회수만이라도 시도.
            try:
                await proc.wait()
            except Exception:
                pass

    try:
        await asyncio.wait_for(_drain_and_wait(), timeout=reap_timeout)
    except (TimeoutError, Exception):
        # bounded: reap 이 시간 내 안 끝나도 진행 (호출부는 timed_out 결과 반환).
        pass


def _parse_result_dir(stdout: str, sandbox_dir: Path) -> Path | None:
    """analyze_package.sh stdout 에서 results dir 추출 → 절대경로 resolve."""
    m = _RESULTS_RE.search(stdout)
    if not m:
        return None
    raw = m.group(1)
    p = Path(raw)
    if not p.is_absolute():
        p = sandbox_dir / p
    try:
        resolved = p.resolve(strict=False)
    except OSError:
        return None
    if not resolved.is_dir():
        return None
    return resolved


def _read_verdict(result_dir: Path) -> dict[str, Any] | None:
    """result_dir/verdict.json 읽기. 누락/파싱 실패 시 None."""
    f = result_dir / "verdict.json"
    if not f.is_file():
        return None
    try:
        return json.loads(f.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _parse_inline_verdict(stdout: str) -> dict[str, Any] | None:
    """stdout 안에서 verdict JSON 블록 찾아 파싱.

    analyze_package.sh CACHE HIT 경로 — pipeline marker 안 찍히고 verdict 만
    바로 print. 블록 검색은 `{` 단독 라인부터 `}` 단독 라인까지 보고,
    JSON 파싱 + risk_level 키 존재 확인.
    """
    lines = stdout.splitlines()
    start: int | None = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "{":
            start = i
            continue
        if start is not None and stripped == "}":
            block = "\n".join(lines[start: i + 1])
            try:
                parsed = json.loads(block)
            except json.JSONDecodeError:
                start = None
                continue
            if isinstance(parsed, dict) and "risk_level" in parsed:
                return parsed
            start = None
    return None


class SandboxRunner(Protocol):
    async def run(
        self,
        *,
        file_path: Path,
        command: str,
        timeout_sec: float,
        evidence_dir: Path,
        is_aborted: Callable[[], bool] | None = None,
    ) -> SandboxResult: ...


# 단일 VM 직렬화 — 모듈 레벨 (다중 runner 인스턴스 간에도 충돌 방지).
_VM_LOCK = asyncio.Lock()


class StubSandboxRunner:
    """테스트/eval 용 결정적 runner."""

    def __init__(
        self,
        *,
        canned: SandboxResult | None = None,
        override_run: Callable | None = None,
    ) -> None:
        self._canned = canned or SandboxResult(exit_code=0, stdout="stub-ok")
        self._override_run = override_run

    async def run(
        self,
        *,
        file_path: Path,
        command: str,
        timeout_sec: float,
        evidence_dir: Path,
        is_aborted: Callable[[], bool] | None = None,
    ) -> SandboxResult:
        async with _VM_LOCK:
            if is_aborted and is_aborted():
                return SandboxResult(
                    exit_code=-1, stdout="", stderr="aborted before run",
                    cancelled=True,
                )
            if self._override_run is not None:
                return await self._override_run(
                    file_path=file_path, command=command,
                    timeout_sec=timeout_sec, evidence_dir=evidence_dir,
                    is_aborted=is_aborted,
                )
            return self._canned


class AiSandboxRunner:
    """ai-sandbox subprocess + Lock 직렬화. 실제 microVM 호출."""

    def __init__(self, *, config: SandboxConfig | None = None) -> None:
        self.config = config or SandboxConfig.from_env()

    async def run(
        self,
        *,
        file_path: Path,
        command: str,
        timeout_sec: float,
        evidence_dir: Path,
        is_aborted: Callable[[], bool] | None = None,
    ) -> SandboxResult:
        if not self.config.enabled:
            raise SandboxDisabledError(self.config.disabled_reason)

        evidence_dir.mkdir(parents=True, exist_ok=True)

        async with _VM_LOCK:
            if is_aborted and is_aborted():
                return SandboxResult(
                    exit_code=-1, cancelled=True, stderr="aborted before run",
                )
            return await self._run_locked(
                file_path=file_path, command=command,
                timeout_sec=timeout_sec, evidence_dir=evidence_dir,
            )

    async def _run_locked(
        self, *, file_path: Path, command: str,
        timeout_sec: float, evidence_dir: Path,
    ) -> SandboxResult:
        """실제 ai-sandbox 호출. 현재 MVP: analyze_package.sh 가 받는 디렉토리/tarball
        포맷 그대로. SMB 의심 파일은 일단 tarball 로 묶어서 전달. command 인자는
        v3.18.1 에서 ai-sandbox 쪽에 exec_command.sh 박을 때 활용."""
        assert self.config.sandbox_dir is not None
        script = self.config.sandbox_dir / "scripts" / "analyze_package.sh"

        start = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_exec(
                "bash", str(script), str(file_path),
                cwd=str(self.config.sandbox_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as e:
            return SandboxResult(
                exit_code=127, stderr=f"bash launch failed: {e}",
                duration_sec=time.monotonic() - start,
            )

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout_sec,
            )
        except TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass  # 이미 종료됨 — reap 만 진행.
            # kill 후 bounded reap + 파이프 drain/close (좀비/fd 누수 방지).
            await _reap_process(proc, _reap_timeout_sec())
            return SandboxResult(
                exit_code=-1, timed_out=True,
                stderr=f"timed out after {timeout_sec}s",
                duration_sec=time.monotonic() - start,
            )

        stdout_s = (stdout or b"").decode("utf-8", errors="replace")
        stderr_s = (stderr or b"").decode("utf-8", errors="replace")

        assert self.config.sandbox_dir is not None
        result_dir = _parse_result_dir(stdout_s, self.config.sandbox_dir)
        verdict = _read_verdict(result_dir) if result_dir is not None else None
        if verdict is None:
            # CACHE HIT 등 marker 미출력 케이스 — stdout 안 verdict JSON 블록 fallback.
            verdict = _parse_inline_verdict(stdout_s)

        return SandboxResult(
            exit_code=proc.returncode or 0,
            stdout=stdout_s,
            stderr=stderr_s,
            duration_sec=time.monotonic() - start,
            result_dir=result_dir,
            verdict=verdict,
        )
