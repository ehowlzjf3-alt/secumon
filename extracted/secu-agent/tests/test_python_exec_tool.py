"""PythonExecTool — agent 가 임의 Python 으로 count/chunk/filter/bulk-add 처리.

v3.33: sandbox 룰 (import / dunder / builtins 화이트리스트) 전면 해제. Claude Code 모델.
남는 가드:
- signal.SIGALRM timeout.
- stdout/stderr capture.
- state 자동 노출 (편의).
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess


def _ctx(tmp_path: Path) -> ToolContext:
    return ToolContext(evidence_dir=tmp_path, metadata={})


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def test_python_basic_arithmetic(tmp_db, tmp_path):
    from secu_agent.agent.tools.python_exec_tool import PythonExecTool
    res = _run(PythonExecTool(), {"code": "print(2 + 2)"}, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess), res
    assert "4" in res.content


def test_python_list_comprehension_and_count(tmp_db, tmp_path):
    from secu_agent.agent.tools.python_exec_tool import PythonExecTool
    code = (
        "xs = [10.11 for _ in range(50)]\n"
        "print('count:', len(xs))"
    )
    res = _run(PythonExecTool(), {"code": code}, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess), res
    assert "count: 50" in res.content


def test_python_ipaddress_module(tmp_db, tmp_path):
    """v3.33: ipaddress 자동 노출 안 함. import 자유라 LLM 이 직접 import."""
    from secu_agent.agent.tools.python_exec_tool import PythonExecTool
    code = (
        "import ipaddress\n"
        "net = ipaddress.ip_network('198.51.100.5/24', strict=False)\n"
        "print(str(net))"
    )
    res = _run(PythonExecTool(), {"code": code}, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess), res
    assert "198.51.100.0/24" in res.content


def test_python_can_call_state_read(tmp_db, tmp_path):
    # v3.82 U3c: 도메인 함수(smb_target_*)는 state 에서 분리 — 코어 함수로 검증.
    # 도메인 DB 접근은 skills 가이드가 안내하는 도메인 서비스 모듈 소유.
    from secu_agent import state
    from secu_agent.agent.tools.python_exec_tool import PythonExecTool
    state.finding_upsert(
        task_type="web", asset="https://app.example.test/.env", asset_kind="url",
        severity="high", summary="exposed env", evidence_ref="finding.json",
    )
    res = _run(PythonExecTool(), {
        "code": "rows = state.finding_list(); print(len(rows))",
    }, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess), res
    assert "1" in res.content


def test_python_can_call_state_write(tmp_db, tmp_path):
    """agent 가 bulk 작업 직접 코딩 가능 — memory_rule 5건 for 루프."""
    from secu_agent import state
    from secu_agent.agent.tools.python_exec_tool import PythonExecTool
    # de-domain v3.84 #5: 'host' 는 등록형 도메인 scope — 이 테스트 동안만 등록.
    state.register_memory_scope("host")
    try:
        code = (
            "for i in range(5):\n"
            "    state.memory_add(scope='host', key=f'10.11.{i+10}.5', "
            "rule=f'rule {i}')\n"
            "print('added 5')"
        )
        res = _run(PythonExecTool(), {"code": code}, _ctx(tmp_path))
        assert isinstance(res, ToolSuccess), res
        assert len(state.memory_search(scope="host")) == 5
    finally:
        state.unregister_memory_scope("host")


def test_python_allows_import_os(tmp_db, tmp_path):
    """v3.33: import 자유. sandbox 룰 해제됨."""
    from secu_agent.agent.tools.python_exec_tool import PythonExecTool
    res = _run(PythonExecTool(), {
        "code": "import os; print(os.path.basename('/a/b/c'))",
    }, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess), res
    assert "c" in res.content


def test_python_allows_dunder_attribute(tmp_db, tmp_path):
    """v3.33: dunder 접근 허용."""
    from secu_agent.agent.tools.python_exec_tool import PythonExecTool
    res = _run(PythonExecTool(), {
        "code": "print('x'.__class__.__name__)",
    }, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess), res
    assert "str" in res.content


def test_python_allows_open_file(tmp_db, tmp_path):
    """v3.33: open 허용. evidence/state 의 file path 직접 읽기 가능."""
    from secu_agent.agent.tools.python_exec_tool import PythonExecTool
    target = tmp_path / "x.txt"
    target.write_text("hello", encoding="utf-8")
    res = _run(PythonExecTool(), {
        "code": f"print(open({str(target)!r}).read())",
    }, _ctx(tmp_path))
    assert isinstance(res, ToolSuccess), res
    assert "hello" in res.content


def test_python_timeout(tmp_db, tmp_path):
    """무한 루프는 timeout."""
    from secu_agent.agent.tools.python_exec_tool import PythonExecTool
    res = _run(PythonExecTool(), {
        "code": "while True:\n    pass",
        "timeout_seconds": 1,
    }, _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert "timeout" in res.message.lower()


def test_python_syntax_error_returns_error(tmp_db, tmp_path):
    from secu_agent.agent.tools.python_exec_tool import PythonExecTool
    res = _run(PythonExecTool(), {"code": "this is not (valid python"},
               _ctx(tmp_path))
    assert isinstance(res, ToolError)
    assert "syntax" in res.message.lower()


def test_python_runtime_error_includes_traceback(tmp_db, tmp_path):
    from secu_agent.agent.tools.python_exec_tool import PythonExecTool
    res = _run(PythonExecTool(), {"code": "1/0"}, _ctx(tmp_path))
    # ZeroDivisionError → ToolSuccess 또는 ToolError — 어떻든 메시지에 zero / division 보임
    msg = res.content if isinstance(res, ToolSuccess) else res.message
    assert "zero" in msg.lower() or "division" in msg.lower()


def test_python_in_operator_registry(tmp_db):
    from secu_agent.agent.tools import build_registry_for_task
    r = build_registry_for_task("operator")
    names = [t.name for t in r.all()]
    assert "python_exec" in names


def test_python_prompt_schema_keeps_domain_tables_in_skills(tmp_db):
    """Core python prompt stays generic; domain schema lives in skills."""
    from secu_agent import state
    from secu_agent.agent.tools.python_exec_tool import PythonExecTool

    with state.connect() as c:
        tables = {
            r["name"]
            for r in c.execute(
                "SELECT table_name AS name FROM information_schema.tables "
                "WHERE table_schema='public'"
            ).fetchall()
        }

    assert "smb_file_hit" not in tables
    assert "file_finding" not in tables
    assert "`finding_lifecycle`" in PythonExecTool.prompt_section
    assert "`smb_file_hit`" not in PythonExecTool.prompt_section
    assert "`file_finding`" not in PythonExecTool.prompt_section

    # de-domain: 도메인 schema.md 는 secu-agent-skill/skills/smb_tasking 으로 이동 —
    # 코어 단언은 "prompt 가 generic 유지" 까지만.
