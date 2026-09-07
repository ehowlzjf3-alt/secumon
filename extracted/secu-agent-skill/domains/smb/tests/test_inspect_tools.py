"""smb_file_inspect sub-agent tools — 격리 컨텍스트, full body access."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest


def _ctx(metadata: dict, tmp_path: Path | None = None):
    from secu_agent.agent.tools.base import ToolContext
    return ToolContext(evidence_dir=tmp_path or Path("/tmp"), metadata=metadata)


def _invoke(tool, raw_input: dict, ctx):
    from secu_agent.agent.tools.base import ToolError
    from pydantic import ValidationError
    try:
        validated = type(tool).input_model.model_validate(raw_input)
    except ValidationError as e:
        return ToolError(kind="validation", message=str(e))
    return asyncio.run(tool.execute(validated, ctx))


# ============================================================
# ReadFileContentTool (sub-agent, full body access)
# ============================================================

def test_read_file_content_returns_lines_for_text(tmp_db, seed, monkeypatch):
    from secu_agent.agent.tools.base import ToolSuccess
    from domains.smb.plugin.tools.inspect_tools import ReadFileContentTool
    from domains.smb.plugin.agent_types import smb as smb_module

    sid = seed.share(host="1.2.3.4", share="A")
    fid = seed.file(sid, path="a/big.log", fetch_status="text", read=True)
    body = "\n".join(f"line {i}" for i in range(1, 1001))

    def fake_fetch(host, share, path, **kw):
        return ("text", body)
    monkeypatch.setattr(smb_module, "fetch_file", fake_fetch)

    tool = ReadFileContentTool()
    ctx = _ctx({
        "inspect_file_id": fid, "inspect_host": "1.2.3.4",
        "inspect_share": "A", "inspect_path": "a/big.log",
    })
    # sub-agent 는 master 의 read_file_quick 대비 더 큰 page (≤500)
    result = _invoke(tool, {"offset": 0, "limit": 500}, ctx)
    assert isinstance(result, ToolSuccess), getattr(result, "message", result)
    assert "UNTRUSTED INPUT BEGINS" in result.content
    assert "line 1" in result.content
    assert "line 500" in result.content
    assert "line 501" not in result.content


def test_read_file_content_caps_at_500(tmp_db, seed):
    from secu_agent.agent.tools.base import ToolError
    from domains.smb.plugin.tools.inspect_tools import ReadFileContentTool
    sid = seed.share(); fid = seed.file(sid)
    result = _invoke(ReadFileContentTool(),
                     {"offset": 0, "limit": 5000}, _ctx({"inspect_file_id": fid}))
    assert isinstance(result, ToolError)
    assert result.kind == "validation"


def test_read_file_content_requires_inspect_context(tmp_db):
    from secu_agent.agent.tools.base import ToolError
    from domains.smb.plugin.tools.inspect_tools import ReadFileContentTool
    result = _invoke(ReadFileContentTool(), {"offset": 0, "limit": 100}, _ctx({}))
    assert isinstance(result, ToolError)
    assert "inspect" in result.message.lower()


# ============================================================
# ReportInspectionTool (terminal — return summary to master)
# ============================================================

def test_report_inspection_persists_to_db_and_writes_result_file(tmp_db, seed, tmp_path):
    """report_inspection 호출:
    1) state.file_set_review 로 DB 결정 저장
    2) evidence_dir/inspection_result.json 작성 — delegate tool 이 read.
    """
    from service import state_domain as state
    from secu_agent.agent.tools.base import ToolSuccess
    from domains.smb.plugin.tools.inspect_tools import ReportInspectionTool

    sid = seed.share()
    fid = seed.file(sid, path="design.xlsx", fetch_status="binary", read=True)

    tool = ReportInspectionTool()
    ctx = _ctx({
        "inspect_file_id": fid,
        "inspect_question": "PII 가 들어있나?",
    }, tmp_path=tmp_path)
    result = _invoke(tool, {
        "answer": "본문 5KB 검토 결과 PII 없음. 부서 매출 dummy data.",
        "severity": "low",
        "key_evidence": ["row 32: '주문번호'", "row 44: 'YYYY-MM-DD'"],
        "tags": ["test_data"],
    }, ctx)
    assert isinstance(result, ToolSuccess), getattr(result, "message", result)

    # DB 영속화
    with state.connect() as c:
        row = c.execute("SELECT * FROM smb_file WHERE id=?", (fid,)).fetchone()
    assert row["review_status"] == "reviewed"
    assert row["review_severity"] == "low"
    # inspection_result.json 작성
    result_file = tmp_path / "inspection_result.json"
    assert result_file.exists()
    payload = json.loads(result_file.read_text())
    assert payload["file_id"] == fid
    assert payload["severity"] == "low"
    assert "본문 5KB" in payload["answer"]
    assert len(payload["key_evidence"]) == 2


def test_report_inspection_requires_inspect_context(tmp_db, tmp_path):
    from secu_agent.agent.tools.base import ToolError
    from domains.smb.plugin.tools.inspect_tools import ReportInspectionTool
    result = _invoke(ReportInspectionTool(),
                     {"answer": "x", "severity": "low"}, _ctx({}, tmp_path=tmp_path))
    assert isinstance(result, ToolError)


def test_report_inspection_validates_severity(tmp_db, seed, tmp_path):
    from secu_agent.agent.tools.base import ToolError
    from domains.smb.plugin.tools.inspect_tools import ReportInspectionTool
    sid = seed.share(); fid = seed.file(sid)
    result = _invoke(ReportInspectionTool(),
                     {"answer": "x", "severity": "extreme"},
                     _ctx({"inspect_file_id": fid}, tmp_path=tmp_path))
    assert isinstance(result, ToolError)
    assert result.kind == "validation"


# ============================================================
# registry
# ============================================================

def test_registry_for_smb_file_inspect_is_the_worker_toolset():
    """`smb_file_inspect` 도구셋은 **오늘 smb 워커의 것**이다 (Phase 1, 2026-08-20).

    구 등록은 파일 1개 단위 위임용 2종(ReadFileContentTool + ReportInspectionTool)이었다
    — v3.23 2단 구조의 잔재로, 계약도 agents/*.md 도 없어 도달 불가 상태로 남아 있었다.
    Phase 1 은 이 이름을 검토원으로 되살리는데, 게이트가 "오늘과 동등한 결과" 이므로
    도구를 줄이지 않는다. 축소는 Phase 2 에서 경계를 그을 때 측정하며 한다.

    bootstrap 은 import 만으로 프로세스 전역을 바꾸므로(dev_web browser-verified 등)
    격리 프로세스에서 확인한다 — 이 규약을 어겨 다른 테스트를 두 번 깨뜨렸다.
    """
    import json
    import os
    import subprocess
    import sys

    repo = str(Path(__file__).resolve().parents[3])
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [repo, env.get("PYTHONPATH", "")]).rstrip(os.pathsep)
    code = (
        "import json, plugin.bootstrap\n"
        "from secu_agent.agent.tools import build_registry_for_task\n"
        "print(json.dumps(sorted(t.name for t in "
        "build_registry_for_task('smb_file_inspect').all())))\n"
    )
    proc = subprocess.run([sys.executable, "-c", code], cwd=repo, env=env,
                          capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, proc.stderr
    names = set(json.loads(proc.stdout.strip().splitlines()[-1]))

    assert "smb_submit_finding" in names, "종료 도구가 없으면 워커가 끝낼 수 없다"
    assert "submit_finding" not in names, "코어 범용 submit 은 judge 디스패치를 안 탄다"
    assert len(names) > 2, f"구 2종 도구셋이 남아 있다: {sorted(names)}"


# ============================================================
# 큰 파일 — **받지 않는다** (2026-08-27)
#
# `fetch_file` 의 max_bytes 는 버퍼 상한이지 전송량이 아니다. 130MB tar 를 1MB 캡으로
# 부르면 130MB 를 받아 놓고 "binary" 한 줄을 돌려준다 — 검토원이 큰 파일을 "안 보고
# 버리는" 것처럼 보였던 이유다.
# ============================================================

_HUGE = 130 * 1024 * 1024


def _no_full_fetch(monkeypatch):
    """`fetch_file`(전송을 안 줄이는 쪽)을 부르면 즉시 실패시킨다."""
    from domains.smb.plugin.agent_types import smb as smb_module

    def boom(*a, **kw):
        raise AssertionError("큰 파일을 fetch_file 로 통째 요청했다")
    monkeypatch.setattr(smb_module, "fetch_file", boom)


def test_huge_file_uses_ranged_read_not_full_fetch(tmp_db, seed, monkeypatch):
    """★ 요점은 메시지가 아니라 **어느 경로로 읽었는가** 다."""
    from secu_agent.agent.tools.base import ToolSuccess
    from domains.smb.plugin.tools.inspect_tools import ReadFileContentTool
    from domains.smb.plugin.agent_types import smb as smb_module

    sid = seed.share(host="1.2.3.4", share="A")
    fid = seed.file(sid, path="a/huge.log", size=_HUGE)
    _no_full_fetch(monkeypatch)

    seen = {}

    def ranged(host, share, path, *, offset, length):
        seen["offset"], seen["length"] = offset, length
        return smb_module.SmbFileBytes(
            status="bytes", data=b"line one\nline two\n", size=18)
    monkeypatch.setattr(smb_module, "fetch_file_range", ranged)

    result = _invoke(ReadFileContentTool(), {"offset": 0, "limit": 200}, _ctx({
        "inspect_file_id": fid, "inspect_host": "1.2.3.4",
        "inspect_share": "A", "inspect_path": "a/huge.log",
    }))
    assert isinstance(result, ToolSuccess), getattr(result, "message", result)
    assert seen == {"offset": 0, "length": 1024 * 1024}, seen
    # ★ 거부가 아니다 — 앞부분은 실제로 보여준다.
    assert "line one" in result.content
    # 그리고 잘렸다는 사실을 밝힌다.
    assert "130MB" in result.content and "확인하지 않았다" in result.content


def test_huge_archive_points_at_the_index_tool(tmp_db, seed, monkeypatch):
    from domains.smb.plugin.tools.inspect_tools import ReadFileContentTool
    from domains.smb.plugin.agent_types import smb as smb_module

    sid = seed.share(host="1.2.3.4", share="A")
    fid = seed.file(sid, path="pkg/AB12.tar", size=_HUGE)
    _no_full_fetch(monkeypatch)
    monkeypatch.setattr(smb_module, "fetch_file_range",
                        lambda *a, **kw: smb_module.SmbFileBytes(
                            status="bytes", data=b"\x00\x01\x02binary", size=10))
    result = _invoke(ReadFileContentTool(), {"offset": 0, "limit": 200}, _ctx({
        "inspect_file_id": fid, "inspect_host": "1.2.3.4",
        "inspect_share": "A", "inspect_path": "pkg/AB12.tar",
    }))
    assert "inspect_archive_index" in result.content


def test_huge_gzip_says_why_it_cannot(tmp_db, seed, monkeypatch):
    """못 하는 것은 못 한다고 말한다 — 그래야 '문제 없음'으로 안 접힌다."""
    from domains.smb.plugin.tools.inspect_tools import ReadFileContentTool
    from domains.smb.plugin.agent_types import smb as smb_module

    sid = seed.share(host="1.2.3.4", share="A")
    fid = seed.file(sid, path="pkg/x.tar.gz", size=_HUGE)
    _no_full_fetch(monkeypatch)
    monkeypatch.setattr(smb_module, "fetch_file_range",
                        lambda *a, **kw: smb_module.SmbFileBytes(
                            status="bytes", data=b"\x1f\x8b\x08\x00binary", size=12))
    result = _invoke(ReadFileContentTool(), {"offset": 0, "limit": 200}, _ctx({
        "inspect_file_id": fid, "inspect_host": "1.2.3.4",
        "inspect_share": "A", "inspect_path": "pkg/x.tar.gz",
    }))
    assert "원리적으로 불가" in result.content
    assert "못 봤다고" in result.content


def test_small_file_still_reads_normally(tmp_db, seed, monkeypatch):
    """상한이 정상 경로를 막으면 안 된다."""
    from domains.smb.plugin.tools.inspect_tools import ReadFileContentTool
    from domains.smb.plugin.agent_types import smb as smb_module

    sid = seed.share(host="1.2.3.4", share="A")
    fid = seed.file(sid, path="a/small.log", size=2048, fetch_status="text", read=True)
    monkeypatch.setattr(smb_module, "fetch_file", lambda *a, **kw: ("text", "hello\nworld\n"))
    result = _invoke(ReadFileContentTool(), {"offset": 0, "limit": 200}, _ctx({
        "inspect_file_id": fid, "inspect_host": "1.2.3.4",
        "inspect_share": "A", "inspect_path": "a/small.log",
    }))
    assert "hello" in result.content


# ============================================================
# InspectArchiveIndexTool
# ============================================================

def test_inspect_archive_index_is_registered():
    """도구가 검토원 화이트리스트에 없으면 계약만 있고 손이 없다."""
    from domains.smb.plugin.toolsets import smb_file_inspect_tools
    assert "inspect_archive_index" in {t.name for t in smb_file_inspect_tools()}


def test_inspect_archive_index_refuses_without_opening_a_session(monkeypatch):
    """★ 못 하는 형식에 로그인하면 lockout 예산만 먹는다."""
    from domains.smb.plugin.tools.inspect_tools import InspectArchiveIndexTool
    from domains.smb.plugin.agent_types import smb as smb_module

    def boom(*a, **kw):
        raise AssertionError("세션을 열었다")
    monkeypatch.setattr(smb_module, "open_session", boom)

    result = _invoke(InspectArchiveIndexTool(), {}, _ctx({
        "inspect_host": "1.2.3.4", "inspect_share": "A", "inspect_path": "x.7z",
    }))
    assert "목차 불가" in result.content


def test_inspect_archive_index_needs_context():
    from secu_agent.agent.tools.base import ToolError
    from domains.smb.plugin.tools.inspect_tools import InspectArchiveIndexTool
    result = _invoke(InspectArchiveIndexTool(), {}, _ctx({}))
    assert isinstance(result, ToolError)
