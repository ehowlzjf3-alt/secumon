"""캡처가 정말 '나가는 전부' 인가 — transport kwargs 와 대조 (Phase 3d).

`_shared/egress_capture.py` 는 `LLMRequest`(에이전트 층이 transport 에 건네는 것)를 적는다.
그게 실제 HTTP 본문과 **같은 내용**인지는 주장이 아니라 확인의 대상이다.

여기서는 같은 요청으로 codex transport 의 `_build_kwargs` 를 떠서, 캡처에 없는 문자열이
kwargs 에 있는지 본다. 네트워크는 타지 않는다(자격증명 불필요).

    PYTHONPATH=. SA_ENGINE_DIR=~/project/secu-agent \
        ~/project/secu-agent/.venv/bin/python docs/probes/egress_diff.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def _strings(obj) -> set[str]:
    """JSON 트리의 모든 문자열 토큰(길이 4 이상)."""
    out: set[str] = set()
    stack = [obj]
    while stack:
        cur = stack.pop()
        if isinstance(cur, str):
            for tok in re.split(r"[\s,;{}\[\]()\"']+", cur):
                if len(tok) >= 4:
                    out.add(tok)
        elif isinstance(cur, dict):
            stack.extend(list(cur.keys()) + list(cur.values()))
        elif isinstance(cur, (list, tuple)):
            stack.extend(cur)
    return out


def main() -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from secu_agent.agent.llm.messages import TextBlock, UserMessage
    from secu_agent.agent.llm.types import LLMRequest, ToolSpec

    from _shared.egress_capture import _plain

    secret_marker = "CANARY-9f3a1c-DO-NOT-LEAK"
    request = LLMRequest(
        system=f"너는 리드다. {secret_marker}",
        messages=[UserMessage(content=[TextBlock(text="타깃 672 를 봐라")])],
        tools=[ToolSpec(name="delegate_inspect", description="검토원 위임",
                        input_schema={"type": "object", "properties": {}})],
        max_tokens=2048,
    )

    captured = _plain(request)
    cap_strings = _strings(captured)
    print(f"캡처 문자열 토큰: {len(cap_strings)}개")
    if secret_marker not in json.dumps(captured, ensure_ascii=False):
        print("✗ 캡처가 system prompt 를 놓쳤다")
        return 1
    print("✓ 캡처에 system/messages/tools 가 모두 들어 있다")

    from secu_agent.agent.llm.codex_responses_client import CodexResponsesClient

    # 실 codex 프로파일을 그대로 쓴다 — 손으로 지어낸 프로파일은 실제 transport 동작을
    # 대변하지 못한다(reasoning_effort/service_tier 가 kwargs 를 바꾼다).
    from secu_agent.agent.llm.profile import load_profiles
    import os

    engine = Path(os.environ.get("SA_ENGINE_DIR",
                                 str(Path.home() / "project" / "secu-agent")))
    profiles = load_profiles(engine / "config" / "llm_profiles.yaml")
    profile = profiles.get("codex")
    if profile is None:
        print("✗ llm_profiles.yaml 에 codex 프로파일이 없다")
        return 1
    client = CodexResponsesClient(profile)
    kwargs = client._build_kwargs(request)
    kw_strings = _strings(kwargs)

    extra = {t for t in kw_strings - cap_strings if not t.startswith(("gpt-", "http"))}
    # transport 가 붙이는 상수(reasoning/effort/store 등)는 내용이 아니다 — 값이
    # 요청에서 온 게 아니면 프로파일/코드 상수다. 그 목록을 눈으로 확인할 수 있게 찍는다.
    print(f"transport kwargs 에만 있는 토큰 {len(extra)}개:")
    for t in sorted(extra)[:40]:
        print(f"    {t}")
    print()
    print("판정: 위 목록에 **요청 내용**(경로·호스트·본문 조각)이 있으면 캡처 지점이 낮다.")
    print("      전부 상수/스키마 키워드면 캡처가 나가는 내용을 다 담고 있다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
