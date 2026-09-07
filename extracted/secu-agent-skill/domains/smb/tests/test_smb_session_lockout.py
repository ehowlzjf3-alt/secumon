"""v3.79 ③-2: walk/fetch 용 _smb_session lockout-safe (codex 분석 A1).

기존: _smb_session(walk_share/fetch_file 이 매 호출 사용)은 env 계정 실패 시
무조건 guest 폴백 — lockout 감지/회로차단 없음. 비번 변경·잠금 상태에서 장기
스윕(파일 수천 개 = 세션 수백 개)이 돌면 LOGON_FAILURE 가 잠금 임계(보통 5회)를
즉시 초과 → 계정잠금 (운영 1순위 안전규칙 위반).

수정: discovery 의 _auth_mode_allowed/_AUTH_DISABLED_REASON 회로차단을 공유하되,
권한 없음과 credential login 실패를 분리한다. LOCKED_OUT 은 즉시 전역 차단,
단일 host LOGON_FAILURE 는 host-scoped auth skip, 여러 host 에서 반복되면 credential
drift 로 보고 전역 차단한다.
"""
from __future__ import annotations

import pytest

from domains.smb.plugin.agent_types import smb as smb_mod


class _FakeConn:
    """impacket SMBConnection 흉내 — login 호출 기록."""
    login_calls: list[tuple[str, str]] = []
    fail_user_with: str | None = None  # env 계정 login 시 이 메시지로 raise

    def __init__(self, *a, **k):
        pass

    def login(self, user: str, pw: str) -> None:
        _FakeConn.login_calls.append((user, pw))
        if user and user not in ("guest", "thisuserisjustguestnotreal"):
            if _FakeConn.fail_user_with:
                raise Exception(_FakeConn.fail_user_with)

    def logoff(self) -> None:
        pass

    def close(self) -> None:
        pass


@pytest.fixture()
def fake_smb(monkeypatch):
    _FakeConn.login_calls = []
    _FakeConn.fail_user_with = None
    monkeypatch.setattr(smb_mod, "_get_smb_class", lambda: _FakeConn)
    monkeypatch.setenv("SMB_USERNAME", "svc_agent_type")
    monkeypatch.setenv("SMB_PASSWORD", "pw")
    monkeypatch.setenv("SMB_AUTH_ENABLED", "true")
    monkeypatch.setenv("SMB_AUTH_FAILURE_GLOBAL_THRESHOLD", "2")
    smb_mod.reset_auth_lockout_flag()
    yield _FakeConn
    smb_mod.reset_auth_lockout_flag()


def _auth_attempts() -> int:
    return sum(1 for u, _ in _FakeConn.login_calls if u == "svc_agent_type")


def test_logon_failure_disables_auth_for_host_only(fake_smb):
    fake_smb.fail_user_with = "SMB SessionError: STATUS_LOGON_FAILURE"
    # 1번째 세션 — auth 1회 실패 후 guest 폴백
    with smb_mod._smb_session("10.0.0.1"):
        pass
    assert _auth_attempts() == 1
    assert fake_smb.login_calls[-1] == ("thisuserisjustguestnotreal", "")
    assert smb_mod._auth_mode_allowed("10.0.0.1")[0] is False
    assert smb_mod._auth_mode_allowed("10.0.0.2")[0] is True
    # 같은 host 재시도는 auth 없이 곧장 guest (잠금 예방)
    for _ in range(3):
        with smb_mod._smb_session("10.0.0.1"):
            pass
    assert _auth_attempts() == 1, "host LOGON_FAILURE 후 같은 host auth 재시도 — 계정잠금 위험"
    assert all(u != "svc_agent_type" for u, _ in fake_smb.login_calls[2:])


def test_logon_failure_on_multiple_hosts_disables_auth_globally(fake_smb):
    fake_smb.fail_user_with = "SMB SessionError: STATUS_LOGON_FAILURE"
    with smb_mod._smb_session("10.0.0.1"):
        pass
    assert smb_mod._auth_mode_allowed()[0] is True
    with smb_mod._smb_session("10.0.0.2"):
        pass
    allowed, reason = smb_mod._auth_mode_allowed()
    assert allowed is False and "2 hosts" in reason


def test_locked_out_disables_auth_for_process(fake_smb):
    fake_smb.fail_user_with = "SMB SessionError: STATUS_ACCOUNT_LOCKED_OUT"
    with smb_mod._smb_session("10.0.0.1"):
        pass
    with smb_mod._smb_session("10.0.0.2"):
        pass
    assert _auth_attempts() == 1
    # 차단 사유가 discovery 쪽(_auth_mode_allowed)에도 공유됨
    allowed, reason = smb_mod._auth_mode_allowed()
    assert allowed is False and "LOCKED_OUT" in reason


def test_other_auth_failure_disables_auth_for_process(fake_smb):
    fake_smb.fail_user_with = "SMB SessionError: STATUS_PASSWORD_EXPIRED"
    with smb_mod._smb_session("10.0.0.1"):
        pass
    with smb_mod._smb_session("10.0.0.2"):
        pass
    assert _auth_attempts() == 1
    allowed, reason = smb_mod._auth_mode_allowed()
    assert allowed is False and "AUTH_ACCOUNT_UNAVAILABLE" in reason


def test_auth_success_no_circuit_break(fake_smb):
    for _ in range(3):
        with smb_mod._smb_session("10.0.0.1"):
            pass
    assert _auth_attempts() == 3  # 정상 계정은 매 세션 auth 사용
    # guest 폴백 없었음
    assert all(u == "svc_agent_type" for u, _ in fake_smb.login_calls)


def test_auth_env_disabled_goes_straight_to_guest(fake_smb, monkeypatch):
    monkeypatch.setenv("SMB_AUTH_ENABLED", "false")
    with smb_mod._smb_session("10.0.0.1"):
        pass
    assert _auth_attempts() == 0
    assert fake_smb.login_calls and fake_smb.login_calls[0][0] == "thisuserisjustguestnotreal"


def test_reset_clears_circuit(fake_smb):
    fake_smb.fail_user_with = "STATUS_LOGON_FAILURE"
    with smb_mod._smb_session("10.0.0.1"):
        pass
    fake_smb.fail_user_with = None  # 비번 고침
    smb_mod.reset_auth_lockout_flag()
    with smb_mod._smb_session("10.0.0.1"):
        pass
    assert _auth_attempts() == 2  # reset 후 auth 재개
