"""v3.53-1: web_target_domain schema + helpers."""
from __future__ import annotations

import datetime as dt

import pytest

import service.state_domain as sd
from secu_agent import state


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    monkeypatch.setenv("SECU_AGENT_DB", str(tmp_path / "test.sqlite3"))
    # state caches connection per pid — clear
    state._cached_db_path.cache_clear() if hasattr(state, "_cached_db_path") else None
    yield


def _today() -> str:
    return dt.date.today().isoformat()


# ─── upsert ────────────────────────────────────────────────


def test_upsert_creates_pending_row():
    tid = sd.web_target_upsert(
        "fmetal-rpa--fmfdcfastapi-prod.cdep.samsungds.net",
        source="splunk", day_bucket=_today(), event_count=135,
    )
    assert tid > 0
    rows = sd.web_targets_pending(day_bucket=_today())
    assert len(rows) == 1
    assert rows[0]["domain"].startswith("fmetal-rpa")
    assert rows[0]["status"] == "pending"
    assert rows[0]["event_count"] == 135


def test_upsert_same_day_dedups():
    """같은 day_bucket 안 같은 domain — 같은 row 갱신 (last_seen + event_count)."""
    today = _today()
    tid1 = sd.web_target_upsert("x.cdep.samsungds.net",
                                   source="splunk", day_bucket=today, event_count=10)
    tid2 = sd.web_target_upsert("x.cdep.samsungds.net",
                                   source="splunk", day_bucket=today, event_count=15)
    assert tid1 == tid2
    rows = sd.web_targets_pending(day_bucket=today)
    assert len(rows) == 1
    assert rows[0]["event_count"] == 15  # 갱신됨


def test_upsert_different_day_buckets_separate_rows():
    """day_bucket 다르면 같은 domain 도 다른 row — 매일 fresh task 위해."""
    tid1 = sd.web_target_upsert("x.cdep.samsungds.net",
                                   source="splunk", day_bucket="2026-05-25", event_count=10)
    tid2 = sd.web_target_upsert("x.cdep.samsungds.net",
                                   source="splunk", day_bucket="2026-05-26", event_count=12)
    assert tid1 != tid2


# ─── set_status + filters ──────────────────────────────────


def test_set_status_marks_tasked():
    today = _today()
    tid = sd.web_target_upsert("a.cdep.samsungds.net",
                                  source="splunk", day_bucket=today, event_count=5)
    sd.web_target_set_status(tid, "tasked", finding_count=2)
    # pending list 에서 사라짐
    pending = sd.web_targets_pending(day_bucket=today)
    assert len(pending) == 0
    # summary 에선 tasked=1
    summary = sd.web_targets_summary(day_bucket=today)
    assert summary["tasked"] == 1
    assert summary["pending"] == 0


def test_set_status_rejects_bad_column():
    """v3.51-S2 column guard 평행."""
    tid = sd.web_target_upsert("b.cdep.samsungds.net",
                                  source="splunk", day_bucket=_today(), event_count=1)
    with pytest.raises(ValueError, match="invalid column"):
        sd.web_target_set_status(tid, "tasked", **{"BAD COL": "x"})


def test_pending_limit():
    today = _today()
    for i in range(5):
        sd.web_target_upsert(f"h{i}.cdep.samsungds.net",
                                source="splunk", day_bucket=today, event_count=i)
    rows = sd.web_targets_pending(day_bucket=today, limit=3)
    assert len(rows) == 3


def test_pending_default_no_day_filter_returns_all_pending():
    sd.web_target_upsert("a.x", source="splunk",
                            day_bucket="2026-05-25", event_count=1)
    sd.web_target_upsert("b.x", source="splunk",
                            day_bucket="2026-05-26", event_count=1)
    rows = sd.web_targets_pending(day_bucket=None)
    assert len(rows) == 2


def test_pending_returns_high_event_count_first():
    """sort -count 처럼 event_count desc."""
    today = _today()
    sd.web_target_upsert("low.x", source="splunk", day_bucket=today, event_count=5)
    sd.web_target_upsert("high.x", source="splunk", day_bucket=today, event_count=11545)
    sd.web_target_upsert("mid.x", source="splunk", day_bucket=today, event_count=200)
    rows = sd.web_targets_pending(day_bucket=today)
    assert [r["domain"] for r in rows] == ["high.x", "mid.x", "low.x"]


# ─── summary ──────────────────────────────────────────────


def test_summary_counts_status_buckets():
    today = _today()
    pen = sd.web_target_upsert("p.x", source="splunk",
                                  day_bucket=today, event_count=1)
    hun = sd.web_target_upsert("h.x", source="splunk",
                                  day_bucket=today, event_count=1)
    skp = sd.web_target_upsert("s.x", source="splunk",
                                  day_bucket=today, event_count=1)
    sd.web_target_set_status(hun, "tasked", finding_count=1)
    sd.web_target_set_status(skp, "skipped")
    s = sd.web_targets_summary(day_bucket=today)
    assert s["pending"] == 1
    assert s["tasked"] == 1
    assert s["skipped"] == 1
    assert s["total"] == 3
