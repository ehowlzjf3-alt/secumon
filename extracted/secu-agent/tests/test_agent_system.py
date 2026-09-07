"""v3.12-E: agents/ 디렉토리 + AgentTool — sub-agent 정의 외부화.

agents/<name>.md frontmatter (name, description, task_type, when_to_use, input_keys).
AgentTool(subagent_type, input) 으로 generic spawn — 새 도메인 sub-agent = markdown 만.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest


SAMPLE_AGENT = """\
---
name: sample_master
description: 테스트용 sample master agent
task_type: sample_master
when_to_use: 샘플 테스트 시
input_keys: [target_id, mode]
---

# sample_master

sample master sub-agent system prompt 보조 본문 (선택).
"""

NO_FRONTMATTER = """\
just markdown without frontmatter — 거부되어야 함.
"""


@pytest.fixture
def agents_dir(tmp_path: Path) -> Path:
    d = tmp_path / "agents"
    d.mkdir()
    (d / "sample_master.md").write_text(SAMPLE_AGENT)
    return d


# ─── agent loader ────────────────────────────────────────────────


def test_load_agents_lists_agents(agents_dir):
    from secu_agent.agent.agents import load_agents
    ags = load_agents(agents_dir)
    assert len(ags) == 1
    a = ags[0]
    assert a.name == "sample_master"
    assert a.task_type == "sample_master"
    assert a.description == "테스트용 sample master agent"
    assert "target_id" in a.input_keys
    assert "mode" in a.input_keys


def test_load_agents_skips_bad_frontmatter(tmp_path):
    from secu_agent.agent.agents import load_agents
    d = tmp_path / "agents"
    d.mkdir()
    (d / "bad.md").write_text(NO_FRONTMATTER)
    assert load_agents(d) == []


def test_load_agents_skips_name_mismatch(tmp_path):
    """file basename ≠ frontmatter name → skip."""
    from secu_agent.agent.agents import load_agents
    d = tmp_path / "agents"
    d.mkdir()
    # file=wrong.md, name=sample_master 안 맞음
    (d / "wrong.md").write_text(SAMPLE_AGENT)
    assert load_agents(d) == []


def test_load_agents_get_by_name(agents_dir):
    from secu_agent.agent.agents import get_agent
    a = get_agent("sample_master", agents_dir=agents_dir)
    assert a is not None and a.name == "sample_master"
    assert get_agent("nope", agents_dir=agents_dir) is None


# ─── default agents (packaged) ───────────────────────────────────


def test_default_agents_packaged():
    """de-domain: 코어 패키지에는 finding_narrator 만 — 도메인 agent md 는 plugin 소유."""
    from secu_agent.agent.agents import load_agents
    ags = load_agents()  # default dir
    names = {a.name for a in ags}
    assert "finding_narrator" in names
    assert not any(n.startswith("smb_") for n in names)


# ─── AgentTool (v3.81 T1b: WorkerPool subprocess 백엔드) ─────────


def _run(tool, payload, ctx):
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


# fake 워커 — 실제 subprocess 로 돌며 worker_result.json(유일 채널) +
# agent_result.json(보조 채널) 을 쓴다. argv[1] = sub evidence dir.
FAKE_WORKER_OK = """\
import json, os, sys
from pathlib import Path
ev = Path(sys.argv[1])
(ev / "depth_seen.txt").write_text(os.environ.get("SA_AGENT_DEPTH", ""))
(ev / "agent_result.json").write_text(json.dumps({
    "ok": True, "summary": "fake sample_master result"}))
(ev / "worker_result.json").write_text(json.dumps({
    "rc": 0, "status": "ok", "summary": "fake done", "findings_count": 0,
    "turns_used": 1, "tokens_in": 10, "tokens_out": 5, "evidence_paths": []}))
"""

FAKE_WORKER_CRASH = """\
import json, sys
from pathlib import Path
ev = Path(sys.argv[1])
(ev / "worker_result.json").write_text(json.dumps({
    "rc": 1, "status": "error_crash", "summary": "boom", "findings_count": 0,
    "turns_used": 0, "tokens_in": 0, "tokens_out": 0, "evidence_paths": []}))
sys.exit(1)
"""

FAKE_WORKER_SILENT = """\
import sys
sys.exit(0)
"""

FAKE_WORKER_WEDGED = """\
import time
time.sleep(30)
"""


def _patch_worker(monkeypatch, script: str):
    import sys as _sys
    from secu_agent.agent.tools import agent_tool as at_mod

    def fake_argv(sub_evidence):
        return [_sys.executable, "-c", script, str(sub_evidence)]

    monkeypatch.setattr(at_mod, "_worker_argv", fake_argv)


def _sub_dir(parent: Path) -> Path:
    dirs = sorted(parent.glob("sub-*"))
    assert dirs, f"sub evidence dir 없음: {list(parent.iterdir())}"
    return dirs[0]


def test_agent_tool_metadata():
    from secu_agent.agent.tools.agent_tool import AgentTool
    assert AgentTool.domain == "core"
    assert AgentTool.dispatch_keywords


def test_agent_tool_dispatches_to_agent(agents_dir, tmp_path, monkeypatch):
    """AgentTool(subagent_type='sample_master', input={...}) → subprocess 워커 실행."""
    from secu_agent.agent.tools.agent_tool import AgentTool
    from secu_agent.agent.tools.base import ToolContext, ToolSuccess

    _patch_worker(monkeypatch, FAKE_WORKER_OK)

    ctx = ToolContext(evidence_dir=tmp_path,
                      metadata={"agents_dir": str(agents_dir)})
    res = _run(AgentTool(), {
        "subagent_type": "sample_master",
        "input": {"target_id": 42, "mode": "quick"},
    }, ctx)

    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    spec_seen = json.loads((_sub_dir(tmp_path) / "task_spec.json").read_text())
    assert spec_seen["task_type"] == "sample_master"
    assert spec_seen["target"]["target_id"] == 42
    assert spec_seen["target"]["mode"] == "quick"
    assert "fake sample_master" in res.content.lower()


def test_agent_tool_worker_runs_as_subprocess_with_depth_env(
    agents_dir, tmp_path, monkeypatch,
):
    """v3.81 T1b: 워커는 별도 프로세스 + SA_AGENT_DEPTH=부모+1 상속."""
    from secu_agent.agent.tools.agent_tool import AgentTool
    from secu_agent.agent.tools.base import ToolContext, ToolSuccess

    monkeypatch.delenv("SA_AGENT_DEPTH", raising=False)
    _patch_worker(monkeypatch, FAKE_WORKER_OK)

    ctx = ToolContext(evidence_dir=tmp_path,
                      metadata={"agents_dir": str(agents_dir)})
    res = _run(AgentTool(), {
        "subagent_type": "sample_master",
        "input": {"target_id": 1, "mode": "q"},
    }, ctx)
    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    assert (_sub_dir(tmp_path) / "depth_seen.txt").read_text() == "1"


def test_agent_tool_depth_limit_blocks_spawn(agents_dir, tmp_path, monkeypatch):
    """v3.81 T1b: depth >= max → spawn 자체를 거부 (무한 self-spawn 차단)."""
    from secu_agent.agent.tools.agent_tool import AgentTool
    from secu_agent.agent.tools.base import ToolContext, ToolError

    monkeypatch.setenv("SA_AGENT_DEPTH", "2")  # 기본 max=2 → 차단

    ctx = ToolContext(evidence_dir=tmp_path,
                      metadata={"agents_dir": str(agents_dir)})
    res = _run(AgentTool(), {
        "subagent_type": "sample_master",
        "input": {"target_id": 1, "mode": "q"},
    }, ctx)
    assert isinstance(res, ToolError)
    assert res.kind == "permission"
    assert "깊이" in res.message
    assert not list(tmp_path.glob("sub-*"))  # spawn 안 함


def test_agent_tool_missing_worker_result_fail_closed(
    agents_dir, tmp_path, monkeypatch,
):
    """v3.81 T1b: rc=0 이어도 worker_result.json 누락 = fail-closed 에러."""
    from secu_agent.agent.tools.agent_tool import AgentTool
    from secu_agent.agent.tools.base import ToolContext, ToolError

    _patch_worker(monkeypatch, FAKE_WORKER_SILENT)

    ctx = ToolContext(evidence_dir=tmp_path,
                      metadata={"agents_dir": str(agents_dir)})
    res = _run(AgentTool(), {
        "subagent_type": "sample_master",
        "input": {"target_id": 1, "mode": "q"},
    }, ctx)
    assert isinstance(res, ToolError)
    assert res.kind == "execution"
    assert "fail-closed" in res.message


def test_agent_tool_unknown_subagent_type(agents_dir, tmp_path):
    from secu_agent.agent.tools.agent_tool import AgentTool
    from secu_agent.agent.tools.base import ToolContext, ToolError

    ctx = ToolContext(evidence_dir=tmp_path,
                      metadata={"agents_dir": str(agents_dir)})
    res = _run(AgentTool(), {
        "subagent_type": "nonexistent",
        "input": {},
    }, ctx)
    assert isinstance(res, ToolError)
    assert res.kind in {"validation", "not_found"}
    assert "available sub-agents" in res.message
    assert "sample_master" in res.message


def test_agent_tool_lists_available_subagents(agents_dir, tmp_path):
    from secu_agent.agent.tools.agent_tool import AgentTool
    from secu_agent.agent.tools.base import ToolContext, ToolSuccess

    ctx = ToolContext(evidence_dir=tmp_path,
                      metadata={"agents_dir": str(agents_dir)})
    res = _run(AgentTool(), {"action": "list"}, ctx)

    assert isinstance(res, ToolSuccess)
    assert "sample_master" in res.content


def test_agent_tool_sub_agent_failure(agents_dir, tmp_path, monkeypatch):
    """워커가 error_crash 보고 + rc=1 → ToolError(execution), summary 포함."""
    from secu_agent.agent.tools.agent_tool import AgentTool
    from secu_agent.agent.tools.base import ToolContext, ToolError

    _patch_worker(monkeypatch, FAKE_WORKER_CRASH)

    ctx = ToolContext(evidence_dir=tmp_path,
                      metadata={"agents_dir": str(agents_dir)})
    res = _run(AgentTool(), {
        "subagent_type": "sample_master",
        "input": {"target_id": 1, "mode": "q"},
    }, ctx)
    assert isinstance(res, ToolError)
    assert res.kind == "execution"
    assert "error_crash" in res.message
    assert "boom" in res.message


# ─── v3.80 Slice0c→v3.81 T1b: backstop timeout + charter_ref 상속 ─


def test_agent_tool_spawn_timeout(agents_dir, tmp_path, monkeypatch):
    """워커가 backstop 초과로 wedge → ToolError(kind=timeout) + 프로세스 kill."""
    import time as _time
    from secu_agent.agent.tools.agent_tool import AgentTool
    from secu_agent.agent.tools.base import ToolContext, ToolError

    _patch_worker(monkeypatch, FAKE_WORKER_WEDGED)
    monkeypatch.setenv("SA_SUBAGENT_TIMEOUT_SEC", "0.3")

    ctx = ToolContext(evidence_dir=tmp_path,
                      metadata={"agents_dir": str(agents_dir)})
    t0 = _time.monotonic()
    res = _run(AgentTool(), {
        "subagent_type": "sample_master",
        "input": {"target_id": 1, "mode": "q"},
    }, ctx)
    elapsed = _time.monotonic() - t0
    assert isinstance(res, ToolError)
    assert res.kind == "timeout"
    assert "timeout" in res.message.lower()
    # thread 백엔드와 달리 워커는 SIGTERM 으로 즉사 — 30s sleep 을 기다리지 않음
    assert elapsed < 15


def test_agent_tool_charter_ref_inherited_from_parent_context(
    agents_dir, tmp_path, monkeypatch,
):
    """부모 metadata 의 charter_ref 가 env 기본값보다 우선 — 감사추적 보존."""
    from secu_agent.agent.tools.agent_tool import AgentTool
    from secu_agent.agent.tools.base import ToolContext, ToolSuccess

    monkeypatch.setenv("DEFAULT_CHARTER_REF", "ENV-SHOULD-LOSE")
    _patch_worker(monkeypatch, FAKE_WORKER_OK)

    ctx = ToolContext(evidence_dir=tmp_path, metadata={
        "agents_dir": str(agents_dir),
        "charter_ref": "CHG-2026-042",
    })
    res = _run(AgentTool(), {
        "subagent_type": "sample_master",
        "input": {"target_id": 7, "mode": "q"},
    }, ctx)
    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    spec_seen = json.loads((_sub_dir(tmp_path) / "task_spec.json").read_text())
    assert spec_seen["charter_ref"] == "CHG-2026-042"


def test_agent_tool_charter_ref_env_fallback(agents_dir, tmp_path, monkeypatch):
    """charter 없는 부모(operator chat 등) → env fallback 유지."""
    from secu_agent.agent.tools.agent_tool import AgentTool
    from secu_agent.agent.tools.base import ToolContext, ToolSuccess

    monkeypatch.setenv("DEFAULT_CHARTER_REF", "ENV-CHG-9")
    _patch_worker(monkeypatch, FAKE_WORKER_OK)

    ctx = ToolContext(evidence_dir=tmp_path,
                      metadata={"agents_dir": str(agents_dir)})
    res = _run(AgentTool(), {
        "subagent_type": "sample_master",
        "input": {"target_id": 7, "mode": "q"},
    }, ctx)
    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    spec_seen = json.loads((_sub_dir(tmp_path) / "task_spec.json").read_text())
    assert spec_seen["charter_ref"] == "ENV-CHG-9"


# ─── v3.81 T1b: 워커측 worker_result.json 작성 (cli.main) ─────────


def test_cli_main_writes_worker_result_on_missing_spec(tmp_path):
    """task_spec 없음 → rc=1 + worker_result(error_crash) 기록 (fail-closed 채널)."""
    import signal as _sig
    from secu_agent.agent.cli import main

    old = _sig.getsignal(_sig.SIGTERM)
    try:
        rc = main([str(tmp_path)])
    finally:
        _sig.signal(_sig.SIGTERM, old)  # main 이 건 grace 핸들러 원복
    assert rc == 1
    data = json.loads((tmp_path / "worker_result.json").read_text())
    assert data["rc"] == 1
    assert data["status"] == "error_crash"
    assert "task_spec" in data["summary"]


# ─── v3.81 T1c: 모델 라우팅 (profile frontmatter + SA_CHAT_PROFILE) ─

SAMPLE_AGENT_WITH_PROFILE = """\
---
name: cheap_agent
description: 저비용 모델 sub-agent
task_type: generic
when_to_use: 간단 반복 작업
input_keys: [target_id]
profile: cheap-x
---
"""

FAKE_WORKER_ARGV_SPY = """\
import json, sys
from pathlib import Path
ev = Path(sys.argv[1])
(ev / "argv_seen.json").write_text(json.dumps(sys.argv[1:]))
(ev / "worker_result.json").write_text(json.dumps({
    "rc": 0, "status": "ok", "summary": "ok", "findings_count": 0,
    "turns_used": 0, "tokens_in": 0, "tokens_out": 0, "evidence_paths": []}))
"""


def test_agent_def_profile_frontmatter(tmp_path):
    from secu_agent.agent.agents import load_agents
    d = tmp_path / "agents"
    d.mkdir()
    (d / "cheap_agent.md").write_text(SAMPLE_AGENT_WITH_PROFILE)
    (d / "sample_master.md").write_text(SAMPLE_AGENT)
    by_name = {a.name: a for a in load_agents(d)}
    assert by_name["cheap_agent"].profile == "cheap-x"
    assert by_name["sample_master"].profile == ""  # 미지정 = 워커 기본 선택


def test_agent_tool_passes_profile_to_worker(tmp_path, monkeypatch):
    """frontmatter profile → 워커 argv --profile-name (sub-agent 별 모델 라우팅)."""
    from secu_agent.agent.tools.agent_tool import AgentTool
    from secu_agent.agent.tools.base import ToolContext, ToolSuccess

    d = tmp_path / "agents"
    d.mkdir()
    (d / "cheap_agent.md").write_text(SAMPLE_AGENT_WITH_PROFILE)
    _patch_worker(monkeypatch, FAKE_WORKER_ARGV_SPY)

    ctx = ToolContext(evidence_dir=tmp_path, metadata={"agents_dir": str(d)})
    res = _run(AgentTool(), {
        "subagent_type": "cheap_agent",
        "input": {"target_id": 1},
    }, ctx)
    assert isinstance(res, ToolSuccess), getattr(res, "message", res)
    argv_seen = json.loads((_sub_dir(tmp_path) / "argv_seen.json").read_text())
    assert "--profile-name" in argv_seen
    assert argv_seen[argv_seen.index("--profile-name") + 1] == "cheap-x"


def test_cli_select_profile_name(monkeypatch):
    """v3.81 T1c: argv > SA_CHAT_PROFILE > YAML 첫 프로파일. 무효 env 는
    그대로 반환 → 호출부 rc=2 fail-closed (silent downgrade 금지)."""
    from secu_agent.agent.cli import _select_profile_name

    profiles = {"first": object(), "codex": object()}
    monkeypatch.delenv("SA_CHAT_PROFILE", raising=False)
    assert _select_profile_name(None, profiles) == "first"
    assert _select_profile_name("codex", profiles) == "codex"
    monkeypatch.setenv("SA_CHAT_PROFILE", "codex")
    assert _select_profile_name(None, profiles) == "codex"  # 이전: 무시 → first
    assert _select_profile_name("first", profiles) == "first"  # argv 우선
    monkeypatch.setenv("SA_CHAT_PROFILE", "ghost")
    assert _select_profile_name(None, profiles) == "ghost"


def test_cli_worker_status_mapping():
    """rc/reason → WorkerStatus 매핑 — budget 류는 error_budget (부분결과 유효)."""
    from secu_agent.agent.cli import _worker_status_for

    assert _worker_status_for(0, {}) == "ok"
    assert _worker_status_for(3, {"reason": "max_turns"}) == "error_budget"
    assert _worker_status_for(3, {"reason": "max_tokens"}) == "error_budget"
    assert _worker_status_for(3, {"reason": "aborted"}) == "error_budget"
    assert _worker_status_for(3, {"reason": "stream_error"}) == "error_crash"
    assert _worker_status_for(2, {}) == "error_crash"
    assert _worker_status_for(4, {}) == "error_crash"


def test_cli_writer_fills_completion_reason_and_metrics_version(tmp_path):
    """ASK-2: worker_result writer 가 엔진 reason 을 정규화·스키마 승격 +
    metrics_version 스탬프. aborted → cancelled 매핑 확인."""
    from secu_agent.agent.cli import _write_worker_result_best_effort
    from secu_agent.agent.candidate_ledger import CANDIDATE_METRICS_VERSION

    _write_worker_result_best_effort(
        tmp_path, 3,
        {"reason": "aborted", "summary": "budget abort", "turns_used": 2},
    )
    data = json.loads((tmp_path / "worker_result.json").read_text())
    assert data["completion_reason"] == "cancelled"   # aborted → 정규화
    assert data["metrics_version"] == CANDIDATE_METRICS_VERSION


def test_cli_writer_completion_reason_passthrough_and_none(tmp_path):
    """매핑 없는 엔진 reason 은 통과; reason 미기록이면 None."""
    from secu_agent.agent.cli import _write_worker_result_best_effort

    _write_worker_result_best_effort(
        tmp_path, 0, {"reason": "end_turn", "summary": "ok"},
    )
    d1 = json.loads((tmp_path / "worker_result.json").read_text())
    assert d1["completion_reason"] == "end_turn"

    ev2 = tmp_path / "sub"
    ev2.mkdir()
    _write_worker_result_best_effort(ev2, 4, {"summary": "no reason set"})
    d2 = json.loads((ev2 / "worker_result.json").read_text())
    assert d2["completion_reason"] is None


def test_subagent_timeout_env_parsing(monkeypatch):
    """SA_SUBAGENT_TIMEOUT_SEC — 유효값만 적용, 쓰레기/음수는 기본 600."""
    from secu_agent.agent.tools.base import subagent_timeout_sec

    monkeypatch.delenv("SA_SUBAGENT_TIMEOUT_SEC", raising=False)
    assert subagent_timeout_sec() == 600.0
    monkeypatch.setenv("SA_SUBAGENT_TIMEOUT_SEC", "120")
    assert subagent_timeout_sec() == 120.0
    monkeypatch.setenv("SA_SUBAGENT_TIMEOUT_SEC", "-5")
    assert subagent_timeout_sec() == 600.0
    monkeypatch.setenv("SA_SUBAGENT_TIMEOUT_SEC", "abc")
    assert subagent_timeout_sec() == 600.0
