"""v3.51-H2: sqlite3.IntegrityError 등 module-prefixed 예외도 fingerprint 잡힘."""
from __future__ import annotations

from secu_agent.agent.repeat_error import (
    HALT_THRESHOLD,
    RepeatErrorState,
    extract_error_signature,
)
from secu_agent.agent.tools.base import ToolSuccess


def test_extract_sqlite_integrity_error_namespace():
    """sqlite3.IntegrityError 가 traceback 마지막 라인이면 IntegrityError 로 매칭."""
    content = (
        "[stdout]\nstart walk\n\n"
        "[error]\nTraceback (most recent call last):\n"
        '  File "...", line 12, in <module>\n'
        "    state.add_file_hits(...)\n"
        "sqlite3.IntegrityError: UNIQUE constraint failed: smb_file_hit.file_id"
    )
    sig = extract_error_signature("smb_python", ToolSuccess(content=content))
    assert sig is not None
    assert "IntegrityError" in sig
    assert "UNIQUE constraint" in sig


def test_extract_sqlite_operational_error():
    content = (
        "[error]\nTraceback (most recent call last):\n"
        "sqlite3.OperationalError: database is locked"
    )
    sig = extract_error_signature("python_exec", ToolSuccess(content=content))
    assert sig is not None
    assert "OperationalError" in sig


def test_repeat_sqlite_integrity_triggers_halt():
    state = RepeatErrorState()
    content = "[error]\nsqlite3.IntegrityError: UNIQUE constraint failed"
    sig1 = extract_error_signature("smb_python", ToolSuccess(content=content))
    sig2 = extract_error_signature("smb_python", ToolSuccess(content=content))
    assert state.update(sig1) is False
    assert state.update(sig2) is True  # 2회 → halt


def test_dotted_namespace_kept_in_signature():
    """ModuleNotFoundError 같은 일반 케이스는 namespace 없어도 작동."""
    content = "[error]\nModuleNotFoundError: No module named 'foo'"
    sig = extract_error_signature("python_exec", ToolSuccess(content=content))
    assert sig is not None
    assert "ModuleNotFoundError" in sig


def test_underscore_module_prefix():
    """_internal.MyError 처럼 underscore 시작 prefix 도 흡수."""
    content = "[error]\n_internal.SomeError: bad state"
    sig = extract_error_signature("python_exec", ToolSuccess(content=content))
    assert sig is not None
    assert "SomeError" in sig
