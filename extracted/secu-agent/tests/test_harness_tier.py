"""Front-D: harness_tier — 모델 등급 적응형 생산성 loop-guard.

강한 모델(frontier)은 loop-guard 를 느슨하게, 약한 모델(small)은 엄격하게 스케일한다.
**안전 불변식(url_safety/마스킹/egress/권한/파괴적 게이트)은 harness_tier 를 절대 읽지
않는다** — 이 경계를 grep 테스트로 못박는다. tier 는 _tool_guardrail_config 한 곳에서만
소비되고, 안전 모듈로는 흐르지 않는다.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from secu_agent.agent.engine import (
    QueryConfig,
    _HARNESS_TIER_GUARDRAIL_SCALE,
    _tier_scaled,
    _tier_scaled_pair,
    _tool_guardrail_config,
)
from secu_agent.agent.llm.profile import LLMProfile


# ── tier 스케일 로직 ────────────────────────────────────────────────────────

def test_tier_scaled_frontier_loosens_small_tightens():
    assert _tier_scaled(5, "frontier") == 10   # ×2 느슨
    assert _tier_scaled(5, "mid") == 5         # ×1 무변
    assert _tier_scaled(5, None) == 5          # None=mid 무변
    assert _tier_scaled(5, "small") == 2       # ×0.5 → round(2.5)=2 엄격


def test_tier_scaled_floors_at_one_only_when_scaling():
    # small ×0.5 라도 최소 1 (0 이 되면 loop-guard 가 첫 실패에 터짐).
    assert _tier_scaled(1, "small") == 1
    assert _tier_scaled(2, "small") == 1


def test_tier_scaled_none_mid_is_exact_passthrough_including_zero():
    # V3: scale==1.0 은 floor 없이 원본 그대로 — 0 도 0 (정확한 하위호환).
    assert _tier_scaled(0, None) == 0
    assert _tier_scaled(0, "mid") == 0
    assert _tier_scaled(0, "bogus") == 0       # 미지 등급=mid(1.0) 폴백도 passthrough
    assert _tier_scaled(7, None) == 7


def test_tier_scaled_unknown_tier_is_mid():
    assert _tier_scaled(5, "bogus") == 5       # 미지 등급 = mid(1.0) 안전 폴백


def test_tier_scaled_pair_preserves_warn_below_block():
    # V2: 원래 warn<block 이면 모든 등급·경계 쌍에서 스케일 후에도 warn<block 보장.
    edge_pairs = [(1, 2), (2, 3), (4, 5), (2, 5), (3, 8), (2, 5), (10, 20)]
    for tier in list(_HARNESS_TIER_GUARDRAIL_SCALE) + [None, "bogus"]:
        for warn, block in edge_pairs:
            w, b = _tier_scaled_pair(warn, block, tier)
            assert w < b, f"{tier} {warn}/{block}: scaled warn={w} block={b}"
            assert w >= 1 and b >= 1


def test_tier_scaled_pair_leaves_non_ladder_untouched():
    # V3(W3): 원래 warn>=block(사다리 아님)은 스케일만 하고 인위적 순서를 만들지 않는다.
    # frontier ×2: (5,5)→(10,10) 그대로 warn==block.
    assert _tier_scaled_pair(5, 5, "frontier") == (10, 10)
    # None passthrough: (5,3)→(5,3) 그대로(warn>block 유지).
    assert _tier_scaled_pair(5, 3, None) == (5, 3)


def test_tier_scaled_pair_no_unnecessary_repair_when_already_ordered():
    # Y2: 스케일 후에도 이미 warn<block 이면 복원하지 않는다 — frontier (0,1)→(0,2) 정확.
    assert _tier_scaled_pair(0, 1, "frontier") == (0, 2)
    assert _tier_scaled_pair(1, 3, "frontier") == (2, 6)
    # small (2,5)→(1,2): 붕괴 아님(1<2) → 그대로.
    assert _tier_scaled_pair(2, 5, "small") == (1, 2)


def test_tier_scaled_pair_none_mid_exact_passthrough_no_ladder_repair():
    # W5: mid/None 은 사다리 복원을 절대 하지 않아 (0,1) 같은 원본을 정확히 보존.
    assert _tier_scaled_pair(0, 1, None) == (0, 1)
    assert _tier_scaled_pair(0, 1, "mid") == (0, 1)
    assert _tier_scaled_pair(0, 1, "bogus") == (0, 1)   # 미지=mid passthrough
    assert _tier_scaled_pair(2, 5, None) == (2, 5)


def test_tier_scaled_frontier_is_exact_integer_multiply():
    # W4: frontier 는 정수배 — 큰 정수에서도 float 정밀도 손실 없음.
    big = 2 ** 53 + 1
    assert _tier_scaled(big, "frontier") == big * 2
    assert _tier_scaled(3, "frontier") == 6


def test_tier_scaled_small_is_exact_integer_no_float():
    # X2/X3: small 도 정수 연산 — 초대형 정수에서 OverflowError·정밀손실 없음.
    assert _tier_scaled(2 ** 54 + 2, "small") == 2 ** 53 + 1   # 정확한 절반
    huge = 10 ** 400
    # float 이면 OverflowError — 정수라 안전.
    assert _tier_scaled(huge, "small") == huge // 2
    w, b = _tier_scaled_pair(huge, huge + 1, "small")
    assert w < b


def test_tier_scaled_small_matches_round_half_even():
    # 정수 구현이 round(base*0.5)(짝수 반올림)와 소규모 값에서 일치.
    for base in range(0, 21):
        assert _tier_scaled(base, "small") == max(1, round(base * 0.5))


# ── _tool_guardrail_config 소비 ─────────────────────────────────────────────

def test_guardrail_config_default_tier_unchanged():
    cfg = QueryConfig()  # harness_tier=None
    gc = _tool_guardrail_config(cfg)
    assert gc.exact_failure_warn_after == cfg.tool_guardrail_exact_failure_warn_after
    assert gc.no_progress_block_after == cfg.tool_guardrail_no_progress_block_after


def test_guardrail_config_frontier_loosens_counts_only():
    cfg = QueryConfig(harness_tier="frontier")
    gc = _tool_guardrail_config(cfg)
    # count 임계값은 ×2.
    assert gc.exact_failure_warn_after == 2 * cfg.tool_guardrail_exact_failure_warn_after
    assert gc.no_progress_block_after == 2 * cfg.tool_guardrail_no_progress_block_after
    # 불리언(경보 on/off·hard stop)은 스케일 대상 아님 — 그대로.
    assert gc.warnings_enabled == cfg.tool_guardrail_warnings_enabled
    assert gc.hard_stop_enabled == cfg.tool_guardrail_hard_stop_enabled


def test_guardrail_config_small_tightens_counts():
    cfg = QueryConfig(harness_tier="small")
    gc = _tool_guardrail_config(cfg)
    assert gc.same_tool_failure_halt_after < cfg.tool_guardrail_same_tool_failure_halt_after
    assert gc.same_tool_failure_halt_after >= 1


def test_guardrail_config_small_preserves_warn_below_block_on_close_thresholds():
    # V2: 운영자가 가까운 커스텀 임계(warn=4/block=5)를 줘도 small 스케일 후 warn<block 유지.
    cfg = QueryConfig(
        harness_tier="small",
        tool_guardrail_exact_failure_warn_after=4,
        tool_guardrail_exact_failure_block_after=5,
        tool_guardrail_no_progress_warn_after=4,
        tool_guardrail_no_progress_block_after=5,
    )
    gc = _tool_guardrail_config(cfg)
    assert gc.exact_failure_warn_after < gc.exact_failure_block_after
    assert gc.no_progress_warn_after < gc.no_progress_block_after


def test_guardrail_config_none_exactly_reproduces_raw_thresholds():
    # V3: harness_tier=None 은 커스텀 값(0 포함)을 정확히 그대로 전달(하위호환).
    cfg = QueryConfig(
        harness_tier=None,
        tool_guardrail_exact_failure_block_after=0,  # "첫 호출에 block" 설정
    )
    gc = _tool_guardrail_config(cfg)
    assert gc.exact_failure_block_after == 0  # floor 로 1 이 되지 않음


# ── LLMProfile 필드 ─────────────────────────────────────────────────────────

def test_llm_profile_accepts_harness_tier():
    p = LLMProfile(name="x", base_url="http://h", model="m", harness_tier="frontier")
    assert p.harness_tier == "frontier"


def test_llm_profile_harness_tier_defaults_none():
    p = LLMProfile(name="x", base_url="http://h", model="m")
    assert p.harness_tier is None


def test_llm_profile_rejects_invalid_tier():
    with pytest.raises(ValueError):
        LLMProfile(name="x", base_url="http://h", model="m", harness_tier="turbo")


# ── client 파생: 모든 agent-loop 경로가 client 에서 등급을 얻는다 ─────────────

def test_llm_clients_expose_harness_tier_from_profile():
    """Y3: 실 client 클래스가 profile.harness_tier 를 property 로 노출한다.

    ChatSession(자율 Ralph 루프)·GuardedHarness(워커) 둘 다 getattr(client,'harness_tier')
    로 등급을 파생하므로, 경로별 개별 배선을 잊어 누락되는 버그를 구조적으로 없앤다.
    """
    import asyncio

    from secu_agent.agent.llm.internal_gateway import OpenAICompatClient

    prof = LLMProfile(name="p", base_url="http://h", model="m", harness_tier="frontier")
    client = OpenAICompatClient(prof)
    try:
        assert client.harness_tier == "frontier"
    finally:
        asyncio.run(client.aclose())

    prof_none = LLMProfile(name="p", base_url="http://h", model="m")
    client2 = OpenAICompatClient(prof_none)
    try:
        assert client2.harness_tier is None   # 미설정 → None(=mid)
    finally:
        asyncio.run(client2.aclose())


def test_fallback_client_delegates_harness_tier_to_primary():
    from secu_agent.agent.llm.fallback import FallbackLLMClient

    class _Stub:
        name = "stub"
        harness_tier = "small"

    fb = FallbackLLMClient([_Stub()])
    assert fb.harness_tier == "small"


def test_client_without_property_derives_none_mid():
    # ScriptedLLMClient 등 property 없는 client → getattr None → mid(무변).
    class _Bare:
        pass
    assert getattr(_Bare(), "harness_tier", None) is None


# ── 경계 불변식: 안전 모듈은 harness_tier 를 절대 읽지 않는다 ──────────────────

# harness_tier 가 새어들면 안 되는 안전 임계 모듈들(SAFETY-KEEP 표면).
_SAFETY_MODULES = [
    "agent/tools/url_safety.py",       # url 하드블록 perimeter
    "detectors/text_scan.py",          # PII/secret 마스킹
    "agent/delivery.py",               # egress 게이트
    "agent/tools/autonomy.py",         # 자율 도구 허용 게이트
    "agent/tools/invoker.py",          # 권한/정책 게이트 초크포인트
    "agent/tool_policy.py",            # 도메인 도구 정책 게이트
    "agent/harness/audit.py",          # 감사 로그(마스킹·체인)
    "agent/tools/submit_finding.py",   # finding 영속 마스킹
    "agent/tools/browser_tool.py",     # SSO lockout 회로차단기(login_halted/streak 임계)
]


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src" / "secu_agent"


@pytest.mark.parametrize("rel", _SAFETY_MODULES)
def test_safety_modules_never_read_harness_tier(rel):
    """안전 모듈이 harness_tier 를 참조하면 등급이 안전 동작을 흔들 수 있다 — 금지."""
    path = _src_root() / rel
    assert path.exists(), f"safety module 경로 오류: {rel}"
    text = path.read_text(encoding="utf-8")
    assert "harness_tier" not in text, (
        f"{rel} 가 harness_tier 를 참조 — 안전 불변식은 모델 등급 무관이어야 한다"
    )
