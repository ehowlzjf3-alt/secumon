"""조치요청 메일 수신처 정책.

사용자 결정(2026-08-24):
    메일은 **담당자 + DSSOC(자기 자신)** 에게 간다. DSSOC 에게만 보내는 것은 **드라이런 때뿐**.

★ 이 파일이 지키는 핵심은 "정상 발송" 이 아니라 **모순 상태에서 멈추는 것**이다.
  자율발송이 켜졌는데 수신처가 dssoc_only 면, 진짜 메일이 DSSOC 에게만 가고 담당자는
  영영 못 듣는다 — 화면엔 "통보 완료" 로 남는다. 그게 예전 **기본값**이었다.
"""
from __future__ import annotations

import pytest

from service.services import owner_recipients as orx

_MODE = "TEST_REMEDIATION_MAIL_MODE"
_DSSOC = ("TEST_DSSOC_RECIPIENT", "SA_DSSOC_MAIL_RECIPIENT")
_OWNER = ["a.kim@samsung.com"]


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    for k in (_MODE, orx.AUTOSEND_SINKS_ENV, *_DSSOC):
        monkeypatch.delenv(k, raising=False)
    # ★ 이 파일은 **수신처 정책**(누구에게 보내는가)을 검증한다. 최초 발송 게이트
    #   (자동이면 아무에게도 안 보낸다)는 관심사가 다르고 `test_initial_send_gate.py`
    #   가 따로 고정한다. 여기서 게이트를 열어 두지 않으면 모든 케이스가
    #   `initial_closed` 로 뭉개져 정책 자체를 검증하지 못한다(2026-08-31).
    monkeypatch.setenv(orx.INITIAL_AUTOSEND_ENV, "1")
    yield


def _targets(owners=_OWNER):
    return orx.delivery_targets(owners, mode_env=_MODE, dssoc_env_names=_DSSOC)


def test_실발송이_켜지고_normal_이면_담당자에게_간다(monkeypatch):
    """★ 핵심. 예전엔 MAIL_MODE 기본값이 dssoc_only 라 담당자가 빠졌다."""
    monkeypatch.setenv(orx.AUTOSEND_SINKS_ENV, "knox_mail")
    monkeypatch.setenv(_MODE, "normal")
    t = _targets()
    assert t["mode"] == "normal"
    assert t["recipients"] == _OWNER
    assert t["cc"] == [orx.DSSOC_DEFAULT]      # DSSOC 는 자기 자신 사본으로 항상 붙는다


def test_normal_요청이면_드라이런이어도_담당자를_넣는다(monkeypatch):
    # 발송이 안 되므로 안전하고, draft 에 진짜 수신처가 보여야 검증이 된다.
    monkeypatch.setenv(_MODE, "normal")
    assert _targets()["recipients"] == _OWNER


def test_드라이런에_dssoc_only_면_DSSOC_로만(monkeypatch):
    # 자율발송이 꺼져 있으면 어차피 안 나간다 — 관측용으로 DSSOC 만 남긴다.
    t = _targets()
    assert t["mode"] == "dry_run"
    assert t["recipients"] == [orx.DSSOC_DEFAULT] and t["cc"] == []


def test_실발송_중_모드_미설정은_예외로_멈춘다(monkeypatch):
    """★ 조용히 고치지 않는다.

    담당자를 넣으면 의도치 않게 실제 사람에게 메일이 가고, 그대로 두면 담당자가 못 듣는다.
    둘 다 위험하므로 추측하지 말고 사람이 풀게 멈춘다.
    """
    monkeypatch.setenv(orx.AUTOSEND_SINKS_ENV, "knox_mail")
    with pytest.raises(orx.DeliveryPolicyError) as e:
        _targets()
    assert _MODE in str(e.value) and orx.AUTOSEND_SINKS_ENV in str(e.value)


def test_실발송_중_DSSOC_로만_보내는_상태는_없다(monkeypatch):
    """★ 정책: "DSSOC 에게만 보내는 것은 드라이런 때뿐이다."

    한때 `staged`(도메인별로 실발송을 미룬다)를 넣었다가 뺐다 — 그건 정책이 금지한 상태를
    정책으로 허용하는 것이었다. 자율발송이 켜졌는데 normal 이 아니면 **전부 예외**다.
    """
    monkeypatch.setenv(orx.AUTOSEND_SINKS_ENV, "knox_mail")
    for value in ("", "dssoc_only", "staged", "hold", "무엇이든"):
        monkeypatch.setenv(_MODE, value)
        with pytest.raises(orx.DeliveryPolicyError):
            _targets()


def test_예외_메시지가_고치는_법을_알려준다(monkeypatch):
    monkeypatch.setenv(orx.AUTOSEND_SINKS_ENV, "knox_mail")
    monkeypatch.setenv(_MODE, "dssoc_only")
    with pytest.raises(orx.DeliveryPolicyError) as e:
        _targets()
    msg = str(e.value)
    assert f"{_MODE}=normal" in msg
    assert f"{orx.AUTOSEND_SINKS_ENV} 를 비워" in msg
    assert "같은 sink" in msg


def test_담당자를_못_찾으면_정책이_아니라_사고로_표시한다(monkeypatch):
    """"정책상 DSSOC" 와 "담당자 해석 실패" 는 다른 일이다 — 같은 값으로 보이면 안 된다."""
    monkeypatch.setenv(_MODE, "normal")
    t = orx.delivery_targets([], mode_env=_MODE, dssoc_env_names=_DSSOC)
    assert t["mode"] == "no_owner"
    assert t["recipients"] == [orx.DSSOC_DEFAULT]


def test_사외_주소는_담당자로_안_친다(monkeypatch):
    monkeypatch.setenv(orx.AUTOSEND_SINKS_ENV, "knox_mail")
    monkeypatch.setenv(_MODE, "normal")
    t = orx.delivery_targets(["yb07.kim@partner.sec.co.kr"], mode_env=_MODE, dssoc_env_names=_DSSOC)
    assert t["mode"] == "no_owner"


def test_dssoc_수신자는_env_를_따른다(monkeypatch):
    monkeypatch.setenv("TEST_DSSOC_RECIPIENT", "soc1@samsung.com, soc2@samsung.com")
    monkeypatch.setenv(_MODE, "normal")
    assert _targets()["cc"] == ["soc1@samsung.com", "soc2@samsung.com"]


def test_자율발송_판정은_목록이_비었는지로_본다(monkeypatch):
    assert orx.autosend_enabled() is False
    monkeypatch.setenv(orx.AUTOSEND_SINKS_ENV, "  ")
    assert orx.autosend_enabled() is False
    monkeypatch.setenv(orx.AUTOSEND_SINKS_ENV, "knox_mail")
    assert orx.autosend_enabled() is True


def test_4도메인이_같은_규칙을_쓴다(monkeypatch):
    """도메인마다 분기를 각자 들고 있던 것이 이 사고의 원인이었다."""
    monkeypatch.setenv(orx.AUTOSEND_SINKS_ENV, "knox_mail")
    for name in ("SMB_REMEDIATION_MAIL_MODE", "CONFLUENCE_REMEDIATION_MAIL_MODE",
                 "DEV_WEB_REMEDIATION_MAIL_MODE", "GITHUB_REMEDIATION_MAIL_MODE"):
        monkeypatch.setenv(name, "normal")
    from domains.dev_web.plugin.tools import dev_web_report_tools as dw
    from domains.services.confluence.application import reporter as cf
    from domains.services.github.application import scanner as gh
    from domains.smb.plugin.tools import smb_report_mail_tools as smb

    for fn in (smb.report_mail_delivery_targets, cf.confluence_report_delivery_targets,
               dw._delivery_targets, gh.github_report_delivery_targets):
        t = fn(_OWNER)
        assert t["mode"] == "normal" and t["recipients"] == _OWNER, fn


# ── 수신자 필터 — 모듈 import 로는 안 잡히는 자리 ──────────────────────────────
#
# ★ 이 블록이 생긴 이유(2026-08-24 라이브):
#   SSOT 통합(62b7cb3)이 `_DSSOC_LOCALPARTS` 를 `owner_recipients` 로 옮기면서
#   `dev_web_report_tools` 의 **참조 한 줄**을 남겼다. 함수 **본문** 안의 미정의 이름이라
#   import 도 통과하고 스위트 2,559건도 통과했다. 실기동에서만 터졌다:
#
#       deliver → NameError: name '_DSSOC_LOCALPARTS' is not defined
#
#   그 결과 dev_web 배달이 전부 실패했고, 워커는 그걸 "일시적 오류" 로 읽고 재시도를
#   반복하다 예산에 걸려 죽었다. 증상이 `idle timeout` 이라 원인이 **지연으로 보였다** —
#   나는 그걸 두 번 오진했다(백엔드 단절 → 부하 지연). 진짜는 NameError 한 줄이었다.
#
# ⚠️ 교훈은 "상수를 옮길 때 조심하자" 가 아니다. **함수를 실제로 불러보는 테스트가 없으면
#    이 계열은 통과한다.** 그래서 아래는 값 검증보다 **호출 자체**가 목적이다.


def test_수신자_필터를_실제로_불러본다():
    """DSSOC 판별 함수들을 **호출**한다 — 미정의 이름은 부를 때만 드러난다."""
    from domains.dev_web.plugin.tools import dev_web_report_tools as dw
    from domains.smb.plugin.tools import smb_reply_tools as smb_reply

    for fn in (dw._is_dssoc_address, smb_reply._is_dssoc_address):
        assert fn("dssoc@samsung.com") is True, fn
        assert fn("a.kim@samsung.com") is False, fn

    # 시그니처가 다른 형제 — dssoc 목록을 인자로 받는다. 같이 불러 둔다.
    from service.services import remediation_mail as rm

    assert rm._is_dssoc_address("dssoc@samsung.com", ["dssoc@samsung.com"]) is True
    assert rm._is_dssoc_address("a.kim@samsung.com", ["dssoc@samsung.com"]) is False


def test_dssoc_목록은_정본_하나뿐이다():
    """사본을 두면 한쪽만 늙는다 — 이번 사고가 그 사본을 옮기다 난 것이다."""
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    owners = []
    for path in root.rglob("*.py"):
        if "/tests/" in str(path) or path.name.startswith("test_"):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if re.search(r"^\s*(NON_OWNER_LOCALPARTS|_DSSOC_LOCALPARTS)\s*=", text, re.M):
            owners.append(str(path.relative_to(root)))
    assert owners == ["service/services/owner_recipients.py"], (
        f"DSSOC local part 목록이 여러 곳에 있다: {owners}"
    )


# ── 회신 수신처 ───────────────────────────────────────────────────────────────
def test_회신도_담당자_To_에_DSSOC_는_참조():
    """정책은 회신에도 같다 — 메일 수신처는 담당자 + DSSOC(자기 자신)."""
    from service.services.remediation_mail import reply_targets

    to, cc = reply_targets(
        {"mail_from": "owner@samsung.com", "mail_to": "dssoc@samsung.com",
         "mail_cc": "peer@samsung.com"},
        dssoc_recipients=["dssoc@samsung.com"],
    )
    assert to == ["owner@samsung.com"]
    assert cc == ["peer@samsung.com", "dssoc@samsung.com"]


def test_회신_수신자가_없으면_DSSOC_로_떨어지지_않는다():
    """★ 폴백이 있었다: `if not recipients: recipients = list(dssoc)`.

    누구에게 보낼지 모르는 상황을 **발송 성공처럼** 만든다 — 팀함에 조용히 쌓이고 화면엔
    통보 완료로 남고 담당자는 아무것도 못 받는다. 빈 채로 돌려주면 엔진이
    `DeliveryError("TO 수신자가 없습니다.")` 로 막아 **발송 실패로 남는다.**
    """
    from service.services.remediation_mail import reply_targets

    to, cc = reply_targets(
        {"mail_from": "dssoc@samsung.com", "mail_to": "dssoc@samsung.com", "mail_cc": ""},
        dssoc_recipients=["dssoc@samsung.com"],
    )
    assert to == []
    assert cc == ["dssoc@samsung.com"]


def test_빈_수신자는_엔진이_막는다():
    """폴백 제거가 성립하려면 엔진이 빈 To 를 거부해야 한다 — 그 계약을 여기서 고정한다."""
    import pytest as _pytest
    from secu_agent.agent.delivery import DeliveryError, DeliveryPayload, apply_egress_gate

    with _pytest.raises(DeliveryError, match="TO 수신자"):
        apply_egress_gate("knox_mail", DeliveryPayload(
            subject="s", body="b", recipients=(), cc=("dssoc@samsung.com",),
        ))
