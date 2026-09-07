"""v3.61 D1: devops_target 전용 테이블 + claim (web_target 과 완전 독립).

DevOps(github/confluence) 점검 타깃은 URL 단위. web 공통 claim 함수를 안 건드리고
전용 테이블/함수로 격리. 동시 세션이 같은 URL 중복 안 물게 atomic claim.
"""
from __future__ import annotations

import datetime as dt
import time

import pytest

import service.state_domain as sd
from secu_agent import state


@pytest.fixture(autouse=True)
def _isolated_db(tmp_db):
    yield


def _today() -> str:
    return dt.date.today().isoformat()


def _seed(day, *specs):
    ids = []
    for url, service, cnt in specs:
        ids.append(sd.devops_target_upsert(
            url, service=service, source="proxy", day_bucket=day, access_count=cnt))
    return ids


def test_claim_returns_highest_access_and_marks_in_progress():
    day = _today()
    _seed(day,
          ("https://github.samsungds.net/A/low", "github", 3),
          ("https://github.samsungds.net/A/hot", "github", 88))
    row = sd.devops_target_claim_next(session_id=15, day_bucket=day)
    assert row is not None
    assert row["url"].endswith("/hot")
    assert row["status"] == "in_progress"
    assert row["claimed_by"] == 15
    assert sd.devops_target_get(row["id"])["status"] == "in_progress"


def test_concurrent_claims_distinct():
    day = _today()
    _seed(day,
          ("https://github.samsungds.net/a", "github", 5),
          ("https://confluence.samsungds.net/display/B", "confluence", 4))
    r1 = sd.devops_target_claim_next(session_id=15, day_bucket=day)
    r2 = sd.devops_target_claim_next(session_id=16, day_bucket=day)
    assert r1["id"] != r2["id"]


def test_claim_none_when_empty():
    assert sd.devops_target_claim_next(session_id=1, day_bucket=_today()) is None


def test_claim_service_filter_isolates_github_confluence():
    """v3.74: github-batch 는 github 타깃만, confluence-batch 는 confluence 타깃만 claim."""
    day = _today()
    _seed(day,
          ("https://github.samsungds.net/a", "github", 5),
          ("https://confluence.samsungds.net/display/B", "confluence", 9))
    gh = sd.devops_target_claim_next(session_id=21, day_bucket=day, service="github")
    assert gh is not None and gh["service"] == "github"
    cf = sd.devops_target_claim_next(session_id=22, day_bucket=day, service="confluence")
    assert cf is not None and cf["service"] == "confluence"
    # github 만 남기면 confluence claim 은 None
    assert sd.devops_target_claim_next(
        session_id=23, day_bucket=day, service="github") is None


def test_upsert_does_not_steal_existing_url_from_other_service():
    day = _today()
    target_id = sd.devops_target_upsert(
        "https://github.samsungds.net/shared/url",
        service="github",
        source="proxy",
        day_bucket=day,
        access_count=5,
    )
    sd.devops_target_set_status(
        target_id,
        "in_progress",
        claimed_by=1234,
        claimed_at=time.time(),
    )

    same_id = sd.devops_target_upsert(
        "https://github.samsungds.net/shared/url",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=99,
    )

    row = sd.devops_target_get(target_id)
    assert same_id == target_id
    assert row["service"] == "github"
    assert row["status"] == "in_progress"
    assert row["claimed_by"] == 1234
    assert row["access_count"] == 5


def test_cross_service_upsert_does_not_reset_existing_url_on_new_cycle(monkeypatch):
    day = _today()
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    target_id = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/SHARED",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=7,
    )
    sd.devops_target_set_status(target_id, "tasked", finding_count=2)

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    same_id = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/SHARED",
        service="github",
        source="proxy",
        day_bucket=day,
        access_count=99,
    )

    row = sd.devops_target_get(target_id)
    assert same_id == target_id
    assert row["service"] == "confluence"
    assert row["cycle_key"] == "2026-W27"
    assert row["status"] == "tasked"
    assert row["cycle_finding_count"] == 2
    assert row["access_count"] == 7


def test_stale_reclaimed():
    day = _today()
    ids = _seed(day, ("https://github.samsungds.net/x", "github", 1))
    sd.devops_target_claim_next(session_id=15, day_bucket=day)
    sd.devops_target_set_status(ids[0], "in_progress", claimed_at=time.time() - 99999)
    r = sd.devops_target_claim_next(session_id=16, day_bucket=day, stale_seconds=1800)
    assert r is not None and r["claimed_by"] == 16


def test_retry_after_excludes_pending_until_due():
    day = _today()
    ids = _seed(day, ("https://github.samsungds.net/retry", "github", 1))
    with sd.connect() as c:
        c.execute(
            "UPDATE devops_target SET retry_after=? WHERE id=?",
            (time.time() + 3600, ids[0]),
        )

    assert sd.devops_target_claim_next(session_id=1, day_bucket=day) is None

    with sd.connect() as c:
        c.execute(
            "UPDATE devops_target SET retry_after=? WHERE id=?",
            (time.time() - 1, ids[0]),
        )
    row = sd.devops_target_claim_next(session_id=1, day_bucket=day)
    assert row is not None
    assert row["id"] == ids[0]


def test_terminal_clears_claim():
    day = _today()
    ids = _seed(day, ("https://github.samsungds.net/x", "github", 1))
    sd.devops_target_claim_next(session_id=15, day_bucket=day)
    sd.devops_target_set_status(ids[0], "tasked", finding_count=2)
    got = sd.devops_target_get(ids[0])
    assert got["status"] == "tasked"
    assert got["claimed_by"] is None and got["claimed_at"] is None
    assert got["retry_after"] is None


def test_summary():
    day = _today()
    _seed(day,
          ("https://github.samsungds.net/a", "github", 5),
          ("https://github.samsungds.net/b", "github", 4))
    sd.devops_target_claim_next(session_id=15, day_bucket=day)
    s = sd.devops_targets_summary(day_bucket=day)
    assert s["total"] == 2
    assert s["in_progress"] == 1
    assert s["pending"] == 1


def _set_last_task(target_id, ts):
    with sd.connect() as c:
        c.execute("UPDATE devops_target SET last_task_at=? WHERE id=?", (ts, target_id))


def test_claim_never_first_then_access_count_secondary():
    """v3.76 rolling: 안 본 것(last_task_at NULL) 먼저 → access_count desc secondary."""
    day = _today()
    ids = _seed(day,
                ("https://github.samsungds.net/never", "github", 1),
                ("https://github.samsungds.net/hot", "github", 99))
    # hot 을 tasked(본 적 있음, cooldown 풀림)로
    sd.devops_target_set_status(ids[1], "tasked")
    _set_last_task(ids[1], time.time() - 200000)
    c1 = sd.devops_target_claim_next(session_id=1, day_bucket=day, cooldown_seconds=0)
    assert c1["url"].endswith("/never")  # never 가 access_count 낮아도 먼저


def test_cooldown_re_task_of_terminal():
    """terminal(tasked) devops row 도 cooldown 지나면 재헌트."""
    day = _today()
    ids = _seed(day, ("https://github.samsungds.net/done", "github", 5))
    sd.devops_target_set_status(ids[0], "tasked")  # last_task_at = now
    assert sd.devops_target_claim_next(session_id=1, day_bucket=day) is None
    again = sd.devops_target_claim_next(session_id=1, day_bucket=day, cooldown_seconds=0)
    assert again is not None and again["url"].endswith("/done")


def test_isolated_from_web_target():
    """devops claim 이 web_target 을 안 건드리고, web claim 도 devops 를 안 건드림."""
    day = _today()
    sd.web_target_upsert("cdep-site.samsungds.net", source="splunk",
                            day_bucket=day, event_count=10)
    _seed(day, ("https://github.samsungds.net/a", "github", 5))
    # devops claim → web pending 그대로
    sd.devops_target_claim_next(session_id=15, day_bucket=day)
    assert sd.web_targets_summary(day_bucket=day)["pending"] == 1
    # web claim → devops pending 그대로
    sd.web_target_claim_next(session_id=16, day_bucket=day)
    assert sd.devops_targets_summary(day_bucket=day)["pending"] == 0  # 이미 위에서 claim
    # (devops 1개를 위에서 claim 했으니 pending 0, in_progress 1 — web claim 영향 없음)
    assert sd.devops_targets_summary(day_bucket=day)["in_progress"] == 1


def test_confluence_sso_cycle_resets_completed_url_to_fresh_queue(monkeypatch):
    day = _today()
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    target_id = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/WEEKLY",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=7,
    )
    sd.devops_target_set_status(target_id, "tasked", finding_count=3)
    done = sd.devops_target_get(target_id)
    assert done["cycle_key"] == "2026-W27"
    assert done["cycle_scanned_at"] is not None
    assert done["cycle_finding_count"] == 3
    assert sd.devops_target_claim_next(
        session_id=1,
        service="confluence",
        cycle_key="2026-W27",
    ) is None

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    reset = sd.devops_target_cycle_ensure_current(service="confluence")
    row = sd.devops_target_get(target_id)
    assert reset["targets_reset"] == 1
    assert row["status"] == "pending"
    assert row["cycle_key"] == "2026-W28"
    assert row["cycle_scanned_at"] is None
    assert row["cycle_finding_count"] == 0

    claimed = sd.devops_target_claim_next(
        session_id=88,
        service="confluence",
        cycle_key="2026-W28",
    )
    assert claimed is not None
    assert claimed["id"] == target_id


def test_confluence_sso_cycle_reset_does_not_reset_github_devops_rows(monkeypatch):
    day = _today()
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    confluence_id = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/ONLY",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=3,
    )
    github_id = sd.devops_target_upsert(
        "https://github.samsungds.net/org/repo",
        service="github",
        source="proxy",
        day_bucket=day,
        access_count=99,
    )
    sd.devops_target_set_status(confluence_id, "tasked")
    sd.devops_target_set_status(github_id, "tasked")

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    sd.devops_target_cycle_ensure_current(service="confluence")

    confluence = sd.devops_target_get(confluence_id)
    github = sd.devops_target_get(github_id)
    assert confluence["cycle_key"] == "2026-W28"
    assert confluence["status"] == "pending"
    assert github["cycle_key"] == "2026-W27"
    assert github["status"] == "tasked"


def test_github_sso_cycle_resets_completed_url_to_fresh_queue(monkeypatch):
    day = _today()
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    target_id = sd.devops_target_upsert(
        "https://github.samsungds.net/sec/repo",
        service="github",
        source="proxy",
        day_bucket=day,
        access_count=11,
    )
    sd.devops_target_set_status(target_id, "tasked", finding_count=2)
    done = sd.devops_target_get(target_id)
    assert done["cycle_key"] == "2026-W27"
    assert done["cycle_scanned_at"] is not None
    assert done["cycle_finding_count"] == 2
    assert sd.devops_target_claim_next(
        session_id=1,
        service="github",
        cycle_key="2026-W27",
    ) is None

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    reset = sd.devops_target_cycle_ensure_current(service="github")
    row = sd.devops_target_get(target_id)
    assert reset["targets_reset"] == 1
    assert row["status"] == "pending"
    assert row["cycle_key"] == "2026-W28"
    assert row["cycle_scanned_at"] is None
    assert row["cycle_finding_count"] == 0

    claimed = sd.devops_target_claim_next(
        session_id=89,
        service="github",
        cycle_key="2026-W28",
    )
    assert claimed is not None
    assert claimed["id"] == target_id


def test_github_sso_cycle_reset_does_not_reset_confluence_devops_rows(monkeypatch):
    day = _today()
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    github_id = sd.devops_target_upsert(
        "https://github.samsungds.net/org/repo",
        service="github",
        source="proxy",
        day_bucket=day,
        access_count=99,
    )
    confluence_id = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/ONLY",
        service="confluence",
        source="proxy",
        day_bucket=day,
        access_count=3,
    )
    sd.devops_target_set_status(github_id, "tasked")
    sd.devops_target_set_status(confluence_id, "tasked")

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    sd.devops_target_cycle_ensure_current(service="github")

    github = sd.devops_target_get(github_id)
    confluence = sd.devops_target_get(confluence_id)
    assert github["cycle_key"] == "2026-W28"
    assert github["status"] == "pending"
    assert confluence["cycle_key"] == "2026-W27"
    assert confluence["status"] == "tasked"


def test_confluence_sso_cycle_reset_uses_latest_row_per_url(monkeypatch):
    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    older = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/DUP",
        service="confluence",
        source="proxy",
        day_bucket="2026-06-23",
        access_count=1,
    )
    newer = sd.devops_target_upsert(
        "https://confluence.samsungds.net/display/DUP",
        service="confluence",
        source="proxy",
        day_bucket="2026-06-30",
        access_count=9,
    )
    sd.devops_target_set_status(older, "tasked")
    sd.devops_target_set_status(newer, "tasked")

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    reset = sd.devops_target_cycle_ensure_current(service="confluence")

    assert reset["targets_reset"] == 1
    assert sd.devops_target_get(older)["cycle_key"] == "2026-W27"
    assert sd.devops_target_get(newer)["cycle_key"] == "2026-W28"
    claimed = sd.devops_target_claim_next(
        session_id=99,
        service="confluence",
        cycle_key="2026-W28",
    )
    assert claimed is not None
    assert claimed["id"] == newer
    assert sd.devops_target_claim_next(
        session_id=100,
        service="confluence",
        cycle_key="2026-W28",
    ) is None
