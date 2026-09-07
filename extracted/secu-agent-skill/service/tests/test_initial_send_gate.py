"""최초 발송 게이트 — 수동은 열리고 자동은 닫힌다. 4도메인 동일.

## 사용자 결정 (2026-08-31)

    수동 발송   → 실제 담당자에게    (사람이 승인했다)
    회신·재검증 → 모두에게 열림      (`reply_targets` 를 쓴다 — 이 게이트를 안 지난다)
    최초 발송   → **닫혀 있다**

## ⚠️ 왜 코드로 막는가

수동 발송이 실제 담당자에게 나가려면 `SA_DELIVERY_RECIPIENT_ALLOW` 를 열어야 한다.
그 순간 최초 대량 발송을 막는 건 **컴포넌트 플래그 하나뿐**이 된다. 플래그는 누가
켜면 그만이고, 그러면 큐가 통째로 실존 임직원에게 나간다
(2026-08-31 실측: smb 48 · github 552 · confluence 44 · dev_web 71).

이 저장소가 오늘만 세 번 확인했다 — 부탁·설정으로 지켜지는 불변식은 깨지고,
깨져도 조용하다(재검증 게이트 · 티켓 스탬프 · 리드 반복).
"""
from __future__ import annotations

import pytest

from service.services import owner_recipients as orx

_OWNER = ["owner.one@samsung.com"]
_DOMAINS = [
    ("smb", "domains.smb.plugin.tools.smb_report_mail_tools", "report_mail_delivery_targets"),
    ("github", "domains.services.github.application.scanner", "github_report_delivery_targets"),
    ("confluence", "domains.services.confluence.application.reporter",
     "confluence_report_delivery_targets"),
    ("dev_web", "domains.dev_web.plugin.tools.dev_web_report_tools",
     "dev_web_report_delivery_targets"),
]


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    """게이트가 닫힌 기본 상태 + 담당자 모드."""
    monkeypatch.delenv(orx.INITIAL_AUTOSEND_ENV, raising=False)
    for d in ("SMB", "GITHUB", "CONFLUENCE", "DEV_WEB"):
        monkeypatch.setenv(f"{d}_REMEDIATION_MAIL_MODE", "normal")
    monkeypatch.setenv("SA_DSSOC_MAIL_RECIPIENT", "dssoc@samsung.com")


def _call(module: str, fn: str, **kw):
    from importlib import import_module

    return getattr(import_module(module), fn)(_OWNER, **kw)


@pytest.mark.parametrize("domain,module,fn", _DOMAINS)
def test_automatic_initial_send_is_closed(domain, module, fn) -> None:
    """★ 자동 최초 발송은 담당자에게 가지 않는다 — 기본이 닫힘이다."""
    out = _call(module, fn)
    assert out["mode"] == "initial_closed", f"{domain}: {out}"
    # ★ 수신처가 **완전히 비어야** 한다. DSSOC 도 넣지 않는다 —
    #   사용자 요구는 "제작까지만"(2026-08-31)이고, 주소가 하나라도 있으면
    #   autosend 가 켜진 순간 실제로 나간다. 빈 목록이면 코어가 거부한다.
    assert out["recipients"] == [] and out["cc"] == [], f"{domain} 에서 나갈 수 있다: {out}"
    assert out.get("reason"), "왜 닫혔는지 말해야 한다 — 조용한 차단은 사고를 못 본다"


@pytest.mark.parametrize("domain,module,fn", _DOMAINS)
def test_manual_send_reaches_the_owner(domain, module, fn) -> None:
    """수동(콘솔 승인)은 실제 담당자에게 나간다."""
    out = _call(module, fn, manual=True)
    assert out["mode"] == "normal", f"{domain}: {out}"
    assert out["recipients"] == _OWNER
    assert "dssoc@samsung.com" in out["cc"], "DSSOC 참조가 빠지면 스레드 기록이 끊긴다"


@pytest.mark.parametrize("domain,module,fn", _DOMAINS)
def test_draft_still_gets_built_when_send_is_closed(domain, module, fn) -> None:
    """★ "제작까지만" 이다 — 발송만 막고 초안 생성은 막지 않는다.

    도구가 수신처 없음에 터지면 초안도 안 만들어진다(`recipients[0]` IndexError).
    """
    out = _call(module, fn)
    assert isinstance(out.get("recipients"), list), f"{domain}: 호출부가 빈 목록을 다뤄야 한다"


@pytest.mark.parametrize("domain,module,fn", _DOMAINS)
def test_gate_opens_only_when_explicitly_set(domain, module, fn, monkeypatch) -> None:
    monkeypatch.setenv(orx.INITIAL_AUTOSEND_ENV, "1")
    out = _call(module, fn)
    assert out["mode"] == "normal" and out["recipients"] == _OWNER, f"{domain}: {out}"


@pytest.mark.parametrize("raw", ["", "0", "false", "no", "off", " "])
def test_ambiguous_values_keep_it_closed(raw, monkeypatch) -> None:
    """★ 애매한 값은 **닫힘**이다. 열림 쪽으로 해석하면 사고가 조용히 난다."""
    monkeypatch.setenv(orx.INITIAL_AUTOSEND_ENV, raw)
    assert not orx.initial_autosend_enabled()


def test_reply_path_does_not_pass_through_this_gate() -> None:
    """회신은 `reply_targets` 를 쓴다 — 최초 발송 게이트와 무관하게 열려 있어야 한다."""
    from service.services.remediation_mail import reply_targets

    to, cc = reply_targets({
        "mail_from": "Owner <owner.one@samsung.com>",
        "mail_to": "dssoc@samsung.com", "mail_cc": "",
    })
    assert to == _OWNER, "회신이 담당자에게 못 가면 답장 루프가 끊긴다"
    assert "dssoc@samsung.com" in cc
