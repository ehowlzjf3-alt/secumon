"""은퇴한 SMB 평면 러너 — 큐를 건드리지 않으면서 살아 있다고 말하는지.

이 루프는 `run_task_pass` 를 반복 호출하던 러너였다(2026-08-28 은퇴). 지금 남긴
이유는 두 가지뿐이고, 테스트도 그 둘만 고정한다:

  ① k8s 진입점(`domains/smb/runners/task.py` → `main`)이 살아 있어야 한다.
  ② 폴링마다 heartbeat 를 `phase="disabled"` 로 갱신해야 한다 — 조용히 멈추면
     콘솔에서 러너가 죽은 것으로 보이고, `phase="retired"` 를 쓰면 콘솔의
     denylist 판정(`activity_of_phase`)이 이걸 `active` 로 읽어 유령 카드가 된다.

★ 그리고 **아무것도 claim 하지 않는다**는 것이 이 파일의 핵심 단언이다.
"""
from __future__ import annotations

import asyncio
from typing import Any

from domains.smb.application.contracts import COMPONENT_TASK
from service import state_domain as state
from service.agents import smb_task_loop


def _capture_heartbeats(monkeypatch) -> list[dict[str, Any]]:
    beats: list[dict[str, Any]] = []
    monkeypatch.setattr(
        state,
        "heartbeat_upsert",
        lambda component, **kwargs: beats.append({"component": component, **kwargs}),
    )
    return beats


def test_task_loop_reports_retirement_without_claiming(monkeypatch) -> None:
    beats = _capture_heartbeats(monkeypatch)

    # 큐를 건드리면 즉시 터진다 — 은퇴 러너가 share 를 집어가면 리드와 싸운다.
    def _forbidden(*_a, **_kw):
        raise AssertionError("은퇴한 러너가 큐를 claim 했다")

    monkeypatch.setattr(state, "smb_task_claim_next", _forbidden)
    monkeypatch.setattr(state, "share_set_status", _forbidden)
    monkeypatch.setattr(state, "pipeline_run_start", _forbidden)

    result = asyncio.run(
        smb_task_loop.run_task_loop(once=True, max_hosts=3, charter_ref="SECOPS-TEST"),
    )

    assert result["errors"] == 0
    assert result["last"]["status"] == "retired"
    assert result["last"]["lead_component"] == "smb.lead"

    assert len(beats) == 1
    assert beats[0]["component"] == COMPONENT_TASK
    # ⚠️ `retired` 가 아니라 `disabled` — 콘솔 phase 판정이 denylist 라서다.
    assert beats[0]["phase"] == "disabled"
    assert "리드" in beats[0]["detail"] or "smb.lead" in beats[0]["detail"]


def test_task_loop_does_not_read_the_control_flag(monkeypatch) -> None:
    """`control_flag_get` 은 행이 없으면 enabled=1 로 **만들어** 돌려준다.

    은퇴 가드가 그걸 부르면 지운 레인을 되살리는 부작용이 난다.
    """
    _capture_heartbeats(monkeypatch)

    def _forbidden(*_a, **_kw):
        raise AssertionError("은퇴 가드가 control_flag 를 읽어 레인을 되살렸다")

    monkeypatch.setattr(state, "control_flag_get", _forbidden)
    monkeypatch.setattr(state, "control_flag_consume_run_now", _forbidden)

    result = asyncio.run(smb_task_loop.run_task_loop(once=True))
    assert result["errors"] == 0


def test_task_loop_keeps_beating_across_ticks(monkeypatch) -> None:
    """한 번 찍고 마는 게 아니라 폴링마다 갱신해야 age 가 안 늙는다."""
    beats = _capture_heartbeats(monkeypatch)

    result = asyncio.run(smb_task_loop.run_task_loop(poll_sec=0.001, max_loops=3))

    assert result["loops"] == 3
    assert len(beats) == 3
    assert {b["phase"] for b in beats} == {"disabled"}


def test_k8s_entrypoint_is_still_callable() -> None:
    import domains.smb.runners.task as runner

    assert callable(runner.main)
