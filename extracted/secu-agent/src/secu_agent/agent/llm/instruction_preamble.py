"""LLM instructions preamble — 등록형 기여 훅 (de-domain v3.84 #1).

이전엔 codex transport 가 Samsung DS SecOps / samsungds.net / SMB·SSO 등 보안·조직
특화 preamble 문자열을 모듈 상수로 하드코딩하고 매 요청 instructions 최상단에 박았다
(코어 도메인 누출). 코어는 프로토콜+게이트+등록 API 만 담아야 하므로, preamble 내용은
도메인 어댑터(secu-agent-skill plugin)가 이 훅으로 등록하고 코어 transport 는 등록된
것을 결합만 한다 — 코어 단독(plugin 미부착)이면 preamble 없음(도메인-프리 기본).

transport-level 훅인 이유: preamble 은 (예) chatgpt.com 모더레이터가 방어보안 콘텐츠를
차단하는 것을 우회하려고 **모든** codex 요청(judge/summarizer/sub-agent 포함, 도메인
system prompt 를 안 쓰는 것도)에 붙어야 했다. 도메인 system prompt 로 옮기면 그런
요청들이 preamble 을 잃어 동작이 바뀐다 — 그래서 transport 훅으로 보존한다.
"""
from __future__ import annotations

from typing import Callable

# 등록된 preamble 공급자. 각 () -> str (빈 문자열/None 이면 skip). 코어는 아무것도
# 등록하지 않는다 (도메인-프리). plugin 재부착이 register_instruction_preamble 로 채운다.
_PREAMBLES: list[Callable[[], str | None]] = []


def register_instruction_preamble(fn: Callable[[], str | None]) -> None:
    """LLM instructions 최상단 기여 preamble 공급자 등록 (plugin 부트스트랩용).

    fn 은 인자 없이 호출돼 preamble 문자열(또는 빈/None)을 반환한다 — 매 요청 시
    호출되므로 공급자가 env kill-switch 등으로 런타임에 켜고 끌 수 있다.
    """
    if not callable(fn):
        raise TypeError("instruction preamble 공급자는 callable 이어야 한다")
    _PREAMBLES.append(fn)


def unregister_all_instruction_preambles() -> None:
    """등록 전체 해제 (테스트/재부착 멱등 보장용)."""
    _PREAMBLES.clear()


def compose_instruction_preamble() -> str:
    """등록된 preamble 들을 결합해 반환 (없으면 빈 문자열). 공급자 예외는 무시."""
    parts: list[str] = []
    for fn in _PREAMBLES:
        try:
            s = fn()
        except Exception:
            continue
        if s and s.strip():
            parts.append(s.strip())
    return "\n\n".join(parts)


__all__ = [
    "register_instruction_preamble",
    "unregister_all_instruction_preambles",
    "compose_instruction_preamble",
]
