"""memory_recall / memory_save master 도구.

master agent 가 share 시작 시 recall → 시스템 메시지/사용자 메시지에 합쳐짐.
share 끝날 때 (또는 중간 발견 시) memory_save 로 영속.
"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _register_domain_memory_scopes():
    """de-domain v3.84 #5: host/share/path_pattern 은 코어 base 가 아니라 도메인 등록형
    scope 다 (코어 base = global/operator). 이 도메인 테스트는 plugin 이 등록했을 scope
    를 명시 등록한다 — 부트스트랩 미로드 상황에서도 memory_add 검증을 통과하도록."""
    from secu_agent import state
    for s in ("host", "share", "path_pattern"):
        state.register_memory_scope(s)
    yield
    for s in ("host", "share", "path_pattern"):
        state.unregister_memory_scope(s)


def _ctx(metadata: dict, tmp_path: Path | None = None):
    from secu_agent.agent.tools.base import ToolContext
    return ToolContext(evidence_dir=tmp_path or Path("/tmp"), metadata=metadata)


def _invoke(tool, raw_input: dict, ctx):
    from secu_agent.agent.tools.base import ToolError
    from pydantic import ValidationError
    try:
        validated = type(tool).input_model.model_validate(raw_input)
    except ValidationError as e:
        return ToolError(kind="validation", message=str(e))
    return asyncio.run(tool.execute(validated, ctx))


# ============================================================
# memory_recall
# ============================================================

def test_memory_recall_returns_matching_rules(tmp_db, seed, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.base import ToolSuccess
    from domains.smb.plugin.tools.master_tools import MemoryRecallTool

    sid = seed.share(host="10.0.0.5", share="print$")
    # 매칭 룰들
    state.memory_add(scope="host", key="10.0.0.5",
                     rule="dev sandbox host", severity_hint="informational")
    state.memory_add(scope="share", key="10.0.0.5:print$",
                     rule="standard driver share",
                     severity_hint="informational")
    state.memory_add(scope="global", key="*",
                     rule=".env 발견 시 본문 확인")
    # 매칭 안 됨
    state.memory_add(scope="host", key="9.9.9.9", rule="다른 host")

    tool = MemoryRecallTool()
    ctx = _ctx({"master_share_id": sid, "master_host": "10.0.0.5",
                "master_share": "print$"}, tmp_path=tmp_path)
    result = _invoke(tool, {}, ctx)

    assert isinstance(result, ToolSuccess), getattr(result, "message", result)
    content = result.content
    assert "dev sandbox" in content
    assert "standard driver" in content
    assert ".env" in content
    assert "다른 host" not in content


def test_memory_recall_with_path_samples_matches_path_pattern(tmp_db, seed, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.base import ToolSuccess
    from domains.smb.plugin.tools.master_tools import MemoryRecallTool

    sid = seed.share(host="1.1.1.1", share="A")
    state.memory_add(scope="path_pattern", key="정유준님",
                     rule="개인 폴더 — high default", severity_hint="high")
    state.memory_add(scope="path_pattern", key="홍길동", rule="다른 사람")

    tool = MemoryRecallTool()
    ctx = _ctx({"master_share_id": sid, "master_host": "1.1.1.1",
                "master_share": "A"}, tmp_path=tmp_path)
    result = _invoke(tool, {
        "path_samples": ["정유준님/PMIC.xlsx", "common/readme.txt"],
    }, ctx)

    assert isinstance(result, ToolSuccess)
    assert "개인 폴더" in result.content
    assert "홍길동" not in result.content


def test_memory_recall_empty_returns_friendly_message(tmp_db, seed, tmp_path):
    from secu_agent.agent.tools.base import ToolSuccess
    from domains.smb.plugin.tools.master_tools import MemoryRecallTool

    sid = seed.share(host="1.1.1.1", share="A")
    tool = MemoryRecallTool()
    ctx = _ctx({"master_share_id": sid, "master_host": "1.1.1.1",
                "master_share": "A"}, tmp_path=tmp_path)
    result = _invoke(tool, {}, ctx)
    assert isinstance(result, ToolSuccess)
    # 빈 결과면 명시적으로 알려주기 — agent 가 "찾은 룰 없음" 알아야 함
    assert "no" in result.content.lower() or "없음" in result.content or "empty" in result.content.lower()


def test_memory_recall_touches_hit_count(tmp_db, seed, tmp_path):
    from secu_agent import state
    from domains.smb.plugin.tools.master_tools import MemoryRecallTool

    sid = seed.share(host="1.1.1.1", share="A")
    mid = state.memory_add(scope="host", key="1.1.1.1", rule="r")

    tool = MemoryRecallTool()
    ctx = _ctx({"master_share_id": sid, "master_host": "1.1.1.1",
                "master_share": "A"}, tmp_path=tmp_path)
    _invoke(tool, {}, ctx)
    assert state.memory_get(mid)["hit_count"] == 1


# ============================================================
# memory_save
# ============================================================

def test_memory_save_persists_rule(tmp_db, seed, tmp_path):
    from secu_agent import state
    from secu_agent.agent.tools.base import ToolSuccess
    from domains.smb.plugin.tools.master_tools import MemorySaveTool

    sid = seed.share(host="1.1.1.1", share="A")
    tool = MemorySaveTool()
    ctx = _ctx({"master_share_id": sid, "master_host": "1.1.1.1",
                "master_share": "A"}, tmp_path=tmp_path)
    result = _invoke(tool, {
        "scope": "share",
        "key": "1.1.1.1:A",
        "rule": "이 share 는 팀 공유 — 분기마다 confirm 필요",
        "severity_hint": "medium",
        "tags": ["team_share"],
    }, ctx)

    assert isinstance(result, ToolSuccess), getattr(result, "message", result)
    rows = state.memory_search(scope="share")
    assert len(rows) == 1
    assert rows[0]["rule"].startswith("이 share 는")
    assert rows[0]["severity_hint"] == "medium"
    assert rows[0]["source"] == "master_agent"


def test_memory_save_rejects_invalid_scope(tmp_db, seed, tmp_path):
    from secu_agent.agent.tools.base import ToolError
    from domains.smb.plugin.tools.master_tools import MemorySaveTool

    sid = seed.share(host="1.1.1.1", share="A")
    result = _invoke(MemorySaveTool(), {
        "scope": "weird", "key": "x", "rule": "x",
    }, _ctx({"master_share_id": sid}, tmp_path=tmp_path))
    assert isinstance(result, ToolError)


def test_memory_save_upserts_same_scope_key(tmp_db, seed, tmp_path):
    from secu_agent import state
    from domains.smb.plugin.tools.master_tools import MemorySaveTool

    sid = seed.share(host="1.1.1.1", share="A")
    tool = MemorySaveTool()
    ctx = _ctx({"master_share_id": sid}, tmp_path=tmp_path)

    _invoke(tool, {"scope": "host", "key": "1.1.1.1", "rule": "v1"}, ctx)
    _invoke(tool, {"scope": "host", "key": "1.1.1.1",
                   "rule": "v2 — 업데이트됨"}, ctx)
    rows = state.memory_search(scope="host")
    assert len(rows) == 1
    assert "v2" in rows[0]["rule"]


def test_memory_save_share_scope_requires_host_in_key(tmp_db, seed, tmp_path):
    """share scope 의 key 는 'host:share' 형식이어야 함 — recall 매칭 위해."""
    from secu_agent.agent.tools.base import ToolError
    from domains.smb.plugin.tools.master_tools import MemorySaveTool

    sid = seed.share(host="1.1.1.1", share="A")
    result = _invoke(MemorySaveTool(), {
        "scope": "share", "key": "justaname", "rule": "x",
    }, _ctx({"master_share_id": sid}, tmp_path=tmp_path))
    assert isinstance(result, ToolError)
    assert "host:share" in result.message.lower() or "format" in result.message.lower()


# ============================================================
# registry
# ============================================================

def test_memory_tools_keep_their_registered_names(tmp_db):
    """구 `smb_share_master` 역할 레지스트리를 통해 확인하던 것 (2026-08-21 역할 은퇴).

    그 역할은 Phase 2 의 도메인 무관 리드가 대체했다. 메모리 도구 자체는 남아 있으므로
    이름 계약만 직접 고정한다 — 이름이 바뀌면 프롬프트/도구셋이 조용히 어긋난다.
    """
    from domains.smb.plugin.tools.master_tools import MemoryRecallTool, MemorySaveTool

    assert MemoryRecallTool.name == "memory_recall"
    assert MemorySaveTool.name == "memory_save"
