"""StatePort — 코어 persistence 포트 (순수 인터페이스, DB 무지).

v3.88: 코어는 구체 DB 를 소유하는 대신 이 포트를 소유하고, `PostgresStateAdapter` 가 구현한다.
스킬(secu-agent-skill, P2)은 이 인터페이스에 코딩한다. finding_* 시그니처는 현행
`secu_agent.state.finding_*` 와 **동일**해 기존 호출자(도메인 submit_finding 래퍼)가 안 깨진다.
신규 seam 은 `connection(namespace)` + `register_schema` 둘뿐.
"""
from __future__ import annotations

from typing import Any, ContextManager, Protocol, Sequence, runtime_checkable


@runtime_checkable
class Conn(Protocol):
    """네임스페이스 스코프 커넥션 (어댑터 구현). sqlite 호환 래퍼(`?`→`%s`)를 유지한다.

    `execute()` 는 커서 유사 객체를 돌려주고 `.fetchone()/.fetchall()` 로 소비한다
    (기존 `secu_agent.state` 호출 패턴과 동일)."""

    def execute(self, sql: str, params: Sequence[Any] = ()) -> Any: ...


@runtime_checkable
class StatePort(Protocol):
    # ── 네임스페이스 스코프 커넥션 ──
    def connection(
        self, namespace: str = "core", *, ensure_schema: bool = True,
    ) -> ContextManager[Conn]:
        """`namespace`(스키마)로 search_path 스코프된 커넥션. 트랜잭션 내 `SET LOCAL` —
        신규 경로엔 public fallback 없음(미이관 테이블 fail-fast). namespace 미지정=core.
        ensure_schema=False: skill_* lazy DDL(apply_schema) 스킵 — 명시 migrator 가
        provisioning 했다고 신뢰(runtime writer/migrator 권한 분리). 등록 확인(LookupError)은 유지."""
        ...

    # ── 스킬 state 소유 등록 (신규 핵심 seam) ──
    def register_schema(
        self,
        namespace: str,
        baseline_ddl: str,
        *,
        migrations: Sequence[tuple[int, str]] = (),
        idless_tables: Sequence[str] = (),
        concurrent_steps: Sequence[str] = (),
    ) -> None:
        """스킬이 자기 네임스페이스에 자기 테이블 DDL 을 등록. 등록=순수 메모리(플러그인
        import 시 DB/pool 무접근). 실제 DDL 실행은 lazy(첫 connection(ns) 또는 명시 apply)."""
        ...

    # ── finding SSOT (코어 소유·현행 시그니처 동일) ──
    def finding_upsert(
        self,
        *,
        task_type: str,
        asset: str,
        asset_kind: str,
        severity: str,
        summary: str,
        fingerprint: str | None = None,
        owner: str | None = None,
        ticket_ref: str | None = None,
        sla_due: float | None = None,
        evidence_ref: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> tuple[int, bool]:
        """core.finding_lifecycle 에 upsert(fingerprint UNIQUE dedup + advisory xact lock).
        (id, created) 반환 — 현행 `state.finding_upsert` 와 동일."""
        ...

    def finding_list(
        self,
        *,
        status: str | None = None,
        task_type: str | None = None,
        since: float | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]: ...

    def finding_get(self, finding_id: int) -> dict[str, Any] | None: ...
