"""워커 finding 에 **실제로 응답한 LLM** 을 기록한다.

배경(2026-07-29): 모델 A/B 이후 "어제 github 30 건은 gauss-o32 가 낸 건가, 폴백한
gpt-oss 가 낸 건가"에 답할 수 없었다. 엔진 `runtime_llm_metadata` 는 `chat_session.py`
에서만 호출돼 워커 finding 의 extra_json 에는 아무 것도 안 붙는다(실측: 최근 3 일 33 건
전부 `llm_profile=None`). 모델을 재평가하려면 먼저 "누가 찾았나"가 데이터에 있어야 한다.

## 왜 값을 실시간 갱신하나

엔진 `agent_provenance` 는 metadata 에서 **고정 키 집합**만 finding 으로 옮긴다
(`agent_type` / `llm_profile` / `llm_client` / `llm_model` + `llm_profile_chain`).
엔진은 무수정이라 새 키를 추가할 수 없다. 대신 그 키들의 **값**을 갱신한다: 체인의 각
프로파일 client 를 태그 래퍼로 감싸고, 실제로 스트림을 낸 순간 harness metadata 의
`llm_profile`/`llm_model` 을 그 프로파일로 덮어쓴다. persist 는 언제나 턴 **뒤에**
일어나므로, finding 에는 그 finding 을 만든 턴을 서빙한 모델이 남는다.

폴백이 뛰면 `llm_profile`(마지막 서빙) != `llm_profile_chain[0]`(설정 선두) 이 되고,
그 차이 자체가 "1 순위 게이트웨이가 아팠다"는 신호다.

## 두 경로

1. **bound metadata**(정확) — `run_agent` 가 harness metadata 를 recorder 에 bind.
   엔진 `SubmitFindingTool`(smb/dev_web) · `_persist_scanned_findings`(github/confluence)
   가 전부 `with_agent_provenance(..., context.metadata)` 를 지나가므로 호출부 수정
   없이 덮인다. (`domain_report_tool` 도 이 경로였으나 도달 불가로 제거됐다.)
2. **프로세스 스냅샷**(근사) — `context` 가 없는 결정론 경로(clone+detector 스캔 등)용.
   워커 1 프로세스 = 1 프로파일 설정이라는 배포 형태에서만 정확하다. 한 번도 서빙되지
   않았으면 **빈 dict** 를 준다 — LLM 이 안 낀 실행에 모델을 갖다 붙이지 않는다.
"""
from __future__ import annotations

from collections.abc import Mapping, MutableMapping
from typing import Any, AsyncIterator

from secu_agent.agent.llm.types import StreamError

# 이 프로세스에서 마지막으로 **실제 응답**한 모델. context 없는 persist 경로용(경로 2).
# 서빙이 한 번도 없으면 비어 있다.
_PROCESS_SERVED: dict[str, Any] = {}


def _clean(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


class ServedProfileRecorder:
    """어느 프로파일이 실제로 응답했는지 추적해 bind 된 metadata 에 반영한다.

    `run_agent` 1 회 = recorder 1 개(= `_build_client` 1 회). 같은 프로세스에서 에이전트를
    동시 실행해도 서로의 metadata 를 건드리지 않는다.
    """

    def __init__(self) -> None:
        self._bound: list[MutableMapping[str, Any]] = []
        self._served: dict[str, str] = {}
        self._used: list[str] = []

    def bind(self, metadata: MutableMapping[str, Any]) -> None:
        self._bound.append(metadata)
        self._apply(metadata)

    def record(self, profile: str, model: str | None) -> None:
        name = _clean(profile)
        if name is None:
            return
        if name not in self._used:
            self._used.append(name)
        self._served = {"llm_profile": name}
        model_name = _clean(model)
        if model_name:
            self._served["llm_model"] = model_name
        for metadata in self._bound:
            self._apply(metadata)
        _PROCESS_SERVED.clear()
        _PROCESS_SERVED.update(self._served)
        if len(self._used) > 1:
            _PROCESS_SERVED["llm_profiles_used"] = list(self._used)

    def _apply(self, metadata: MutableMapping[str, Any]) -> None:
        metadata.update(self._served)
        # 엔진 고정 키가 아니라 finding 까지는 안 가지만, 워커 RESULT/로그에서 폴백을 본다.
        if len(self._used) > 1:
            metadata["llm_profiles_used"] = list(self._used)

    @property
    def served(self) -> list[str]:
        """실제로 응답한 프로파일 — 처음 서빙한 순서. 비었으면 아직 한 턴도 안 돌았다."""
        return list(self._used)


class ProfileTaggedClient:
    """스트림이 실제 이벤트를 내면 그 프로파일을 recorder 에 기록하는 얇은 래퍼.

    `StreamError` 만 내고 끝난 client 는 **기록하지 않는다** — 시도했으나 아무것도 못 낸
    것이라, 그걸 "이 모델이 찾았다"로 남기면 A/B 어트리뷰션이 뒤집힌다. 폴백이 다음
    프로파일로 넘어가 성공하면 그쪽이 마지막 기록이 된다.

    ⚠️ 속성명이 `_profile` 이면 안 된다 — 엔진 `client_model_name` 이 `_profile.model` 로
    모델명을 캐므로, 문자열을 `_profile` 에 두면 모델 추출이 조용히 None 이 된다.
    `__getattr__` 위임으로 inner 의 진짜 `_profile` 이 보이게 둔다.
    """

    def __init__(self, inner: Any, *, profile: str, model: str | None,
                 recorder: ServedProfileRecorder) -> None:
        self._inner = inner
        self._profile_name = profile
        self._model_name = model
        self._recorder = recorder

    @property
    def name(self) -> str:
        return str(getattr(self._inner, "name", self._profile_name))

    def __getattr__(self, item: str) -> Any:
        # name/stream 은 자기 것. 그 외(_profile/harness_tier/aclose/...)는 inner 위임.
        return getattr(self._inner, item)

    async def stream(self, request: Any) -> AsyncIterator[Any]:
        recorded = False
        async for event in self._inner.stream(request):
            if not recorded and not isinstance(event, StreamError):
                self._recorder.record(self._profile_name, self._model_name)
                recorded = True
            yield event


def tag_profile(inner: Any, *, profile: str, model: str | None,
                recorder: ServedProfileRecorder) -> ProfileTaggedClient:
    return ProfileTaggedClient(inner, profile=profile, model=model, recorder=recorder)


def attach_recorder(client: Any, recorder: ServedProfileRecorder) -> Any:
    """`_build_client` 가 돌려주는 최종 client 에 recorder 를 달아 둔다(run_agent 가 찾음)."""
    try:
        client._sa_llm_recorder = recorder
    except AttributeError:  # __slots__ client — 프로세스 스냅샷 경로로 폴백
        pass
    return client


def llm_recorder(client: Any) -> ServedProfileRecorder | None:
    found = getattr(client, "_sa_llm_recorder", None)
    return found if isinstance(found, ServedProfileRecorder) else None


def process_served_llm() -> dict[str, Any]:
    """이 프로세스에서 마지막으로 응답한 모델. 서빙 이력이 없으면 빈 dict."""
    return dict(_PROCESS_SERVED)


def with_served_llm(extra: Mapping[str, Any] | None) -> dict[str, Any]:
    """context 없는 persist 경로용 — `agent_provenance` 에 서빙 모델을 병합.

    서빙 이력이 없으면(순수 CLI/배치) 아무 것도 안 붙인다.
    """
    out = dict(extra or {})
    served = process_served_llm()
    if not served:
        return out
    provenance = dict(out.get("agent_provenance") or {})
    provenance.update(served)
    out["agent_provenance"] = provenance
    return out


def reset_for_tests() -> None:
    _PROCESS_SERVED.clear()
