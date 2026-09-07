"""재확인 회신 본문 — 엔진 내부 어휘가 담당자에게 나가고 있었다.

## 고친 것

**① 상태값이 영문 내부 키였다.** `재검증 상태` 칸에 `now_closed`/`still_open` 이 그대로
   찍혔다. 같은 메일의 행별 `결과` 열은 번역돼 있어서 **한 메일 안에서 어긋나기까지** 했다.

**② `검증 근거` 열이 내부 진단이었다.** `api_code_search_detail_scan matched HEAD abc123
   detail fetched` 같은 문자열이다. 값 누출은 아니지만 우리 진단이지 담당자가 할 일이 아니다.
   조치요청 메일에서 `스캔 방식`·`후보 출처` 를 뺀 것과 같은 이유로 뺐다.

**③ `Finding` 열이 DB 내부 id 였다.** 담당자에게 아무 뜻이 없다.

라벨은 `service.services.sensitive_summary.recheck_status_label` 하나가 소유한다 —
도메인마다 적으면 어긋난다(오늘 세 번 봤다).
"""
from __future__ import annotations

import pytest

from domains.services.confluence.application.reporter import _confluence_recheck_body
from domains.services.github.application.scanner import _github_recheck_body
from service.services.sensitive_summary import recheck_status_label

_RESULT = {
    "final_status": "still_open",
    "scan": {"head_sha": "abc123def456789"},
    "results": [{
        "finding_id": 20301, "path": "deploy/.env", "asset": "confluence:DSSOC:page/1",
        "verdict": "still_open",
        "verification": {"method": "api_code_search_detail_scan", "matched": True,
                         "head_sha": "abc123def456789", "detail_fetched": True,
                         "status_code": 200},
    }],
}

_BODIES = [
    ("github", _github_recheck_body, {"repo": "org/repo"}),
    ("confluence", _confluence_recheck_body, {"space_key": "DSSOC"}),
]


# ── ① 상태 라벨 ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("now_closed", "조치 확인됨"), ("remediated", "조치 확인됨"),
    ("still_open", "아직 확인됨"), ("partially_remediated", "일부 조치됨"),
    ("unknown", "판단 보류"), ("error", "확인 실패"),
])
def test_status_labels(raw, expected):
    assert recheck_status_label(raw) == expected


def test_unknown_status_is_folded_not_leaked():
    """새 어휘가 생겨도 영문 키가 메일로 나가면 안 된다."""
    assert recheck_status_label("brand_new_engine_status") == "판단 보류"
    assert recheck_status_label(None) == "판단 보류"


@pytest.mark.parametrize("name,fn,thread", _BODIES)
def test_body_shows_korean_status_not_engine_key(name, fn, thread):
    html = fn(thread, _RESULT)
    assert "아직 확인됨" in html
    assert "still_open" not in html, f"{name}: 엔진 내부 키가 메일에 실렸다"


# ── ②③ 내부 진단·DB id 제거 ───────────────────────────────────────────────

@pytest.mark.parametrize("name,fn,thread", _BODIES)
@pytest.mark.parametrize("needle", [
    "api_code_search_detail_scan", "detail fetched", "status_code", "20301",
])
def test_internal_diagnostics_and_db_ids_are_gone(name, fn, thread, needle):
    assert needle not in fn(thread, _RESULT), f"{name}: {needle!r} 가 메일에 실렸다"


# ── 담당자가 필요한 것은 남는다 ────────────────────────────────────────────

def test_github_keeps_location_and_head():
    html = _github_recheck_body({"repo": "org/repo"}, _RESULT)
    assert "deploy/.env" in html          # 어디를 고칠지
    assert "abc123def456789" in html      # 어느 시점 기준인지
    assert "org/repo" in html


def test_confluence_keeps_target_and_space():
    html = _confluence_recheck_body({"space_key": "DSSOC"}, _RESULT)
    assert "DSSOC" in html
    assert "스페이스" in html             # 영문 헤더 아님


@pytest.mark.parametrize("name,fn,thread", _BODIES)
def test_empty_results_still_renders(name, fn, thread):
    html = fn(thread, {"final_status": "unknown", "results": []})
    assert "표시할 재검증 항목이 없습니다" in html
    assert "판단 보류" in html
