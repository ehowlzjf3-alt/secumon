"""paste_cache 영속 layer.

설계:
- 사용자가 chat 으로 4KB 이상 메시지 보내면 server 가 paste_add(text) → short hex id.
- agent 가 python_exec 으로 state.paste_get(paste_id) 호출해 full content fetch.
- 원본 audit / replay 용으로 영속.
"""
from __future__ import annotations


def test_paste_add_returns_short_hex_id(tmp_db):
    from secu_agent import state
    pid = state.paste_add("hello world" * 1000)
    assert isinstance(pid, str)
    assert 6 <= len(pid) <= 32
    # alphanumeric
    assert pid.isalnum()


def test_paste_get_returns_original_text(tmp_db):
    from secu_agent import state
    body = "line1\nline2\n" + ("x" * 5000)
    pid = state.paste_add(body)
    got = state.paste_get(pid)
    assert got == body


def test_paste_get_unknown_returns_none(tmp_db):
    from secu_agent import state
    assert state.paste_get("nonexistent") is None


def test_paste_add_stores_metadata(tmp_db):
    from secu_agent import state
    body = "a\nb\nc\nd\ne"
    pid = state.paste_add(body)
    meta = state.paste_meta(pid)
    assert meta is not None
    assert meta["char_count"] == len(body)
    assert meta["line_count"] == 5
    assert meta["paste_id"] == pid
    assert meta["created_at"] > 0


def test_paste_add_different_texts_different_ids(tmp_db):
    from secu_agent import state
    a = state.paste_add("aaa")
    b = state.paste_add("bbb")
    assert a != b


def test_paste_get_blob_huge(tmp_db):
    """100KB 도 정상 round-trip."""
    from secu_agent import state
    body = "x" * 100_000
    pid = state.paste_add(body)
    got = state.paste_get(pid)
    assert got == body
