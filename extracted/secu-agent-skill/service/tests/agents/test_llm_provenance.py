"""워커 finding 의 LLM 어트리뷰션 — 실제로 응답한 모델이 남는지.

회귀 대상(2026-07-29): 워커 finding extra_json 에 모델 정보가 전혀 없어(실측 33/33 건
llm_profile=None) "설정한 모델이 찾았나 폴백한 모델이 찾았나"를 사후에 알 수 없었다.
"""
from __future__ import annotations

import asyncio

import pytest

from secu_agent.agent.finding_provenance import agent_provenance, client_model_name
from secu_agent.agent.llm.types import StreamError, StreamTextDelta

from service.agents.llm_provenance import (
    ServedProfileRecorder,
    llm_recorder,
    process_served_llm,
    reset_for_tests,
    tag_profile,
    with_served_llm,
)


@pytest.fixture(autouse=True)
def _clean_process_state():
    reset_for_tests()
    yield
    reset_for_tests()


class _FakeProfile:
    def __init__(self, model: str) -> None:
        self.model = model


class _FakeClient:
    """events 를 그대로 흘리는 최소 client. `_profile` 은 엔진 model 추출 계약용."""

    def __init__(self, name: str, events: list, model: str = "m") -> None:
        self.name = name
        self._events = events
        self._profile = _FakeProfile(model)
        self.calls = 0

    async def stream(self, request):  # noqa: ANN001
        self.calls += 1
        for event in self._events:
            yield event


def _drain(client) -> list:
    """이 저장소 관례: pytest-asyncio 없이 asyncio.run 으로 감싼다."""
    async def _go():
        return [event async for event in client.stream(object())]

    return asyncio.run(_go())


# ── 기록 규칙 ───────────────────────────────────────────────────────────────


def test_serving_profile_is_recorded_on_first_real_event():
    recorder = ServedProfileRecorder()
    metadata: dict = {}
    recorder.bind(metadata)
    tagged = tag_profile(
        _FakeClient("inner", [StreamTextDelta(text="hi")]),
        profile="gemma", model="openai/Gemma4-260430", recorder=recorder,
    )

    _drain(tagged)

    assert metadata["llm_profile"] == "gemma"
    assert metadata["llm_model"] == "openai/Gemma4-260430"
    assert recorder.served == ["gemma"]


def test_error_only_stream_is_not_recorded_as_serving():
    """시도했으나 아무것도 못 낸 모델을 '찾았다'로 기록하면 A/B 어트리뷰션이 뒤집힌다."""
    recorder = ServedProfileRecorder()
    metadata: dict = {}
    recorder.bind(metadata)
    tagged = tag_profile(
        _FakeClient("inner", [StreamError(kind="transient", message="500", retryable=True)]),
        profile="gemma", model="openai/Gemma4-260430", recorder=recorder,
    )

    _drain(tagged)

    assert "llm_profile" not in metadata
    assert recorder.served == []
    assert process_served_llm() == {}


def test_fallback_attributes_the_profile_that_actually_served():
    """1 순위가 500 으로 죽고 2 순위가 응답 → finding 은 2 순위 것이어야 한다."""
    recorder = ServedProfileRecorder()
    metadata: dict = {"llm_profile": "deepseek", "llm_model": "chain"}
    recorder.bind(metadata)
    primary = tag_profile(
        _FakeClient("p", [StreamError(kind="transient", message="500", retryable=True)]),
        profile="gemma", model="openai/Gemma4-260430", recorder=recorder,
    )
    fallback = tag_profile(
        _FakeClient("f", [StreamTextDelta(text="ok")]),
        profile="gemma", model="openai/Gemma4-260430", recorder=recorder,
    )

    _drain(primary)
    _drain(fallback)

    assert metadata["llm_profile"] == "gemma"
    assert metadata["llm_model"] == "openai/Gemma4-260430"


def test_multiple_serving_profiles_are_listed_in_first_seen_order():
    recorder = ServedProfileRecorder()
    metadata: dict = {}
    recorder.bind(metadata)
    for profile in ("deepseek", "gemma", "deepseek"):
        _drain(tag_profile(
            _FakeClient("c", [StreamTextDelta(text="x")]),
            profile=profile, model=f"model-{profile}", recorder=recorder,
        ))

    assert recorder.served == ["deepseek", "gemma"]
    assert metadata["llm_profiles_used"] == ["deepseek", "gemma"]
    assert metadata["llm_profile"] == "deepseek"  # 마지막 서빙 (루프 3회차)


def test_binding_after_serving_still_picks_up_the_served_profile():
    """bind 순서에 의존하지 않는다 — run_agent 는 client 를 먼저 만든다."""
    recorder = ServedProfileRecorder()
    _drain(tag_profile(
        _FakeClient("c", [StreamTextDelta(text="x")]),
        profile="gemma", model="m3", recorder=recorder,
    ))
    metadata: dict = {}
    recorder.bind(metadata)

    assert metadata["llm_profile"] == "gemma"


def test_concurrent_agents_do_not_cross_contaminate_bound_metadata():
    """recorder 는 run_agent 1 회당 1 개 — 같은 프로세스의 다른 실행을 안 건드린다."""
    rec_a, rec_b = ServedProfileRecorder(), ServedProfileRecorder()
    meta_a: dict = {}
    meta_b: dict = {}
    rec_a.bind(meta_a)
    rec_b.bind(meta_b)

    _drain(tag_profile(_FakeClient("a", [StreamTextDelta(text="x")]),
                             profile="deepseek", model="m1", recorder=rec_a))
    _drain(tag_profile(_FakeClient("b", [StreamTextDelta(text="y")]),
                             profile="gemma", model="m3", recorder=rec_b))

    assert meta_a["llm_profile"] == "deepseek"
    assert meta_b["llm_profile"] == "gemma"


# ── 엔진 계약: metadata → finding extra ────────────────────────────────────


def test_served_profile_reaches_finding_extra_through_engine_provenance():
    """엔진 `agent_provenance` 는 고정 키만 옮긴다 — 그 키의 '값'을 갱신하는 설계의 근거."""
    recorder = ServedProfileRecorder()
    metadata: dict = {
        "llm_profile": "deepseek",
        "llm_profile_chain": ["deepseek", "gemma"],
        "llm_client": "fallback(retry(a) -> retry(b))",
    }
    recorder.bind(metadata)
    _drain(tag_profile(
        _FakeClient("c", [StreamTextDelta(text="x")]),
        profile="gemma", model="openai/Gemma4-260430", recorder=recorder,
    ))

    provenance = agent_provenance(metadata)

    assert provenance["llm_profile"] == "gemma"        # 실제 서빙
    assert provenance["llm_model"] == "openai/Gemma4-260430"
    assert provenance["llm_profile_chain"][0] == "deepseek"  # 설정 선두는 그대로
    # 서빙 != 체인 선두 = "1 순위 게이트웨이가 아팠다" 신호.
    assert provenance["llm_profile"] != provenance["llm_profile_chain"][0]


def test_tagged_client_does_not_break_engine_model_extraction():
    """⚠️ 속성명을 `_profile` 로 두면 엔진 model 추출이 조용히 None 이 된다."""
    tagged = tag_profile(
        _FakeClient("inner", [], model="openai/DeepseekV4"),
        profile="gemma", model="openai/Gemma4-260430", recorder=ServedProfileRecorder(),
    )

    assert client_model_name(tagged) == "openai/DeepseekV4"
    assert tagged.name == "inner"


# ── context 없는 persist 경로 ──────────────────────────────────────────────


def test_with_served_llm_is_a_noop_when_no_llm_ever_ran():
    """순수 배치/CLI 실행에 모델을 갖다 붙이지 않는다."""
    extra = {"source": "github_e2e_scan"}

    assert with_served_llm(extra) == extra
    assert "agent_provenance" not in with_served_llm(extra)


def test_with_served_llm_stamps_the_process_serving_model():
    recorder = ServedProfileRecorder()
    _drain(tag_profile(
        _FakeClient("c", [StreamTextDelta(text="x")]),
        profile="gemma", model="openai/Gemma4-260430", recorder=recorder,
    ))

    out = with_served_llm({"source": "github_e2e_scan"})

    assert out["source"] == "github_e2e_scan"
    assert out["agent_provenance"]["llm_profile"] == "gemma"
    assert out["agent_provenance"]["llm_model"] == "openai/Gemma4-260430"


def test_with_served_llm_preserves_existing_provenance_keys():
    recorder = ServedProfileRecorder()
    _drain(tag_profile(
        _FakeClient("c", [StreamTextDelta(text="x")]),
        profile="gemma", model="m3", recorder=recorder,
    ))

    out = with_served_llm({"agent_provenance": {"session_id": 7}})

    assert out["agent_provenance"]["session_id"] == 7
    assert out["agent_provenance"]["llm_profile"] == "gemma"


# ── _build_client 배선 ─────────────────────────────────────────────────────


def _write_profiles(tmp_path):
    path = tmp_path / "llm_profiles.yaml"
    path.write_text(
        "profiles:\n"
        "  deepseek: {base_url: 'https://x/v1', model: 'm1', auth: {mode: api_key, api_key: k}, verify_ssl: false}\n"
        "  gemma:   {base_url: 'https://y/v1', model: 'm3', auth: {mode: api_key, api_key: k}, verify_ssl: false}\n",
        encoding="utf-8",
    )
    return path


def test_build_client_attaches_a_recorder_single_profile(tmp_path, monkeypatch):
    from service.agents import runtime

    monkeypatch.setenv("SA_CHAT_PROFILES_PATH", str(_write_profiles(tmp_path)))
    monkeypatch.setenv("SA_CHAT_PROFILE", "deepseek")
    monkeypatch.delenv("SA_CHAT_PROFILE_CHAIN", raising=False)

    client = runtime._build_client()

    assert llm_recorder(client) is not None
    assert client_model_name(client) == "m1"  # 태그 래퍼가 모델 추출을 안 가린다


def test_build_client_attaches_a_recorder_shared_across_the_chain(tmp_path, monkeypatch):
    from service.agents import runtime

    monkeypatch.setenv("SA_CHAT_PROFILES_PATH", str(_write_profiles(tmp_path)))
    monkeypatch.setenv("SA_CHAT_PROFILE", "deepseek")
    monkeypatch.setenv("SA_CHAT_PROFILE_CHAIN", "deepseek,gemma")

    client = runtime._build_client()
    recorder = llm_recorder(client)

    assert recorder is not None
    # 체인의 모든 client 가 **같은** recorder 를 공유해야 폴백을 한 줄로 추적한다.
    assert all(c._recorder is recorder for c in client._clients)
