"""read_extract — log_parser.py가 만든 extract.json 구조화 읽기."""
from __future__ import annotations

import json
from typing import ClassVar

from pydantic import BaseModel

from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess


class ReadExtractInput(BaseModel):
    pass


class ReadExtractTool(Tool[ReadExtractInput]):
    name: ClassVar[str] = "read_extract"
    description: ClassVar[str] = (
        "extract.json (log_parser가 install_trace.log에서 추출한 결정론적 시그널)을 읽는다.\n"
        "Usage: 파라미터 없음. evidence_dir/extract.json 자동 로드.\n"
        "Output: package_meta, stats(syscall 카운트), signals[{type, raw_line_nums, value}].\n"
        "When to use: 분석 시작 시 첫 호출 권장 — 어떤 시그널이 자동 탐지됐는지 한눈에. "
        "각 signal의 raw_line_nums는 read_file로 install_trace.log 원문 확인용 포인터."
    )
    input_model: ClassVar[type[BaseModel]] = ReadExtractInput
    search_hint: ClassVar[str] = "extract signals deterministic parser overview"
    is_read_only: ClassVar[bool] = True

    async def execute(
        self, validated_input: ReadExtractInput, context: ToolContext,
    ) -> ToolResult:
        path = context.evidence_dir / "extract.json"
        if not path.exists():
            return ToolError(kind="not_found", message="extract.json missing — log_parser 안 돌았음")
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            return ToolError(kind="io_error", message=f"extract.json 읽기 실패: {e}")

        # 사람 친화 요약
        sigs = data.get("signals", [])
        meta = data.get("package_meta", {})
        stats = data.get("stats", {})
        lines: list[str] = []
        lines.append(f"# package: {meta.get('name', '?')} {meta.get('version', '')}")
        lines.append(f"# source: {meta.get('source_path', '?')}")
        if "sha256" in meta:
            lines.append(f"# sha256: {meta['sha256']}")
        lines.append("")
        lines.append("## stats")
        for k, v in stats.items():
            lines.append(f"- {k}: {v}")
        lines.append("")
        lines.append(f"## signals ({len(sigs)})")
        for i, s in enumerate(sigs):
            lns = s.get("raw_line_nums", [])
            ln_str = ",".join(str(x) for x in lns[:5]) + (f",+{len(lns) - 5}more" if len(lns) > 5 else "")
            value = s.get("value", "")
            if isinstance(value, str) and len(value) > 200:
                value = value[:200] + "..."
            lines.append(f"[{i}] type={s.get('type')!r}  raw_lines={ln_str}")
            lines.append(f"    value: {value!r}")
        lines.append("")
        lines.append(
            f"raw_log: {data.get('raw_log_path', 'install_trace.log')} "
            f"(read_file로 line_num 직접 확인)"
        )
        if "setup_py_path" in data:
            lines.append(f"setup_py: {data['setup_py_path']}")
        return ToolSuccess(content="\n".join(lines))
