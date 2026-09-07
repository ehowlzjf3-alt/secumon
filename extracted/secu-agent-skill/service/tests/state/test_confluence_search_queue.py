"""B: confluence_search_target rolling 큐 — confluence_space_target 미러(keyword 키).

REST CQL 정책차단 → dosearchsite 브라우저 검색 큐. bounded, oldest-first(never 먼저),
cooldown 재검색, stale 재claim, batch claim, cycle 리셋, scope/config 갱신.
"""
from __future__ import annotations

import time

import service.state_domain as sd


def test_upsert_is_bounded_and_preserves_scan_history(tmp_db):
    from secu_agent import state  # noqa: F401

    a = sd.confluence_search_target_upsert("password", scope_space_keys=["ENGOPS"], config_version="v1")
    sd.confluence_search_target_set_status(a, "tasked", last_scanned_at=1000.0, finding_count=2)
    # 재upsert: 같은 id · scope/config 갱신 · last_scanned_at/status 보존
    a2 = sd.confluence_search_target_upsert("password", scope_space_keys=["ENGOPS", "DSSOC"], config_version="v2")
    assert a2 == a
    row = sd.confluence_search_target_get(a)
    assert row["config_version"] == "v2"
    assert row["last_scanned_at"] == 1000.0
    assert row["status"] == "tasked"
    assert row["finding_count"] == 2
    # bounded: keyword 수 = row 수(누적 X)
    sd.confluence_search_target_upsert("password")
    assert sd.confluence_search_targets_summary()["total"] == 1


def test_claim_never_first_then_oldest(tmp_db):
    from secu_agent import state  # noqa: F401

    sd.confluence_search_target_upsert("never_kw")
    k_old = sd.confluence_search_target_upsert("old_kw")
    k_new = sd.confluence_search_target_upsert("recent_due_kw")
    sd.confluence_search_target_set_status(k_old, "tasked", last_scanned_at=100.0)
    sd.confluence_search_target_set_status(k_new, "tasked", last_scanned_at=time.time() - 200000)

    c1 = sd.confluence_search_target_claim_next(session_id=7, limit=1)
    assert [r["keyword"] for r in c1] == ["never_kw"]  # never(NULL) 먼저
    assert c1[0]["status"] == "in_progress" and c1[0]["claimed_by"] == 7
    c2 = sd.confluence_search_target_claim_next(session_id=7, limit=1)
    assert [r["keyword"] for r in c2] == ["old_kw"]
    c3 = sd.confluence_search_target_claim_next(session_id=7, limit=1)
    assert [r["keyword"] for r in c3] == ["recent_due_kw"]


def test_cooldown_excludes_recently_scanned(tmp_db):
    from secu_agent import state  # noqa: F401

    r = sd.confluence_search_target_upsert("fresh_kw")
    sd.confluence_search_target_set_status(r, "tasked")  # last_scanned_at = now
    assert sd.confluence_search_target_claim_next(session_id=1) == []
    again = sd.confluence_search_target_claim_next(session_id=1, cooldown_seconds=0)
    assert [x["keyword"] for x in again] == ["fresh_kw"]


def test_stale_in_progress_reclaimed(tmp_db):
    from secu_agent import state  # noqa: F401

    r = sd.confluence_search_target_upsert("stuck_kw")
    sd.confluence_search_target_set_status(r, "in_progress", claimed_by=99, claimed_at=time.time() - 99999)
    claimed = sd.confluence_search_target_claim_next(session_id=2, stale_seconds=1800)
    assert [x["keyword"] for x in claimed] == ["stuck_kw"]
    assert claimed[0]["claimed_by"] == 2
    assert sd.confluence_search_target_claim_next(session_id=3, stale_seconds=1800) == []


def test_batch_claim_limit(tmp_db):
    from secu_agent import state  # noqa: F401

    for i in range(5):
        sd.confluence_search_target_upsert(f"kw{i}")
    claimed = sd.confluence_search_target_claim_next(session_id=1, limit=3)
    assert len(claimed) == 3
    assert all(x["status"] == "in_progress" for x in claimed)
    assert len(sd.confluence_search_target_claim_next(session_id=1, limit=10)) == 2


def test_set_status_tasked_releases_claim(tmp_db):
    from secu_agent import state  # noqa: F401

    r = sd.confluence_search_target_upsert("kw_x")
    sd.confluence_search_target_claim_next(session_id=1)
    sd.confluence_search_target_set_status(r, "tasked", finding_count=3)
    row = sd.confluence_search_target_get(r)
    assert row["status"] == "tasked"
    assert row["finding_count"] == 3
    assert row["last_scanned_at"] is not None
    assert row["claimed_by"] is None and row["claimed_at"] is None


def test_scope_json_roundtrip(tmp_db):
    from secu_agent import state  # noqa: F401

    r = sd.confluence_search_target_upsert("scoped_kw", scope_space_keys=["A", "B"])
    row = sd.confluence_search_target_get(r)
    import json
    assert json.loads(row["scope_json"]) == ["A", "B"]  # 정렬 저장
    # scope 없는 upsert
    r2 = sd.confluence_search_target_upsert("global_kw")
    assert sd.confluence_search_target_get(r2)["scope_json"] is None


def test_weekly_cycle_resets_completed_to_fresh_queue(tmp_db, monkeypatch):
    from secu_agent import state  # noqa: F401

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W27")
    k = sd.confluence_search_target_upsert("weekly_kw")
    sd.confluence_search_target_set_status(k, "tasked", finding_count=3)
    assert sd.confluence_search_target_get(k)["cycle_key"] == "2026-W27"

    monkeypatch.setattr(sd, "smb_current_cycle_key", lambda ts=None: "2026-W28")
    reset = sd.confluence_search_cycle_ensure_current()
    row = sd.confluence_search_target_get(k)
    assert reset["targets_reset"] == 1
    assert row["status"] == "pending"
    assert row["cycle_key"] == "2026-W28"
    assert row["cycle_scanned_at"] is None
    claimed = sd.confluence_search_target_claim_next(session_id=88)
    assert [x["keyword"] for x in claimed] == ["weekly_kw"]


def test_upsert_rejects_empty_keyword(tmp_db):
    import pytest

    from secu_agent import state  # noqa: F401
    with pytest.raises(ValueError):
        sd.confluence_search_target_upsert("")


def test_keyword_sync_seeds_queue_and_is_claimable(tmp_db, monkeypatch):
    """허용목록 YAML → 큐 시드 sync(패키지 기본 config). bounded·idempotent·claimable."""
    from secu_agent import state  # noqa: F401
    from service.agents import confluence_discovery_agent as disc

    monkeypatch.setattr(disc, "load_runtime_env", lambda load_plugins=False: None)
    # 키워드 목록/버전은 운영 중 늘어나는 **설정값**이라 숫자를 박아두면 키워드를 추가할
    # 때마다 이 테스트가 깨진다(실제로 15→46 확장 때 깨졌다). 여기서 고정할 계약은
    # sync 의 **동작**(전량 시드·idempotent·claimable)이지 설정 내용이 아니다.
    expected_version, expected_entries = disc._load_search_keywords()
    n = len(expected_entries)
    assert n >= 15, "패키지 기본 키워드 설정이 비었다"

    res = disc.run_search_keyword_sync()
    assert res["config_version"] == expected_version
    assert res["keywords"] == res["total"] == res["new"] == n
    # 재sync = bounded(누적 X)·진행상태 보존
    res2 = disc.run_search_keyword_sync()
    assert res2["total"] == n and res2["new"] == 0
    # 시드된 키워드는 oldest-first 로 claim 가능(never 먼저)
    claimed = sd.confluence_search_target_claim_next(session_id=1, limit=200)
    assert len(claimed) == n
    kws = {c["keyword"] for c in claimed}
    assert kws == {e["keyword"] for e in expected_entries}
    assert "password" in kws and "비밀번호" in kws  # 영문/국문 축이 둘 다 살아있는지
    assert all(c["status"] == "in_progress" for c in claimed)
