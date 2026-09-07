"""SchemaOrchestrator — 네임스페이스 DDL 등록/적용 (v3.88 StatePort).

- 등록(`register_schema`)은 **순수 메모리**: 플러그인 import 시 DB/pool 무접근.
- 적용(`apply_schema`)은 **lazy·멱등·원자적**: 첫 connection(ns) 또는 명시 호출 시, DB advisory
  lock 으로 멀티워커 직렬화, core.schema_version(phase,version,checksum)로 영속 판정,
  각 migration DDL 과 version 기록을 **한 트랜잭션**으로, checksum drift 는 fail-closed,
  read-only 롤에선 validate-only.
- 네임스페이스 allowlist `^(core|platform|skill_[a-z0-9_]+)$` — fullmatch + 길이제한(SQLi/식별자 충돌 차단).
- core/platform 은 코어 소유(register_schema 거부). 순서: core/platform 선행(코어 부트스트랩이 보장).
"""
from __future__ import annotations

import hashlib
import re
import threading
import time
from dataclasses import dataclass

_NS_RE = re.compile(r"(core|platform|skill_[a-z0-9_]+)")
_IDENT_RE = re.compile(r"[a-z_][a-z0-9_]*")
_MAX_IDENT = 63  # PostgreSQL NAMEDATALEN-1


def validate_namespace(ns: str) -> str:
    # fullmatch: `$` 는 끝의 개행 앞에서도 매치돼 'skill_x\n' 같은 위장 식별자를 통과시킨다(codex).
    if not isinstance(ns, str) or not _NS_RE.fullmatch(ns) or len(ns) > _MAX_IDENT:
        raise ValueError(f"invalid persistence namespace: {ns!r}")
    return ns


def _validate_ident(name: str) -> str:
    if not isinstance(name, str) or not _IDENT_RE.fullmatch(name) or len(name) > _MAX_IDENT:
        raise ValueError(f"invalid table identifier: {name!r}")
    return name


def _checksum(*parts) -> str:
    return hashlib.sha256(repr(parts).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class SchemaSpec:
    namespace: str
    baseline_ddl: str
    migrations: tuple[tuple[int, str, str], ...]  # (version, ddl, checksum)
    idless_tables: tuple[str, ...]
    concurrent_steps: tuple[str, ...]
    checksum: str


_LOCK = threading.Lock()
_REGISTERED: dict[str, SchemaSpec] = {}


def register_schema(
    namespace: str,
    baseline_ddl: str,
    *,
    migrations=(),
    idless_tables=(),
    concurrent_steps=(),
) -> None:
    """순수 메모리 등록 (DB 무접근). 동일 checksum 재등록=no-op, 상이=conflict 에러.
    core/platform 은 코어 소유라 등록 거부(스킬은 skill_* 만)."""
    ns = validate_namespace(namespace)
    if ns in ("core", "platform"):
        raise ValueError(f"{ns!r} 는 코어 소유 네임스페이스 — register_schema 로 등록 불가")
    raw_migs = sorted((int(v), str(s)) for v, s in migrations)
    versions = [v for v, _ in raw_migs]
    if any(v <= 0 for v in versions) or len(set(versions)) != len(versions):
        raise ValueError("migration versions must be positive and unique")
    migs = tuple((v, s, _checksum(v, s)) for v, s in raw_migs)
    idless = tuple(dict.fromkeys(_validate_ident(str(t)) for t in idless_tables))
    csteps = tuple(str(s) for s in concurrent_steps)
    checksum = _checksum(baseline_ddl, raw_migs, idless, csteps)
    spec = SchemaSpec(ns, baseline_ddl, migs, idless, csteps, checksum)
    from secu_agent import state
    with _LOCK:  # registry 공개와 idless funnel 을 같은 경계에서(레이스 차단).
        existing = _REGISTERED.get(ns)
        if existing is not None and existing.checksum != checksum:
            raise ValueError(f"schema namespace already registered with different DDL: {ns!r}")
        _REGISTERED[ns] = spec
        for t in idless:  # DDL 前에도 RETURNING 억제 정합.
            state.register_idless_table(t)


def registered_namespaces() -> frozenset[str]:
    with _LOCK:
        return frozenset(_REGISTERED)


def _reset_registry() -> None:
    """테스트 전용 — 등록 + 프로세스 readiness 초기화 (재등록 후 재적용 가능하게)."""
    from secu_agent import state
    with _LOCK:
        _REGISTERED.clear()
        state._SCHEMA_READY_NS.clear()


def _applied_checksum(raw, ns: str, phase: str, version: int) -> str | None | object:
    """적용 기록 조회. 미적용=_NOT_APPLIED, 적용=checksum(또는 None). 조회 오류는 삼키지 않고
    전파(fail-closed) — '미적용'으로 오판해 재실행하지 않게."""
    row = raw.execute(
        "SELECT checksum FROM core.schema_version WHERE namespace=%s AND phase=%s AND version=%s",
        (ns, phase, version),
    ).fetchone()
    return _NOT_APPLIED if row is None else row[0]


_NOT_APPLIED = object()


def _record_applied(raw, ns: str, phase: str, version: int, checksum: str | None) -> None:
    raw.execute(
        "INSERT INTO core.schema_version(namespace, phase, version, checksum, applied_at) "
        "VALUES (%s, %s, %s, %s, %s) ON CONFLICT (namespace, phase, version) DO NOTHING",
        (ns, phase, version, checksum, time.time()),
    )


def _apply_phase(conn, raw, ns: str, phase: str, version: int, ddl: str, checksum: str) -> None:
    prev = _applied_checksum(raw, ns, phase, version)
    if prev is _NOT_APPLIED:
        with raw.transaction():  # DDL + version 기록을 원자적으로 (부분적용 방지)
            conn.executescript(ddl)
            _record_applied(raw, ns, phase, version, checksum)
    elif prev != checksum:
        raise RuntimeError(
            f"schema drift {ns}/{phase}/{version}: applied checksum {str(prev)[:8]} != "
            f"registered {checksum[:8]} — 변경은 새 migration version 으로(기존 재작성 금지)"
        )


def apply_schema(namespace: str, *, force: bool = False) -> None:
    """네임스페이스 DDL 을 lazy·멱등·원자 적용. 미등록이면 KeyError. read-only 면 validate-only."""
    ns = validate_namespace(namespace)
    with _LOCK:
        spec = _REGISTERED.get(ns)
    if spec is None:
        raise KeyError(f"persistence namespace not registered: {ns!r}")
    from secu_agent import state
    if ns in state._SCHEMA_READY_NS and not force:
        return
    with state._connect_postgres() as conn:  # 첫 연결이면 core 부트스트랩 선행(순서 보장)
        raw = conn.raw
        if state._txn_read_only(raw):
            # validate-only: baseline 이 이미 적용됐는지 확인(미적용이면 fail-closed).
            if _applied_checksum(raw, ns, "baseline", 0) is _NOT_APPLIED:
                raise RuntimeError(f"read-only DB: namespace {ns!r} baseline 미provisioning")
            return
        try:
            raw.execute("SET lock_timeout='8s'")
        except Exception:
            pass
        raw.execute(f"SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext('secu_agent:schema:{ns}'))")
        try:
            raw.execute(f"CREATE SCHEMA IF NOT EXISTS {ns}")  # ns allowlist 검증됨
            raw.execute(f"SET search_path TO {ns}, pg_catalog, pg_temp")  # 스킬 CREATE 격리
            # baseline phase checksum 은 baseline_ddl 단독 해시 — migration 추가로 spec.checksum 이
            # 바뀌어도 baseline drift 로 오판하지 않게(baseline SQL 이 실제 바뀔 때만 drift).
            _apply_phase(conn, raw, ns, "baseline", 0, spec.baseline_ddl, _checksum(spec.baseline_ddl))
            for ver, ddl, csum in spec.migrations:
                _apply_phase(conn, raw, ns, "migration", ver, ddl, csum)
            for step in spec.concurrent_steps:  # txn 밖 (CREATE INDEX CONCURRENTLY 등)
                try:
                    raw.execute(step)
                except Exception:
                    pass  # P2 hardening: pg_index.indisvalid 검증·version 기록 예정
            state._grant_readonly(raw, ns)
        finally:
            # R2-2: lock_timeout 도 복원(부트스트랩과 대칭). 풀 reset 콜백이 check-in 에 재정규화·
            # advisory_unlock_all 하지만 명시 복원으로 이중 안전. (unlock 실패해도 reset 이 회수 — R2-3)
            for _stmt in (
                "SET lock_timeout TO 0",
                f"SET search_path TO {state._BASELINE_SEARCH_PATH}",
                f"SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext('secu_agent:schema:{ns}'))",
            ):
                try:
                    raw.execute(_stmt)
                except Exception:
                    pass
    with _LOCK:
        state._SCHEMA_READY_NS.add(ns)
