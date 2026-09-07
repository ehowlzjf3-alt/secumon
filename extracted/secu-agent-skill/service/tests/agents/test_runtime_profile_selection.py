"""워커 vision 대체 슬롯 + vision 래퍼 배선 계약.

⚠️ 이 "도메인 기본값" 은 **도메인 전용 모델이 아니다**. 도메인별 모델 특화(A/B 1~3차)는
무효화됐고, 남은 건 "선택된 모델이 이미지를 못 받을 때 쓸 대체" 라는 능력 슬롯 하나다.

두 가지를 고정한다.

1. **우선순위**: env `SA_CHAT_PROFILE` > 워커 도메인 기본값 > 폴백.
   skill `.env` 핀 금지 정책(v3.90 split-brain 재발 방지)과 per-worker override
   (A/B 하니스)를 둘 다 살리려면 env 가 **언제나** 이겨야 한다. 도메인 기본값은
   "핀" 이 아니라 "아무도 지정 안 했을 때의 값" 이다.

2. **래퍼 순서**: tag → retry → gateway_compat → vision_compat(최내곽).
   vision 보정이 재시도 안쪽이라 재전송도 보정본으로 나간다.
"""
from __future__ import annotations

import pytest

from service.agents.gateway_compat import GatewayCompatClient
from service.agents.vision_compat import VisionCompatClient


def _write_profiles(tmp_path):
    path = tmp_path / "llm_profiles.yaml"
    path.write_text(
        "profiles:\n"
        "  deepseek: {base_url: 'https://x/v1', model: 'm1', auth: {mode: api_key, api_key: k}, verify_ssl: false}\n"
        "  gemma: {base_url: 'https://y/v1', model: 'm2', auth: {mode: api_key, api_key: k}, verify_ssl: false}\n",
        encoding="utf-8",
    )
    return path


@pytest.fixture()
def clean_env(tmp_path, monkeypatch):
    monkeypatch.setenv("SA_CHAT_PROFILES_PATH", str(_write_profiles(tmp_path)))
    monkeypatch.delenv("SA_CHAT_PROFILE", raising=False)
    monkeypatch.delenv("SA_SMB_AGENT_PROFILE", raising=False)
    monkeypatch.delenv("SA_CHAT_PROFILE_CHAIN", raising=False)
    monkeypatch.delenv("SA_VISION_COMPAT", raising=False)
    monkeypatch.delenv("SA_VISION_UNSUPPORTED_PROFILES", raising=False)


def _served_profile(client) -> str:
    """래퍼를 벗겨 태그된 프로파일 이름을 읽는다."""
    return client._profile_name


# ── ① 우선순위 ───────────────────────────────────────────────────────────
def test_domain_default_is_used_when_env_is_unset(clean_env):
    from service.agents import runtime
    assert _served_profile(runtime._build_client("gemma")) == "gemma"


def test_env_override_always_beats_the_domain_default(clean_env, monkeypatch):
    """⚠️ 계약의 핵심 — 운영/실험이 언제나 모델을 되찾아올 수 있어야 한다."""
    from service.agents import runtime
    monkeypatch.setenv("SA_CHAT_PROFILE", "deepseek")
    assert _served_profile(runtime._build_client("gemma")) == "deepseek"


def test_vision_required_worker_overrides_a_blind_global_pin(clean_env, monkeypatch):
    """⚠️ env 우선 계약의 **유일한 예외** — 그리고 이게 없으면 배선이 死코드다.

    엔진 `.env` 가 `SA_CHAT_PROFILE` 을 전역으로 박아 두는데, 현재 값 `deepseek` 은
    이미지를 400 으로 거부한다(2026-08-20 실측). 예외가 없으면 smb/dev_web 의 vision
    대체 슬롯이 영영 적용되지 않는다.
    """
    from service.agents import runtime
    monkeypatch.setenv("SA_CHAT_PROFILE", "deepseek")
    assert _served_profile(runtime._build_client("gemma", require_vision=True)) == "gemma"


def test_vision_not_required_keeps_the_global_pin(clean_env, monkeypatch):
    """github/confluence 처럼 이미지가 필요 없는 워커는 전역 핀을 그대로 존중한다."""
    from service.agents import runtime
    monkeypatch.setenv("SA_CHAT_PROFILE", "deepseek")
    assert _served_profile(runtime._build_client("gemma")) == "deepseek"


def test_vision_exception_does_not_fire_for_a_seeing_pin(clean_env, monkeypatch):
    """핀이 이미 이미지를 볼 수 있으면 운영자 선택을 바꾸지 않는다."""
    from service.agents import runtime
    monkeypatch.setenv("SA_CHAT_PROFILE", "gemma")
    monkeypatch.setenv("SA_VISION_UNSUPPORTED_PROFILES", "deepseek")
    assert _served_profile(
        runtime._build_client("deepseek", require_vision=True)) == "gemma"


def test_unknown_domain_default_falls_through(clean_env):
    """오타/미배포 프로파일이 워커를 죽이면 안 된다 — 기존 폴백으로 넘어간다."""
    from service.agents import runtime
    assert _served_profile(runtime._build_client("does-not-exist")) in {
        "deepseek", "gemma",
    }


def test_no_preference_keeps_previous_behaviour(clean_env):
    from service.agents import runtime
    assert _served_profile(runtime._build_client()) in {"deepseek", "gemma"}


# ── ② 래퍼 순서 / 프로파일별 적용 ────────────────────────────────────────
def test_vision_wrapper_sits_inside_gateway_compat(clean_env, monkeypatch):
    from service.agents import runtime
    monkeypatch.setenv("SA_CHAT_PROFILE", "deepseek")

    client = runtime._build_client()
    # tag → retry → gateway_compat → vision_compat
    assert isinstance(client._inner._inner, GatewayCompatClient)
    assert isinstance(client._inner._inner._inner, VisionCompatClient)


def test_vision_wrapper_absent_for_seeing_profiles(clean_env, monkeypatch):
    from service.agents import runtime
    monkeypatch.setenv("SA_CHAT_PROFILE", "gemma")

    client = runtime._build_client()
    assert isinstance(client._inner._inner, GatewayCompatClient)
    assert not isinstance(client._inner._inner._inner, VisionCompatClient)


def test_chain_wraps_each_profile_independently(clean_env, monkeypatch):
    """폴백 체인에서 deepseek 만 강등되고 gemma 는 이미지를 그대로 받아야 한다."""
    from service.agents import runtime
    monkeypatch.setenv("SA_CHAT_PROFILE", "deepseek")
    monkeypatch.setenv("SA_CHAT_PROFILE_CHAIN", "deepseek,gemma")

    client = runtime._build_client()
    tagged = client._clients if hasattr(client, "_clients") else client.clients
    by_profile = {c._profile_name: c for c in tagged}
    assert isinstance(by_profile["deepseek"]._inner._inner._inner, VisionCompatClient)
    assert not isinstance(by_profile["gemma"]._inner._inner._inner, VisionCompatClient)


# ── ③ 워커를 띄우는 쪽이 실제로 vision 기본값을 넘기는가 ──────────────────
#
# ⚠️ 이 단언은 원래 평면 레인(`*_task_agent.py` 의 `llm_profile=` 인자)에 걸려 있었다.
#    평면 레인이 은퇴하면서(smb 2026-08-28) 워커를 띄우는 주체가 **검토원 계약**으로
#    옮겼다. 단언도 따라 옮긴다 — 지운 코드에 걸어 두면 조용히 사라진다.
def _read(rel_path: str) -> str:
    from pathlib import Path
    return (Path(__file__).resolve().parents[3] / rel_path).read_text(encoding="utf-8")


@pytest.mark.parametrize("module_path", [
    "domains/smb/plugin/inspect_contract.py",
    "domains/dev_web/plugin/inspect_contract.py",
])
def test_vision_dependent_inspectors_declare_a_seeing_profile(module_path):
    """이미지가 근거인 도메인은 vision 가능한 대체 프로파일을 선언해야 한다.

    배선이 사라지면 vision 불가 모델로 돌 때 `smb_inspect_image`/스크린샷 한 번에
    태스크가 영구히 죽는다(400 = invalid_request = 폴백 비대상).
    """
    assert 'vision_fallback="gemma"' in _read(module_path)


def test_vision_fallback_actually_requires_vision():
    """`vision_fallback` 이 `require_vision` 으로 이어지지 않으면 배선이 死코드다.

    엔진 .env 의 전역 프로파일 핀이 이겨서 검토원이 눈 없는 모델로 돈다.
    """
    assert "require_vision=bool(vision_fallback)" in _read("_shared/inspect_contract.py")
