"""리드 경계 값 필터 + 위임 봉투 (Phase 2b).

게이트: **검토원이 일부러 크리덴셜/본문/PII 를 요약에 넣어도** 리드가 받는 문자열에는
그 값이 0회 나온다. 두 채널(worker_result.summary / agent_result.json raw payload)
모두. 프롬프트를 믿지 않고 문자열을 센다.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess

from _shared.lead_adapter import (
    LeadAdapter, register_lead_adapter, unregister_lead_adapter,
)
from _shared.lead_masking import (
    EGRESS_ALLOWED, EGRESS_BLOCKED, FAILSAFE_PLACEHOLDER, mask_text_for_lead,
    mask_tool_content, register_lead_masker, unregister_lead_masker,
)
from _shared.lead_tools import (
    LEAD_DOMAIN_KEY, DelegateInspectInput, DelegateInspectTool, ListTargetsInput,
    ListTargetsTool, RecordPivotInput, RecordPivotTool, SetTargetStatusInput,
    SetTargetStatusTool, TargetHitSummaryInput, TargetHitSummaryTool, lead_tools,
)

# 검토원이 실수로(또는 악의적 프롬프트 주입으로) 요약에 실을 법한 값들.
SECRET_VALUES = [
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",   # github PAT (코어가 잡는다)
    "AKIAIOSFODNN7EXAMPLE",                        # AWS key id (egress 전용 규칙이 잡는다)
    "AIzaSyD-1234567890abcdefghijklmnopqrstuv",    # GCP api key (egress 전용)
    "900101-1234568",                              # 유효 체크섬 RRN
    "4111-1111-1111-1111",                         # 카드번호
]

# 정책상 리드가 봐도 되는 값들 — 이게 지워지면 리드가 판단을 못 한다.
ALLOWED_VALUES = [
    "12.23.72.66", "github.samsungds.net", "/data/reports/q3.xlsx",
    "samsungds/bios-fw", "8443", "홍길동", "21001234",
]


def _fake_adapter(tmp_path: Path, calls: list) -> LeadAdapter:
    return LeadAdapter(
        domain="lead_test",
        inspect_agent="fake_inspect",
        statuses=("pending", "tasked", "skipped"),
        claimable_statuses=("pending", "tasked", "skipped"),
        queue_label="테스트 큐",
        list_targets=lambda **kw: [{
            "id": 1, "host": "12.23.72.66", "path": "/data/reports/q3.xlsx",
            "owner": "홍길동", "employee_id": "21001234",
            "note": f"leaked {SECRET_VALUES[0]}",
        }],
        target_detail=lambda tid: {"target_id": tid, "leak": SECRET_VALUES[1]},
        # 어댑터가 `masked` 자리에 마스킹 안 된 값을 넣어도 리드에 닿지 않아야 한다 —
        # 1차는 `hit_view.value_view`(모양으로 대체), 2차는 LeadTool 마스킹.
        scan_summary=lambda tid, **kw: {
            "source": "fake", "total": 2,
            "rollup": [{"category": "secret", "kind": "k", "verdict": "pending",
                        "count": 2, "files": 1}],
            "shapes": [{"category": "secret", "kind": "k", "verdict": "pending",
                        "masked": SECRET_VALUES[2], "count": 2, "files": 1,
                        "sample_ref": "/data/reports/q3.xlsx", "sample_line": 7}],
        },
        run_verb=lambda action, **kw: {"performed": True, "result": "alive",
                                       "detail": SECRET_VALUES[0], "port": 445},
        delegate_input=lambda tid, scope: {"target_id": tid},
        set_status=lambda tid, st, **kw: calls.append((tid, st, kw)) or {"ok": True},
    )


@pytest.fixture()
def lead_ctx(tmp_path):
    calls: list = []
    adapter = _fake_adapter(tmp_path, calls)
    register_lead_adapter(adapter)
    ctx = ToolContext(evidence_dir=tmp_path,
                      metadata={LEAD_DOMAIN_KEY: adapter.domain})
    yield ctx, adapter, calls
    unregister_lead_adapter(adapter.domain)


# ── 값 필터 ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("value", SECRET_VALUES)
def test_blocked_values_never_survive(value):
    text = f"검토원 요약: 여기 {value} 가 있었다"
    assert value not in mask_text_for_lead(text)


@pytest.mark.parametrize("value", ALLOWED_VALUES)
def test_allowed_values_survive(value):
    """정책 허용값이 지워지면 리드가 좌표를 잃는다 — 과잉 마스킹도 결함이다."""
    text = f"타깃: {value} 를 봤다"
    assert value in mask_text_for_lead(text)


def test_credential_url_is_stripped():
    out = mask_text_for_lead("https://user:p4ssw0rd@intra.samsungds.net/x")
    assert "p4ssw0rd" not in out
    assert "intra.samsungds.net" in out   # 호스트는 좌표라 살아야 한다


def test_json_structure_survives_but_values_do_not():
    payload = {"host": "12.23.72.66", "token": SECRET_VALUES[0], "size": 4096}
    out = mask_tool_content(json.dumps(payload, ensure_ascii=False))
    parsed = json.loads(out)          # 구조가 남아야 리드가 파싱한다
    assert parsed["host"] == "12.23.72.66"
    assert parsed["size"] == 4096
    assert SECRET_VALUES[0] not in out


def test_masker_failure_hides_more_not_less():
    """★ fail-safe 방향 — 덜 가리는 쪽으로 실패하면 그게 곧 유출이다."""
    def _boom(_text: str) -> str:
        raise RuntimeError("마스커 폭발")

    register_lead_masker(_boom)
    try:
        out = mask_text_for_lead(f"secret {SECRET_VALUES[0]}")
        assert out == FAILSAFE_PLACEHOLDER
        assert SECRET_VALUES[0] not in out
    finally:
        unregister_lead_masker(_boom)


def test_domain_masker_is_applied():
    def _hide(text: str) -> str:
        return text.replace("사내코드명", "<redacted>")

    register_lead_masker(_hide)
    try:
        assert "사내코드명" not in mask_text_for_lead("프로젝트 사내코드명 진행")
    finally:
        unregister_lead_masker(_hide)


def test_egress_policy_is_a_single_constant():
    """정책이 문서에만 있으면 코드와 갈린다 — 상수가 단일 근거다."""
    assert EGRESS_ALLOWED and EGRESS_BLOCKED
    blocked = " ".join(EGRESS_BLOCKED)
    assert "본문" in blocked and "크리덴셜" in blocked and "PII" in blocked


# ── base 클래스 강제 ───────────────────────────────────────────────────

def test_every_lead_tool_inherits_the_masking_execute():
    """★ `execute` 를 자기가 정의한 리드 도구는 마스킹을 건너뛴다.

    코어 `Tool.__init_subclass__` 는 **자기 클래스에 execute 를 정의한 서브클래스만**
    새로 래핑한다. 즉 `_run` 만 구현하면 `LeadTool.execute`(마스킹)를 못 벗어난다.
    예외는 `delegate_inspect` 하나 — 코어 `AgentTool` 을 상속해야 해서(검문소가
    `super().execute()` 만 허용) 자기 execute 안에서 명시적으로 마스킹한다.
    """
    allowed_exceptions = {"delegate_inspect"}
    offenders = [
        cls.name for cls in lead_tools()
        if "execute" in cls.__dict__ and cls.name not in allowed_exceptions
    ]
    assert not offenders, (
        f"이 리드 도구들이 execute 를 자기가 정의해 마스킹을 우회한다: {offenders}. "
        f"`_run` 을 구현하라.")


def test_list_targets_output_is_masked(lead_ctx):
    ctx, _adapter, _calls = lead_ctx
    res = asyncio.run(ListTargetsTool().execute(ListTargetsInput(), ctx))
    assert isinstance(res, ToolSuccess)
    assert SECRET_VALUES[0] not in res.content
    # 좌표는 살아 있어야 한다
    assert "12.23.72.66" in res.content and "홍길동" in res.content


def test_tool_error_message_is_masked_too(lead_ctx):
    """오류 메시지도 리드 컨텍스트로 들어간다 — 같은 경계를 통과해야 한다."""
    ctx, adapter, _calls = lead_ctx
    res = asyncio.run(SetTargetStatusTool().execute(
        SetTargetStatusInput(target_id=1, status="없는상태",
                             reason=f"tok {SECRET_VALUES[0]}"), ctx))
    assert isinstance(res, ToolError)
    assert SECRET_VALUES[0] not in res.message
    assert "허용" in res.message


def test_set_status_rejects_values_outside_closed_enum(lead_ctx):
    ctx, _adapter, calls = lead_ctx
    res = asyncio.run(SetTargetStatusTool().execute(
        SetTargetStatusInput(target_id=1, status="triaged_completed"), ctx))
    assert isinstance(res, ToolError)
    assert not calls, "닫힌 enum 밖 값인데 DB 쓰기가 일어났다"


def test_record_pivot_persists_rationale(lead_ctx):
    ctx, _adapter, _calls = lead_ctx
    res = asyncio.run(RecordPivotTool().execute(RecordPivotInput(
        from_ref="share 1053", to_target="host 12.23.72.66",
        rationale=f"같은 크리덴셜 {SECRET_VALUES[0]} 재사용 흔적"), ctx))
    assert isinstance(res, ToolSuccess)
    line = (ctx.evidence_dir / "lead_pivots.jsonl").read_text(encoding="utf-8")
    entry = json.loads(line.strip())
    assert entry["from_ref"] == "share 1053"
    # 감사기록은 evidence_dir 안이라 egress 가 아니다 — 여기선 원문 보존이 맞다
    # (코어 audit_log 쪽은 mask_deep 을 이미 태운다).
    assert "재사용 흔적" in entry["rationale"]


def test_missing_adapter_fails_loud(tmp_path):
    ctx = ToolContext(evidence_dir=tmp_path, metadata={LEAD_DOMAIN_KEY: "없는도메인"})
    res = asyncio.run(ListTargetsTool().execute(ListTargetsInput(), ctx))
    assert isinstance(res, ToolError)
    assert "어댑터 미등록" in res.message


def test_no_lead_domain_metadata_fails_loud(tmp_path):
    ctx = ToolContext(evidence_dir=tmp_path, metadata={})
    res = asyncio.run(ListTargetsTool().execute(ListTargetsInput(), ctx))
    assert isinstance(res, ToolError)
    assert LEAD_DOMAIN_KEY in res.message


def test_egress_rules_are_stricter_than_the_finding_gate():
    """★ 방향이 반대라 규칙도 달라야 한다.

    코어 `mask_scanned_text` 는 산문 속 AWS key id 를 통과시킨다 — finding 게이트에선
    옳다(오탐이 비싸다). egress 경계에선 미탐이 비싸므로 여기서만 더 세게 잡는다.
    코어 규칙 자체는 건드리지 않는다(정오탐 게이트 약화/변경 금지 불변식).
    """
    from secu_agent.detectors.text_scan import mask_scanned_text

    prose = "여기 AKIAIOSFODNN7EXAMPLE 가 있었다"
    assert "AKIAIOSFODNN7EXAMPLE" in mask_scanned_text(prose), (
        "코어 동작이 바뀌었다 — 이 테스트의 전제를 다시 확인하라")
    assert "AKIAIOSFODNN7EXAMPLE" not in mask_text_for_lead(prose)


def test_keyword_value_masking_does_not_eat_ordinary_prose():
    """과잉 마스킹은 허용된 실패 방향이지만, 구분자 없는 일반 문장까지 먹으면 리드가 눈을 잃는다."""
    assert mask_text_for_lead("the password policy is weak") == "the password policy is weak"
    # Phase 3a 이후 값은 `***REDACTED***` 가 아니라 **길이 기반 부분 마스킹**으로 바뀐다
    # (리드가 "진짜인가 placeholder 인가" 를 판단할 수 있게). 값 자체는 여전히 안 나간다.
    out = mask_text_for_lead("password is Sup3rSecret!23")
    assert "Sup3rSecret!23" not in out
    assert "len=14" in out


def test_known_residual_is_documented_not_pretended_away():
    """★ 정직: 값 마스킹만으로는 '파일 본문 금지' 를 지킬 수 없다.

    시크릿도 PII 도 없는 본문 20줄은 어떤 마스커도 통과시킨다. 그걸 막는 것은
    ①본문 반환 도구를 리드에 안 주는 것 ②검토원 보고를 닫힌 봉투로 재조립하고
    산문을 하드캡하는 것이다. 이 테스트는 그 사실을 코드로 남긴다.
    """
    benign_body = "def main():\n    return compute(x, y)  # 사내 로직"
    assert mask_text_for_lead(benign_body) == benign_body, (
        "값 마스커가 본문을 막는다고 착각하면 안 된다 — 막는 것은 도구셋과 봉투다")
    # 그래서 봉투의 산문 캡이 경계의 일부다.
    from _shared.inspector_channel import MAX_SUMMARY
    assert MAX_SUMMARY <= 500


def test_hit_summary_output_is_masked(lead_ctx):
    """어댑터가 마스킹 안 된 값을 `masked` 자리에 넣어도 리드에 닿지 않는다.

    ★ 이건 두 겹이 같이 걸린 것이다 — `value_view` 가 모양으로 바꾸고(1차),
    `LeadTool.execute` 가 남은 산문을 마스킹한다(2차). 1차가 없으면 마스커가 못 잡는
    본문 문장이 그대로 나간다(finding extra 의 `masked` 가 실제로 그렇다).
    """
    ctx, _adapter, _calls = lead_ctx
    out = asyncio.run(TargetHitSummaryTool().execute(
        TargetHitSummaryInput(target_id=1), ctx))
    assert isinstance(out, ToolSuccess)
    assert SECRET_VALUES[2] not in out.content
    got = json.loads(out.content)
    assert got["total"] == 2 and got["shapes"], got
    assert got["shapes"][0]["value"].startswith("<len="), got["shapes"][0]
    # 좌표는 살아 있어야 한다 — 과잉 마스킹도 결함이다.
    assert "/data/reports/q3.xlsx" in out.content
    assert got["shapes"][0]["sample_line"] == 7


def test_hit_summary_never_carries_a_body_line(lead_ctx):
    """어댑터가 `line_preview` 를 밀어 넣어도 봉투에 안 실린다(닫힌 필드 집합)."""
    ctx, adapter, _ = lead_ctx
    unregister_lead_adapter(adapter.domain)
    leaky = replace(adapter, scan_summary=lambda tid, **kw: {
        "source": "fake", "total": 1, "rollup": [],
        "shapes": [{"category": "secret", "kind": "k", "verdict": "pending",
                    "masked": "ab***cd", "count": 1, "files": 1,
                    "line_preview": "DB_HOST=prod-db-01 내부 설계 문서 본문입니다",
                    "preview": "또 다른 본문", "sample_ref": "/x.conf"}],
        "line_preview": "봉투 최상위로 밀어넣기",
    })
    register_lead_adapter(leaky)
    try:
        out = asyncio.run(TargetHitSummaryTool().execute(
            TargetHitSummaryInput(target_id=1), ctx))
        assert isinstance(out, ToolSuccess)
        assert "본문" not in out.content, out.content
        assert "line_preview" not in out.content
        assert "prod-db-01" not in out.content
    finally:
        unregister_lead_adapter(leaky.domain)
        register_lead_adapter(adapter)
