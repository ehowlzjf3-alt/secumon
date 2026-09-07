"""#33: 개인키 finding 이 원리적으로 제출 불가였다 — 시스템이 자기 증거를 무효화했다.

2026-08-22 smb target 1766(`workspace/platform/config/gpg/arcashield.asc`).
검토원은 **포기하지 않았다.** 3번 제출을 시도했고 3번 다 거부됐다. 마지막 시도엔
진짜 PGP 비밀키 본문까지 담았다. 리드는 "실제 GPG private key" 로 확인하고도
finding 을 못 만들었다(record_pivot 메모로만 남았다).

원인은 **두 개의 독립 결함이 겹친 것**이다.

① 증거 게이트의 마커 정규식에 `( BLOCK)?` 가 없었다 — 탐지 정규식엔 있었다.
   같은 개념을 두 곳에 적어서 어긋난 것이다. ⇒ PGP armor 는 원문이 온전해도 거부.
② `mask_secret` 이 양끝 4자만 남겨 armor 의 **다섯째 대시를 별표로** 만들었다.
   `-----BEGIN …-----` → `----***…----`. 게이트가 요구하는 "PEM 헤더" 를
   파이프라인이 스스로 파괴한 것이다. ⇒ 스캔에서 온 개인키는 형식 불문 전부 거부.

armor 헤더에는 비밀이 한 글자도 없다 — 고정 공개 문자열이고, 실제 키는 뒤따르는
base64 본문이다(`private_key_block` 룰은 헤더만 매칭한다). 비밀을 가리는 게 아니라
증거만 지우고 있었다.

★ 이 파일이 지키는 것은 **양방향**이다: 개인키는 통과하고, 비밀은 새지 않으며,
   산문·라벨만인 주장은 여전히 거부된다.
"""
from __future__ import annotations

import pytest

from secu_agent.agent.evidence_judgment import judge_task_finding
from secu_agent.agent.tools.submit_finding import SubmitFindingInput
from secu_agent.detectors import scan_text
from secu_agent.detectors.secrets import _PRIVATE_KEY_ARMOR_RE, mask_secret

# 실제 키 본문 형상(테스트용 더미) — 이건 비밀 취급이어야 한다.
BODY = "MIIEpAIBAAKCAQEA2M8PsWFq+qRDgYLOzQ7bF7a3D1fdHJXVPSM27AGKy2s09VXE"

ARMORS = [
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",   # ← ①이 놓치던 것
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN DSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",   # ← 탐지조차 안 되던 것
]


def _finding(masked: str, preview: str = "", kind: str = "private_key_block",
             task_type: str = "generic"):
    return SubmitFindingInput(**{"finding": {
        "hits": [{"category": "secret", "kind": kind, "location": "smb://h/share/k",
                  "masked": masked, "preview": preview}],
        "recommended_actions": ["키를 폐기하고 재발급하라"],
        "severity": "high", "summary": "개인키 평문 노출",
        "target": "smb://h/share", "task_type": task_type}}).finding


# ── 1. 탐지 → 마스킹 → 게이트 왕복 (수정 전 0/5) ────────────────────────

@pytest.mark.parametrize("armor", ARMORS)
def test_every_private_key_format_survives_the_round_trip(armor):
    """실기동에서 깨지던 정확한 경로: 스캔이 만든 masked 를 그대로 제출한다."""
    hits = [h for h in scan_text(armor + "\n" + BODY).hits
            if h.kind == "private_key_block"]
    assert hits, f"탐지 실패: {armor}"
    masked = hits[0].masked
    assert masked == armor, f"마스킹이 헤더를 훼손했다: {masked!r}"
    j = judge_task_finding(_finding(masked, masked))
    assert j.should_persist, f"{armor} → {j.verdict}: {j.reason}"


def test_the_exact_payload_that_was_rejected_live_now_passes():
    """arcashield.asc 재현 — 검토원이 실제로 받았던 masked 값."""
    hits = [h for h in scan_text("-----BEGIN PGP PRIVATE KEY BLOCK-----\n"
                                 "lQcYBGkbAcsBEACaQZu36Mhc2sTOSmRCdQywPRc6pY2Q4g53Lh\n").hits
            if h.kind == "private_key_block"]
    assert hits[0].masked == "-----BEGIN PGP PRIVATE KEY BLOCK-----"
    assert judge_task_finding(_finding(hits[0].masked)).should_persist


# ── 2. ★ 비밀 누출 회귀 가드 ────────────────────────────────────────────

def test_only_a_bare_armor_header_is_left_unmasked():
    """본문이 한 글자라도 섞이면 예전대로 마스킹한다."""
    assert mask_secret("-----BEGIN RSA PRIVATE KEY-----") == \
        "-----BEGIN RSA PRIVATE KEY-----"
    with_body = mask_secret("-----BEGIN RSA PRIVATE KEY-----\n" + BODY)
    assert BODY not in with_body
    assert "*" in with_body


def test_real_secret_values_are_still_masked():
    for value in ("AKIAIOSFODNN7EXAMPLE", "ghp_" + "a" * 36, "xoxb-123456789012-abcdef"):
        out = mask_secret(value)
        assert out != value and "*" in out, out


def test_the_key_body_never_leaks_through_scan():
    """스캔 결과 어디에도 base64 본문이 평문으로 실리면 안 된다."""
    result = scan_text("-----BEGIN RSA PRIVATE KEY-----\n" + BODY + "\n")
    for h in result.hits:
        assert BODY not in (h.masked or "")


# ── 3. 공개키·인증서는 개인키가 아니다 ──────────────────────────────────

@pytest.mark.parametrize("text", [
    "-----BEGIN PGP PUBLIC KEY BLOCK-----",
    "-----BEGIN PUBLIC KEY-----",
    "-----BEGIN CERTIFICATE-----",
])
def test_public_material_is_not_a_private_key(text):
    assert not _PRIVATE_KEY_ARMOR_RE.fullmatch(text)
    assert "private_key_block" not in {h.kind for h in scan_text(text).hits}


# ── 4. ★ 게이트 약화 회귀 — 여전히 거부되어야 하는 것 ──────────────────

@pytest.mark.parametrize("masked", [
    "private key detected in file",   # 산문
    "value_present=True",             # 주장
    "<masked,len=1675>",              # assertion
    "",                               # 빈 값
    "***",                            # 플레이스홀더
    "secret ... keyword context",     # 카테고리 라벨
])
def test_label_only_claims_are_still_rejected(masked):
    j = judge_task_finding(_finding(masked))
    assert not j.should_persist, f"{masked!r} 가 통과했다 — 게이트가 약해졌다"


# ── 5. 정본이 하나여야 한다 (①의 재발 방지) ────────────────────────────

def test_detector_and_gate_share_one_armor_definition():
    """같은 개념을 두 곳에 적으면 어긋난다 — 실제로 어긋나서 이 버그가 났다."""
    from secu_agent.agent import evidence_judgment as ej
    assert ej._PRIVATE_KEY_MARKER_RE is _PRIVATE_KEY_ARMOR_RE


# ── 6. 거부 사유가 증거에 남는다 ────────────────────────────────────────
#
# 이 조사가 오래 걸린 이유: audit 에 `outcome=error:validation` 과
# `content_preview=""` 만 남아 **왜** 거부됐는지 증거만 봐서는 알 수 없었다
# ("0 chars"). 모델은 message 를 받아 읽는데 우리는 못 봤다.

def test_audit_records_why_a_tool_rejected_the_call(tmp_path):
    import asyncio
    import json
    from typing import ClassVar

    from pydantic import BaseModel

    from secu_agent.agent.eval.scripted_llm import (
        ScriptedLLMClient, ScriptedToolCall, ScriptedTurn,
    )
    from secu_agent.agent.harness.runner import GuardedHarness
    from secu_agent.agent.llm.messages import TextBlock, UserMessage
    from secu_agent.agent.tools.base import Tool, ToolContext, ToolError
    from secu_agent.agent.tools.registry import ToolRegistry

    class _Empty(BaseModel):
        pass

    class _AlwaysRejects(Tool[_Empty]):
        name: ClassVar[str] = "always_rejects"
        description: ClassVar[str] = "테스트용 — 항상 거부한다"
        input_model: ClassVar[type[BaseModel]] = _Empty

        async def execute(self, vi: _Empty, ctx: ToolContext):
            return ToolError(kind="validation", message="증거가 부족하다 — 실제 값을 넣어라")

    registry = ToolRegistry()
    registry.register(_AlwaysRejects)
    harness = GuardedHarness(
        client=ScriptedLLMClient(turns=[
            ScriptedTurn(tool_calls=[ScriptedToolCall(name="always_rejects", input={})]),
            ScriptedTurn(text="끝."),
        ]),
        registry=registry, evidence_dir=tmp_path,
    )

    async def _go():
        return [ev async for ev in harness.run(
            initial_messages=[UserMessage(content=[TextBlock(text="go")])])]

    asyncio.run(_go())

    entries = [json.loads(x) for x in
               (tmp_path / ".harness" / "audit.log.jsonl").read_text(
                   encoding="utf-8").splitlines() if x.strip()]
    done = [e["payload"] for e in entries
            if e["type"] == "tool_call_completed" and e["payload"]["name"] == "always_rejects"]
    assert done, [e["type"] for e in entries]
    assert done[-1]["outcome"] == "error:validation"
    assert "증거가 부족하다" in done[-1].get("error_message", ""), done[-1]


def test_audit_does_not_add_an_error_message_to_successes(tmp_path):
    import asyncio
    import json
    from typing import ClassVar

    from pydantic import BaseModel

    from secu_agent.agent.eval.scripted_llm import (
        ScriptedLLMClient, ScriptedToolCall, ScriptedTurn,
    )
    from secu_agent.agent.harness.runner import GuardedHarness
    from secu_agent.agent.llm.messages import TextBlock, UserMessage
    from secu_agent.agent.tools.base import Tool, ToolContext, ToolSuccess
    from secu_agent.agent.tools.registry import ToolRegistry

    class _Empty(BaseModel):
        pass

    class _Ok(Tool[_Empty]):
        name: ClassVar[str] = "always_ok"
        description: ClassVar[str] = "테스트용 — 항상 성공"
        input_model: ClassVar[type[BaseModel]] = _Empty

        async def execute(self, vi: _Empty, ctx: ToolContext):
            return ToolSuccess(content="fine")

    registry = ToolRegistry()
    registry.register(_Ok)
    harness = GuardedHarness(
        client=ScriptedLLMClient(turns=[
            ScriptedTurn(tool_calls=[ScriptedToolCall(name="always_ok", input={})]),
            ScriptedTurn(text="끝."),
        ]),
        registry=registry, evidence_dir=tmp_path,
    )

    async def _go():
        return [ev async for ev in harness.run(
            initial_messages=[UserMessage(content=[TextBlock(text="go")])])]

    asyncio.run(_go())
    entries = [json.loads(x) for x in
               (tmp_path / ".harness" / "audit.log.jsonl").read_text(
                   encoding="utf-8").splitlines() if x.strip()]
    done = [e["payload"] for e in entries
            if e["type"] == "tool_call_completed" and e["payload"]["name"] == "always_ok"]
    assert done and "error_message" not in done[-1], done[-1]


# ── 7. 헤더는 증거, 본문은 비밀 ─────────────────────────────────────────
#
# ★ 이건 6절의 반대 방향이다. armor 헤더를 살려 준 대가로 개인키 finding 이 늘어나는데,
#   워커가 preview 에 원문을 붙여 넣으면 **키 본문이 평문으로 영속**된다.
#   실측(2026-08-23): core.finding_lifecycle 최근 smb finding 400건 중 9건이 그랬다
#   (2026-08-16~08-23 — 이 변경보다 앞선다). span 마스킹으로는 원리적으로 못 잡는다:
#   private_key_block 룰은 헤더만 매칭하고 PEM 본문 줄은 엔트로피 탐지가 일부러
#   억제하기 때문에(hit 폭발 방지), 본문은 어떤 hit 의 span 도 아니다.

_KEY_BODY = "MIIJKAIBAAKCAgEAqqVodUiHUdyq8ISa4Xo8WCwy4wgrt8o1X0pW6vxQk6b/yi0B"
_PGP_BODY = "lQcYBGkbAcsBEACaQZu36Mhc2sTOSmRCdQywPRc6pY2Q4g53Lh"


@pytest.mark.parametrize("text,body", [
    # 워커가 실제로 붙여 넣는 형태 — END 마커가 없다(그래서 기존 redact 규칙이 놓쳤다).
    ("-----BEGIN RSA PRIVATE KEY----- " + _KEY_BODY + "...", _KEY_BODY),
    ("-----BEGIN RSA PRIVATE KEY-----\n" + _KEY_BODY + "\n-----END RSA PRIVATE KEY-----",
     _KEY_BODY),
    ("-----BEGIN PGP PRIVATE KEY BLOCK-----\n" + _PGP_BODY + "\n", _PGP_BODY),
])
def test_persisted_text_never_carries_the_key_body(text, body):
    from secu_agent.detectors.text_scan import mask_scanned_text
    out = mask_scanned_text(text)
    assert body not in out, out
    assert "[REDACTED KEY BODY]" in out


def test_the_armor_marker_survives_redaction():
    """본문을 지우되 증거는 남긴다 — 안 남기면 개인키 finding 을 아예 못 낸다."""
    from secu_agent.detectors.text_scan import mask_scanned_text
    out = mask_scanned_text("-----BEGIN RSA PRIVATE KEY----- " + _KEY_BODY)
    assert "-----BEGIN RSA PRIVATE KEY-----" in out
    assert judge_task_finding(_finding(out, out)).should_persist


def test_mask_deep_redacts_key_bodies_in_nested_payloads():
    """영속 경계는 mask_deep 이다 — finding.extra_json 이 이 길로 저장된다."""
    from secu_agent.detectors.text_scan import mask_deep
    payload = {"hits": [{"preview": "-----BEGIN RSA PRIVATE KEY----- " + _KEY_BODY}]}
    assert _KEY_BODY not in str(mask_deep(payload))


def test_a_bare_armor_header_is_not_mangled_by_the_body_redactor():
    """본문이 없으면 건드리지 않는다 — 헤더만 있는 hit 가 흔하다."""
    from secu_agent.detectors.text_scan import redact_private_key_bodies
    for armor in ARMORS:
        assert redact_private_key_bodies(armor) == armor
