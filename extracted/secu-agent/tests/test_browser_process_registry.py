"""F5-B: 브라우저 CDP PID 캡처 + registry 등록/해제 통합 (실 Chromium).

_start_session 이 실제 chromium 을 띄우고 CDP `SystemInfo.getProcessInfo` 로 browser
OS PID 를 얻어 owner token 과 함께 registry 에 등록하는지, 정상 close 시 해제하는지,
그리고 owner 가 살아있는 동안 reaper 가 그 browser 를 절대 안 죽이는지 검증한다.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

import pytest

from secu_agent.agent import process_registry as pr
from secu_agent.agent.tools import browser_tool as bt

import contextlib
import subprocess

linux_only = pytest.mark.skipif(
    not sys.platform.startswith("linux"), reason="/proc 검증은 Linux 전용",
)

# 실 Chromium 통합은 **opt-in** — 공유/부하 머신에서 chromium launch 가 멈춰
# 스위트를 hang 시키는 것을 막는다. 핵심 registry/reaper 로직은 chromium 없이
# tests/test_process_registry.py 가 검증. 실행: SA_RUN_BROWSER_INTEGRATION=1.
# collection 단계에서 chromium 을 띄우지 않는다(그 자체가 hang 위험). timeout 으로
# 실행 시에도 절대 무한 hang 하지 않게 상한(pytest-timeout).
_run_integration = os.environ.get(
    "SA_RUN_BROWSER_INTEGRATION", "",
).lower() in ("1", "true", "yes")

opt_in = pytest.mark.skipif(
    not _run_integration,
    reason="opt-in: SA_RUN_BROWSER_INTEGRATION=1 (실 chromium 통합)",
)


# ── chromium 없이 브라우저 글루(CDP 파싱+토큰검증+등록) 결정론 검증 ──────────
# 실 chromium 대신 fake CDP browser + 실 subprocess(토큰 env)로 _register_browser_process
# 를 검증한다. CDP 자체 작동은 별도 opt-in 통합 테스트가 실 chromium 으로 확인.


class _FakeCDP:
    def __init__(self, info):
        self._info = info

    async def send(self, method):
        assert method == "SystemInfo.getProcessInfo"
        return self._info


class _FakeBrowser:
    def __init__(self, info):
        self._info = info

    async def new_browser_cdp_session(self):
        return _FakeCDP(self._info)


@linux_only
def test_register_browser_process_captures_verified_pid(tmp_path, monkeypatch):
    monkeypatch.setenv("SA_BROWSER_PROC_REGISTRY_DIR", str(tmp_path))
    token = pr.new_owner_token()
    # 실 프로세스를 chromium browser 대역으로 — env 에 owner token 주입.
    p = subprocess.Popen(
        [sys.executable, "-c", "import time;time.sleep(30)"],
        env={**os.environ, pr.OWNER_TOKEN_ENV: token},
    )
    try:
        info = {"processInfo": [
            {"type": "GPU", "id": 999_999},
            {"type": "browser", "id": p.pid},
        ]}
        got = asyncio.run(bt._register_browser_process(_FakeBrowser(info), token))
        assert got == p.pid  # browser type PID 를 골라 token 확증 후 등록
        data = json.loads(bt._browser_registry_path().read_text())
        assert str(p.pid) in data
        assert data[str(p.pid)]["kind"] == "browser"
    finally:
        with contextlib.suppress(ProcessLookupError):
            p.kill()
            p.wait()


@linux_only
def test_register_browser_process_rejects_ambiguous_and_token_mismatch(
    tmp_path, monkeypatch,
):
    monkeypatch.setenv("SA_BROWSER_PROC_REGISTRY_DIR", str(tmp_path))
    token = pr.new_owner_token()
    p = subprocess.Popen(
        [sys.executable, "-c", "import time;time.sleep(30)"],
        env={**os.environ, pr.OWNER_TOKEN_ENV: token},
    )
    try:
        # browser 프로세스가 2개면 모호 → 등록 생략(None).
        amb = {"processInfo": [
            {"type": "browser", "id": p.pid},
            {"type": "browser", "id": p.pid + 1},
        ]}
        assert asyncio.run(bt._register_browser_process(_FakeBrowser(amb), token)) is None
        # token 불일치(우리가 띄운 게 아님) → 등록 생략(None).
        one = {"processInfo": [{"type": "browser", "id": p.pid}]}
        assert asyncio.run(
            bt._register_browser_process(_FakeBrowser(one), "WRONG-token"),
        ) is None
        # 어느 경우도 registry 파일이 생기지 않는다.
        assert not bt._browser_registry_path().exists()
    finally:
        with contextlib.suppress(ProcessLookupError):
            p.kill()
            p.wait()


@linux_only
@opt_in
@pytest.mark.timeout(120)
def test_browser_pid_registered_and_reaper_respects_live_owner(tmp_path, monkeypatch):
    monkeypatch.setenv("SA_BROWSER_PROC_REGISTRY_DIR", str(tmp_path / "reg"))
    # 이 테스트에서 세션 주입 env 가 새지 않도록.
    for k in ("SA_BROWSER_SESSION_STORAGE_STATE", "SA_BROWSER_SESSION_COOKIES"):
        monkeypatch.delenv(k, raising=False)
    bt._browser_orphan_reap_task = None  # latch reset (프로세스당 1회 reap 재실행)

    async def go():
        ok, reason = await bt._start_session(
            headless=True, viewport_width=1024, viewport_height=768,
        )
        assert ok, f"browser start 실패: {reason}"
        try:
            pid = bt._SESSION_STATE["browser_pid"]
            token = bt._SESSION_STATE["owner_token"]
            return pid, token
        finally:
            pass

    pid, token = asyncio.run(go())
    try:
        # 실제 chromium browser PID 를 얻어 등록했다.
        assert isinstance(pid, int), "browser PID 미획득(CDP 실패?)"
        assert pr.proc_starttime(pid) is not None, "browser 프로세스 미생존"
        # /proc/<pid>/environ 에 owner token 이 실제로 주입됐다.
        assert pr.proc_environ_var(pid, pr.OWNER_TOKEN_ENV) == token
        # registry 파일에 기록됐다.
        reg_path = bt._browser_registry_path()
        data = json.loads(reg_path.read_text())
        assert str(pid) in data
        assert data[str(pid)]["token"] == token

        # 안전: owner(이 테스트 프로세스)가 살아있는 동안 reaper 는 이 browser 를
        # 절대 죽이지 않고, 살아있는 프로세스의 파일도 삭제하지 않는다.
        signalled = pr.reap_orphaned_in_dir(bt._browser_registry_dir())
        assert pid not in signalled
        assert pr.proc_starttime(pid) is not None, "살아있는 owner 의 browser 를 오살"
        assert reg_path.exists(), "살아있는 프로세스의 registry 파일을 오삭제"
    finally:
        asyncio.run(bt._stop_session())

    # 정상 close → registry 에서 해제됐다.
    reg_path = bt._browser_registry_path()
    if reg_path.exists():
        data = json.loads(reg_path.read_text())
        assert str(pid) not in data
    assert bt._SESSION_STATE["browser_pid"] is None
