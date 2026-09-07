"""리드 모델 격리 — 폴백이 조용히 판단자를 바꾸지 않는다 (2026-08-22).

## 무엇이 문제였나

리드를 `SA_LEAD_PROFILE=codex` 로 띄웠는데, client 가 **전역 체인**
(`SA_CHAT_PROFILE_CHAIN`, 검토원용 사내 모델)을 물려받아
`fallback(retry(codex) -> retry(gemma))` 가 됐다.

그 자체는 안전 문제가 아니다(gemma 는 사내다). 문제는 **판단의 출처가 사라지는 것**이다:
codex 가 간헐 500 을 내면 gemma 가 대신 답하는데, 로그에도 캡처에도 그 사실이 안 남는다.
실제로 "리드가 정말 codex 로 돌았나" 를 확인하는 데 시간을 썼고, 당시 자료로는 판정이
불가능했다 — 캡처의 `profile` 은 래퍼 이름이고, 요청의 `reasoning_effort` 는 arm 선택
**전** 값이라 둘 다 근거가 못 됐다.

## 이 파일이 지키는 사실

1. 역할 프로파일이 명시되면 **전역 체인을 물려받지 않는다**(미설정=폴백 없음).
2. 폴백을 원하면 `SA_LEAD_PROFILE_CHAIN` 으로 **명시**해야 한다.
3. 역할 프로파일이 없으면 오늘과 동일하다(전역 체인 그대로).
4. 캡처가 **누가 응답했는지**를 요청마다 남긴다.
"""
from __future__ import annotations

import json

import pytest
from secu_agent.agent.llm.fallback import FallbackLLMClient

from _shared.lead_contract import LEAD_CHAIN_ENV, LEAD_PROFILE_ENV
from service.agents.runtime import GLOBAL_CHAIN_ENV, _build_client


def _arms(client) -> list[str]:
    members = getattr(client, "clients", None) or getattr(client, "_clients", None)
    if not members:
        return [getattr(client, "_profile_name", type(client).__name__)]
    return [getattr(m, "_profile_name", type(m).__name__) for m in members]


@pytest.mark.parametrize("lead", ["codex", "deepseek"])
def test_role_profile_does_not_inherit_the_global_chain(monkeypatch, lead):
    """★ 이게 이 파일의 요점 — 리드가 한 모델로 시작해 다른 모델로 넘어가면 안 된다.

    `deepseek` 도 함께 건다: 리드 모델 A/B(프리셋 [C])의 전제가 **폴백 없음**이다.
    폴백이 뛰면 판단 주체가 사라져 측정 자체가 무의미해진다.
    """
    monkeypatch.setenv(GLOBAL_CHAIN_ENV, "gemma")
    monkeypatch.delenv(LEAD_CHAIN_ENV, raising=False)
    client = _build_client(None, override=lead, chain_env=LEAD_CHAIN_ENV)
    assert not isinstance(client, FallbackLLMClient), _arms(client)
    assert _arms(client) == [lead]


def test_ab_preset_c_gives_a_chained_worker_and_a_single_lead(monkeypatch):
    """프리셋 [C] 그대로 — 같은 프로세스에서 워커는 체인, 리드는 단일.

    두 축이 **서로 다른 env 를 읽는다**는 것이 여기서 지켜져야 할 사실이다. 검토원은
    간헐 500 에 죽으면 안 되니 체인을 유지하고, 리드는 어트리뷰션을 위해 단일이어야 한다.
    한 env 로 둘 다 조종하던 시절엔 이 조합 자체를 표현할 수 없었다.
    """
    monkeypatch.setenv(GLOBAL_CHAIN_ENV, "deepseek,gemma")
    monkeypatch.delenv(LEAD_CHAIN_ENV, raising=False)

    lead = _build_client(None, override="deepseek", chain_env=LEAD_CHAIN_ENV)
    worker = _build_client(None, override="deepseek")

    assert _arms(lead) == ["deepseek"], "리드에 폴백이 붙으면 A/B 가 깨진다"
    assert _arms(worker) == ["deepseek", "gemma"], "검토원 체인까지 같이 없애면 안 된다"


def test_explicit_role_chain_is_honored(monkeypatch):
    """폴백이 필요하면 **명시**하면 된다 — 능력을 없앤 게 아니라 기본값을 바꾼 것이다."""
    monkeypatch.setenv(GLOBAL_CHAIN_ENV, "gemma")
    monkeypatch.setenv(LEAD_CHAIN_ENV, "codex,gemma")
    client = _build_client(None, override="codex", chain_env=LEAD_CHAIN_ENV)
    assert isinstance(client, FallbackLLMClient)
    assert _arms(client) == ["codex", "gemma"]


def test_worker_path_is_unchanged(monkeypatch):
    """역할 env 를 안 쓰는 검토원/러너는 오늘 그대로 전역 체인을 탄다."""
    monkeypatch.setenv(GLOBAL_CHAIN_ENV, "gemma,deepseek")
    client = _build_client(None, override="gemma")
    assert _arms(client) == ["gemma", "deepseek"]


def test_lead_contract_passes_the_role_chain_only_when_pinned():
    """★ 역할 프로파일이 없으면 체인 env 도 안 넘긴다 — 안 그러면 러너 경로가 바뀐다."""
    import inspect

    from _shared import lead_contract

    src = inspect.getsource(lead_contract.build_lead_contract)
    assert 'kwargs["chain_env"] = LEAD_CHAIN_ENV' in src
    assert "if role_profile:" in src


def test_env_names_are_role_scoped():
    assert LEAD_PROFILE_ENV == "SA_LEAD_PROFILE"
    assert LEAD_CHAIN_ENV == "SA_LEAD_PROFILE_CHAIN"
    assert LEAD_CHAIN_ENV != GLOBAL_CHAIN_ENV


# ── 캡처가 서빙 프로파일을 남긴다 ─────────────────────────────────────

class _FakeInner:
    name = "fallback(retry(codex) -> retry(gemma))"

    def __init__(self, served_as: str) -> None:
        self._served_as = served_as

    async def stream(self, request):  # noqa: ANN001
        from service.agents import llm_provenance

        llm_provenance._PROCESS_SERVED.clear()
        llm_provenance._PROCESS_SERVED.update(
            {"llm_profile": self._served_as, "llm_model": f"{self._served_as}-model"})
        for ev in ("a", "b"):
            yield ev


def _capture(tmp_path, monkeypatch, served_as: str) -> list[dict]:
    import asyncio

    from _shared.egress_capture import wrap_egress_capture

    path = tmp_path / "egress.jsonl"
    monkeypatch.setenv("SA_EGRESS_CAPTURE", str(path))
    client = wrap_egress_capture(_FakeInner(served_as), role="lead", task_type="t")

    async def go():
        async for _ in client.stream({"messages": []}):
            pass

    asyncio.run(go())
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x]


def test_capture_records_who_actually_answered(tmp_path, monkeypatch):
    """★ `profile` 은 래퍼 이름이라 arm 을 말하지 않는다 — `served` 가 그걸 말한다."""
    rows = _capture(tmp_path, monkeypatch, "codex")
    assert rows[0]["profile"] == "fallback(retry(codex) -> retry(gemma))"
    served = [r for r in rows if "served" in r]
    assert served and served[0]["served"]["llm_profile"] == "codex"
    assert served[0]["seq"] == rows[0]["seq"], "요청과 서빙기록이 seq 로 짝지어져야 한다"


def test_capture_shows_a_fallback_when_it_happens(tmp_path, monkeypatch):
    """폴백이 뛰면 그게 **보여야** 한다 — 그게 이 기록의 존재 이유다."""
    rows = _capture(tmp_path, monkeypatch, "gemma")
    served = [r for r in rows if "served" in r]
    assert served[0]["served"]["llm_profile"] == "gemma"


def test_capture_notes_served_even_when_the_stream_raises(tmp_path, monkeypatch):
    import asyncio

    from _shared.egress_capture import wrap_egress_capture

    class _Boom(_FakeInner):
        async def stream(self, request):  # noqa: ANN001
            from service.agents import llm_provenance

            llm_provenance._PROCESS_SERVED.clear()
            llm_provenance._PROCESS_SERVED.update({"llm_profile": "codex"})
            yield "a"
            raise RuntimeError("mid-stream 500")

    path = tmp_path / "e.jsonl"
    monkeypatch.setenv("SA_EGRESS_CAPTURE", str(path))
    client = wrap_egress_capture(_Boom("codex"), role="lead", task_type="t")

    async def go():
        async for _ in client.stream({"messages": []}):
            pass

    with pytest.raises(RuntimeError):
        asyncio.run(go())
    rows = [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x]
    assert any("served" in r for r in rows), "실패한 arm 도 기록 가치가 있다"
