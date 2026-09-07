"""열람량은 **코드가 센다** — 검토원에게 묻지 않는다.

## 왜 (2026-08-28 실측)

`report_inspection` 의 `files_seen`/`bytes_seen` 은 **145회 중 0회 전달**됐고
읽는 코드도 0개였다. LLM 에게 셀 이유가 없는 숫자를 자기신고하라고 시킨 것이
원인이다 — 이 저장소 원칙은 "찾기는 코드가, 판정은 LLM 이" 다.

그 사이 `clean` 판정 131건 중 **56건(43%)이 파일을 한 번도 안 연 세션**에서 나왔다.
목록만 보고 "깨끗함" 이라고 말한 것이다.

⚠️ 판정을 덮어쓰지는 **않는다.** 판정은 LLM 이 한다. 다만 아무것도 안 열고
   clean 이라고 하면 그 사실이 보고에 박히고 검토원에게도 되돌아간다.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from _shared import inspector_report as ir


class _Ctx:
    def __init__(self, tmp_path):
        self.evidence_dir = tmp_path
        self.metadata: dict = {}


def _report(ctx, verdict="clean", **kw):
    vi = ir.ReportInspectionInput(verdict=verdict, narrative="봤다", **kw)
    return asyncio.run(ir.ReportInspectionTool().execute(vi, ctx))


def _saved(tmp_path) -> dict:
    return json.loads((tmp_path / ir.REPORT_FILENAME).read_text(encoding="utf-8"))


def test_tally_starts_empty_and_accumulates(tmp_path):
    ctx = _Ctx(tmp_path)
    assert ir.read_tally(ctx) == {"files": 0, "bytes": 0}
    ir.record_read(ctx, files=3, read_bytes=100)
    ir.record_read(ctx, files=2, read_bytes=50)
    assert ir.read_tally(ctx) == {"files": 5, "bytes": 150}


def test_tally_never_raises_on_a_context_without_metadata():
    ir.record_read(object(), files=1, read_bytes=1)      # 예외 없이 지나가야 한다
    assert ir.read_tally(object()) == {"files": 0, "bytes": 0}


def test_looked_at_comes_from_code_not_from_the_inspector(tmp_path):
    """★ 자기신고가 계측을 덮으면 안 된다."""
    ctx = _Ctx(tmp_path)
    ir.record_read(ctx, files=7, read_bytes=999)
    _report(ctx, verdict="confirmed", files_seen=12345, bytes_seen=6789)
    saved = _saved(tmp_path)
    assert saved["looked_at"] == {"files": 7, "bytes": 999, "source": "code"}
    # 검토원이 준 값은 참고로만 남는다.
    assert saved["claimed_looked_at"] == {"files": 12345, "bytes": 6789}


def test_clean_without_reading_is_marked_and_told_to_the_inspector(tmp_path):
    """★ 목록만 보고 '깨끗함' 이라고 한 사실이 남는다."""
    ctx = _Ctx(tmp_path)
    result = _report(ctx, verdict="clean")
    saved = _saved(tmp_path)
    assert saved["clean_without_reading"] is True
    assert saved["looked_at"]["files"] == 0
    body = json.loads(result.content)
    assert "warning" in body
    assert "파일을 하나도 열지 않았다" in body["warning"]


def test_clean_after_reading_is_not_marked(tmp_path):
    ctx = _Ctx(tmp_path)
    ir.record_read(ctx, files=4, read_bytes=1024)
    result = _report(ctx, verdict="clean")
    saved = _saved(tmp_path)
    assert "clean_without_reading" not in saved
    assert "warning" not in json.loads(result.content)


@pytest.mark.parametrize("verdict", ["suspicious", "confirmed", "blocked"])
def test_only_clean_gets_the_unread_warning(tmp_path, verdict):
    """`blocked` 는 못 읽었다는 판정 자체다 — 경고가 붙으면 소음이다."""
    ctx = _Ctx(tmp_path)
    _report(ctx, verdict=verdict)
    assert "clean_without_reading" not in _saved(tmp_path)


def test_the_verdict_is_never_overwritten(tmp_path):
    """판정은 LLM 이 한다 — 계측이 판정을 바꾸지 않는다."""
    ctx = _Ctx(tmp_path)
    _report(ctx, verdict="clean")
    assert _saved(tmp_path)["verdict"] == "clean"
