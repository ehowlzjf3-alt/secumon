"""GitHub 조치요청 메일 — 값은 감추고 위치는 보여준다 + 영향 범위를 정직하게 센다.

## 고친 것 둘

**① 값과 내부 진단이 담당자 메일로 나가고 있었다.** 표에 `마스킹 값` 열과
`스캔 방식`·`후보 출처` 열이 있었다. 메일은 전달·회신으로 퍼지고 메일함에 남으므로
값이 실리면 메일 자체가 새 노출 경로가 된다. 스캔 방식은 우리 내부 진단이지 담당자 일이 아니다.

**② `영향 파일/경로 0개` 인데 근거는 28건이었다**(실측 #301 `jd2016-lee/SKILLS`).
커밋 단위 finding 은 `path` 가 없다 — asset 이 `github:repo/commit/sha` 라 파일이 아니라
커밋을 가리키고 파일명은 `metadata.files` 배열에 있다. 받는 사람은 **"영향 없음"** 으로
읽는다. 표엔 3행이 뜨는데 경로는 0이라 앞뒤도 안 맞았다.
"""
from __future__ import annotations

import pytest

from domains.services.github.application.scanner import _report_html, _report_summary

_COMMIT_ITEM = {
    "severity": "critical", "asset": "github:org/repo/commit/abc123",
    "verification_status": "live_in_HEAD",
    "metadata": {"files": ["deploy/.env", "ci/secrets.yaml", "deploy/.env"]},
    "recommended_actions": ["토큰 폐기 후 재발급"],
    "scan_trace": {"scan_method": "api_recent_commit_patch_scan",
                   "candidate_source": "recent_commit_patches"},
    "hits": [{"category": "secret", "kind": "private_key_block", "masked": "----***----"},
             {"category": "credential", "kind": "aws_secret_access_key", "masked": "AKIA***MPLE"}],
}
_PATH_ITEM = {
    "severity": "high", "path": "src/config.py", "verification_status": "historical_only",
    "recommended_actions": ["history 정리 검토"],
    "hits": [{"category": "pii", "kind": "kr_phone", "masked": "010-****-1234"}],
}


# ── ② 영향 범위 ────────────────────────────────────────────────────────────

def test_commit_findings_count_files_from_metadata():
    """★ 커밋 단위 finding 도 영향 파일을 센다 — 중복은 한 번만."""
    assert _report_summary([_COMMIT_ITEM])["unique_paths"] == 2


def test_path_findings_still_counted():
    assert _report_summary([_PATH_ITEM])["unique_paths"] == 1


def test_mixed_items_sum_without_double_counting():
    assert _report_summary([_COMMIT_ITEM, _PATH_ITEM])["unique_paths"] == 3


def test_impact_never_reads_as_no_impact_when_there_are_findings():
    """근거가 있는데 `0개` 로 찍히면 담당자는 '영향 없음' 으로 읽는다."""
    html = _report_html("org/repo", [_COMMIT_ITEM], _report_summary([_COMMIT_ITEM]))
    assert "0개" not in html
    assert "영향 범위" in html


def test_item_without_path_or_files_falls_back_to_item_count():
    bare = {"severity": "low", "hits": [{"category": "pii", "kind": "email", "masked": "a***@b"}]}
    html = _report_html("org/repo", [bare], _report_summary([bare]))
    assert "커밋·항목 1건" in html


# ── ① 누출 가드 ────────────────────────────────────────────────────────────

@pytest.fixture()
def html():
    items = [_COMMIT_ITEM, _PATH_ITEM]
    return _report_html("org/repo", items, _report_summary(items), recipient="홍길동")


@pytest.mark.parametrize("needle", [
    "private_key_block", "aws_secret_access_key", "kr_phone",   # kind 이름
    "AKIA***MPLE", "----***----", "010-****-1234",              # 마스킹 값
])
def test_hit_kinds_and_values_never_reach_the_mail(html, needle):
    assert needle not in html, f"{needle!r} 가 메일에 실렸다 — 메일이 노출 경로가 된다"


@pytest.mark.parametrize("needle", ["api_recent_commit_patch_scan", "recent_commit_patches"])
def test_internal_scan_diagnostics_are_not_in_the_mail(html, needle):
    assert needle not in html


# ── 담당자가 필요한 것은 남는다 ────────────────────────────────────────────

def test_location_and_actions_remain(html):
    """그릇은 보여주고 내용물은 감춘다."""
    assert "src/config.py" in html
    assert "토큰 폐기 후 재발급" in html


def test_sensitive_summary_and_actions_are_attached(html):
    assert "확인된 민감 항목" in html
    assert "개인키" in html and "크리덴셜·비밀번호" in html
    assert "폐기·재발급" in html
    assert "접속 로그" in html or "접속 이력" in html


def test_no_sensitive_section_when_nothing_matches():
    """빈 표를 그리지 않는다."""
    bare = {"severity": "low", "path": "a.md",
            "hits": [{"category": "misconfig", "kind": "open_share_exposure"}]}
    html = _report_html("org/repo", [bare], _report_summary([bare]))
    assert "확인된 민감 항목" not in html


# ── 저장소 담당자 폴백 ─────────────────────────────────────────────────────
#
# finding 의 `author_email` 은 **그 커밋을 올린 사람**이고 저장소를 관리하는 사람과 다를 수
# 있다. 게다가 신 스캔 경로에는 한동안 그 값이 아예 없었다(0/2,177). 담당자가 비면 스레드가
# `owner_recipient` 없이 생기고 claim 필터(주차 ∧ 담당자)에서 영원히 걸린다.

def test_repo_owner_is_looked_up_when_the_finding_has_none(monkeypatch):
    from domains.services.github.application import scanner
    monkeypatch.setattr(scanner.state, "github_repo_owner_get",
                        lambda repo: {"repo": repo, "knox_id": "hong.gildong"})
    assert scanner._repo_owner_recipients("org/repo") == ["hong.gildong@samsung.com"]


def test_mail_address_rule_is_not_reimplemented_here(monkeypatch):
    """★ `knox_id → 메일` 규칙은 `knox_directory.Employee.email` 이 소유한다.

    여기서 f-string 으로 조립하면 규칙이 두 곳이 되고, 오늘만 네 번 본 그 사고가 또 난다."""
    from service.services.knox_directory import Employee
    from domains.services.github.application import scanner
    monkeypatch.setattr(scanner.state, "github_repo_owner_get",
                        lambda repo: {"knox_id": "a.b"})
    assert scanner._repo_owner_recipients("x/y") == [Employee(knox_id="a.b").email]


@pytest.mark.parametrize("row", [None, {}, {"knox_id": ""}, {"knox_id": "   "}])
def test_missing_owner_yields_empty_not_a_guess(monkeypatch, row):
    from domains.services.github.application import scanner
    monkeypatch.setattr(scanner.state, "github_repo_owner_get", lambda repo: row)
    assert scanner._repo_owner_recipients("org/repo") == []


def test_lookup_failure_does_not_block_thread_creation(monkeypatch):
    """담당자 조회가 깨져도 스레드는 생겨야 한다 — 없으면 finding 이 통째로 묻힌다."""
    from domains.services.github.application import scanner

    def boom(_repo):
        raise RuntimeError("directory down")

    monkeypatch.setattr(scanner.state, "github_repo_owner_get", boom)
    assert scanner._repo_owner_recipients("org/repo") == []


def test_blank_repo_is_not_looked_up(monkeypatch):
    from domains.services.github.application import scanner
    called = []
    monkeypatch.setattr(scanner.state, "github_repo_owner_get",
                        lambda repo: called.append(repo))
    assert scanner._repo_owner_recipients("") == []
    assert called == []
