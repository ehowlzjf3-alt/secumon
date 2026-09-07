"""리드 위임이 **프로덕션 검문소** 아래에서 실제로 도는지 (Phase 2a).

## 왜 따로 있는가

저장소 conftest 의 `_tool_checkpoint_test_mode` 가 코어 v3.89 검문소를 꺼 둔다
(cold-call 테스트 호환). 그 상태에서는 `delegate_inspect` 가 `super().execute()` 로
코어 `AgentTool` 을 부르는 경로가 **검증되지 않는다** — 프로덕션에서만 검문소가 켜지고,
거기서 거부되면 위임이 통째로 죽는다. 그래서 여기서만 강제를 되켠다.

## 무엇을 고정하는가

1. `delegate_inspect` → `super().execute()` 협조상속 체인이 permit 을 통과한다.
2. 리드는 코어 `agent` 도구를 **부를 수 없다**(레지스트리에 없다) — 마스킹 우회 차단.
3. 검문소가 진짜로 켜져 있다(다른 인스턴스 직접 호출은 차단된다) — 1번이 "그냥 꺼져
   있어서 통과" 한 게 아님을 증명한다.
"""
from __future__ import annotations

import asyncio

import pytest

from secu_agent.agent.tools import base
from secu_agent.agent.tools.base import ToolContext, ToolError
from secu_agent.agent.tools.registry import ToolRegistry

from _shared.lead_adapter import (
    LeadAdapter, register_lead_adapter, unregister_lead_adapter,
)
from _shared.lead_tools import LEAD_DOMAIN_KEY, lead_tools


@pytest.fixture()
def enforced(tmp_path, monkeypatch):
    """검문소 ON + 리드 레지스트리 + 빈 agents_dir(위임은 not_found 로 빨리 끝난다)."""
    monkeypatch.delenv("SA_AGENT_DEPTH", raising=False)
    agents_dir = tmp_path / "agents"
    agents_dir.mkdir()

    adapter = LeadAdapter(
        domain="lead_enforced_test",
        inspect_agent="없는검토원",
        statuses=("pending", "tasked"),
        claimable_statuses=("pending", "tasked"),
        queue_label="테스트 큐",
        list_targets=lambda **kw: [],
        target_detail=lambda tid: {"target_id": tid},
        scan_summary=lambda tid, **kw: {"source": "none", "total": 0},
        run_verb=lambda action, **kw: {"performed": False, "result": "unsupported"},
        delegate_input=lambda tid, scope: {"target_id": tid},
        set_status=lambda tid, st, **kw: {"ok": True},
    )
    register_lead_adapter(adapter)

    reg = ToolRegistry()
    for cls in lead_tools():
        reg.register(cls)
    ctx = ToolContext(
        evidence_dir=tmp_path, registry=reg,
        metadata={LEAD_DOMAIN_KEY: adapter.domain, "agents_dir": str(agents_dir)},
    )
    prev = base.set_checkpoint_enforced(True)
    try:
        yield ctx
    finally:
        base.set_checkpoint_enforced(prev)
        unregister_lead_adapter(adapter.domain)


def test_checkpoint_is_actually_on(enforced):
    """★ 이게 없으면 아래 테스트가 '꺼져 있어서 통과' 한 것인지 알 수 없다."""
    from secu_agent.agent.tools.agent_tool import AgentInput, AgentTool

    with pytest.raises(base.ToolCheckpointBypass):
        asyncio.run(AgentTool().execute(
            AgentInput(action="list"), enforced))


def test_delegate_inspect_passes_the_permit_chain(enforced):
    """`super().execute()` 협조상속이 permit 을 통과해야 위임이 산다."""
    res = asyncio.run(enforced.invoke_tool(
        "delegate_inspect", {"target_id": 1, "question": "테스트"}))
    assert isinstance(res, ToolError), res
    # not_found = AgentTool 본문까지 **도달했다**는 증거(검문소 통과 후 agent 조회 실패).
    assert "not found" in res.message.lower() or "없는검토원" in res.message, res.message
    assert "outside invoke_tool" not in res.message, (
        "검문소가 delegate_inspect → super().execute() 체인을 거부했다 — "
        "프로덕션에서 위임이 통째로 죽는다")


def test_lead_cannot_invoke_the_core_agent_tool(enforced):
    """★ 마스킹 우회 경로 — `agent` 가 리드 레지스트리에 있으면 안 된다."""
    res = asyncio.run(enforced.invoke_tool("agent", {"action": "list"}))
    assert isinstance(res, ToolError)
    assert res.kind in {"not_found", "validation"}, res


def test_read_only_lead_tools_pass_the_checkpoint(enforced):
    """LeadTool base 의 execute 도 검문소 래퍼다 — invoke_tool 경로에서 정상 동작해야 한다."""
    res = asyncio.run(enforced.invoke_tool("list_targets", {"limit": 5}))
    assert not isinstance(res, ToolError) or "outside invoke_tool" not in res.message
