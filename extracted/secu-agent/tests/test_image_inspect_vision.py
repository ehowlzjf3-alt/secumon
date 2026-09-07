"""v3.43-V2: image_inspect analyze=True — vision LLM call.

기본 metadata 만 모드는 그대로. analyze=True 면 SA_VISION_PROFILE (default 'gaussO4')
의 vision-capable LLM 으로 호출 → 분석 결과 텍스트를 result 에 append.

테스트는 vision LLM 을 mock — `_make_vision_client` 가 _build 로 inject 가능.
"""
from __future__ import annotations

import asyncio
import base64
import struct
import zlib
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import ImageBlock, TextBlock, UserMessage
from secu_agent.agent.llm.types import (
    LLMRequest, StreamMessageStop, StreamTextDelta, StreamUsage,
)
from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess
from secu_agent.agent.tools.image_tools import (
    ImageInspectInput, ImageInspectTool,
)


def _write_png_1px(path: Path) -> None:
    # minimal valid PNG: 1x1 white pixel
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = b"IHDR" + struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    ihdr_chunk = struct.pack(">I", 13) + ihdr + struct.pack(">I", zlib.crc32(ihdr))
    raw = b"\x00\xff\xff\xff"
    comp = zlib.compress(raw)
    idat = b"IDAT" + comp
    idat_chunk = struct.pack(">I", len(comp)) + idat + struct.pack(">I", zlib.crc32(idat))
    iend = b"IEND"
    iend_chunk = struct.pack(">I", 0) + iend + struct.pack(">I", zlib.crc32(iend))
    path.write_bytes(sig + ihdr_chunk + idat_chunk + iend_chunk)


class _FakeVisionLLM(LLMClient):
    """analyze 모드 검증용 mock — image block 받았는지 확인."""

    def __init__(self, reply: str = "이미지에 sensitive 정보 발견 안 됨."):
        self._reply = reply
        self.requests: list[LLMRequest] = []

    @property
    def name(self) -> str:
        return "fake-vision"

    async def stream(self, request: LLMRequest) -> AsyncIterator:
        self.requests.append(request)
        yield StreamTextDelta(text=self._reply)
        yield StreamMessageStop(
            stop_reason="end_turn",
            usage=StreamUsage(input_tokens=10, output_tokens=5),
        )


def _run(coro):
    return asyncio.run(coro)


def test_image_inspect_no_analyze_returns_metadata_only(tmp_path):
    """default analyze=False — vision 호출 없이 metadata 만."""
    p = tmp_path / "shot.png"
    _write_png_1px(p)
    tool = ImageInspectTool()
    res = _run(tool.execute(
        ImageInspectInput(path=str(p)),
        ToolContext(evidence_dir=tmp_path),
    ))
    assert isinstance(res, ToolSuccess)
    assert "format=png" in res.content
    assert "width=1" in res.content
    # analysis 영역 없음
    assert "[analysis]" not in res.content


def test_image_inspect_analyze_invokes_vision_llm_with_image(tmp_path):
    """analyze=True → vision LLM 호출. request 에 ImageBlock 포함."""
    p = tmp_path / "shot.png"
    _write_png_1px(p)
    client = _FakeVisionLLM(reply="screenshot 에 PII 없음, 메뉴 화면.")
    tool = ImageInspectTool(vision_client=client)
    res = _run(tool.execute(
        ImageInspectInput(path=str(p), analyze=True),
        ToolContext(evidence_dir=tmp_path),
    ))
    assert isinstance(res, ToolSuccess), f"got {res!r}"
    assert "format=png" in res.content
    assert "[analysis]" in res.content
    assert "screenshot 에 PII 없음" in res.content

    # LLM request 의 message 에 ImageBlock 들어갔는지
    assert len(client.requests) == 1
    msg = client.requests[0].messages[0]
    blocks_of_image = [b for b in msg.content if isinstance(b, ImageBlock)]
    assert len(blocks_of_image) == 1
    assert blocks_of_image[0].media_type == "image/png"


def test_image_inspect_analyze_custom_prompt(tmp_path):
    """analyze=True + prompt — 사용자 지정 prompt 사용."""
    p = tmp_path / "shot.png"
    _write_png_1px(p)
    client = _FakeVisionLLM()
    tool = ImageInspectTool(vision_client=client)
    _run(tool.execute(
        ImageInspectInput(
            path=str(p), analyze=True,
            prompt="이 화면에 자격증명 입력 폼 있는지만 yes/no 로 보고.",
        ),
        ToolContext(evidence_dir=tmp_path),
    ))
    msg = client.requests[0].messages[0]
    text_blocks = [b for b in msg.content if isinstance(b, TextBlock)]
    assert text_blocks
    assert "yes/no" in text_blocks[0].text


def test_image_inspect_analyze_too_large_skips_vision(tmp_path):
    """이미지가 너무 크면 vision 호출 안 함 (cost guard) — 그래도 metadata 반환."""
    p = tmp_path / "big.png"
    _write_png_1px(p)
    # vision 직전 inline cap: 2MB. 1px PNG 는 small 이라 cap 통과 — 별도로 cap 검사를
    # 위해 cap 자체를 0 으로 override 해서 negative path 검증.
    client = _FakeVisionLLM()
    tool = ImageInspectTool(vision_client=client, vision_max_bytes=10)  # 임의 작은 cap
    res = _run(tool.execute(
        ImageInspectInput(path=str(p), analyze=True),
        ToolContext(evidence_dir=tmp_path),
    ))
    assert isinstance(res, ToolSuccess)
    assert "format=png" in res.content
    # vision skip 노트 들어가야
    assert "[analysis skipped]" in res.content
    assert client.requests == []  # 호출 안 됨
