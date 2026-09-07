"""검토원→리드 봉투 — 두 채널 모두 (Phase 2b).

코어 `AgentTool` 은 자식 결과를 부모에게 **두 채널**로 준다:
  1. `worker_result.json` 의 summary (≤500자, fail-closed 유일 판정 채널)
  2. `agent_result.json` 의 raw payload 전체 (fail-open 보조 채널)

리드 경계에서는 2번을 **마스킹하는 게 아니라 버린다** — 본문이 리드로 새는 가장 넓은
통로가 그 덤프다. 여기 테스트가 그 사실을 고정한다.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess

from _shared.lead_adapter import (
    LeadAdapter, register_lead_adapter, unregister_lead_adapter,
)
from _shared.inspector_channel import strip_raw_payload
from _shared.lead_tools import (
    LEAD_DOMAIN_KEY, DelegateInspectInput, DelegateInspectTool,
)

# 검토원이 본 것 — 리드에게 절대 가면 안 되는 것들.
FILE_BODY = "def deploy():\n    conn = psycopg2.connect(password='Sup3rSecret!23')"
PAT = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"


def _adapter(spawned: list) -> LeadAdapter:
    return LeadAdapter(
        domain="lead_delegate_test",
        inspect_agent="fake_inspect",
        statuses=("pending", "tasked", "skipped"),
        claimable_statuses=("pending", "tasked", "skipped"),
        queue_label="테스트 큐",
        list_targets=lambda **kw: [],
        target_detail=lambda tid: {"target_id": tid},
        scan_summary=lambda tid, **kw: {"source": "none", "total": 0},
        run_verb=lambda action, **kw: {"performed": False, "result": "unsupported"},
        delegate_input=lambda tid, scope: spawned.append((tid, scope)) or {
            "target_id": tid, "kind": "sso_url"},
        set_status=lambda tid, st, **kw: {"ok": True},
    )


@pytest.fixture()
def wired(tmp_path, monkeypatch):
    spawned: list = []
    ad = _adapter(spawned)
    register_lead_adapter(ad)
    ctx = ToolContext(evidence_dir=tmp_path, metadata={LEAD_DOMAIN_KEY: ad.domain})

    state: dict = {}

    def _fake_agent_execute(sub_dir_name="sub-20260821T000000-abc123-fake",
                            worker_result=None, raw_payload=None,
                            recommendation=None, error=None):
        """코어 AgentTool 을 대신한다 — 실제 파일 배치를 그대로 흉내낸다."""
        async def _run(self, vi, c):
            d = tmp_path / sub_dir_name
            d.mkdir(parents=True, exist_ok=True)
            if worker_result is not None:
                (d / "worker_result.json").write_text(
                    json.dumps(worker_result), encoding="utf-8")
            if recommendation is not None:
                (d / "recommended_status.json").write_text(
                    json.dumps(recommendation), encoding="utf-8")
            if error is not None:
                return ToolError(kind="execution", message=error)
            summary = (worker_result or {}).get("summary", "")
            body = f"[fake_inspect result] (turns=3)\nsummary: {summary}"
            if raw_payload is not None:
                body += f"\nraw: {json.dumps(raw_payload, ensure_ascii=False)}"
            return ToolSuccess(content=body)

        from secu_agent.agent.tools.agent_tool import AgentTool
        monkeypatch.setattr(AgentTool, "execute", _run, raising=True)
        return _run

    state["arm"] = _fake_agent_execute
    yield ctx, ad, spawned, state
    unregister_lead_adapter(ad.domain)


def _ok_worker_result(summary: str, **over) -> dict:
    base = {"rc": 0, "status": "ok", "summary": summary, "findings_count": 1,
            "turns_used": 7, "tokens_in": 1000, "tokens_out": 50,
            "candidates_seen": 3, "candidates_accounted": 3,
            "completion_reason": "end_turn", "metrics_version": 1,
            "evidence_paths": []}
    base.update(over)
    return base


def _call(ctx, **kw) -> ToolSuccess | ToolError:
    return asyncio.run(DelegateInspectTool().execute(
        DelegateInspectInput(target_id=42, **kw), ctx))


def test_raw_payload_channel_is_dropped_not_masked(wired):
    """★ agent_result.json 의 raw 덤프가 봉투에 들어오면 안 된다."""
    ctx, _ad, _sp, st = wired
    st["arm"](
        worker_result=_ok_worker_result("공유 1개 점검, finding 1건"),
        raw_payload={"file_body": FILE_BODY, "token": PAT},
    )
    res = _call(ctx)
    assert isinstance(res, ToolSuccess)
    assert FILE_BODY.splitlines()[0] not in res.content
    assert PAT not in res.content
    assert "psycopg2" not in res.content
    assert "raw" not in json.loads(res.content)


def test_envelope_is_a_closed_field_set(wired):
    ctx, _ad, _sp, st = wired
    st["arm"](worker_result=_ok_worker_result("깨끗함"))
    res = _call(ctx)
    env = json.loads(res.content)
    assert env["source"] == "worker_result"
    assert env["agent"] == "fake_inspect"
    assert env["status"] == "ok"
    assert env["findings_count"] == 1
    assert env["turns"] == 7
    assert env["completion_reason"] == "end_turn"
    unexpected = set(env) - {
        "agent", "domain", "target_id", "source", "status", "findings_count",
        "turns", "tokens", "candidates_seen", "candidates_accounted",
        "completion_reason", "summary", "silence_warning", "silence_note",
        "recommended_status", "report", "report_missing",
        "recommendation", "worker_result_invalid",
        # v3.99 — 답이 **어디서 왔는가**. 값이 아니라 메타라 경계에 안전하고,
        # 없을 때 "빈 문자열" 과 "답이 없음" 을 리드가 구분하게 해 준다.
        "answer_source",
    }
    assert not unexpected, f"봉투에 규격 밖 필드가 생겼다: {sorted(unexpected)}"
    assert env["answer_source"] in {"report", "text", "none"}


def test_inspector_summary_is_masked(wired):
    """검토원이 **일부러** 요약에 크리덴셜을 넣어도 리드는 못 본다."""
    ctx, _ad, _sp, st = wired
    st["arm"](worker_result=_ok_worker_result(f"발견: PAT {PAT} 노출, RRN 900101-1234568"))
    res = _call(ctx)
    assert PAT not in res.content
    assert "900101-1234568" not in res.content
    # 그래도 "무언가 발견됐다" 는 남아야 판단이 가능하다
    assert "발견" in res.content


def test_summary_is_hard_capped(wired):
    ctx, _ad, _sp, st = wired
    long_summary = "가" * 500
    st["arm"](worker_result=_ok_worker_result(long_summary))
    res = _call(ctx)
    from _shared.inspector_channel import MAX_SUMMARY
    assert len(json.loads(res.content)["summary"]) <= MAX_SUMMARY


def test_silence_ledger_is_surfaced(wired):
    """v3.90 침묵 게이트 — 후보를 봤는데 해명 0이면 리드가 clean 으로 읽으면 안 된다."""
    ctx, _ad, _sp, st = wired
    st["arm"](worker_result=_ok_worker_result(
        "특이사항 없음", candidates_seen=9, candidates_accounted=0, findings_count=0))
    env = json.loads(_call(ctx).content)
    assert env["candidates_seen"] == 9
    assert env["candidates_accounted"] == 0
    assert "silence_warning" in env


def test_partial_accounting_is_surfaced_as_a_note(wired):
    """★ 2026-08-21 실기동: github 검토원이 seen=6 accounted=1 로 끝났다.

    코어 기준으로는 침묵(accounted==0)이 아니지만 '깨끗함' 도 아니다. 코어 정의를 다시
    쓰지 않고(두 개의 진실 금지) 리드에게 판단 재료로만 준다.
    """
    ctx, _ad, _sp, st = wired
    st["arm"](worker_result=_ok_worker_result(
        "특이사항 없음", candidates_seen=6, candidates_accounted=1, findings_count=0))
    env = json.loads(_call(ctx).content)
    assert "silence_warning" not in env, "코어 침묵 정의를 넓히면 안 된다"
    assert "6" in env["silence_note"] and "1" in env["silence_note"]


def test_fully_accounted_run_has_no_silence_marker(wired):
    ctx, _ad, _sp, st = wired
    st["arm"](worker_result=_ok_worker_result(
        "3건 확인", candidates_seen=3, candidates_accounted=3))
    env = json.loads(_call(ctx).content)
    assert "silence_warning" not in env and "silence_note" not in env


def test_recommendation_from_delegated_inspector_reaches_lead(wired):
    """큐 소유권: 검토원은 안 닫고 권고만 남긴다 — 그 권고가 리드에 닿아야 한다."""
    ctx, _ad, _sp, st = wired
    st["arm"](
        worker_result=_ok_worker_result("접근 불가"),
        recommendation={"deferred_to_lead": True, "recommended_status": "skipped",
                        "target_ids": [42], "reason": "HTTP 403"},
    )
    env = json.loads(_call(ctx).content)
    assert env["recommended_status"] == "skipped"
    assert env["recommendation"]["reason"] == "HTTP 403"


def test_missing_worker_result_is_marked_not_silently_downgraded(wired):
    """★ 조용한 저품질 대체 금지 — 리드가 신뢰도를 알아야 한다."""
    ctx, _ad, _sp, st = wired
    st["arm"](worker_result=None, raw_payload={"body": FILE_BODY})
    env = json.loads(_call(ctx).content)
    assert env["source"] == "text-fallback"
    assert "worker_result_invalid" in env
    assert FILE_BODY.splitlines()[0] not in json.dumps(env, ensure_ascii=False)


def test_agent_error_is_returned_as_error_with_masked_envelope(wired):
    ctx, _ad, _sp, st = wired
    st["arm"](worker_result=None, error=f"spawn 실패: token {PAT}")
    res = _call(ctx)
    assert isinstance(res, ToolError)
    assert PAT not in res.message


def test_lead_cannot_choose_the_inspector(wired):
    """리드 입력에 subagent_type 이 없다 — 위임 대상은 어댑터가 정한다."""
    assert "subagent_type" not in DelegateInspectInput.model_fields
    assert set(DelegateInspectInput.model_fields) == {
        "target_id", "scope", "question", "use_cred"}


def test_cred_is_passed_as_handle_not_value(wired):
    """Phase 2c — 리드는 핸들 id 만 넘긴다. 값은 검토원 프로세스 안에서만 재료화된다."""
    ctx, _ad, _sp, st = wired
    captured: dict = {}

    async def _capture(self, vi, c):
        captured["input"] = dict(vi.input)
        return ToolSuccess(content="[fake_inspect result] (x)\nsummary: ok")

    from secu_agent.agent.tools.agent_tool import AgentTool
    import pytest as _p
    mp = _p.MonkeyPatch()
    mp.setattr(AgentTool, "execute", _capture, raising=True)
    try:
        _call(ctx, use_cred=7)
    finally:
        mp.undo()
    assert captured["input"]["cred_id"] == 7
    assert not any("pass" in str(k).lower() for k in captured["input"]), (
        "리드가 크리덴셜 값 비슷한 것을 넘기고 있다")


def test_core_agent_tool_still_emits_the_raw_marker():
    """★ `_strip_raw_payload` 는 코어 문자열 형식에 기댄다.

    코어가 형식을 바꾸면 text-fallback 경로에서 raw 덤프가 통과한다 — 조용히 새는 대신
    여기서 깨지게 한다.
    """
    import secu_agent.agent.tools.agent_tool as at

    src = Path(at.__file__).read_text(encoding="utf-8")
    assert 'f"raw: {_json.dumps(payload' in src, (
        "코어 AgentTool 의 raw payload 동봉 형식이 바뀌었다 — "
        "_shared/lead_tools.py::_strip_raw_payload 를 함께 고쳐라")


def test_strip_raw_payload_cuts_everything_after_the_marker():
    text = ("[a result] (turns=3)\nsummary: 요약\n"
            f"raw: {{\"body\": \"{FILE_BODY}\"}}")
    out = strip_raw_payload(text)
    assert "요약" in out
    assert "raw:" not in out and "psycopg2" not in out
