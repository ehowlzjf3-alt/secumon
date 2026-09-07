"""Splunk 경로 선택 + 게이트웨이 응답 해석 회귀 방지.

배경(2026-08-16): 구 MCP 호스트가 통째로 죽었는데 dev_web discovery 는 **5주간
조용히 멈춰 있었다**(마지막 day_bucket 2026-07-10). 원인이 둘이었다.

1. 경로 선택이 두 곳에 흩어져 있었다 — `SplunkSearchClient.search` 와
   `enrich_owners` 가 각자 분기해서, 한쪽을 고쳐도 다른 쪽은 죽은 채였다.
   → `splunk_owner.search()` 단일 진입점으로 모으고 그것을 여기서 고정한다.
2. 실패가 조용했다. 게이트웨이는 `{"ran": false}` 로 **조회 실패**를 알리는데
   이걸 빈 rows 로 내리면 discovery 가 "대상 0건"으로 정상 종료해 큐가 비어버린다.
   → `SplunkQueryFailed` 예외로 승격하고 그것을 여기서 고정한다.

대부분은 monkeypatch 로 가로채 네트워크를 안 탄다. 다만 **맨 아래 라이브 스모크 2건은
실제 게이트웨이를 호출한다**(사용자 허용 2026-08-16). monkeypatch 만으로는 게이트웨이가
또 옮겨가도 전부 통과해버리기 때문이다 — 그게 이번에 5주를 잃은 실패 양상이다.
라이브 2건은 읽기 전용 SPL 조회이고, 게이트웨이 미설정이면 skip 한다.
"""
from __future__ import annotations

import json

import pytest

from service.collector import splunk_owner as so


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in (
        "MCP_SPLUNK_GATEWAY_URL", "MCP_SPLUNK_GATEWAY_SERVER", "MCP_SPLUNK_GATEWAY_KEY",
        "MCP_SPLUNK_GATEWAY_CA", "MCP_SPLUNK_GATEWAY_OWNER_BASE",
        "MCP_SPLUNK_URL", "SPLUNK_REST_URL", "LITELLM_API_KEY",
    ):
        monkeypatch.delenv(k, raising=False)


# ── 응답 해석 ──────────────────────────────────────────────────────────────
def test_run_payload_returns_rows():
    body = json.dumps({"ran": True, "count": 2, "rows": [{"domain": "a"}, {"domain": "b"}]})
    assert so._rows_from_run_payload(body) == [{"domain": "a"}, {"domain": "b"}]


def test_run_payload_zero_rows_is_success_not_failure():
    """★ ran=true·count=0 은 '조회는 됐고 데이터가 없다' — 실패가 아니다."""
    body = json.dumps({"ran": True, "count": 0, "rows": []})
    assert so._rows_from_run_payload(body) == []


def test_run_payload_ran_false_raises():
    """★ ran=false 는 조회 실패다. 빈 리스트로 내리면 '대상 0건'으로 조용히 성공한다."""
    body = json.dumps({"ran": False, "error": "index not found", "rows": []})
    with pytest.raises(so.SplunkQueryFailed):
        so._rows_from_run_payload(body)


def test_run_payload_unwraps_mcp_text_blocks():
    blocks = [{"type": "text", "text": json.dumps({"ran": True, "rows": [{"IP": "1.2.3.4"}]})}]
    assert so._rows_from_run_payload(blocks) == [{"IP": "1.2.3.4"}]


# ── 경로 선택 ──────────────────────────────────────────────────────────────
def test_gateway_wins_over_legacy_paths(monkeypatch):
    monkeypatch.setenv("MCP_SPLUNK_GATEWAY_URL", "https://gw/mcp/")
    monkeypatch.setenv("MCP_SPLUNK_URL", "http://dead-host:8002/sse")
    monkeypatch.setenv("LITELLM_API_KEY", "k")
    seen: dict = {}

    async def fake(spl, *, max_results, earliest, latest, base=None):
        seen.update(spl=spl, earliest=earliest, latest=latest, base=base)
        return [{"domain": "x"}]

    monkeypatch.setattr(so, "_search_via_gateway", fake)
    monkeypatch.setattr(so, "_search_via_mcp", _must_not_run)
    monkeypatch.setattr(so, "_search_via_rest", _must_not_run)

    assert so.search("index=a", max_results=10) == [{"domain": "x"}]
    assert seen["spl"] == "index=a"


def test_legacy_mcp_used_when_gateway_absent(monkeypatch):
    monkeypatch.setenv("MCP_SPLUNK_URL", "http://host:8002/sse")
    called: list = []

    async def fake(spl, *, max_results):
        called.append(spl)
        return [{"IP": "1"}]

    monkeypatch.setattr(so, "_search_via_gateway", _must_not_run)
    monkeypatch.setattr(so, "_search_via_mcp", fake)
    assert so.search("index=a", max_results=5) == [{"IP": "1"}]
    assert called == ["index=a"]


def _must_not_run(*a, **k):  # noqa: ANN002, ANN003
    raise AssertionError("이 경로가 선택되면 안 된다")


def test_splunk_enabled_counts_the_gateway(monkeypatch):
    assert so.splunk_enabled() is False
    monkeypatch.setenv("MCP_SPLUNK_GATEWAY_URL", "https://gw/mcp/")
    assert so.splunk_enabled() is True
    assert so.gateway_enabled() is True


def test_gateway_requires_a_key(monkeypatch):
    """키가 없으면 조용히 빈 결과가 아니라 즉시 에러여야 한다."""
    import asyncio

    monkeypatch.setenv("MCP_SPLUNK_GATEWAY_URL", "https://gw/mcp/")
    with pytest.raises(RuntimeError, match="LITELLM_API_KEY"):
        asyncio.run(so._search_via_gateway("index=a", max_results=1))


# ── owner 조회 꼬리 SPL ────────────────────────────────────────────────────
def test_owner_tail_spl_is_a_tail_not_a_generating_command():
    """게이트웨이는 base 없는 `| inputlookup` 을 거부한다 — 꼬리는 where 로 시작한다."""
    tail = so.build_owner_tail_spl({"10.0.0.1", "10.0.0.2"})
    assert tail.lstrip().startswith("| where")
    assert "inputlookup" not in tail
    assert '"10.0.0.1"' in tail and '"10.0.0.2"' in tail
    assert "USER_DEPT" in tail


def test_owner_enrich_uses_the_lookup_on_the_gateway_too(monkeypatch):
    """★ 2026-08-22: 게이트웨이 전용 base+tail 분기를 없앴다.

    그 우회는 구 도구(`lens_splunk_mcp-splunk_run`)가 `|` 로 시작하는 꼬리 SPL 을
    거부해서 필요했던 것이다. 신 도구(`splunk-splunk_search`)는 생 SPL 을 그대로 받고,
    구 베이스 이름(`endpoint_context_base`)은 게이트웨이에 **매크로로도 savedsearch
    로도 없다** — 서버가 풀어 주던 이름이라 클라이언트가 붙이면 그냥 검색어가 된다
    (실측: base 단독은 timeout, base+tail 은 0건).
    """
    monkeypatch.setenv("MCP_SPLUNK_GATEWAY_URL", "https://gw/mcp/")
    monkeypatch.setenv("LITELLM_API_KEY", "k")
    seen: dict = {}

    def fake_search(spl, *, max_results, earliest="-24h", latest="now", base=None):
        seen.update(spl=spl, earliest=earliest, base=base)
        return []

    monkeypatch.setattr(so, "search", fake_search)
    monkeypatch.setattr(so.state, "asset_owner_upsert", lambda *a, **k: None)
    so.enrich_owners({"10.0.0.9"})

    assert seen["base"] is None, "base 우회는 은퇴했다"
    assert "inputlookup" in seen["spl"]
    assert "10.0.0.9" in seen["spl"]


def test_legacy_owner_path_still_uses_inputlookup(monkeypatch):
    """게이트웨이가 꺼지면 구 lookup 으로 돌아가야 한다(되돌릴 수 있어야 한다)."""
    monkeypatch.setenv("MCP_SPLUNK_URL", "http://host:8002/sse")
    seen: dict = {}

    def fake_search(spl, *, max_results, earliest="-24h", latest="now", base=None):
        seen.update(spl=spl, base=base)
        return []

    monkeypatch.setattr(so, "search", fake_search)
    monkeypatch.setattr(so.state, "asset_owner_upsert", lambda *a, **k: None)
    so.enrich_owners({"10.0.0.9"})

    assert seen["base"] is None
    assert "inputlookup" in seen["spl"]


# ── dev_web 배선 ──────────────────────────────────────────────────────────
def test_dev_web_client_delegates_to_the_single_entrypoint(monkeypatch):
    """dev_web 이 자체 분기를 다시 갖지 않는지 — 그게 5주 정지의 원인이었다."""
    from domains.dev_web.infrastructure import runtime as rt

    monkeypatch.setenv("MCP_SPLUNK_GATEWAY_URL", "https://gw/mcp/")
    monkeypatch.setenv("LITELLM_API_KEY", "k")
    seen: dict = {}

    def fake_search(spl, *, max_results, earliest="-24h", latest="now", base=None):
        seen.update(spl=spl, max_results=max_results)
        return [{"domain": "d"}]

    monkeypatch.setattr(so, "search", fake_search)
    client = rt.SplunkSearchClient()
    assert client.enabled() is True
    assert client.search("index=hq_escort", max_results=7) == [{"domain": "d"}]
    assert seen == {"spl": "index=hq_escort", "max_results": 7}


def test_dev_web_client_errors_when_no_splunk_configured():
    from domains.dev_web.infrastructure import runtime as rt

    with pytest.raises(RuntimeError, match="MCP_SPLUNK_GATEWAY_URL"):
        rt.SplunkSearchClient().search("index=a", max_results=1)


# ── 라이브 스모크 (사용자 허용: 2026-08-16 "호출해도 돼") ─────────────────────
# 위 테스트들은 전부 monkeypatch 라 **게이트웨이가 또 옮겨가도 통과한다**.
# 그게 정확히 이번에 5주를 잃은 실패 양상이라(구 호스트가 죽었는데 아무도 몰랐다),
# 실제로 한 번 찔러보는 테스트를 따로 둔다.
#
# ⚠️ 읽기 전용 SPL 조회다. 메일/쓰기 경로와 무관하다.
# ⚠️ 게이트웨이 미설정(.env 없는 CI)이면 skip — 실패로 만들지 않는다.
def test_live_gateway_answers_a_read_only_query():
    """게이트웨이가 실제로 응답하는지 — 조회 성공/실패만 본다(행 수는 안 본다)."""
    import os

    from service.runtime_env import load_runtime_env

    load_runtime_env(load_plugins=False)
    if not os.environ.get("MCP_SPLUNK_GATEWAY_URL"):
        pytest.skip("MCP_SPLUNK_GATEWAY_URL 미설정 — 라이브 스모크 대상 아님")

    rows = so.search(
        'index=hq_escort sourcetype=escort_web_access | head 1 | fields index',
        max_results=1, earliest="-24h", latest="now",
    )
    # ran=false 면 위 호출이 SplunkQueryFailed 로 터진다. 여기 왔으면 조회는 성공한 것.
    assert isinstance(rows, list)


def test_live_gateway_rejects_a_tail_spl_without_base():
    """`ran=false` 가 예외로 올라오는지 — 실제 게이트웨이 응답으로 확인한다.

    이 계약이 깨지면 Splunk 가 죽은 날 discovery 가 '대상 0건'으로 조용히 성공한다.
    """
    import os

    from service.runtime_env import load_runtime_env

    load_runtime_env(load_plugins=False)
    if not os.environ.get("MCP_SPLUNK_GATEWAY_URL"):
        pytest.skip("MCP_SPLUNK_GATEWAY_URL 미설정 — 라이브 스모크 대상 아님")

    with pytest.raises(so.SplunkQueryFailed):
        so.search("| inputlookup NOPE_THIS_DOES_NOT_EXIST", max_results=1)


# ── 조용한 0건 금지 (2026-08-22 사고) ────────────────────────────────────
#
# 게이트웨이가 `lens_splunk_mcp` 를 없애면서 `"Error: User not allowed to call this
# tool."` 이라는 **평문**을 돌려줬다. JSON 파싱에 실패해 조용히 `[]` 가 됐고, dev_web
# discovery 가 5일간 "0건 성공" 했다(마지막 타깃 생성 2026-08-17).

def test_plaintext_error_body_is_not_no_data():
    """★ 파싱 실패 = 데이터 없음이 **아니다**. 이 한 줄이 5일을 잡아먹었다."""
    with pytest.raises(so.SplunkQueryFailed) as e:
        so._rows_from_run_payload("Error: User not allowed to call this tool.")
    assert "not allowed" in str(e.value)


def test_empty_body_is_still_no_data():
    """과잉 반응도 곤란하다 — 빈 응답은 예외가 아니다."""
    assert so._rows_from_run_payload("") == []
    assert so._rows_from_run_payload("   ") == []


def test_success_false_raises_like_ran_false():
    """신 도구는 `success`, 구 도구는 `ran` — 둘 다 실패 신호다."""
    with pytest.raises(so.SplunkQueryFailed):
        so._rows_from_run_payload('{"success": false, "error": "bad SPL"}')
    with pytest.raises(so.SplunkQueryFailed):
        so._rows_from_run_payload('{"ran": false, "error": "bad SPL"}')


def test_new_shape_results_are_read():
    got = so._rows_from_run_payload('{"success": true, "count": 1, "results": [{"IP": "1.2.3.4"}]}')
    assert got == [{"IP": "1.2.3.4"}]


def test_gateway_tool_name_is_configurable(monkeypatch):
    """서버가 또 옮겨갈 수 있다 — env 로 되찾을 수 있어야 한다."""
    assert so._gateway_tool() == "splunk_search"
    assert so._gateway_server() == "splunk"
    monkeypatch.setenv("MCP_SPLUNK_GATEWAY_TOOL", "splunk_run")
    monkeypatch.setenv("MCP_SPLUNK_GATEWAY_SERVER", "lens_splunk_mcp")
    assert so._gateway_tool() == "splunk_run"
    assert so._gateway_server() == "lens_splunk_mcp"
