"""Image artifact inspection tool."""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path


from service import state_domain as state
from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess
from secu_agent.agent.tools.image_tools import ImageInspectTool
from domains.smb.plugin.tools.smb_tools import SmbInspectImageTool, SmbInspectPdfTool
from domains.smb.plugin.agent_types import smb as smb_mod


_PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lQn3ygAAAABJRU5ErkJggg=="
)


def _ctx(tmp_path: Path) -> ToolContext:
    return ToolContext(evidence_dir=tmp_path, metadata={"charter_ref": "TH-TEST-001"})


def _run(payload, ctx):
    tool = ImageInspectTool()
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def test_image_inspect_png_dimensions_and_hash(tmp_path):
    img = tmp_path / "shot.png"
    img.write_bytes(_PNG_1X1)

    res = _run({"path": str(img)}, _ctx(tmp_path))

    assert isinstance(res, ToolSuccess), res
    assert "format=png" in res.content
    assert "width=1" in res.content
    assert "height=1" in res.content
    assert "sha256=" in res.content


def test_image_inspect_rejects_non_image(tmp_path):
    f = tmp_path / "note.txt"
    f.write_text("hello", encoding="utf-8")

    res = _run({"path": str(f)}, _ctx(tmp_path))

    assert isinstance(res, ToolError)
    assert res.kind == "binary"


def test_smb_inspect_tools_in_smb_task_worker_whitelist():
    """v3.88: operator 는 core-owned 라 도메인 도구를 안 받는다(WITHDRAWN CORE-ASK
    register_task_toolset_extension). smb_inspect_image/pdf 는 대신 #1 점검 워커의 도구
    화이트리스트(service.agents.smb_task_agent._tool_classes)에 실려 도달한다 — redesign doc §#1
    점검 표. unlock-list 멤버십은 reachability 를 증명하지 못하므로(core 는 registry 에 없는
    도구를 조용히 skip) 실제 워커 registry 를 검증한다."""
    from service.agents.smb_task_agent import _tool_classes

    names = {c.name for c in _tool_classes()}
    assert "smb_inspect_image" in names
    assert "smb_inspect_pdf" in names


def test_smb_inspect_image_reads_remote_image_metadata(tmp_db, tmp_path, monkeypatch):
    sid = state.scan_start("smb", ["10.0.0.0/24"])
    _, share_id = state.upsert_smb_share(
        sid, "10.0.0.0/24", "10.0.0.5", "data", share_read=True,
    )
    file_id = state.upsert_smb_file(
        share_id,
        "대강당 사이드 배너_1.jpg",
        size=len(_PNG_1X1),
        is_text_candidate=False,
        suspicious_name=False,
    )
    monkeypatch.setattr(
        smb_mod,
        "fetch_file_bytes",
        lambda host, share, path, **kw: smb_mod.SmbFileBytes(
            status="bytes",
            data=_PNG_1X1,
            size=len(_PNG_1X1),
        ),
    )

    tool = SmbInspectImageTool()
    res = asyncio.run(tool.execute(
        tool.input_model(
            host="10.0.0.5",
            share="data",
            path="대강당 사이드 배너_1.jpg",
            analyze=False,
        ),
        _ctx(tmp_path),
    ))

    assert isinstance(res, ToolSuccess), res
    payload = json.loads(res.content)
    assert payload["source"] == "smb://10.0.0.5/data/대강당 사이드 배너_1.jpg"
    assert payload["format"] == "png"
    assert payload["width"] == 1
    assert payload["height"] == 1
    assert Path(payload["artifact_path"]).exists()
    with state.connect() as c:
        row = c.execute(
            "SELECT fetch_status, file_read FROM smb_file WHERE id=?",
            (file_id,),
        ).fetchone()
    assert row["fetch_status"] == "image_read"
    assert row["file_read"] == 1


def test_smb_inspect_image_rejects_non_image(tmp_db, tmp_path, monkeypatch):
    monkeypatch.setattr(
        smb_mod,
        "fetch_file_bytes",
        lambda host, share, path, **kw: smb_mod.SmbFileBytes(
            status="bytes",
            data=b"plain text",
            size=10,
        ),
    )

    tool = SmbInspectImageTool()
    res = asyncio.run(tool.execute(
        tool.input_model(host="10.0.0.5", share="data", path="note.jpg"),
        _ctx(tmp_path),
    ))

    assert isinstance(res, ToolError)
    assert res.kind == "binary"


def test_smb_inspect_pdf_extracts_text_and_records_scan(tmp_db, tmp_path, monkeypatch):
    raw = b"%PDF-1.4\nBT (password=agent_type2 endpoint=https://app.example/login) Tj ET\n%%EOF"
    sid = state.scan_start("smb", ["10.0.0.0/24"])
    _, share_id = state.upsert_smb_share(
        sid, "10.0.0.0/24", "10.0.0.5", "data", share_read=True,
    )
    file_id = state.upsert_smb_file(
        share_id,
        "docs/secret.pdf",
        size=len(raw),
        is_text_candidate=True,
        suspicious_name=False,
    )
    monkeypatch.setattr(
        smb_mod,
        "fetch_file_bytes",
        lambda host, share, path, **kw: smb_mod.SmbFileBytes(
            status="bytes",
            data=raw,
            size=len(raw),
        ),
    )

    tool = SmbInspectPdfTool()
    res = asyncio.run(tool.execute(
        tool.input_model(host="10.0.0.5", share="data", path="docs/secret.pdf"),
        _ctx(tmp_path),
    ))

    assert isinstance(res, ToolSuccess), res
    payload = json.loads(res.content)
    assert payload["source"] == "smb://10.0.0.5/data/docs/secret.pdf"
    assert payload["text_extracted"] is True
    assert "password=agent_type2" in payload["text_preview"]
    assert Path(payload["artifact_path"]).exists()
    with state.connect() as c:
        row = c.execute(
            "SELECT fetch_status, file_read, scan_status FROM smb_file WHERE id=?",
            (file_id,),
        ).fetchone()
    assert row["fetch_status"] == "pdf_text"
    assert row["file_read"] == 1
    assert row["scan_status"] == "scanned"


def test_smb_inspect_pdf_image_pdf_renders_pages_when_available(tmp_db, tmp_path, monkeypatch):
    raw = b"%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF"
    sid = state.scan_start("smb", ["10.0.0.0/24"])
    _, share_id = state.upsert_smb_share(
        sid, "10.0.0.0/24", "10.0.0.5", "data", share_read=True,
    )
    file_id = state.upsert_smb_file(
        share_id,
        "scan/image.pdf",
        size=len(raw),
        is_text_candidate=True,
        suspicious_name=False,
    )
    monkeypatch.setattr(
        smb_mod,
        "fetch_file_bytes",
        lambda host, share, path, **kw: smb_mod.SmbFileBytes(
            status="bytes",
            data=raw,
            size=len(raw),
        ),
    )
    monkeypatch.setattr(smb_mod, "_extract_document_text", lambda path, data: None)
    monkeypatch.setattr(smb_mod, "render_pdf_pages_as_images", lambda data, **kw: [_PNG_1X1])

    tool = SmbInspectPdfTool()
    res = asyncio.run(tool.execute(
        tool.input_model(
            host="10.0.0.5",
            share="data",
            path="scan/image.pdf",
            analyze=False,
        ),
        _ctx(tmp_path),
    ))
    assert isinstance(res, ToolSuccess), res
    payload = json.loads(res.content)
    assert payload["analysis_status"] == "skipped_analyze_false"

    res = asyncio.run(tool.execute(
        tool.input_model(
            host="10.0.0.5",
            share="data",
            path="scan/image.pdf",
            analyze=True,
        ),
        _ctx(tmp_path),
    ))
    assert isinstance(res, ToolSuccess), res
    payload = json.loads(res.content)
    # Vision client may be unavailable in tests, but page rendering path must be reached.
    assert payload["analysis_status"] in {"unavailable", "ok", "no_page_analysis"}
    with state.connect() as c:
        row = c.execute(
            "SELECT fetch_status, file_read FROM smb_file WHERE id=?",
            (file_id,),
        ).fetchone()
    assert row["file_read"] == 1
