"""게이트웨이 모델 ID 별 추론폭주/도구호출 실측 — internal 계열만(외부 반출 금지)."""
import asyncio, os, sys, collections
from pathlib import Path
sys.path.insert(0,"/home/shaneee.baek/project/secu-agent-skill")
from service.runtime_env import load_runtime_env
load_runtime_env(load_plugins=False)
from secu_agent.agent.llm.profile import load_profiles
from secu_agent.agent.llm.factory import _build_client as core_build
from secu_agent.agent.llm.messages import TextBlock, UserMessage
from secu_agent.agent.llm.types import (
    LLMRequest, StreamTextDelta, StreamReasoningDelta,
    StreamToolUseStart, StreamToolUseDelta, StreamError,
)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from empty_probe import TOOLS, PROMPT

N = int(os.environ.get("PROBE_N","6"))
MODELS = os.environ.get("PROBE_MODELS","internal-gemma4").split(",")
base = load_profiles(Path(str(Path(os.environ["SA_ENGINE_DIR"])/"config"/"llm_profiles.yaml")))["gemma"]

async def one(client):
    req = LLMRequest(messages=[UserMessage(content=[TextBlock(text=PROMPT)])],
                     system="너는 github 보안 점검 워커다. 반드시 도구 호출로 진행하라.",
                     tools=TOOLS, max_tokens=4096)
    k=collections.Counter(); msg=""
    async for ev in client.stream(req):
        if isinstance(ev, StreamTextDelta): k["text"]+=1
        elif isinstance(ev, StreamReasoningDelta): k["reasoning"]+=1
        elif isinstance(ev,(StreamToolUseStart,StreamToolUseDelta)): k["tool"]+=1
        elif isinstance(ev, StreamError): k["err"]+=1; msg=ev.message[:70]
    return k, msg

async def main():
    print(f"자극=동일(후보 40건 → 도구 호출 요구), max_tokens=4096, N={N}\n")
    print(f"{'모델':26s} {'정상':>5} {'폭주':>5} {'에러':>5} {'도구호출':>7}  비고")
    for m in MODELS:
        prof = base.model_copy(update={"model": m})
        try: client = core_build(prof)
        except Exception as e:
            print(f"{m:26s} 빌드실패 {type(e).__name__}"); continue
        tal=collections.Counter(); tool=0; note=""
        for i in range(N):
            try: k, msg = await asyncio.wait_for(one(client), timeout=150)
            except Exception as e: tal["에러"]+=1; note=type(e).__name__; continue
            if k["err"]: tal["에러"]+=1; note=msg; continue
            if k["text"] or k["tool"]: tal["정상"]+=1
            else: tal["폭주"]+=1
            if k["tool"]: tool+=1
        print(f"{m:26s} {tal['정상']:>5} {tal['폭주']:>5} {tal['에러']:>5} {tool:>7}  {note[:45]}", flush=True)
asyncio.run(main())
