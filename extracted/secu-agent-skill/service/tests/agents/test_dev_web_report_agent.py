"""dev_web report mail behavior."""
from __future__ import annotations

import pytest

import asyncio
import json

from secu_agent.agent.tools.base import ToolContext

from domains.dev_web.application.contracts import REPORT_SESSION_ID
from domains.dev_web.plugin.tools.dev_web_report_tools import (
    DevWebBuildReportInput,
    DevWebBuildReportTool,
)
from service.agents import dev_web_report_agent



@pytest.fixture(autouse=True)
def _initial_gate_open(monkeypatch):
    """이 파일은 **수신처/본문 정책**을 검증한다 — 최초 발송 게이트는 관심사가 다르다.

    게이트가 닫힌 채로 두면 모든 케이스가 `initial_closed`(수신처 없음)로 뭉개져
    정작 검증하려던 정책을 못 본다. 게이트 자체는
    `service/tests/test_initial_send_gate.py` 가 따로 고정한다(2026-08-31).
    """
    from service.services.owner_recipients import INITIAL_AUTOSEND_ENV

    monkeypatch.setenv(INITIAL_AUTOSEND_ENV, "1")

def _dev_web_thread(tmp_db):
    from service import state_domain as state
    from secu_agent import state as core_state

    finding_id, _ = core_state.finding_upsert(
        task_type="dev_web",
        asset="https://dev-api.example.test/swagger",
        asset_kind="url",
        severity="high",
        summary="Swagger API 문서가 인증 없이 노출됨",
        evidence_ref="web-sweep://dev-api",
        extra={
            "hits": [
                {"category": "internal_system", "kind": "swagger"},
                {"category": "secret", "kind": "token"},
            ],
            "risk": "내부 API 구조와 테스트 토큰이 함께 노출될 수 있음",
        },
    )
    _, thread_id = state.dev_web_report_thread_upsert(
        target_id=None,
        finding_id=finding_id,
        domain="dev-api.example.test",
        url="https://dev-api.example.test/swagger",
        severity="high",
        status="reported",
        report_json={"recommended_actions": ["Swagger 접근을 담당자 그룹으로 제한한다."]},
    )
    thread = state.dev_web_report_thread_get(thread_id)
    assert thread is not None
    return thread


def test_dev_web_report_tool_uses_management_subject_and_html_form(tmp_db, tmp_path, monkeypatch) -> None:
    from domains.dev_web.plugin.tools import dev_web_report_tools

    monkeypatch.delenv("DEV_WEB_REMEDIATION_DSSOC_RECIPIENT", raising=False)
    monkeypatch.delenv("SA_DSSOC_MAIL_RECIPIENT", raising=False)
    thread = _dev_web_thread(tmp_db)

    result = asyncio.run(
        DevWebBuildReportTool().execute(
            DevWebBuildReportInput(thread_id=int(thread["id"])),
            ToolContext(evidence_dir=tmp_path),
        ),
    )

    payload = json.loads(result.content)
    # ★ 제목 앞에 티켓 번호가 붙는다(회신 매칭 1차 키, 2026-08-31).
    #   기존 태그는 **지우지 않는다** — 폴백 경로가 그걸 본다.
    # ★ 2026-08-31 형식: 티켓 번호가 태그 **바로 뒤 괄호**에 온다.
    #   `[Dev Web 보안취약점 조치요청](DW00001)(dev-api.example.test) …`
    assert "(DW00001)" in payload["subject"], payload["subject"]
    assert payload["subject"].endswith(
        "(dev-api.example.test) 개발 웹 접근통제 조치"
    ), payload["subject"]
    assert payload["recipient"] == "dssoc@samsung.com"
    assert payload["deliver_hint"]["subject"] == payload["subject"]
    assert "Dev Web 접근통제 조치 요청" in payload["html"]
    assert "점검 방법" in payload["html"]
    assert "Swagger 접근을 담당자 그룹으로 제한해 주시기 바랍니다." in payload["html"]
    assert dev_web_report_tools._MAIL_SUBJECT_SUFFIX in payload["subject"]


def test_dev_web_report_agent_records_sent_report(tmp_db, monkeypatch) -> None:
    from service import state_domain as state

    thread = _dev_web_thread(tmp_db)

    async def fake_run_agent(**kwargs):
        del kwargs
        return {
            "saw_terminal": True,
            "terminal_calls": [{
                "name": "deliver",
                "input": {
                    "recipients": ["owner@samsung.com"],
                    "subject": "[Dev Web 보안취약점 조치요청](dev-api.example.test) 개발 웹 접근통제 조치",
                    "body": "<html><body>dev_web report</body></html>",
                },
                "result_content": "[deliver:knox_mail] sent",
            }],
        }

    monkeypatch.setattr(dev_web_report_agent.runtime, "run_agent", fake_run_agent)

    result = asyncio.run(dev_web_report_agent._report_one_thread(thread))

    saved = state.dev_web_report_thread_get(int(thread["id"]))
    assert result["delivery_mode"] == "sent"
    assert saved is not None
    assert saved["status"] == "awaiting_reply"
    # ★ 이 단언이 예전엔 "dssoc@samsung.com" 이었다 — 위 가짜 호출은 owner 에게 보냈는데도.
    #   즉 테스트가 **지어낸 값을 지키고 있었다.** 기록은 실제 수신자를 말해야 한다.
    assert saved["recipient"] == "owner@samsung.com"
    assert saved["attempt_count"] == 1


def test_dev_web_report_agent_parks_dry_run_out_of_the_claim_queue(tmp_db, monkeypatch) -> None:
    """★ 계약이 바뀌었다 (2026-08-28).

    예전 이름은 `..._keeps_dry_run_in_reported_queue` 였고, dry-run 종결을 `reported` +
    `claimed_by=REPORT_SESSION_ID` 로 되돌리는 **순환을 사양으로 못 박고** 있었다.
    그 순환이 같은 스레드를 1800초마다 다시 집어 `attempt_count` 를 67까지 올렸다
    (실측 2026-08-28: 71스레드가 53~67, retry_after non-NULL 0행).

    이제 초안까지 만들고 발송만 남은 스레드는 `report_ready` 로 **파킹**한다 —
    confluence·github 이 이미 쓰는 어휘다. terminal 이 아니므로 병합 후보에는 남고,
    자율발송이 켜지면 `dev_web_report_thread_requeue_ready` 로 되돌아온다.
    """
    from service import state_domain as state

    thread = _dev_web_thread(tmp_db)

    async def fake_run_agent(**kwargs):
        del kwargs
        return {
            "saw_terminal": True,
            "terminal_calls": [{
                "name": "deliver",
                "input": {
                    "recipients": ["dssoc@samsung.com"],
                    "subject": "[Dev Web 보안취약점 조치요청](dev-api.example.test) 개발 웹 접근통제 조치",
                    "body": "<html><body>blocked</body></html>",
                },
                "result_content": "[deliver:knox_mail] dry-run - 실발송 안 됨",
            }],
        }

    monkeypatch.setattr(dev_web_report_agent.runtime, "run_agent", fake_run_agent)

    result = asyncio.run(dev_web_report_agent._report_one_thread(thread))

    saved = state.dev_web_report_thread_get(int(thread["id"]))
    assert result["delivery_mode"] == "dry_run"
    assert saved is not None
    assert saved["status"] == "report_ready"          # 청구 큐를 떠났다
    assert saved["claimed_by"] is None                # 아무도 붙들고 있지 않다
    assert saved["attempt_count"] == 1
    assert "dry-run" in saved["last_reason"]
    # 파킹 사유 토큰 — 자율발송이 켜졌을 때 **되돌릴 대상**을 고르는 유일한 근거다.
    assert saved["last_reason"].startswith(dev_web_report_agent.PARK_AUTOSEND_OFF)
    # 청구 큐에서 실제로 사라졌는지 확인한다. 상태값만 보면 배선을 안 본 것이다.
    assert state.dev_web_report_thread_claim_next(
        session_id=REPORT_SESSION_ID, status="reported",
        cycle_key=saved["last_cycle_key"],
    ) is None


def test_parked_thread_comes_back_when_autosend_is_turned_on(tmp_db, monkeypatch) -> None:
    """되돌리는 문이 실제로 열리는가 — 파킹은 종결이 아니다."""
    from service import state_domain as state

    thread = _dev_web_thread(tmp_db)

    async def fake_run_agent(**kwargs):
        del kwargs
        return {
            "saw_terminal": True,
            "terminal_calls": [{
                "name": "deliver",
                "input": {"recipients": ["dssoc@samsung.com"], "subject": "s", "body": "b"},
                "result_content": "[deliver:knox_mail] dry-run - 실발송 안 됨",
            }],
        }

    monkeypatch.setattr(dev_web_report_agent.runtime, "run_agent", fake_run_agent)
    asyncio.run(dev_web_report_agent._report_one_thread(thread))

    moved = state.dev_web_report_thread_requeue_ready(
        only_prefix=dev_web_report_agent.PARK_AUTOSEND_OFF)
    assert moved == 1
    saved = state.dev_web_report_thread_get(int(thread["id"]))
    assert saved["status"] == "reported"
    assert saved["retry_after"] is None
    # 되돌릴 때 주차를 함께 찍는다 — 안 찍으면 claim_next 의 주차 조건에 걸려 영영 안 잡힌다.
    assert saved["last_cycle_key"] == state.smb_current_cycle_key()


def test_requeue_only_touches_threads_parked_for_autosend_off(tmp_db) -> None:
    """발송이 켜져 있는데도 막힌 것(dry_run_blocked)은 스위치를 켜도 안 풀린다."""
    from service import state_domain as state

    thread = _dev_web_thread(tmp_db)
    state.dev_web_report_thread_set_status(
        int(thread["id"]), "report_ready",
        last_reason=f"{dev_web_report_agent.PARK_BLOCKED} 수신처 없음",
    )
    assert state.dev_web_report_thread_requeue_ready(
        only_prefix=dev_web_report_agent.PARK_AUTOSEND_OFF) == 0
    assert state.dev_web_report_thread_get(int(thread["id"]))["status"] == "report_ready"


def test_failed_pass_backs_off_instead_of_being_reclaimed_at_once(tmp_db, monkeypatch) -> None:
    """실패는 큐에 남되 **즉시** 다시 잡히지 않는다.

    예전엔 인자 없는 `set_status(thread_id, "reported")` 가 retry_after 와 claim 을
    NULL 로 지워서 곧바로 재청구됐다(실측: 21:48:18 실패 → 21:50:13 재실행).
    """
    from service import state_domain as state

    thread = _dev_web_thread(tmp_db)

    async def boom(**kwargs):
        del kwargs
        raise RuntimeError("gateway down")

    monkeypatch.setattr(dev_web_report_agent.runtime, "run_agent", boom)
    asyncio.run(dev_web_report_agent._report_one_thread(thread))

    saved = state.dev_web_report_thread_get(int(thread["id"]))
    assert saved["status"] == "reported"           # 큐에도 화면에도 남는다
    assert saved["retry_after"] is not None        # 그러나 지금은 못 잡는다
    assert "gateway down" in str(saved["last_reason"])
    assert state.dev_web_report_thread_claim_next(
        session_id=REPORT_SESSION_ID, status="reported",
        cycle_key=saved["last_cycle_key"],
    ) is None


# ── 수신처 정책 — dev_web 은 4도메인 중 유일하게 SSOT 를 안 거치고 있었다 ──────────────
#
# 아래 셋은 전부 **실제로 호출한다.** dev_web 배달을 3시간 죽인 미정의 참조(2026-08-23)가
# import 와 전체 스위트를 통과했던 이유가 "부르는 테스트가 없어서" 였다.

def test_dev_web_report_targets_put_owner_in_to_and_dssoc_in_cc(tmp_db, tmp_path, monkeypatch) -> None:
    """담당자(To) + DSSOC(Cc). 예전엔 Cc 가 항상 빈 배열이라 팀함 사본이 안 남았다."""
    from service import state_domain as state
    from domains.dev_web.plugin.tools import dev_web_report_tools

    monkeypatch.setenv("DEV_WEB_REMEDIATION_MAIL_MODE", "normal")
    monkeypatch.setenv("DEV_WEB_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")
    thread = _dev_web_thread(tmp_db)
    state.dev_web_report_thread_set_status(
        int(thread["id"]), "reported", recipient="owner@samsung.com",
    )

    payload = json.loads(asyncio.run(
        DevWebBuildReportTool().execute(
            DevWebBuildReportInput(thread_id=int(thread["id"])),
            ToolContext(evidence_dir=tmp_path),
        ),
    ).content)

    assert payload["recipient"] == "owner@samsung.com"
    assert payload["cc"] == ["dssoc@samsung.com"]
    assert payload["delivery_policy"] == "normal"
    assert payload["deliver_hint"]["recipients"] == ["owner@samsung.com"]
    assert payload["deliver_hint"]["cc"] == ["dssoc@samsung.com"]
    del dev_web_report_tools  # import 가 살아있는지 확인용


def test_dev_web_stored_dssoc_recipient_is_not_mistaken_for_the_owner(tmp_db, tmp_path, monkeypatch) -> None:
    """되먹임 차단 — 발송기록이 DSSOC 로 굳어 있어도 그건 담당자가 아니다.

    `_report_fields` 가 오래 DSSOC 를 적어 왔기 때문에 실제 DB 에 그런 행이 있다.
    그걸 담당자로 읽으면 팀함이 영구히 담당자가 되고 `delivery_policy` 가 normal 로 뜬다.
    """
    from service import state_domain as state

    monkeypatch.setenv("DEV_WEB_REMEDIATION_MAIL_MODE", "normal")
    monkeypatch.setenv("DEV_WEB_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")
    monkeypatch.delenv("SA_DELIVERY_AUTOSEND_SINKS", raising=False)
    thread = _dev_web_thread(tmp_db)
    state.dev_web_report_thread_set_status(
        int(thread["id"]), "reported", recipient="dssoc@samsung.com",
    )

    payload = json.loads(asyncio.run(
        DevWebBuildReportTool().execute(
            DevWebBuildReportInput(thread_id=int(thread["id"])),
            ToolContext(evidence_dir=tmp_path),
        ),
    ).content)

    assert payload["owner_recipient"] is None
    assert payload["delivery_policy"] == "no_owner"   # normal 이 아니다 — 담당자를 못 찾았다
    assert payload["cc"] == []


def test_dev_web_records_the_address_it_actually_sent_to(tmp_db, monkeypatch) -> None:
    """기록은 env 가 아니라 실제 deliver 호출에서 온다 — 수신자를 바꿔도 따라와야 한다."""
    from service import state_domain as state

    monkeypatch.setenv("DEV_WEB_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")
    thread = _dev_web_thread(tmp_db)

    async def fake_run_agent(**kwargs):
        del kwargs
        return {
            "saw_terminal": True,
            "terminal_calls": [{
                "name": "deliver",
                "input": {
                    "recipients": ["someone.else@samsung.com"],
                    "cc": ["dssoc@samsung.com"],
                    "subject": "s",
                    "body": "b",
                },
                "result_content": "[deliver:knox_mail] sent",
            }],
        }

    monkeypatch.setattr(dev_web_report_agent.runtime, "run_agent", fake_run_agent)
    asyncio.run(dev_web_report_agent._report_one_thread(thread))

    saved = state.dev_web_report_thread_get(int(thread["id"]))
    assert saved is not None
    assert saved["recipient"] == "someone.else@samsung.com"
