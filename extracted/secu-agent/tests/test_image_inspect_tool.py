"""Image artifact inspection tool."""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path

from secu_agent import state
from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess
from secu_agent.agent.tools.image_tools import ImageInspectTool


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


def test_image_inspect_registered_for_operator():
    from secu_agent.agent.tools import build_registry_for_task

    r = build_registry_for_task("operator")
    names = {t.name for t in r.all()}
    assert "image_inspect" in names
    # de-domain: smb_inspect_* 는 plugin 소유 — 코어 registry 에 없어야 한다
    assert "smb_inspect_image" not in names
    assert "smb_inspect_pdf" not in names

# smb_inspect_* 테스트는 secu-agent-skill/tests/test_image_inspect_tool_smb.py 로 이동
