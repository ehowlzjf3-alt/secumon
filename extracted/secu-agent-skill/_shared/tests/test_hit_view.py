"""리드 hit view 경계 — 값이 아니라 **모양**이 나가는지 (v3.98).

## 왜 양방향인가

차단만 고정하면 과잉 마스킹을 못 잡는다. 리드가 좌표를 잃으면 판단을 못 하고 2단은
비용만 남는다 — Phase 3 에서 이미 데인 자리라 여기서도 둘 다 고정한다.

## 이 파일이 지키는 사실

1. `masked` 필드는 **항상 마스킹돼 있지 않다**(실측). 그래서 내용 기반 fail-closed 로 판정한다.
2. 순수 count desc 정렬은 대량 PII 가 소수 크리덴셜을 덮는다.
3. 캡은 도구 입력이 아니라 이 모듈이 정한다.
"""
from __future__ import annotations

import pytest

from _shared.hit_view import (
    CATEGORY_PRIORITY, MAX_MASKED_CHARS, MAX_ROLLUP_ROWS, MAX_SHAPE_ROWS,
    aggregate_finding_hits, build_hit_summary, category_rank, value_view,
)

# 실측 표본 (2026-08-21 라이브 DB / finding_lifecycle.extra_json).
PASS_THROUGH = [
    "b77a********e089",             # smb secret/generic_password_assignment
    "ja***@samsungds.net",          # smb pii/email
    "470000***0001",                # smb pii/credit_card
    "02963456******",               # smb pii/kr_rrn
    "----*******************----",  # smb secret/private_key_block
    "N***",                         # smb pii/person_name_with_label
]

MUST_NOT_PASS = [
    # ⚠️ finding extra 의 `masked` — 이건 본문 문장이다. `***` 가 없다.
    "Ulysses 수율 확보 목표는 양산 초기 최대 생산에 기여할 수 있도록 일정 및 수치를",
    # ⚠️ 부분만 마스킹된 크리덴셜 값 — `***` 는 있지만 공백이 있는 값 조각이다.
    "Proxy-Authorization: NTLM TlRMTVNTUAAD (domain=SECDS,user=jh***,workstation=KORC***)",
    "RCP / LOT TRACKING SYSTEM",    # dev_web internal_system/exposed_functionality
    "fdc",                          # semiconductor_process 키워드
    "changeme",
]


# ── value_view: 양방향 ────────────────────────────────────────────────

@pytest.mark.parametrize("raw", PASS_THROUGH)
def test_already_masked_single_token_passes_through(raw: str) -> None:
    """이미 마스킹된 단일 토큰은 그대로 — 리드가 '같은 값인가' 를 판단할 수 있어야 한다."""
    assert value_view(raw) == raw


@pytest.mark.parametrize("raw", MUST_NOT_PASS)
def test_unmasked_value_never_reaches_the_lead(raw: str) -> None:
    """통과 못 하면 값이 **아예** 안 나가고 모양으로 대체된다(fail-closed)."""
    got = value_view(raw)
    assert got.startswith("<len="), got
    assert raw not in got
    # 토막이라도 새면 안 된다 — 앞 6글자 검사.
    assert raw[:6] not in got


def test_the_two_conditions_are_both_required() -> None:
    """`***` 만으로는 부족하다 — 공백 없는 단일 토큰이어야 한다.

    이 조건이 없으면 `'…user=jh***, …'` 같은 값 조각과 `'*** 중요 *** 내부 문서'` 같은
    본문이 전부 통과한다. 실측에서 둘 다 존재했다.
    """
    assert value_view("ab***cd") == "ab***cd"          # 표식 O, 공백 X → 통과
    assert value_view("ab***cd ef").startswith("<len=")  # 표식 O, 공백 O → 차단
    assert value_view("abcd").startswith("<len=")        # 표식 X → 차단


def test_empty_masked_is_explicit() -> None:
    assert value_view("") == "<empty>"
    assert value_view(None) == "<empty>"


def test_long_masked_value_is_capped() -> None:
    raw = "eyJh" + "*" * 300
    got = value_view(raw)
    assert len(got) == MAX_MASKED_CHARS + 1 and got.endswith("…")


# ── 표시 순서 ─────────────────────────────────────────────────────────

def test_priority_beats_raw_count() -> None:
    """★ 순수 count desc 면 email 30,065건이 aws key 2건을 덮는다(실측 공유 1213)."""
    rows = [
        {"category": "pii", "kind": f"email{i}", "verdict": "pending",
         "masked": f"a{i}***@x.com", "count": 30065 - i, "files": 1}
        for i in range(MAX_SHAPE_ROWS + 5)
    ] + [
        {"category": "secret", "kind": "aws_access_key_id", "verdict": "pending",
         "masked": "AKIA***MPLE", "count": 2, "files": 1},
        {"category": "credential", "kind": "ntlm", "verdict": "pending",
         "masked": "ab***cd", "count": 1, "files": 1},
    ]
    out = build_hit_summary(domain="smb", target_id=1, source="smb_file_hit",
                            total=99, shapes=rows)
    kinds = [s["kind"] for s in out["shapes"]]
    assert kinds[0] == "ntlm" and kinds[1] == "aws_access_key_id", kinds
    assert out["shapes_truncated"] > 0


def test_category_rank_is_stable_for_unknown() -> None:
    assert category_rank("credential") < category_rank("secret") < category_rank("pii")
    assert category_rank("pii") < category_rank("semiconductor_process")
    assert category_rank(None) == category_rank("무엇이든")


# ── 캡 ────────────────────────────────────────────────────────────────

def test_rollup_is_capped_and_reports_the_cut() -> None:
    rows = [{"category": "pii", "kind": f"k{i}", "verdict": "pending",
             "count": i, "files": 1} for i in range(MAX_ROLLUP_ROWS + 7)]
    out = build_hit_summary(domain="smb", target_id=1, source="smb_file_hit",
                            total=1, rollup=rows)
    assert len(out["rollup"]) == MAX_ROLLUP_ROWS
    assert out["rollup_truncated"] == 7


def test_input_limit_cannot_exceed_the_module_cap() -> None:
    """도구 입력이 캡을 못 넘긴다 — 상한은 여기가 정한다."""
    rows = [{"category": "pii", "kind": f"k{i}", "verdict": "p",
             "masked": f"a{i}***b", "count": 1, "files": 1}
            for i in range(MAX_SHAPE_ROWS + 30)]
    out = build_hit_summary(domain="smb", target_id=1, source="x", total=1,
                            shapes=rows, limit=999)
    assert len(out["shapes"]) == MAX_SHAPE_ROWS


def test_envelope_is_a_closed_field_set() -> None:
    """어댑터가 무엇을 더 넣어도 봉투에 안 실린다."""
    out = build_hit_summary(
        domain="smb", target_id=1, source="smb_file_hit", total=1,
        shapes=[{"category": "secret", "kind": "k", "verdict": "p",
                 "masked": "ab***cd", "count": 1, "files": 1,
                 "line_preview": "DB_HOST=prod-db-01",
                 "preview": "본문", "raw": "본문"}])
    assert set(out) <= {"domain", "target_id", "source", "total", "rollup",
                        "shapes", "rollup_truncated", "shapes_truncated", "note",
                        # 2026-08-29: 리드가 "닫아도 되나" 를 정할 재료. 의도적 확장이다.
                        "pending_verdict"}
    item = out["shapes"][0]
    assert set(item) <= {"category", "kind", "verdict", "value", "count",
                         "files", "sample_ref", "sample_line"}


def test_sample_ref_is_kept_but_capped() -> None:
    """좌표는 살아야 한다(과잉 마스킹도 결함) — 다만 길이는 캡."""
    ref = "a" * 400
    out = build_hit_summary(
        domain="smb", target_id=1, source="x", total=1,
        shapes=[{"category": "secret", "kind": "k", "verdict": "p",
                 "masked": "ab***cd", "count": 1, "files": 1,
                 "sample_ref": ref, "sample_line": 3365}])
    got = out["shapes"][0]
    assert got["sample_ref"].endswith("…") and len(got["sample_ref"]) == 201
    assert got["sample_line"] == 3365


# ── finding_lifecycle 집계 (smb 외 3도메인 공용) ───────────────────────

_FINDINGS = [
    {"asset": "github:org/repo/a.yml", "status": "open", "extra_json":
     '{"hits": [{"category": "secret", "kind": "gpa", "masked": "ab***cd",'
     ' "line_no": 3}, {"category": "secret", "kind": "gpa", "masked": "ab***cd",'
     ' "line_no": 9}]}'},
    {"asset": "github:org/repo/b.yml", "status": "open", "extra_json":
     '{"hits": [{"category": "secret", "kind": "gpa", "masked": "ab***cd"},'
     ' {"category": "pii", "kind": "email", "masked": "j***@x.com"}]}'},
    {"asset": "github:org/repo/c.yml", "status": "closed", "extra_json": "{}"},
]


def test_finding_hits_aggregate_by_value() -> None:
    """'같은 값이 몇 번' 이 이 도구의 핵심 신호다 — asset 을 넘어 합산된다."""
    total, roll, shapes = aggregate_finding_hits(_FINDINGS)
    assert total == 4
    gpa = [s for s in shapes if s["kind"] == "gpa"][0]
    assert gpa["count"] == 3 and gpa["files"] == 2
    assert gpa["sample_ref"] == "github:org/repo/a.yml"
    assert gpa["sample_line"] == 3
    assert [r["count"] for r in roll if r["kind"] == "gpa"] == [3]


def test_finding_hits_use_finding_status_as_verdict() -> None:
    """per-hit verdict 이 없다 — 없는 것을 있는 척하지 않고 finding status 를 쓴다."""
    _t, roll, _s = aggregate_finding_hits(_FINDINGS)
    assert {r["verdict"] for r in roll} == {"open"}


def test_finding_hit_filters_apply() -> None:
    total, roll, _s = aggregate_finding_hits(_FINDINGS, category="pii")
    assert total == 1 and [r["kind"] for r in roll] == ["email"]
    total, _r, _s = aggregate_finding_hits(_FINDINGS, verdict="closed")
    assert total == 0


def test_malformed_extra_json_does_not_raise() -> None:
    total, roll, shapes = aggregate_finding_hits(
        [{"asset": "a", "status": "open", "extra_json": "{not json"},
         {"asset": "b", "status": "open", "extra_json": '{"hits": "문자열"}'},
         {"asset": "c", "status": "open"}])
    assert (total, roll, shapes) == (0, [], [])


def test_category_priority_is_the_single_source() -> None:
    """state_domain 이 이 상수를 **받아서** 쓴다 — 복사본이 생기면 정렬이 갈린다."""
    import inspect

    from service import state_domain

    src = inspect.getsource(state_domain.share_hit_shapes)
    assert "priority" in src
    for cat in CATEGORY_PRIORITY:
        assert f'"{cat}"' not in src, f"state_domain 에 {cat} 이 복사돼 있다"


# ── 판정 대기 축 (2026-08-29, 항목 B) ──────────────────────────────────────

def test_pending_verdict_is_derived_from_rollup_not_a_new_query():
    """★ rollup 이 `GROUP BY category, kind, agent_verdict` 라 판정 축이 이미 있다.

    따로 세면 쿼리가 늘고(실측 +45~93%, `smb_file_hit.category` 인덱스 부재)
    두 숫자가 갈릴 수 있다.
    """
    from _shared.hit_view import pending_by_category

    roll = [
        {"category": "secret", "kind": "k1", "verdict": "pending", "count": 5},
        {"category": "secret", "kind": "k2", "verdict": "pending", "count": 3},
        {"category": "secret", "kind": "k1", "verdict": "false_positive", "count": 9},
        {"category": "semiconductor_process", "kind": "k3", "verdict": "pending", "count": 2},
    ]
    assert pending_by_category(roll) == {"secret": 8, "semiconductor_process": 2}


def test_domains_without_raw_hits_get_none_not_zero():
    """⚠️ **0 을 내보내면 리드가 "판정 끝났다" 로 읽는다.**

    smb 만 finding 이전 raw hit 을 갖는다. 나머지 셋은 `finding_lifecycle` 기반이라
    verdict 자리에 finding.status 가 들어간다 — 거기서 0 은 거짓말이다.
    """
    from _shared.hit_view import pending_by_category

    assert pending_by_category(None) is None, "raw hit 축이 없는데 0 을 만들었다"
    assert pending_by_category([]) == {}, "탐지 0건과 축 없음은 다르다"


def test_envelope_carries_pending_verdict_but_omits_it_when_absent():
    """봉투는 닫힌 집합이다 — 어댑터가 넣어도 여기 없으면 리드에게 안 간다."""
    from _shared.hit_view import build_hit_summary

    roll = [{"category": "secret", "kind": "k", "verdict": "pending", "count": 7}]
    out = build_hit_summary(domain="smb", target_id=1, source="smb_file_hit",
                            total=7, rollup=roll, shapes=[])
    assert out["pending_verdict"] == {"secret": 7}

    # raw hit 축이 없으면 키 자체가 없어야 한다(0 도, 빈 dict 도 아니다)
    out2 = build_hit_summary(domain="github", target_id=1, source="finding_lifecycle",
                             total=0, rollup=None, shapes=[])
    assert "pending_verdict" not in out2


def test_lead_tools_does_not_flatten_none_rollup_into_a_list():
    """★ `or []` 로 뭉개면 raw hit 축이 없는 도메인이 '판정 대기 0건' 이 된다.

    조용한 거짓말이라 테스트가 없으면 못 잡는다.
    """
    import inspect

    from _shared import lead_tools

    src = inspect.getsource(lead_tools.HitSummaryTool._run) if hasattr(
        lead_tools, "HitSummaryTool") else inspect.getsource(lead_tools)
    assert 'rollup=got.get("rollup") or []' not in src, "None 이 빈 리스트로 뭉개진다"
