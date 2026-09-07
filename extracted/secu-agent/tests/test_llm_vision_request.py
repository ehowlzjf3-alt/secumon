"""v3.43-V1: LLM multimodal (vision) content block + OpenAI request 변환.

UserMessage 가 ImageBlock 을 포함하면 OpenAI 형식의 multimodal content array
(`[{type:text,text:...}, {type:image_url,image_url:{url:'data:...'}}]`) 로 변환.
text-only 메시지는 기존 string content 유지 (back-compat).
"""
from __future__ import annotations

import base64

from secu_agent.agent.llm.internal_gateway import _to_openai_messages
from secu_agent.agent.llm.messages import (
    ImageBlock,
    SystemMessage,
    TextBlock,
    UserMessage,
)


def _b64_png_1px() -> str:
    return base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16).decode()


def test_text_only_user_message_stays_string_content():
    msgs = _to_openai_messages(
        [UserMessage(content=[TextBlock(text="hello")])],
        system=None,
    )
    assert msgs == [{"role": "user", "content": "hello"}]


def test_image_block_produces_multimodal_array():
    data_b64 = _b64_png_1px()
    msg = UserMessage(content=[
        TextBlock(text="이 스크린샷에서 sensitive 정보 있어?"),
        ImageBlock(media_type="image/png", data_b64=data_b64),
    ])
    out = _to_openai_messages([msg], system=None)
    assert len(out) == 1
    user = out[0]
    assert user["role"] == "user"
    assert isinstance(user["content"], list)
    types = [p["type"] for p in user["content"]]
    assert types == ["text", "image_url"]
    assert user["content"][0]["text"] == "이 스크린샷에서 sensitive 정보 있어?"
    image_url = user["content"][1]["image_url"]["url"]
    assert image_url.startswith("data:image/png;base64,")
    assert image_url.endswith(data_b64)


def test_multiple_images_all_appended():
    b64a, b64b = _b64_png_1px(), _b64_png_1px()
    msg = UserMessage(content=[
        TextBlock(text="두 장 비교해줘"),
        ImageBlock(media_type="image/png", data_b64=b64a),
        ImageBlock(media_type="image/jpeg", data_b64=b64b),
    ])
    out = _to_openai_messages([msg], system=None)
    parts = out[0]["content"]
    assert len(parts) == 3
    assert parts[1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert parts[2]["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_image_block_alone_no_text_still_valid_array():
    msg = UserMessage(content=[
        ImageBlock(media_type="image/png", data_b64=_b64_png_1px()),
    ])
    out = _to_openai_messages([msg], system=None)
    parts = out[0]["content"]
    # text 없어도 array 가 만들어지고 image 1개 포함
    assert len(parts) == 1
    assert parts[0]["type"] == "image_url"


def test_system_message_unaffected_by_image_path():
    out = _to_openai_messages(
        [SystemMessage(text="sys note")],
        system=None,
    )
    assert out == [{"role": "system", "content": "sys note"}]


def test_image_block_constructor_validates_media_type():
    blk = ImageBlock(media_type="image/png", data_b64="AAAA")
    # 잘 만들어지면 OK — type 필드도 자동
    assert blk.media_type == "image/png"
    assert blk.data_b64 == "AAAA"
    assert getattr(blk, "type", "image") == "image"
