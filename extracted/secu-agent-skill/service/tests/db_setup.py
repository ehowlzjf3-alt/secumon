"""테스트 DB 헬퍼 — _test DB resolve/생성 (라이브 오염 방지).

de-domain 정리: DB 픽스처 conftest 를 repo 루트로 승격하면서, 여기 헬퍼는 여러
테스트가 직접 import(`from service.tests.db_setup import ...`) 하므로 conftest 가
아닌 정식 모듈로 분리했다. 루트 conftest 도 이 모듈을 사용한다.
"""
from __future__ import annotations

import os
from urllib.parse import urlsplit, urlunsplit


def _resolve_test_dsn() -> str:
    """엔진 tests/conftest 와 동일 — _test DB 강제 (라이브 오염 방지)."""
    from secu_agent.agent.llm.factory import _ensure_dotenv
    _ensure_dotenv()
    dsn = os.environ.get("SECU_AGENT_TEST_PG_DSN")
    if not dsn:
        base = os.environ.get("SECU_AGENT_PG_DSN")
        if not base:
            raise RuntimeError(
                "테스트는 postgres 가 필요합니다. SECU_AGENT_TEST_PG_DSN 또는 "
                ".env 의 SECU_AGENT_PG_DSN 을 설정하세요."
            )
        parts = urlsplit(base)
        db = (parts.path or "/secu_agent").lstrip("/") or "secu_agent"
        if not db.endswith("_test"):
            db = db + "_test"
        dsn = urlunsplit((parts.scheme, parts.netloc, "/" + db, parts.query, parts.fragment))
    name = urlsplit(dsn).path.lstrip("/")
    if not name.endswith("_test"):
        raise RuntimeError(f"테스트 DB 이름이 '_test' 로 끝나야 합니다 (라이브 보호): {name!r}")
    return dsn


def _ensure_test_db(dsn: str) -> None:
    import psycopg
    parts = urlsplit(dsn)
    name = parts.path.lstrip("/")
    admin = urlunsplit((parts.scheme, parts.netloc, "/postgres", parts.query, parts.fragment))
    with psycopg.connect(admin, autocommit=True) as c:
        exists = c.execute(
            "SELECT 1 FROM pg_database WHERE datname=%s", (name,)
        ).fetchone()
        if not exists:
            c.execute(f'CREATE DATABASE "{name}"')


def _truncate_all_managed(c) -> None:
    """P2 W2: managed schema(public/core/platform/skill_*) 전 테이블 truncate — 공용 헬퍼.
    public-only truncate 는 platform/skill_* 로 이동한 테이블을 놓쳐 테스트 간 오염(codex F #2).
    보존: state_meta(엔진 메타) + **core.schema_version**(register/apply ledger — truncate 시 프로세스
    _SCHEMA_READY_NS 와 불일치해 컷오버 테스트가 조용히 skip, codex F #5).
    """
    rows = c.execute(
        "SELECT format('%I.%I', schemaname, tablename) FROM pg_tables "
        "WHERE (schemaname IN ('public', 'core', 'platform') "
        "       OR substr(schemaname, 1, 6) = 'skill_') "
        "  AND NOT (tablename = 'state_meta' AND schemaname IN ('public', 'core')) "
        "  AND NOT (tablename = 'schema_version' AND schemaname = 'core') "
        "ORDER BY schemaname, tablename"
    ).fetchall()
    tables = [r[0] for r in rows]
    if tables:
        c.execute(f"TRUNCATE {', '.join(tables)} RESTART IDENTITY CASCADE")
