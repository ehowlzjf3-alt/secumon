"""v3.82 U2: plugin 부트스트랩 (SA_PLUGINS) — fail-loud / 멱등 / 등록 부수효과."""
from __future__ import annotations

import sys

import pytest

from secu_agent import plugins
from secu_agent.plugins import PluginLoadError, load_plugins


@pytest.fixture(autouse=True)
def _isolate_loaded(monkeypatch):
    """프로세스 전역 _LOADED 를 테스트별로 격리하고 sys.modules 오염을 정리."""
    monkeypatch.setattr(plugins, "_LOADED", {})
    before = set(sys.modules)
    yield
    for name in set(sys.modules) - before:
        if name.startswith("th_plugin_"):
            sys.modules.pop(name, None)


def test_file_plugin_registers_via_side_effect(tmp_path):
    from secu_agent.agent_type_registry import unregister_agent_type, valid_agent_types

    plug = tmp_path / "plug_reg_agent_type.py"
    plug.write_text(
        "from secu_agent.agent_type_registry import register_agent_type\n"
        "register_agent_type('plugtest_agent_type')\n",
        encoding="utf-8",
    )
    try:
        loaded = load_plugins(str(plug))
        assert loaded == ["th_plugin_plug_reg_agent_type"]
        assert "plugtest_agent_type" in valid_agent_types()
    finally:
        try:
            unregister_agent_type("plugtest_agent_type")
        except Exception:  # noqa: BLE001
            pass


def test_idempotent_same_entry(tmp_path):
    plug = tmp_path / "plug_idem.py"
    plug.write_text("X = 1\n", encoding="utf-8")
    assert load_plugins(str(plug)) == ["th_plugin_plug_idem"]
    # 같은 entry 재로드 = no-op (등록 부수효과 재실행 금지)
    assert load_plugins(str(plug)) == []


def test_missing_file_fails_loud():
    with pytest.raises(PluginLoadError, match="plugin 파일 없음"):
        load_plugins("/nonexistent/plug_missing.py")


def test_import_error_fails_loud_and_cleans_sys_modules(tmp_path):
    plug = tmp_path / "plug_broken.py"
    plug.write_text("raise ValueError('boom')\n", encoding="utf-8")
    with pytest.raises(PluginLoadError, match="plugin import 실패"):
        load_plugins(str(plug))
    assert "th_plugin_plug_broken" not in sys.modules


def test_name_collision_between_different_files(tmp_path):
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    (a / "plug_same.py").write_text("X = 'a'\n", encoding="utf-8")
    (b / "plug_same.py").write_text("X = 'b'\n", encoding="utf-8")
    load_plugins(str(a / "plug_same.py"))
    with pytest.raises(PluginLoadError, match="모듈명 충돌"):
        load_plugins(str(b / "plug_same.py"))


def test_dotted_module_entry():
    # 부수효과 없는 stdlib 모듈로 dotted-path 분기 검증
    assert load_plugins("string") == ["string"]
    assert load_plugins("string") == []


def test_bad_dotted_module_fails_loud():
    with pytest.raises(PluginLoadError, match="plugin import 실패"):
        load_plugins("th_no_such_module_xyz")


def test_env_default_and_multi_entry(tmp_path, monkeypatch):
    p1 = tmp_path / "plug_env_one.py"
    p2 = tmp_path / "plug_env_two.py"
    p1.write_text("X = 1\n", encoding="utf-8")
    p2.write_text("X = 2\n", encoding="utf-8")
    monkeypatch.setenv("SA_PLUGINS", f"{p1},{p2}")
    assert load_plugins() == ["th_plugin_plug_env_one", "th_plugin_plug_env_two"]


def test_empty_env_is_noop(monkeypatch):
    monkeypatch.delenv("SA_PLUGINS", raising=False)
    assert load_plugins() == []
