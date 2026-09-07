"""PostgresStateAdapter — StatePort 의 Postgres 구현 (v3.88).

현 `secu_agent.state` 의 풀·finding 로직에 **얇게 위임**한다(SQL 중복 0). 신규 seam:
- `connection(namespace)`: 트랜잭션 내 `SET LOCAL search_path`(신규 경로엔 public fallback 없음).
- `register_schema(...)`: schema_orchestrator 에 순수 등록(+ 첫 connection 에서 lazy 적용).
`default_state_port()` 싱글턴이 P2 DI 진입점이다.
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Sequence

from . import schema_orchestrator as _orch


def _search_path_for(ns: str) -> str:
    # 신규 경로엔 public 미포함 → 미이관 테이블이 조용히 resolve 되어 P2 오류를 숨기지 않게(fail-fast).
    # pg_temp 는 명시적 마지막(임시 테이블 shadowing 차단).
    if ns == "core":
        return "core, platform, pg_catalog, pg_temp"
    if ns == "platform":
        return "platform, core, pg_catalog, pg_temp"
    return f"{ns}, platform, core, pg_catalog, pg_temp"  # skill_*


class PostgresStateAdapter:
    """StatePort 구현. 상태(풀·스키마 레지스트리)는 프로세스 전역이라 인스턴스는 얇다."""

    # ── 네임스페이스 스코프 커넥션 ──
    @contextmanager
    def connection(self, namespace: str = "core", *, ensure_schema: bool = True):
        ns = _orch.validate_namespace(namespace)
        from secu_agent import state
        if ns.startswith("skill_"):
            if ns not in _orch.registered_namespaces():
                raise LookupError(f"persistence namespace not registered: {ns!r}")
            # ensure_schema=False: lazy DDL(apply_schema) 스킵 — 명시 migrator 가
            # 이미 provisioning 했다고 신뢰(runtime writer 와 migrator 권한 분리의
            # 코어측 토대). 미provisioning 이면 이후 SELECT/INSERT 가 42P01
            # (undefined_table)로 깨끗이 실패(호출측 best-effort 가 처리) — DML-only
            # writer 가 실패한 CREATE 를 매 이벤트 반복하지 않는다. 등록 확인
            # (LookupError)은 search_path 의미 보존을 위해 그대로 유지한다.
            if ensure_schema:
                _orch.apply_schema(ns)  # lazy 멱등 적용 (기존 동작)
        # core/platform 스키마는 state 첫연결 부트스트랩이 생성한다.
        with state._connect_postgres() as conn:
            raw = conn.raw
            path = _search_path_for(ns)
            with raw.transaction():  # autocommit 이라도 명시 txn — SET LOCAL 이 유효해진다
                raw.execute(f"SET LOCAL search_path TO {path}")
                yield conn

    # ── 스킬 state 소유 등록 ──
    def register_schema(
        self,
        namespace: str,
        baseline_ddl: str,
        *,
        migrations: Sequence[tuple[int, str]] = (),
        idless_tables: Sequence[str] = (),
        concurrent_steps: Sequence[str] = (),
    ) -> None:
        _orch.register_schema(
            namespace, baseline_ddl,
            migrations=migrations, idless_tables=idless_tables,
            concurrent_steps=concurrent_steps,
        )

    # ── finding SSOT (state.* 위임 — SQL 중복 0, 시그니처 동일) ──
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
        from secu_agent import state
        return state.finding_upsert(
            task_type=task_type, asset=asset, asset_kind=asset_kind, severity=severity,
            summary=summary, fingerprint=fingerprint, owner=owner, ticket_ref=ticket_ref,
            sla_due=sla_due, evidence_ref=evidence_ref, extra=extra,
        )

    def finding_list(
        self,
        *,
        status: str | None = None,
        task_type: str | None = None,
        since: float | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        from secu_agent import state
        return state.finding_list(status=status, task_type=task_type, since=since, limit=limit)

    def finding_get(self, finding_id: int) -> dict[str, Any] | None:
        from secu_agent import state
        return state.finding_get(finding_id)


_ADAPTER: PostgresStateAdapter | None = None


def default_state_port() -> PostgresStateAdapter:
    """프로세스 싱글턴 어댑터 (P2 DI 진입점)."""
    global _ADAPTER
    if _ADAPTER is None:
        _ADAPTER = PostgresStateAdapter()
    return _ADAPTER
