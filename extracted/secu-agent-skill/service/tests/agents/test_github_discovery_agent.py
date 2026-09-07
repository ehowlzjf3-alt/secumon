from __future__ import annotations

import pytest


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

# ── 프록시(Splunk) 발견 테스트 2건을 지웠다 (2026-08-27) ──────────────────────
#
# `github_discovery_agent.run_sso_discovery_pass()` 가 삭제됐다. 프록시는 GitHub API 를
# 안 부르므로 visibility 를 알 수 없어, 우리 토큰으로 못 읽는 private repo 가 큐에
# 쌓였다. 실측(같은 큐 안에서 출처별):
#
#     code_search  880건  error+skipped 12%  finding 32
#     proxy        466건  error+skipped 58%  finding 11
#
# 대체는 이미 있었다 — `run_search_discovery_pass()`(전역 /search/code)가 같은 큐를
# 채우고 있었고 이미 다수(65%)였다. 검색 인덱스는 읽을 수 있는 repo 만 돌려준다.
#
# ⚠️ confluence 는 그대로다(`confluence_discovery_agent`) — 위키는 "누가 봤나" 가
#    여전히 유효한 발견 신호다. 그쪽 테스트는 손대지 않았다.

