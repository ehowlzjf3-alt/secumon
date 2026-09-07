"""dev_web 재검증 회신 — 3단 단절의 마지막 칸.

재검증 워커의 종료 도구가 `dev_web_record_reverify_result`(DB 기록)뿐이라, 재검증을 해도
담당자는 결과를 못 받았다. 다른 도메인은 **발송이 종료 조건**이다(SMB: {"deliver","smb_build_reply"}).
"""
from __future__ import annotations

import asyncio
import json

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess

from domains.dev_web.plugin.tools.dev_web_reply_tools import (
    DevWebBuildReplyTool, _build_body, _open_urls_table,
)

_THREAD = {"id": 7, "url": "https://x--dev.cdep.samsungds.net", "domain": "x--dev.cdep.samsungds.net",
           "subject_tag": "[Dev Web 보안취약점 조치요청](x--dev.cdep.samsungds.net)"}


#: 기본 재검증 기록. ★ 2026-08-31 부터 **상태를 단언하는 회신**(confirmed/still_exposed/
#: partial)은 재검증 기록 없이는 만들 수 없다(`_shared/reply_guard`). 재검증 워커가
#: `dev_web_record_reverify_result` 로 남긴 뒤 회신하는 것이 실제 순서이므로,
#: 테스트도 그 순서를 표현한다.
_RECHECK = [{"id": 1, "thread_id": 7, "verdict": "still_exposed", "created_at": 9_999_999_999.0}]


def _run(payload, ctx=None, thread=_THREAD, inbound=None, monkeypatch=None, recheck=_RECHECK):
    from domains.dev_web.plugin.tools import dev_web_reply_tools as M
    monkeypatch.setattr(M.state, "dev_web_report_thread_get", lambda _i: thread)
    monkeypatch.setattr(M.state, "service_reply_message_latest_inbound_for_thread",
                        lambda _d, _i: inbound)
    monkeypatch.setattr(M.state, "dev_web_recheck_results_for_thread",
                        lambda _i: list(recheck or []))
    monkeypatch.setattr(M.state, "service_reply_messages_for_thread",
                        lambda _d, _i: ([inbound] if inbound else []))
    tool = DevWebBuildReplyTool()
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx or ToolContext(evidence_dir=__import__("pathlib").Path("."))))


@pytest.mark.parametrize("kind", ["confirmed", "still_exposed", "partial"])
def test_each_reply_kind_builds_a_body(kind, monkeypatch):
    res = _run({"thread_id": 7, "reply_kind": kind}, monkeypatch=monkeypatch)
    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    out = json.loads(res.content)
    assert out["reply_kind"] == kind
    assert out["subject"].startswith("RE:")
    assert out["body"].strip()
    assert out["deliver_hint"]["sink_id"] == "knox_mail"


def test_unsettled_verdicts_are_refused(monkeypatch):
    """★ 판단이 안 선 것을 담당자에게 보내지 않는다."""
    for kind in ("inconclusive", "error"):
        res = _run({"thread_id": 7, "reply_kind": kind}, monkeypatch=monkeypatch)
        assert isinstance(res, ToolError) and res.kind == "validation", kind


def test_open_urls_are_listed_when_still_exposed(monkeypatch):
    urls = ["https://x--dev.cdep.samsungds.net/api/debug",
            "https://x--dev.cdep.samsungds.net/actuator/env"]
    res = _run({"thread_id": 7, "reply_kind": "still_exposed", "open_urls": urls},
               monkeypatch=monkeypatch)
    body = json.loads(res.content)["body"]
    for u in urls:
        assert u in body, "아직 열린 경로가 회신에 안 실리면 담당자가 무엇을 닫을지 모른다"


def test_no_table_when_nothing_is_open():
    """빈 표를 그리지 않는다 — '확인했는데 없음' 과 '확인 안 함' 이 섞인다."""
    assert _open_urls_table([]) == ""
    assert _open_urls_table(["  "]) == ""


def test_open_url_cap_declares_what_it_dropped():
    """조용한 절단은 '이게 전부' 로 읽힌다."""
    html = _open_urls_table([f"https://h/{i}" for i in range(30)])
    assert "외 10건" in html and "총 30건" in html


def test_missing_thread_is_not_found(monkeypatch):
    res = _run({"thread_id": 999, "reply_kind": "confirmed"}, thread=None, monkeypatch=monkeypatch)
    assert isinstance(res, ToolError) and res.kind == "not_found"


def test_reply_targets_come_from_the_inbound_message(monkeypatch):
    """회신은 답장 보낸 사람에게 간다 — dssoc 는 대상이 아니라 참조다."""
    inbound = {"mail_from": "owner@samsung.com", "mail_to": "dssoc@samsung.com",
               "mail_cc": "peer@samsung.com", "subject": "RE: 조치 완료"}
    res = _run({"thread_id": 7, "reply_kind": "confirmed"}, inbound=inbound, monkeypatch=monkeypatch)
    out = json.loads(res.content)
    assert out["recipients"] == ["owner@samsung.com"]
    # ★ 정책이 뒤집혔다: DSSOC 는 **참조로 붙는다**(자기 자신 사본).
    #   To 에는 안 들어간다 — 회신 상대가 To 다.
    assert "dssoc@samsung.com" in out["cc"]
    assert "dssoc@samsung.com" not in out["recipients"]
    assert "peer@samsung.com" in out["cc"]


def test_body_escapes_html():
    body = _build_body("still_exposed", owner_name="<script>x</script>", url="https://h/<b>",
                       site="h", open_urls=[], detail="")
    assert "<script>" not in body


@pytest.mark.parametrize("kind", ["confirmed", "still_exposed", "partial"])
def test_state_asserting_reply_needs_a_recheck_record(kind, monkeypatch):
    """★ 재검증 없이 "재점검한 결과" 를 말하지 않는다.

    기록이 없으면 조립기가 저장된 지난 스캔으로 폴백해 표를 채우는데 본문은 그대로
    "재점검했다" 고 쓴다. 담당자가 실제로 조치했어도 "아직 안 됐다" 고 잘못 답한다.
    """
    res = _run({"thread_id": 7, "reply_kind": kind}, monkeypatch=monkeypatch, recheck=[])
    assert isinstance(res, ToolError) and res.kind == "precondition", kind
    assert "재검증 기록이 없다" in res.message
    assert "dev_web_record_reverify_result" in res.message, "무엇을 하라는지 알려줘야 한다"
