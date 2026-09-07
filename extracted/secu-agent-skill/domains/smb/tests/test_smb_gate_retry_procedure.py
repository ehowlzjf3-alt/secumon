"""거부 메시지가 **재시도 절차까지** 워커에게 실어 보낸다.

배경(2026-08-17 실측) — smb halt 5건의 제출 페이로드를 해시로 비교했더니, 워커가
**실제로 수리한 경우에도** 죽고 있었다:

    12.56.74.220  제출 2회 · 페이로드 다름(hits 수정, 1093→1101자)  → halt
    12.56.74.200  제출 2회 · 페이로드 동일                          → halt(정당)
    12.23.67.40   제출 5회 · 4가지 · 마지막 둘만 동일               → 그때 halt

`repeat_error.py` 의 halt 카운터는 **페이로드가 아니라 오류 메시지**가 연속 2회 같은지를
센다. 내용을 고쳐도 판정문이 같으면 두 번째 제출이 곧 halt 다. 살아남는 유일한 방법은
두 제출 **사이에 실제 도구 호출을 끼워** 연속 카운터를 리셋하는 것이다.

그 절차는 worker.md 에 이미 적혀 있었고 지켜지지 않았다. 그래서 거부 **시점에**
in-context 로 도착하는 메시지에 실었다 — 워커가 그것을 읽는 순간이 결정하는 순간이다.

⚠️ 게이트를 약화하지 않는다. verdict/should_persist 는 그대로이고, 통과 조건도 그대로다.
추가된 것은 `required_actions` 의 절차 문장 하나뿐이다.
"""
from __future__ import annotations

import pytest

from plugin.smb_evidence_judge import _RETRY_PROCEDURE, judge_smb_credential_hit


class _Hit:
    def __init__(self, category="credential", kind="hardcoded_password",
                 masked="", preview="", validation=None):
        self.category = category
        self.kind = kind
        self.masked = masked
        self.preview = preview
        self.validation = validation


class _Finding:
    def __init__(self, summary="", risk_narrative=None):
        self.summary = summary
        self.risk_narrative = risk_narrative
        self.evidence_notes = {}
        self.pivot_interpretation = ""


def _no_value_evidence() -> tuple[_Finding, _Hit]:
    """값 증거가 없는 hit → `rejected`(실측: 12.56.74.220 이 여기서 죽었다)."""
    return _Finding("SMB 공유에 비밀번호 노출"), _Hit(preview="password field present")


def _reachable_but_unvalidated() -> tuple[_Finding, _Hit]:
    """값은 있고 도달점도 있는데 검증 결과가 없는 hit → `suspected`(12.23.67.40)."""
    return (
        _Finding("App.config 에 DB 계정 노출"),
        _Hit(masked="1q2w****5t!",
             preview="data source=12.25.183.214;user id=sa;password=1q2w3e4r5t!"),
    )


def _printer_claim() -> tuple[_Finding, _Hit]:
    return (
        _Finding("프린터 드라이버 INI"),
        _Hit(kind="printer_fax_config_password_fields",
             masked="<masked,len=8>", preview="value_present=True"),
    )


CASES = [
    pytest.param(_no_value_evidence, "rejected", id="값증거_없음"),
    pytest.param(_reachable_but_unvalidated, "suspected", id="도달점_있고_미검증"),
    pytest.param(_printer_claim, "rejected", id="프린터_INI_주장"),
]


@pytest.mark.parametrize("build,expected", CASES)
def test_every_rejection_carries_the_retry_procedure(build, expected) -> None:
    """★ 거부하는 경로 **전부**에 절차가 실려야 한다 — 하나라도 빠지면 그 경로는 계속 죽는다."""
    finding, hit = build()
    v = judge_smb_credential_hit(finding, hit)
    assert v is not None and v.verdict == expected
    assert _RETRY_PROCEDURE in v.required_actions, (
        f"{expected} 경로에 재시도 절차가 없다 — 워커가 곧바로 재제출해 halt 한다"
    )


@pytest.mark.parametrize("build,expected", CASES)
def test_the_original_required_action_is_kept(build, expected) -> None:
    """절차 문장이 기존 지시를 **밀어내면** 안 된다 — 무엇을 고칠지가 먼저다."""
    finding, hit = build()
    v = judge_smb_credential_hit(finding, hit)
    others = [a for a in v.required_actions if a != _RETRY_PROCEDURE]
    assert others, "원래의 '무엇을 고쳐라' 지시가 사라졌다"


def test_procedure_names_a_concrete_intervening_tool() -> None:
    """"다른 도구를 불러라" 만으로는 부족하다 — 어떤 도구인지 말해야 움직인다."""
    assert "smb_fetch_scan" in _RETRY_PROCEDURE
    assert "도구 호출 없이" in _RETRY_PROCEDURE


def test_procedure_offers_the_always_safe_exit() -> None:
    """가져올 증거가 없을 때의 안전한 출구가 같이 있어야 한다."""
    assert "finding_count=0" in _RETRY_PROCEDURE


def test_procedure_actually_reaches_the_worker_message() -> None:
    """★ required_actions 가 워커에게 전달되지 않으면 이 수정은 전부 무의미하다.

    코어 submit_finding 이 `next: <actions>` 로 붙여 보낸다는 계약에 의존한다.
    그 계약이 사라지면 여기서 먼저 깨져야 한다.
    """
    import inspect

    from secu_agent.agent.tools import submit_finding as sf

    src = inspect.getsource(sf.SubmitFindingTool.execute)
    assert 'actions = "; ".join(judgment.required_actions)' in src
    assert 'f" next: {actions}"' in src


@pytest.mark.parametrize("build,expected", CASES)
def test_gate_verdict_is_unchanged(build, expected) -> None:
    """⚠️ 회귀 기준 — 절차 안내가 통과 판정을 바꾸면 게이트가 약화된 것이다."""
    finding, hit = build()
    v = judge_smb_credential_hit(finding, hit)
    assert v.should_persist is False


def test_a_clean_hit_still_passes_through_untouched() -> None:
    """검증까지 붙은 hit 는 여전히 judge 가 손대지 않는다(None = 코어 계약으로 폴백)."""
    finding = _Finding("App.config 에 DB 계정 노출")
    hit = _Hit(masked="1q2w****5t!",
               preview="data source=12.25.183.214;user id=sa;password=1q2w3e4r5t!",
               validation={"kind": "credential_reachability", "result": "unreachable"})
    assert judge_smb_credential_hit(finding, hit) is None
