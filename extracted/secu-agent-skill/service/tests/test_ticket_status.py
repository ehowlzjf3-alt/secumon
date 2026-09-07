"""티켓 상태 수동 지정 — 어휘·매핑·실제 쓰기.

## 이 파일이 지키는 것

① **정방향(서버) 과 역방향(화면) 맵이 짝이 맞는다.** 갈라지면 눌러도 같은 칸이 켜진 채
   남아서 "안 바뀐다" 로 보인다 — 이 기능이 애초에 있던 이유가 그것이다.
   (`src_key()` 의 SQL/Python 두 판을 테스트로 묶어 둔 것과 같은 규율.)
② **도메인마다 native 어휘가 다르다.** 회신 대기는 smb 가 `awaiting_reply`,
   github 은 `awaiting_owner` 다. 한 벌로 쓰면 github 이 통째로 실패한다.
③ 쓴 값이 그 도메인의 **허용 어휘 안**이다 — 아니면 setter 가 ValueError 로 죽는다.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from service.services.ticket_status import (
    TICKET_STATUS_MAP, TICKET_STATUS_ORDER, TicketStatusError, native_status,
)

_DOMAINS = ("smb", "github", "confluence", "dev_web")

#: 계약 파일 — 화면이 읽는 역방향 맵이 여기 있다.
_CONTRACTS = Path(__file__).resolve().parents[3] / "digisecu-employee" / "contracts" / "src" / "triage.ts"


def _reverse_map_from_contracts() -> dict[str, str]:
    """`NATIVE_TO_TICKET_STATUS` 를 계약 파일에서 그대로 읽는다."""
    text = _CONTRACTS.read_text(encoding="utf-8")
    m = re.search(
        r"NATIVE_TO_TICKET_STATUS[^=]*=\s*\{(.*?)\};", text, re.S)
    assert m, "계약에서 NATIVE_TO_TICKET_STATUS 를 못 찾았다"
    out: dict[str, str] = {}
    for key, value in re.findall(r'(\w+):\s*"(\w+)"', m.group(1)):
        out[key] = value
    return out


def test_every_ticket_status_covers_every_domain() -> None:
    """빠진 칸이 있으면 그 도메인에서만 조용히 실패한다."""
    for key in TICKET_STATUS_ORDER:
        assert key in TICKET_STATUS_MAP, key
        for dom in _DOMAINS:
            assert dom in TICKET_STATUS_MAP[key], f"{key}/{dom} 이 비었다"


def test_domains_do_not_share_one_vocabulary() -> None:
    """★ 이름의 유사성을 믿지 않는다 — github 은 `awaiting_owner` 다."""
    assert native_status("awaiting", "smb") == "awaiting_reply"
    assert native_status("awaiting", "github") == "awaiting_owner"
    assert native_status("replied", "smb") == "reply_received"
    assert native_status("replied", "confluence") == "recheck_requested"


def test_written_status_is_in_the_domain_vocabulary() -> None:
    """쓰는 값이 그 도메인 허용 집합 안이어야 한다(아니면 setter 가 죽는다)."""
    from service import state_domain as sd

    allowed = {
        "smb": sd._MAIL_THREAD_STATUSES,
        "github": sd._GITHUB_REPORT_THREAD_STATUSES,
        "confluence": sd._CONFLUENCE_REPORT_THREAD_STATUSES,
        "dev_web": sd._DEV_WEB_REPORT_STATUSES,
    }
    for key in TICKET_STATUS_ORDER:
        for dom in _DOMAINS:
            native = native_status(key, dom)
            assert native in allowed[dom], f"{dom} 에 없는 status: {native} ({key})"


@pytest.mark.skipif(not _CONTRACTS.exists(), reason="계약 파일이 없는 체크아웃")
def test_forward_and_reverse_maps_agree() -> None:
    """★ 서버가 쓰는 값과 화면이 접는 값이 같아야 한다.

    정방향에 있는 모든 native 값은 역방향에서 같은 필터 키로 돌아와야 한다.
    """
    reverse = _reverse_map_from_contracts()
    for key in TICKET_STATUS_ORDER:
        for dom in _DOMAINS:
            native = native_status(key, dom)
            assert native in reverse, f"계약 역매핑에 {native} 가 없다 ({dom}/{key})"
            assert reverse[native] == key, (
                f"{native} → 서버={key} 화면={reverse[native]} 로 갈렸다")


#: 역매핑에만 있어도 되는 값 — 파이프라인/과거 운영자가 남긴 것이라 **칸은 켜 주되**
#: 버튼이 새로 만들지는 않는다. 늘리려면 이유를 여기 적는다(조용히 늘면 검사가 무의미해진다).
_READ_ONLY_NATIVE = {
    # 2026-09-01 이전 운영자 지정분. 지금은 `remediated`("조치 완료")로 통일했다.
    "closed",
}


@pytest.mark.skipif(not _CONTRACTS.exists(), reason="계약 파일이 없는 체크아웃")
def test_reverse_map_has_no_status_the_server_never_writes() -> None:
    """역매핑에만 있는 값은 "켜지는데 못 누르는 칸" 을 만든다 — 면제 목록 외엔 없어야 한다."""
    written = {native_status(k, d) for k in TICKET_STATUS_ORDER for d in _DOMAINS}
    for native, key in _reverse_map_from_contracts().items():
        assert native in written or native in _READ_ONLY_NATIVE, (
            f"{native}({key}) 는 서버가 쓰지 않는 값이다")


def test_done_button_writes_the_same_status_the_pipeline_writes() -> None:
    """★ 사람이 누른 완료와 파이프라인의 완료가 **같은 값**이어야 한다.

    갈라지면 목록 필터에선 둘 다 "종결" 그룹이라 안 보이고, 상세 화면에서만 한쪽이
    "종결"·다른 쪽이 "조치 완료" 로 나온다 — 2026-09-01 에 실제로 그렇게 보였다.
    """
    for dom in _DOMAINS:
        assert native_status("closed", dom) == "remediated", dom


def test_unknown_vocabulary_is_refused() -> None:
    """어휘 밖은 조용히 통과하지 않는다 — 셋(계약·CLI·서비스)이 같이 닫는다."""
    with pytest.raises(TicketStatusError):
        native_status("resolved", "smb")       # 트리아지 어휘다 — 티켓 상태가 아니다
    with pytest.raises(TicketStatusError):
        native_status("closed", "sharepoint")  # 없는 도메인


def test_none_and_reported_are_not_settable() -> None:
    """`none`·`reported` 는 파생값이다 — 고를 수 있는 상태로 두면 뜻이 없다."""
    assert "none" not in TICKET_STATUS_MAP
    assert "reported" not in TICKET_STATUS_MAP


def test_cli_rejects_vocabulary_outside_the_contract() -> None:
    from service import ticket_status_cli as cli

    assert cli.main(["--domain", "smb", "--thread-id", "1", "--status", "resolved"]) == 3
    assert cli.main(["--domain", "smb", "--thread-id", "0", "--status", "closed"]) == 3


def test_set_ticket_status_writes_the_thread(capsys) -> None:
    """실제 스레드 하나를 만들어 상태가 바뀌는지 본다."""
    from service import state_domain as sd
    from service.services.ticket_status import set_ticket_status

    _, tid = sd.mail_thread_upsert(
        finding_id=990001, host="10.0.0.99", subject_tag="보안취약점 조치요청",
        cycle_key="2026-W36",
    )
    sd.mail_thread_set_status(tid, "awaiting_reply")

    out = set_ticket_status(domain="smb", thread_id=tid, ticket_status="closed",
                            requested_by="tester")
    assert out["previous"] == "awaiting_reply"
    # ★ "종결" 버튼이 쓰는 값은 `remediated` 다 — 파이프라인과 같은 말(2026-09-01).
    assert out["status"] == "remediated"
    assert sd.mail_thread_get(tid)["status"] == "remediated"

    # 같은 값으로 두 번 — "이미 그 상태" 는 성공이 아니다(화면이 바뀐 줄 안다).
    with pytest.raises(TicketStatusError):
        set_ticket_status(domain="smb", thread_id=tid, ticket_status="closed")
