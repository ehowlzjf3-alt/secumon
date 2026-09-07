"""`SessionChannel` — 리드 쪽 세션 배관 (Phase 4a).

가짜 serve 프로세스(프로토콜만 흉내)로 채널 로직을 검증한다 — LLM 없이 돈다.
여기서 막는 것은 **조용한 실패**다: 세션이 죽었는데 리드가 성공으로 읽으면
"깨끗한 타깃" 이 되어 큐가 닫힌다.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import textwrap

import pytest

from _shared.inspector_channel import InspectorAnswer, SessionChannel

_SPEC = {"task_id": "t", "task_type": "smb_file_inspect", "charter_ref": "C",
         "target": {"host": "10.0.0.1"}}


def _fake_server(tmp_path, body: str) -> str:
    """serve 프로토콜을 흉내내는 최소 스크립트 경로."""
    p = tmp_path / "fake_serve.py"
    p.write_text(textwrap.dedent(body), encoding="utf-8")
    return str(p)


def _channel(tmp_path, script: str, monkeypatch) -> SessionChannel:
    ch = SessionChannel(agent="smb_file_inspect", domain="smb", target_id=1,
                        evidence_dir=tmp_path / "ev", spec=_SPEC)
    real = asyncio.create_subprocess_exec

    async def _fake_exec(*argv, **kw):
        return await real(sys.executable, script, **kw)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_exec)
    return ch


ECHO_SERVER = '''
    import json, sys
    def emit(o): sys.stdout.write(json.dumps(o, ensure_ascii=False) + "\\n"); sys.stdout.flush()
    emit({"ok": True, "ready": True, "task_id": "t", "task_type": "smb_file_inspect"})
    n = 0
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        req = json.loads(line)
        if req.get("close"):
            emit({"ok": True, "closed": True, "asks": n}); break
        n += 1
        emit({"ok": True, "turn": n, "text": f"답{n}: {req['ask']}",
              "reason": "end_turn", "turns_used": 2, "turns_total": 2 * n,
              "tokens_in": 7800, "saw_submit": False, "findings_count": 0,
              "candidates_seen": 6, "candidates_accounted": 1})
'''


def test_ask_returns_an_answer_object_not_a_file(tmp_path, monkeypatch):
    """★ 답이 **반환값**이다 — 파일시스템을 안 탄다. 그래서 나중에 transport 만 갈아끼운다."""
    ch = _channel(tmp_path, _fake_server(tmp_path, ECHO_SERVER), monkeypatch)

    async def _go():
        await ch.start()
        a = await ch.ask("파일 목록 훑어봐")
        await ch.close()
        return a

    a = asyncio.run(_go())
    assert isinstance(a, InspectorAnswer)
    assert a.source == "session" and a.status == "ok"
    assert "파일 목록 훑어봐" in a.summary
    assert a.turns == 2 and a.tokens["in"] == 7800


def test_silence_ledger_travels_on_every_answer(tmp_path, monkeypatch):
    """카운터 자체는 매 답에 실린다 — 리드가 직접 볼 수 있어야 한다."""
    ch = _channel(tmp_path, _fake_server(tmp_path, ECHO_SERVER), monkeypatch)

    async def _go():
        await ch.start()
        a = await ch.ask("q")
        await ch.close()
        return a

    a = asyncio.run(_go())
    assert a.candidates_seen == 6 and a.candidates_accounted == 1


def test_partial_accounting_note_is_not_attached_to_session_answers(tmp_path, monkeypatch):
    """★ 세션 중간 답에 `accounted < seen` 노트를 붙이면 리드가 유령을 쫓는다.

    카운터는 후보 identity 가 없는 cumulative 정수다(엔진 `candidate_ledger.py:128` 이
    정확-대조를 명시적으로 포기한 이유). 세션은 ask 마다 그게 계속 자라고, `seen` 은 ask
    끝에서 오르고 `accounted` 는 다음 ask 에서 올라 **한 박자 지연**이 생긴다.

    2026-08-26 실측(smb 리드, 세션 s2) — 이 노트가 붙어 있었을 때:

        ask#1  seen=19 acc=19          정상
        ask#2  seen=20 acc=19   note   → 리드가 "미해명 1건" 추궁 (turn 5)
        ask#3  seen=21 acc=20   note   → 또 추궁 (turn 6)
        ask#4  seen=21 acc=34          재스캔 이중집계로 acc 가 seen 추월, note 소멸

    미해명 후보는 없었다. 8턴 중 2턴을 버렸다.
    """
    ch = _channel(tmp_path, _fake_server(tmp_path, ECHO_SERVER), monkeypatch)

    async def _go():
        await ch.start()
        return await ch.ask("q")

    a = asyncio.run(_go())
    assert "silence_note" not in a.notes, (
        "세션 중간 답에 부분해명 노트가 붙었다 — 정상 세션이 매번 1건 모자라 보인다")


def test_binary_silence_warning_still_reaches_the_lead_in_a_session(tmp_path, monkeypatch):
    """★ 이진 신호는 남긴다 — 이중집계·단위불일치에 면역이라 세션에서도 참이다.

    "봤는데 해명이 0건" 은 뺄셈이 아니라 존재 판정이므로 카운터 드리프트와 무관하다.
    노트 하나를 걷어내면서 이것까지 같이 사라지면, 침묵한 검토원이 조용히 통과한다.
    """
    silent = ECHO_SERVER.replace('"candidates_accounted": 1', '"candidates_accounted": 0')
    ch = _channel(tmp_path, _fake_server(tmp_path, silent), monkeypatch)

    async def _go():
        await ch.start()
        return await ch.ask("q")

    a = asyncio.run(_go())
    assert a.candidates_seen == 6 and a.candidates_accounted == 0
    assert "silence_warning" in a.notes


def test_max_turns_is_marked_continuable(tmp_path, monkeypatch):
    """★ 세션에서는 캡이 제약이 아니라 체크포인트다 — 단발에서는 잘린 워커를 그냥 잃는다."""
    server = ECHO_SERVER.replace('"reason": "end_turn"', '"reason": "max_turns"')
    ch = _channel(tmp_path, _fake_server(tmp_path, server), monkeypatch)

    async def _go():
        await ch.start()
        a = await ch.ask("q")
        await ch.close()
        return a

    a = asyncio.run(_go())
    assert a.completion_reason == "max_turns"
    assert "continuable" in a.notes and "계속해" in a.notes["continuable"]


def test_dead_session_fails_closed(tmp_path, monkeypatch):
    """★ 검토원이 답 없이 죽으면 **실패**다. 성공으로 읽히면 큐가 조용히 닫힌다."""
    server = '''
    import json, sys
    sys.stdout.write(json.dumps({"ok": True, "ready": True}) + "\\n"); sys.stdout.flush()
    sys.exit(1)
    '''
    ch = _channel(tmp_path, _fake_server(tmp_path, server), monkeypatch)

    async def _go():
        await ch.start()
        try:
            return await ch.ask("q")
        finally:
            await ch.close()

    a = asyncio.run(_go())
    assert a.status == "error_crash"
    assert "session_error" in a.notes


def test_worker_refusal_is_not_success(tmp_path, monkeypatch):
    """세션 예산 초과 등 워커의 거부(ok=false)도 실패로 읽혀야 한다."""
    server = '''
    import json, sys
    def emit(o): sys.stdout.write(json.dumps(o) + "\\n"); sys.stdout.flush()
    emit({"ok": True, "ready": True})
    for line in sys.stdin:
        if line.strip():
            emit({"ok": False, "error": "세션 질문 상한 초과", "limit": "asks"})
    '''
    ch = _channel(tmp_path, _fake_server(tmp_path, server), monkeypatch)

    async def _go():
        await ch.start()
        try:
            return await ch.ask("q")
        finally:
            await ch.close()

    a = asyncio.run(_go())
    assert a.status == "error_crash" and "상한" in a.summary


def test_ask_after_close_is_refused(tmp_path, monkeypatch):
    ch = _channel(tmp_path, _fake_server(tmp_path, ECHO_SERVER), monkeypatch)

    async def _go():
        await ch.start()
        await ch.close()
        return await ch.ask("q")

    a = asyncio.run(_go())
    assert a.status == "error_crash" and "종료" in a.summary


def test_close_is_idempotent(tmp_path, monkeypatch):
    """고아 프로세스를 남기지 않는 책임이 채널에 있다 — close 는 몇 번 불러도 안전."""
    ch = _channel(tmp_path, _fake_server(tmp_path, ECHO_SERVER), monkeypatch)

    async def _go():
        await ch.start()
        first = await ch.close()
        second = await ch.close()
        return first, second

    first, second = asyncio.run(_go())
    assert second is None                      # 두 번째는 no-op
    assert first is None or first.source in ("worker_result", "text-fallback")


def test_start_failure_is_loud(tmp_path, monkeypatch):
    """ready 를 못 받으면 **조용히 진행하면 안 된다** — 리드가 빈손을 성공으로 읽는다."""
    server = "import sys; sys.exit(3)"
    ch = _channel(tmp_path, _fake_server(tmp_path, server), monkeypatch)
    with pytest.raises(RuntimeError, match="기동 실패"):
        asyncio.run(ch.start())


def test_depth_is_incremented_for_the_child(tmp_path, monkeypatch):
    """큐 소유권 규칙(`SA_AGENT_DEPTH>=1` = 위임된 검토원)이 세션에서도 서야 한다."""
    seen: dict = {}
    real = asyncio.create_subprocess_exec

    async def _fake_exec(*argv, **kw):
        seen["env"] = kw.get("env") or {}
        return await real(sys.executable,
                          _fake_server(tmp_path, ECHO_SERVER), **kw)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_exec)
    monkeypatch.delenv("SA_AGENT_DEPTH", raising=False)
    ch = SessionChannel(agent="a", domain="smb", target_id=1,
                        evidence_dir=tmp_path / "ev2", spec=_SPEC)

    async def _go():
        await ch.start()
        await ch.close()

    asyncio.run(_go())
    assert seen["env"]["SA_AGENT_DEPTH"] == "1"
