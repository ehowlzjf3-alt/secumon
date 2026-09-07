"""Finding-driven todo refinement policy.

This module is intentionally domain-neutral. Domain tools may translate their
own raw results into FindingSignal objects, but the engine/todo contract only
sees generic statuses and action classes.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal


FindingStatus = Literal["confirmed", "suspected", "inconclusive", "rejected"]
ActionClass = Literal["validate", "deep_dive", "report_update", "triage"]

_SEVERITY_RANK = {
    "critical": 4,
    "high": 3,
    "medium": 2,
    "low": 1,
    "informational": 0,
    "clean": -1,
}
_FOLLOWUP_STATUSES = {"confirmed", "suspected", "inconclusive"}


@dataclass(frozen=True, slots=True)
class FindingSignal:
    """Domain-neutral signal emitted by a tool after evidence is observed."""

    source_tool: str
    task_type: str
    asset: str
    summary: str
    severity: str = "informational"
    status: FindingStatus = "suspected"
    asset_kind: str = "asset"
    confidence: float | None = None
    finding_id: int | None = None
    evidence_ref: str | None = None
    recommended_actions: tuple[str, ...] = field(default_factory=tuple)
    raw_ref: str | None = None
    report_updated: bool = False
    # enricher 가 집계한 노출/신호 카운트 (record-only 요약). 하위호환 공개 필드 —
    # 도메인 어댑터가 FindingSignal(pivot_exposed=...) 로 구성한다. 코어 내러티브는
    # 더 이상 이 필드를 읽지 않고 register_followup_hint 로 이관됐지만(v3.85), 필드
    # 이름은 back-compat 로 유지. submit_finding 은 enricher descriptor 의
    # signal_count/exposed_count 합계를 여기 넣는다.
    pivot_exposed: int = 0
    # v3.76: 이 finding 에 4부 위험내용(risk_narrative)이 작성됐는지 (submit_finding 에서 set).
    has_narrative: bool = False

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["recommended_actions"] = list(self.recommended_actions)
        return data


@dataclass(frozen=True, slots=True)
class TodoSuggestion:
    action_class: ActionClass
    content: str
    reason: str
    priority: int
    source_finding_id: int | None = None
    source_asset: str | None = None

    def to_line(self) -> str:
        fid = f" finding_id={self.source_finding_id}" if self.source_finding_id else ""
        asset = f" asset={self.source_asset}" if self.source_asset else ""
        return (
            f"- {self.action_class}: {self.content} "
            f"(priority={self.priority}; {self.reason}{fid}{asset})"
        )


def append_finding_signal(
    metadata: dict[str, object],
    signal: FindingSignal,
    *,
    max_signals: int = 20,
) -> None:
    """Append a signal to session metadata and mark todo refinement pending."""

    signals = metadata.setdefault("finding_signals", [])
    if not isinstance(signals, list):
        signals = []
        metadata["finding_signals"] = signals
    signals.append(signal.to_dict())
    if len(signals) > max_signals:
        del signals[: len(signals) - max_signals]
    revision = int(metadata.get("finding_signal_revision", 0)) + 1
    metadata["finding_signal_revision"] = revision
    metadata["finding_followup_pending"] = True
    metadata["finding_followup_pending_revision"] = revision

    # v3.72: 하이브리드 reasoning 안전망 — HIGH/critical 신호는 에이전트가 deep_mode 를
    # 명시 호출하지 않아도 다음 pass 를 자동으로 xhigh 정밀추론으로 승급. 진짜 위험
    # 후보가 medium triage 에서 얕게 처리되는 걸 방지. (engine 이 카운터를 소진.)
    if _SEVERITY_RANK.get(signal.severity, 0) >= _SEVERITY_RANK["high"]:
        try:
            _rem = int(metadata.get("deep_passes_remaining", 0) or 0)
        except (TypeError, ValueError):
            _rem = 0
        metadata["deep_passes_remaining"] = max(_rem, 1)


def mark_finding_followup_addressed(metadata: dict[str, object]) -> None:
    """Mark pending finding follow-up as handled by an explicit todo write."""

    metadata["finding_followup_pending"] = False
    metadata["finding_followup_addressed_revision"] = int(
        metadata.get("finding_signal_revision", 0),
    )


def _coerce_signal(raw: object) -> FindingSignal | None:
    if isinstance(raw, FindingSignal):
        return raw
    if not isinstance(raw, dict):
        return None
    try:
        actions_raw = raw.get("recommended_actions") or ()
        if not isinstance(actions_raw, (list, tuple)):
            actions_raw = (str(actions_raw),)
        return FindingSignal(
            source_tool=str(raw.get("source_tool") or "unknown"),
            task_type=str(raw.get("task_type") or "unknown"),
            asset=str(raw.get("asset") or "(unknown asset)"),
            asset_kind=str(raw.get("asset_kind") or "asset"),
            severity=str(raw.get("severity") or "informational"),
            status=str(raw.get("status") or "suspected"),  # type: ignore[arg-type]
            confidence=(
                float(raw["confidence"]) if raw.get("confidence") is not None else None
            ),
            finding_id=(
                int(raw["finding_id"]) if raw.get("finding_id") is not None else None
            ),
            evidence_ref=(
                str(raw["evidence_ref"]) if raw.get("evidence_ref") is not None else None
            ),
            summary=str(raw.get("summary") or ""),
            recommended_actions=tuple(str(a) for a in actions_raw if str(a).strip()),
            raw_ref=str(raw["raw_ref"]) if raw.get("raw_ref") is not None else None,
            report_updated=bool(raw.get("report_updated")),
            pivot_exposed=int(raw.get("pivot_exposed") or 0),
            has_narrative=bool(raw.get("has_narrative")),
        )
    except (TypeError, ValueError):
        return None


def pending_finding_signals(metadata: dict[str, object]) -> list[FindingSignal]:
    if not metadata.get("finding_followup_pending"):
        return []
    raw_signals = metadata.get("finding_signals")
    if not isinstance(raw_signals, list):
        return []
    signals: list[FindingSignal] = []
    for raw in raw_signals:
        signal = _coerce_signal(raw)
        if signal is None or signal.status not in _FOLLOWUP_STATUSES:
            continue
        signals.append(signal)
    return signals


def build_todo_suggestions(signals: list[FindingSignal]) -> list[TodoSuggestion]:
    suggestions: list[TodoSuggestion] = []
    seen: set[tuple[str, str]] = set()

    def add(
        signal: FindingSignal,
        action_class: ActionClass,
        content: str,
        reason: str,
        priority: int,
        *,
        dedup_tag: str = "",
    ) -> None:
        # v3.76: dedup_tag 로 같은 action_class 라도 별개 suggestion 을 허용(narrative vs report).
        key = (action_class + dedup_tag, signal.asset)
        if key in seen:
            return
        seen.add(key)
        suggestions.append(TodoSuggestion(
            action_class=action_class,
            content=content[:500],
            reason=reason,
            priority=priority,
            source_finding_id=signal.finding_id,
            source_asset=signal.asset,
        ))

    for signal in signals:
        summary = signal.summary.strip() or "observed finding signal"
        sev_rank = _SEVERITY_RANK.get(signal.severity, 0)
        if signal.status in {"suspected", "inconclusive"}:
            add(
                signal,
                "validate",
                f"Validate evidence for {signal.asset}: {summary}",
                f"{signal.status} evidence needs confirmation",
                max(3, sev_rank + 3),
            )
            continue
        if signal.status == "confirmed" and sev_rank >= 2:
            add(
                signal,
                "deep_dive",
                f"Deep-dive impact and scope for {signal.asset}: {summary}",
                f"confirmed {signal.severity} finding",
                sev_rank + 3,
            )
        if signal.status == "confirmed" and not signal.report_updated:
            add(
                signal,
                "report_update",
                f"Update finding report and recommended actions for {signal.asset}",
                "confirmed finding requires operator-facing report state",
                sev_rank + 1,
            )
        # v3.76: confirmed + 고심각도인데 4부 위험내용이 비어있으면 채우기 제안 (additive).
        if signal.status == "confirmed" and sev_rank >= 3 and not signal.has_narrative:
            add(
                signal,
                "report_update",
                f"Fill 4-part risk narrative (위험내용) for {signal.asset}: {summary}",
                "confirmed high/critical finding has no risk_narrative — enrich_finding 으로 채워라",
                sev_rank + 2,
                dedup_tag="_narrative",
            )

    suggestions.sort(key=lambda item: (-item.priority, item.action_class, item.content))
    return suggestions


def build_finding_followup_reminder(
    metadata: dict[str, object],
    *,
    todo_available: bool,
    limit: int = 6,
) -> str | None:
    """Return a system reminder when findings need explicit todo refinement."""

    if not todo_available:
        return None
    signals = pending_finding_signals(metadata)
    if not signals:
        return None
    suggestions = build_todo_suggestions(signals)
    if not suggestions:
        return None
    # v3.85: 도메인-특화 후속행동 nudge(구 [PIVOT] 등)는 등록형 — 코어는 하드코딩
    # nudge 를 들지 않는다. 도메인 plugin 이 register_followup_hint 로 공급(enricher 와
    # 짝). 미등록(코어 단독)=hint 없음(도메인-프리 기본).
    from secu_agent.agent.finding_enrichment import run_followup_hints
    hint_lines = run_followup_hints(signals)
    if hint_lines:
        hint_lines = [*hint_lines, ""]
    lines = hint_lines + [
        "[SYSTEM NOTE] Prior tool calls produced finding signals that are still "
        "UNRESOLVED. A text-only answer is NOT acceptable yet — you must respond "
        "with a TOOL CALL that actually deep-dives the suspected asset: open the "
        "endpoint/record (browser_action navigate/click, web_fetch, or call the "
        "exposed API) and verify whether real data is exposed. If you confirm real "
        "data → submit_finding with the masked record. If after this attempt it is "
        "protected/empty → explicitly dismiss it (or submit_finding as 'suspected' "
        "with what you saw). Do NOT abandon the signal silently. You may also update "
        "the todo list with todo(action='write', merge=True) to track the deep-dive.",
        "",
        "Suggested follow-ups (each needs a real tool action, not just a note):",
    ]
    lines.extend(s.to_line() for s in suggestions[:limit])
    return "\n".join(lines)
