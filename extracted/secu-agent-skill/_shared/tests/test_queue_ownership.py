"""큐 소유권 분담 — 위임된 검토원은 닫지 않는다 (Phase 2, 4도메인 동일).

★ 이 규칙이 틀리면 **에러가 안 난다.** 둘 다 닫으면 경합(리드 판단 전에 큐가 terminal),
둘 다 안 닫으면 큐가 walked 인 채로 영영 남는다. 그래서 테스트로 못 박는다.

    SA_AGENT_DEPTH >= 1  → 닫지 않는다. `recommended_status.json` 만 남긴다.
    SA_AGENT_DEPTH == 0  → 닫는다 (Phase 1 동작 보존).
"""
from __future__ import annotations

import asyncio
import json

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolSuccess

from _shared.queue_ownership import (
    RECOMMENDATION_FILENAME, agent_depth, is_delegated_inspector,
    read_recommendation, write_recommendation,
)


@pytest.fixture()
def delegated(monkeypatch):
    monkeypatch.setenv("SA_AGENT_DEPTH", "1")
    yield


@pytest.fixture()
def standalone(monkeypatch):
    monkeypatch.delenv("SA_AGENT_DEPTH", raising=False)
    yield


def test_depth_signal(monkeypatch):
    monkeypatch.delenv("SA_AGENT_DEPTH", raising=False)
    assert agent_depth() == 0 and not is_delegated_inspector()
    monkeypatch.setenv("SA_AGENT_DEPTH", "1")
    assert agent_depth() == 1 and is_delegated_inspector()
    monkeypatch.setenv("SA_AGENT_DEPTH", "2")
    assert is_delegated_inspector()
    monkeypatch.setenv("SA_AGENT_DEPTH", "쓰레기")
    assert agent_depth() == 0, "파싱 실패는 0(단독)으로 — 알 수 없으면 오늘 동작을 지킨다"


def test_recommendation_roundtrip(tmp_path):
    write_recommendation(tmp_path, target_ids=[7], status="skipped",
                         finding_count=0, reason="403")
    got = read_recommendation(tmp_path)
    assert got["recommended_status"] == "skipped"
    assert got["target_ids"] == [7]
    assert (tmp_path / RECOMMENDATION_FILENAME).exists()


def test_recommendation_write_failure_does_not_raise(tmp_path):
    """권고 기록 실패가 검토원 종료를 막으면, 부모는 결과 누락(crash 단정)만 본다."""
    bad = tmp_path / "없는디렉터리" / "더깊이"
    payload = write_recommendation(bad, target_ids=[1], status="tasked")
    assert payload["recommended_status"] == "tasked"   # 예외 없이 payload 는 돌려준다


# ── 도메인 상태 도구 4종 ────────────────────────────────────────────────

def _ctx(tmp_path) -> ToolContext:
    return ToolContext(evidence_dir=tmp_path, metadata={})


def test_dev_web_setter_defers_when_delegated(tmp_path, delegated, monkeypatch):
    from domains.dev_web.plugin.tools import dev_web_discovery_tool as m

    wrote: list = []
    monkeypatch.setattr(m.state, "dev_web_target_get", lambda tid: {"id": tid})
    monkeypatch.setattr(m.state, "dev_web_target_set_status",
                        lambda *a, **k: wrote.append((a, k)))
    res = asyncio.run(m.DevWebTargetSetStatusTool().execute(
        m.DevWebTargetSetStatusInput(target_id=1, status="tasked", finding_count=0),
        _ctx(tmp_path)))
    assert isinstance(res, ToolSuccess), "종료 도구는 성공을 반환해야 워커가 끝난다"
    assert not wrote, "위임된 검토원이 큐를 닫았다"
    assert read_recommendation(tmp_path)["recommended_status"] == "tasked"


def test_dev_web_setter_closes_when_standalone(tmp_path, standalone, monkeypatch):
    from domains.dev_web.plugin.tools import dev_web_discovery_tool as m

    wrote: list = []
    monkeypatch.setattr(m.state, "dev_web_target_get", lambda tid: {"id": tid})
    monkeypatch.setattr(m.state, "dev_web_target_set_status",
                        lambda *a, **k: wrote.append((a, k)))
    res = asyncio.run(m.DevWebTargetSetStatusTool().execute(
        m.DevWebTargetSetStatusInput(target_id=1, status="tasked"), _ctx(tmp_path)))
    assert isinstance(res, ToolSuccess)
    assert wrote, "단독 검토원이 큐를 안 닫았다 — Phase 1 동작 회귀"


def test_devops_setter_defers_when_delegated(tmp_path, delegated, monkeypatch):
    from domains.services.plugin.tools import devops_discovery_tool as m

    wrote: list = []
    monkeypatch.setattr(m.state, "devops_target_get",
                        lambda tid: {"id": tid, "service": "github"})
    monkeypatch.setattr(m.state, "devops_target_set_status",
                        lambda *a, **k: wrote.append((a, k)))
    res = asyncio.run(m.DevopsTargetSetStatusTool().execute(
        m.DevopsTargetSetStatusInput(target_id=13, status="tasked", finding_count=0),
        _ctx(tmp_path)))
    assert isinstance(res, ToolSuccess)
    assert not wrote
    assert read_recommendation(tmp_path)["recommended_status"] == "tasked"


def test_devops_setter_closes_when_standalone(tmp_path, standalone, monkeypatch):
    from domains.services.plugin.tools import devops_discovery_tool as m

    wrote: list = []
    monkeypatch.setattr(m.state, "devops_target_get",
                        lambda tid: {"id": tid, "service": "github"})
    monkeypatch.setattr(m.state, "devops_target_set_status",
                        lambda *a, **k: wrote.append((a, k)))
    asyncio.run(m.DevopsTargetSetStatusTool().execute(
        m.DevopsTargetSetStatusInput(target_id=13, status="tasked"), _ctx(tmp_path)))
    assert wrote


def test_confluence_space_setter_defers_when_delegated(tmp_path, delegated, monkeypatch):
    from domains.services.confluence.plugin.tools import (
        confluence_space_discovery_tool as m,
    )

    wrote: list = []
    monkeypatch.setattr(m.state, "confluence_space_target_get",
                        lambda tid: {"id": tid, "space_key": "DOC"})
    monkeypatch.setattr(m.state, "confluence_space_target_set_status",
                        lambda *a, **k: wrote.append((a, k)))
    res = asyncio.run(m.ConfluenceSpaceSetStatusTool().execute(
        m.ConfluenceSpaceSetStatusInput(target_ids=[1], status="skipped"),
        _ctx(tmp_path)))
    assert isinstance(res, ToolSuccess)
    assert not wrote
    assert read_recommendation(tmp_path)["recommended_status"] == "skipped"


def test_confluence_space_setter_closes_when_standalone(tmp_path, standalone, monkeypatch):
    from domains.services.confluence.plugin.tools import (
        confluence_space_discovery_tool as m,
    )

    wrote: list = []
    monkeypatch.setattr(m.state, "confluence_space_target_get",
                        lambda tid: {"id": tid, "space_key": "DOC"})
    monkeypatch.setattr(m.state, "confluence_space_target_set_status",
                        lambda *a, **k: wrote.append((a, k)))
    asyncio.run(m.ConfluenceSpaceSetStatusTool().execute(
        m.ConfluenceSpaceSetStatusInput(target_ids=[1], status="skipped"),
        _ctx(tmp_path)))
    assert wrote


def test_confluence_search_setter_defers_when_delegated(tmp_path, delegated, monkeypatch):
    from domains.services.confluence.plugin.tools import (
        confluence_browser_search_tool as m,
    )

    wrote: list = []
    monkeypatch.setattr(m.state, "confluence_search_target_get", lambda tid: {"id": tid})
    monkeypatch.setattr(m.state, "confluence_search_target_set_status",
                        lambda *a, **k: wrote.append((a, k)))
    res = asyncio.run(m.ConfluenceSearchSetStatusTool().execute(
        m.ConfluenceSearchSetStatusInput(target_ids=[5], status="tasked"),
        _ctx(tmp_path)))
    assert isinstance(res, ToolSuccess)
    assert not wrote
    assert read_recommendation(tmp_path)["recommended_status"] == "tasked"


def test_confluence_search_setter_closes_when_standalone(tmp_path, standalone, monkeypatch):
    from domains.services.confluence.plugin.tools import (
        confluence_browser_search_tool as m,
    )

    wrote: list = []
    monkeypatch.setattr(m.state, "confluence_search_target_get", lambda tid: {"id": tid})
    monkeypatch.setattr(m.state, "confluence_search_target_set_status",
                        lambda *a, **k: wrote.append((a, k)))
    asyncio.run(m.ConfluenceSearchSetStatusTool().execute(
        m.ConfluenceSearchSetStatusInput(target_ids=[5], status="tasked"),
        _ctx(tmp_path)))
    assert wrote


# ── smb: 종료 도구가 아니라 계약 후처리에서 닫는다 ─────────────────────

def test_smb_contract_defers_when_delegated(tmp_path, delegated, monkeypatch):
    from domains.smb.plugin import inspect_contract as m

    closed: list = []
    import service.state_domain as sd
    monkeypatch.setattr(sd, "share_set_status", lambda *a, **k: closed.append((a, k)))
    monkeypatch.setattr(sd, "smb_share_ensure_open_exposure_finding",
                        lambda *a, **k: closed.append(("exposure", a)))
    rc = m._on_no_submit(tmp_path, {"target": {"host": "10.0.0.1", "share_ids": [3]}},
                         "end_turn")
    assert rc == 0
    assert not closed, "위임된 smb 검토원이 공유를 닫았다"   # ← 이 테스트의 본론
    rec = read_recommendation(tmp_path)
    assert rec["target_ids"] == [3]
    # ★ 계약이 바뀌었다 (2026-08-28). 예전엔 여기서 무조건 `triaged_completed` 를
    #   권고했다 — 검토원이 아무것도 못 봤어도. 리드의 `set_target_status` 는 권고와
    #   다르게 닫으려면 근거를 요구하므로, 그 무조건 권고는 리드가 "완료" 를 따르도록
    #   압박했다. 실측: `clean` 판정 131건 중 56건(43%)이 파일을 한 번도 안 연 세션.
    #   이 케이스는 inspector_report 가 없다 = 연 파일 0 → 큐로 되돌린다.
    assert rec["recommended_status"] == "walked"
    assert rec["looked_at_files"] == 0


def test_smb_contract_recommends_completed_when_the_inspector_actually_read(
    tmp_path, delegated, monkeypatch,
):
    """읽었으면 예전 그대로 `triaged_completed` — 제출이 없어도 판정은 판정이다."""
    import json

    from _shared.inspector_report import REPORT_FILENAME
    from domains.smb.plugin import inspect_contract as m

    (tmp_path / REPORT_FILENAME).write_text(
        json.dumps({"verdict": "clean",
                    "looked_at": {"files": 12, "bytes": 3400, "source": "code"}}),
        encoding="utf-8")
    import service.state_domain as sd
    monkeypatch.setattr(sd, "share_set_status", lambda *a, **k: None)
    monkeypatch.setattr(sd, "smb_share_ensure_open_exposure_finding", lambda *a, **k: None)
    m._on_no_submit(tmp_path, {"target": {"host": "10.0.0.1", "share_ids": [3]}}, "end_turn")
    rec = read_recommendation(tmp_path)
    assert rec["recommended_status"] == "triaged_completed"
    assert rec["looked_at_files"] == 12


def test_smb_contract_closes_when_standalone(tmp_path, standalone, monkeypatch):
    from domains.smb.plugin import inspect_contract as m

    closed: list = []
    import service.state_domain as sd
    monkeypatch.setattr(sd, "share_set_status", lambda *a, **k: closed.append((a, k)))
    monkeypatch.setattr(sd, "smb_share_ensure_open_exposure_finding", lambda *a, **k: None)
    monkeypatch.setattr(sd, "smb_task_host_open_count", lambda *a, **k: 1)
    rc = m._on_no_submit(tmp_path, {"target": {"host": "10.0.0.1", "share_ids": [3]}},
                         "end_turn")
    assert rc == 0
    assert closed, "단독 smb 검토원이 공유를 안 닫았다 — Phase 1 실기동 회귀"
    assert not (tmp_path / RECOMMENDATION_FILENAME).exists()


def test_all_four_domains_follow_the_same_rule():
    """★ 규칙이 도메인마다 갈리면 '누가 닫았는가' 가 조용히 달라진다."""
    import inspect

    from domains.dev_web.plugin.tools import dev_web_discovery_tool as a
    from domains.services.confluence.plugin.tools import (
        confluence_browser_search_tool as b, confluence_space_discovery_tool as c,
    )
    from domains.services.plugin.tools import devops_discovery_tool as d
    from domains.smb.plugin import inspect_contract as e

    for mod in (a, b, c, d, e):
        src = inspect.getsource(mod)
        assert "is_delegated_inspector()" in src, (
            f"{mod.__name__} 에 큐 소유권 가드가 없다 — 이 도메인만 다르게 닫는다")
