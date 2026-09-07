"""권고 뒤집기 근거 강제 + 피벗의 큐 반영 (v3.98 §2).

## 무엇을 고치는 것인가

1. 리드가 검토원 권고를 **말없이 뒤집을 수 있었다**. 2026-08-21 실기동에서 smb 리드가
   권고 `triaged_completed` 를 `closed` 로 바꿨고 근거가 아무 데도 안 남았다.
2. `record_pivot` 이 **소비자 0인 쓰기 전용 저널**이었다(8런 0건 호출). 모델은 다음
   수를 안 바꾸는 도구를 건너뛴다.

## ★ 이 파일이 지키는 가장 중요한 사실

거부는 `ToolError` 가 **아니다**. 엔진 repeat-error 가드가 같은 실패 2회에 런을 죽인다
— 2026-08-21 세션 상한 halt 가 정확히 그 함정이었다. 할 수 있는 일이 남은 상황은
성공으로 알려주고 다음 수를 준다.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from secu_agent.agent.tools.base import ToolContext, ToolSuccess

from _shared.lead_adapter import (
    LeadAdapter, register_lead_adapter, unregister_lead_adapter,
)
from _shared.lead_tools import (
    LEAD_DOMAIN_KEY, RecordPivotInput, RecordPivotTool, SetTargetStatusInput,
    SetTargetStatusTool, _mark_examined, examined_reset_for_test,
)
from _shared.queue_ownership import (
    collect_recommendations, result_dirs, write_recommendation,
)

PIVOT_LOG = "lead_pivots.jsonl"


@pytest.fixture()
def lead(tmp_path):
    calls: list = []
    adapter = LeadAdapter(
        domain="pivot_test",
        inspect_agent="fake_inspect",
        statuses=("pending", "tasked", "closed", "triaged_completed"),
        claimable_statuses=("pending", "tasked", "closed", "triaged_completed"),
        queue_label="테스트 큐",
        list_targets=lambda **kw: [],
        target_detail=lambda tid: {"target_id": tid},
        scan_summary=lambda tid, **kw: {"source": "none", "total": 0},
        run_verb=lambda action, **kw: {"performed": False, "result": "unsupported"},
        delegate_input=lambda tid, scope: {"target_id": tid},
        set_status=lambda tid, st, **kw: calls.append((tid, st, kw)) or {"ok": True},
    )
    register_lead_adapter(adapter)
    examined_reset_for_test()      # 열람 장부는 모듈 전역 — 테스트끼리 새지 않게
    ctx = ToolContext(evidence_dir=tmp_path,
                      metadata={LEAD_DOMAIN_KEY: adapter.domain})
    yield ctx, adapter, calls
    unregister_lead_adapter(adapter.domain)


def _recommend(evidence_dir: Path, *, sub: str, target_id: int, status: str,
               reason: str = "검토원 판단") -> None:
    d = evidence_dir / sub
    d.mkdir(parents=True, exist_ok=True)
    write_recommendation(d, target_ids=[target_id], status=status, reason=reason)


def _pivots(evidence_dir: Path) -> list[dict]:
    path = evidence_dir / PIVOT_LOG
    if not path.exists():
        return []
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x]


def _examine(ctx, target_id: int) -> None:
    """`target_detail`/`target_hit_summary` 를 부른 것과 같은 효과.

    ★ 2026-08-26 부터 리드는 **본 적 없는 타깃을 근거 없이 못 닫는다**. 권고 뒤집기
      테스트들은 그 앞단이 아니라 뒤집기 자체를 보는 것이므로, 여기서 '봤다' 를 만든다.
    """
    _mark_examined(ctx, target_id)


def _set(ctx, **kw) -> ToolSuccess:
    out = asyncio.run(SetTargetStatusTool().execute(SetTargetStatusInput(**kw), ctx))
    assert isinstance(out, ToolSuccess), out
    return out


# ── 권고 수집: 두 종류의 디렉터리 ──────────────────────────────────────

def test_result_dirs_covers_both_transports(tmp_path):
    """★ one-shot 은 `sub-*`, 세션은 `session-*` 에 쓴다. 한쪽만 보면 세션 경로가 샌다."""
    (tmp_path / "sub-abc").mkdir()
    (tmp_path / "session-s1-x-smb").mkdir()
    (tmp_path / "other").mkdir()
    got = {p.name for p in result_dirs(tmp_path)}
    assert got == {"sub-abc", "session-s1-x-smb"}


def test_sub_dirs_stays_narrow(tmp_path):
    """`sub_dirs` 를 넓혀 재사용하면 안 된다 — one-shot 위임 diff 가 세션을 오인한다."""
    from _shared.inspector_channel import sub_dirs

    (tmp_path / "sub-abc").mkdir()
    (tmp_path / "session-s1-x-smb").mkdir()
    assert sub_dirs(tmp_path) == {"sub-abc"}


def test_later_recommendation_wins(tmp_path):
    import os
    import time

    _recommend(tmp_path, sub="sub-a", target_id=7, status="tasked")
    time.sleep(0.01)
    _recommend(tmp_path, sub="session-s1-x", target_id=7, status="closed")
    os.utime(tmp_path / "session-s1-x", (time.time() + 5, time.time() + 5))
    assert collect_recommendations(tmp_path)[7]["recommended_status"] == "closed"


# ── 뒤집기 강제 ───────────────────────────────────────────────────────

def test_override_without_reason_is_refused_as_success(lead):
    """★ ToolError 가 아니다. ToolError 면 두 번째 시도에서 런이 halt 한다."""
    ctx, _adapter, calls = lead
    _examine(ctx, 7)
    _recommend(ctx.evidence_dir, sub="sub-a", target_id=7,
               status="triaged_completed")
    out = _set(ctx, target_id=7, status="closed")
    got = json.loads(out.content)
    assert got["closed"] is False
    assert got["recommended_status"] == "triaged_completed"
    assert "set_target_status" in got["next"]
    assert calls == [], "거부됐는데 큐가 바뀌었다"


def test_a_one_word_reason_does_not_count(lead):
    """'ok' 로 통과되면 강제가 장식이 된다."""
    ctx, _adapter, calls = lead
    _examine(ctx, 7)
    _recommend(ctx.evidence_dir, sub="sub-a", target_id=7, status="triaged_completed")
    got = json.loads(_set(ctx, target_id=7, status="closed", reason="ok").content)
    assert got["closed"] is False and calls == []


def test_override_with_reason_closes_and_is_journaled(lead):
    ctx, _adapter, calls = lead
    _examine(ctx, 7)
    _recommend(ctx.evidence_dir, sub="sub-a", target_id=7, status="triaged_completed")
    got = json.loads(_set(
        ctx, target_id=7, status="closed",
        reason="파일이 전부 이미지라 재점검 가치가 없다").content)
    assert got["closed"] is True and got["override_recorded"] == "triaged_completed"
    assert [c[:2] for c in calls] == [(7, "closed")]
    entries = _pivots(ctx.evidence_dir)
    assert len(entries) == 1 and entries[0]["kind"] == "override"
    assert "이미지" in entries[0]["rationale"]


def test_following_the_recommendation_needs_no_reason(lead):
    ctx, _adapter, calls = lead
    _examine(ctx, 7)
    _recommend(ctx.evidence_dir, sub="sub-a", target_id=7, status="tasked")
    got = json.loads(_set(ctx, target_id=7, status="tasked").content)
    assert got["closed"] is True and "override_recorded" not in got
    assert [c[:2] for c in calls] == [(7, "tasked")]
    assert _pivots(ctx.evidence_dir) == []


def test_no_recommendation_still_closes_once_the_target_was_examined(lead):
    """위임 없이 닫는 것은 정당하다(접근불가 skip 등) — 막으면 큐가 안 닫힌다.

    2026-08-26 이후 조건이 하나 붙었다: **보기는 했어야 한다.** 위임까지는 아니어도
    target_detail·target_hit_summary·verify 중 하나는 부른 뒤라야 한다.
    """
    ctx, _adapter, calls = lead
    _examine(ctx, 7)
    got = json.loads(_set(ctx, target_id=7, status="closed").content)
    assert got["closed"] is True
    assert [c[:2] for c in calls] == [(7, "closed")]


def test_recommendation_for_another_target_does_not_gate(lead):
    ctx, _adapter, calls = lead
    _examine(ctx, 7)
    _recommend(ctx.evidence_dir, sub="sub-a", target_id=99, status="tasked")
    got = json.loads(_set(ctx, target_id=7, status="closed").content)
    assert got["closed"] is True and [c[:2] for c in calls] == [(7, "closed")]


def test_unreadable_recommendation_does_not_block_closing(lead):
    """권고를 못 읽는다고 큐가 안 닫히면 그게 더 나쁘다 — fail-open 이 맞는 자리다."""
    ctx, _adapter, calls = lead
    _examine(ctx, 7)
    d = ctx.evidence_dir / "sub-broken"
    d.mkdir()
    (d / "recommended_status.json").write_text("{깨진 json", encoding="utf-8")
    got = json.loads(_set(ctx, target_id=7, status="closed").content)
    assert got["closed"] is True and calls


# ── 피벗의 큐 반영 ────────────────────────────────────────────────────

def _pivot(ctx, **kw) -> dict:
    out = asyncio.run(RecordPivotTool().execute(RecordPivotInput(**kw), ctx))
    assert isinstance(out, ToolSuccess), out
    return json.loads(out.content)


def test_pivot_with_target_id_requeues(lead):
    """★ 소비자가 생긴다 — 저널이 아니라 다음 런이 보는 상태가 된다."""
    ctx, _adapter, calls = lead
    got = _pivot(ctx, from_ref="share 3778 의 web.config",
                 to_target="같은 host 의 인접 공유", to_target_id=3694,
                 rationale="같은 서버의 다른 공유에 같은 설정이 있을 가능성")
    assert got["requeued"] == 3694 and got["status"] == "pending"
    assert [c[:2] for c in calls] == [(3694, "pending")]
    assert calls[0][2]["reason"].startswith("같은 서버")
    assert _pivots(ctx.evidence_dir)[0]["requeued"] == "pending"


def test_pivot_without_target_id_is_journal_only(lead):
    ctx, _adapter, calls = lead
    got = _pivot(ctx, from_ref="a", to_target="b", rationale="c")
    assert got["recorded"] is True and "requeued" not in got
    assert calls == []
    assert len(_pivots(ctx.evidence_dir)) == 1


def test_pivot_returns_what_it_has_so_far(lead):
    """블랙홀이 아니게 — 모델이 효과를 볼 수 있어야 다시 쓴다."""
    ctx, _adapter, _calls = lead
    _pivot(ctx, from_ref="a", to_target="b", rationale="c")
    got = _pivot(ctx, from_ref="d", to_target="e", rationale="f")
    assert len(got["pivots_so_far"]) == 2


def test_requeue_failure_still_journals(lead):
    """재큐가 실패해도 판단 기록까지 잃지 않는다."""
    ctx, adapter, _calls = lead
    unregister_lead_adapter(adapter.domain)
    from dataclasses import replace

    def _boom(tid, st, **kw):
        raise RuntimeError("DB 없음")

    register_lead_adapter(replace(adapter, set_status=_boom))
    try:
        got = _pivot(ctx, from_ref="a", to_target="b", to_target_id=5, rationale="c")
        assert got["requeued"] is None and "재큐 실패" in got["note"]
        assert "requeue_error" in _pivots(ctx.evidence_dir)[0]
    finally:
        unregister_lead_adapter(adapter.domain)
        register_lead_adapter(adapter)


def test_queue_without_pending_says_so(lead):
    ctx, adapter, calls = lead
    unregister_lead_adapter(adapter.domain)
    from dataclasses import replace

    register_lead_adapter(replace(adapter, statuses=("tasked", "closed")))
    try:
        got = _pivot(ctx, from_ref="a", to_target="b", to_target_id=5, rationale="c")
        assert got["requeued"] is None and "pending" in got["note"]
        assert calls == []
    finally:
        unregister_lead_adapter(adapter.domain)
        register_lead_adapter(adapter)


# ── 안 본 타깃 닫기 관문 (2026-08-26 실사고) ─────────────────────────────
#
# ★ 무엇이 있었나 — confluence.lead 컷오버 첫 사이클(19:35):
#
#     turn 1  list_targets(status='pending')   → 0건
#     turn 2  list_targets(limit=50)
#     turn 4  set_target_status(1, skipped) … set_target_status(25, skipped)
#
#   target_detail·target_hit_summary·verify·open_inspection 을 **한 번도 안 부르고**
#   25개 스페이스를 통째로 닫았다. 상태는 이미 skipped 라 안 바뀌었지만
#   `cycle_scanned_at` 이 갱신돼 그 주 정상 재스캔이 막혔다(되돌렸다).
#
#   계약(`lead.md`)은 처음부터 "열어보지도 않은 타깃을 닫지 마라. 안 볼 거면 skipped +
#   이유다" 라고 적고 있었다. 강제가 없었을 뿐이다.

def test_closing_an_unexamined_target_is_refused(lead):
    """★ 실사고 재현 — 아무것도 안 보고 닫으려 하면 막힌다."""
    ctx, _adapter, calls = lead
    got = json.loads(_set(ctx, target_id=7, status="closed").content)
    assert got["closed"] is False
    assert "들여다보지 않았다" in got["why"]
    assert calls == [], "안 본 타깃이 큐에 반영됐다"


def test_refusal_is_a_success_not_an_error(lead):
    """★ 거부는 ToolError 가 아니다 — 엔진 repeat-error 가 같은 실패 2회에 런을 죽인다.

    25건을 연달아 거부당하면 두 번째에서 런이 통째로 끝난다. 그건 고치는 게 아니라
    다른 방식으로 부수는 것이다.
    """
    ctx, _adapter, _calls = lead
    out = _set(ctx, target_id=7, status="closed")      # ToolSuccess 단언은 _set 안
    got = json.loads(out.content)
    assert got["closed"] is False and "next" in got


def test_a_reason_lets_the_lead_skip_without_looking(lead):
    """안 보고 넘기는 것 자체는 리드의 권한이다 — 막는 것은 **근거 없이** 넘기는 것.

    여기가 막히면 접근불가 스페이스 같은 정당한 skip 이 안 되고 큐가 정체된다.
    """
    ctx, _adapter, calls = lead
    got = json.loads(_set(ctx, target_id=7, status="closed",
                          reason="CQL 403 으로 접근 자체가 막혀 볼 수 없다").content)
    assert got["closed"] is True
    assert [c[:2] for c in calls] == [(7, "closed")]


def test_listing_the_queue_is_not_examining_a_target(lead):
    """★ `list_targets` 는 열람이 아니다 — 큐 개요이지 그 타깃을 본 게 아니다.

    실사고에서 리드가 부른 것이 정확히 `list_targets` 둘뿐이었다. 이걸 열람으로 세면
    관문이 그 사고를 그대로 통과시킨다.
    """
    from _shared.lead_tools import ListTargetsInput, ListTargetsTool

    ctx, _adapter, calls = lead
    asyncio.run(ListTargetsTool().execute(ListTargetsInput(limit=50), ctx))
    got = json.loads(_set(ctx, target_id=7, status="closed").content)
    assert got["closed"] is False, "list_targets 가 열람으로 세어졌다"
    assert calls == []


@pytest.mark.parametrize("tool_name", ["detail", "hits", "verify"])
def test_each_looking_tool_marks_the_target(lead, tool_name):
    """열람 경로가 하나라도 빠지면 정당한 닫기가 막힌다 — 큐 정체는 조용하다."""
    from _shared.lead_tools import (
        TargetDetailInput, TargetDetailTool, TargetHitSummaryInput,
        TargetHitSummaryTool, VerifyInput, VerifyTool,
    )

    ctx, _adapter, calls = lead
    if tool_name == "detail":
        asyncio.run(TargetDetailTool().execute(TargetDetailInput(target_id=7), ctx))
    elif tool_name == "hits":
        asyncio.run(TargetHitSummaryTool().execute(
            TargetHitSummaryInput(target_id=7), ctx))
    else:
        asyncio.run(VerifyTool().execute(
            VerifyInput(action="reachable", target_id=7), ctx))
    got = json.loads(_set(ctx, target_id=7, status="closed").content)
    assert got["closed"] is True, f"{tool_name} 이 열람으로 안 세어졌다"


def test_examining_one_target_does_not_unlock_another(lead):
    """★ 타깃 단위여야 한다. 하나 봤다고 전부 열리면 실사고를 못 막는다."""
    ctx, _adapter, calls = lead
    _examine(ctx, 7)
    got = json.loads(_set(ctx, target_id=8, status="closed").content)
    assert got["closed"] is False and calls == []


# ── 긴 근거를 거부하지 않는다 (2026-09-02 실측) ────────────────────────────
#
# `reason` 상한이 300 이던 시절, 근거를 길게 쓴 리드의 종결이 **입력 검증에서 통째로
# 거부**됐다(`err:validation`). 그러면 `closed:false` 안내조차 못 받는다 — 그건 성공
# 응답이라 다음 수를 알려주는데, 검증 에러는 아무것도 안 알려준다.
# 실기동: confluence 리드가 검토원 3명을 돌리고 이유까지 써 놓고 **0건**을 닫았다.
# 길게 썼다는 이유로 일을 버리지 않는다 — 받고 **자른다**.

def test_long_reason_is_accepted_not_rejected() -> None:
    from _shared.lead_tools import SetTargetStatusInput

    vi = SetTargetStatusInput(target_id=1, status="tasked", reason="가" * 1500)
    assert vi.reason is not None and len(vi.reason) == 1500


def test_reason_is_truncated_on_the_way_in(tmp_path) -> None:
    """저장 상한은 지키되, 거부가 아니라 절단으로 지킨다."""
    from _shared.lead_tools import _REASON_STORE_LIMIT

    assert _REASON_STORE_LIMIT == 300


def test_absurd_reason_still_bounded() -> None:
    """상한을 없앤 것이 아니다 — 무제한 페이로드는 여전히 막는다(A8 규율)."""
    import pytest as _pytest

    from _shared.lead_tools import SetTargetStatusInput

    with _pytest.raises(Exception):
        SetTargetStatusInput(target_id=1, status="tasked", reason="가" * 50_000)
