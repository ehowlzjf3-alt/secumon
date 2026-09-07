"""F2 goal-scoped finding (#17) — evidence digest 를 goal 수명으로 스코핑.

전역 dedup 모델이라 goal 소유가 없어 last_seen 시간창(since=goal.created_at)으로 근사한다.
무관한 이전 goal 의 finding 이 이 goal 판정에 섞이는 것(F2-B/F2-E 의 전역-digest G1) 해소.
"""
from __future__ import annotations

import pytest

from secu_agent import state
from secu_agent.agent import ralph_controller as rc_mod


def _seed_finding(asset: str) -> float:
    fid, _new = state.finding_upsert(
        task_type="web", asset=asset, asset_kind="url",
        severity="high", summary="test finding",
    )
    rows = [r for r in state.finding_list(limit=50) if r["asset"] == asset]
    assert rows, "삽입 finding 이 조회돼야 함"
    return float(rows[0]["last_seen"])


# ── 단위: finding_list(since=) 시간 필터 ───────────────────────────────────

def test_finding_list_since_filters_by_last_seen(tmp_db):
    _seed_finding("https://a.test/x")
    _seed_finding("https://b.test/y")
    allrows = state.finding_list(limit=50)
    assert len(allrows) == 2
    max_ls = max(r["last_seen"] for r in allrows)
    # since=max_last_seen → 최소 그 finding 포함.
    scoped = state.finding_list(since=max_ls, limit=50)
    assert len(scoped) >= 1
    # since=미래 → 아무것도 안 나옴(전부 그 이전 관측).
    assert state.finding_list(since=max_ls + 10_000, limit=50) == []
    # since=None → 전역(구동작) 2건.
    assert len(state.finding_list(since=None, limit=50)) == 2


# ── 단위: _build_evidence_digest(since=) ───────────────────────────────────

def test_digest_scoped_excludes_pre_goal_findings(tmp_db):
    _seed_finding("https://old.test/a")  # goal 이전 finding
    max_ls = max(r["last_seen"] for r in state.finding_list(limit=50))
    future = max_ls + 10_000
    # since=미래(=이 goal 이후) → 스코프 digest 비어야 함(무관 finding 제외).
    assert rc_mod._build_evidence_digest(since=future) == ""
    # since=None(전역) → 그 finding 포함.
    assert "old.test" in rc_mod._build_evidence_digest(since=None)


def test_digest_passes_since_through(monkeypatch):
    seen = {}

    def fake_list(**kw):
        seen.update(kw)
        return []

    monkeypatch.setattr(rc_mod.state, "finding_list", fake_list)
    rc_mod._build_evidence_digest(since=12345.0)
    assert seen.get("since") == 12345.0


# ── 단위: SA_GOAL_SCOPED_EVIDENCE 토글 ─────────────────────────────────────

def test_scoped_evidence_default_on(monkeypatch):
    monkeypatch.delenv("SA_GOAL_SCOPED_EVIDENCE", raising=False)
    assert rc_mod._goal_scoped_evidence() is True


def test_scoped_evidence_can_disable(monkeypatch):
    for v in ("0", "false", "no", "off"):
        monkeypatch.setenv("SA_GOAL_SCOPED_EVIDENCE", v)
        assert rc_mod._goal_scoped_evidence() is False
