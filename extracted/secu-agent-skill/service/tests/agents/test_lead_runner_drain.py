"""리드가 차례 한 번에 **큐가 빌 때까지** 도는지 — 그리고 언제 멈추는지.

## 왜

리드는 40턴 예산 중 7턴만 쓰고 1건만 닫고 끝냈다(2026-08-31 실측, 5회 연속 전부
`end_turn`). 차례는 15분에 한 번이라 가동률이 5% 였다 — 큐 1,706건에 하루 82건,
소진 3주.

계약 프롬프트는 **이미** "닫았으면 다음 타깃으로 간다. 큐가 비거나 턴이 다할 때까지
반복하라"고 지시하고 2026-08-27 의 같은 사고까지 인용한다. 그래도 안 지켜진다.
⇒ 부탁 대신 러너가 다시 부른다.

여기서 고정하는 건 **멈추는 조건**이다. 안 멈추면 한 도메인이 차례를 독점하고
나머지가 굶는다.
"""
from __future__ import annotations

import pytest

from service.agents import lead_pipeline_runner as R


@pytest.fixture
def fake(monkeypatch):
    """패스 결과와 큐 깊이를 대본대로 돌려준다."""
    def _install(pass_results, depths):
        calls = {"n": 0}

        def _pass(domain, **_kw):
            i = min(calls["n"], len(pass_results) - 1)
            calls["n"] += 1
            return dict(pass_results[i])

        seq = list(depths)

        def _depth(_domain):
            return seq.pop(0) if seq else (seq[-1] if seq else 0)

        monkeypatch.setattr(R, "run_lead_pass", _pass)
        monkeypatch.setattr(R, "_claimable_depth", _depth)
        return calls
    return _install


def test_keeps_going_while_the_queue_shrinks(fake) -> None:
    """★ 이게 이 변경의 전부다 — 한 차례에 여러 건."""
    calls = fake([{"status": "ok"}], [10, 8, 6, 4, 2, 0, 0, 0, 0, 0])
    out = R._run_until_drained("smb", "smb.lead")
    assert calls["n"] > 1, "한 번만 돌면 예전과 같다"
    assert out["pass_count"] == calls["n"]


def test_stops_when_queue_is_empty(fake) -> None:
    calls = fake([{"status": "ok"}, {"status": "idle"}], [5, 3, 0])
    R._run_until_drained("smb", "smb.lead")
    assert calls["n"] == 2, "idle 이면 더 부르지 않는다"


def test_stops_when_nothing_was_closed(fake) -> None:
    """★ 헛돌지 않는다. 큐가 안 줄었으면 다시 불러도 같은 결과다."""
    calls = fake([{"status": "ok"}], [7, 7, 7, 7])
    R._run_until_drained("smb", "smb.lead")
    assert calls["n"] == 1


def test_stops_on_error(fake) -> None:
    """같은 실패를 8번 반복하지 않는다."""
    calls = fake([{"status": "error", "summary": "boom"}], [9, 9])
    R._run_until_drained("smb", "smb.lead")
    assert calls["n"] == 1


def test_stops_when_depth_is_unknown(fake) -> None:
    """★ -1(못 셌다)을 0(비었다)과 뭉치지 않는다.

    조회가 깨진 채로 반복하면 무한히 돈다 — 진척을 판정할 수 없으면 멈춘다.
    """
    calls = fake([{"status": "ok"}], [4, -1, -1])
    R._run_until_drained("smb", "smb.lead")
    assert calls["n"] == 1


def test_respects_the_pass_cap(monkeypatch, fake) -> None:
    """★ 상한이 없으면 큐가 깊은 도메인이 차례를 독점한다(smb 1,706건)."""
    monkeypatch.setenv(R.MAX_PASSES_ENV, "3")
    calls = fake([{"status": "ok"}], list(range(100, 0, -1)))
    out = R._run_until_drained("smb", "smb.lead")
    assert calls["n"] == 3 and out["pass_count"] == 3


def test_respects_the_wall_clock(monkeypatch, fake) -> None:
    """벽시계 상한도 독점을 막는다 — 패스가 느려도 차례는 끝난다."""
    monkeypatch.setenv(R.TURN_WALL_ENV, "1")
    ticks = iter([0.0, 5.0, 5.0, 5.0, 5.0])
    monkeypatch.setattr(R.time, "monotonic", lambda: next(ticks, 5.0))
    calls = fake([{"status": "ok"}], [10, 8, 6])
    R._run_until_drained("smb", "smb.lead")
    assert calls["n"] == 1


def test_returns_the_last_pass_plus_a_trace(fake) -> None:
    """호출부(run_once)가 예전과 같은 모양을 받아야 한다 — 추적만 덧붙인다."""
    fake([{"status": "ok", "turns": 7}], [6, 4, 2, 0])
    out = R._run_until_drained("smb", "smb.lead")
    assert out["status"] == "ok" and out["turns"] == 7
    assert isinstance(out["passes"], list) and out["passes"]
