"""크리덴셜 핸들 — 값 없는 좌표만 (Phase 2c)."""
from __future__ import annotations

import json

from _shared.cred_handle import FORBIDDEN_HANDLE_KEYS, CredHandle, smb_cred_handles


def test_handle_shape_is_value_free():
    h = CredHandle(id=7, type="smb_account", source_ref="smb_credential#7",
                   validated=True, scope_count=12).as_dict()
    assert set(h) == {"id", "type", "source_ref", "validated", "scope_count"}
    assert not (set(h) & FORBIDDEN_HANDLE_KEYS)


def test_handles_never_carry_password_ref(tmp_db, seed):
    """★ `password_ref`(=`env:VAR`) 는 값은 아니지만 내부 구성 정보다 — 사외에 줄 이유가 없다."""
    seed.credential(name="c1", username="svc", env_var="TEST_LEAD_CRED_PW")
    handles = smb_cred_handles(enabled_only=False)
    assert handles, "핸들이 비었다 — cred_list 배선 확인"
    blob = json.dumps(handles, ensure_ascii=False)
    assert "env:" not in blob
    assert "TEST_LEAD_CRED_PW" not in blob
    for h in handles:
        assert not (set(h) & FORBIDDEN_HANDLE_KEYS)


def test_scope_count_reflects_reuse_breadth(tmp_db, seed):
    """재사용 폭은 위험도 신호다 — 리드가 이걸 보고 우선순위를 정한다."""
    cid = seed.credential(name="c2", username="svc2", env_var="TEST_LEAD_CRED_PW2")
    seed.share(host="10.0.0.1", share="s1", cred_id=cid)
    seed.share(host="10.0.0.2", share="s2", cred_id=cid)
    got = {h["id"]: h for h in smb_cred_handles(enabled_only=False)}
    assert got[cid]["scope_count"] == 2
    assert got[cid]["validated"] is True   # seed 는 auth_login_ok=True


def test_runner_path_has_no_lead_directive_but_keeps_the_report_hint(tmp_path):
    """리드 없이 도는 러너 경로에는 **지시**가 없다. 보고 안내는 남는다.

    Phase 2 에서는 여기서 빈 문자열을 요구했다(오늘 프롬프트와 바이트 동일). Phase 3a 가
    그 계약을 의도적으로 바꿨다 — 워커가 **누가 띄웠느냐에 따라 다르게 동작하면 안 된다**
    (원칙 ②). 보고 채널은 러너 경로에서도 유용하고, 안 불러도 워커는 오늘처럼 끝난다.
    """
    from _shared.inspect_contract import _lead_directive

    out = _lead_directive({"target": {"host": "10.0.0.1"}})
    assert "리드 지시" not in out
    assert "report_inspection" in out
    assert _lead_directive({}) == out


def test_lead_directive_carries_question_scope_and_cred():
    """★ 이게 없으면 delegate_inspect 의 question/scope/use_cred 가 조용히 버려진다."""
    from _shared.inspect_contract import _lead_directive

    out = _lead_directive({"target": {
        "question": "CI 설정에 배포 크리덴셜이 있나?",
        "scope": ".github/workflows/",
        "cred_id": 7,
    }})
    assert "CI 설정에 배포 크리덴셜이 있나?" in out
    assert ".github/workflows/" in out
    assert "cred_id=7" in out
    assert "평문" in out, "요약에 평문을 쓰지 말라는 지시가 빠졌다"
