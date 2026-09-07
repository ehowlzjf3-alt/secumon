"""리드 세션 장부 + 동시성 계약 (Phase 4c).

여기서 막는 것:
  · 세션 누수 — 검토원 프로세스(도메인에 따라 브라우저까지)가 남는다
  · 동시성 플래그가 조용히 뒤집히는 것 — 병렬이 꺼지거나(느려짐), 안전하지 않은 게 병렬로 돈다
"""
from __future__ import annotations

import asyncio
import json
import sys
import textwrap

import pytest

from secu_agent.agent.tools.base import tool_is_concurrency_safe

from _shared import session_registry as reg
from _shared.lead_tools import lead_tools

_SPEC = {"task_id": "t", "task_type": "smb_file_inspect", "charter_ref": "C",
         "target": {"host": "10.0.0.1"}}

ECHO = '''
    import json, sys, time
    def emit(o): sys.stdout.write(json.dumps(o) + "\\n"); sys.stdout.flush()
    emit({"ok": True, "ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        req = json.loads(line)
        if req.get("close"):
            emit({"ok": True, "closed": True}); break
        time.sleep(float(req.get("ask", "0.05") if req.get("ask", "").replace(".","").isdigit() else 0.05))
        emit({"ok": True, "text": req["ask"], "reason": "end_turn",
              "turns_used": 1, "tokens_in": 100})
'''


@pytest.fixture(autouse=True)
def _clean():
    reg._reset_for_test()
    yield
    reg._reset_for_test()


@pytest.fixture()
def fake_exec(tmp_path, monkeypatch):
    script = tmp_path / "echo.py"
    script.write_text(textwrap.dedent(ECHO), encoding="utf-8")
    real = asyncio.create_subprocess_exec

    async def _fake(*argv, **kw):
        return await real(sys.executable, str(script), **kw)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake)
    return script


async def _open(tmp_path, n: int):
    return await reg.open_session(
        evidence_dir=tmp_path, agent="smb_file_inspect", domain="smb",
        target_id=n, spec=_SPEC)


# ── 동시성 계약 (조용히 바뀌면 안 되는 표) ─────────────────────────────

EXPECTED_CONCURRENCY = {
    "list_targets": True,
    "target_detail": True,
    "target_hit_summary": True,   # read-only 집계 — 여러 타깃을 같은 턴에 봐도 된다
    "verify": True,               # 타깃끼리 독립 — 블로킹은 to_thread 로 벗긴다
    "delegate_inspect": False,
    "set_target_status": False,
    "record_pivot": False,
    # 종료 계약 상태(면제)를 쓴다. 열람 도구와 병렬로 돌면 "면제를 세운다" 와
    # "열람이 면제를 회수한다" 의 순서가 비결정적이 되고, 그 창이 곧 우회로다.
    "report_no_targets": False,
    "open_inspection": False,     # 레지스트리 변경 — 배치 경계
    "ask_inspector": True,        # ★ 병렬의 전부
    "close_inspection": False,
}


def test_concurrency_contract_is_pinned():
    """★ `ask_inspector=True` 가 뒤집히면 병렬이 조용히 꺼진다(느려질 뿐 에러는 없다).
    반대로 open/close 가 True 가 되면 레지스트리 변경이 병렬로 돈다."""
    got = {c.name: tool_is_concurrency_safe(c) for c in lead_tools()}
    assert got == EXPECTED_CONCURRENCY


def test_ask_safety_depends_on_the_channel_lock():
    """`ask_inspector=True` 의 **근거**가 락이다 — 락을 지우면 플래그가 거짓말이 된다."""
    import inspect

    from _shared import inspector_channel as m

    src = inspect.getsource(m.SessionChannel)
    assert "self._lock = asyncio.Lock()" in src
    assert "async with self._lock" in src


def test_rollback_switch_removes_session_tools(monkeypatch):
    monkeypatch.setenv("SA_LEAD_SESSIONS", "0")
    names = {c.name for c in lead_tools()}
    assert "ask_inspector" not in names
    assert "delegate_inspect" in names, "롤백 경로가 사라지면 되돌아갈 수 없다"


# ── 장부 ──────────────────────────────────────────────────────────────

def test_open_and_close_tracks_live_count(tmp_path, fake_exec):
    async def _go():
        a = await _open(tmp_path, 1)
        b = await _open(tmp_path, 2)
        assert reg.live_count(tmp_path) == 2
        assert {s["session_id"] for s in reg.live_sessions(tmp_path)} == {a.session_id, b.session_id}
        await reg.close_session(a.session_id)
        assert reg.live_count(tmp_path) == 1
        await reg.close_all(tmp_path)
        assert reg.live_count(tmp_path) == 0
    asyncio.run(_go())


def test_limit_refuses_loudly_and_does_not_kill_existing(tmp_path, fake_exec, monkeypatch):
    """★ 조용히 오래된 세션을 죽이면 리드가 진행 중 작업을 잃고도 모른다."""
    monkeypatch.setenv("SA_LEAD_MAX_SESSIONS", "2")

    async def _go():
        await _open(tmp_path, 1)
        await _open(tmp_path, 2)
        with pytest.raises(reg.SessionLimitReached) as e:
            await _open(tmp_path, 3)
        assert "close_inspection" in str(e.value)
        assert reg.live_count(tmp_path) == 2, "기존 세션이 죽었다"
        await reg.close_all(tmp_path)
    asyncio.run(_go())


def test_close_all_is_the_leak_guard(tmp_path, fake_exec):
    """리드가 끝날 때 남은 세션을 전부 닫는다 — 계약 훅이 이걸 부른다."""
    async def _go():
        await _open(tmp_path, 1)
        await _open(tmp_path, 2)
        n = await reg.close_all(tmp_path)
        assert n == 2 and reg.live_count(tmp_path) == 0
    asyncio.run(_go())


def test_close_all_scopes_by_evidence_dir(tmp_path, fake_exec):
    """다른 리드 런의 세션을 닫으면 안 된다."""
    other = tmp_path / "other"
    other.mkdir()

    async def _go():
        a = await _open(tmp_path, 1)
        b = await reg.open_session(evidence_dir=other, agent="a", domain="smb",
                                   target_id=2, spec=_SPEC)
        await reg.close_all(tmp_path)
        assert reg.get_session(a.session_id) is None
        assert reg.get_session(b.session_id) is not None
        await reg.close_all(other)
    asyncio.run(_go())


def test_parallel_asks_across_sessions_actually_overlap(tmp_path, fake_exec):
    """★ 병렬이 진짜인가 — 각 답이 0.3초 걸리는데 3개가 0.9초가 아니어야 한다."""
    import time

    async def _go():
        chans = [await _open(tmp_path, i) for i in range(3)]
        t0 = time.monotonic()
        await asyncio.gather(*(c.ask("0.3") for c in chans))
        elapsed = time.monotonic() - t0
        await reg.close_all(tmp_path)
        return elapsed

    elapsed = asyncio.run(_go())
    assert elapsed < 0.75, f"세션 3개가 직렬로 돌았다 ({elapsed:.2f}초)"


def test_same_session_asks_are_serialized(tmp_path, fake_exec):
    """같은 세션 동시 호출은 락이 막는다 — 파이프는 단일 스트림이라 짝이 어긋난다."""
    async def _go():
        ch = await _open(tmp_path, 1)
        answers = await asyncio.gather(ch.ask("q1"), ch.ask("q2"), ch.ask("q3"))
        await reg.close_all(tmp_path)
        return [a.summary for a in answers]

    got = asyncio.run(_go())
    assert got == ["q1", "q2", "q3"], f"질문/답 짝이 어긋났다: {got}"


# ── 실기동이 잡은 것 (2026-08-21) ──────────────────────────────────────

def test_cap_is_a_normal_condition_not_an_error(tmp_path, fake_exec, monkeypatch):
    """★ 상한 도달을 ToolError 로 돌려주면 엔진 repeat-error 가드가 런을 죽인다.

    실기동에서 리드가 5·6번째 세션을 열려다 `repeat_error_halt` 로 끝났다. 닫고 다시
    열면 되는 상황은 **오류가 아니다** — 성공으로 알려주고 상태를 줘야 리드가 회복한다.
    """
    import asyncio as _a
    import json as _j

    from secu_agent.agent.tools.base import ToolContext, ToolSuccess

    from _shared.lead_adapter import (
        LeadAdapter, register_lead_adapter, unregister_lead_adapter,
    )
    from _shared.lead_tools import LEAD_DOMAIN_KEY, OpenInspectionInput, OpenInspectionTool

    monkeypatch.setenv("SA_LEAD_MAX_SESSIONS", "1")
    ad = LeadAdapter(
        domain="cap_test", inspect_agent="smb_file_inspect",
        statuses=("pending",),
        claimable_statuses=("pending",), queue_label="q",
        list_targets=lambda **k: [], target_detail=lambda t: {},
        scan_summary=lambda t, **k: {"source": "none", "total": 0},
        run_verb=lambda a, **k: {"performed": False, "result": "unsupported"},
        delegate_input=lambda t, s: {"host": "10.0.0.1"},
        set_status=lambda t, s, **k: {})
    register_lead_adapter(ad)
    ctx = ToolContext(evidence_dir=tmp_path,
                      metadata={LEAD_DOMAIN_KEY: "cap_test",
                                "agents_dir": str(
                                    pathlib_parent() / "domains" / "smb" / "agents")})
    async def _go():
        # ⚠️ 한 루프 안에서 끝내야 한다 — `asyncio.run` 을 여러 번 부르면 첫 루프에서
        #    띄운 subprocess transport 가 닫힌 루프를 참조해 GC 때 터진다(테스트 잡음).
        first = await OpenInspectionTool().execute(
            OpenInspectionInput(target_id=1), ctx)
        second = await OpenInspectionTool().execute(
            OpenInspectionInput(target_id=2), ctx)
        await reg.close_all(tmp_path)
        return first, second

    try:
        first, second = _a.run(_go())
        assert isinstance(first, ToolSuccess) and _j.loads(first.content)["opened"]
        assert isinstance(second, ToolSuccess), "상한 도달이 ToolError 면 런이 halt 한다"
        body = _j.loads(second.content)
        assert body["opened"] is False
        assert body["open_sessions"] and "close_inspection" in body["next"]
    finally:
        unregister_lead_adapter(ad.domain)


def pathlib_parent():
    import pathlib
    return pathlib.Path(__file__).resolve().parents[2]


def test_cleanup_hook_must_be_async():
    """★ 계약 후처리 훅은 async `_run` 안에서 불린다 — 실행 중 루프가 항상 있다.

    sync 로 두면 `asyncio.run()` 을 못 써서 **정리를 조용히 건너뛴다**. 실기동에서
    세션 4개가 그대로 남았다. 코어가 awaitable 을 await 해 준다(v3.97).
    """
    import inspect as _i

    from _shared.lead_contract import build_lead_contract

    c = build_lead_contract(domain="smb", agents_dir=pathlib_parent() / "domains" / "smb" / "agents")
    assert _i.iscoroutinefunction(c.on_submit)
    assert _i.iscoroutinefunction(c.on_no_submit)


def test_sync_cleanup_helper_is_gone():
    """함정이었던 `close_all_sync` 를 지웠다 — 남겨두면 다시 쓰인다."""
    assert not hasattr(reg, "close_all_sync")
