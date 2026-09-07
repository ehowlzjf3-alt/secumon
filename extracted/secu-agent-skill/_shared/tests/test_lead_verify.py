"""리드의 닫힌 동사 — 좌표 in, 닫힌 결과 out (v3.99 §B).

## 무엇을 막는가

사용자 요구는 "리드가 구체적으로 시킬 수 있어야 한다" 였다. 임의 `tool + args` 로 풀면
경계가 무너진다 — `smb_task_python(code=…)` 하나면 본문 읽기 능력을 그대로 얻는다.
그래서 **동사 집합을 닫고**, 인자는 좌표만, 반환은 닫힌 enum 으로 고정한다.

## 이 파일이 지키는 사실

1. action 은 pydantic 단계에서 닫힌다 — 목록 밖은 도구에 도달하지 못한다.
2. 결과 문자열도 닫힌다 — 어댑터가 규격 밖 값을 주면 `error` 로 접는다.
3. 못 하는 큐는 **명시적 미지원** — 조용한 no-op 이 아니다.
4. 봉투는 닫힌 필드 집합 — 어댑터가 본문을 넣어도 안 실린다.
5. 블로킹 I/O 는 스레드로 벗긴다 — 안 그러면 `is_concurrency_safe=True` 가 거짓말이다.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import replace

import pytest
from pydantic import ValidationError
from secu_agent.agent.tools.base import ToolContext, ToolSuccess

from _shared.lead_adapter import (
    LeadAdapter, register_lead_adapter, unregister_lead_adapter,
)
from _shared.lead_tools import LEAD_DOMAIN_KEY, VerifyInput, VerifyTool
from _shared.lead_verbs import ACTIONS, RESULTS, build_verify_result, unsupported


@pytest.fixture()
def lead(tmp_path):
    seen: list = []

    def _verb(action, **kw):
        seen.append((action, kw))
        return {"performed": True, "result": "alive", "port": 445, "ms": 12}

    adapter = LeadAdapter(
        domain="verify_test", inspect_agent="fake", statuses=("pending",),
        claimable_statuses=("pending",),
        queue_label="테스트 큐",
        list_targets=lambda **kw: [], target_detail=lambda tid: {},
        scan_summary=lambda tid, **kw: {"source": "none", "total": 0},
        run_verb=_verb,
        delegate_input=lambda tid, scope: {}, set_status=lambda tid, st, **kw: {},
    )
    register_lead_adapter(adapter)
    ctx = ToolContext(evidence_dir=tmp_path,
                      metadata={LEAD_DOMAIN_KEY: adapter.domain})
    yield ctx, adapter, seen
    unregister_lead_adapter(adapter.domain)


def _call(ctx, **kw) -> dict:
    out = asyncio.run(VerifyTool().execute(VerifyInput(**kw), ctx))
    assert isinstance(out, ToolSuccess), out
    return json.loads(out.content)


# ── 동사 집합이 닫혀 있다 ─────────────────────────────────────────────

def test_action_is_closed_at_the_input_layer():
    """★ 모델이 지어낸 action 은 도구 몸통에 **도달하지 못한다**."""
    with pytest.raises(ValidationError):
        VerifyInput(action="run_python", target_id=1)
    with pytest.raises(ValidationError):
        VerifyInput(action="read_file", target_id=1)


def test_declared_actions_match_the_input_model():
    """`ACTIONS` 와 도구 입력이 갈리면 문서와 강제가 어긋난다."""
    import typing

    got = typing.get_args(VerifyInput.model_fields["action"].annotation)
    assert set(got) == set(ACTIONS)
    assert set(RESULTS) == set(ACTIONS), "결과 어휘가 없는 동사가 있다"


def test_arbitrary_tool_and_args_are_not_expressible():
    """경계의 요점 — 입력에 tool/code/args 같은 자리가 없다."""
    fields = set(VerifyInput.model_fields)
    assert fields == {"action", "target_id", "ref", "line_no"}


# ── 결과도 닫혀 있다 ──────────────────────────────────────────────────

def test_offspec_result_is_folded_to_error(lead):
    ctx, adapter, _ = lead
    unregister_lead_adapter(adapter.domain)
    register_lead_adapter(replace(
        adapter, run_verb=lambda a, **k: {"performed": True, "result": "완전히_새로운_값"}))
    try:
        got = _call(ctx, action="reachable", target_id=1)
        assert got["result"] == "error"
        assert "규격 밖" in got["detail"]
    finally:
        unregister_lead_adapter(adapter.domain)
        register_lead_adapter(adapter)


def test_unsupported_is_explicit_not_silent():
    got = build_verify_result(action="reachable", target_id=1, ref=None,
                              raw=unsupported("reachable", "이 큐는 못 한다"))
    assert got["performed"] is False
    assert got["result"] == "unsupported"
    assert got["detail"] == "이 큐는 못 한다"


def test_adapter_exception_becomes_error_without_leaking(lead):
    """예외 문자열에 좌표·값이 실릴 수 있다 — 타입 이름만 남긴다."""
    ctx, adapter, _ = lead
    unregister_lead_adapter(adapter.domain)

    def _boom(action, **kw):
        raise RuntimeError("smb://10.1.2.3/Share/secret.txt 읽다 실패 password=hunter2")

    register_lead_adapter(replace(adapter, run_verb=_boom))
    try:
        got = _call(ctx, action="reachable", target_id=1)
        assert got["result"] == "error" and got["detail"] == "RuntimeError"
        assert "hunter2" not in json.dumps(got, ensure_ascii=False)
        assert "10.1.2.3" not in json.dumps(got, ensure_ascii=False)
    finally:
        unregister_lead_adapter(adapter.domain)
        register_lead_adapter(adapter)


# ── 봉투 ──────────────────────────────────────────────────────────────

def test_envelope_is_a_closed_field_set(lead):
    ctx, adapter, _ = lead
    unregister_lead_adapter(adapter.domain)
    register_lead_adapter(replace(adapter, run_verb=lambda a, **k: {
        "performed": True, "result": "alive", "port": 445, "ms": 3,
        "body": "DB_HOST=prod-db-01 내부 설계 문서 본문", "raw": "본문", "banner": "SMB 3.1.1"}))
    try:
        got = _call(ctx, action="reachable", target_id=7, ref="/x/y.conf")
        assert set(got) <= {"action", "target_id", "performed", "result",
                            "ref", "detail", "port", "ms"}
        blob = json.dumps(got, ensure_ascii=False)
        assert "본문" not in blob and "prod-db-01" not in blob
        assert got["ref"] == "/x/y.conf" and got["port"] == 445
    finally:
        unregister_lead_adapter(adapter.domain)
        register_lead_adapter(adapter)


def test_coordinates_reach_the_adapter(lead):
    ctx, _adapter, seen = lead
    _call(ctx, action="reachable", target_id=9, ref="a/b.conf", line_no=340)
    assert seen == [("reachable", {"target_id": 9, "ref": "a/b.conf", "line_no": 340})]


def test_detail_is_capped():
    from _shared.lead_verbs import MAX_DETAIL

    got = build_verify_result(action="reachable", target_id=1, ref=None, raw={
        "performed": False, "result": "skipped", "detail": "가" * 900})
    assert len(got["detail"]) == MAX_DETAIL


# ── 블로킹 I/O 는 스레드로 ────────────────────────────────────────────

def test_blocking_io_is_offloaded_to_a_thread():
    """★ `is_concurrency_safe=True` 의 **근거**가 to_thread 다.

    소켓 connect 를 이벤트 루프에서 직접 부르면 다른 세션의 ask 까지 멈춘다 —
    플래그는 True 인데 실제로는 직렬이 되는, 조용히 느려지는 종류의 거짓말이다.
    """
    import inspect

    src = inspect.getsource(VerifyTool._run)
    assert "asyncio.to_thread" in src


def test_verify_is_not_marked_read_only():
    """관측만 하지만 **바깥으로 나간다**(TCP connect) — 감사에서 지워지면 안 된다."""
    assert VerifyTool.is_read_only is False
    assert VerifyTool.is_concurrency_safe is True


# ── 5어댑터 규격 ──────────────────────────────────────────────────────

def _adapters():
    from domains.dev_web.plugin.lead_adapter import dev_web_lead_adapter
    from domains.services.confluence.plugin.lead_adapter import (
        confluence_lead_adapter, confluence_search_lead_adapter,
    )
    from domains.services.github.plugin.lead_adapter import github_lead_adapter
    from domains.smb.plugin.lead_adapter import smb_lead_adapter

    return [("smb", smb_lead_adapter), ("dev_web", dev_web_lead_adapter),
            ("github", github_lead_adapter), ("confluence", confluence_lead_adapter),
            ("confluence_search", confluence_search_lead_adapter)]


@pytest.mark.parametrize("name,factory", _adapters())
def test_every_adapter_supplies_run_verb(name, factory):
    fn = factory().run_verb
    assert callable(fn)
    import inspect

    params = inspect.signature(fn).parameters
    for kw in ("target_id", "ref", "line_no"):
        assert kw in params, f"{name}.run_verb 에 {kw} 가 없다"


@pytest.mark.parametrize("name,factory", _adapters())
def test_unknown_action_is_unsupported_everywhere(name, factory):
    """★ 새 동사를 추가했는데 어떤 큐가 안 고쳐지면 **조용히** no-op 이 되면 안 된다."""
    got = factory().run_verb("아직_없는_동사", target_id=1, ref=None, line_no=None)
    assert got["result"] == "unsupported", (name, got)
    assert got.get("detail"), f"{name} 이 이유를 안 말한다"


@pytest.mark.parametrize("name", ["github", "confluence", "confluence_search"])
def test_shared_host_queues_refuse_reachable(name):
    """★ github/confluence 는 타깃이 호스트를 공유해 도달성이 **항상 alive** 다.

    실측에서 그 큐들의 실패는 도달성이 아니라 권한(SSO 벽 / HTTP 403)이었다.
    항상 alive 를 돌려주는 동사는 정보가 0이면서 "봐도 된다" 는 잘못된 신호를 준다.
    """
    factory = dict(_adapters())[name]
    got = factory().run_verb("reachable", target_id=1, ref=None, line_no=None)
    assert got["result"] == "unsupported", got
    assert "권한" in got["detail"] or "403" in got["detail"]
