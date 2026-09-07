from __future__ import annotations


def test_splunk_owner_timeout_marks_requested_ips_failed(tmp_db, monkeypatch) -> None:
    from service import state_domain as state
    from service.collector import splunk_owner

    monkeypatch.setenv("MCP_SPLUNK_URL", "http://splunk.example/sse")
    monkeypatch.delenv("SPLUNK_REST_URL", raising=False)
    # ⚠️ 이 테스트는 **구 MCP(SSE) 경로**를 검증한다. 게이트웨이 env 가 살아 있으면
    #    enrich_owners 가 그쪽으로 가버려 아래 monkeypatch 가 무력화되고, 심지어 실제
    #    사내 게이트웨이로 나간다(2026-08-16 전체 스위트에서 실측 — 단독 실행만 통과했다).
    monkeypatch.delenv("MCP_SPLUNK_GATEWAY_URL", raising=False)

    async def fail_search(*args, **kwargs):  # noqa: ANN002, ANN003
        raise TimeoutError("connect timeout")

    monkeypatch.setattr(splunk_owner, "_search_via_mcp", fail_search)

    res = splunk_owner.enrich_owners({"10.0.0.30"}, max_results=1)

    owner = state.asset_owner_get("10.0.0.30")
    assert res == {"queried": 0, "persisted": 0, "missing": 1, "error": 1}
    assert owner is not None
    assert owner["source"] == "splunk:LOOKUP_CONTEXT_ASSET_LIST_V2:error"
