"""vision 미지원 프로파일 보호 — ImageBlock 을 텍스트 자리표시자로 강등.

## 왜 필요한가 (2026-07-30 실측)

`deepseek` 는 **이미지 입력을 HTTP 400 으로 거부**한다(gemma 는 수용).
같은 실패를 내던 `gauss-o32` 는 2026-08-20 에 은퇴했다(`gpt-oss`·`gauss-o41` 도 함께).
그런데 코어 엔진은 도구가 반환한 이미지를 tool-result 직후 user 파트에 **ImageBlock**
으로 주입한다(`secu_agent/agent/engine.py:173`, F4-C 비전 되먹임).

400 은 `internal_gateway._classify` 에서 `kind="invalid_request", retryable=False` 로
분류되고, `FallbackLLMClient` 의 폴백 대상은 `{transient, rate_limit, auth}` 뿐이다
(`llm/fallback.py:31`). **재시도도 폴백도 안 걸린다.**

⇒ `smb_inspect_image(analyze=True)` 나 dev_web 스크린샷이 한 번 돌면, 그 이미지가
대화 히스토리에 남는 한 **이후 모든 요청이 400 이고 태스크는 영구히 죽는다.**
A/B 3차에서 gauss 의 dev_web finding 이 0 이었던 것이 이 버그의 관측 결과다
(게이트웨이 500 과는 **별개**의 두 번째 태스크킬러 — [[gateway-toolcall-null-content-500]]).

## 무엇을 하나

vision 미지원 프로파일의 클라이언트에서만, 요청 직전에 ImageBlock 을 제거하고 같은
자리에 한국어 자리표시자 TextBlock 을 넣는다. 모델은 이미지를 못 보지만 **태스크는
살아서** 텍스트 근거로 계속 진행한다. 이미지가 없으면 원본 요청을 그대로 통과시킨다.

## 범위/한계

- 이건 **생존 장치이지 능력 복원이 아니다.** 이미지 증거가 실제로 필요한 도메인
  (smb 이미지 문서·dev_web 스크린샷)은 vision 가능한 프로파일을 쓰는 것이 정답이고,
  워커의 **vision 대체 슬롯**(도메인 전용 모델이 아니다)이 그렇게 잡혀 있다. 이 래퍼는
  누가 vision 불가 모델로 그 도메인을 돌려도 사고가 나지 않게 하는 2차 방어선이다.
- 프로파일**별**로 감싼다 — 폴백 체인에서 deepseek 클라이언트만 강등되고 gemma 는
  이미지를 그대로 받는다.
- 능력 표를 skill 쪽에 두는 이유: 엔진 `LLMProfile` 이 `ConfigDict(extra="forbid")` 라
  `llm_profiles.yaml` 에 `vision:` 필드를 **추가할 수 없다**(엔진 무수정 불변식).

kill-switch: `SA_VISION_COMPAT=0` · 목록 override: `SA_VISION_UNSUPPORTED_PROFILES`.
"""
from __future__ import annotations

import os
from dataclasses import replace
from typing import Any, AsyncIterator

from secu_agent.agent.llm.messages import ImageBlock, TextBlock

# 실측으로 확인된 것만 넣는다. 추측으로 넣으면 멀쩡한 모델의 이미지 증거를 조용히
# 버리게 된다 — 이 래퍼는 실패가 눈에 안 보이는 종류라 특히 위험하다.
# 측정 도구: `docs/probes/vision_probe.py` (16x16 PNG 1장 → 수용/400).
#
#   deepseek  : 400 거부 "deepseek-v4-flash is not a multimodal model"  (2026-08-20)
#   gemma     : 수용 — 응답 '빨강' (색을 실제로 읽었다)                  (2026-08-20)
#   gauss-o41 : 수용 (400 없음, 응답 텍스트는 빔) → 2026-08-20 은퇴(프로필 삭제)
#   gauss-o32 : 400 거부 → 2026-08-20 은퇴(프로필 삭제)
#   gpt-oss   : 수용    → 2026-08-20 은퇴(프로필 삭제)
#
# ⇒ 같은 게이트웨이라도 모델마다 다르다. 형제 모델이라고 추측해서 넣지 말 것.
# ⚠️ 프로필이 은퇴해도 이름을 남겨둘 이유는 없다 — 없는 프로필은 선택될 수 없다.
_DEFAULT_UNSUPPORTED = frozenset({"deepseek"})

_PLACEHOLDER = (
    "[이미지 {n}장 생략 — 현재 모델이 이미지 입력을 지원하지 않는다. "
    "텍스트 근거(파일명·경로·메타데이터·추출 텍스트)만으로 판단하고, "
    "이미지 확인이 반드시 필요하면 그 사실을 근거에 명시하라.]"
)


def _disabled() -> bool:
    return (os.environ.get("SA_VISION_COMPAT", "1") or "").strip().lower() in {
        "0", "false", "no", "off",
    }


def unsupported_profiles() -> frozenset[str]:
    """vision 미지원 프로파일 이름 집합. env 가 있으면 **완전 대체**(추가 아님)."""
    raw = (os.environ.get("SA_VISION_UNSUPPORTED_PROFILES") or "").strip()
    if not raw:
        return _DEFAULT_UNSUPPORTED
    return frozenset(p.strip() for p in raw.split(",") if p.strip())


def supports_vision(profile: str | None) -> bool:
    return str(profile or "") not in unsupported_profiles()


def _has_image(message: object) -> bool:
    return any(
        isinstance(b, ImageBlock) for b in (getattr(message, "content", None) or [])
    )


def strip_images(messages: list[Any]) -> list[Any]:
    """ImageBlock 을 자리표시자 TextBlock 으로 치환한다.

    한 메시지에 이미지가 여러 장이면 **한 개의** 자리표시자로 합친다(토큰 낭비 방지).
    바꿀 게 없으면 원본 리스트를 그대로 돌려준다 — `gateway_compat` 과 같은 규약이라
    요청마다 불필요한 재조립이 생기지 않는다.
    """
    if not any(_has_image(m) for m in messages):
        return messages
    out = []
    for message in messages:
        if not _has_image(message):
            out.append(message)
            continue
        kept: list[Any] = []
        dropped = 0
        for block in message.content:
            if isinstance(block, ImageBlock):
                dropped += 1
                continue
            kept.append(block)
        kept.append(TextBlock(text=_PLACEHOLDER.format(n=dropped)))
        out.append(replace(message, content=kept))
    return out


def normalize_request(request: Any) -> Any:
    messages = getattr(request, "messages", None)
    if not messages:
        return request
    fixed = strip_images(messages)
    return request if fixed is messages else replace(request, messages=fixed)


class VisionCompatClient:
    """요청 직전에 이미지를 걷어내는 얇은 래퍼. 응답은 건드리지 않는다."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def name(self) -> str:
        return str(getattr(self._inner, "name", "vision-compat"))

    def __getattr__(self, item: str) -> Any:
        return getattr(self._inner, item)

    async def stream(self, request: Any) -> AsyncIterator[Any]:
        async for event in self._inner.stream(normalize_request(request)):
            yield event


def wrap_vision_compat(client: Any, *, profile: str | None) -> Any:
    """vision 지원 프로파일이거나 kill-switch 면 무래핑(byte-for-byte 원복)."""
    if _disabled() or supports_vision(profile):
        return client
    return VisionCompatClient(client)
