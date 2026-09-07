"""KnoxApprovalResolver — in-chat 텍스트 승인 (lockout 방지 = 타임아웃 deny)."""
from __future__ import annotations

import asyncio

import pytest

from secu_agent import state
from secu_agent.agent.tools.approval import ApprovalRequest
from secu_agent.knox.approval import (
    KnoxApprovalRegistry,
    KnoxApprovalResolver,
    short_id_for,
)


def _req(iid="inv-12345678") -> ApprovalRequest:
    return ApprovalRequest(
        invocation_id=iid, tool_name="smb_write",
        tool_input={"path": "x"}, reason="쓰기 필요",
    )


async def _wait_until_prompted(sent, timeout=2.0):
    """리졸버가 방에 프롬프트를 올릴 때까지(=waiter 등록 완료) 실제 대기."""
    waited = 0.0
    while not sent and waited < timeout:
        await asyncio.sleep(0.01)
        waited += 0.01


def _resolver(reg, sent, *, mode, timeout=5.0):
    async def send(cid, text):
        sent.append((cid, text))

    return KnoxApprovalResolver(
        registry=reg, chatroom_id="room-A", send=send, mode=mode,
        timeout_seconds=timeout, session_id=None, agent_type="smb",
        actor="shaneee.baek",
    )


@pytest.mark.anyio
async def test_auto_mode_allows_without_prompting(tmp_db):
    sent: list = []
    r = _resolver(KnoxApprovalRegistry(), sent, mode="auto")
    d = await r.resolve(_req())
    assert d.behavior == "allow"
    assert sent == []  # auto 는 방에 안 물어봄


@pytest.mark.anyio
async def test_deny_mode_denies_without_prompting(tmp_db):
    sent: list = []
    r = _resolver(KnoxApprovalRegistry(), sent, mode="deny")
    d = await r.resolve(_req())
    assert d.behavior == "deny"
    assert sent == []


@pytest.mark.anyio
async def test_ask_posts_prompt_and_approve_allows(tmp_db):
    reg = KnoxApprovalRegistry()
    sent: list = []
    r = _resolver(reg, sent, mode="ask", timeout=5.0)
    task = asyncio.create_task(r.resolve(_req("inv-abcdef99")))
    # 프롬프트가 방에 올라오고 waiter 가 등록될 때까지 양보
    await _wait_until_prompted(sent)
    assert any("승인" in t for _, t in sent)
    short = short_id_for("inv-abcdef99")
    assert reg.resolve(short, "room-A", True) is True
    d = await task
    assert d.behavior == "allow"
    # 감사기록: allow
    row = state.approval_audit_get("inv-abcdef99")
    assert row is not None and row["decision"] == "allow"


@pytest.mark.anyio
async def test_ask_deny_reply_denies(tmp_db):
    reg = KnoxApprovalRegistry()
    sent: list = []
    r = _resolver(reg, sent, mode="ask", timeout=5.0)
    task = asyncio.create_task(r.resolve(_req("inv-deny0001")))
    await _wait_until_prompted(sent)
    assert reg.resolve(short_id_for("inv-deny0001"), "room-A", False) is True
    d = await task
    assert d.behavior == "deny"


@pytest.mark.anyio
async def test_ask_timeout_denies_and_records_timeout(tmp_db):
    reg = KnoxApprovalRegistry()
    sent: list = []
    r = _resolver(reg, sent, mode="ask", timeout=0.05)
    d = await r.resolve(_req("inv-timeout01"))
    assert d.behavior == "deny"
    row = state.approval_audit_get("inv-timeout01")
    assert row is not None and row["decision"] == "timeout"


@pytest.mark.anyio
async def test_registry_rejects_wrong_room(tmp_db):
    reg = KnoxApprovalRegistry()
    sent: list = []
    r = _resolver(reg, sent, mode="ask", timeout=5.0)
    task = asyncio.create_task(r.resolve(_req("inv-room0001")))
    await _wait_until_prompted(sent)
    # 다른 방에서 같은 short id 로 승인 시도 → 매칭 안 됨
    assert reg.resolve(short_id_for("inv-room0001"), "room-OTHER", True) is False
    # 올바른 방에서 거부로 마무리
    assert reg.resolve(short_id_for("inv-room0001"), "room-A", False) is True
    d = await task
    assert d.behavior == "deny"
