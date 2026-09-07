"""v3.42 F2: repeat_error helper unit tests."""
from __future__ import annotations

from secu_agent.agent.repeat_error import (
    HALT_THRESHOLD,
    RepeatErrorState,
    build_halt_message,
    extract_error_signature,
)
from secu_agent.agent.tools.base import ToolError, ToolSuccess


def test_extract_signature_for_tool_error():
    sig = extract_error_signature(
        "smb_python",
        ToolError(kind="execution", message="something went wrong"),
    )
    assert sig is not None
    assert "smb_python" in sig
    assert "execution" in sig
    assert "something went wrong" in sig


def test_extract_signature_for_traceback_in_success_content():
    # smb_python 의 실제 sandbox-style 에러 출력 (msg 532 와 동형)
    content = (
        "[error]\nTraceback (most recent call last):\n"
        "  File \"<string>\", line 34, in <module>\n"
        "AttributeError: 'Hit' object has no attribute 'preview'"
    )
    sig = extract_error_signature("smb_python", ToolSuccess(content=content))
    assert sig is not None
    assert "AttributeError" in sig
    assert "preview" in sig


def test_extract_signature_normal_success_returns_none():
    sig = extract_error_signature("foo", ToolSuccess(content="all good {result: 42}"))
    assert sig is None


def test_state_update_same_signature_triggers_halt():
    st = RepeatErrorState()
    sig = "smb_python|exc:AttributeError|'Hit' object has no attribute 'preview'"
    assert st.update(sig) is False  # 1회
    assert st.update(sig) is True   # 2회 → halt
    assert st.count == HALT_THRESHOLD


def test_state_update_different_signature_resets_count():
    st = RepeatErrorState()
    st.update("smb_python|err:execution|A")
    st.update("smb_python|err:execution|B")
    assert st.count == 1     # 다른 signature → reset 됐다가 1
    assert st.last_signature.endswith("B")


def test_state_update_success_resets_counter():
    st = RepeatErrorState()
    st.update("smb_python|err:execution|A")
    st.update(None)   # 정상 호출
    assert st.count == 0
    assert st.last_signature is None


def test_metadata_roundtrip():
    metadata: dict = {}
    st = RepeatErrorState.from_metadata(metadata)
    assert st.count == 0
    st.update("x|err:y|z")
    st.write_to(metadata)
    st2 = RepeatErrorState.from_metadata(metadata)
    assert st2.last_signature == "x|err:y|z"
    assert st2.count == 1


def test_build_halt_message_mentions_tool_and_msg():
    msg = build_halt_message(
        "smb_python|exc:AttributeError|'Hit' object has no attribute 'preview'"
    )
    assert "smb_python" in msg
    assert "preview" in msg
    assert str(HALT_THRESHOLD) in msg
