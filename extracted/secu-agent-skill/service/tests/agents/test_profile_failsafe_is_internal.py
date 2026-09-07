"""프로파일 fail-safe 는 **사내**여야 한다 (2026-08-20).

## 무엇이 있었나

스킬 런타임의 폴백이 이랬다:

    if name is None or name not in profiles:
        name = "codex" if "codex" in profiles else next(iter(profiles), None)

`codex` 는 `https://chatgpt.com/backend-api/codex` — **사외 egress** 다. 즉
SA_CHAT_PROFILE 이 없거나 오타면 워커가 조용히 사외 모델로 붙었고, 그 워커가 읽은
파일 본문·크리덴셜·PII 가 그대로 따라 나갔다.

코어는 같은 자리를 이미 고쳐 뒀다(`llm/factory.py`: "env 미설정은 사고이지 의도가
아니므로 사내로 fail-safe 한다 — 구 기본값 codex 는 chatgpt.com 외부 egress 였다").
스킬 사본만 옛 동작으로 남아 있었다.

## 왜 지금 더 위험해졌나

2026-08-20 에 `gauss-o32`·`gpt-oss`·`gauss-o41` 을 은퇴시켜 프로필 정의를 지웠다.
구 `.env`·구 컨테이너 이미지가 그 이름을 가리키면 `name not in profiles` 가 되고,
옛 코드였다면 **전부 codex 로 떨어졌다.**
"""
from __future__ import annotations

import pytest

_YAML = (
    "profiles:\n"
    "  gemma:    {base_url: 'https://a/v1', model: 'm1', auth: {mode: api_key, api_key: k}, verify_ssl: false}\n"
    "  deepseek: {base_url: 'https://b/v1', model: 'm2', auth: {mode: api_key, api_key: k}, verify_ssl: false}\n"
    "  codex:    {base_url: 'https://chatgpt.com/backend-api/codex', model: 'gpt-5.5', transport: codex_responses, auth: {mode: oauth_codex}, verify_ssl: false}\n"
    "  o4-mini:  {base_url: 'https://c/v1', model: 'm4', auth: {mode: api_key, api_key: k}, verify_ssl: false}\n"
)


@pytest.fixture()
def profiles_yaml(tmp_path, monkeypatch):
    p = tmp_path / "llm_profiles.yaml"
    p.write_text(_YAML, encoding="utf-8")
    monkeypatch.setenv("SA_CHAT_PROFILES_PATH", str(p))
    monkeypatch.delenv("SA_CHAT_PROFILE", raising=False)
    monkeypatch.delenv("SA_SMB_AGENT_PROFILE", raising=False)
    monkeypatch.delenv("SA_CHAT_PROFILE_CHAIN", raising=False)
    return p


def _served(client) -> str:
    return client._profile_name


def test_unset_env_lands_internal_not_codex(profiles_yaml):
    """★ env 미설정 = 사고다. 사고의 착지점이 사외면 안 된다."""
    from service.agents import runtime
    assert _served(runtime._build_client()) == "gemma"


def test_retired_profile_name_lands_internal(profiles_yaml, monkeypatch):
    """★ 은퇴한 이름을 가리키는 구 env — 오늘 실제로 생길 수 있는 경로다."""
    from service.agents import runtime
    monkeypatch.setenv("SA_CHAT_PROFILE", "gauss-o32")
    assert _served(runtime._build_client()) == "gemma"


def test_typo_profile_name_lands_internal(profiles_yaml, monkeypatch):
    from service.agents import runtime
    monkeypatch.setenv("SA_CHAT_PROFILE", "gemmma")
    assert _served(runtime._build_client()) == "gemma"


def test_explicit_codex_is_still_honored(profiles_yaml, monkeypatch):
    """명시 선택은 존중한다 — Phase 3 리드가 이 경로로 뜬다."""
    from service.agents import runtime
    monkeypatch.setenv("SA_CHAT_PROFILE", "codex")
    assert _served(runtime._build_client()) == "codex"


def test_no_internal_profile_raises_instead_of_using_an_external_one(tmp_path, monkeypatch):
    """★ 사내 프로파일이 하나도 없으면 **죽는다** — 사외로 조용히 넘어가지 않는다."""
    from service.agents import runtime

    p = tmp_path / "only_external.yaml"
    p.write_text(
        "profiles:\n"
        "  codex:   {base_url: 'https://chatgpt.com/backend-api/codex', model: 'gpt-5.5', transport: codex_responses, auth: {mode: oauth_codex}, verify_ssl: false}\n"
        "  o4-mini: {base_url: 'https://c/v1', model: 'm4', auth: {mode: api_key, api_key: k}, verify_ssl: false}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("SA_CHAT_PROFILES_PATH", str(p))
    monkeypatch.delenv("SA_CHAT_PROFILE", raising=False)
    monkeypatch.delenv("SA_SMB_AGENT_PROFILE", raising=False)
    monkeypatch.delenv("SA_CHAT_PROFILE_CHAIN", raising=False)

    with pytest.raises(RuntimeError, match="사내"):
        runtime._build_client()


def test_domain_vision_fallback_still_wins_over_the_internal_default(profiles_yaml, monkeypatch):
    """능력 기반 대체는 그대로 — deepseek(이미지 불가) 핀 + require_vision → gemma."""
    from service.agents import runtime
    monkeypatch.setenv("SA_CHAT_PROFILE", "deepseek")
    monkeypatch.setenv("SA_VISION_UNSUPPORTED_PROFILES", "deepseek")
    assert _served(runtime._build_client("gemma", require_vision=True)) == "gemma"
    # require_vision 이 아니면 운영자 선택 존중
    assert _served(runtime._build_client("gemma")) == "deepseek"
