"""GuardedHarness — engine.run_query 위에 budget/limits/audit 감쌈.

책임:
- max_turns / max_tokens_total / max_wall_clock_sec 모니터링 → 초과 시 signal.set
- per-turn tool 호출 카운트 (web_fetch_per_turn) — engine이 turn마다 reset
- 모든 LLM/tool 이벤트 audit.log.jsonl에 SHA256 chain으로 기록
- LoopCompleted 결과 정리 (verdict.json 존재 여부, 누적 usage)
"""
from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import json
import logging
import math
import os as _os
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from secu_agent.agent.engine import QueryConfig, run_query
from secu_agent.agent.events import (
    LoopCompleted,
    LoopError,
    LoopEvent,
    TextChunk,
    ToolCallCompleted,
    ToolCallStarted,
    TurnStarted,
)
from secu_agent.agent.harness.activity import AgentActivityTracker
from secu_agent.agent.harness.audit import AuditLog
from secu_agent.agent.harness.budget import AgentBudget, AgentLimits
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import Message
from secu_agent.agent.tools.base import (
    ToolContext,
    ToolError,
    ToolSuccess,
)
from secu_agent.agent.tools.registry import ToolRegistry

log = logging.getLogger(__name__)


def _safe_audit_payload(obj: Any) -> Any:
    """ToolSuccess/ToolError 같은 dataclass도 직렬화 가능하게."""
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return {k: _safe_audit_payload(v) for k, v in dataclasses.asdict(obj).items()}
    if isinstance(obj, dict):
        return {k: _safe_audit_payload(v) for k, v in obj.items()}
    if isinstance(obj, list | tuple):
        return [_safe_audit_payload(v) for v in obj]
    if isinstance(obj, str | int | float | bool) or obj is None:
        return obj
    return repr(obj)


class GuardedHarness:
    """run_query를 감싸 가드 적용."""

    def __init__(
        self,
        *,
        client: LLMClient,
        registry: ToolRegistry,
        evidence_dir: Path,
        budget: AgentBudget | None = None,
        limits: AgentLimits | None = None,
    ):
        self.client = client
        self.registry = registry
        self.evidence_dir = evidence_dir
        self.budget = budget or AgentBudget()
        self.limits = limits or AgentLimits()
        # audit log은 evidence_dir 안의 hidden subdir에 둠 — agent가 read_file/glob으로
        # 자기 audit를 다시 흡수하는 걸 safe_path가 차단함 (.harness/ → hidden component 거부).
        self.audit = AuditLog(evidence_dir / ".harness" / "audit.log.jsonl")
        self.context = ToolContext(
            evidence_dir=evidence_dir,
            audit_log=self.audit,
            llm_client=client,
        )
        # disk size cap 스캔 throttle — 매 tool 완료마다 evidence dir 전체를
        # rglob+stat 하면 evidence가 쌓일수록 O(files)로 비싸진다.
        # 최근 계산값을 캐시하고 최대 interval초마다만 재-walk. (SA_ env로 override)
        self._dir_scan_interval_sec = _read_scan_interval_sec()
        self._last_dir_scan_ts: float | None = None
        self._last_dir_size_mb: float = 0.0

    def _evidence_size_mb(self) -> float:
        """size cap 체크용 evidence dir 크기(MB), throttle 적용.

        최근 계산값을 캐시하고 최대 self._dir_scan_interval_sec 초마다만 재-walk.
        첫 호출은 항상 스캔한다(캐시 없음).

        walk 실패 시: 조용히 0을 반환하면 size cap이 무력화되므로,
        경고를 남기고 '마지막으로 알려진 값'을 반환한다 — cap이 조용히
        뚫리지 않도록 보수적으로 처리.
        """
        now = time.monotonic()
        if (
            self._last_dir_scan_ts is not None
            and (now - self._last_dir_scan_ts) < self._dir_scan_interval_sec
        ):
            return self._last_dir_size_mb
        try:
            size = _dir_size_mb(self.evidence_dir)
        except OSError as e:
            # 다음 재시도까지 throttle을 걸어 로그 폭주를 막고,
            # 0 대신 마지막으로 알려진 값을 유지해 cap을 보존한다.
            self._last_dir_scan_ts = now
            log.warning(
                "evidence dir size scan failed (%s); keeping last known %.2f MB "
                "so the disk cap is not silently bypassed",
                e, self._last_dir_size_mb,
            )
            return self._last_dir_size_mb
        self._last_dir_size_mb = size
        self._last_dir_scan_ts = now
        return size

    async def run(
        self,
        *,
        initial_messages: list[Message],
        system: str | None = None,
    ) -> AsyncIterator[LoopEvent]:
        """이벤트 stream + 가드 트립 시 즉시 signal.set."""
        start = time.monotonic()
        cumulative_in = 0
        cumulative_out = 0
        # turn별 LLM 텍스트 누적 — turn 경계나 tool 호출 시점에 flush.
        text_buf: list[str] = []
        cur_turn = 0

        def _flush_text() -> None:
            if not text_buf:
                return
            txt = "".join(text_buf)
            text_buf.clear()
            if txt.strip():
                self.audit.append("assistant_text", {
                    "turn": cur_turn,
                    # tab 사이 텍스트가 너무 크면 자름 (12KB cap)
                    "text": txt if len(txt) <= 12_000 else txt[:12_000] + "…(truncated)",
                })

        # v3.31: backend task (CLI / scheduler / eval) 는 high — UX 시간 부담 없고
        # 정확도 우선. env SA_TASK_REASONING_EFFORT 로 override.
        re = _os.environ.get("SA_TASK_REASONING_EFFORT", "high")
        cfg = QueryConfig(
            max_turns=self.budget.max_turns,
            max_tokens_per_call=16384,
            temperature=0.0,
            reasoning_effort=re,
            # Front-D: 등급은 client(=profile 로 구성)에서 파생 — 모든 loop 경로 단일 소스.
            harness_tier=getattr(self.client, "harness_tier", None),
        )

        activity = AgentActivityTracker()
        activity.touch("agent_start")
        # #32: 오래 블로킹하는 도구가 자식의 진척을 부모 타이머에 되먹일 수 있게 한다.
        # 훅을 안 부르면 예전 그대로 idle 이 발동한다 — 이건 heartbeat 이 아니다.
        self.context.progress = activity.touch
        self.context.idle_budget_sec = float(self.budget.max_idle_sec)
        self.audit.append("agent_start", {
            "evidence_dir": str(self.evidence_dir),
            "tools": [t.name for t in self.registry.all()],
            "budget": dataclasses.asdict(self.budget),
            "limits": dataclasses.asdict(self.limits),
            "activity": activity.summary(),
        })

        def _handle_event(ev: LoopEvent) -> None:
            nonlocal cumulative_in, cumulative_out, cur_turn
            activity.touch(ev.type)

            # wall clock 검사
            elapsed = time.monotonic() - start
            if elapsed > self.budget.max_wall_clock_sec:
                self.audit.append("budget_trip", {
                    "kind": "wall_clock",
                    "elapsed_sec": elapsed,
                    "limit_sec": self.budget.max_wall_clock_sec,
                })
                self.context.signal.set()

            # disk 검사 (몇 turn마다 — 매 이벤트 du는 비싸니 ToolCallCompleted에서만)
            if isinstance(ev, ToolCallCompleted):
                used_mb = self._evidence_size_mb()
                if used_mb > self.budget.max_disk_mb:
                    self.audit.append("budget_trip", {
                        "kind": "disk", "used_mb": used_mb,
                        "limit_mb": self.budget.max_disk_mb,
                    })
                    self.context.signal.set()

            # per-turn 도구 카운트 검사 (web_fetch)
            if isinstance(ev, ToolCallStarted):
                if ev.name == "web_fetch":
                    cur = self.context.per_turn_counts.get("web_fetch", 0) + 1
                    if cur > self.limits.web_fetch_per_turn:
                        self.audit.append("limit_trip", {
                            "kind": "web_fetch_per_turn",
                            "count": cur, "limit": self.limits.web_fetch_per_turn,
                        })
                        self.context.signal.set()

            # audit 기록
            if isinstance(ev, TurnStarted):
                # 직전 turn에 남은 텍스트 flush
                _flush_text()
                cur_turn = ev.turn
                self.audit.append("turn_started", {"turn": ev.turn, "elapsed_sec": elapsed})
            elif isinstance(ev, ToolCallStarted):
                # 도구 호출 전에 텍스트 flush — assistant_text → tool_call_started 순서 보존
                _flush_text()
                self.audit.append("tool_call_started", {
                    "tool_use_id": ev.tool_use_id, "name": ev.name,
                    "input": _safe_audit_payload(ev.input),
                })
            elif isinstance(ev, ToolCallCompleted):
                outcome = "success" if isinstance(ev.result, ToolSuccess) else f"error:{ev.result.kind if isinstance(ev.result, ToolError) else '?'}"
                content = ev.result.content if isinstance(ev.result, ToolSuccess) else ""
                payload = {
                    "tool_use_id": ev.tool_use_id, "name": ev.name, "outcome": outcome,
                    "content_chars": len(content),
                    # frontend가 보여줄 미리보기 — 너무 크면 잘라 저장 (2KB cap).
                    "content_preview": content if len(content) <= 2_000 else content[:2_000] + "…(truncated)",
                }
                # #33: 거부 사유를 남긴다. 여태 ToolError 는 `outcome=error:validation`
                # + `content_preview=""` 로만 남아서, 증거만 봐서는 **왜** 거부됐는지
                # 알 수 없었다("0 chars"). 모델은 message 를 받아 읽는데 우리는 못 봤다 —
                # smb arcashield 개인키 3회 거부의 원인 규명이 그래서 오래 걸렸다.
                if isinstance(ev.result, ToolError):
                    msg = str(getattr(ev.result, "message", "") or "")
                    payload["error_message"] = (
                        msg if len(msg) <= 2_000 else msg[:2_000] + "…(truncated)")
                self.audit.append("tool_call_completed", payload)
            elif isinstance(ev, LoopCompleted):
                _flush_text()
                if ev.usage is not None:
                    cumulative_in = ev.usage.input_tokens
                    cumulative_out = ev.usage.output_tokens
                self.audit.append("loop_completed", {
                    "reason": ev.reason, "total_turns": ev.total_turns,
                    "input_tokens": cumulative_in, "output_tokens": cumulative_out,
                    "elapsed_sec": elapsed,
                    # #32: 정상 종료에도 activity 를 남긴다. 여태 budget_trip/loop_error
                    # 에만 있어서, 무엇이 런을 **살려 뒀는지**(예: subagent_progress 가
                    # 몇 번 들어왔는지)는 런이 죽어야만 볼 수 있었다.
                    "activity": activity.summary(),
                })
            elif isinstance(ev, LoopError):
                _flush_text()
                self.audit.append("loop_error", {"message": ev.message})
            elif isinstance(ev, TextChunk):
                text_buf.append(ev.text)

            # token cap (LoopCompleted에서만 누적 갱신되므로 거기서 검사)
            if isinstance(ev, LoopCompleted):
                total = cumulative_in + cumulative_out
                if total > self.budget.max_tokens_total:
                    self.audit.append("budget_trip", {
                        "kind": "tokens", "total": total,
                        "limit": self.budget.max_tokens_total,
                    })
                    self.context.signal.set()

        queue: asyncio.Queue[LoopEvent | Exception | object] = asyncio.Queue()
        sentinel = object()

        async def _produce_events() -> None:
            try:
                async for ev in run_query(
                    client=self.client,
                    registry=self.registry,
                    context=self.context,
                    initial_messages=initial_messages,
                    system=system,
                    config=cfg,
                    # 사전 unlock 화이트리스트(_unlock_all 등)를 run_query 에 전달 —
                    # 미전달 시 run_query 가 unlocked 를 빈 set 으로 덮어써 pre-unlock
                    # 이 조용히 소실된다(deferred 종료 도구 미광고 → 종료-도구 게이트
                    # 무력화 포함). 기본 context 는 빈 set 이라 non-skill 경로 무변(codex R2).
                    unlocked_tools=self.context.unlocked_tools,
                ):
                    await queue.put(ev)
            except Exception as e:
                await queue.put(e)
            finally:
                await queue.put(sentinel)

        producer = asyncio.create_task(_produce_events())
        check_interval = max(0.1, float(self.budget.idle_check_interval_sec))
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=check_interval)
                except asyncio.TimeoutError:
                    elapsed = time.monotonic() - start
                    if elapsed > self.budget.max_wall_clock_sec:
                        self.audit.append("budget_trip", {
                            "kind": "wall_clock",
                            "elapsed_sec": elapsed,
                            "limit_sec": self.budget.max_wall_clock_sec,
                        })
                        self.context.signal.set()
                    idle = activity.idle_seconds()
                    if self.budget.max_idle_sec > 0 and idle > self.budget.max_idle_sec:
                        _flush_text()
                        self.audit.append("budget_trip", {
                            "kind": "idle",
                            "idle_sec": idle,
                            "limit_sec": self.budget.max_idle_sec,
                            "activity": activity.summary(),
                        })
                        self.context.signal.set()
                        producer.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await producer
                        msg = (
                            f"harness idle timeout: no observable activity for "
                            f"{idle:.1f}s after {activity.last_event}"
                        )
                        yield LoopError(message=msg)
                        yield LoopCompleted(
                            reason="aborted",
                            total_turns=cur_turn,
                            final_message=None,
                            usage=None,
                        )
                        return
                    continue

                if item is sentinel:
                    return
                if isinstance(item, Exception):
                    _flush_text()
                    self.audit.append("loop_error", {
                        "message": f"run_query exception: {type(item).__name__}: {item}",
                        "activity": activity.summary(),
                    })
                    yield LoopError(
                        message=f"run_query exception: {type(item).__name__}: {item}",
                    )
                    yield LoopCompleted(
                        reason="aborted" if self.context.signal.is_set() else "stream_error",
                        total_turns=cur_turn,
                        final_message=None,
                        usage=None,
                    )
                    return

                ev = item
                _handle_event(ev)
                yield ev
        finally:
            if not producer.done():
                producer.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await producer


_DEFAULT_EVIDENCE_SIZE_SCAN_INTERVAL_SEC = 10.0


def _read_scan_interval_sec() -> float:
    """evidence size 스캔 throttle 간격(초). SA_EVIDENCE_SIZE_SCAN_INTERVAL_SEC로 override.

    파싱 실패/음수는 안전 기본값으로 fallback (기본 동작 보존).
    0이면 매번 스캔(=throttle 해제).
    """
    raw = _os.environ.get("SA_EVIDENCE_SIZE_SCAN_INTERVAL_SEC")
    if raw is None:
        return _DEFAULT_EVIDENCE_SIZE_SCAN_INTERVAL_SEC
    try:
        val = float(raw)
    except (TypeError, ValueError):
        log.warning(
            "invalid SA_EVIDENCE_SIZE_SCAN_INTERVAL_SEC=%r; using default %.1fs",
            raw, _DEFAULT_EVIDENCE_SIZE_SCAN_INTERVAL_SEC,
        )
        return _DEFAULT_EVIDENCE_SIZE_SCAN_INTERVAL_SEC
    # 음수/비유한(inf·nan) 은 기본값으로 — inf 는 첫 스캔 후 영영 재-walk 안 해
    # size cap 을 첫 값에 고정시키는 잠재적 우회다.
    if val < 0 or not math.isfinite(val):
        return _DEFAULT_EVIDENCE_SIZE_SCAN_INTERVAL_SEC
    return val


def _dir_size_mb(path: Path) -> float:
    """evidence dir 전체 크기(MB).

    스캔 도중 사라진 개별 파일(race)은 건너뛰되, walk 자체가 실패하면
    OSError를 호출자에게 전파한다 — 조용히 0을 돌려 size cap을 무력화하지
    않기 위함. (호출자 _evidence_size_mb 가 last-known 값으로 보수 처리)
    """
    total = 0
    for p in path.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            # 개별 파일이 스캔 중 삭제/권한변경 — 전체를 무효화하지 않고 skip.
            continue
    return total / (1024 * 1024)


def write_errored_finding(
    evidence_dir: Path, *, task_id: str, task_type: str, reason: str,
) -> None:
    """가드가 트립한 경우 fallback finding.json 작성."""
    target = evidence_dir / "finding.json"
    if target.exists():
        return  # LLM이 이미 submit했음
    target.write_text(
        json.dumps({
            "task_id": task_id,
            "task_type": task_type,
            "severity": "informational",
            "summary": f"agent harness aborted: {reason}",
            "asset_count_scanned": 0,
            "hits": [],
            "recommended_actions": [],
        }, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
