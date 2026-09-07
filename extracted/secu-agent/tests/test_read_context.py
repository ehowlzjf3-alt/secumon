"""v3.51-H4: read_context dedup state tests."""
from __future__ import annotations

import time
from pathlib import Path

from secu_agent.agent.read_context import (
    READ_STATE_KEY,
    READ_STATE_MAX_ENTRIES,
    check_unchanged_read,
    clear_read_state,
    forget_read_path,
    record_read,
    unchanged_read_stub,
)


def _mk_file(tmp_path: Path, name: str, content: str = "hello") -> Path:
    p = tmp_path / name
    p.write_text(content, encoding="utf-8")
    return p


def test_check_unchanged_returns_none_when_not_recorded(tmp_path):
    md: dict = {}
    p = _mk_file(tmp_path, "a.txt")
    assert check_unchanged_read(md, p, offset=0, limit=100) is None


def test_record_then_check_returns_hit(tmp_path):
    md: dict = {}
    p = _mk_file(tmp_path, "a.txt")
    record_read(md, p, offset=0, limit=100, total_lines=1, returned_chars=5)
    hit = check_unchanged_read(md, p, offset=0, limit=100)
    assert hit is not None
    assert hit.path == str(p)
    assert hit.offset == 0
    assert hit.total_lines == 1


def test_modified_file_invalidates_hit(tmp_path):
    md: dict = {}
    p = _mk_file(tmp_path, "a.txt", content="hello")
    record_read(md, p, offset=0, limit=100, total_lines=1, returned_chars=5)
    # mtime 진짜 변경되게 약간 sleep
    time.sleep(0.01)
    p.write_text("longer hello world", encoding="utf-8")
    hit = check_unchanged_read(md, p, offset=0, limit=100)
    assert hit is None
    # 그리고 stale entry 가 state 에서 제거됐어야
    state = md.get(READ_STATE_KEY)
    assert state is not None
    assert len(state) == 0


def test_different_offset_no_hit(tmp_path):
    md: dict = {}
    p = _mk_file(tmp_path, "a.txt")
    record_read(md, p, offset=0, limit=100, total_lines=1, returned_chars=5)
    assert check_unchanged_read(md, p, offset=50, limit=100) is None


def test_clear_read_state_drops_everything(tmp_path):
    md: dict = {}
    p = _mk_file(tmp_path, "a.txt")
    record_read(md, p, offset=0, limit=100, total_lines=1, returned_chars=5)
    clear_read_state(md)
    assert READ_STATE_KEY not in md


def test_forget_read_path_drops_only_matching(tmp_path):
    md: dict = {}
    p1 = _mk_file(tmp_path, "a.txt")
    p2 = _mk_file(tmp_path, "b.txt")
    record_read(md, p1, offset=0, limit=100, total_lines=1, returned_chars=5)
    record_read(md, p2, offset=0, limit=100, total_lines=1, returned_chars=5)
    forget_read_path(md, p1)
    assert check_unchanged_read(md, p1, offset=0, limit=100) is None
    assert check_unchanged_read(md, p2, offset=0, limit=100) is not None


def test_lru_eviction_at_max_entries(tmp_path):
    md: dict = {}
    p = _mk_file(tmp_path, "a.txt")
    # MAX + 5 만큼 record — 다른 offset 으로
    for i in range(READ_STATE_MAX_ENTRIES + 5):
        record_read(md, p, offset=i, limit=10, total_lines=1, returned_chars=1)
    state = md[READ_STATE_KEY]
    assert len(state) == READ_STATE_MAX_ENTRIES
    # 가장 오래된 (offset=0~4) 는 떨어졌어야
    assert check_unchanged_read(md, p, offset=0, limit=10) is None
    # 최근 건 살아있음
    assert check_unchanged_read(md, p, offset=READ_STATE_MAX_ENTRIES, limit=10) is not None


def test_unchanged_stub_message(tmp_path):
    md: dict = {}
    p = _mk_file(tmp_path, "a.txt")
    record_read(md, p, offset=0, limit=100, total_lines=1, returned_chars=5)
    hit = check_unchanged_read(md, p, offset=0, limit=100)
    assert hit is not None
    stub = unchanged_read_stub(hit)
    assert "unchanged" in stub
    assert str(p) in stub
