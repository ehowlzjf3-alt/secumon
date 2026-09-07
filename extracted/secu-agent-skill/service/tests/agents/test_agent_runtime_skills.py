from __future__ import annotations

import pytest


def test_default_skill_search_dirs_load_github_worker_contracts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.agents import runtime

    monkeypatch.delenv("SA_SKILLS_DIRS", raising=False)

    expected = {
        "github_task": "GitHub E2E SSO URL worker",
        "github_scan": "GitHub API candidate search",
        "github_report": "Default recipient policy is DSSOC-only",
        "github_recheck": "Retry attempts are bounded",
    }
    for skill_name, marker in expected.items():
        text = runtime.load_skill_contract(skill_name, resource="worker.md")
        assert marker in text


def test_default_skill_search_dirs_keep_confluence_contracts_loadable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from service.agents import runtime

    monkeypatch.delenv("SA_SKILLS_DIRS", raising=False)

    expected = {
        "confluence_task": "Confluence E2E worker",
        "confluence_report": "DSSOC-only recipients by",
        "confluence_recheck": "Retry attempts are bounded",
    }
    for skill_name, marker in expected.items():
        text = runtime.load_skill_contract(skill_name, resource="worker.md")
        assert marker in text


def test_skill_contract_loader_rejects_unlisted_resources(monkeypatch: pytest.MonkeyPatch) -> None:
    from service.agents import runtime

    monkeypatch.delenv("SA_SKILLS_DIRS", raising=False)

    with pytest.raises(FileNotFoundError):
        runtime.load_skill_contract("github_task", resource="../github_scan/worker.md")


def _write_profiles(tmp_path):
    """3 프로파일 최소 llm_profiles.yaml — client 실제 생성 없이 이름/체인 배선만 검증."""
    p = tmp_path / "llm_profiles.yaml"
    p.write_text(
        "profiles:\n"
        "  deepseek: {base_url: 'https://x/v1', model: 'm1', auth: {mode: api_key, api_key: k}, verify_ssl: false}\n"
        "  llama-4-maverick: {base_url: 'https://x/v1', model: 'm2', auth: {mode: api_key, api_key: k}, verify_ssl: false}\n"
        "  gemma:   {base_url: 'https://y/v1', model: 'm3', auth: {mode: api_key, api_key: k}, verify_ssl: false}\n",
        encoding="utf-8",
    )
    return p


def test_build_client_single_profile_no_chain(tmp_path, monkeypatch):
    """체인 미설정 → 단일 client (기존 동작 보존, FallbackLLMClient 아님)."""
    from service.agents import runtime
    from secu_agent.agent.llm.fallback import FallbackLLMClient

    monkeypatch.setenv("SA_CHAT_PROFILES_PATH", str(_write_profiles(tmp_path)))
    monkeypatch.setenv("SA_CHAT_PROFILE", "deepseek")
    monkeypatch.delenv("SA_CHAT_PROFILE_CHAIN", raising=False)
    cl = runtime._build_client()
    assert not isinstance(cl, FallbackLLMClient)


def test_build_client_chain_wraps_fallback_selected_first(tmp_path, monkeypatch):
    """체인 설정 → FallbackLLMClient, 선택 프로파일이 선두 + 나머지 폴백 (gauss 500 흡수)."""
    from service.agents import runtime
    from secu_agent.agent.llm.fallback import FallbackLLMClient

    monkeypatch.setenv("SA_CHAT_PROFILES_PATH", str(_write_profiles(tmp_path)))
    monkeypatch.setenv("SA_CHAT_PROFILE", "deepseek")
    monkeypatch.setenv("SA_CHAT_PROFILE_CHAIN", "deepseek,gemma")
    cl = runtime._build_client()
    assert isinstance(cl, FallbackLLMClient)
    # name(fallback 표기)에 3프로파일이 순서대로 들어가야 함
    assert cl.name.count("->") == 1


def test_build_client_per_worker_override_stays_primary(tmp_path, monkeypatch):
    """per-worker SA_CHAT_PROFILE override 가 체인 선두보다 우선(override 보존)."""
    from service.agents import runtime
    from secu_agent.agent.llm.fallback import FallbackLLMClient

    monkeypatch.setenv("SA_CHAT_PROFILES_PATH", str(_write_profiles(tmp_path)))
    monkeypatch.setenv("SA_CHAT_PROFILE", "gemma")  # 워커가 명시 override
    monkeypatch.setenv("SA_CHAT_PROFILE_CHAIN", "deepseek,gemma")
    cl = runtime._build_client()
    assert isinstance(cl, FallbackLLMClient)
    # gemma 가 선두여야 함(선택 override), 중복 제거로 2개 유지.
    # 구 어서션은 픽스처 모델명("m3"/"gpt")을 봤는데 client.name 은 **프로파일명**을 쓴다
    # — 이름 순서를 직접 본다.
    assert cl.name.index("gemma") < cl.name.index("deepseek")
    assert cl.name.count("->") == 1
