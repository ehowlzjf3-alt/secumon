"""스레드는 **수신처를 모르는 채로** 태어나야 한다.

2026-08-24 실측으로 드러난 것:
  dev_web_report_thread  137행 전부 dssoc@samsung.com · NULL 0행 · awaiting_reply 0행
  mail_thread            510행 전부 dssoc@samsung.com · 서로 다른 값 1종

dev_web 은 **한 건도 안 보냈는데** 전부 "DSSOC 로 보냄" 으로 기록돼 있었다. 출처는 발송
경로가 아니라 finding 제출 시점의 개발 기본값이었다(`_default_recipient`,
`_build_phase_recipient` — 후자는 docstring 이 스스로 "Development default" 라고 적혀 있었다).

파급: 게이트웨이 `deliveryTarget` 이 안 보낸 스레드까지 "DSSOC" 로 그리고,
`dev_web/webapp/routes/targets.py` 의 `has_request_mail` 이 항상 True 가 된다.

⚠️ 이 동작을 지키는 테스트가 **하나도 없었다** — 기본값을 걷어냈는데 613건이 다 통과했다.
   그래서 여기 둔다.
"""
from __future__ import annotations

import re


def _dev_web_finding():
    from secu_agent.agent.schema.finding import FindingHit, TaskFinding

    return TaskFinding(
        task_type="dev_web",
        target="https://app.cdep.samsungds.net",
        severity="high",
        summary="인증 없이 내부 API 문서가 노출됩니다.",
        hits=[FindingHit(
            category="credential", kind="api_token",
            location="https://app.cdep.samsungds.net/admin",
            masked="TOKEN=ab***", preview="TOKEN=ab***",
        )],
        recommended_actions=["인증/인가를 적용하세요."],
    )


def test_dev_web_submit_creates_a_thread_with_no_recipient(tmp_db, tmp_path, monkeypatch) -> None:
    """★ 실제로 제출 도구를 부른다 — 심는 자리가 upsert 가 아니라 이 호출부다.

    env 를 일부러 채워 둔다: 예전 코드였다면 이 값이 스레드에 박힌다.
    """
    import asyncio

    # ⚠️ 정책 A(브라우저 검증) 게이트는 **플러그인이 등록해야 켜지는 전역**이라, 이 파일을
    #    단독으로 돌리면 꺼져 있고 전체 스위트에서는 켜진다. 그래서 이 테스트는 처음에
    #    단독 통과 / 전체 실패였다.
    #    여기서 `plugin.bootstrap.register_all()` 로 강제로 켜지 **않는다** — 부트스트랩이
    #    스스로 경고한다: in-process 로드는 judge/category/browser-verified 전역을 오염시켜
    #    다른 테스트 결과를 바꾼다. 대신 아래 metadata 에 정책 A 기록을 넣어, 게이트가
    #    켜져 있든 꺼져 있든 같은 경로를 지나게 한다. 켜진 상태의 증명은 전체 스위트다.
    from domains.dev_web.plugin.tools.dev_web_submit_finding_tool import (
        DevWebSubmitFindingInput,
        DevWebSubmitFindingTool,
    )
    from secu_agent.agent.tools.base import ToolContext, ToolError
    from service import state_domain as state

    monkeypatch.setenv("DEV_WEB_REMEDIATION_DSSOC_RECIPIENT", "dssoc@samsung.com")

    result = asyncio.run(
        DevWebSubmitFindingTool().execute(
            DevWebSubmitFindingInput(finding=_dev_web_finding()),
            ToolContext(
                evidence_dir=tmp_path,
                metadata={
                    "_dev_web_browser_deep_dive_seen": True,
                    # ⚠️ 정책 A(브라우저 검증) 기록. 이걸 빼면 **전체 스위트에서만** 깨진다 —
                    #    게이트는 `browser_verification_required(task_type)` 로 켜지는데 그건
                    #    플러그인이 등록하는 전역이라, 단독 실행에선 dev_web 이 미등록이라
                    #    게이트가 아예 안 걸린다. 실제 제출에는 이 기록이 있으므로 넣어 둔다.
                    "_web_browser_hosts": ["app.cdep.samsungds.net"],
                },
            ),
        ),
    )
    assert not isinstance(result, ToolError), getattr(result, "message", result)

    m = re.search(r"report_thread=\w+\(id=(\d+)\)", result.content)
    assert m, f"제출이 스레드를 안 만들었다: {result.content}"
    thread = state.dev_web_report_thread_get(int(m.group(1)))
    assert thread is not None
    assert thread["recipient"] is None, (
        "발송 전에 수신처가 박혔다 — 개발 기본값이 되살아났다"
    )


def test_submit_tools_no_longer_carry_a_dssoc_default() -> None:
    """개발 기본값이 다시 생기면 여기서 잡는다.

    지운 것이 아니라 **되살아나는 것**을 막는 테스트다 — 이 값은 한 번 심어 두면
    아무 테스트도 안 깨지면서 전 도메인의 기록을 조용히 오염시킨다.
    """
    from domains.dev_web.plugin.tools import dev_web_submit_finding_tool as dw
    from domains.smb.plugin.tools import smb_submit_finding_tool as smb

    assert not hasattr(dw, "_default_recipient")
    assert not hasattr(smb, "_build_phase_recipient")
