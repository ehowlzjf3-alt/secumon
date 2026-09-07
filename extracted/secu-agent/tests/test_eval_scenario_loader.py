"""v3.16-B: Scenario YAML 로더.

시나리오 = 입력 + scripted LLM turns + 기대 동작. YAML 1개 파일로 표현.
"""
from __future__ import annotations

from pathlib import Path

import pytest


def _write(p: Path, body: str) -> Path:
    p.write_text(body, encoding="utf-8")
    return p


# ─── 최소 시나리오 ───────────────────────────────────────────


def test_loads_minimal_scenario(tmp_path):
    from secu_agent.agent.eval.scenario import load_scenario

    f = _write(tmp_path / "min.yaml", """\
name: min
task_type: operator
user_input: "안녕"
script:
  - text: "네 안녕하세요"
expectations: {}
""")
    s = load_scenario(f)
    assert s.name == "min"
    assert s.task_type == "operator"
    assert s.user_input == "안녕"
    assert len(s.script) == 1
    assert s.script[0].text == "네 안녕하세요"
    assert s.script[0].tool_calls == []
    assert s.expectations.tools_called == []


def test_scripted_turn_with_tool_calls(tmp_path):
    from secu_agent.agent.eval.scenario import load_scenario

    f = _write(tmp_path / "t.yaml", """\
name: tcall
task_type: operator
user_input: "discovery 돌려"
script:
  - tool_calls:
      - name: run_smb_discovery
        input: {limit: 5}
  - text: "끝"
expectations:
  tools_called: ["run_smb_discovery"]
""")
    s = load_scenario(f)
    assert len(s.script) == 2
    tc = s.script[0].tool_calls
    assert len(tc) == 1
    assert tc[0].name == "run_smb_discovery"
    assert tc[0].input == {"limit": 5}
    assert s.expectations.tools_called == ["run_smb_discovery"]


# ─── expectations 다양한 필드 ───────────────────────────────


def test_expectations_full(tmp_path):
    from secu_agent.agent.eval.scenario import load_scenario

    f = _write(tmp_path / "e.yaml", """\
name: e
task_type: operator
user_input: "x"
script:
  - text: "done"
expectations:
  tools_called: ["a", "b"]
  tools_not_called: ["c"]
  final_text_contains: ["done"]
  final_text_not_contains: ["error"]
  min_turns: 1
  max_turns: 5
""")
    s = load_scenario(f)
    e = s.expectations
    assert e.tools_called == ["a", "b"]
    assert e.tools_not_called == ["c"]
    assert e.final_text_contains == ["done"]
    assert e.final_text_not_contains == ["error"]
    assert e.min_turns == 1
    assert e.max_turns == 5


# ─── seed (옵션) ────────────────────────────────────────────


def test_seed_section_optional(tmp_path):
    from secu_agent.agent.eval.scenario import load_scenario

    f = _write(tmp_path / "s.yaml", """\
name: s
task_type: operator
user_input: "x"
seed:
  subnets:
    - "10.99.0.0/24"
script:
  - text: "ok"
expectations: {}
""")
    s = load_scenario(f)
    assert s.seed is not None
    assert s.seed.subnets == ["10.99.0.0/24"]


def test_seed_missing_means_no_seed(tmp_path):
    from secu_agent.agent.eval.scenario import load_scenario

    f = _write(tmp_path / "ns.yaml", """\
name: ns
task_type: operator
user_input: "x"
script:
  - text: "ok"
expectations: {}
""")
    s = load_scenario(f)
    assert s.seed is None


# ─── 검증 ───────────────────────────────────────────────────


def test_missing_required_field_raises(tmp_path):
    from secu_agent.agent.eval.scenario import load_scenario

    f = _write(tmp_path / "bad.yaml", """\
task_type: operator
user_input: "x"
script:
  - text: ok
expectations: {}
""")
    with pytest.raises(ValueError, match="name"):
        load_scenario(f)


def test_empty_script_raises(tmp_path):
    from secu_agent.agent.eval.scenario import load_scenario

    f = _write(tmp_path / "es.yaml", """\
name: es
task_type: operator
user_input: "x"
script: []
expectations: {}
""")
    with pytest.raises(ValueError, match="script"):
        load_scenario(f)


# ─── 디렉토리 일괄 로드 ─────────────────────────────────────


def test_load_scenarios_dir(tmp_path):
    from secu_agent.agent.eval.scenario import load_scenarios_dir

    _write(tmp_path / "a.yaml", """\
name: a
task_type: operator
user_input: "x"
script:
  - text: ok
expectations: {}
""")
    _write(tmp_path / "b.yaml", """\
name: b
task_type: operator
user_input: "y"
script:
  - text: ok
expectations: {}
""")
    # non-yaml 은 무시
    (tmp_path / "README.md").write_text("ignore me", encoding="utf-8")

    scenarios = load_scenarios_dir(tmp_path)
    names = sorted(s.name for s in scenarios)
    assert names == ["a", "b"]
