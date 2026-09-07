"""v3.16-D: 패키지 동봉 시나리오가 실제로 통과하는지 + CLI 동작.

번들 시나리오 (smoke_greeting / smb_discovery_then_pending_check) 가
ScriptedLLM + stub registry 위에서 결정적으로 통과해야 한다.
"""
from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

import pytest

from secu_agent.agent.eval.cli import (
    default_scenarios_dir,
    run_from_args,
)
from secu_agent.agent.eval.runner import build_stub_registry, run_scenario
from secu_agent.agent.eval.scenario import load_scenario, load_scenarios_dir
from secu_agent.agent.eval.scoring import score_scenario


def _scenarios_dir() -> Path:
    return default_scenarios_dir()


def test_default_scenarios_dir_exists():
    d = _scenarios_dir()
    assert d.is_dir()
    yamls = list(d.glob("*.yaml"))
    assert len(yamls) >= 2  # 최소 smoke + smb chain


def test_bundled_scenarios_all_loadable():
    scenarios = load_scenarios_dir(_scenarios_dir())
    names = {s.name for s in scenarios}
    assert "smoke_greeting" in names
    # de-domain: 도메인 시나리오는 secu-agent-skill/eval_scenarios 로 이동
    assert not any("smb" in n for n in names)


def test_bundled_scenarios_all_pass(tmp_path):
    scenarios = load_scenarios_dir(_scenarios_dir())
    for s in scenarios:
        ev_dir = tmp_path / s.name
        result = asyncio.run(run_scenario(s, evidence_dir=ev_dir))
        report = score_scenario(result, s.expectations)
        assert report.passed, f"{s.name} failed: {report.failures}"


def test_stub_registry_built_from_tool_stubs():
    # de-domain: 번들 시나리오 대신 인라인 stub 으로 메커니즘 검증
    from secu_agent.agent.eval.scenario import ToolStub
    stubs = [
        ToolStub(name="fake_probe", success_message="ok"),
        ToolStub(name="fake_list", success_message="[]"),
    ]
    r = build_stub_registry(stubs)
    names = {t.name for t in r.all()}
    assert "fake_probe" in names
    assert "fake_list" in names


# ─── CLI ────────────────────────────────────────────────────


def test_cli_runs_single_scenario_by_name(capsys, tmp_path):
    args = argparse.Namespace(
        cmd="eval", scenario="smoke_greeting", dir=None, file=None,
    )
    rc = run_from_args(args)
    assert rc == 0
    out = capsys.readouterr().out
    assert "smoke_greeting" in out
    assert "1 pass" in out


def test_cli_runs_all_default_scenarios(capsys):
    args = argparse.Namespace(cmd="eval", scenario=None, dir=None, file=None)
    rc = run_from_args(args)
    assert rc == 0
    out = capsys.readouterr().out
    assert "0 fail" in out


def test_cli_unknown_scenario_name_returns_1(capsys):
    args = argparse.Namespace(
        cmd="eval", scenario="does_not_exist", dir=None, file=None,
    )
    rc = run_from_args(args)
    assert rc == 1


def test_cli_single_file_path(capsys):
    f = _scenarios_dir() / "smoke_greeting.yaml"
    args = argparse.Namespace(cmd="eval", scenario=None, dir=None, file=str(f))
    rc = run_from_args(args)
    assert rc == 0


def test_cli_dir_with_no_yaml_returns_1(tmp_path, capsys):
    empty = tmp_path / "empty"
    empty.mkdir()
    args = argparse.Namespace(
        cmd="eval", scenario=None, dir=str(empty), file=None,
    )
    rc = run_from_args(args)
    assert rc == 1
