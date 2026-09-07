"""OpenAI Responses API (Codex / ChatGPT enterprise) 어댑터 — v3.56.

chat.completions(OpenAICompatClient)와 wire 포맷이 다르다:
- `/responses` 엔드포인트, `input` items + 최상위 `instructions`
- reasoning 은 `reasoning:{effort, summary}` dict + `include:[reasoning.encrypted_content]`
- max_output_tokens / temperature 미사용 (chatgpt.com backend 이 무시/거부)
- 인증은 OAuth Bearer(access_token) + Cloudflare 우회 헤더(originator/account-id)

oss 게이트웨이용 워크어라운드(max_completion_tokens·temperature fallback flag 등)는
OpenAICompatClient 안에만 있고 여기엔 안 들어온다 — codex 식으로 깨끗하게 짠다.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
from openai import AsyncOpenAI

from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.codex_auth import (
    CodexAuthError,
    codex_account_id,
    resolve_codex_credentials,
)
from secu_agent.agent.llm.internal_gateway import _classify
from secu_agent.agent.llm.messages import (
    AssistantMessage,
    ImageBlock,
    Message,
    StopReason,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from secu_agent.agent.llm.profile import LLMProfile
from secu_agent.agent.llm.types import (
    LLMRequest,
    StreamError,
    StreamEvent,
    StreamMessageStop,
    StreamReasoningDelta,
    StreamTextDelta,
    StreamToolUseDelta,
    StreamToolUseStart,
    StreamToolUseStop,
    StreamUsage,
    ToolSpec,
)

# gpt-5 계열은 minimal/low/medium/high/xhigh dial 을 받는다. 그대로 전달.
_VALID_EFFORTS = {"minimal", "low", "medium", "high", "xhigh"}

# v3.65: Codex "Fast" = service_tier 'priority' (1.5x 속도, 크레딧 더 씀, 추론/모델 무변).
# wire 값은 tier id (config alias "fast" 아님 — codex CLI 가 실제로 priority 송신, 로그 확인).
# OAuth(구독 크레딧) 경로라 사용 가능(API key 면 불가). 기본 priority — 끄려면 env=default/off.
_VALID_SERVICE_TIERS = {"auto", "default", "flex", "scale", "priority"}
_SERVICE_TIER_DEFAULT = "priority"


# de-domain v3.84 #1: instructions preamble 은 등록형 훅으로 이동했다. 코어 transport 는
# 등록된 preamble 을 결합만 하고 내용은 모른다 (도메인/조직 특화 문구는 secu-agent-skill
# plugin 이 register_instruction_preamble 로 공급). 코어 단독이면 preamble 없음.
import os as _os  # noqa: E402

from secu_agent.agent.llm.instruction_preamble import compose_instruction_preamble


def _apply_instruction_preamble(system: str) -> str:
    preamble = compose_instruction_preamble()
    if not preamble:
        return system or ""
    if not system:
        return preamble
    # 중복 prepend 방지 (앞 80자 prefix 매칭).
    if system.lstrip().startswith(preamble[:80]):
        return system
    return preamble + "\n\n" + system


def _to_responses_input(messages: list[Message]) -> list[dict[str, Any]]:
    """내부 Message 블록 → Responses input items. (system 은 instructions 로 분리)"""
    items: list[dict[str, Any]] = []
    for m in messages:
        if isinstance(m, SystemMessage):
            # mid-convo system note (드묾) — Responses input 에 system role 이 모호해
            # user note 로 안전하게 흘린다.
            items.append({
                "role": "user",
                "content": [{"type": "input_text", "text": f"[SYSTEM NOTE]\n{m.text}"}],
            })
        elif isinstance(m, UserMessage):
            parts: list[dict[str, Any]] = []
            for b in m.content:
                if isinstance(b, ToolResultBlock):
                    # function_call_output 는 독립 input item (user content 밖).
                    items.append({
                        "type": "function_call_output",
                        "call_id": b.tool_use_id,
                        "output": b.content,
                    })
                elif isinstance(b, TextBlock):
                    parts.append({"type": "input_text", "text": b.text})
                elif isinstance(b, ImageBlock):
                    parts.append({
                        "type": "input_image",
                        "image_url": f"data:{b.media_type};base64,{b.data_b64}",
                    })
            if parts:
                items.append({"role": "user", "content": parts})
        elif isinstance(m, AssistantMessage):
            parts = []
            calls: list[ToolUseBlock] = []
            for b in m.content:
                if isinstance(b, TextBlock):
                    parts.append({"type": "output_text", "text": b.text})
                elif isinstance(b, ToolUseBlock):
                    calls.append(b)
            if parts:
                items.append({"role": "assistant", "content": parts})
            for tb in calls:
                items.append({
                    "type": "function_call",
                    "call_id": tb.id,
                    "name": tb.name,
                    "arguments": json.dumps(tb.input, ensure_ascii=False),
                })
    return _repair_tool_pairing(items)


def _repair_tool_pairing(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Responses API 는 function_call ↔ function_call_output 1:1 을 요구한다.
    압축이 tool_use/tool_result 짝을 자르거나, ESC/취소로 tool_use 만 남거나,
    결과가 유실되면 400 'No tool output found for function call ...' 가 나고
    엔진이 같은 히스토리로 재시도하며 **무한반복**한다. 마지막 방어선으로 복구:
      - output 없는 function_call → 직후에 placeholder function_call_output 주입
      - 선행 call 없는 orphan function_call_output → 제거
    (정상 짝은 그대로 — 멀쩡한 흐름은 안 건드린다.)"""
    call_ids = {it.get("call_id") for it in items if it.get("type") == "function_call"}
    out_ids = {it.get("call_id") for it in items if it.get("type") == "function_call_output"}
    repaired: list[dict[str, Any]] = []
    for it in items:
        t = it.get("type")
        if t == "function_call_output" and it.get("call_id") not in call_ids:
            continue  # orphan output drop (선행 call 없음)
        repaired.append(it)
        if t == "function_call" and it.get("call_id") not in out_ids:
            # 짝 없는 호출 — placeholder 주입(호출 직후). 쿠키/값 노출 없음.
            repaired.append({
                "type": "function_call_output",
                "call_id": it.get("call_id"),
                "output": "[도구 결과 없음 — 호출이 중단(ESC)되었거나 컨텍스트 압축으로 유실됨]",
            })
    return repaired


def _to_responses_tools(tools: list[ToolSpec] | None) -> list[dict[str, Any]] | None:
    """ToolSpec → Responses function-tool (flat) 스키마."""
    if not tools:
        return None
    return [
        {
            "type": "function",
            "name": t.name,
            "description": t.description,
            "strict": False,
            "parameters": t.input_schema or {"type": "object", "properties": {}},
        }
        for t in tools
    ]


def _response_format_to_text(rf: Any) -> dict[str, Any] | None:
    """chat.completions response_format → Responses `text.format`.

    goal judge 의 JSON 강제(response_format)를 codex 에서도 동작시킨다.
    """
    if not isinstance(rf, dict):
        return None
    rtype = rf.get("type")
    if rtype == "json_object":
        return {"format": {"type": "json_object"}}
    if rtype == "json_schema":
        js = rf.get("json_schema") or {}
        fmt: dict[str, Any] = {"type": "json_schema"}
        if isinstance(js, dict):
            if js.get("name"):
                fmt["name"] = js["name"]
            if js.get("schema") is not None:
                fmt["schema"] = js["schema"]
            if "strict" in js:
                fmt["strict"] = js["strict"]
        return {"format": fmt}
    return None


def _usage_from(final: Any) -> StreamUsage | None:
    u = getattr(final, "usage", None)
    if u is None:
        return None
    inp = getattr(u, "input_tokens", None)
    out = getattr(u, "output_tokens", None)
    if inp is None and out is None:
        return None
    _itd = getattr(u, "input_tokens_details", None)
    _cached = int(getattr(_itd, "cached_tokens", 0) or 0) if _itd else 0
    _inp = int(inp or 0)
    return StreamUsage(
        input_tokens=_inp, output_tokens=int(out or 0),
        cache_read_input_tokens=_cached,
        # Responses API 도 cached_tokens(read)만 보고한다 — cache 쓰기 수치는 없다.
        # (input-cached)를 creation 으로 라벨하면 미캐시 입력을 cache-write 로 오기재
        # 하므로 보고된 값만 싣고 creation 은 0 으로 둔다 (internal_gateway 와 동일).
        cache_creation_input_tokens=0,
    )


def _finish_reason(final: Any, has_tool: bool) -> StopReason:
    if has_tool:
        return "tool_use"
    status = getattr(final, "status", None)
    if status == "incomplete":
        details = getattr(final, "incomplete_details", None)
        reason = getattr(details, "reason", None) if details else None
        if reason == "max_output_tokens":
            return "max_tokens"
    return "end_turn"


class CodexResponsesClient(LLMClient):
    """OpenAI Responses API 어댑터 (transport=codex_responses)."""

    def __init__(self, profile: LLMProfile) -> None:
        self._profile = profile
        self._http = httpx.AsyncClient(
            proxy=profile.proxy or None,
            verify=profile.verify_ssl,
            timeout=profile.timeout,
            trust_env=profile.trust_env,
        )

    @property
    def name(self) -> str:
        return self._profile.name

    @property
    def harness_tier(self) -> str | None:
        # Front-D: profile 등급을 client 로 노출 — 모든 agent-loop 경로가 여기서 파생.
        return self._profile.harness_tier

    async def aclose(self) -> None:
        await self._http.aclose()

    def _cloudflare_headers(self, access_token: str) -> dict[str, str]:
        """chatgpt.com/backend-api/codex Cloudflare 403 회피 헤더 (codex-rs CLI 모방)."""
        headers = {
            "User-Agent": "codex_cli_rs/0.0.0 (Secu Agent)",
            "originator": "codex_cli_rs",
        }
        acct = codex_account_id(access_token)
        if acct:
            headers["ChatGPT-Account-ID"] = acct
        return headers

    def _build_client(self) -> AsyncOpenAI:
        """매 호출마다 토큰 만료 재확인 → 필요시 refresh → 현재 access_token 으로 client.

        resolve_codex_credentials 는 토큰 만료 임박 시 **동기** httpx OAuth refresh(수 초)를
        수행할 수 있어, async stream() 에서 직접 호출하면 그 사이 이벤트 루프 전체가 막힌다.
        그래서 stream() 은 이 메서드를 asyncio.to_thread 로 오프로드해 부른다.
        (이 메서드 자체의 시맨틱은 불변 — 동일 토큰·캐싱/만료·에러/헤더. 동기 유지해야
        기존 테스트가 sync 대체 lambda 로 몽키패치할 수 있다.)
        """
        cred = resolve_codex_credentials(self._profile.auth.token_path)
        base_url = self._profile.base_url or cred.base_url
        return AsyncOpenAI(
            base_url=base_url,
            api_key=cred.access_token,
            http_client=self._http,
            default_headers=self._cloudflare_headers(cred.access_token),
        )

    def _build_kwargs(self, request: LLMRequest) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": self._profile.model,
            "instructions": _apply_instruction_preamble(request.system or ""),
            "input": _to_responses_input(request.messages),
            "tool_choice": "auto",
            "parallel_tool_calls": True,
            "store": False,
            # stream=True 는 넣지 않는다 — responses.stream() 은 전용 스트리밍
            # 컨텍스트매니저라 stream kwarg 를 거부한다 (create(stream=True) 와 다름).
        }
        tools = _to_responses_tools(request.tools)
        if tools:
            kwargs["tools"] = tools

        # reasoning: per-request override → profile 기본(xhigh). codex 는 항상 reasoning 지원.
        effort = None
        if request.vendor_params:
            effort = request.vendor_params.get("reasoning_effort")
        effort = effort or self._profile.reasoning_effort
        if isinstance(effort, str) and effort in _VALID_EFFORTS:
            kwargs["reasoning"] = {"effort": effort, "summary": "auto"}
            kwargs["include"] = ["reasoning.encrypted_content"]

        # response_format(goal judge JSON) → Responses text.format.
        if request.vendor_params:
            text_cfg = _response_format_to_text(request.vendor_params.get("response_format"))
            if text_cfg:
                kwargs["text"] = text_cfg

        # v3.65: Codex Fast(service_tier=priority). 우선순위 per-request → env → profile → 기본.
        tier = self._resolve_service_tier(request)
        if tier:
            kwargs["service_tier"] = tier

        # max_output_tokens / temperature 는 의도적으로 송신하지 않음 (codex backend 무시/거부).
        return kwargs

    def _resolve_service_tier(self, request: LLMRequest) -> str | None:
        """Codex service_tier 해석. vendor_params → env → profile → 기본('priority').

        유효 tier 면 그 값, 아니면(빈값/'off'/오타) None → 미송신(backend 기본 사용).
        """
        val: Any = None
        if request.vendor_params:
            val = request.vendor_params.get("service_tier")
        val = val or _os.environ.get("SA_CODEX_SERVICE_TIER")
        val = val or self._profile.service_tier
        if val is None:
            val = _SERVICE_TIER_DEFAULT
        val = str(val).strip().lower()
        return val if val in _VALID_SERVICE_TIERS else None

    async def stream(self, request: LLMRequest) -> AsyncIterator[StreamEvent]:
        import openai

        try:
            # 자격증명 resolve 는 만료 임박 시 동기 httpx OAuth refresh(수 초)를 돌 수 있어
            # 이벤트 루프를 막는다 → 스레드로 오프로드(시맨틱 불변, refresh/캐싱/에러 그대로).
            client = await asyncio.to_thread(self._build_client)
            kwargs = self._build_kwargs(request)
        except CodexAuthError as e:
            yield StreamError(kind="auth", message=str(e))
            return
        except openai.APIError as e:
            yield _classify(e)
            return

        # chatgpt.com/backend-api/codex 의 SSE 는 SDK 의 strict typed `.stream()`
        # 파서(parse_response)와 안 맞아 터진다. raw 이벤트 이터레이터인
        # `.create(stream=True)` 로 받아 우리가 직접 누적한다 (hermes 의 chatgpt
        # backend 폴백 경로와 동일). final 은 response.completed 이벤트의 .response.
        collected_items: list[Any] = []
        streamed_text = False
        final: Any = None
        try:
            event_stream = await client.responses.create(stream=True, **kwargs)
            async for event in event_stream:
                et = getattr(event, "type", "") or ""
                if et.endswith("output_text.delta"):
                    delta = getattr(event, "delta", "") or ""
                    if delta:
                        streamed_text = True
                        yield StreamTextDelta(text=delta)
                elif "reasoning" in et and et.endswith("delta"):
                    rdelta = getattr(event, "delta", "") or ""
                    if rdelta:
                        yield StreamReasoningDelta(text=rdelta)
                elif et == "response.output_item.done":
                    item = getattr(event, "item", None)
                    if item is not None:
                        collected_items.append(item)
                elif et in ("response.completed", "response.incomplete",
                            "response.failed"):
                    final = getattr(event, "response", None)
        except openai.APIError as e:
            yield _classify(e)
            return

        out = getattr(final, "output", None)
        if not isinstance(out, list) or not out:
            out = collected_items

        has_tool = False
        for item in out:
            itype = getattr(item, "type", "")
            if itype == "function_call":
                has_tool = True
                call_id = getattr(item, "call_id", "") or getattr(item, "id", "")
                yield StreamToolUseStart(tool_use_id=call_id, name=getattr(item, "name", ""))
                args = getattr(item, "arguments", "") or ""
                if args:
                    yield StreamToolUseDelta(tool_use_id=call_id, input_json_delta=args)
                yield StreamToolUseStop(tool_use_id=call_id)
            elif itype == "message" and not streamed_text:
                # 텍스트 델타를 못 받은 backend(chatgpt.com)면 final 에서 backfill.
                txt = "".join(
                    getattr(c, "text", "") or ""
                    for c in (getattr(item, "content", None) or [])
                    if getattr(c, "type", "") == "output_text"
                )
                if txt:
                    yield StreamTextDelta(text=txt)

        yield StreamMessageStop(
            stop_reason=_finish_reason(final, has_tool),
            usage=_usage_from(final),
        )
