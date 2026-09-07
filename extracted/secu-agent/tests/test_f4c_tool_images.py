"""F4-C: 이미지-운반 tool result — 엔진이 ToolSuccess.images 를 tool-result 직후 user
이미지 파트로 주입(비전 되먹임). 턴당 총 base64 바이트 cap 으로 컨텍스트 보호.
"""
from __future__ import annotations

from secu_agent.agent import engine
from secu_agent.agent.engine import _append_tool_images, _tool_image_cap_bytes
from secu_agent.agent.llm.messages import ImageBlock, ToolResultBlock, ToolUseBlock
from secu_agent.agent.tools.base import ToolImage, ToolSuccess


def _img(n: int) -> ToolImage:
    return ToolImage(media_type="image/png", data_b64="A" * n)


def _call(cid: str) -> ToolUseBlock:
    return ToolUseBlock(id=cid, name="browser_query", input={})


# ── cap 헬퍼 ────────────────────────────────────────────────────────────────

def test_cap_default(monkeypatch):
    monkeypatch.delenv("SA_TOOL_IMAGE_MAX_BYTES", raising=False)
    assert _tool_image_cap_bytes() == 4 * 1024 * 1024


def test_cap_env_override(monkeypatch):
    monkeypatch.setenv("SA_TOOL_IMAGE_MAX_BYTES", "1000")
    assert _tool_image_cap_bytes() == 1000


def test_cap_invalid_falls_back(monkeypatch):
    monkeypatch.setenv("SA_TOOL_IMAGE_MAX_BYTES", "nope")
    assert _tool_image_cap_bytes() == 4 * 1024 * 1024


def test_cap_negative_is_zero(monkeypatch):
    monkeypatch.setenv("SA_TOOL_IMAGE_MAX_BYTES", "-5")
    assert _tool_image_cap_bytes() == 0


# ── _append_tool_images ─────────────────────────────────────────────────────

def test_no_images_leaves_blocks_unchanged(monkeypatch):
    monkeypatch.delenv("SA_TOOL_IMAGE_MAX_BYTES", raising=False)
    blocks = [ToolResultBlock(tool_use_id="c1", content="ok")]
    _append_tool_images(blocks, [_call("c1")], {})
    assert len(blocks) == 1
    assert all(isinstance(b, ToolResultBlock) for b in blocks)


def test_images_appended_as_imageblocks(monkeypatch):
    monkeypatch.delenv("SA_TOOL_IMAGE_MAX_BYTES", raising=False)
    blocks = [ToolResultBlock(tool_use_id="c1", content="shot saved")]
    _append_tool_images(blocks, [_call("c1")], {"c1": (_img(100),)})
    imgs = [b for b in blocks if isinstance(b, ImageBlock)]
    assert len(imgs) == 1
    assert imgs[0].media_type == "image/png"
    # tool-result 는 이미지 앞에 온다(순서: result → image).
    assert isinstance(blocks[0], ToolResultBlock)
    assert isinstance(blocks[-1], ImageBlock)


def test_cap_drops_images_over_budget(monkeypatch):
    monkeypatch.setenv("SA_TOOL_IMAGE_MAX_BYTES", "150")
    blocks = [ToolResultBlock(tool_use_id="c1", content="x")]
    # 100 + 100 = 200 > 150 → 첫 이미지만 실림(둘째는 드롭).
    _append_tool_images(blocks, [_call("c1")], {"c1": (_img(100), _img(100))})
    imgs = [b for b in blocks if isinstance(b, ImageBlock)]
    assert len(imgs) == 1


def test_cap_zero_disables(monkeypatch):
    monkeypatch.setenv("SA_TOOL_IMAGE_MAX_BYTES", "0")
    blocks = [ToolResultBlock(tool_use_id="c1", content="x")]
    _append_tool_images(blocks, [_call("c1")], {"c1": (_img(100),)})
    assert not any(isinstance(b, ImageBlock) for b in blocks)


def test_images_ordered_by_tool_calls(monkeypatch):
    monkeypatch.delenv("SA_TOOL_IMAGE_MAX_BYTES", raising=False)
    blocks = [
        ToolResultBlock(tool_use_id="c1", content="a"),
        ToolResultBlock(tool_use_id="c2", content="b"),
    ]
    _append_tool_images(
        blocks, [_call("c1"), _call("c2")],
        {"c1": (_img(10),), "c2": (_img(20),)},
    )
    imgs = [b for b in blocks if isinstance(b, ImageBlock)]
    assert len(imgs) == 2
    assert len(imgs[0].data_b64) == 10 and len(imgs[1].data_b64) == 20


# ── 클라이언트 직렬화: mixed UserMessage(ToolResultBlock + ImageBlock) ──────────

def test_openai_client_serializes_toolresult_then_image():
    from secu_agent.agent.llm.internal_gateway import _user_to_openai
    from secu_agent.agent.llm.messages import UserMessage

    msg = UserMessage(content=[
        ToolResultBlock(tool_use_id="c1", content="shot"),
        ImageBlock(media_type="image/png", data_b64="AAAA"),
    ])
    out = _user_to_openai(msg)
    # tool 메시지 먼저, 그다음 image_url user 메시지.
    assert out[0]["role"] == "tool" and out[0]["tool_call_id"] == "c1"
    assert out[-1]["role"] == "user"
    parts = out[-1]["content"]
    assert any(p.get("type") == "image_url" for p in parts)


# ── C3: 보존 / positional ──────────────────────────────────────────────────

def test_toolsuccess_positional_type_preserved():
    # C3b: images 를 type 뒤에 둬 positional (content, type) 호출이 안 깨진다.
    s = ToolSuccess("ok", "success")
    assert s.content == "ok" and s.type == "success" and s.images == ()


def test_guardrail_decision_preserves_images():
    # C3a: 가드레일 note 를 붙여도 images 유지.
    from secu_agent.agent.engine import _append_guardrail_decision
    from secu_agent.agent.tool_guardrails import ToolGuardrailDecision
    from secu_agent.agent.tools.base import ToolContext
    from pathlib import Path
    import tempfile

    res = ToolSuccess("shot", images=(_img(20),))
    dec = ToolGuardrailDecision(action="warn", code="x", message="dup")
    ctx = ToolContext(evidence_dir=Path(tempfile.gettempdir()))
    out = _append_guardrail_decision(res, dec, ctx)
    assert isinstance(out, ToolSuccess)
    assert len(out.images) == 1  # 이미지 보존
    assert "dup" in out.content


# ── C4: 히스토리 이미지 가지치기 ──────────────────────────────────────────────

def _um(*blocks):
    from secu_agent.agent.llm.messages import UserMessage
    return UserMessage(content=list(blocks))


def _im(tag):
    return ImageBlock(media_type="image/png", data_b64=tag)


def test_prune_history_keeps_last_n_prior_and_current():
    from secu_agent.agent.engine import _prune_history_images
    from secu_agent.agent.llm.messages import TextBlock

    msgs = [_um(_im("1")), _um(_im("2")), _um(_im("3")), _um(_im("4"))]
    _prune_history_images(msgs, keep_last=2)  # 현재("4") 보존 + prior 최근 2("2","3")
    imgs = [b for m in msgs for b in m.content if isinstance(b, ImageBlock)]
    assert {b.data_b64 for b in imgs} == {"2", "3", "4"}
    # 가장 오래된 prior("1")은 텍스트 치환.
    assert any(
        isinstance(b, TextBlock) and "생략" in b.text
        for m in msgs for b in m.content
    )


def test_prune_preserves_current_round_multi_images():
    # D2: 한 라운드에 keep_last 초과 이미지를 넣어도 현재 라운드는 전부 보존.
    from secu_agent.agent.engine import _prune_history_images

    msgs = [_um(_im("a"), _im("b"), _im("c"))]  # 전부 현재 라운드(마지막 메시지)
    _prune_history_images(msgs, keep_last=1)
    imgs = [b for m in msgs for b in m.content if isinstance(b, ImageBlock)]
    assert len(imgs) == 3  # 현재 라운드는 안 가지침


def test_prune_history_noop_when_under_keep():
    from secu_agent.agent.engine import _prune_history_images

    msgs = [_um(_im("1"))]
    _prune_history_images(msgs, keep_last=2)
    imgs = [b for m in msgs for b in m.content if isinstance(b, ImageBlock)]
    assert len(imgs) == 1


def test_prune_history_keep_zero_strips_prior_keeps_current():
    from secu_agent.agent.engine import _prune_history_images

    msgs = [_um(_im("old")), _um(_im("cur"))]  # prior + 현재
    _prune_history_images(msgs, keep_last=0)
    imgs = [b for m in msgs for b in m.content if isinstance(b, ImageBlock)]
    assert {b.data_b64 for b in imgs} == {"cur"}  # prior 제거, 현재 유지
