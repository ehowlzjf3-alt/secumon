"""candidate ledger — 침묵(과소보고) 방지 장부 + 등록형 counter 훅 + 배선."""
from __future__ import annotations

import asyncio
import uuid
from typing import ClassVar

import pytest
from pydantic import BaseModel

from secu_agent.agent.candidate_ledger import (
    CandidateCounter,
    build_candidate_ledger_reminder,
    candidate_ledger_stats,
    candidate_ledger_unreconciled,
    has_candidate_counters,
    record_candidates_accounted,
    record_candidates_seen,
    register_candidate_counter,
    run_candidate_counters,
    unregister_candidate_counter,
)
from secu_agent.agent.tools.base import (
    EmptyInput, Tool, ToolContext, ToolError, ToolInvocation, ToolResult,
    ToolSuccess,
)
from secu_agent.agent.tools.invoker import invoke_tool
from secu_agent.agent.tools.registry import ToolRegistry


# ── 장부 기록/통계 ────────────────────────────────────────────────────────────
def test_record_and_stats():
    md: dict = {}
    record_candidates_seen(md, source_tool="scan_text", count=22)
    record_candidates_seen(md, source_tool="other", count=3)
    record_candidates_accounted(md, bucket="submitted", count=2)
    record_candidates_accounted(md, bucket="triaged", count=5)
    assert candidate_ledger_stats(md) == (25, 2, 5)
    assert md["candidate_ledger"]["sources"] == {"scan_text": 22, "other": 3}


def test_record_zero_or_negative_is_noop():
    md: dict = {}
    record_candidates_seen(md, source_tool="t", count=0)
    record_candidates_seen(md, source_tool="t", count=-4)
    record_candidates_accounted(md, bucket="triaged", count=0)
    assert candidate_ledger_stats(md) == (0, 0, 0)
    assert "candidate_ledger" not in md  # no-op 은 장부 자체를 만들지 않는다


def test_stats_defensive_on_corrupt_ledger():
    assert candidate_ledger_stats({"candidate_ledger": "broken"}) == (0, 0, 0)
    assert candidate_ledger_stats(
        {"candidate_ledger": {"seen": "NaN", "submitted": None}}
    ) == (0, 0, 0)


def test_samples_bounded_and_deduped():
    md: dict = {}
    record_candidates_seen(
        md, source_tool="t", count=1, samples=("a", "a", "b"),
    )
    for i in range(50):
        record_candidates_seen(
            md, source_tool="t", count=1, samples=(f"s{i}",),
        )
    samples = md["candidate_ledger"]["samples"]
    assert samples[:3] == ["a", "b", "s0"]
    assert len(samples) <= 20


def test_accounted_invalid_bucket_raises():
    with pytest.raises(ValueError):
        record_candidates_accounted({}, bucket="seen", count=1)  # type: ignore[arg-type]


# ── 리마인더(게이트 조건) ─────────────────────────────────────────────────────
def _silent_md() -> dict:
    md: dict = {"candidate_ledger_enforce": True}
    record_candidates_seen(md, source_tool="scan_text", count=22,
                           samples=("pii/rrn@page1",))
    return md


def test_reminder_fires_on_pure_silence():
    text = build_candidate_ledger_reminder(_silent_md(), triage_available=True)
    assert text is not None
    assert "22 candidate" in text
    assert "scan_text=22" in text
    assert "triage_candidates" in text
    assert "pii/rrn@page1" in text


def test_reminder_requires_enforce_flag():
    md = _silent_md()
    md.pop("candidate_ledger_enforce")
    assert build_candidate_ledger_reminder(md, triage_available=True) is None


def test_reminder_requires_triage_tool_in_registry():
    # skill lockstep 전(도메인 toolset 에 triage 미노출) — 이행 불가능한 요구 금지.
    assert build_candidate_ledger_reminder(
        _silent_md(), triage_available=False,
    ) is None


def test_any_accounting_clears_gate_documented_gap():
    # total-silence 설계(codex 2R): 어떤 accounting 이든 1건 일어나면 게이트 off.
    # 이것이 알려진 narrow under-block 절충(정확-카운트 대조의 over-block/재점검
    # 루프 대신 택함). submitted 든 triaged 든 1건이면 침묵 아님.
    md = _silent_md()
    record_candidates_accounted(md, bucket="submitted", count=1)
    assert build_candidate_ledger_reminder(md, triage_available=True) is None

    md2 = _silent_md()
    record_candidates_accounted(md2, bucket="triaged", count=1)
    assert build_candidate_ledger_reminder(md2, triage_available=True) is None


def test_reminder_none_when_nothing_seen():
    md: dict = {"candidate_ledger_enforce": True}
    assert build_candidate_ledger_reminder(md, triage_available=True) is None


def test_unreconciled_helper_mirrors_gate_condition():
    # terminal 즉시-break 러너(skill run_agent)가 쓰는 판정 — 게이트 조건에서
    # triage_available 만 뺀 것(total-silence: seen>0 & 제출·기각 0)과 동일해야.
    assert candidate_ledger_unreconciled(_silent_md())

    md = _silent_md()
    md.pop("candidate_ledger_enforce")
    assert not candidate_ledger_unreconciled(md)

    # 어떤 accounting 이든 1건이면 total-silence 아님 → reconciled(문서화된 절충).
    md = _silent_md()
    record_candidates_accounted(md, bucket="submitted", count=1)
    assert not candidate_ledger_unreconciled(md)

    md = _silent_md()
    record_candidates_accounted(md, bucket="triaged", count=1)
    assert not candidate_ledger_unreconciled(md)

    assert not candidate_ledger_unreconciled({"candidate_ledger_enforce": True})


# ── 등록형 counter 훅 ────────────────────────────────────────────────────────
@pytest.fixture
def _counter_cleanup():
    names: list[str] = []
    yield names
    for name in names:
        unregister_candidate_counter(name)


def test_counter_register_duplicate_name_raises(_counter_cleanup):
    c = CandidateCounter(
        name="dup", tool_name="t", bucket="seen", count=lambda i, r: 1,
    )
    register_candidate_counter(c)
    _counter_cleanup.append("dup")
    with pytest.raises(ValueError):
        register_candidate_counter(CandidateCounter(
            name="dup", tool_name="t", bucket="seen", count=lambda i, r: 1,
        ))


def test_counter_name_globally_unique(_counter_cleanup):
    # codex #20: 같은 name 을 다른 tool 에 허용하면 unregister(name) 이 양쪽을
    # 지운다 — 등록 시점에 전역 유일 강제.
    register_candidate_counter(CandidateCounter(
        name="shared", tool_name="toolA", bucket="seen", count=lambda i, r: 1,
    ))
    _counter_cleanup.append("shared")
    with pytest.raises(ValueError):
        register_candidate_counter(CandidateCounter(
            name="shared", tool_name="toolB", bucket="seen", count=lambda i, r: 1,
        ))


def test_counter_invalid_bucket_raises():
    with pytest.raises(ValueError):
        CandidateCounter(name="x", tool_name="t", bucket="nope",  # type: ignore[arg-type]
                         count=lambda i, r: 1)


def test_has_and_unregister(_counter_cleanup):
    assert not has_candidate_counters("mytool")
    register_candidate_counter(CandidateCounter(
        name="c1", tool_name="mytool", bucket="seen", count=lambda i, r: 1,
    ))
    _counter_cleanup.append("c1")
    assert has_candidate_counters("mytool")
    unregister_candidate_counter("c1")
    assert not has_candidate_counters("mytool")


def test_run_counters_bucket_routing_and_isolation(_counter_cleanup):
    register_candidate_counter(CandidateCounter(
        name="boom", tool_name="search", bucket="seen",
        count=lambda i, r: 1 / 0,  # 예외 — 격리돼야 함
    ))
    register_candidate_counter(CandidateCounter(
        name="seen-total", tool_name="search", bucket="seen",
        count=lambda i, r: int(i["n"]),
    ))
    register_candidate_counter(CandidateCounter(
        name="mutator", tool_name="search", bucket="triaged",
        count=lambda i, r: i.clear() or 0,  # 입력 변조 시도 — deep copy 라 무해
    ))
    _counter_cleanup.extend(["boom", "seen-total", "mutator"])
    original_input = {"n": 7}
    md: dict = {}
    run_candidate_counters("search", original_input, "result", md)
    assert candidate_ledger_stats(md) == (7, 0, 0)
    assert original_input == {"n": 7}  # 원본 입력 불변


# ── invoker 배선 (ToolSuccess 후에만 counter 실행) ────────────────────────────
class _OkTool(Tool[EmptyInput]):
    name: ClassVar[str] = "ledger_ok"
    description: ClassVar[str] = "test"
    input_model: ClassVar[type[BaseModel]] = EmptyInput
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input, context) -> ToolResult:
        return ToolSuccess(content="found 3 things")


class _ErrTool(Tool[EmptyInput]):
    name: ClassVar[str] = "ledger_err"
    description: ClassVar[str] = "test"
    input_model: ClassVar[type[BaseModel]] = EmptyInput
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input, context) -> ToolResult:
        return ToolError(kind="execution", message="nope")


def _invoke(name: str, ctx: ToolContext) -> ToolResult:
    registry = ToolRegistry()
    registry.register(_OkTool)
    registry.register(_ErrTool)
    return asyncio.run(invoke_tool(
        ToolInvocation(id=uuid.uuid4().hex, name=name, input={}), registry, ctx,
    ))


def test_invoker_runs_counters_on_success(tmp_path, _counter_cleanup):
    register_candidate_counter(CandidateCounter(
        name="ok-counter", tool_name="ledger_ok", bucket="seen",
        count=lambda i, r: 3 if "3 things" in r else 0,
    ))
    _counter_cleanup.append("ok-counter")
    ctx = ToolContext(evidence_dir=tmp_path, metadata={})
    result = _invoke("ledger_ok", ctx)
    assert isinstance(result, ToolSuccess)
    assert candidate_ledger_stats(ctx.metadata) == (3, 0, 0)


def test_invoker_skips_counters_on_error(tmp_path, _counter_cleanup):
    register_candidate_counter(CandidateCounter(
        name="err-counter", tool_name="ledger_err", bucket="seen",
        count=lambda i, r: 99,
    ))
    _counter_cleanup.append("err-counter")
    ctx = ToolContext(evidence_dir=tmp_path, metadata={})
    result = _invoke("ledger_err", ctx)
    assert isinstance(result, ToolError)
    assert candidate_ledger_stats(ctx.metadata) == (0, 0, 0)


# ── 코어 도구 직접 배선 (scan_text seen 기록) ─────────────────────────────────
def test_scan_text_records_seen(tmp_path, monkeypatch):
    from secu_agent.agent.tools import scan_text as scan_text_mod

    class _Hit:
        category = "pii"
        kind = "rrn"
        masked = "******"
        line_no = 1
        line_preview = "x"

    class _Result:
        hits = [_Hit(), _Hit()]
        bytes_scanned = 10

    monkeypatch.setattr(scan_text_mod, "scan_text", lambda *a, **k: _Result())
    ctx = ToolContext(evidence_dir=tmp_path, metadata={})
    tool = scan_text_mod.ScanTextTool()
    result = asyncio.run(tool.execute(
        scan_text_mod.ScanTextInput(text="dummy", label="page1"), ctx,
    ))
    assert isinstance(result, ToolSuccess)
    assert candidate_ledger_stats(ctx.metadata) == (2, 0, 0)
    assert "pii/rrn@page1" in ctx.metadata["candidate_ledger"]["samples"]
