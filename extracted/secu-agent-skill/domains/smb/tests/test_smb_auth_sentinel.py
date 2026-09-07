"""auth 회로차단기가 **정상 host 2대** 때문에 스윕 전체를 guest 전용으로 만드는 것을 막는다.

배경(2026-08-17 실측) — W34 수집 패스 로그 6,655줄 중 26번째 줄:

    04:17:17,673 LOGON_FAILURE on 10.97.140.31 — 이 host 에서만 auth 모드 skip
    04:17:17,695 LOGON_FAILURE on 2 hosts — 이번 프로세스 동안 auth 모드 자동 중단

스윕 시작 **7초 만에** auth 가 꺼졌고, 남은 1,630여 subnet(22,470 host)이 전부
guest 전용으로 돌았다. 결과:

    DB 의 실공유(print$ 제외)   399건
    이번 주 관측                74건  ← 전부 guest/null
    auth 필요 공유             300건  ← 2026-06-13 이후 재확인 불가

회로를 끊은 `10.97.140.31` 은 **DB 에 기록조차 없는 host** 였다. 즉 "우리 비번이
틀렸다"는 증거가 아니라 그냥 도메인 계정을 안 받는 장비(워크그룹 PC·NAS·어플라이언스)
였을 뿐인데, 임계값이 **절대 개수 2** 라 22,470 host 규모에서는 사실상 매번 즉시 걸린다.

라이브 프로브로 확정: `10.97.130.174`(과거 auth 성공 host)에 1회 로그인 → **성공**,
공유 3개(`print$`,`SharedData`,`single`) 조회됨. 자격증명은 멀쩡했다.

수정의 요지는 임계값을 올리는 게 **아니다**(그건 잠금 위험을 그대로 키운다).
패스 시작에 **알려진 정상 host 로 1회 확인**해서 (a)비번 문제와 (b)host 성질을
가른 뒤, 확정되면 개별 host 실패로 전역 회로를 끊지 않는다.
"""
from __future__ import annotations

import pytest

from domains.smb.plugin.agent_types import smb as smb_mod

LOGON_FAILURE = "STATUS_LOGON_FAILURE"
LOCKED_OUT = "STATUS_ACCOUNT_LOCKED_OUT"


class _FakeConn:
    """impacket SMBConnection 흉내. host 별로 auth login 성패를 지정한다."""

    fail_auth_on: dict[str, str] = {}   # host -> 에러 메시지
    current_host: str = ""
    login_calls: list[tuple[str, str]] = []

    def __init__(self, remoteName="", remoteHost="", *a, **k):
        _FakeConn.current_host = remoteHost or remoteName

    def login(self, user: str, pw: str) -> None:
        _FakeConn.login_calls.append((_FakeConn.current_host, user))
        if user and user not in ("guest", "thisuserisjustguestnotreal"):
            msg = _FakeConn.fail_auth_on.get(_FakeConn.current_host)
            if msg:
                raise Exception(msg)

    def logoff(self) -> None: ...
    def close(self) -> None: ...


@pytest.fixture()
def fake_smb(monkeypatch):
    _FakeConn.fail_auth_on = {}
    _FakeConn.login_calls = []
    monkeypatch.setattr(smb_mod, "_get_smb_class", lambda: _FakeConn)
    monkeypatch.setattr(smb_mod, "tcp_alive", lambda h, *a, **k: True)
    monkeypatch.setenv("SMB_USERNAME", "svc_agent_type")
    monkeypatch.setenv("SMB_PASSWORD", "pw")
    monkeypatch.setenv("SMB_AUTH_ENABLED", "true")
    monkeypatch.setenv("SMB_AUTH_SENTINEL", "true")
    monkeypatch.setenv("SMB_AUTH_FAILURE_GLOBAL_THRESHOLD", "2")
    smb_mod.reset_auth_lockout_flag()
    yield _FakeConn
    smb_mod.reset_auth_lockout_flag()


def _auth_globally_disabled() -> bool:
    allowed, _ = smb_mod._auth_mode_allowed()
    return not allowed


# ── 센티넬 ────────────────────────────────────────────────────────────────

def test_sentinel_confirms_the_credential_and_stops_at_one_attempt(fake_smb) -> None:
    ok, why = smb_mod.verify_auth_credential(["10.0.0.1", "10.0.0.2", "10.0.0.3"])
    assert ok, why
    assert smb_mod._AUTH_VERIFIED_THIS_PROCESS
    auth_logins = [h for h, u in fake_smb.login_calls if u == "svc_agent_type"]
    assert auth_logins == ["10.0.0.1"], "성공했는데도 추가 시도를 했다 — 잠금 위험"


def test_sentinel_failure_stops_the_pass_in_one_attempt(fake_smb) -> None:
    """★ 잠금 위험은 늘지 않는다: 실패해도 시도는 1회, 기존 동작(2회)보다 적다."""
    fake_smb.fail_auth_on = {"10.0.0.1": LOGON_FAILURE, "10.0.0.2": LOGON_FAILURE}
    ok, why = smb_mod.verify_auth_credential(["10.0.0.1", "10.0.0.2"])
    assert not ok
    assert "자격증명 문제" in why
    assert _auth_globally_disabled(), "센티넬이 실패했는데 auth 를 계속 시도한다"
    auth_logins = [h for h, u in fake_smb.login_calls if u == "svc_agent_type"]
    assert auth_logins == ["10.0.0.1"], "실패 후에도 다음 host 를 시도했다 — 잠금 위험"


def test_sentinel_never_touches_hosts_that_are_not_alive(monkeypatch, fake_smb) -> None:
    """tcp_alive 는 로그인이 아니다 — 죽은 host 에 로그인 시도를 낭비하면 안 된다."""
    monkeypatch.setattr(smb_mod, "tcp_alive", lambda h, *a, **k: h == "10.0.0.9")
    ok, _ = smb_mod.verify_auth_credential(["10.0.0.1", "10.0.0.2", "10.0.0.9"])
    assert ok
    assert [h for h, u in fake_smb.login_calls if u == "svc_agent_type"] == ["10.0.0.9"]


def test_sentinel_can_be_switched_off(monkeypatch, fake_smb) -> None:
    monkeypatch.setenv("SMB_AUTH_SENTINEL", "false")
    ok, why = smb_mod.verify_auth_credential(["10.0.0.1"])
    assert not ok and "SMB_AUTH_SENTINEL=false" in why
    assert not fake_smb.login_calls
    assert not _auth_globally_disabled(), "센티넬을 끈 것이 auth 를 끄는 것이 되면 안 된다"


# ── 검증 후 개별 host 실패 ────────────────────────────────────────────────

def test_verified_credential_survives_many_host_login_failures(fake_smb) -> None:
    """★ 이것이 이번 사고의 핵심 회귀 — 정상 host 몇 대가 스윕 전체를 죽이면 안 된다."""
    assert smb_mod.verify_auth_credential(["10.0.0.1"])[0]
    for i in range(2, 12):  # 임계값 2 를 한참 넘는 10대
        smb_mod._disable_auth_after_login_failure(
            f"10.9.9.{i}", "list_shares_modes", Exception(LOGON_FAILURE))
    assert not _auth_globally_disabled(), (
        "자격증명이 검증됐는데도 host 실패로 전역 auth 가 꺼졌다 — 2026-08-17 사고 재발"
    )
    for i in range(2, 12):
        allowed, _ = smb_mod._auth_mode_allowed(f"10.9.9.{i}")
        assert not allowed, "실패한 host 는 여전히 개별 skip 되어야 한다"
    allowed, _ = smb_mod._auth_mode_allowed("10.9.9.200")
    assert allowed, "무관한 host 까지 막혔다"


def test_lockout_still_trips_globally_even_after_verification(fake_smb) -> None:
    """⚠️ 계정 잠금은 host 성질이 아니라 **계정 상태** — 검증 이력과 무관하게 전역 중단."""
    assert smb_mod.verify_auth_credential(["10.0.0.1"])[0]
    smb_mod._disable_auth_after_login_failure(
        "10.9.9.5", "list_shares_modes", Exception(LOCKED_OUT))
    assert _auth_globally_disabled(), "ACCOUNT_LOCKED_OUT 이 전역 중단을 못 시켰다"


def test_unverified_credential_still_trips_on_threshold(fake_smb) -> None:
    """센티넬이 판정 못 했을 땐 기존 보호(임계값)가 그대로 산다."""
    for i in (1, 2):
        smb_mod._disable_auth_after_login_failure(
            f"10.9.9.{i}", "list_shares_modes", Exception(LOGON_FAILURE))
    assert _auth_globally_disabled()


def test_reset_clears_the_verification(fake_smb) -> None:
    """패스마다 다시 확인해야 한다 — 비번은 패스 사이에 바뀔 수 있다."""
    assert smb_mod.verify_auth_credential(["10.0.0.1"])[0]
    smb_mod.reset_auth_lockout_flag()
    assert not smb_mod._AUTH_VERIFIED_THIS_PROCESS


def test_ordinary_auth_success_also_counts_as_verification(fake_smb) -> None:
    """센티넬이 없어도 스윕 중 auth 성공 1건이면 자격증명은 증명된 것이다."""
    smb_mod._note_auth_success("10.5.5.5")
    for i in range(1, 6):
        smb_mod._disable_auth_after_login_failure(
            f"10.9.9.{i}", "list_shares_modes", Exception(LOGON_FAILURE))
    assert not _auth_globally_disabled()


# ── 패스 오너 배선 ────────────────────────────────────────────────────────

def test_pass_owners_call_the_sentinel_right_after_reset() -> None:
    """reset 직후여야 한다 — reset 이 검증 플래그를 지우므로 순서가 뒤집히면 무효."""
    import inspect

    from service.collector import runner, sweep_core

    for mod in (runner, sweep_core):
        src = inspect.getsource(mod)
        assert "verify_auth_credential" in src, f"{mod.__name__}: 센티넬 미배선"
        reset_at = src.index("reset_auth_lockout_flag()")
        verify_at = src.index("verify_auth_credential")
        assert verify_at > reset_at, (
            f"{mod.__name__}: 센티넬이 reset 보다 먼저다 — reset 이 검증을 지운다"
        )


# ── cold start: 센티넬이 판정할 근거가 아예 없는 패스 ────────────────────────
#
# 2026-08-26 실사고. DB 를 비우고 풀 스윕을 시작했더니:
#   · `smb_auth_verified_hosts()` 가 `smb_share WHERE auth_login_ok=1` 에서 오는데
#     그 테이블을 비웠으므로 **후보 0개**
#   · 센티넬이 아무 판정도 못 하고 "판정 불가" 로 빠짐
#   · 시작 0.5초 만에 LOGON_FAILURE 2건 도착 → 임계값 2 도달 → **전역 auth 차단**
#   · 이후 15시간, 28,247 host 를 guest 로만 훑어 공유 70개 관측
#   · 그 뒤 40개 host 만 auth 로 다시 붙어보니 **100% 성공, 공유 277개**
#
# 6주 전 사고(74→234)를 막으려고 만든 센티넬이 **자기 기억에 의존해서** 같은 자리에서
# 다시 뚫렸다. 기억이 없는 첫 패스가 가장 위험한 순간이다.

def test_cold_start_relaxes_the_global_threshold():
    from domains.smb.plugin.agent_types import smb

    smb.reset_auth_lockout_flag()
    assert smb._auth_failure_global_threshold() == 2, "기본값이 바뀌었다"

    smb._AUTH_COLD_START = True
    try:
        relaxed = smb._auth_failure_global_threshold()
        assert relaxed >= 20, f"cold start 완화가 너무 약하다: {relaxed}"
    finally:
        smb.reset_auth_lockout_flag()

    assert smb._auth_failure_global_threshold() == 2, "reset 이 cold start 를 안 지웠다"


def test_sentinel_with_no_candidates_sets_cold_start(monkeypatch):
    """★ 후보가 0개면 cold start 로 표시하고 완화한다.

    예전엔 그냥 "판정 불가" 로 빠져서 임계값 2 가 그대로 적용됐다 — 그게 사고였다.
    """
    from domains.smb.plugin.agent_types import smb

    smb.reset_auth_lockout_flag()
    monkeypatch.setenv("SMB_AUTH_SENTINEL", "true")
    # ⚠️ 계정이 없으면 센티넬이 그 전에 반환한다 — cold start 경로를 못 밟는다.
    monkeypatch.setenv("SMB_USERNAME", "dssoc")
    monkeypatch.setenv("SMB_PASSWORD", "x")
    ok, why = smb.verify_auth_credential([])          # ← DB 초기화 직후가 이 모양
    try:
        assert ok is False
        assert "cold start" in why.lower()
        assert smb._AUTH_COLD_START is True
        assert smb._auth_failure_global_threshold() >= 20
    finally:
        smb.reset_auth_lockout_flag()


def test_cold_start_does_not_weaken_account_state_signals(monkeypatch):
    """★ 계정 잠김·계정 상태 이상은 완화 대상이 **아니다.**

    그 둘은 "몇 대가 도메인 계정을 안 받는다" 와 달리 계정 자체의 신호라,
    성공 이력과 무관하게 즉시 전역 중단이 맞다. 완화가 여기까지 새면 안 된다.
    """
    from domains.smb.plugin.agent_types import smb

    smb.reset_auth_lockout_flag()
    smb._AUTH_COLD_START = True
    try:
        smb._disable_auth_after_login_failure(
            "10.0.0.1", "test", Exception("STATUS_ACCOUNT_LOCKED_OUT"),
        )
        allowed, why = smb._auth_mode_allowed("10.0.0.2")
        assert allowed is False, "잠김인데 cold start 완화가 auth 를 열어줬다"
        assert "LOCKED" in why.upper()
    finally:
        smb.reset_auth_lockout_flag()
