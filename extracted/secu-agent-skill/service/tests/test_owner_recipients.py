"""담당자 수신자 해석 SSOT 계약.

네 층에 복사돼 있던 것을 모았다. 이 파일이 지키는 것은 셋이다.
1. 추출이 **동작을 바꾸지 않았다**(application 판본과 같은 답).
2. webapp 판본이 못 보던 **dict 재귀**가 정본에는 있다(그게 실제 드리프트였다).
3. 도메인 키 목록은 합치지 않고 **나란히** 둔다 — 공통이 양쪽에 다 들어 있는지 고정.
"""
from __future__ import annotations

import pytest

from service.services import owner_recipients as orx


# ── 키 목록 ───────────────────────────────────────────────────────────────────
def test_공통키는_두_도메인에_모두_들어간다():
    assert set(orx.COMMON_KEYS) <= set(orx.GITHUB_KEYS)
    assert set(orx.COMMON_KEYS) <= set(orx.CONFLUENCE_KEYS)


def test_도메인_고유키는_서로_섞이지_않는다():
    # github 이 page_owner_email 을 뒤질 이유가 없고 그 반대도 마찬가지다.
    # 합치면 오히려 틀리므로 나란히 두되 침범은 막는다.
    assert "page_owner_email" not in orx.GITHUB_KEYS
    assert "creator_email" not in orx.GITHUB_KEYS
    assert "commit_author_email" not in orx.CONFLUENCE_KEYS
    assert "suppress_emails" not in orx.CONFLUENCE_KEYS


def test_github_은_커밋_작성자_채널을_모두_본다():
    # 신 스캐너가 author_email 쓰기를 멈춘 걸 아무도 못 알아챘던 자리다.
    for key in ("author_email", "commit_author_email", "committer_email",
                "last_commit_author_email", "suppress_emails"):
        assert key in orx.GITHUB_KEYS


# ── 사내 판정 ─────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("addr,expected", [
    ("a.kim@samsung.com", True),
    ("A.Kim@Samsung.COM", True),          # 대소문자 무시
    ("x@sec.samsung.com", True),          # 서브도메인
    ("yb07.kim@partner.sec.co.kr", False),  # 파트너는 사내가 아니다
    ("dssoc@samsung.com", False),         # 발송 대상이지 담당자가 아니다
    ("nodomain", False),
    ("", False),
    ("x@notsamsung.com", False),
    ("x@evil-samsung.com", False),        # 접미 매칭 사고 방지(점이 반드시 앞에 와야 한다)
])
def test_사내_담당자_주소_판정(addr, expected):
    assert orx.is_internal(addr) is expected


# ── 파싱 ──────────────────────────────────────────────────────────────────────
def test_dict_와_중첩을_재귀로_편다():
    """★ webapp 판본이 이걸 못 해서 화면과 메일이 어긋났다."""
    assert orx.recipient_list({"email": "a.kim@samsung.com"}) == ["a.kim@samsung.com"]
    assert orx.recipient_list([{"recipients": ["b@samsung.com", {"mail": "c@samsung.com"}]}]) == [
        "b@samsung.com", "c@samsung.com",
    ]


def test_표시명_형태와_본문_박힌_주소를_둘_다_건진다():
    assert orx.recipient_list("Kim <a.kim@samsung.com>") == ["a.kim@samsung.com"]
    assert orx.recipient_list("문의: b.lee@samsung.com 로") == ["b.lee@samsung.com"]


def test_중복은_제거하고_순서는_유지한다():
    assert orx.recipient_list(["b@samsung.com", "a@samsung.com", "B@samsung.com"]) == [
        "b@samsung.com", "a@samsung.com",
    ]


def test_사외_주소는_통과하지_않는다():
    assert orx.recipient_list(["x@qq.com", "y@users.noreply.github.com"]) == []


def test_extra_는_metadata_안까지_본다():
    extra = {"recipient": "a@samsung.com", "metadata": {"author_email": "b@samsung.com"}}
    assert orx.from_extra(extra, orx.GITHUB_KEYS) == ["a@samsung.com", "b@samsung.com"]
    # confluence 키 목록으로는 author_email 을 안 본다(도메인 고유 키다).
    assert orx.from_extra(extra, orx.CONFLUENCE_KEYS) == ["a@samsung.com"]
    assert orx.from_extra(None, orx.GITHUB_KEYS) == []


# ── DSSOC ─────────────────────────────────────────────────────────────────────
def test_dssoc_는_env_순서를_따르고_없으면_기본값(monkeypatch):
    monkeypatch.delenv("A_X", raising=False)
    monkeypatch.delenv("B_X", raising=False)
    assert orx.dssoc_recipients("A_X", "B_X") == [orx.DSSOC_DEFAULT]
    monkeypatch.setenv("B_X", "b@samsung.com")
    assert orx.dssoc_recipients("A_X", "B_X") == ["b@samsung.com"]
    monkeypatch.setenv("A_X", "a1@samsung.com, a2@samsung.com")
    assert orx.dssoc_recipients("A_X", "B_X") == ["a1@samsung.com", "a2@samsung.com"]


# ── 두 판본이 갈렸던 자리 ─────────────────────────────────────────────────────
# ⚠️ 여기를 "기존 구현과 답이 같은지" 로 쓰면 안 된다. 호출부를 SSOT 로 바꾸는 순간
#    그 대조는 **자기 자신과 비교**가 되어 조용히 무의미해진다(실제로 한 번 그랬다).
#    그래서 기대값을 리터럴로 못박는다.
@pytest.mark.parametrize("value,expected", [
    # 두 판본이 원래 같던 것들
    ("a@samsung.com", ["a@samsung.com"]),
    (["a@samsung.com", "c@samsung.com"], ["a@samsung.com", "c@samsung.com"]),
    ({"email": "a@samsung.com"}, ["a@samsung.com"]),
    ([["a@samsung.com"]], ["a@samsung.com"]),
    # ★ 갈렸던 것들 — application(메일)이 [] 를 내고 webapp(화면)이 찾아냈다.
    #   "모르는 키는 조용히 버린다" 가 원인이었다. 정본은 합집합이라 셋 다 찾는다.
    ({"primary": "a@samsung.com", "backup": "c@samsung.com"},
     ["a@samsung.com", "c@samsung.com"]),
    ({"owner": {"email": "a@samsung.com"}}, ["a@samsung.com"]),
    ({"emails": ["a@samsung.com", "c@samsung.com"]}, ["a@samsung.com", "c@samsung.com"]),
])
def test_dict_처리는_아는_키와_전체_훑기의_합집합이다(value, expected):
    assert orx.recipient_list(value) == expected


def test_아는_키가_같은_dict_안의_다른_주소보다_우선한다():
    """순서가 뜻을 만든다 — `recipient` 는 '여기가 수신자' 라는 명시적 신호다.

    같은 dict 에 발신자나 억제 목록이 섞여 있어도 명시된 쪽만 나가야 한다.
    """
    assert orx.recipient_list({
        "recipient": "owner@samsung.com",
        "sender": "bot@samsung.com",
    }) == ["owner@samsung.com"]


# ── SSOT 이전이 남긴 미정의 참조 ─────────────────────────────────────────────
# ★ 함수 **본문 안**의 미정의 이름은 import 로도 스위트로도 안 잡힌다 — 모듈은 정상
#   로드되고 그 함수를 부를 때만 터진다. 실제로 그랬다: `62b7cb3` 이 `_DSSOC_LOCALPARTS`
#   참조 한 줄을 남겨 dev_web 배달이 전부 죽었고, 2559건이 통과했다.
#   증상은 워커 idle timeout 이라 원인을 완전히 가렸다(배달 실패 → 워커가 재시도·조사 반복
#   → 예산 소진). 그래서 **호출해 보는** 테스트를 둔다.
def test_DSSOC_판정_함수를_실제로_불러본다(monkeypatch):
    """값 검증보다 **호출 자체**가 목적이다 — 미정의 이름은 부를 때만 드러난다."""
    from domains.smb.plugin.tools import smb_reply_tools as smb_reply
    from service.collector import mail_inbound
    from service.services import remediation_mail

    monkeypatch.setenv("POP3_USER", "dssoc")
    assert orx.is_dssoc("dssoc@samsung.com") is True
    assert orx.is_dssoc("a.kim@samsung.com") is False
    assert isinstance(mail_inbound._our_sender_identities(), set)
    assert mail_inbound._is_dssoc_sender("dssoc@samsung.com") is True
    assert isinstance(smb_reply._dssoc_identities(), set)
    assert smb_reply._is_dssoc_address("dssoc@samsung.com") is True
    assert remediation_mail._is_dssoc_address("dssoc@samsung.com", []) is True


def test_담당자_힌트가_팀함을_사람으로_안_잡는다(monkeypatch):
    """★ env 를 안 보던 유일한 곳이었다 — 주소를 바꾸면 팀함이 담당자로 잡혔다."""
    from service import state_domain as sd

    assert sd._service_owner_recipient_hint("dssoc@samsung.com", None) is None
    assert sd._service_owner_recipient_hint(None, "a.kim@samsung.com") == "a.kim@samsung.com"
    # env 로 팀함을 바꿔도 따라간다(리터럴에만 기대지 않는다).
    monkeypatch.setenv("GITHUB_REMEDIATION_DSSOC_RECIPIENT", "soc-team@samsung.com")
    assert sd._service_owner_recipient_hint(None, "soc-team@samsung.com") is None


def test_DSSOC_판정_목록은_정본_하나뿐이다():
    """사본이 다시 생기면 깨진다 — 갈라진 목록이 오늘 사고의 뿌리였다."""
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[2]
    owners = []
    for path in root.rglob("*.py"):
        if ".git" in path.parts or "/tests/" in str(path):
            continue
        src = path.read_text(encoding="utf-8", errors="replace")
        if re.search(r"^(NON_OWNER_LOCALPARTS|_DSSOC_LOCALPARTS)\s*=", src, re.M):
            owners.append(path.name)
    assert owners == ["owner_recipients.py"], owners


# ── 담당자 판정이 env 를 따라가는가 ─────────────────────────────────────────────
#
# `recipient_list` 는 이미 `dssoc@` 를 거른다 — `is_internal` 이 `NON_OWNER_LOCALPARTS`
# 리터럴을 보기 때문이다. 문제는 **그 리터럴이 전부였다**는 것이다.

def test_hardcoded_team_mailbox_is_still_rejected_without_env(monkeypatch) -> None:
    """백스톱 보존 — env 가 안 붙은 배포에서도 동작이 그대로여야 한다."""
    for name in orx.DSSOC_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    assert orx.is_internal("dssoc@samsung.com") is False
    assert orx.recipient_list(["dssoc@samsung.com"]) == []
    assert orx.is_internal("owner@samsung.com") is True


def test_owner_filter_follows_env_when_the_team_mailbox_changes(monkeypatch) -> None:
    """★ 이게 고친 것. 팀함 주소를 바꾸면 담당자 판정도 따라와야 한다."""
    for name in orx.DSSOC_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    assert orx.is_internal("secteam@samsung.com") is True      # 아직 모르는 주소

    monkeypatch.setenv("CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT", "secteam@samsung.com")
    assert orx.is_internal("secteam@samsung.com") is False
    assert orx.recipient_list(["secteam@samsung.com"]) == []


def test_renamed_team_mailbox_cannot_become_a_normal_mode_send_to_ourselves(monkeypatch) -> None:
    """이걸 놓치면 To=팀함 인 발송이 mode='normal' 로 기록된다 — 금지된 상태다."""
    for name in orx.DSSOC_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("GITHUB_REMEDIATION_MAIL_MODE", "normal")
    monkeypatch.setenv("GITHUB_REMEDIATION_DSSOC_RECIPIENT", "secteam@samsung.com")

    targets = orx.delivery_targets(
        orx.recipient_list(["secteam@samsung.com"]),
        mode_env="GITHUB_REMEDIATION_MAIL_MODE",
        dssoc_env_names=("GITHUB_REMEDIATION_DSSOC_RECIPIENT", "SA_DSSOC_MAIL_RECIPIENT"),
    )
    assert targets["mode"] != "normal"   # 담당자를 못 찾았다는 사실이 드러난다
