"""web 라우트 테스트 공용 fixture.

v3.81 T4: agent_type 는 등록형(agent_type_registry) — 코어 단독으론 'agent' 뿐이다.
web 라우트 테스트들은 다중 agent_type 필터링/세션 라우팅이 목적이라, plugin 이
도메인 agent_type 를 등록한 상태(재부착 후 운영 형상)를 시뮬레이션한다.
도메인 '코드'가 아니라 등록 메커니즘을 통한 이름 등록만이다 — de-domain
회귀 가드(도메인 모듈/도구 부재 검증)와 충돌하지 않는다.
"""
from __future__ import annotations

import pytest

from secu_agent.agent_type_registry import register_agent_type, unregister_agent_type

_SIMULATED_PLUGIN_AGENT_TYPES = ("smb", "web", "github", "jenkins", "confluence")


@pytest.fixture(autouse=True)
def _plugin_agent_types_registered():
    registered = []
    for name in _SIMULATED_PLUGIN_AGENT_TYPES:
        try:
            register_agent_type(name)
        except ValueError:
            continue  # 다른 fixture/테스트가 이미 등록
        registered.append(name)
    try:
        yield
    finally:
        for name in registered:
            unregister_agent_type(name)
