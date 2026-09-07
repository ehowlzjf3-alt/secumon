"""거부가 **어느 hit** 인지 말하게 한 변경의 불변식.

배경 (2026-08-28 실측): mixed-confidence 거부 메시지는
`"1 hit(s) confirmed but 1 hit(s) need more evidence"` 뿐이었다. 워커는 어느 hit 을
빼야 하는지 알 수 없었고, 그래서 같은 finding 을 그대로 다시 내거나 포기했다.

이 파일이 지키는 것은 두 가지다.
  ① 판정은 **하나도 안 바뀐다** — verdict/confidence/should_persist/required_actions.
     바뀌는 것은 `reason` 접미와 새 필드뿐이다. 이게 이 변경의 안전 논거다.
  ② 좌표는 실리되 **값은 절대 안 실린다.** hit_outcomes 는 finding.json 과 DB extra
     양쪽으로 나가는데, 마스킹은 탐지기 커버리지에 묶여 있어서 통과해 버리는 값이 있다.
"""
from __future__ import annotations

import json

import pytest

from secu_agent.agent.evidence_judgment import judge_task_finding
from secu_agent.agent.schema.finding import FindingHit, TaskFinding

_AKIA = "AKIAIOSFODNN7EXAMPLE"


def _hit(category: str, kind: str, *, location: str = "https://x.example.net/.env",
         masked: str = "", preview: str = "") -> FindingHit:
    return FindingHit(category=category, kind=kind, location=location,
                      masked=masked, preview=preview)


def _finding(hits: list[FindingHit], *, severity: str = "high") -> TaskFinding:
    return TaskFinding(task_type="dev_web", severity=severity, summary="s",
                       target="t", hits=hits)


_CONFIRMED_HIT = _hit("secret", "aws_access_key_id", masked=_AKIA)
#: 값이 아니라 "값이 있다" 는 **주장**만 담은 hit — 코어 계약이 막는다.
_BLOCKED_HIT = _hit("credential", "password", masked="value_present")


# ── I1: outcomes 는 순회한 hit 수와 정확히 일치한다 ──────────────────────

@pytest.mark.parametrize(
    ("label", "finding", "expected_code"),
    [
        ("all_confirmed", _finding([_CONFIRMED_HIT]), "all_confirmed"),
        ("all_blocked", _finding([_BLOCKED_HIT]), "all_blocked"),
        ("mixed", _finding([_CONFIRMED_HIT, _BLOCKED_HIT]), "mixed_confidence"),
        ("missing_location",
         _finding([_hit("secret", "tok", location="   ", masked=_AKIA)]),
         "all_blocked"),
        ("unknown_category", _finding([_hit("weird_thing", "x", masked="zz")]),
         "all_blocked"),
    ],
)
def test_hit_outcomes_cover_every_hit(label, finding, expected_code):
    """hit 을 순회한 경로는 **빠짐없이** outcome 을 남긴다.

    한 경로라도 빠지면 하류가 `hit_outcomes=()` 를 "hit 이 없다" 로 오독한다 —
    실제로는 "이 경로가 안 실었다" 인데. 그래서 all_confirmed 도 포함한다.
    """
    judgment = judge_task_finding(finding)
    assert judgment.reason_code == expected_code, label
    assert len(judgment.hit_outcomes) == len(finding.hits), label
    assert [o.index for o in judgment.hit_outcomes] == list(range(len(finding.hits)))
    for outcome in judgment.hit_outcomes:
        assert outcome.hit_verdict in ("confirmed", "blocked")
        if outcome.hit_verdict == "blocked":
            assert outcome.hit_reason_code, "막았으면 사유 코드가 있어야 센다"
        else:
            assert outcome.hit_reason_code == ""


@pytest.mark.parametrize(
    ("label", "finding", "expected_code"),
    [
        ("no_hits_informational", _finding([], severity="informational"), "no_hits"),
        ("no_hits_high", _finding([]), "no_hits"),
        ("low_value_only",
         _finding([_hit("pii", "email_address", masked="a@b.example.com")]),
         "low_value_only"),
    ],
)
def test_pre_loop_paths_leave_outcomes_empty(label, finding, expected_code):
    """순회 **전에** 끝난 판정은 outcomes 가 비는 것이 정상이다.

    소비자는 `len(hit_outcomes) == len(finding.hits)` 를 확인하고 써야 한다 —
    low_value_only 는 hit 이 있는데도 outcomes 가 0 이다.
    """
    judgment = judge_task_finding(finding)
    assert judgment.reason_code == expected_code, label
    assert judgment.hit_outcomes == ()


def test_every_return_path_carries_a_reason_code():
    """코드 없는 판정이 새로 생기면 계측에 구멍이 난다."""
    for finding in (
        _finding([], severity="informational"),
        _finding([]),
        _finding([_hit("pii", "email_address", masked="a@b.example.com")]),
        _finding([_CONFIRMED_HIT]),
        _finding([_BLOCKED_HIT]),
        _finding([_CONFIRMED_HIT, _BLOCKED_HIT]),
    ):
        assert judge_task_finding(finding).reason_code != ""


# ── I2: 판정 자체는 안 바뀐다 ────────────────────────────────────────────

@pytest.mark.parametrize(
    ("finding", "verdict", "persist", "confidence"),
    [
        (_finding([], severity="informational"), "informational", False, 1.0),
        (_finding([]), "rejected", False, 0.0),
        (_finding([_hit("pii", "email_address", masked="a@b.example.com")]),
         "rejected", False, 0.0),
        (_finding([_CONFIRMED_HIT]), "confirmed", True, 0.9),
        (_finding([_BLOCKED_HIT]), "rejected", False, 0.0),
        (_finding([_CONFIRMED_HIT, _BLOCKED_HIT]), "suspected", False, 0.45),
    ],
)
def test_verdict_tuple_is_unchanged(finding, verdict, persist, confidence):
    """★ 이 변경의 안전 논거 — 게이트는 한 건도 안 움직인다.

    이 테스트가 깨지면 계측을 붙인 게 아니라 **게이트를 바꾼 것**이다.
    """
    judgment = judge_task_finding(finding)
    assert judgment.verdict == verdict
    assert judgment.should_persist is persist
    assert judgment.confidence == confidence


def test_mixed_confidence_still_blocks_persistence():
    """확정 hit 이 있어도 약한 hit 이 남아 있으면 영속하지 않는다.

    ⚠️ 부분 영속은 **의도적으로 채택하지 않았다**(2026-08-28). `submit_finding` 은
    terminal 도구라(`cli.py` terminal_tools) ToolSuccess 를 돌려주는 순간 루프가 끝난다
    — 지금은 ToolError 라서 워커가 약한 hit 을 빼고 다시 낼 수 있고, 그 재제출이
    confirmed(0.9)로 영속된다. 부분 영속은 그 수리 턴을 없애고 같은 자산을
    suspected(0.45)로 강등한다.
    """
    judgment = judge_task_finding(_finding([_CONFIRMED_HIT, _BLOCKED_HIT]))
    assert judgment.should_persist is False


# ── I3/I4: 값은 안 실린다, 규칙 이름도 안 실린다 ─────────────────────────

def test_outcomes_never_carry_masked_or_preview():
    """체크섬 무효 주민번호는 탐지기 마스킹을 통과한다 — 실측된 값이다.

    그러니 "마스킹됐으니 안전하다" 에 기대지 않고, 좌표만 담아 표면 자체를 없앤다.
    """
    leaky = "851203-2047318"
    finding = _finding([_hit("pii", "resident_registration_number",
                             masked=leaky, preview=f"rrn={leaky}")])
    judgment = judge_task_finding(finding)
    serialized = json.dumps(judgment.to_dict(), ensure_ascii=False)
    assert leaky not in serialized
    for outcome in judgment.hit_outcomes:
        assert leaky not in json.dumps(outcome.to_dict(), ensure_ascii=False)


def test_reason_names_the_blocked_hit_but_not_the_rule():
    """워커에게 **좌표**는 주고 **규칙 이름**은 주지 않는다.

    어느 hit 을 빼야 할지는 알려줘야 수리가 되지만, 규칙 이름이 노출되면 모델이
    그 이름을 피해가는 쪽으로 맞춘다. 무엇이 부족한지는 required_actions 가 말한다.
    """
    judgment = judge_task_finding(_finding([_CONFIRMED_HIT, _BLOCKED_HIT]))
    assert "[1] credential/password" in judgment.reason
    assert "value_evidence_missing" not in judgment.reason
    # 코드값은 계측 쪽에만 산다.
    assert judgment.hit_outcomes[1].hit_reason_code == "value_evidence_missing"


def test_confirmed_hit_is_not_named_in_the_reason():
    """확정된 hit 을 빼라고 오해시키면 안 된다."""
    judgment = judge_task_finding(_finding([_CONFIRMED_HIT, _BLOCKED_HIT]))
    assert "[0]" not in judgment.reason.split("blocked hits:")[-1]
