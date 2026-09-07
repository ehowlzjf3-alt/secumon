"""프로파일별 vision(ImageBlock) 수용 실측 — internal 게이트웨이만.

`vision_compat._DEFAULT_UNSUPPORTED` 는 "측정된 것만 넣는다"가 계약이라
추측으로 목록을 바꾸면 안 된다. 이 프로브가 그 근거를 만든다.
"""
import asyncio, base64, os, sys
from pathlib import Path

sys.path.insert(0, "/home/shaneee.baek/project/secu-agent-skill")
from service.runtime_env import load_runtime_env
load_runtime_env(load_plugins=False)

from secu_agent.agent.llm.profile import load_profiles
from secu_agent.agent.llm.factory import _build_client as core_build
from secu_agent.agent.llm.messages import ImageBlock, TextBlock, UserMessage
from secu_agent.agent.llm.types import LLMRequest, StreamTextDelta, StreamError

# 8x8 빨간 PNG (내용 없는 합성 이미지 — 실데이터 아님)
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII="
)

# ⚠️ gaussO4 는 2026-08-20 기준 엔드포인트가 404 (apigw .../gausso4-vl/v1) — 별건.
CANDIDATES = os.environ.get(
    "VISION_PROBE_PROFILES", "gemma,deepseek",
).split(",")

profiles = load_profiles(
    Path(os.environ["SA_ENGINE_DIR"]) / "config" / "llm_profiles.yaml"
)


async def probe(name: str) -> str:
    prof = profiles.get(name)
    if prof is None:
        return "프로파일 없음"
    try:
        client = core_build(prof)
    except Exception as e:
        return f"빌드실패 {type(e).__name__}: {e}"
    req = LLMRequest(
        messages=[UserMessage(content=[
            TextBlock(text="이 이미지의 색을 한 단어로만 답하라."),
            ImageBlock(media_type="image/png",
                       data_b64=base64.b64encode(PNG).decode()),
        ])],
        system="너는 이미지를 읽는 보안 점검 워커다.",
        tools=[], max_tokens=64,
    )
    text, err = "", ""
    try:
        async for ev in client.stream(req):
            if isinstance(ev, StreamTextDelta):
                text += ev.text
            elif isinstance(ev, StreamError):
                err = ev.message[:200]
    except Exception as e:
        err = f"{type(e).__name__}: {e}"[:200]
    if err:
        return f"❌ 거부  {err}"
    return f"✅ 수용  응답={text.strip()[:40]!r}"


async def main() -> None:
    print(f"{'프로파일':14s} 결과")
    for name in CANDIDATES:
        name = name.strip()
        if not name:
            continue
        print(f"{name:14s} {await probe(name)}", flush=True)


asyncio.run(main())
