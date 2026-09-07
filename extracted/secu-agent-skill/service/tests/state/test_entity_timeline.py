"""v3.63 H4: entity_timeline — 엔티티(host/domain/url) 단위 cross-table 타임라인.

부서별 테이블(smb_share/web_target_domain/devops_target/finding)을 엔티티 축으로
가로질러 시간순 사건을 묶는다. "host X 의 모든 활동" 한 방 조회.
"""
from __future__ import annotations

import service.state_domain as sd

import time

from secu_agent import state


def test_entity_timeline_empty(tmp_db):
    assert sd.domain_entity_timeline("host", "10.0.0.99") == []


def test_entity_timeline_host_basic(seed):
    sid = seed.share(host="192.0.2.10", share="data", status="walked", file_total=3)
    fid = seed.file(sid, path="conf/app.env", hits=1)
    seed.hit(fid, category="secret", kind="aws_access_key_id", verdict="confirmed")

    tl = sd.domain_entity_timeline("host", "192.0.2.10")
    actions = [e["action"] for e in tl]
    assert "share_discovered" in actions     # first_seen
    assert "share_walked" in actions          # walk_done_at
    assert any(a.startswith("hit_") for a in actions)   # confirmed hit
    # 시간 오름차순 정렬
    ts = [e["ts"] for e in tl]
    assert ts == sorted(ts)
    # 각 이벤트 shape
    for e in tl:
        assert {"ts", "source", "action", "detail"} <= set(e.keys())


def test_entity_timeline_includes_finding(seed):
    seed.share(host="192.0.2.20", share="share1", status="walked")
    fp = state.finding_fingerprint(
        task_type="smb", asset="192.0.2.20/share1/secret.env",
        asset_kind="file", discriminator="secret",
    )
    state.finding_upsert(
        task_type="smb", asset="192.0.2.20/share1/secret.env",
        asset_kind="file", severity="high", summary="AWS key 노출",
        fingerprint=fp, evidence_ref="/tmp/x.json",
    )
    tl = sd.domain_entity_timeline("host", "192.0.2.20")
    findings = [e for e in tl if e["action"].startswith("finding")]
    assert len(findings) == 1
    assert findings[0]["severity"] == "high"
    assert "AWS key" in findings[0]["detail"]


def test_entity_timeline_host_isolation(seed):
    a = seed.share(host="192.0.2.30", share="s", status="walked")
    seed.share(host="192.0.2.31", share="s", status="walked")
    fid = seed.file(a, path="x.env", hits=1)
    seed.hit(fid, verdict="confirmed")
    # host .31 타임라인엔 .30 의 hit 이 없어야
    tl31 = sd.domain_entity_timeline("host", "192.0.2.31")
    assert all("hit" not in e["action"] for e in tl31)
    # .31 은 discovered + walked 만 (hit/finding 없음)
    assert [e["action"] for e in tl31] == ["share_discovered", "share_walked"]


def test_entity_timeline_domain(tmp_db):
    today = time.strftime("%Y-%m-%d")
    sd.web_target_upsert(
        domain="admin.samsungds.net", source="splunk",
        day_bucket=today, event_count=42,
    )
    fp = state.finding_fingerprint(
        task_type="web", asset="https://admin.samsungds.net/.git/config",
        asset_kind="url", discriminator="exposure",
    )
    state.finding_upsert(
        task_type="web", asset="https://admin.samsungds.net/.git/config",
        asset_kind="url", severity="critical", summary=".git 노출",
        fingerprint=fp, evidence_ref="/tmp/y.json",
    )
    tl = sd.domain_entity_timeline("domain", "admin.samsungds.net")
    actions = [e["action"] for e in tl]
    assert any("discovered" in a for a in actions)
    assert any(a.startswith("finding") for a in actions)
