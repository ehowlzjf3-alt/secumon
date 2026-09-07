"""v3.81 T2: delivery sink 프로토콜 + egress 게이트.

정책 (확정 결정 ⑤⑥): 코어 = deliver 프로토콜 + 게이트(allowlist·마스킹·
dry-run 기본 + opt-in 자율발송), sink = 등록형 어댑터. 실발송 4조건
전부 충족 못 하면 draft 만 만들고 외부로 안 나간다 (fail-closed).
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from secu_agent.agent import delivery as dl
from secu_agent.agent.delivery import (
    DeliveryError, DeliveryPayload, apply_egress_gate, deliver,
    list_delivery_sinks, register_delivery_sink, unregister_delivery_sink,
)


class FakeSink:
    sink_id = "fake_sink"
    description = "테스트 sink"

    def __init__(self):
        self.sent: list[DeliveryPayload] = []

    async def send(self, payload: DeliveryPayload) -> str:
        self.sent.append(payload)
        return f"fake sent to {len(payload.recipients)}"


@pytest.fixture
def fake_sink():
    sink = FakeSink()
    register_delivery_sink(sink)
    try:
        yield sink
    finally:
        unregister_delivery_sink(sink.sink_id)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in (dl.AUTOSEND_SINKS_ENV, dl.AUTOSEND_CHARTERS_ENV,
              dl.RECIPIENT_ALLOW_ENV):
        monkeypatch.delenv(k, raising=False)


def _payload(**kw) -> DeliveryPayload:
    base = dict(
        subject="[DSSOC] 점검 결과 확인 요청",
        body="공유 폴더 점검 결과 확인이 필요합니다. 심각도: HIGH",
        recipients=("owner@corp.example.com",),
    )
    base.update(kw)
    return DeliveryPayload(**base)


def _deliver(sink_id, payload, tmp_path, charter=""):
    return asyncio.run(deliver(
        sink_id, payload, evidence_dir=tmp_path, charter_ref=charter,
    ))


# ── 검증 (owner_mail 검증의 일반화) ──────────────────────────────────


@pytest.mark.parametrize("kw,msg", [
    ({"recipients": ()}, "수신자"),
    ({"subject": "  "}, "제목"),
    ({"body": ""}, "본문"),
])
def test_gate_validation_errors(kw, msg):
    with pytest.raises(DeliveryError, match=msg):
        apply_egress_gate("any", _payload(**kw))


def test_unknown_sink_raises(tmp_path):
    with pytest.raises(DeliveryError, match="미등록 sink"):
        _deliver("nope-sink", _payload(), tmp_path)


# ── 기본 = dry-run (확정 결정 ⑥) ─────────────────────────────────────


def test_default_is_dry_run_draft_no_egress(tmp_path, fake_sink):
    res = _deliver("fake_sink", _payload(), tmp_path)
    assert res.mode == "dry_run"
    assert fake_sink.sent == []                       # 외부로 안 나감
    assert res.draft_path and Path(res.draft_path).exists()
    draft = json.loads(Path(res.draft_path).read_text())
    assert draft["sink_id"] == "fake_sink"
    assert draft["recipients"] == ["owner@corp.example.com"]
    # opt-in 아님 + allowlist 미설정 둘 다 사유로 기록
    joined = " ".join(res.reasons)
    assert dl.AUTOSEND_SINKS_ENV in joined
    assert dl.RECIPIENT_ALLOW_ENV in joined
    # audit 기록
    audit = (tmp_path / dl.DELIVERY_AUDIT_FILENAME).read_text()
    assert '"mode": "dry_run"' in audit


def test_autosend_requires_recipient_allowlist(tmp_path, fake_sink, monkeypatch):
    """sink opt-in 만으로는 부족 — allowlist 미설정 = 자율 egress 금지."""
    monkeypatch.setenv(dl.AUTOSEND_SINKS_ENV, "fake_sink")
    res = _deliver("fake_sink", _payload(), tmp_path)
    assert res.mode == "dry_run"
    assert fake_sink.sent == []


# ── 자율발송 opt-in 경로 ─────────────────────────────────────────────


def test_autosend_all_conditions_met(tmp_path, fake_sink, monkeypatch):
    monkeypatch.setenv(dl.AUTOSEND_SINKS_ENV, "fake_sink")
    monkeypatch.setenv(dl.RECIPIENT_ALLOW_ENV, "corp.example.com")
    res = _deliver("fake_sink", _payload(), tmp_path)
    assert res.mode == "sent"
    assert len(fake_sink.sent) == 1
    audit = (tmp_path / dl.DELIVERY_AUDIT_FILENAME).read_text()
    assert '"mode": "sent"' in audit


def test_autosend_blocked_outside_allowlist(tmp_path, fake_sink, monkeypatch):
    monkeypatch.setenv(dl.AUTOSEND_SINKS_ENV, "fake_sink")
    monkeypatch.setenv(dl.RECIPIENT_ALLOW_ENV, "corp.example.com")
    res = _deliver(
        "fake_sink", _payload(recipients=("evil@attacker.example.net",)),
        tmp_path,
    )
    assert res.mode == "dry_run"
    assert any("allowlist 밖" in r for r in res.reasons)
    assert fake_sink.sent == []


def test_autosend_charter_restriction(tmp_path, fake_sink, monkeypatch):
    monkeypatch.setenv(dl.AUTOSEND_SINKS_ENV, "fake_sink")
    monkeypatch.setenv(dl.RECIPIENT_ALLOW_ENV, "corp.example.com")
    monkeypatch.setenv(dl.AUTOSEND_CHARTERS_ENV, "CHG-2026-042")
    # charter 불일치 → dry-run
    res = _deliver("fake_sink", _payload(), tmp_path, charter="")
    assert res.mode == "dry_run"
    # charter 일치 → 발송
    res = _deliver("fake_sink", _payload(), tmp_path, charter="CHG-2026-042")
    assert res.mode == "sent"


# ── 마스킹 + 스캔 게이트 (평문 secret/PII 외부 유출 차단) ────────────


def test_body_redacted_before_sink(tmp_path, fake_sink, monkeypatch):
    monkeypatch.setenv(dl.AUTOSEND_SINKS_ENV, "fake_sink")
    monkeypatch.setenv(dl.RECIPIENT_ALLOW_ENV, "corp.example.com")
    secret = "ghp_AbCdEfGh1234567890AbCdEfGh1234567890"
    res = _deliver(
        "fake_sink",
        _payload(body=f"토큰 노출 발견: {secret} — 즉시 회수 필요"),
        tmp_path,
    )
    assert res.mode == "sent"
    sent_body = fake_sink.sent[0].body
    assert secret not in sent_body                    # 평문 금지 — 마스킹됨


def test_residual_pii_blocks_autosend(tmp_path, fake_sink, monkeypatch):
    """마스킹 후에도 잔존하는 PII(전화번호) → 발송 차단, draft 만."""
    monkeypatch.setenv(dl.AUTOSEND_SINKS_ENV, "fake_sink")
    monkeypatch.setenv(dl.RECIPIENT_ALLOW_ENV, "corp.example.com")
    res = _deliver(
        "fake_sink", _payload(body="개인정보 노출: 010-1234-5678 확인 필요"),
        tmp_path,
    )
    assert res.mode == "dry_run"
    assert any("pii:kr_phone" in h for h in res.scan_hits)
    assert fake_sink.sent == []


def test_reply_metadata_can_allow_exact_email_pii(tmp_path, fake_sink, monkeypatch):
    """Reply quotes may keep exact thread email addresses without disabling PII scanning."""
    monkeypatch.setenv(dl.AUTOSEND_SINKS_ENV, "fake_sink")
    monkeypatch.setenv(dl.RECIPIENT_ALLOW_ENV, "corp.example.com")
    res = _deliver(
        "fake_sink",
        _payload(
            body=(
                "확인했습니다.<br/>--------- Original Message ---------<br/>"
                "Sender: owner@corp.example.com"
            ),
            metadata={
                "delivery_allowed_pii_values": ["owner@corp.example.com"],
            },
        ),
        tmp_path,
    )
    assert res.mode == "sent"
    assert fake_sink.sent
    assert "owner@corp.example.com" in fake_sink.sent[0].body


def test_reply_metadata_does_not_allow_unlisted_email_pii(tmp_path, fake_sink, monkeypatch):
    monkeypatch.setenv(dl.AUTOSEND_SINKS_ENV, "fake_sink")
    monkeypatch.setenv(dl.RECIPIENT_ALLOW_ENV, "corp.example.com")
    res = _deliver(
        "fake_sink",
        _payload(
            body=(
                "Sender: owner@corp.example.com<br/>"
                "Forwarded-To: other@corp.example.com"
            ),
            metadata={
                "delivery_allowed_pii_values": ["owner@corp.example.com"],
            },
        ),
        tmp_path,
    )
    assert res.mode == "dry_run"
    assert any("pii:email" in h for h in res.scan_hits)
    assert fake_sink.sent == []


def test_scanner_failure_fail_closed(tmp_path, fake_sink, monkeypatch):
    """스캐너 자체가 죽으면 발송 차단 (scan_error hit) — fail-closed."""
    monkeypatch.setenv(dl.AUTOSEND_SINKS_ENV, "fake_sink")
    monkeypatch.setenv(dl.RECIPIENT_ALLOW_ENV, "corp.example.com")

    def boom(text):
        raise RuntimeError("detector down")

    import secu_agent.detectors as det
    monkeypatch.setattr(det, "scan_text", boom)
    res = _deliver("fake_sink", _payload(), tmp_path)
    assert res.mode == "dry_run"
    assert any(h.startswith("scan_error:") for h in res.scan_hits)
    assert fake_sink.sent == []


# ── 수신자 매칭 ──────────────────────────────────────────────────────


def test_recipient_allowed_matching():
    allow = ("corp.example.com", "ops@other.example.org")
    assert dl._recipient_allowed("a@corp.example.com", allow)
    assert dl._recipient_allowed("a@sub.corp.example.com", allow)  # 서브도메인
    assert dl._recipient_allowed("OPS@other.example.org", allow)   # exact, 대소문자
    assert not dl._recipient_allowed("b@other.example.org", allow)  # exact 만 허용된 도메인
    assert not dl._recipient_allowed("a@evil.example.net", allow)
    assert not dl._recipient_allowed("a@corp.example.com", ())     # allow 비면 거부


# ── 레지스트리 ───────────────────────────────────────────────────────


def test_sink_registry_duplicate_rejected(fake_sink):
    with pytest.raises(ValueError, match="이미 등록"):
        register_delivery_sink(FakeSink())
    assert any(s.sink_id == "fake_sink" for s in list_delivery_sinks())


def test_core_knox_mail_sink_registered():
    dl.ensure_core_sinks()
    assert any(s.sink_id == "knox_mail" for s in list_delivery_sinks())


# ── DeliverTool ──────────────────────────────────────────────────────


def _run_tool(payload, ctx):
    from secu_agent.agent.tools.deliver_tool import DeliverTool
    tool = DeliverTool()
    return asyncio.run(tool.execute(tool.input_model(**payload), ctx))


def test_deliver_tool_list_and_dry_run(tmp_path, fake_sink):
    from secu_agent.agent.tools.base import ToolContext, ToolSuccess

    ctx = ToolContext(evidence_dir=tmp_path)
    res = _run_tool({"action": "list"}, ctx)
    assert isinstance(res, ToolSuccess)
    assert "fake_sink" in res.content
    assert "knox_mail" in res.content

    res = _run_tool({
        "action": "send", "sink_id": "fake_sink",
        "recipients": ["owner@corp.example.com"],
        "subject": "제목", "body": "본문",
    }, ctx)
    assert isinstance(res, ToolSuccess)
    assert "dry-run" in res.content
    assert fake_sink.sent == []


def test_deliver_tool_validation_to_tool_error(tmp_path, fake_sink):
    from secu_agent.agent.tools.base import ToolContext, ToolError

    ctx = ToolContext(evidence_dir=tmp_path)
    res = _run_tool({
        "action": "send", "sink_id": "fake_sink",
        "recipients": [], "subject": "s", "body": "b",
    }, ctx)
    assert isinstance(res, ToolError)
    assert res.kind == "validation"
