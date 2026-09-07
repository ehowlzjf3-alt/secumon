"""read-only DB 계층 — 게이트웨이의 crux.

【connect() 격리 원칙】 스킬/엔진의 `state_domain.connect()`·`secu_agent.state.connect()`와
그에 묶인 read 함수는 **첫 호출에 라이브 threat_hunter DB에 CREATE TABLE + 백필 UPDATE(쓰기)**를
트리거한다(import은 DDL 0건이나 call은 아님 — 조사 확정). 따라서 이 모듈은 그 함수들을
**호출하지 않고**, 게이트웨이 자체 psycopg 풀을 열어 파라미터라이즈드 SELECT만 발행한다.

【read-only 3중 강제 — codex 검증 반영】
  (1) DB role: threat_hunter 전용 read-only role(GRANT SELECT 특정 테이블 + REVOKE DDL/DML).
      sql/001_readonly_role.sql 로 사용자가 생성. 이 role은 서버측 최소권한 = 기밀성/무결성 경계.
  (2) 세션: default_transaction_read_only=on (conninfo options) + psycopg conn.read_only=True.
      write/DDL은 SQLSTATE 25006으로 거부.
  (3) 앱: 아래 _assert_select_only 가드 — SELECT/WITH 단일문만, 세미콜론 다중문 거부.
  + statement_timeout(쿼리 비용 제한).
"""
from __future__ import annotations

import re
from typing import Any

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import Config

# SELECT/CTE 단일 조회문만 허용. INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/GRANT/CALL 등 전부 거부.
_SELECT_RE = re.compile(r"^\s*(select|with)\b", re.IGNORECASE)


class QueryNotAllowed(ValueError):
    """SELECT-only 가드 위반 — 게이트웨이는 조회 외 SQL을 발행하지 않는다."""


def _assert_select_only(sql: str) -> None:
    if not _SELECT_RE.match(sql):
        raise QueryNotAllowed("SELECT/WITH 로 시작하는 조회문만 허용된다.")
    # 다중문(SQL injection/숨은 write) 차단 — 후행 세미콜론 1개만 허용.
    body = sql.strip()
    if body.endswith(";"):
        body = body[:-1]
    if ";" in body:
        raise QueryNotAllowed("복수 SQL 문은 허용되지 않는다(단일 SELECT만).")


def _configure(conn: Connection) -> None:
    # 세션 레벨 read-only 못박기(2층). autocommit=True + read_only=True →
    # 각 SELECT가 독립 read-only 트랜잭션. 어떤 write/DDL도 25006으로 거부된다.
    conn.autocommit = True
    conn.read_only = True


class ReadOnlyPool:
    """threat_hunter 전용 read-only 조회 풀. 조회 외 경로를 제공하지 않는다."""

    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg
        # conninfo options: 세션 기본 read-only + 쿼리비용/유휴트랜잭션 타임아웃 + search_path.
        # search_path 는 conninfo options 로 못박는다(ALTER ROLE 의존 안 함) — kwargs options 가
        # DSN 내장 options 를 덮으므로 여기서 명시하지 않으면 롤 기본값($user, public)으로 회귀해
        # v3.88 이후 core/skill_*/platform 로 이동한 테이블을 unqualified 로 해소하지 못한다(42P01).
        # 값에 공백 없음(콤마 구분) → options 문자열에 안전.
        opts = (
            f"-c default_transaction_read_only=on "
            f"-c statement_timeout={cfg.statement_timeout_ms} "
            f"-c idle_in_transaction_session_timeout={cfg.idle_in_txn_timeout_ms} "
            f"-c search_path={cfg.search_path}"
        )
        self._pool = ConnectionPool(
            conninfo=cfg.pg_dsn,
            min_size=cfg.pool_min,
            max_size=cfg.pool_max,
            kwargs={"options": opts, "row_factory": dict_row},
            configure=_configure,
            open=False,
            name="digisecu-gw-ro",
        )

    def open(self) -> None:
        self._pool.open()
        try:
            self._assert_read_only()
        except Exception:
            # 검증 실패 시 열린 풀·재연결 워커를 반드시 정리(누수 방지, codex D).
            try:
                self._pool.close()
            except Exception:
                pass
            raise

    def _assert_read_only(self) -> None:
        """방어심층(codex B): DSN 이 writer 롤을 가리켜도 게이트웨이 세션이 서버측 read-only 인지 재확인.
        conn.read_only=True + conninfo default_transaction_read_only=on 이 실제 걸렸는지 검증 — 아니면 fail-closed.
        (롤 이름은 배포마다 다를 수 있어 하드 검사 대신 read-only 속성 자체를 검증하고 current_user 는 감사 로깅.)"""
        row = self.fetch_one("SELECT current_user AS usr, current_setting('transaction_read_only') AS ro")
        ro = str(row.get("ro")).lower() if row else ""
        if ro not in ("on", "true", "1"):
            raise RuntimeError(
                f"게이트웨이 DB 세션이 read-only 가 아님(user={row and row.get('usr')}, ro={ro!r}) — "
                "SECU_AGENT_PG_DSN 이 read-only 롤(digisecu_gw_ro)을 가리키는지 확인. fail-closed 로 기동 거부."
            )
        import logging
        logging.getLogger("digisecu_gateway").info(
            "gateway DB read-only 세션 확인: user=%s", row.get("usr") if row else "?",
        )

    def close(self) -> None:
        self._pool.close()

    def fetch_all(self, sql: str, params: tuple[Any, ...] | list[Any] = ()) -> list[dict[str, Any]]:
        _assert_select_only(sql)
        with self._pool.connection() as conn:  # configure()로 이미 read-only
            with conn.cursor() as cur:
                cur.execute(sql, params)
                return list(cur.fetchall())

    def fetch_one(self, sql: str, params: tuple[Any, ...] | list[Any] = ()) -> dict[str, Any] | None:
        rows = self.fetch_all(sql, params)
        return rows[0] if rows else None

    def ping(self) -> bool:
        """readyz용 — 자체 read-only 커넥션으로 SELECT 1(threat_hunter). digisecu_control 미접촉."""
        row = self.fetch_one("SELECT 1 AS ok")
        return bool(row and row.get("ok") == 1)
