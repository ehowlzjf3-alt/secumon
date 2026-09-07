"""Image artifact inspection tools.

기본 모드: metadata (format, dimensions, sha256). vision LLM 호출 없음.
v3.43-V2: analyze=True 면 SA_VISION_PROFILE (default `gaussO4`) 의 vision-capable
LLM 으로 실제 본문 분석.
"""
from __future__ import annotations

import base64
import hashlib
import os
import struct
from pathlib import Path
from typing import ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import ImageBlock, TextBlock, UserMessage
from secu_agent.agent.llm.types import LLMRequest, StreamMessageStop, StreamTextDelta
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess
from secu_agent.agent.tools.host_tools import PathBlockError, _resolve_abs, _validate_for_read


_MAX_IMAGE_BYTES = 50 * 1024 * 1024
_DEFAULT_VISION_INLINE_CAP = 2 * 1024 * 1024   # 2MB — vision request 본문 cap
_DEFAULT_VISION_PROMPT = (
    "이 이미지를 사내 보안 점검 관점에서 분석해줘. 다음을 보고:\n"
    "1) 화면에 자격증명/토큰/PII 가 노출돼있는지\n"
    "2) sensitive 정보 (사내 시스템 URL, 내부 IP, 직원 정보) 가 visible 한지\n"
    "3) phishing / 의심스러운 UI 가 있는지\n"
    "분석 결과만 한국어로 짧게 보고. metadata 는 별도로 표시되니까 본문만."
)


class ImageInspectInput(BaseModel):
    path: str = Field(description="absolute path 또는 ~ path. PNG/JPEG/GIF/WebP metadata 확인.")
    analyze: bool = Field(
        default=False,
        description=(
            "v3.43: True 면 vision-capable LLM (SA_VISION_PROFILE, default 'gaussO4') "
            "으로 본문 분석. metadata 와 함께 [analysis] 섹션으로 반환."
        ),
    )
    prompt: str | None = Field(
        default=None,
        description="analyze=True 일 때 vision LLM 에 보낼 사용자 지정 prompt.",
    )


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _png_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 24 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return None
    return struct.unpack(">II", data[16:24])


def _gif_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 10 or not (data.startswith(b"GIF87a") or data.startswith(b"GIF89a")):
        return None
    return struct.unpack("<HH", data[6:10])


def _webp_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 30 or not (data.startswith(b"RIFF") and data[8:12] == b"WEBP"):
        return None
    if data[12:16] == b"VP8 " and len(data) >= 30:
        return struct.unpack("<HH", data[26:30])
    if data[12:16] == b"VP8X" and len(data) >= 30:
        width = int.from_bytes(data[24:27], "little") + 1
        height = int.from_bytes(data[27:30], "little") + 1
        return width, height
    return None


def _jpeg_size(data: bytes) -> tuple[int, int] | None:
    if len(data) < 4 or not data.startswith(b"\xff\xd8"):
        return None
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        i += 2
        if marker in {0xD8, 0xD9}:
            continue
        if i + 2 > len(data):
            return None
        segment_len = int.from_bytes(data[i:i + 2], "big")
        if segment_len < 2 or i + segment_len > len(data):
            return None
        if marker in {
            0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
            0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
        }:
            if segment_len < 7:
                return None
            height = int.from_bytes(data[i + 3:i + 5], "big")
            width = int.from_bytes(data[i + 5:i + 7], "big")
            return width, height
        i += segment_len
    return None


def _detect_image(data: bytes) -> tuple[str, int, int] | None:
    checks = (
        ("png", _png_size),
        ("jpeg", _jpeg_size),
        ("gif", _gif_size),
        ("webp", _webp_size),
    )
    for fmt, fn in checks:
        size = fn(data)
        if size is not None:
            width, height = size
            return fmt, width, height
    return None


_FMT_TO_MIME = {
    "png": "image/png",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
}


async def _vision_analyze(
    client: LLMClient, prompt: str, data: bytes, mime: str,
) -> str:
    """vision LLM 호출 → 텍스트 응답 누적."""
    msg = UserMessage(content=[
        TextBlock(text=prompt),
        ImageBlock(
            media_type=mime,
            data_b64=base64.b64encode(data).decode(),
        ),
    ])
    req = LLMRequest(messages=[msg], system=None, tools=None,
                     max_tokens=2048, temperature=0.0)
    chunks: list[str] = []
    async for ev in client.stream(req):
        if isinstance(ev, StreamTextDelta):
            chunks.append(ev.text)
        elif isinstance(ev, StreamMessageStop):
            break
    return "".join(chunks).strip()


class ImageInspectTool(Tool[ImageInspectInput]):
    name: ClassVar[str] = "image_inspect"
    description: ClassVar[str] = (
        "Inspect image artifact metadata. Returns format, width, height, bytes, "
        "sha256, and path. v3.43-V2: analyze=True 면 vision-capable LLM "
        "(SA_VISION_PROFILE, default 'gaussO4') 으로 본문 분석 결과 [analysis] "
        "섹션 포함."
    )
    input_model: ClassVar[type[BaseModel]] = ImageInspectInput
    is_read_only: ClassVar[bool] = True
    is_destructive: ClassVar[bool] = False
    deferred: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    search_hint: ClassVar[str] = "image inspect screenshot png jpeg gif webp dimensions sha256 vision analyze"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "image", "screenshot", "png", "jpeg", "캡쳐", "스크린샷", "vision",
    )
    prompt_section: ClassVar[str] = (
        "### image_inspect(path, analyze=False, prompt=None)\n"
        "이미지 artifact 검증. screenshot 저장/복사 후 `format/width/height/sha256` 확인. "
        "**analyze=True** 면 사내 vision-capable LLM 으로 본문 분석 — 자격증명/PII/sensitive "
        "정보 노출 여부 보고. 기본 모드는 metadata 만이라 본문 봤다고 말하지 말 것."
    )

    def __init__(
        self,
        vision_client: LLMClient | None = None,
        vision_max_bytes: int = _DEFAULT_VISION_INLINE_CAP,
    ):
        self._vision_client = vision_client
        self._vision_max_bytes = vision_max_bytes

    def _get_vision_client(self) -> LLMClient:
        if self._vision_client is not None:
            return self._vision_client
        # lazy import — vision profile 없으면 ToolError 로 graceful 처리
        from secu_agent.agent.llm.factory import build_chat_client_from_profile
        profile = os.environ.get("SA_VISION_PROFILE", "gaussO4")
        return build_chat_client_from_profile(profile)

    async def execute(self, vi: ImageInspectInput, ctx: ToolContext) -> ToolResult:
        del ctx
        try:
            p = _resolve_abs(vi.path)
            _validate_for_read(p)
        except PathBlockError as e:
            return ToolError(kind="forbidden", message=str(e))
        if not p.exists():
            return ToolError(kind="not_found", message=f"{p} 미존재")
        if not p.is_file():
            return ToolError(kind="not_file", message=f"{p} not a file")
        try:
            size = p.stat().st_size
            if size > _MAX_IMAGE_BYTES:
                return ToolError(kind="too_large", message=f"{size} bytes > {_MAX_IMAGE_BYTES} cap")
            data = p.read_bytes()
        except OSError as e:
            return ToolError(kind="io_error", message=str(e))
        detected = _detect_image(data)
        if detected is None:
            return ToolError(kind="binary", message=f"{p} is not a supported image")
        fmt, width, height = detected
        digest = _sha256(p)
        meta = (
            f"path={p}\nformat={fmt}\nwidth={width}\nheight={height}\n"
            f"bytes={size}\nsha256={digest}\nverified=true"
        )
        if not vi.analyze:
            return ToolSuccess(content=meta)

        # vision analyze
        if size > self._vision_max_bytes:
            return ToolSuccess(content=(
                f"{meta}\n[analysis skipped] image size {size} bytes > "
                f"vision cap {self._vision_max_bytes}. resize 또는 호출자 명시 cap 상향 필요."
            ))
        mime = _FMT_TO_MIME.get(fmt, "image/png")
        prompt = vi.prompt or _DEFAULT_VISION_PROMPT
        try:
            client = self._get_vision_client()
        except Exception as e:
            return ToolSuccess(content=(
                f"{meta}\n[analysis unavailable] vision profile 로드 실패: "
                f"{type(e).__name__}: {e}"
            ))
        try:
            analysis = await _vision_analyze(client, prompt, data, mime)
        except Exception as e:
            return ToolSuccess(content=(
                f"{meta}\n[analysis error] {type(e).__name__}: {e}"
            ))
        return ToolSuccess(content=f"{meta}\n[analysis]\n{analysis}")


__all__ = ["ImageInspectTool", "ImageInspectInput"]
