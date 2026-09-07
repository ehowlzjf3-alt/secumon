from __future__ import annotations

from dataclasses import dataclass

import pytest


@dataclass
class _Space:
    key: str
    name: str
    type: str


class _FakeSplunk:
    def __init__(self, rows):
        self.rows = rows
        self.queries: list[str] = []

    def search(self, spl: str, *, max_results: int):
        self.queries.append(spl)
        return self.rows[:max_results]


class _FailingSplunk:
    def search(self, spl: str, *, max_results: int):
        raise RuntimeError("splunk unavailable")


# ── space 열거는 REST 가 아니라 브라우저다 (2026-08-26) ────────────────────────
#
# 예전 이 테스트는 `agent.cf.list_spaces` 를 patch 했다. 그 경로는 사라졌다 —
# `/rest/api/space` 가 Basic 403 / Bearer 429 라 매 런 error 로 끝났고, space 큐가
# id 1~25 에서 몇 주째 안 늘었다. 지금은 `browser_list_spaces` 를 부른다.
#
# ★ patch 대상을 안 바꾸고 테스트만 지웠다면, upsert 규칙(빈 key 버림·중복 병합)이
#   통째로 무검증이 됐을 것이다. 바꾼 것은 **어디서 세느냐**뿐이라 규칙은 그대로 잰다.

def _patch_browser_spaces(monkeypatch, agent, payload):
    """`browser_list_spaces` 를 대역으로 바꾼다. 호출 인자는 observed 로 돌려준다."""
    import domains.services.confluence.plugin.tools.confluence_browser_spaces as bs

    observed: dict[str, object] = {}

    def fake(*, limit: int):
        observed["limit"] = limit
        return payload

    monkeypatch.setattr(agent, "load_runtime_env", lambda load_plugins=False: None)
    monkeypatch.setattr(bs, "browser_list_spaces", fake)
    return observed


def test_confluence_space_discovery_upserts_spaces_and_records_run(tmp_db, monkeypatch) -> None:
    from domains.services.confluence.application.contracts import (
        COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
    )
    from service import state_domain as sd
    from service.agents import confluence_discovery_agent as agent

    observed = _patch_browser_spaces(monkeypatch, agent, {
        "ok": True,
        "spaces": [
            _Space("OPS", "Operations", "global"),
            _Space("SEC", "Security", "global"),
            _Space("", "empty", "global"),      # 빈 key 는 버린다
        ],
        "source": "/spacedirectory/view.action",
        "detail": "",
    })

    result = agent.run_space_discovery_pass(max_spaces=5, space_type="global")

    assert observed == {"limit": 5}
    assert result["enumerated"] == 3
    assert result["upserted"] == 2
    assert result["new"] == 2
    assert sd.confluence_space_targets_summary()["total"] == 2
    runs = sd.pipeline_runs_recent(COMPONENT_CONFLUENCE_SPACE_DISCOVERY, limit=1)
    assert runs[0]["status"] == "ok"
    assert "upserted=2" in runs[0]["detail"]


def test_space_type_filter_is_dropped_loudly_not_faked(tmp_db, monkeypatch, caplog) -> None:
    """★ 브라우저 경로엔 `space_type` 필터가 **없다**.

    directory 페이지가 global/personal 을 구분해 주지 않는다. 없는 기능을 흉내내면
    호출측은 걸린 줄 알고, 실제로는 personal space 까지 큐에 들어간다.
    무시하되 **말은 한다**.
    """
    import logging

    from service.agents import confluence_discovery_agent as agent

    _patch_browser_spaces(monkeypatch, agent, {
        "ok": True, "spaces": [_Space("OPS", "Operations", "global")],
        "source": "x", "detail": "",
    })
    with caplog.at_level(logging.WARNING):
        agent.run_space_discovery_pass(max_spaces=5, space_type="global")

    # `r.message` 는 포맷 **전** 문자열이다 — 인자를 넣은 최종 문구는 getMessage() 다.
    said = [r.getMessage() for r in caplog.records]
    assert any("space_type" in m for m in said), f"필터를 조용히 버렸다: {said}"
    assert any("지원되지 않는다" in m for m in said), "무시한다는 사실을 안 말했다"


def test_enumeration_failure_is_not_recorded_as_a_clean_zero(tmp_db, monkeypatch) -> None:
    """★ 0건과 실패를 구분한다.

    링크를 하나도 못 찾은 것은 "space 가 없다" 가 아니라 "못 읽었다" 다. 빈 목록을
    성공으로 기록하면 discovery 가 조용히 아무것도 안 하는 상태가 되고, 큐가 안 느는
    것을 아무도 모른다 — 그게 25건에서 멈춘 채 몇 주가 지난 이유다.
    """
    from domains.services.confluence.application.contracts import (
        COMPONENT_CONFLUENCE_SPACE_DISCOVERY,
    )
    from service import state_domain as sd
    from service.agents import confluence_discovery_agent as agent

    _patch_browser_spaces(monkeypatch, agent, {
        "ok": False, "spaces": [], "source": "",
        "detail": "space directory 에서 링크를 하나도 못 찾았다",
    })

    with pytest.raises(RuntimeError):
        agent.run_space_discovery_pass(max_spaces=5)

    runs = sd.pipeline_runs_recent(COMPONENT_CONFLUENCE_SPACE_DISCOVERY, limit=1)
    assert runs[0]["status"] == "error", "실패가 ok 로 기록됐다"
    assert "못 찾았다" in (runs[0]["detail"] or ""), "사유가 안 남았다"


def test_confluence_sso_discovery_filters_to_confluence_targets(tmp_db, monkeypatch) -> None:
    from domains.services.confluence.application.contracts import (
        COMPONENT_CONFLUENCE_SSO_DISCOVERY,
    )
    from service import state_domain as sd
    from service.agents import confluence_discovery_agent as agent

    monkeypatch.setattr(agent, "load_runtime_env", lambda load_plugins=False: None)
    sd.devops_target_upsert(
        "https://github.samsungds.net/org/existing",
        service="github",
        source="proxy",
        day_bucket="2026-06-30",
        access_count=42,
    )
    searcher = _FakeSplunk([
        {"full_url": "https://confluence.samsungds.net/display/OPS/Page", "count": "9"},
        {"full_url": "https://confluence.samsungds.net/display/OPS/Other", "count": 4},
        {"full_url": "https://confluence.samsungds.net/spaces/SEC/pages/123", "count": 3},
        {"full_url": "https://github.samsungds.net/org/repo/blob/main/x.py", "count": 99},
        {"full_url": "https://img.shields.io/badge/x", "count": 1},
    ])

    result = agent.run_sso_discovery_pass(
        day_bucket="2026-06-30",
        max_urls=20,
        searcher=searcher,
    )

    assert result["normalized"] == 2
    assert result["confluence"] == 2
    assert result["github"] == 0
    assert result["new"] == 2
    assert result["total"] == 2
    assert 'URL_Host="confluence.samsungds.net"' in searcher.queries[0]
    assert "github.samsungds.net" not in searcher.queries[0]
    summary = sd.devops_targets_summary(day_bucket="2026-06-30", service="confluence")
    assert summary["total"] == 2
    assert sd.devops_targets_summary(day_bucket="2026-06-30")["total"] == 3
    with sd.connect() as c:
        rows = c.execute(
            "SELECT url, service, access_count FROM devops_target "
            "WHERE service='confluence' ORDER BY url",
        ).fetchall()
    assert [(r["url"], r["service"], r["access_count"]) for r in rows] == [
        ("https://confluence.samsungds.net/display/OPS", "confluence", 13),
        ("https://confluence.samsungds.net/spaces/SEC", "confluence", 3),
    ]
    runs = sd.pipeline_runs_recent(COMPONENT_CONFLUENCE_SSO_DISCOVERY, limit=1)
    assert runs[0]["status"] == "ok"
    assert "normalized=2" in runs[0]["detail"]


def test_confluence_sso_discovery_records_failed_run(tmp_db, monkeypatch) -> None:
    from domains.services.confluence.application.contracts import (
        COMPONENT_CONFLUENCE_SSO_DISCOVERY,
    )
    from service import state_domain as sd
    from service.agents import confluence_discovery_agent as agent

    monkeypatch.setattr(agent, "load_runtime_env", lambda load_plugins=False: None)

    with pytest.raises(RuntimeError):
        agent.run_sso_discovery_pass(
            day_bucket="2026-06-30",
            searcher=_FailingSplunk(),
        )

    runs = sd.pipeline_runs_recent(COMPONENT_CONFLUENCE_SSO_DISCOVERY, limit=1)
    assert runs[0]["status"] == "error"
    assert "splunk unavailable" in runs[0]["detail"]
