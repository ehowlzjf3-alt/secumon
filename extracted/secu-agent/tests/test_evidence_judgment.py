from __future__ import annotations


# judge_web_finding 의 WebFinding 기반 테스트는 secu-agent-skill/tests/test_evidence_judgment_web.py 로 이동


def test_judge_task_finding_rejects_non_informational_without_hits():
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    finding = TaskFinding(
        task_id="task-1",
        task_type="web",
        severity="high",
        summary="exposed .env",
        hits=[],
    )

    judgment = judge_task_finding(finding)

    assert judgment.verdict == "rejected"
    assert judgment.should_persist is False


def test_judge_task_finding_rejects_html_env_preview():
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    finding = TaskFinding(
        task_id="task-1",
        task_type="web",
        severity="critical",
        summary="exposed .env with secret",
        hits=[
            {
                "category": "web_vuln",
                "kind": "exposed_file",
                "masked": None,
                "location": "https://example.test/.env",
                "preview": "<html><title>Access denied</title></html>",
            }
        ],
        recommended_actions=["remove exposed file"],
    )

    judgment = judge_task_finding(finding)

    assert judgment.verdict == "rejected"
    assert judgment.should_persist is False


def test_registered_category_with_preview_confirms():
    """v3.82 U3a: requires_content_evidence=True 로 등록된 plugin 분류는 코어 4종과
    같은 content 증거 게이트를 받는다 — 증거(preview) 있으면 confirmed."""
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding
    from secu_agent.finding_taxonomy import (
        register_finding_category, unregister_finding_category,
    )

    register_finding_category(
        "plugtest_sensitive", label="민감 정보", priority=7,
        requires_content_evidence=True,
    )
    try:
        finding = TaskFinding(
            task_id="task-process-1",
            task_type="web",
            severity="high",
            summary="sensitive information exposed in web page",
            hits=[
                {
                    "category": "plugtest_sensitive",
                    "kind": "recipe_parameter",
                    "masked": None,
                    "location": "https://example.test/process.html",
                    "preview": "internal recipe parameter and yield data",
                }
            ],
            recommended_actions=["restrict page access"],
        )
        judgment = judge_task_finding(finding)
        assert judgment.verdict == "confirmed"
        assert judgment.should_persist is True
    finally:
        unregister_finding_category("plugtest_sensitive")


def test_registered_category_without_evidence_rejected():
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding
    from secu_agent.finding_taxonomy import (
        register_finding_category, unregister_finding_category,
    )

    register_finding_category(
        "plugtest_confidential", label="기밀 정보", priority=6,
        requires_content_evidence=True,
    )
    try:
        finding = TaskFinding(
            task_id="task-business-1",
            task_type="web",
            severity="high",
            summary="confidential information exposed",
            hits=[
                {
                    "category": "plugtest_confidential",
                    "kind": "pricing_forecast",
                    "masked": None,
                    "location": "https://example.test/report",
                    "preview": "",
                }
            ],
            recommended_actions=["restrict page access"],
        )
        judgment = judge_task_finding(finding)
        # v3.54: 무증거(masked/preview 둘 다 없음) sensitive hit 은 rejected (강화).
        assert judgment.verdict == "rejected"
        assert judgment.should_persist is False
        assert "증거 없음" in judgment.reason
    finally:
        unregister_finding_category("plugtest_confidential")


def test_judge_task_finding_rejects_placeholder_keyword_masked():
    """v3.54: masked 가 '... keyword context' 같은 플레이스홀더면 거부 (등록 분류 동일)."""
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding
    from secu_agent.finding_taxonomy import (
        register_finding_category, unregister_finding_category,
    )

    register_finding_category(
        "plugtest_kw", label="민감 키워드", priority=7,
        requires_content_evidence=True,
    )
    try:
        finding = TaskFinding(
            task_id="task-kw-1", task_type="web", severity="high",
            summary="민감 키워드가 노출되었습니다",
            hits=[{
                "category": "plugtest_kw", "kind": "process_keyword_context",
                "masked": "process keyword context",
                "location": "https://example.test/", "preview": "",
            }],
        )
        judgment = judge_task_finding(finding)
        assert judgment.verdict == "rejected"
        assert judgment.should_persist is False
    finally:
        unregister_finding_category("plugtest_kw")


def test_judge_task_finding_accepts_real_sensitive_pii():
    """진짜 민감 PII(주민번호) masked 는 preview 없어도 통과."""
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    finding = TaskFinding(
        task_id="task-pii-1", task_type="web", severity="high",
        summary="인증 없이 주민등록번호 노출",
        hits=[{
            "category": "pii", "kind": "kr_rrn",
            "masked": "900101-1******",
            "location": "https://example.test/doc", "preview": "",
        }],
    )
    judgment = judge_task_finding(finding)
    assert judgment.verdict == "confirmed"


def test_judge_task_finding_rejects_id_only_no_credential():
    """v3.54: PW/크리덴셜 없는 단순 ID(이메일/이름)만 노출은 거부."""
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    finding = TaskFinding(
        task_id="task-id-1", task_type="web", severity="medium",
        summary="인증 없이 직원 이메일/이름 노출",
        hits=[
            {"category": "pii", "kind": "email", "masked": "je***@samsung.com",
             "location": "https://example.test/doc", "preview": "직원: 김철수 je***@samsung.com"},
            {"category": "pii", "kind": "person_name", "masked": "김**",
             "location": "https://example.test/doc", "preview": "담당자 김철수"},
        ],
    )
    judgment = judge_task_finding(finding)
    assert judgment.verdict == "rejected"


def test_judge_task_finding_keeps_id_with_credential():
    """ID + 비밀번호(크리덴셜) 함께면 유지."""
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    finding = TaskFinding(
        task_id="task-cred-1", task_type="web", severity="high",
        summary="인증 없이 계정 ID + 비밀번호 노출",
        hits=[
            {"category": "pii", "kind": "email", "masked": "je***@samsung.com",
             "location": "https://example.test/cfg", "preview": "user=je***@samsung.com"},
            {"category": "credential", "kind": "password", "masked": "p***",
             "location": "https://example.test/cfg", "preview": "password=p***"},
        ],
    )
    judgment = judge_task_finding(finding)
    assert judgment.verdict == "confirmed"


def test_registered_evidence_judge_dispatched_and_honored():
    """v3.82 U3a: task_type 별 plugin judge 가 dispatch 되고 verdict 가 그대로 반영된다.

    구 SMB credential 심층 판정(printer INI·deep-dive·safe_probe 요구)의 행동
    테스트는 plugin 과 함께 skill repo 로 이동 — 코어는 dispatch 계약만 검증.
    """
    from secu_agent.agent.evidence_judgment import (
        _rejected,
        judge_task_finding,
        register_evidence_judge,
        unregister_evidence_judge,
    )
    from secu_agent.agent.schema.finding import TaskFinding

    calls: list[tuple[str, str]] = []

    def judge(finding, hit):
        calls.append((finding.task_type, hit.kind))
        if hit.category == "credential":
            return _rejected("plugin judge rejected", "원문 재확인")
        return None  # 비대상 hit 은 generic 계약으로 폴백

    register_evidence_judge("plugtest_task", judge)
    try:
        finding = TaskFinding(
            task_id="task-judge-1",
            task_type="plugtest_task",
            severity="high",
            summary="plugin judge dispatch 검증",
            hits=[{
                "category": "credential",
                "kind": "generic_password_assignment",
                "location": "scheme://host/path",
                "masked": "password=p***",
                "preview": "password=p***x",
            }],
        )
        judgment = judge_task_finding(finding)
        assert calls == [("plugtest_task", "generic_password_assignment")]
        assert judgment.verdict == "rejected"
        assert judgment.should_persist is False
        assert "plugin judge rejected" in judgment.reason
        assert judgment.required_actions == ("원문 재확인",)
    finally:
        unregister_evidence_judge("plugtest_task")


def test_evidence_judge_none_falls_back_to_generic_contract():
    """plugin judge 가 None 을 반환하면 generic 계약이 그대로 적용된다."""
    from secu_agent.agent.evidence_judgment import (
        judge_task_finding,
        register_evidence_judge,
        unregister_evidence_judge,
    )
    from secu_agent.agent.schema.finding import TaskFinding

    register_evidence_judge("plugtest_fallthrough", lambda finding, hit: None)
    try:
        finding = TaskFinding(
            task_id="task-judge-2",
            task_type="plugtest_fallthrough",
            severity="high",
            summary="폴백 검증 — credential 증거 라인 있음",
            hits=[{
                "category": "credential",
                "kind": "password",
                "location": "scheme://host/cfg",
                "masked": "password=p***",
                "preview": "password=p***x",
            }],
        )
        judgment = judge_task_finding(finding)
        assert judgment.verdict == "confirmed"
    finally:
        unregister_evidence_judge("plugtest_fallthrough")


def test_register_evidence_judge_duplicate_is_error():
    import pytest

    from secu_agent.agent.evidence_judgment import (
        register_evidence_judge,
        unregister_evidence_judge,
    )

    register_evidence_judge("plugtest_dup", lambda f, h: None)
    try:
        with pytest.raises(ValueError, match="이미 등록됨"):
            register_evidence_judge("plugtest_dup", lambda f, h: None)
    finally:
        assert unregister_evidence_judge("plugtest_dup") is True
    assert unregister_evidence_judge("plugtest_dup") is False


def test_unregistered_task_type_uses_generic_contract_only():
    """judge 미등록 task_type 은 generic 계약만 — 증거 있는 credential 은 confirmed."""
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    finding = TaskFinding(
        task_id="task-judge-3",
        task_type="smb",
        severity="high",
        summary="미등록 task_type 폴백 — 코어는 도메인 judge 를 모름",
        hits=[{
            "category": "credential",
            "kind": "password",
            "location": "smb://10.0.0.5/Public/app.ini",
            "masked": "password=p***",
            "preview": "password=p***x",
        }],
    )
    judgment = judge_task_finding(finding)
    assert judgment.verdict == "confirmed"


def test_is_low_value_only_email_only_is_noise():
    """v3.78 F1: 이메일(식별자-only PII)만 있으면 노이즈."""
    from secu_agent.agent.evidence_judgment import is_low_value_only

    assert is_low_value_only([{"category": "pii", "kind": "email"}]) is True
    assert is_low_value_only([
        {"category": "pii", "kind": "email"},
        {"category": "pii", "kind": "email"},
    ]) is True


def test_is_low_value_only_email_plus_secret_kept():
    """v3.78 F1: 이메일 + 진짜 secret 동반이면 유지(#90 회귀가드)."""
    from secu_agent.agent.evidence_judgment import is_low_value_only

    assert is_low_value_only([
        {"category": "pii", "kind": "email"},
        {"category": "secret", "kind": "aws_access_key_id"},
    ]) is False


def test_is_low_value_only_vehicle_plate_only_is_noise():
    """차량번호 단독 PII 는 이번 finding 대상에서 제외."""
    from secu_agent.agent.evidence_judgment import is_low_value_only

    assert is_low_value_only([
        {"category": "pii", "kind": "vehicle_plate_images"},
        {"category": "pii", "kind": "license_plate"},
    ]) is True


def test_is_low_value_only_high_value_pii_kept():
    """v3.78 F1: 주민번호/카드/계좌/전화는 그 자체로 민감 → 유지."""
    from secu_agent.agent.evidence_judgment import is_low_value_only

    for kind in ("kr_rrn", "credit_card", "bank_account_with_label", "kr_phone"):
        assert is_low_value_only([{"category": "pii", "kind": kind}]) is False, kind


def test_is_low_value_only_secret_only_kept():
    from secu_agent.agent.evidence_judgment import is_low_value_only

    assert is_low_value_only([{"category": "secret", "kind": "github_pat"}]) is False


def test_is_low_value_only_email_plus_nonpii_kept():
    """v3.78.1 #10: 이메일 + 비-pii 카테고리(attack_surface 등) → 진짜 신호 → 유지."""
    from secu_agent.agent.evidence_judgment import is_low_value_only

    assert is_low_value_only([
        {"category": "pii", "kind": "email"},
        {"category": "attack_surface", "kind": "scoped_domain"},
    ]) is False
    assert is_low_value_only([
        {"category": "pii", "kind": "email"},
        {"category": "internal_system", "kind": "host"},
    ]) is False
    assert is_low_value_only([
        {"category": "pii", "kind": "vehicle_plate_images"},
        {"category": "misconfig", "kind": "smb_anonymous_guest_readable_share"},
    ]) is False


def test_is_low_value_only_empty_is_not_noise():
    from secu_agent.agent.evidence_judgment import is_low_value_only

    assert is_low_value_only([]) is False


def test_is_low_value_only_accepts_attr_objects():
    """service_task 는 dict, submit_finding 은 객체(.category/.kind) — 둘 다 지원."""
    from types import SimpleNamespace

    from secu_agent.agent.evidence_judgment import is_low_value_only

    assert is_low_value_only([SimpleNamespace(category="pii", kind="email")]) is True
    assert is_low_value_only([SimpleNamespace(category="pii", kind="kr_rrn")]) is False


def test_judge_task_finding_rejects_vehicle_plate_only_pii():
    """submit_finding 경로에서도 차량번호 단독 PII 는 저장하지 않는다."""
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    finding = TaskFinding(
        task_id="task-smb-vehicle-1",
        task_type="smb",
        severity="medium",
        summary="차량번호 이미지 노출",
        hits=[{
            "category": "pii",
            "kind": "vehicle_plate_images",
            "masked": "차량등록번호: 경기**아****",
            "location": "smb://10.0.0.5/image/CH01.jpg",
            "preview": "차량번호판이 보이는 이미지",
        }],
    )

    judgment = judge_task_finding(finding)

    assert judgment.verdict == "rejected"
    assert judgment.should_persist is False


def test_judge_task_finding_confirms_attack_surface_url_location():
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    finding = TaskFinding(
        task_id="task-attack-surface-1",
        task_type="web",
        severity="low",
        summary="additional scoped web asset discovered",
        hits=[
            {
                "category": "attack_surface",
                "kind": "scoped_domain",
                "masked": None,
                "location": "https://app.example.test/login",
                "preview": "",
            }
        ],
        recommended_actions=["review ownership and exposure"],
    )

    judgment = judge_task_finding(finding)

    assert judgment.verdict == "confirmed"
    assert judgment.should_persist is True


def test_judge_task_finding_rejects_unknown_or_empty_category():
    # audit #6: 미지/공백 category 는 어느 증거 분기에도 안 걸려 confirmed_count=0·
    # blockers=[] 로 "0 hit(s) passed" confirmed 로 영속되던 fail-closed 위반.
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding

    for cat in ("", "totally_unknown_zzz"):
        finding = TaskFinding(
            task_id="task-unknown-cat",
            task_type="generic",  # plugin_judge 없음
            severity="high",
            summary="mystery finding",
            hits=[{
                "category": cat,
                "kind": "mystery",
                "masked": None,
                "location": "https://example.test/x",
                "preview": "whatever",
            }],
        )
        judgment = judge_task_finding(finding)
        assert judgment.should_persist is False, cat
        assert judgment.verdict == "rejected", cat


# ── B2/B1: evidence-judge 정확도 (위조/placeholder false-accept 봉쇄) ──────

def _judge(hits, *, severity="high", summary="위협 서술", task_type="web"):
    from secu_agent.agent.evidence_judgment import judge_task_finding
    from secu_agent.agent.schema.finding import TaskFinding
    return judge_task_finding(TaskFinding(
        task_id="t", task_type=task_type, severity=severity,
        summary=summary, hits=hits,
    ))


def test_b2_misconfig_summary_only_rejected():
    # B2: summary 만 있고 관찰 증거(preview/masked/probe) 없는 misconfig → 거부(고무도장 제거).
    j = _judge([{"category": "misconfig", "kind": "server_status",
                 "location": "https://x.test/server-status",
                 "masked": "", "preview": ""}],
               summary="server-status 노출로 보임")
    assert j.should_persist is False


def test_b2_misconfig_with_observed_preview_confirmed():
    # B2: 실제 관찰한 preview 있으면 통과(정당 회귀).
    j = _judge([{"category": "misconfig", "kind": "server_status",
                 "location": "https://x.test/server-status",
                 "masked": "", "preview": "Apache Server Status for x.test\nUptime: ..."}])
    assert j.verdict == "confirmed"


def test_b1_credential_fabricated_prose_rejected():
    # B1: 값 없는 산문/라벨만인 credential → 거부(위조 방지).
    j = _judge([{"category": "credential", "kind": "generic",
                 "location": "https://x.test/cfg",
                 "masked": "context: a password field was found",
                 "preview": "the page appears to reference a password"}])
    assert j.should_persist is False


def test_b1_credential_keyvalue_confirmed():
    # B1: 실제 값을 담은 줄(key=value) → 통과(정당 회귀).
    j = _judge([{"category": "credential", "kind": "password",
                 "location": "https://x.test/cfg",
                 "masked": "password=hun***", "preview": "password=hun***"}])
    assert j.verdict == "confirmed"


def test_b1_secret_akia_value_confirmed():
    # B1: 토큰 접두어(AKIA) 있는 secret → 통과.
    j = _judge([{"category": "secret", "kind": "aws_access_key_id",
                 "location": "https://x.test/cfg",
                 "masked": "AKIA1234****", "preview": "AKIA1234****EXAMPLE"}])
    assert j.verdict == "confirmed"


def test_b1_secret_masked_only_no_value_rejected():
    # B1: 형식 힌트 없는 완전마스킹 secret(위조 가능) → 거부.
    j = _judge([{"category": "secret", "kind": "generic",
                 "location": "https://x.test/cfg",
                 "masked": "***", "preview": "some secret is here"}])
    assert j.should_persist is False


# ── B1/B2 하드닝(codex 합심): 정교한 위조 우회 차단 ──────────────────────

def test_b1_credential_id_key_only_rejected():
    # username=alice(ID key)만으로는 credential 확정 금지(값 아님).
    j = _judge([{"category": "credential", "kind": "generic",
                 "location": "https://x.test/cfg",
                 "masked": "username=alice", "preview": "username=alice"}])
    assert j.should_persist is False


def test_b1_secret_detector_shape_confirmed_without_keyvalue():
    # 실제 secret 형상(AKIA/ghp)은 key=value 없이 masked/preview 에 있어도 통과.
    for masked in ("AKIA1234567890ABCDEF", "ghp_" + "a" * 36):
        j = _judge([{"category": "secret", "kind": "generic",
                     "location": "https://x.test/cfg",
                     "masked": masked, "preview": masked}])
        assert j.verdict == "confirmed", masked


def test_b1_assertion_masked_rejected():
    # <masked,len=N> / value_present=True 같은 주장만인 masked 는 거부.
    for masked in ("<masked,len=8>", "value_present=True", "****"):
        j = _judge([{"category": "credential", "kind": "password",
                     "location": "https://x.test/cfg",
                     "masked": masked, "preview": ""}])
        assert j.should_persist is False, masked


def test_b1_probe_attempted_false_rejected_but_success_confirmed():
    # attempted=False probe = 미시도 → 거부; attempted 성공 probe → 통과.
    base = {"category": "credential", "kind": "generic",
            "location": "https://x.test/login", "masked": "", "preview": "credential found"}
    j_fail = _judge([{**base, "validation": {"kind": "credential_reachability", "attempted": False}}])
    assert j_fail.should_persist is False
    j_ok = _judge([{**base, "validation": {"kind": "credential_reachability",
                                           "attempted": True, "status": 200}}])
    assert j_ok.verdict == "confirmed"


def test_b2_whitespace_and_assertion_masked_rejected():
    for masked in ("   ", "<masked,len=4>"):
        j = _judge([{"category": "misconfig", "kind": "server_status",
                     "location": "https://x.test/s", "masked": masked, "preview": ""}])
        assert j.should_persist is False, masked


def test_isolation_pii_internal_masked_only_still_lenient():
    # 격리: pii/internal_system 은 실제 masked 값만 있어도 통과(마스킹 플로어 압박 금지).
    j = _judge([{"category": "internal_system", "kind": "hostname",
                 "location": "https://x.test", "masked": "db-prod-01.corp", "preview": ""}])
    assert j.verdict == "confirmed"
