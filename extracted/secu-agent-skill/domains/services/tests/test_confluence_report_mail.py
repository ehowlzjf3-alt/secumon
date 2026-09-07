"""Confluence 조치요청 메일 — 값은 감추고 위치는 보여준다.

예전 본문은 영문 `<h2>` 하나에 8열 원시 표였고, 그 표에 **`Masked hit` 열**과 스캔 진단
(scan_method·candidate_source)이 들어 있었다. 받는 사람은 사내 담당자다:
  · 값을 메일에 실으면 전달·회신으로 퍼져 **메일 자체가 노출 경로**가 된다.
  · 스캔 방식·후보 출처는 우리 내부 진단이지 담당자가 할 일이 아니다.

SMB 조치요청 메일(실발송 253통으로 검증된 서식)과 같은 구조로 맞췄다.
"""
from __future__ import annotations

import pytest

from domains.services.confluence.application.reporter import _report_html

_ITEMS = [
    {"severity": "critical", "asset_kind": "page", "title": "운영 배포 가이드",
     "verification_status": "verified",
     "scan_trace": {"scan_method": "browser_search", "candidate_source": "keyword_sweep",
                    "candidate_query": "password"},
     "hits": [{"category": "secret", "kind": "private_key_block", "masked": "----***----"},
              {"category": "credential", "kind": "plaintext_password", "masked": "hun***23"}]},
    {"severity": "high", "asset_kind": "attachment", "filename": "deploy.env",
     "verification_status": "verified",
     "hits": [{"category": "pii", "kind": "kr_phone", "masked": "010-****-1234"}]},
]


@pytest.fixture()
def html():
    return _report_html("DSSOC", _ITEMS, {"verified": 2})


# ── ★ 누출 가드 ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("needle", [
    "private_key_block", "plaintext_password", "kr_phone",   # kind 이름
    "hun***23", "----***----", "010-****-1234",              # 마스킹 값
])
def test_hit_kinds_and_values_never_reach_the_mail(html, needle):
    assert needle not in html, f"{needle!r} 가 메일에 실렸다 — 메일이 노출 경로가 된다"


@pytest.mark.parametrize("needle", ["browser_search", "keyword_sweep", "scan_method"])
def test_internal_scan_diagnostics_are_not_in_the_mail(html, needle):
    """스캔 방식·후보 출처는 우리 진단이지 담당자가 할 일이 아니다."""
    assert needle not in html


# ── 담당자가 필요한 것은 남는다 ────────────────────────────────────────────

def test_location_is_shown_so_the_owner_knows_where_to_go(html):
    """그릇은 보여주고 내용물은 감춘다 — 어느 페이지인지는 알아야 고친다."""
    assert "운영 배포 가이드" in html
    assert "deploy.env" in html


def test_sensitive_categories_are_summarised(html):
    assert "개인키" in html and "크리덴셜·비밀번호" in html and "개인정보" in html
    assert "1건" in html


def test_per_category_actions_are_attached(html):
    """권한을 닫아도 이미 나간 값은 유효하다 — 교체·이력 점검을 말해야 한다."""
    assert "폐기·재발급" in html
    assert "접속 로그" in html or "접속 이력" in html


def test_korean_mail_shape(html):
    """SMB 서식과 같은 결 — 헤더·수신자·서명."""
    assert "Confluence 콘텐츠 조치 요청" in html
    assert "담당자님" in html
    assert "DS보안관제 (정보보호)" in html


def test_recurrence_notice_follows_sends_not_scans():
    """★ 2026-08-31 규칙 변경: "이전에 안내드린" 은 **실제로 보냈을 때만** 말한다.

    예전 근거는 스캔 주차(`cycle_summary.is_recurring`)였다 — 우리가 두 주 연속 본 것과
    담당자가 두 번 들은 것은 다르다. 첫 발송인데 "2주 누적 확인" 이 실제로 나갔다.
    """
    never_sent = _report_html("DSSOC", _ITEMS, {},
                              cycle_summary={"is_recurring": True, "cycle_count": 3},
                              sent_notice_count=0)
    assert "번째 안내" not in never_sent, "스캔을 여러 주 했다고 '안내드렸다' 고 하면 안 된다"

    sent_once = _report_html("DSSOC", _ITEMS, {},
                             cycle_summary={"is_recurring": False},
                             sent_notice_count=1)
    assert "2번째 안내 · 이전 1회 안내" in sent_once


def test_no_items_still_renders_without_an_empty_table():
    html = _report_html("DSSOC", [], {})
    assert "Confluence 콘텐츠 조치 요청" in html
    assert "확인된 민감 항목" not in html   # 빈 표 금지
