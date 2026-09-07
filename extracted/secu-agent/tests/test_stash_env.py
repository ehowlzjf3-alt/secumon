import os
from secu_agent.agent.stash import tool_result_inline_max, _DEFAULT_INLINE_MAX

def test_default_when_unset(monkeypatch):
    monkeypatch.delenv("SA_TOOL_INLINE_MAX", raising=False)
    assert tool_result_inline_max() == 50_000

def test_env_raises_threshold(monkeypatch):
    monkeypatch.setenv("SA_TOOL_INLINE_MAX", "150000")
    assert tool_result_inline_max() == 150_000

def test_clamped_to_floor(monkeypatch):
    monkeypatch.setenv("SA_TOOL_INLINE_MAX", "1000")  # 50KB 미만은 floor
    assert tool_result_inline_max() == 50_000

def test_clamped_to_ceiling(monkeypatch):
    monkeypatch.setenv("SA_TOOL_INLINE_MAX", "9999999")
    assert tool_result_inline_max() == 500_000

def test_garbage_falls_back(monkeypatch):
    monkeypatch.setenv("SA_TOOL_INLINE_MAX", "abc")
    assert tool_result_inline_max() == 50_000
