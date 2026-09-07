from __future__ import annotations

import asyncio
from typing import ClassVar

from pydantic import BaseModel

from secu_agent.agent.engine import QueryConfig, run_query
from secu_agent.agent.events import TextChunk
from secu_agent.agent.eval.scripted_llm import (
    ScriptedLLMClient,
    ScriptedToolCall,
    ScriptedTurn,
)
from secu_agent.agent.llm.messages import TextBlock, UserMessage
from secu_agent.agent.mutation_verifier import (
    build_mutation_verifier_footer,
    record_mutation_result,
    unresolved_mutation_failures,
)
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess
from secu_agent.agent.tools.registry import ToolRegistry


def _collect(aiter):
    async def _go():
        out = []
        async for ev in aiter:
            out.append(ev)
        return out
    return asyncio.run(_go())


def test_mutation_verifier_tracks_failure_until_success():
    metadata: dict[str, object] = {}
    payload = {"path": "/tmp/demo.txt"}

    record_mutation_result(
        metadata,
        tool_name="host_edit",
        tool_input=payload,
        result=ToolError(kind="not_found_in_file", message="old_string missing"),
    )
    failures = unresolved_mutation_failures(metadata)
    assert failures[0]["path"] == "/tmp/demo.txt"
    assert "old_string missing" in build_mutation_verifier_footer(metadata)

    record_mutation_result(
        metadata,
        tool_name="host_edit",
        tool_input=payload,
        result=ToolSuccess(content="edited /tmp/demo.txt"),
    )
    assert unresolved_mutation_failures(metadata) == []


class _HostEditInput(BaseModel):
    path: str
    old_string: str = "a"
    new_string: str = "b"


class _HostEditFailTool(Tool[_HostEditInput]):
    name: ClassVar[str] = "host_edit"
    description: ClassVar[str] = "test host edit failure"
    input_model: ClassVar[type[BaseModel]] = _HostEditInput

    async def execute(self, validated_input: _HostEditInput, context: ToolContext) -> ToolResult:
        del validated_input, context
        return ToolError(kind="not_found_in_file", message="old_string missing")


def test_engine_appends_mutation_failure_footer_before_final_answer(tmp_path):
    registry = ToolRegistry()
    registry.register(_HostEditFailTool)
    context = ToolContext(evidence_dir=tmp_path)
    client = ScriptedLLMClient(turns=[
        ScriptedTurn(tool_calls=[
            ScriptedToolCall(
                name="host_edit",
                input={"path": "/tmp/demo.txt", "old_string": "a", "new_string": "b"},
                id="edit-1",
            ),
        ]),
        ScriptedTurn(text="수정 완료"),
    ])

    events = _collect(run_query(
        client=client,
        registry=registry,
        context=context,
        initial_messages=[UserMessage(content=[TextBlock(text="edit file")])],
        config=QueryConfig(max_turns=2, tool_guardrails=False),
    ))

    chunks = [ev.text for ev in events if isinstance(ev, TextChunk)]
    final_text = "\n".join(chunks)
    assert "수정 완료" in final_text
    assert "mutation verifier" in final_text
    assert "/tmp/demo.txt" in final_text
    assert "old_string missing" in final_text
