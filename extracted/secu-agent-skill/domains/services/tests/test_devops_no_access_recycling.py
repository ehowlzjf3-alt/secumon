"""프록시 발견 경로의 접근불가 타깃 재순환 차단 — 커버리지 낭비 방지 계약.

배경(실측): `devops_target` 481건이 **전부** `source='proxy'`다. 프록시 로그는 "누가 방문한
URL"이라 GitHub API 를 한 번도 안 부르므로 우리가 못 읽는 private repo 도 그대로 등재된다.
그 결과 접근불가 270건 중 180건이 cooldown/주간 리셋마다 `pending` 으로 돌아와 무한 재순환했다
(github pending 270 의 67%가 이미 못 읽는다고 판명난 repo). 워커가 계속 물고 계속 실패한다.

여기서 고정하는 계약:
  ① 등재 시점에 readability 를 확인해 못 읽는 건 pending 풀에 안 들어간다
  ② 확인 실패(네트워크/rate)는 **접근불가로 단정하지 않는다** — 조용한 커버리지 손실 방지
  ③ 접근불가 판명 타깃은 긴 백오프로 닫히고, 주간 리셋이 그 백오프를 지우지 않는다
  ④ 영구 제외가 아니다 — 백오프가 지나면 다시 본다(권한 부여/공개 전환 가능)
"""
from __future__ import annotations

import time

import pytest

import service.state_domain as sd
from domains.services.application.devops_discovery import (
    DevopsDiscoveryConfig,
    github_repo_slug,
    ingest_devops_discovery_rows,
)

_GH = "https://github.samsungds.net"


def _rows(*slugs: str) -> list[dict]:
    return [{"full_url": f"{_GH}/{s}", "count": 5} for s in slugs]


def _cfg() -> DevopsDiscoveryConfig:
    return DevopsDiscoveryConfig(earliest="-1d", latest="now", day_bucket="2026-07-28",
                                 max_urls=100)


# ── slug 추출 ────────────────────────────────────────────────────────────
@pytest.mark.parametrize("url,expected", [
    (f"{_GH}/org/repo", "org/repo"),
    (f"{_GH}/org/repo/", "org/repo"),
    ("https://confluence.samsungds.net/display/ENG", None),
    (f"{_GH}/onlyorg", None),
    ("not a url", None),
])
def test_github_repo_slug(url, expected):
    assert github_repo_slug(url) == expected


# ── ① 등재 시점 필터 ─────────────────────────────────────────────────────
def test_unreadable_targets_never_enter_pending(tmp_db):
    from secu_agent import state  # noqa: F401

    res = ingest_devops_discovery_rows(
        _rows("org/readable", "org/hidden"),
        config=_cfg(), store=sd, service_filter="github",
        visibility_check=lambda slug: slug == "org/readable",
    )
    assert res["visibility_checked"] == 2
    assert res["no_access"] == 1

    claimed = []
    while (row := sd.devops_target_claim_next(session_id=1, service="github")) is not None:
        claimed.append(row["url"])
        sd.devops_target_set_status(row["id"], "tasked")
    assert claimed == [f"{_GH}/org/readable"], "못 읽는 repo 가 워커에 물렸다"


def test_unreadable_target_row_is_kept_not_deleted(tmp_db):
    """행을 지우면 내일 프록시 로그에서 다시 발견해 매번 재확인하게 된다."""
    from secu_agent import state  # noqa: F401

    ingest_devops_discovery_rows(
        _rows("org/hidden"), config=_cfg(), store=sd, service_filter="github",
        visibility_check=lambda _s: False,
    )
    summary = sd.devops_targets_summary(service="github")
    assert summary["total"] == 1
    assert summary["skipped"] == 1 and summary["pending"] == 0


# ── ② 확인 실패는 단정하지 않는다 ────────────────────────────────────────
def test_visibility_check_error_keeps_target_alive(tmp_db):
    """일시적 실패로 멀쩡한 타깃을 닫으면 커버리지를 조용히 잃는다."""
    from secu_agent import state  # noqa: F401

    def _boom(_slug):
        raise RuntimeError("connection reset")

    res = ingest_devops_discovery_rows(
        _rows("org/maybe"), config=_cfg(), store=sd, service_filter="github",
        visibility_check=_boom,
    )
    assert res["visibility_check_errors"] == 1
    assert res["no_access"] == 0
    assert sd.devops_targets_summary(service="github")["pending"] == 1


def test_no_check_preserves_legacy_behaviour(tmp_db):
    from secu_agent import state  # noqa: F401

    res = ingest_devops_discovery_rows(
        _rows("org/a", "org/b"), config=_cfg(), store=sd, service_filter="github",
        visibility_check=None,
    )
    assert res["no_access"] == 0 and res["visibility_checked"] == 0
    assert sd.devops_targets_summary(service="github")["pending"] == 2


def test_confluence_rows_are_not_visibility_checked(tmp_db):
    """github 전용 확인이 confluence 타깃까지 건드리면 안 된다."""
    from secu_agent import state  # noqa: F401

    calls: list[str] = []
    ingest_devops_discovery_rows(
        [{"full_url": "https://confluence.samsungds.net/display/ENGOPS", "count": 3}],
        config=_cfg(), store=sd, service_filter=None,
        visibility_check=lambda s: calls.append(s) or True,
    )
    assert calls == []
    assert sd.devops_targets_summary(service="confluence")["pending"] == 1


# ── ③④ 백오프와 주간 리셋 ───────────────────────────────────────────────
def test_weekly_cycle_reset_preserves_future_backoff(tmp_db, monkeypatch):
    """주간 리셋이 백오프를 지우면 재순환이 그대로 살아난다."""
    from secu_agent import state  # noqa: F401

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W30")
    ingest_devops_discovery_rows(
        _rows("org/hidden", "org/open"), config=_cfg(), store=sd, service_filter="github",
        visibility_check=lambda slug: slug == "org/open",
    )
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W31")
    reset = sd.devops_target_cycle_ensure_current(service="github")

    assert reset["targets_reset"] == 1, "백오프 걸린 행까지 리셋됐다"
    rows = {r["url"]: r for r in _all_targets()}
    assert rows[f"{_GH}/org/open"]["status"] == "pending"
    assert rows[f"{_GH}/org/hidden"]["status"] == "skipped"
    assert rows[f"{_GH}/org/hidden"]["retry_after"] > time.time()


def test_reupsert_across_cycle_preserves_future_backoff(tmp_db, monkeypatch):
    """같은 (url, day_bucket) 행이 주 경계 뒤 재등재돼도 백오프가 살아있어야 한다.

    `devops_target_upsert` 의 cycle 전환 분기가 `retry_after=NULL` 로 지우고 있었다 —
    `devops_target_cycle_ensure_current` 만 고쳤으면 이쪽으로 재순환이 그대로 샜다.
    """
    from secu_agent import state  # noqa: F401

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W30")
    ingest_devops_discovery_rows(
        _rows("org/hidden"), config=_cfg(), store=sd, service_filter="github",
        visibility_check=lambda _s: False,
    )
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W31")
    ingest_devops_discovery_rows(  # 같은 day_bucket 을 새 사이클에서 재수집
        _rows("org/hidden"), config=_cfg(), store=sd, service_filter="github",
        visibility_check=None,
    )
    row = _all_targets()[0]
    assert row["cycle_key"] == "2026-W31", "메타(cycle_key)는 갱신돼야 한다"
    assert row["status"] == "skipped", "백오프 걸린 행이 pending 으로 되살아났다"
    assert row["retry_after"] > time.time()


def test_reupsert_across_cycle_still_resets_normal_targets(tmp_db, monkeypatch):
    """백오프 없는 평범한 타깃은 기존대로 사이클 전환 시 pending 으로 리셋된다."""
    from secu_agent import state  # noqa: F401

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W30")
    ingest_devops_discovery_rows(
        _rows("org/open"), config=_cfg(), store=sd, service_filter="github",
    )
    tid = _all_targets()[0]["id"]
    sd.devops_target_set_status(tid, "tasked", finding_count=2)
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W31")
    ingest_devops_discovery_rows(
        _rows("org/open"), config=_cfg(), store=sd, service_filter="github",
    )
    row = _all_targets()[0]
    assert row["status"] == "pending" and row["cycle_key"] == "2026-W31"
    assert row["cycle_scanned_at"] is None


def test_backoff_is_not_permanent_exclusion(tmp_db):
    """권한이 부여되면 다시 읽힐 수 있다 — 백오프가 지나면 반드시 재claim 되어야 한다."""
    from secu_agent import state  # noqa: F401

    ingest_devops_discovery_rows(
        _rows("org/hidden"), config=_cfg(), store=sd, service_filter="github",
        visibility_check=lambda _s: False, no_access_backoff_seconds=1.0,
    )
    assert sd.devops_target_claim_next(session_id=1, service="github") is None
    time.sleep(1.1)
    row = sd.devops_target_claim_next(
        session_id=1, service="github", cooldown_seconds=0,
    )
    assert row is not None and row["url"] == f"{_GH}/org/hidden"


def test_zero_backoff_disables_deferral(tmp_db):
    from secu_agent import state  # noqa: F401

    ingest_devops_discovery_rows(
        _rows("org/hidden"), config=_cfg(), store=sd, service_filter="github",
        visibility_check=lambda _s: False, no_access_backoff_seconds=0,
    )
    row = _all_targets()[0]
    assert row["status"] == "skipped"
    assert row["retry_after"] is None


# ── 워커 종료 경로(소비 시점 판명) ───────────────────────────────────────
def test_set_status_tool_applies_backoff_on_no_access(tmp_db, monkeypatch):
    """워커가 스캔 중 404 를 만나 skipped 로 닫을 때도 백오프가 걸려야 한다."""
    from secu_agent import state  # noqa: F401
    from domains.services.plugin.tools import devops_discovery_tool as ddt

    assert ddt._no_access_reason("repo metadata not found") is True
    assert ddt._no_access_reason("no_access: not readable at ingestion") is True
    assert ddt._no_access_reason("no sensitive data found") is False
    assert ddt._no_access_reason(None) is False

    monkeypatch.setenv("SA_DEVOPS_NO_ACCESS_BACKOFF_SEC", "600")
    assert ddt._no_access_backoff_seconds() == 600.0
    monkeypatch.delenv("SA_DEVOPS_NO_ACCESS_BACKOFF_SEC")
    assert ddt._no_access_backoff_seconds() == 30 * 86400.0


def _all_targets() -> list[dict]:
    with sd.connect() as c:
        rows = c.execute("SELECT * FROM devops_target").fetchall()
    return [{k: r[k] for k in r.keys()} for r in rows]


# ── v3.92 범위 밖(private/제외목록) 과 접근불가의 분리 ──────────────────────
@pytest.mark.parametrize("verdict,expected", [
    (True, None),                       # 예전 bool 검사기 — 읽힘
    (None, None),                       # 판정 보류 = 유지
    ("", None),                         # 빈 사유는 사유가 아니다
    ("   ", None),
    (False, "no_access: not readable at ingestion"),
    ("out_of_scope: private repo", "out_of_scope: private repo"),
])
def test_screen_reason_accepts_both_contracts(verdict, expected):
    """bool 검사기와 사유 문자열 검사기를 같이 받는다.

    `None` 을 '닫아라'로 읽으면 검사기가 실수로 아무것도 안 돌려준 순간 큐가 통째로
    닫힌다. 애매하면 살려두는 쪽이 안전하다.
    """
    from domains.services.application.devops_discovery import screen_reason

    assert screen_reason(verdict) == expected


def test_out_of_scope_is_counted_apart_from_no_access(tmp_db):
    """둘을 뭉뚱그리면 '못 읽는다'와 '읽히지만 범위가 아니다'가 구분이 안 된다."""
    from secu_agent import state  # noqa: F401

    def _screen(slug: str):
        if slug == "org/private":
            return "out_of_scope: private repo"
        if slug == "org/hidden":
            return "no_access: repo metadata not found at ingestion"
        return None

    res = ingest_devops_discovery_rows(
        _rows("org/ok", "org/private", "org/hidden"),
        config=_cfg(), store=sd, service_filter="github",
        visibility_check=_screen,
    )
    assert res["visibility_checked"] == 3
    assert res["no_access"] == 1
    assert res["out_of_scope"] == 1
    assert res["screened_out"] == 2

    rows = {github_repo_slug(r["url"]): r for r in _all_targets()}
    assert rows["org/private"]["status"] == "skipped"
    assert rows["org/private"]["last_reason"] == "out_of_scope: private repo"
    assert rows["org/private"]["retry_after"] > time.time()
    assert rows["org/ok"]["status"] == "pending"


def test_out_of_scope_target_is_never_claimed(tmp_db):
    from secu_agent import state  # noqa: F401

    ingest_devops_discovery_rows(
        _rows("org/ok", "ai-for-security/secu-agent"),
        config=_cfg(), store=sd, service_filter="github",
        visibility_check=lambda slug: ("out_of_scope: excluded repo"
                                       if slug.startswith("ai-for-security/") else None),
    )
    claimed = []
    while (row := sd.devops_target_claim_next(session_id=1, service="github")) is not None:
        claimed.append(row["url"])
        sd.devops_target_set_status(row["id"], "tasked")
    assert claimed == [f"{_GH}/org/ok"], "범위 밖 repo 가 워커에 물렸다"


def test_worker_reported_out_of_scope_also_gets_backoff(tmp_db, monkeypatch):
    """워커가 out_of_scope 로 닫는 경로에도 백오프가 붙어야 매주 재순환하지 않는다."""
    from secu_agent import state  # noqa: F401
    from domains.services.plugin.tools import devops_discovery_tool as ddt

    assert ddt._no_access_reason("out_of_scope: private repo") is True


# ── 제외 glob 매칭(두 발견 경로 공용) ────────────────────────────────────
@pytest.mark.parametrize("slug,patterns,expected", [
    ("aiplatform-external/gitleaks", ["*/gitleaks"], True),
    ("AI-for-Security/secu-agent", ["ai-for-security/*"], True),   # 대소문자 무시
    ("ai-for-security/secu-agent", ["AI-for-Security/*"], True),
    ("team/real-service", ["*/gitleaks", "ai-for-security/*"], False),
    ("team/real-service", [], False),
    ("team/real-service", None, False),
    ("", ["*"], False),                                            # 빈 slug 는 제외 아님
])
def test_repo_excluded_matching(slug, patterns, expected):
    from domains.services.application.devops_discovery import repo_excluded

    assert repo_excluded(slug, patterns) is expected
