"""빈 완성의 정체 규명 — 전송 결함(H1) vs 모델 행동/추론예산소진(H2).

실패 턴 재현: 큰 도구 결과를 받은 직후, 도구를 든 채로 다음 행동을 요구한다.
각 콜을 이벤트 종류로 분류하고 usage 를 찍는다.
  text/tool 있음        → 정상
  reasoning 만 있음      → H2 (모델이 생각만 하고 답을 안 냄)
  아무 이벤트 없음        → H1 (게이트웨이가 빈 응답)
"""
import asyncio, os, sys, collections
sys.path.insert(0, "/home/shaneee.baek/project/secu-agent-skill")
from service.runtime_env import load_runtime_env
load_runtime_env(load_plugins=False)
from secu_agent.agent.llm.messages import TextBlock, UserMessage
from secu_agent.agent.llm.types import (
    LLMRequest, ToolSpec, StreamTextDelta, StreamReasoningDelta,
    StreamToolUseStart, StreamToolUseDelta, StreamUsage, StreamError,
)
from service.agents import runtime

N = int(os.environ.get("PROBE_N", "8"))
MAXTOK = int(os.environ.get("PROBE_MAX_TOKENS", "4096"))
PROFILE = os.environ.get("PROBE_PROFILE", "gemma")

TOOLS = [
    ToolSpec(name="github_browse",
             description="github URL 을 열어 파일 내용을 반환한다.",
             input_schema={"type":"object","properties":{"url":{"type":"string"},
                           "patterns":{"type":"array","items":{"type":"string"}}},
                           "required":["url"]}),
    ToolSpec(name="devops_target_set_status",
             description="타깃을 종료 상태로 닫는다(필수 종료 도구).",
             input_schema={"type":"object","properties":{"target_id":{"type":"integer"},
                           "status":{"type":"string"},"finding_count":{"type":"integer"}},
                           "required":["target_id","status","finding_count"]}),
]

# 실패 턴 직전 상황을 모사 — 스캔이 후보 다수를 돌려준 뒤
BIG = "\n".join(
    f'{{"path": "examples/file_{i}.py", "kind": "generic_password_assignment", '
    f'"masked": "pw**{i}", "line": {100+i}}}' for i in range(40))
PROMPT = (
    "github_task_scan 결과다(후보 40건):\n" + BIG +
    "\n\n이제 다음 행동을 하나 골라 **도구로 호출**하라. 설명만 하지 마라."
)

async def one(client):
    req = LLMRequest(
        messages=[UserMessage(content=[TextBlock(text=PROMPT)])],
        system="너는 github 보안 점검 워커다. 반드시 도구 호출로 진행하라.",
        tools=TOOLS, max_tokens=MAXTOK,
    )
    kinds = collections.Counter(); usage=None; err=None
    async for ev in client.stream(req):
        if isinstance(ev, StreamTextDelta): kinds["text"] += 1
        elif isinstance(ev, StreamReasoningDelta): kinds["reasoning"] += 1
        elif isinstance(ev, (StreamToolUseStart, StreamToolUseDelta)): kinds["tool"] += 1
        elif isinstance(ev, StreamUsage): usage = ev
        elif isinstance(ev, StreamError): err = ev
        else: kinds[type(ev).__name__] += 1
    return kinds, usage, err

async def main():
    os.environ.pop("SA_CHAT_PROFILE", None)
    os.environ.pop("SA_CHAT_PROFILE_CHAIN", None)
    client = runtime._build_client(PROFILE)
    print(f"프로파일={getattr(client,'_profile_name','?')} max_tokens={MAXTOK} N={N}\n")
    tally = collections.Counter()
    for i in range(N):
        try:
            kinds, usage, err = await asyncio.wait_for(one(client), timeout=180)
        except Exception as e:
            print(f"  #{i+1} EXC {type(e).__name__}: {str(e)[:90]}"); tally["exc"]+=1; continue
        has_out = kinds["text"] or kinds["tool"]
        if has_out:              verdict = "정상"
        elif kinds["reasoning"]: verdict = "★H2 reasoning만"
        else:                    verdict = "★H1 완전 빈 응답"
        tally[verdict]+=1
        u = f"in={usage.input_tokens} out={usage.output_tokens}" if usage else "usage없음"
        print(f"  #{i+1} {verdict:18s} text={kinds['text']:>4} tool={kinds['tool']:>3} "
              f"reasoning={kinds['reasoning']:>5}  {u}" + (f"  ERR={err.message[:50]}" if err else ""))
    print("\n집계:", dict(tally))
asyncio.run(main())
