"""secu_agent.persistence — 코어 persistence 포트&어댑터 (v3.88 StatePort P1).

- `port`: 순수 인터페이스 `StatePort`/`Conn`.
- `postgres_adapter`: `PostgresStateAdapter`(StatePort 구현) + `default_state_port()` 싱글턴.
- `schema_orchestrator`: 네임스페이스 DDL 등록/lazy 멱등 적용.

코어 테이블은 `core` 스키마, 스킬은 P2 에서 `skill_<name>`, 횡단은 `platform`. finding SSOT 는
코어 소유(core.finding_lifecycle). 역호환 shim 은 `secu_agent.state` 가 계속 제공한다.
"""
from __future__ import annotations

from .port import Conn, StatePort
from .postgres_adapter import PostgresStateAdapter, default_state_port
from .schema_orchestrator import (
    apply_schema,
    register_schema,
    registered_namespaces,
    validate_namespace,
)

__all__ = [
    "Conn",
    "StatePort",
    "PostgresStateAdapter",
    "default_state_port",
    "apply_schema",
    "register_schema",
    "registered_namespaces",
    "validate_namespace",
]
