"""`smb_submit_finding` 이 smb 게이트를 **실제로 태우는지** 고정한다.

배경(2026-08-17 실측) — 오늘 `smb_submit_finding` 제출 67건 중 **16건(24%)이
`task_type` 을 빠뜨렸다.**

`TaskFinding.task_type` 의 기본값은 `"generic"` 이고, 코어 디스패치는
`_TASK_TYPE_JUDGES.get(finding.task_type)` 로 judge 를 고른다
(`evidence_judgment.py:630`). 그래서 `generic` 으로 들어오면 **등록된 smb judge 가
아예 실행되지 않고** 코어 generic 계약이 대신 판정한다. 즉 도메인 게이트가
에러 없이 **조용히 우회된다.**

그렇게 통과한 4건이 DB 에 `task_type='generic'` 으로 남아 있다 — 전부 `asset` 이
`smb://…` 이고 그중 하나는 `critical` 이다:

    #20303 critical  smb://12.23.37.227/PublicShare/test/iml-….war
    #20301 high      smb://12.23.124.99/samsung/_old/…/server/.env
    #20314 low       smb://12.52.48.167/SCCMContentLib$/…
    #20299 low       smb://11.106.101.210/공유폴더/회원관리/…

두 가지가 동시에 깨졌다: smb 전용 증거계약(deep-dive·probe 검증)이 적용되지 않았고,
smb 리포트/대시보드가 그 finding 을 못 본다.

⚠️ dev_web 은 같은 상황을 **거부**로 처리하는데, 오늘 그 거부가 halt 6건을 만들었다.
이 도구는 정의상 전부 smb 이므로 비었거나 `generic` 이면 **확정**하고, 다른 도메인을
명시했을 때만 거부한다.
"""
from __future__ import annotations

import pytest

from secu_agent.agent.schema.finding import FindingHit, TaskFinding
from secu_agent.agent.tools.base import ToolError

from domains.smb.plugin.tools.smb_submit_finding_tool import _ensure_smb_task_type


def _finding(task_type: str | None = None) -> TaskFinding:
    kw = {} if task_type is None else {"task_type": task_type}
    return TaskFinding(
        severity="high",
        summary="SMB 공유에 자격증명 노출",
        hits=[FindingHit(category="credential", kind="db_password",
                         location="smb://10.0.0.1/share/App.config",
                         masked="pw****23", preview="password=pw123423")],
        **kw,
    )


def test_default_task_type_is_generic_which_is_the_whole_problem() -> None:
    """★ 전제 확인 — 모델이 안 채우면 'generic' 이 된다."""
    assert _finding().task_type == "generic"


@pytest.mark.parametrize("given", [None, "generic", "", "  ", "GENERIC"])
def test_missing_or_generic_task_type_is_pinned_to_smb(given) -> None:
    f = _finding() if given is None else _finding().model_copy(update={"task_type": given})
    out = _ensure_smb_task_type(f)
    assert not isinstance(out, ToolError), "빈/generic 은 거부가 아니라 확정이어야 한다"
    assert out.task_type == "smb"


@pytest.mark.parametrize("given", ["smb", "SMB", " smb "])
def test_explicit_smb_passes_through(given) -> None:
    out = _ensure_smb_task_type(_finding().model_copy(update={"task_type": given}))
    assert not isinstance(out, ToolError)
    assert out.task_type == "smb"


@pytest.mark.parametrize("given", ["github", "dev_web", "confluence"])
def test_a_different_domain_is_rejected_not_silently_rewritten(given) -> None:
    """다른 도메인을 **명시**한 건 워커의 혼동이다 — 조용히 고치면 그 혼동이 숨는다."""
    out = _ensure_smb_task_type(_finding().model_copy(update={"task_type": given}))
    assert isinstance(out, ToolError)
    assert given in out.message


def test_nothing_else_about_the_finding_is_touched() -> None:
    """⚠️ task_type 만 바꾼다 — 증거를 건드리면 게이트 판정이 달라진다."""
    f = _finding()
    out = _ensure_smb_task_type(f)
    assert out.summary == f.summary
    assert [h.model_dump() for h in out.hits] == [h.model_dump() for h in f.hits]
    assert out.severity == f.severity


def test_pinning_actually_routes_to_the_registered_smb_judge() -> None:
    """★★ 이 테스트가 본체다 — 'smb' 로 확정하면 smb judge 가 **실제로** 판정한다.

    generic 이면 코어 계약이, smb 면 등록된 도메인 judge 가 잡는다. 두 판정문이
    다르다는 것으로 라우팅이 실제로 바뀌었음을 확인한다.
    """
    from secu_agent.agent.evidence_judgment import (
        judge_task_finding,
        register_evidence_judge,
        unregister_evidence_judge,
    )

    from plugin.smb_evidence_judge import judge_smb_credential_hit

    weak = TaskFinding(
        severity="high", summary="비밀번호 노출 의심",
        hits=[FindingHit(category="credential", kind="hardcoded_password",
                         location="smb://10.0.0.1/share/x.ini",
                         masked="'gmail': '********'", preview="password field present")],
    )
    unregister_evidence_judge("smb")
    register_evidence_judge("smb", judge_smb_credential_hit)
    try:
        generic_reason = judge_task_finding(weak).reason
        pinned = _ensure_smb_task_type(weak)
        smb_reason = judge_task_finding(pinned).reason
    finally:
        unregister_evidence_judge("smb")

    assert "SMB credential/secret finding requires deep-dive evidence" in smb_reason, (
        "task_type 을 smb 로 고정해도 smb judge 가 안 돌았다 — 게이트가 계속 우회된다"
    )
    assert smb_reason != generic_reason
    assert "값 증거 없음" in generic_reason, "generic 경로는 코어 계약이 판정한다(대조군)"
