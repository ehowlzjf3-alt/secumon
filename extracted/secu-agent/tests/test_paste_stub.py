"""paste_stub.maybe_stub — short text 는 그대로, long text 는 paste_add + stub 으로 변환.

WS handler 가 사용자 메시지 받을 때 호출. agent / DB 에는 stub 만 보냄.
"""
from __future__ import annotations


def test_short_text_passes_through(tmp_db):
    from secu_agent.agent.paste_stub import maybe_stub
    stub, pid = maybe_stub("짧은 명령", threshold=4000)
    assert stub == "짧은 명령"
    assert pid is None


def test_long_text_creates_paste_and_returns_stub(tmp_db):
    from secu_agent import state
    from secu_agent.agent.paste_stub import maybe_stub
    text = "\n".join(f"198.51.100.{i}.0/24" for i in range(500))
    stub, pid = maybe_stub(text, threshold=4000)
    assert pid is not None
    # paste_get 으로 원본 fetch 가능
    assert state.paste_get(pid) == text
    # stub 안에 메타정보
    assert "paste_id" in stub
    assert pid in stub
    # 길이 / 줄 수
    assert "500" in stub  # line count
    assert "cidr" in stub  # format hint
    # python_exec 안내
    assert "python_exec" in stub or "paste_get" in stub
    # 짧음
    assert len(stub) < 2000


def test_stub_has_preview_and_tail(tmp_db):
    from secu_agent.agent.paste_stub import maybe_stub
    text = "HEAD_LINE\n" + ("\n".join(f"middle{i}" for i in range(200))) + "\nTAIL_LINE"
    stub, pid = maybe_stub(text, threshold=100)
    assert pid is not None
    assert "HEAD_LINE" in stub
    assert "TAIL_LINE" in stub


def test_stub_without_format_hint_when_natural_language(tmp_db):
    from secu_agent.agent.paste_stub import maybe_stub
    text = ("이것은 그냥 한국어 자연어로 작성된 매우 긴 명령 메시지입니다. " * 200)
    stub, pid = maybe_stub(text, threshold=1000)
    assert pid is not None
    # 자연어 — format hint 없거나 unknown
    assert "format hint:" not in stub or "unknown" in stub or "(0%)" in stub


def test_stub_default_threshold(tmp_db):
    """default threshold 는 4000 chars."""
    from secu_agent.agent.paste_stub import maybe_stub
    short = "a" * 100
    stub_s, pid_s = maybe_stub(short)
    assert pid_s is None and stub_s == short

    long = "a" * 5000
    stub_l, pid_l = maybe_stub(long)
    assert pid_l is not None
