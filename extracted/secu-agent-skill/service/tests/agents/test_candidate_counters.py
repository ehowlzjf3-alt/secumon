"""v3.90 침묵 게이트 lockstep — 도메인 counter 등록/파싱 + 워커 도구면 검증."""
from __future__ import annotations

import json

from secu_agent.agent.candidate_ledger import (
    candidate_ledger_stats,
    has_candidate_counters,
    run_candidate_counters,
)

from service.agents.candidate_counters import ensure_registered


def _run(tool_name: str, payload: dict) -> tuple[int, int, int]:
    ensure_registered()
    md: dict = {}
    run_candidate_counters(tool_name, {}, json.dumps(payload), md)
    return candidate_ledger_stats(md)


def test_ensure_registered_idempotent():
    ensure_registered()
    ensure_registered()  # 재호출 무해
    for tool in (
        "confluence_browser_search", "web_site_sweep", "web_task_scan",
        "smb_fetch_scan", "smb_inspect_pdf",
        "confluence_task_scan", "github_task_scan",
    ):
        assert has_candidate_counters(tool), tool


def test_confluence_browser_search_counts_candidate_pages():
    assert _run("confluence_browser_search", {
        "scanned_pages": 40, "candidate_pages": 22, "candidates": [],
    }) == (22, 0, 0)


def test_web_site_sweep_counts_scan_hit_total():
    assert _run("web_site_sweep", {
        "scan_hit_summary": {"total": 7, "secret": 3, "pii": 4},
    }) == (7, 0, 0)
    assert _run("web_site_sweep", {"scan_hit_summary": {"total": 0}}) == (0, 0, 0)


def test_web_site_sweep_confirmed_content_not_counted():
    # codex 4R #1: semantic_status="confirmed" 는 콘텐츠 형식 확인(정상 HTML 등) —
    # clean 사이트를 over-block 하지 않도록 detector hit 만 센다.
    assert _run("web_site_sweep", {
        "scan_hit_summary": {"total": 0},
        "probes": [{"semantic_status": "confirmed"}],
        "api_samples": [{"semantic_status": "confirmed"}],
    }) == (0, 0, 0)


def test_web_task_scan_counts_raw_findings():
    assert _run("web_task_scan", {"raw_finding_count": 5}) == (5, 0, 0)
    # confirmed 리소스는 콘텐츠 확인이라 세지 않음(over-block 방지).
    assert _run("web_task_scan", {
        "raw_finding_count": 0,
        "resource_summary": {"confirmed": 2, "sensitive_signals": 1},
    }) == (0, 0, 0)


def test_smb_fetch_scan_counts_hits_not_persisted():
    # persisted 는 파일-hit 상태 적재(finding 아님) — accounted 로 세지 않는다.
    assert _run("smb_fetch_scan", {
        "hits_count": 4, "persisted": 4, "hits": [],
    }) == (4, 0, 0)


def test_smb_inspect_pdf_counts_scan_hits_list():
    assert _run("smb_inspect_pdf", {"scan_hits": [{"kind": "rrn"}, {"kind": "pw"}]}) == (2, 0, 0)
    assert _run("smb_inspect_pdf", {"scan_hits": []}) == (0, 0, 0)


def test_task_scan_autopersist_is_gate_neutral():
    # confluence 는 아직 자동적재 — finding = seen 이자 submitted, 게이트 중립.
    assert _run("confluence_task_scan", {"finding_count": 3}) == (3, 3, 0)


def test_github_task_scan_candidates_are_seen_only():
    """github 은 후보만 돌려주고 등록은 에이전트가 한다 → submitted 로 세면 안 된다.

    ⚠️ 이 테스트는 낡은 의미를 고정하고 있었다. `register=False` 전환 뒤에도
    `submitted=finding_count` 를 세는 바람에, 한 건도 등록 안 된 실행이 장부상
    "제출했다" 로 보여 침묵 게이트가 무력화됐다(실측 `seen=2, submitted=2` — 둘 다
    거부된 실행이었다).
    """
    assert _run("github_task_scan", {"finding_count": 2}) == (2, 0, 0)


def test_malformed_result_is_harmless():
    assert _run("web_site_sweep", {}) == (0, 0, 0)
    md: dict = {}
    ensure_registered()
    run_candidate_counters("web_site_sweep", {}, "not-json{{", md)
    assert candidate_ledger_stats(md) == (0, 0, 0)


def test_hunting_worker_toolsets_expose_triage():
    # triage_candidates 미노출이면 게이트가 스스로 꺼진다(코어 안전 기본) —
    # 4개 헌팅 워커 전부 노출 + counter 등록 트리거를 검증한다.
    from service.agents import (
        confluence_task_worker, dev_web_task_agent, github_task_worker, smb_task_agent,
    )

    for classes in (
        confluence_task_worker._tool_classes("keyword_search"),
        confluence_task_worker._tool_classes(None),
        github_task_worker._tool_classes(),
        dev_web_task_agent._tool_classes(),
        smb_task_agent._tool_classes(),
    ):
        names = {c.name for c in classes}
        assert "triage_candidates" in names
    assert has_candidate_counters("confluence_browser_search")
