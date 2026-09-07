"""v3.79 ②: WS projection 강화 — 토큰미터/current-target/결과 truncation.

SYNTHESIS ②: "데이터는 이미 emit 되는데 브라우저로 projection 이 안 됨".
- U1 TokenMeter: token_usage(Slice2) 누적을 TurnStarted 마다 브라우저로 push.
- U2 current-target: ToolCallStarted.input(untyped dict)에서 대상(host/url/repo...)
  을 정규화해 payload.target 으로 — UI 가 "지금 뭘 점검 중인지" 표시.
- U4 truncation: ToolCallCompleted 전문 broadcast 가 WS 를 범람시킴 — 상한.
"""
from __future__ import annotations

from secu_agent import state
from secu_agent.agent.events import ToolCallCompleted, ToolCallStarted
from secu_agent.agent.tools.base import ToolSuccess


# ---- U2: current-target 정규화 ----

def test_extract_target_smb_host():
    from secu_agent.web.routes.chat import _extract_target
    assert _extract_target("smb_python", {"host": "12.34.56.78", "code": "x"}) == "12.34.56.78"


def test_extract_target_web_url():
    from secu_agent.web.routes.chat import _extract_target
    assert _extract_target(
        "web_task_scan", {"seed": "https://wiki.example.internal/page"},
    ) == "https://wiki.example.internal/page"


def test_extract_target_repo_list_first_plus_count():
    from secu_agent.web.routes.chat import _extract_target
    t = _extract_target("github_task_scan", {"repo_names": ["org/a", "org/b", "org/c"]})
    assert t is not None and "org/a" in t and "2" in t


def test_extract_target_none_when_no_match():
    from secu_agent.web.routes.chat import _extract_target
    assert _extract_target("memory", {"action": "recall"}) is None


def test_extract_target_long_value_truncated():
    from secu_agent.web.routes.chat import _extract_target
    t = _extract_target("web_fetch", {"url": "https://x.internal/" + "a" * 300})
    assert t is not None and len(t) <= 80


def test_tool_call_started_payload_includes_target():
    from secu_agent.web.routes.chat import _event_to_payload
    ev = ToolCallStarted(tool_use_id="t1", name="smb_python",
                         input={"host": "10.1.2.3", "code": "ls"})
    p = _event_to_payload(ev)
    assert p["target"] == "10.1.2.3"


# ---- U4: ToolCallCompleted 결과 truncation ----

def test_tool_result_broadcast_truncated():
    from secu_agent.web.routes.chat import _event_to_payload
    big = "x" * 50_000
    ev = ToolCallCompleted(
        tool_use_id="t1", name="web_fetch",
        result=ToolSuccess(content=big),
    )
    p = _event_to_payload(ev)
    assert len(p["result"]) < 10_000
    assert "생략" in p["result"]


def test_tool_result_broadcast_small_unchanged():
    from secu_agent.web.routes.chat import _event_to_payload
    ev = ToolCallCompleted(
        tool_use_id="t1", name="memory",
        result=ToolSuccess(content="짧은 결과"),
    )
    p = _event_to_payload(ev)
    assert p["result"] == "짧은 결과"


# ---- U1: TokenMeter payload ----

def test_token_meter_payload_from_usage(tmp_db):
    from secu_agent.web.routes.chat import _token_meter_payload
    sid = state.chat_session_get_or_create()
    state.token_usage_record(
        session_id=sid, turn_seq=1, system_chars=10, tools_chars=20,
        history_chars=30, input_tokens=10_000, output_tokens=200,
        cache_read_input_tokens=4_000, cache_creation_input_tokens=6_000,
    )
    state.token_usage_record(
        session_id=sid, turn_seq=2, system_chars=10, tools_chars=20,
        history_chars=30, input_tokens=20_000, output_tokens=300,
        cache_read_input_tokens=0, cache_creation_input_tokens=20_000,
    )
    p = _token_meter_payload(sid)
    assert p is not None
    assert p["event"] == "TokenMeter"
    assert p["calls"] == 2
    assert p["input_tokens"] == 30_000
    assert p["output_tokens"] == 500
    assert p["cache_read_input_tokens"] == 4_000
    assert abs(p["cache_hit_pct"] - 13.33) < 0.1


def test_token_meter_payload_none_when_empty(tmp_db):
    from secu_agent.web.routes.chat import _token_meter_payload
    sid = state.chat_session_get_or_create()
    assert _token_meter_payload(sid) is None


# ---- v3.79 ② 보안: WS 토큰 URL query → Sec-WebSocket-Protocol ----

class _FakeWSReq:
    def __init__(self, headers=None, query=None):
        self.headers = headers or {}
        self.query_params = query or {}


def test_ws_token_from_subprotocol():
    import base64
    from secu_agent.web.routes.chat import _ws_token_and_subprotocol
    enc = base64.urlsafe_b64encode(b"devtoken").decode().rstrip("=")
    ws = _FakeWSReq(headers={"sec-websocket-protocol": f"th-token.{enc}"})
    tok, proto = _ws_token_and_subprotocol(ws)
    assert tok == "devtoken"
    assert proto == f"th-token.{enc}"  # 핸드셰이크 에코용


def test_ws_token_subprotocol_among_multiple_offers():
    import base64
    from secu_agent.web.routes.chat import _ws_token_and_subprotocol
    enc = base64.urlsafe_b64encode(b"s3cret").decode().rstrip("=")
    ws = _FakeWSReq(headers={"sec-websocket-protocol": f"chat, th-token.{enc}"})
    tok, proto = _ws_token_and_subprotocol(ws)
    assert tok == "s3cret"
    assert proto and proto.startswith("th-token.")


def test_ws_token_query_fallback():
    from secu_agent.web.routes.chat import _ws_token_and_subprotocol
    ws = _FakeWSReq(query={"token": "legacy-tok"})
    tok, proto = _ws_token_and_subprotocol(ws)
    assert tok == "legacy-tok"
    assert proto is None


def test_ws_token_garbage_b64_falls_back_to_query():
    from secu_agent.web.routes.chat import _ws_token_and_subprotocol
    ws = _FakeWSReq(
        headers={"sec-websocket-protocol": "th-token.%%%invalid%%%"},
        query={"token": "qtok"},
    )
    tok, proto = _ws_token_and_subprotocol(ws)
    assert tok == "qtok"
    assert proto is None
