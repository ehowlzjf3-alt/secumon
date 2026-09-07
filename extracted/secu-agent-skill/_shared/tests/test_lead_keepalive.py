"""검토원이 일하는 동안 리드가 idle 로 죽지 않는다 (2026-08-26).

## 무엇이 있었나

confluence 리드가 **3연속** 같은 자리에서 죽었다:

    --- turn 8 ---
    [tool→] ask_inspector(session_id='s1-fcb788', question='이 space 에 접근 …')
    [tool→] ask_inspector(session_id='s2-9c218a', question='이 space 에 접근 …')
    [loop error] harness idle timeout: no observable activity for 300.3s
    [agent] done — reason=aborted turns=8

검토원은 멀쩡히 일하고 있었다. 브라우저 SSO 로그인 + 검색 + 결과 페이지 방문은
5분을 쉽게 넘긴다. **죽은 건 리드다.**

## 왜 구조적이었나

    ask() 타임아웃      1800s
    부모 idle 워치독     300s      ← 6배 역전

ask 가 기다리는 동안 부모 하네스에 이벤트가 하나도 안 올라갔다. 그래서 300s 를 넘는
답은 **원리적으로 하나도 받을 수 없었다** — 1800s 는 도달 불가능한 숫자였다.

단발 위임에는 이 방어가 이미 있었다(`agent_tool._watch_subagent`).
세션 경로만 배선이 없었다. 함수는 있는데 부르는 곳이 없던 종류다.

## 이 파일이 고정하는 것

1. 자식이 **움직이면** 진척을 보고한다 (그래야 리드가 산다)
2. 자식이 **멎으면** 침묵한다 (그래야 워치독이 제 일을 한다 — 하트비트가 아니다)
3. 그 역전이 여전히 존재한다 (그래서 keepalive 가 선택이 아니라 필수다)
"""
from __future__ import annotations

import asyncio

import pytest

from _shared.inspector_channel import keep_parent_alive


class _Ctx:
    """`report_progress` 만 있는 최소 ToolContext 대역."""

    def __init__(self) -> None:
        self.events: list[str] = []

    def report_progress(self, event: str) -> None:
        self.events.append(event)


@pytest.fixture
def fast_interval(monkeypatch):
    """폴링 간격을 줄여 테스트를 초 단위로 끝낸다."""
    monkeypatch.setattr("_shared.inspector_channel._keepalive_interval", lambda: 0.05)


async def _run_with_child(tmp_path, ctx, *, writes: int, hold: float) -> None:
    sub = tmp_path / "session-s1"
    sub.mkdir()
    (sub / "audit.log.jsonl").write_text("start\n", encoding="utf-8")

    async with keep_parent_alive(sub, ctx, label="test"):
        for i in range(writes):
            await asyncio.sleep(hold)
            # 검토원이 감사로그를 쓰는 것 = 살아 있다는 증거
            with (sub / "audit.log.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(f"tick {i}\n")
        await asyncio.sleep(hold)


def test_progress_is_reported_while_the_inspector_works(tmp_path, fast_interval):
    """자식이 쓰고 있으면 부모에게 살아 있다고 알린다."""
    ctx = _Ctx()
    asyncio.run(_run_with_child(tmp_path, ctx, writes=3, hold=0.15))
    assert ctx.events, "자식이 일하는 동안 진척 보고가 하나도 없었다 — 리드가 죽는다"
    assert set(ctx.events) == {"inspector_progress"}


def test_silence_when_the_inspector_is_dead(tmp_path, fast_interval):
    """★ 하트비트가 아니다 — 자식이 멎으면 **침묵해야** 워치독이 제 일을 한다.

    무조건 핑을 보내면 죽은 검토원을 붙잡고 리드가 1800s 를 버린다.
    """
    ctx = _Ctx()
    sub = tmp_path / "session-dead"
    sub.mkdir()
    (sub / "audit.log.jsonl").write_text("start\n", encoding="utf-8")

    async def _quiet():
        async with keep_parent_alive(sub, ctx, label="dead"):
            await asyncio.sleep(0.6)      # 폴링 12회분 — 아무것도 안 바뀐다

    asyncio.run(_quiet())
    assert ctx.events == [], f"죽은 자식에게 생존신호를 보냈다: {ctx.events}"


def test_a_ctx_without_progress_hook_is_harmless(tmp_path, fast_interval):
    """`report_progress` 가 없는 컨텍스트(테스트 더블)에서도 죽지 않는다."""

    async def _run():
        async with keep_parent_alive(tmp_path, object(), label="nohook"):
            await asyncio.sleep(0.1)

    asyncio.run(_run())      # 예외 없이 끝나면 통과


def test_the_watcher_stops_when_the_block_ends(tmp_path, fast_interval):
    """블록을 나가면 감시 태스크가 남지 않는다 — 고아 태스크는 다음 ask 를 오염시킨다."""

    async def _run():
        before = len(asyncio.all_tasks())
        async with keep_parent_alive(tmp_path, _Ctx(), label="leak"):
            await asyncio.sleep(0.1)
        await asyncio.sleep(0.1)
        return before, len(asyncio.all_tasks())

    before, after = asyncio.run(_run())
    assert after <= before, f"감시 태스크가 남았다 ({before} → {after})"


def test_the_inversion_that_makes_this_mandatory():
    """★ 전제 검증 — ask 타임아웃이 부모 idle 예산보다 **크다**.

    이 역전이 사라지면(ask 타임아웃이 idle 예산보다 작아지면) keepalive 는 보험이
    되지만, 지금은 없으면 **반드시** 죽는다. 숫자가 바뀌면 이 주석도 바뀌어야 한다.
    """
    import inspect

    from _shared import lead_contract
    from _shared.inspector_channel import _ask_timeout

    ask = _ask_timeout()
    # 리드 idle 예산은 하드코딩하지 않고 **실제 기본값**을 읽는다 — 숫자가 바뀌면
    # 테스트가 거짓말을 하는 게 아니라 새 사실을 말해야 한다.
    idle = inspect.signature(lead_contract.build_lead_contract).parameters[
        "default_idle_sec"].default

    assert idle == 300, f"리드 idle 기본값이 {idle}s 로 바뀌었다 — 실측 죽음은 300.3s 였다"
    assert ask > idle, (
        f"ask 타임아웃({ask}s) 이 부모 idle 예산({idle}s) 보다 크다 — 이 역전이 있는 한 "
        f"keepalive 없이는 {idle}s 를 넘는 답을 하나도 받을 수 없다")


def test_ask_inspector_wraps_the_call_in_the_keepalive():
    """배선 확인 — 함수가 있어도 **부르는 곳이 없으면** 아무 일도 안 일어난다.

    이 사고 자체가 그 종류였다(`_watch_subagent` 는 있었는데 세션 경로가 안 썼다).
    """
    import inspect

    from _shared.lead_tools import AskInspectorTool

    src = inspect.getsource(AskInspectorTool._run)
    assert "keep_parent_alive" in src, "ask_inspector 가 keepalive 를 안 쓴다"
    assert src.index("keep_parent_alive") < src.index("await ch.ask("), (
        "keepalive 가 ask 를 감싸지 않는다")
