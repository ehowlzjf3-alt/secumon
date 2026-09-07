"""공용 fixture — tmp_db, seeded, client.

v3.76: 단일 postgres 백엔드. 각 테스트는 전용 테스트 DB(secu_agent_test)에서
매 테스트마다 모든 테이블을 TRUNCATE ... RESTART IDENTITY CASCADE 로 격리한다
(id 가 1부터 재시작 → 기존 sqlite AUTOINCREMENT 동작과 동일).

테스트 DSN 결정 순서:
  1. SECU_AGENT_TEST_PG_DSN (있으면 그대로)
  2. .env 의 SECU_AGENT_PG_DSN 에서 pytest 실행별 '<db>_..._test' 로 치환
라이브 DB(secu_agent) 오염 방지를 위해 DB 이름이 '_test' 로 끝나지 않으면 거부한다.
"""
from __future__ import annotations

import os
import re
import time
from urllib.parse import urlsplit, urlunsplit

import pytest


# ── 코어 스위트는 SA_PLUGINS 에 대해 hermetic 하다 (2026-08-20) ──────────────
# 개발자 .env 의 `SA_PLUGINS` 가 **코어 테스트 결과를 바꾸면 안 된다**. 실제로 바뀌고 있었다:
# skill plugin 이 `semiconductor_process` finding category / 민감어휘 시그널 / github·
# confluence task_type canonicalizer 를 전역 등록하는데, 코어 테스트 4건은 그 이름들이
# **미등록**인 상태(= plugin 미부착 baseline)를 검증한다.
#
# 오래 안 보였던 이유: plugin bootstrap 이 중복 등록 ValueError 로 **중간에 죽어서**
# 뒷단계(category/시그널/canonicalizer)가 아예 실행되지 않았다. plugin 을 멱등으로 고쳐
# 끝까지 로드되자 비로소 드러났다 — 86 errors 가 사라진 자리에 4 failed 가 남는 형태로.
#
# 여기서 빈 문자열로 **덮어쓴다**(pop 이 아니라). python-dotenv 는 os.environ 에 이미 있는
# 키를 건너뛰므로, 뒤늦은 `.env` 로드가 값을 되살리지 못한다.
# plugin 부착 상태를 일부러 보고 싶으면 SA_TEST_WITH_PLUGINS=1 로 실행한다.
if os.environ.get("SA_TEST_WITH_PLUGINS", "").strip().lower() not in {
    "1", "true", "yes", "on",
}:
    os.environ["SA_PLUGINS"] = ""


def _safe_db_component(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_]+", "_", value).strip("_") or "secu_agent"


def _resolve_test_dsn() -> tuple[str, bool]:
    """테스트용 postgres DSN.

    명시 DSN 은 그대로 쓰고, .env 에서 파생한 기본값은 pytest 프로세스마다
    고유 DB 를 만든다. 대량 실행 중단/백그라운드 잔여 연결이 다음 실행을 흔드는
    것을 DB 이름 레벨에서 차단한다.
    """
    from secu_agent.agent.llm.factory import _ensure_dotenv
    _ensure_dotenv()
    dsn = os.environ.get("SECU_AGENT_TEST_PG_DSN")
    generated = False
    if not dsn:
        base = os.environ.get("SECU_AGENT_PG_DSN")
        if not base:
            raise RuntimeError(
                "테스트는 postgres 가 필요합니다. SECU_AGENT_TEST_PG_DSN 또는 "
                ".env 의 SECU_AGENT_PG_DSN(=> '<db>_test' 자동 파생) 을 설정하세요."
            )
        parts = urlsplit(base)
        db = (parts.path or "/secu_agent").lstrip("/") or "secu_agent"
        root = db[:-5] if db.endswith("_test") else db
        suffix = _safe_db_component(os.environ.get("PYTEST_XDIST_WORKER", "gw0"))
        db = f"{_safe_db_component(root)}_{os.getpid()}_{suffix}_test"
        dsn = urlunsplit((parts.scheme, parts.netloc, "/" + db, parts.query, parts.fragment))
        generated = True
    name = urlsplit(dsn).path.lstrip("/")
    if not name.endswith("_test"):
        raise RuntimeError(f"테스트 DB 이름이 '_test' 로 끝나야 합니다 (라이브 보호): {name!r}")
    return dsn, generated


def _ensure_test_db(dsn: str) -> None:
    """테스트 DB 가 없으면 maintenance DB(postgres)에 붙어 CREATE DATABASE."""
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


def _drop_test_db(dsn: str) -> None:
    import psycopg
    parts = urlsplit(dsn)
    name = parts.path.lstrip("/")
    admin = urlunsplit((parts.scheme, parts.netloc, "/postgres", parts.query, parts.fragment))
    with psycopg.connect(admin, autocommit=True) as c:
        c.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE datname=%s AND pid <> pg_backend_pid()",
            (name,),
        )
        c.execute(f'DROP DATABASE IF EXISTS "{name}"')


@pytest.fixture(scope="session", autouse=True)
def _pg_test_env():
    """세션 1회: 테스트 DB 보장 + env 고정 + 스키마 부트스트랩."""
    dsn, generated = _resolve_test_dsn()
    _ensure_test_db(dsn)
    os.environ["SECU_AGENT_DB_BACKEND"] = "postgres"  # (제거 후엔 무시되지만 무해)
    os.environ["SECU_AGENT_PG_DSN"] = dsn
    from secu_agent import state
    state._reset_pg_pool()
    with state.connect():  # 스키마 1회 부트스트랩
        pass
    yield
    state._reset_pg_pool()
    if generated and os.environ.get("SECU_AGENT_KEEP_TEST_DB") != "true":
        _drop_test_db(dsn)


def _truncate_all() -> None:
    # v3.88 StatePort FULL-MOVE: 코어 16테이블이 `core` 스키마로, 스킬은 public, P2 는 skill_*/
    # platform. 격리 TRUNCATE 를 schema-aware·forward-safe 하게 — 관리 스키마 전체 대상.
    from secu_agent import state
    with state.connect() as c:
        rows = c.execute(
            "SELECT format('%I.%I', schemaname, tablename) FROM pg_tables "
            "WHERE (schemaname IN ('public','core','platform') "
            "       OR substr(schemaname,1,6)='skill_') "
            # state_meta(코어 schema_version 메타)만 보존. core.schema_version(register_schema
            # 네임스페이스 추적)은 매 테스트 초기화 — 테스트별 register/apply 가 stale 기록에 막히지 않게.
            "  AND NOT (tablename='state_meta' AND schemaname IN ('public','core')) "
            "ORDER BY schemaname, tablename"
        ).fetchall()
        tables = [r[0] for r in rows]
        if tables:
            c.execute(f"TRUNCATE {', '.join(tables)} RESTART IDENTITY CASCADE")


@pytest.fixture(autouse=True)
def tmp_db(_pg_test_env):
    """함수스코프 격리(autouse) — 매 테스트 전 모든 테이블 초기화 (id 1부터 재시작).

    v3.76: autouse 라 모든 테스트가 깨끗한 pg 에서 시작 — 일부 파일의 레거시
    sqlite 격리 픽스처(SECU_AGENT_DB setenv, 이제 무시됨)는 무해한 no-op 이 된다.
    """
    _truncate_all()
    yield None


@pytest.fixture(autouse=True)
def _disable_dns_rebind_check(monkeypatch):
    """audit #7: 테스트는 실제 DNS 를 태우지 않는다(느림/오프라인 불안정).

    프로덕션 기본은 ON — DNS 재바인딩 검사 로직은 test_url_safety_dns_rebind.py
    가 주입 resolver 로 결정론 검증한다. 개별 테스트는 필요 시 monkeypatch 로
    다시 켤 수 있다(나중 setenv 가 우선).
    """
    monkeypatch.setenv("SA_WEB_DNS_REBIND_CHECK", "0")


@pytest.fixture(autouse=True)
def _tool_checkpoint_test_mode():
    """v3.89: 검문소는 프로덕션 항상 강제이나, 테스트 41파일은 tool.execute() 를 invoker 밖
    cold 로 직접 부른다. 강제를 낮춰 그 cold-call 을 허용한다(env 노출 0 — conftest 전용).
    ★ invoke_tool 경로는 여전히 permit 이 매칭돼 소비되므로 검문소 happy-path 는 전 스위트에서
    실제로 검증된다. cold-call 만 우회. bypass raise 검증은 test_tool_checkpoint.py 가 강제 on 으로."""
    from secu_agent.agent.tools import base
    prev = base.set_checkpoint_enforced(False)
    yield
    base.set_checkpoint_enforced(prev)


@pytest.fixture(autouse=True)
def _autonomous_login_latch_reset():
    """Slice3: 자율 login one-shot latch 는 process-global(프로덕션 reset API 없음, codex) —
    테스트 격리를 위해 모듈 dict 를 직접 초기화(public reset 함수 미제공)."""
    from secu_agent.agent.tools import capability
    capability._AUTONOMOUS_LOGIN_LATCH["consumed"] = False
    yield
    capability._AUTONOMOUS_LOGIN_LATCH["consumed"] = False


@pytest.fixture()
def client(tmp_db):
    from fastapi.testclient import TestClient
    from secu_agent.web.app import create_app
    return TestClient(create_app())
