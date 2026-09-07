"""dev_web discovery runner."""
from __future__ import annotations

import pytest

from domains.dev_web.application.contracts import COMPONENT_DISCOVERY
from domains.dev_web.application.discovery import DevWebDiscoveryConfig
from service import state_domain as sd
from service.agents.dev_web_discovery_agent import run_discovery_pass


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


def test_dev_web_discovery_runner_upserts_targets_and_records_run(tmp_db) -> None:
    searcher = _FakeSplunk([
        {"domain": "dev-one.cdep.samsungds.net", "count": "9"},
        {"domain": "prod.cdep.samsungds.net", "count": "20"},
        {"domain": "https://stage-two.cdep.samsungds.net/path", "count": 7},
    ])
    result = run_discovery_pass(
        config=DevWebDiscoveryConfig(
            siem_filter='domain="cdep.samsungds.net"',
            include_regex=r"(?i)^(dev|stage)-",
            day_bucket="2026-06-16",
            max_domains=10,
        ),
        searcher=searcher,
    )

    assert result["matched"] == 3
    assert result["priority_matched"] == 2
    assert result["new"] == 3
    assert result["pending"] == 3
    assert 'domain="cdep.samsungds.net"' in searcher.queries[0]
    assert "index=hq_escort sourcetype=escort_web_access" in searcher.queries[0]
    pending = sd.dev_web_targets_pending(day_bucket="2026-06-16", limit=10)
    assert [row["domain"] for row in pending] == [
        "dev-one.cdep.samsungds.net",
        "stage-two.cdep.samsungds.net",
        "prod.cdep.samsungds.net",
    ]
    assert pending[0]["priority_score"] > pending[-1]["priority_score"]
    runs = sd.pipeline_runs_recent(COMPONENT_DISCOVERY, limit=1)
    assert runs[0]["status"] == "ok"
    assert "matched=3" in runs[0]["detail"]


def test_dev_web_discovery_default_spl_targets_cdep_access_logs() -> None:
    from domains.dev_web.application.discovery import build_discovery_spl

    spl = build_discovery_spl(DevWebDiscoveryConfig())

    assert "index=hq_escort sourcetype=escort_web_access" in spl
    assert " cdep " in f" {spl} "
    assert "coalesce(domain, URL_Host, host)" in spl
    assert 'where match(domain, "(?i)cdep")' in spl


def test_dev_web_discovery_runner_records_failed_run(tmp_db) -> None:
    with pytest.raises(RuntimeError):
        run_discovery_pass(
            config=DevWebDiscoveryConfig(day_bucket="2026-06-16"),
            searcher=_FailingSplunk(),
        )

    runs = sd.pipeline_runs_recent(COMPONENT_DISCOVERY, limit=1)
    assert runs[0]["status"] == "error"
    assert "splunk unavailable" in runs[0]["detail"]
