"""v3.32: LLMProfile extra_body + reasoning_effort_supported + qwen profile.

profile YAML 로딩 → internal_gateway _open_stream 의 extra_body 합성까지 검증.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from secu_agent.agent.llm.internal_gateway import OpenAICompatClient
from secu_agent.agent.llm.profile import load_profiles
from secu_agent.agent.llm.types import LLMRequest


def _write_profiles(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "p.yaml"
    p.write_text(body, encoding="utf-8")
    return p


def test_profile_defaults_keep_backward_compat(tmp_path: Path) -> None:
    """기존 프로필 YAML 은 새 필드 없이도 그대로 로드."""
    p = _write_profiles(tmp_path, """
profiles:
  gpt-oss:
    base_url: http://x/v1
    model: m
""")
    profs = load_profiles(p)
    pr = profs["gpt-oss"]
    assert pr.reasoning_effort_supported is True
    assert pr.extra_body == {}


def test_profile_loads_extra_body_and_reasoning_flag(tmp_path: Path) -> None:
    p = _write_profiles(tmp_path, """
profiles:
  qwen:
    base_url: http://10.0.0.1:9810/v1
    model: Qwen3.5-27B-FP8
    auth:
      mode: api_key
      api_key: dummy
    timeout: 600
    reasoning_effort_supported: false
    extra_body:
      chat_template_kwargs:
        enable_thinking: false
""")
    profs = load_profiles(p)
    pr = profs["qwen"]
    assert pr.reasoning_effort_supported is False
    assert pr.extra_body == {"chat_template_kwargs": {"enable_thinking": False}}
    assert pr.auth.api_key == "dummy"


def _capture_kwargs() -> tuple[OpenAICompatClient, list[dict[str, Any]]]:
    """OpenAICompatClient 만들고 chat.completions.create 를 capture 로 교체."""
    captured: list[dict[str, Any]] = []

    class _FakeStream:
        async def __aiter__(self):
            if False:
                yield  # pragma: no cover

    async def _fake_create(**kwargs):
        captured.append(kwargs)
        return _FakeStream()

    return captured, _fake_create


def _run_open_stream(client: OpenAICompatClient, req: LLMRequest) -> dict[str, Any]:
    captured, fake_create = _capture_kwargs()
    client._client.chat.completions.create = fake_create  # type: ignore[attr-defined]

    async def _go() -> None:
        await client._open_stream(req)
        await client.aclose()

    asyncio.run(_go())
    return captured[0]


def test_gateway_merges_profile_extra_body_with_reasoning(tmp_path: Path) -> None:
    """profile.extra_body 가 있고 reasoning_effort 도 지원하면 두 dict 모두 박힌다."""
    p = _write_profiles(tmp_path, """
profiles:
  mix:
    base_url: http://x/v1
    model: m
    extra_body:
      cache_prompt: true
    reasoning_effort: high
""")
    pr = load_profiles(p)["mix"]
    client = OpenAICompatClient(pr)
    kw = _run_open_stream(client, LLMRequest(messages=[], max_tokens=256))
    assert kw["extra_body"] == {"cache_prompt": True, "reasoning_effort": "high"}


def test_gateway_omits_reasoning_when_unsupported(tmp_path: Path) -> None:
    """reasoning_effort_supported=False 면 per-request 로 와도 inject 금지."""
    p = _write_profiles(tmp_path, """
profiles:
  qwen:
    base_url: http://x/v1
    model: m
    reasoning_effort_supported: false
    extra_body:
      chat_template_kwargs:
        enable_thinking: false
""")
    pr = load_profiles(p)["qwen"]
    client = OpenAICompatClient(pr)
    req = LLMRequest(messages=[], max_tokens=256,
                     vendor_params={"reasoning_effort": "high"})
    kw = _run_open_stream(client, req)
    eb = kw["extra_body"]
    assert "reasoning_effort" not in eb
    assert eb == {"chat_template_kwargs": {"enable_thinking": False}}


def test_gateway_no_extra_body_when_empty(tmp_path: Path) -> None:
    """profile.extra_body 비고 reasoning 도 없으면 extra_body 키 자체가 빠진다."""
    p = _write_profiles(tmp_path, """
profiles:
  plain:
    base_url: http://x/v1
    model: m
    reasoning_effort_supported: false
""")
    pr = load_profiles(p)["plain"]
    client = OpenAICompatClient(pr)
    kw = _run_open_stream(client, LLMRequest(messages=[], max_tokens=256))
    assert "extra_body" not in kw


def test_repo_qwen_profile_present() -> None:
    """config/llm_profiles.yaml 에 qwen 프로필 등록 — SA_CHAT_PROFILE=qwen 으로 스위치."""
    repo_yaml = Path(__file__).resolve().parents[1] / "config" / "llm_profiles.yaml"
    profs = load_profiles(repo_yaml)
    assert "qwen" in profs, "qwen 프로필 등록 필요"
    qw = profs["qwen"]
    assert qw.model == "Qwen3.5-27B-FP8"
    assert qw.reasoning_effort_supported is False
    assert qw.extra_body == {"chat_template_kwargs": {"enable_thinking": False}}


def test_example_template_interpolates_env(monkeypatch) -> None:
    """커밋된 .example 템플릿이 ${VAR} 를 제대로 싣는지 가드.

    이름 이력: `..._and_gptoss_medium` → `..._loads_gauss_sibling` → 지금.
    gpt-oss 는 2026-08-20 은퇴(fade-out)라 템플릿에서 제거됐고, 그 effort=medium
    어서션도 함께 내렸다.

    2026-08-22: `gauss`(GAUSS41_*) 를 겨눴는데 **그 프로파일은 실물 yaml 에 없다** —
    템플릿에만 살아 있던 유령이었다. 실물 yaml 이 gitignore 라 example 이 로스터의
    정본이 되면서(`test_llm_profile_presets.py`) 유령을 계속 실을 이유가 없어졌다.
    이 테스트가 실제로 지키던 성질은 **보간**이므로 살아있는 프로파일로 옮긴다:
      · headers 보간 → llama-4-maverick(x-dep-ticket, User-Id)
      · base_url/model 보간 → o4-mini
    사라진 어서션은 "gauss 와 gaussO4 는 서로 다른 cred 를 쓰는 sibling" 하나뿐이고,
    그건 이제 없는 프로파일에 대한 사실이다.
    """
    for k, v in {
        "OPENAI_BASE_URL": "http://openai.example/v1", "OPENAI_MODEL": "o4-mini-2026",
        "OPENAI_API_KEY": "sk-test", "SOC_USER_ID": "tester", "OPENAI_CRED_KEY": "ok",
        "LITELLM_API_KEY": "sk-lite",
    }.items():
        monkeypatch.setenv(k, v)
    example = Path(__file__).parent.parent / "config" / "llm_profiles.yaml.example"
    profs = load_profiles(example)

    # headers 보간
    assert profs["llama-4-maverick"].headers.get("x-dep-ticket") == "ok"
    assert profs["llama-4-maverick"].headers.get("User-Id") == "tester"
    # base_url / model 보간
    assert profs["o4-mini"].base_url == "http://openai.example/v1"
    assert profs["o4-mini"].model == "o4-mini-2026"
    # 지금 실제로 도는 둘도 템플릿에서 로드된다 (워커 / 리드)
    assert profs["deepseek"].model == "private-deepseek-v4-seunghanee"
    assert profs["codex"].transport == "codex_responses"

    # 은퇴한 이름이 템플릿에 남아 있으면 안 된다 — 남겨두면 env 가 그걸 가리켜도
    # 조용히 버려져(사내 기본 fail-safe) 오타처럼 티가 안 난다.
    for dead in ("gpt-oss", "gauss-o32", "gauss-o41", "gauss"):
        assert dead not in profs, f"은퇴한 {dead} 가 템플릿에 남아 있다"
