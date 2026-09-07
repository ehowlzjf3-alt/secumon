"""v3.56: factory 가 transport 로 client 분기 + repo yaml codex 프로필 존재."""
from __future__ import annotations

from pathlib import Path

from secu_agent.agent.llm.codex_responses_client import CodexResponsesClient
from secu_agent.agent.llm.factory import _build_client
from secu_agent.agent.llm.internal_gateway import OpenAICompatClient
from secu_agent.agent.llm.profile import AuthConfig, LLMProfile, load_profiles


def test_build_client_codex_transport() -> None:
    p = LLMProfile(name="codex", base_url="https://chatgpt.com/backend-api/codex",
                   model="gpt-5.5", transport="codex_responses",
                   auth=AuthConfig(mode="oauth_codex"))
    assert isinstance(_build_client(p), CodexResponsesClient)


def test_build_client_default_openai_chat() -> None:
    p = LLMProfile(name="oss", base_url="http://x/v1", model="m")
    assert isinstance(_build_client(p), OpenAICompatClient)


def test_repo_codex_profile_present() -> None:
    repo_yaml = Path(__file__).resolve().parents[1] / "config" / "llm_profiles.yaml"
    profs = load_profiles(repo_yaml)
    assert "codex" in profs
    cx = profs["codex"]
    assert cx.transport == "codex_responses"
    assert cx.model == "gpt-5.5"
    assert cx.auth.mode == "oauth_codex"
    assert cx.reasoning_effort == "xhigh"
    assert cx.trust_env is True
    assert cx.verify_ssl is False
    # 기존 fallback 프로필 보존. gpt-oss·gauss-o32·gauss-o41 은 2026-08-20 은퇴(fade-out).
    assert {"o4-mini", "qwen"} <= set(profs)
    # 워커 기본/대체 프로필은 반드시 있어야 한다 — 빠지면 워커가 프로필 없음으로 죽는다.
    assert {"gemma", "deepseek"} <= set(profs)
    assert not ({"gpt-oss", "gauss-o32", "gauss-o41"} & set(profs)), "은퇴한 프로필이 되살아났다"


# ─── v3.81 T1c: 역할별 모델 라우팅 (make_role_client) ─────────────

ROLE_YAML = """\
profiles:
  cheap:
    base_url: http://localhost:1/v1
    model: cheap-model
"""


def test_make_role_client_default_when_env_unset(monkeypatch) -> None:
    from secu_agent.agent.llm import factory
    monkeypatch.delenv("SA_JUDGE_PROFILE", raising=False)
    default = object()
    assert factory.make_role_client("judge", default=default) is default


def test_make_role_client_routes_and_caches(tmp_path, monkeypatch) -> None:
    from secu_agent.agent.llm import factory
    yaml_path = tmp_path / "p.yaml"
    yaml_path.write_text(ROLE_YAML)
    monkeypatch.setenv("SA_CHAT_PROFILES_PATH", str(yaml_path))
    monkeypatch.setenv("SA_JUDGE_PROFILE", "cheap")
    factory._role_client_cache.clear()
    try:
        default = object()
        c1 = factory.make_role_client("judge", default=default)
        assert c1 is not default
        assert isinstance(c1, OpenAICompatClient)
        # process-lifetime 캐시 — 같은 (role, profile) 은 같은 client
        assert factory.make_role_client("judge", default=default) is c1
    finally:
        factory._role_client_cache.clear()


def test_make_role_client_fail_open_on_bad_profile(tmp_path, monkeypatch) -> None:
    """무효 profile → 예외 없이 default (라우팅 실패가 루프를 멈추면 안 됨)."""
    from secu_agent.agent.llm import factory
    yaml_path = tmp_path / "p.yaml"
    yaml_path.write_text(ROLE_YAML)
    monkeypatch.setenv("SA_CHAT_PROFILES_PATH", str(yaml_path))
    monkeypatch.setenv("SA_SUMMARIZER_PROFILE", "ghost")
    default = object()
    assert factory.make_role_client("summarizer", default=default) is default
