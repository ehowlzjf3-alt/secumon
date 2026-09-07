"""v3.81 T2: delivery sink 프로토콜 + egress 게이트.

확정 결정 ⑤ (a)-done-right (docs/design/v3.81-de-domain-autonomy.md):
- **코어 소유** = 전달 프로토콜(`deliver(sink_id, payload)`) + egress 게이트
  (수신자 allowlist · 마스킹/스캔 검증 · dry-run 기본 + 자율발송 opt-in).
- **plugin/skill 소유** = sink 별 어댑터(MCP/HTTP/file/git/웹폼…)와 포맷.
  코어 하드코딩 금지 — `register_delivery_sink` 등록형 (fanout 어댑터와
  같은 패턴). 예외: Knox Mail 은 KEEP 코어 채널이라 코어가 기본 등록.

확정 결정 ⑥ outbound 정책 = **dry-run 기본 + 자율 발송 opt-in**:
- 기본은 draft 생성(evidence_dir)·audit 기록만 — 외부로 안 나간다.
- 실발송 조건 (전부 충족, fail-closed):
  1. sink 가 `SA_DELIVERY_AUTOSEND_SINKS` (comma) 에 opt-in
  2. `SA_DELIVERY_AUTOSEND_CHARTERS` 설정 시 charter_ref 일치
  3. `SA_DELIVERY_RECIPIENT_ALLOW` 가 **설정돼 있고** 모든 수신자 매칭
     (미설정 = 자율발송 전면 불가 — allowlist 없는 egress 금지)
  4. 마스킹 후 secret/PII 스캔 hit 0 (잔존 hit = 발송 차단)
- 본문/제목은 발송 전 무조건 redact(env 값 + 패턴) — 평문 secret 의
  외부 유출 경로 차단 (마스킹 정책: 유형/분류만, 평문 금지).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Protocol, runtime_checkable

from secu_agent.agent.redact import redact_sensitive_text
from secu_agent.agent.secret_redact import redact_secrets

log = logging.getLogger(__name__)

AUTOSEND_SINKS_ENV = "SA_DELIVERY_AUTOSEND_SINKS"
AUTOSEND_CHARTERS_ENV = "SA_DELIVERY_AUTOSEND_CHARTERS"
RECIPIENT_ALLOW_ENV = "SA_DELIVERY_RECIPIENT_ALLOW"

DELIVERY_AUDIT_FILENAME = "delivery_audit.jsonl"


class DeliveryError(RuntimeError):
    """검증/게이트/sink 오류 — 호출부(도구)가 ToolError 로 변환."""


@dataclass(frozen=True, slots=True)
class DeliveryPayload:
    """sink 로 전달할 내용 — 도메인 무관 정규화 형태.

    metadata 는 sink 어댑터 전용 패스스루 (예: knox doc_secu_type).
    """

    subject: str
    body: str
    recipients: tuple[str, ...] = ()
    cc: tuple[str, ...] = ()
    finding_id: int | None = None
    metadata: Mapping[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class DeliveryResult:
    sink_id: str
    mode: Literal["sent", "dry_run"]
    detail: str
    reasons: tuple[str, ...] = ()      # dry-run 사유 / 차단 사유
    draft_path: str | None = None
    scan_hits: tuple[str, ...] = ()    # 마스킹 후 잔존 hit (category:kind)


@runtime_checkable
class DeliverySink(Protocol):
    """sink 어댑터 프로토콜 — 구현은 plugin/skill (Knox Mail 만 코어 기본).

    send 는 **게이트를 통과한 redacted payload** 만 받는다. 반환 = 사람용
    결과 요약 1줄. 실패는 예외 (DeliveryError 권장).
    """

    sink_id: str
    description: str

    async def send(self, payload: DeliveryPayload) -> str: ...


# ── sink 레지스트리 (등록형 — fanout 어댑터와 같은 패턴) ─────────────

_SINKS: dict[str, DeliverySink] = {}
_CORE_SINKS_LOADED = False


def register_delivery_sink(sink: DeliverySink) -> None:
    if sink.sink_id in _SINKS:
        raise ValueError(f"delivery sink {sink.sink_id!r} 이미 등록됨")
    _SINKS[sink.sink_id] = sink


def unregister_delivery_sink(sink_id: str) -> bool:
    return _SINKS.pop(sink_id, None) is not None


def get_delivery_sink(sink_id: str) -> DeliverySink | None:
    return _SINKS.get(sink_id)


def list_delivery_sinks() -> list[DeliverySink]:
    return [_SINKS[k] for k in sorted(_SINKS)]


def ensure_core_sinks() -> None:
    """코어 기본 sink 1회 등록 — Knox Mail (KEEP 채널).

    plugin sink 는 plugin 부트스트랩이 직접 register_delivery_sink.
    """
    global _CORE_SINKS_LOADED
    if _CORE_SINKS_LOADED:
        return
    _CORE_SINKS_LOADED = True
    try:
        from secu_agent.knox.mail_sink import KnoxMailSink
        if "knox_mail" not in _SINKS:
            register_delivery_sink(KnoxMailSink())
    except Exception as e:  # noqa: BLE001 — sink 부재가 다른 기능을 못 막음
        log.warning("knox_mail sink 등록 실패: %r", e)


# ── egress 게이트 ────────────────────────────────────────────────────


def _env_csv(name: str) -> tuple[str, ...]:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return ()
    return tuple(p.strip() for p in raw.split(",") if p.strip())


def _recipient_allowed(addr: str, allow: tuple[str, ...]) -> bool:
    """exact 주소 또는 도메인(suffix) 매칭. allow 비면 False (fail-closed)."""
    a = addr.strip().lower()
    if not a or not allow:
        return False
    domain = a.split("@", 1)[1] if "@" in a else a
    for entry in allow:
        e = entry.lower().lstrip("@")
        if a == e:
            return True
        if domain == e or domain.endswith("." + e):
            return True
    return False


def _redact(text: str) -> str:
    return redact_sensitive_text(redact_secrets(text), force=True)


def _metadata_allowed_pii_values(metadata: Mapping[str, Any] | None) -> frozenset[str]:
    """Exact PII values that are already part of an explicit delivery context.

    This is intentionally value-based, not kind-based: callers may not disable
    PII scanning wholesale. The main use is reply-style email quotes where the
    sender/recipient addresses must remain intact for thread context.
    """
    raw = (metadata or {}).get("delivery_allowed_pii_values")
    if not isinstance(raw, (list, tuple, set)):
        return frozenset()
    return frozenset(
        str(value).strip().lower()
        for value in raw
        if str(value or "").strip()
    )


def _scan_hits(
    text: str, *, allowed_pii_values: frozenset[str] | None = None,
) -> tuple[str, ...]:
    """마스킹 후 잔존 secret/PII — 평문 유출 차단의 마지막 층. fail-closed:
    스캐너 자체가 죽으면 'scan_error' hit 으로 발송을 막는다."""
    try:
        from secu_agent.detectors import scan_text
        result = scan_text(text)
        allowed = allowed_pii_values or frozenset()
        out: list[str] = []
        for h in result.hits:
            if h.category == "pii" and h.kind == "email" and h.span:
                matched = text[h.span[0]:h.span[1]].strip().lower()
                if matched in allowed:
                    continue
            out.append(f"{h.category}:{h.kind}")
        return tuple(out)
    except Exception as e:  # noqa: BLE001
        log.error("egress 스캔 실패 — 발송 차단: %r", e)
        return (f"scan_error:{type(e).__name__}",)


@dataclass(frozen=True, slots=True)
class EgressDecision:
    payload: DeliveryPayload          # redacted
    autosend: bool
    reasons: tuple[str, ...]          # autosend=False 인 이유들
    scan_hits: tuple[str, ...]


def apply_egress_gate(
    sink_id: str, payload: DeliveryPayload, *, charter_ref: str = "",
) -> EgressDecision:
    """검증 + 마스킹 + 자율발송 판정. 검증 실패는 DeliveryError."""
    recipients = tuple(r.strip() for r in payload.recipients if r and r.strip())
    cc = tuple(r.strip() for r in payload.cc if r and r.strip())
    if not recipients:
        raise DeliveryError("TO 수신자가 없습니다.")
    if not payload.subject.strip():
        raise DeliveryError("제목이 비어 있습니다.")
    if not payload.body.strip():
        raise DeliveryError("본문이 비어 있습니다.")

    redacted = DeliveryPayload(
        subject=_redact(payload.subject),
        body=_redact(payload.body),
        recipients=recipients,
        cc=cc,
        finding_id=payload.finding_id,
        metadata=payload.metadata,
    )

    reasons: list[str] = []
    hits = _scan_hits(
        redacted.subject + "\n" + redacted.body,
        allowed_pii_values=_metadata_allowed_pii_values(redacted.metadata),
    )
    if hits:
        reasons.append(
            f"마스킹 후 secret/PII 잔존 {len(hits)}건 — 발송 차단 "
            f"(유형: {', '.join(sorted(set(hits))[:5])})"
        )

    if sink_id not in _env_csv(AUTOSEND_SINKS_ENV):
        reasons.append(
            f"sink {sink_id!r} 자율발송 opt-in 아님 ({AUTOSEND_SINKS_ENV})"
        )
    charters = _env_csv(AUTOSEND_CHARTERS_ENV)
    if charters and charter_ref not in charters:
        reasons.append(
            f"charter {charter_ref!r} 자율발송 허용 목록 아님 "
            f"({AUTOSEND_CHARTERS_ENV})"
        )
    allow = _env_csv(RECIPIENT_ALLOW_ENV)
    if not allow:
        reasons.append(
            f"수신자 allowlist 미설정 ({RECIPIENT_ALLOW_ENV}) — "
            "allowlist 없는 자율 egress 금지"
        )
    else:
        bad = [r for r in (*recipients, *cc) if not _recipient_allowed(r, allow)]
        if bad:
            reasons.append(f"allowlist 밖 수신자: {', '.join(bad)}")

    return EgressDecision(
        payload=redacted,
        autosend=not reasons,
        reasons=tuple(reasons),
        scan_hits=hits,
    )


# ── deliver — 코어 진입점 ────────────────────────────────────────────


def _write_draft(
    evidence_dir: Path, sink_id: str, decision: EgressDecision,
    *, charter_ref: str,
) -> Path:
    ts = time.strftime("%Y%m%dT%H%M%S")
    nonce = uuid.uuid4().hex[:6]
    path = evidence_dir / f"delivery_draft-{ts}-{nonce}-{sink_id}.json"
    p = decision.payload
    path.write_text(json.dumps({
        "sink_id": sink_id,
        "charter_ref": charter_ref,
        "subject": p.subject,
        "body": p.body,
        "recipients": list(p.recipients),
        "cc": list(p.cc),
        "finding_id": p.finding_id,
        "metadata": dict(p.metadata or {}),
        "dry_run_reasons": list(decision.reasons),
        "scan_hits": list(decision.scan_hits),
        "created_at": time.time(),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _audit(evidence_dir: Path, record: dict[str, Any]) -> None:
    try:
        with (evidence_dir / DELIVERY_AUDIT_FILENAME).open(
            "a", encoding="utf-8",
        ) as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as e:
        log.warning("delivery audit 기록 실패: %r", e)


async def deliver(
    sink_id: str,
    payload: DeliveryPayload,
    *,
    evidence_dir: Path,
    charter_ref: str = "",
) -> DeliveryResult:
    """게이트 → dry-run(draft) 또는 자율발송. 검증/sink 실패는 DeliveryError.

    sink.send 에는 **redacted payload** 만 전달된다 — 어댑터가 원문을 볼
    경로가 없다 (perimeter = 이 함수, 어댑터 신뢰 불요).
    """
    ensure_core_sinks()
    sink = get_delivery_sink(sink_id)
    if sink is None:
        known = ", ".join(s.sink_id for s in list_delivery_sinks()) or "(없음)"
        raise DeliveryError(f"미등록 sink {sink_id!r} — 등록된 sink: {known}")

    decision = apply_egress_gate(sink_id, payload, charter_ref=charter_ref)
    base_audit = {
        "ts": time.time(),
        "sink_id": sink_id,
        "charter_ref": charter_ref,
        "recipients": list(decision.payload.recipients),
        "subject": decision.payload.subject[:200],
        "finding_id": decision.payload.finding_id,
        "scan_hits": list(decision.scan_hits),
    }

    if not decision.autosend:
        draft = _write_draft(
            evidence_dir, sink_id, decision, charter_ref=charter_ref,
        )
        _audit(evidence_dir, {**base_audit, "mode": "dry_run",
                              "reasons": list(decision.reasons),
                              "draft": draft.name})
        return DeliveryResult(
            sink_id=sink_id, mode="dry_run",
            detail=(
                f"dry-run draft 생성: {draft.name} — 실발송 안 됨. "
                f"사유: {'; '.join(decision.reasons)}"
            ),
            reasons=decision.reasons,
            draft_path=str(draft),
            scan_hits=decision.scan_hits,
        )

    try:
        summary = await sink.send(decision.payload)
    except DeliveryError:
        _audit(evidence_dir, {**base_audit, "mode": "send_failed"})
        raise
    except Exception as e:  # noqa: BLE001 — sink 어댑터 예외 정규화
        _audit(evidence_dir, {**base_audit, "mode": "send_failed"})
        raise DeliveryError(f"sink {sink_id!r} 발송 실패: {e!r}") from e

    _audit(evidence_dir, {**base_audit, "mode": "sent", "summary": summary})
    log.info("delivery sent: sink=%s recipients=%d finding=%s",
             sink_id, len(decision.payload.recipients), payload.finding_id)
    return DeliveryResult(sink_id=sink_id, mode="sent", detail=summary)


def deliver_sync(
    sink_id: str, payload: DeliveryPayload, *,
    evidence_dir: Path, charter_ref: str = "",
) -> DeliveryResult:
    """동기 호출부(web route 등)용 래퍼."""
    return asyncio.run(deliver(
        sink_id, payload, evidence_dir=evidence_dir, charter_ref=charter_ref,
    ))
