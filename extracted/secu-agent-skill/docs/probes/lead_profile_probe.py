"""리드 프로파일 배선 실측 — 지정한 모델이 **리드 경로에서** 실제로 도구를 부르는가.

`SA_LEAD_PROFILE` 을 바꿀 수 있게 해놓는 것과, 그 모델이 리드 노릇을 할 수 있는 것은
다른 얘기다. 이 프로브가 확인하는 셋:

  1. 폴백이 안 붙는다 — arms 가 하나여야 한다. 리드 A/B 의 전제다(폴백이 뛰면 판단
     주체가 사라져 측정이 무의미해진다).
  2. **실제로 응답한 프로파일**이 지정한 그것이다(llm_provenance 기록).
  3. 리드 모양의 요청(좌표만 있는 롤업 + 닫힌 도구)에 **도구 호출로** 답한다.
     리드는 산문이 아니라 도구로 일한다 — 텍스트만 내면 배선은 됐어도 못 쓴다.

사용: PROBE_LEAD=deepseek python docs/probes/lead_profile_probe.py
"""
import asyncio, collections, os, sys

sys.path.insert(0, "/home/shaneee.baek/project/secu-agent-skill")
from service.runtime_env import load_runtime_env

load_runtime_env(load_plugins=False)

from secu_agent.agent.llm.fallback import FallbackLLMClient
from secu_agent.agent.llm.messages import TextBlock, UserMessage
from secu_agent.agent.llm.types import (
    LLMRequest, StreamError, StreamTextDelta, StreamToolUseDelta,
    StreamToolUseStart, ToolSpec,
)

from _shared.lead_contract import LEAD_CHAIN_ENV
from service.agents.runtime import _build_client

LEAD = os.environ.get("PROBE_LEAD", "deepseek")

# 리드 도구면의 축소판 — 좌표만 받고 닫힌 값만 돌려주는 것들.
TOOLS = [
    ToolSpec(name="target_hit_summary",
             description="타깃의 히트를 범주별로 롤업해 보여준다. 본문은 반환하지 않는다.",
             input_schema={"type": "object",
                           "properties": {"target_id": {"type": "integer"}},
                           "required": ["target_id"]}),
    ToolSpec(name="verify",
             description="닫힌 동사 하나를 수행한다.",
             input_schema={"type": "object",
                           "properties": {"action": {"type": "string", "enum": ["reachable"]},
                                          "target_id": {"type": "integer"}},
                           "required": ["action", "target_id"]}),
    ToolSpec(name="delegate_inspect",
             description="검토원에게 질문 하나를 위임한다.",
             input_schema={"type": "object",
                           "properties": {"target_id": {"type": "integer"},
                                          "question": {"type": "string"}},
                           "required": ["target_id", "question"]}),
]

PROMPT = (
    "큐에서 받은 타깃이다(좌표만 준다 — 본문은 네게 오지 않는다):\n"
    '  target_id=41207  host=10.11.61.46  port=445  share="Users"  files=152\n'
    '  hits: credential 3건 / secret 1건 / pii 0건 (전부 마스킹됨)\n\n'
    "이 타깃을 어떻게 진행할지 **도구를 호출해서** 정하라. 설명만 하지 마라."
)


async def main() -> int:
    os.environ.pop(LEAD_CHAIN_ENV, None)          # ★ 폴백 없음이 이 배선의 전제
    client = _build_client(None, override=LEAD, chain_env=LEAD_CHAIN_ENV)

    arms = ([getattr(m, "_profile_name", "?") for m in (getattr(client, "clients", None) or [])]
            or [getattr(client, "_profile_name", type(client).__name__)])
    chained = isinstance(client, FallbackLLMClient)
    print(f"요청 프로파일 : {LEAD}")
    print(f"client arms  : {arms}  (폴백={'있음 ← A/B 불가' if chained else '없음'})")

    req = LLMRequest(
        messages=[UserMessage(content=[TextBlock(text=PROMPT)])],
        system=("너는 보안 점검의 리드다. 파일 본문·크리덴셜 값·PII 값은 절대 받지 않는다. "
                "좌표와 롤업만 보고 판단하고, 진행은 반드시 도구 호출로 한다."),
        tools=TOOLS, max_tokens=2048,
    )

    kinds: collections.Counter[str] = collections.Counter()
    called: list[str] = []
    err = ""
    async for ev in client.stream(req):
        if isinstance(ev, StreamTextDelta):
            kinds["text"] += 1
        elif isinstance(ev, StreamToolUseStart):
            kinds["tool"] += 1
            called.append(getattr(ev, "name", "?"))
        elif isinstance(ev, StreamToolUseDelta):
            kinds["tool_delta"] += 1
        elif isinstance(ev, StreamError):
            kinds["err"] += 1
            err = str(getattr(ev, "message", ""))[:120]

    from service.agents import llm_provenance
    served = dict(llm_provenance._PROCESS_SERVED)

    print(f"실제 서빙     : {served.get('llm_profile')} / {served.get('llm_model')}")
    print(f"이벤트        : {dict(kinds)}")
    print(f"도구 호출     : {called or '없음'}")
    if err:
        print(f"에러          : {err}")

    ok = (not chained) and served.get("llm_profile") == LEAD and bool(called)
    print(f"\n판정: {'PASS — 리드로 쓸 수 있다' if ok else 'FAIL'}")
    return 0 if ok else 1


sys.exit(asyncio.run(main()))
