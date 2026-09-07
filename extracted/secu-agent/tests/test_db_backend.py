"""v3.76: postgres 단독 백엔드 — placeholder 번역 / dual-row / pg roundtrip.

sqlite 듀얼백엔드는 제거됐다. db_backend()/db_path()/migrate_sqlite_to_pg() 등
sqlite 관련 심볼은 더 이상 존재하지 않으므로 관련 단언도 삭제했다.
conftest 가 세션 단위로 테스트 postgres(secu_agent_test) 를 세팅하고, tmp_db
픽스처가 매 테스트마다 테이블을 격리한다.
"""
from __future__ import annotations

from secu_agent import state


# ---- placeholder 번역 ----------------------------------------------------

def test_to_pg_sql_qmark_to_percent_s():
    assert state._to_pg_sql("SELECT * FROM t WHERE a=? AND b=?", True) == \
        "SELECT * FROM t WHERE a=%s AND b=%s"


def test_to_pg_sql_no_params_no_qmark_unchanged():
    sql = "SELECT count(*) FROM finding_lifecycle"
    assert state._to_pg_sql(sql, False) == sql


def test_to_pg_sql_escapes_literal_percent_only_with_params():
    # 파라미터 있을 때만 % → %% (psycopg 가 params 있을 때만 % 특수처리)
    assert state._to_pg_sql("x LIKE ? AND y='50%'", True) == "x LIKE %s AND y='50%%'"
    assert state._to_pg_sql("y='50%'", False) == "y='50%'"


# ---- _PgRow dual access (sqlite3.Row 호환) -------------------------------

def test_pgrow_index_and_key_access():
    r = state._PgRow(("id", "name"), (7, "alpha"))
    assert r[0] == 7
    assert r["id"] == 7
    assert r[1] == "alpha"
    assert r["name"] == "alpha"
    assert r.keys() == ["id", "name"]
    assert list(r) == [7, "alpha"]
    assert len(r) == 2


# ---- pg roundtrip (conftest 가 세팅한 테스트 DB 사용) ---------------------

def test_pg_insert_select_roundtrip(tmp_db):
    with state.connect() as c:
        c.execute(
            "INSERT INTO state_meta(key,value,updated_at) VALUES(?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, "
            "updated_at=excluded.updated_at",
            ("pg_test_rt", "v", 1.0),
        )
        row = c.execute(
            "SELECT key,value FROM state_meta WHERE key=?", ("pg_test_rt",)
        ).fetchone()
        assert row[0] == "pg_test_rt"        # 정수 인덱스 (sqlite3.Row 호환)
        assert row["value"] == "v"            # 컬럼명
        sv = c.execute(
            "SELECT value FROM state_meta WHERE key='schema_version'"
        ).fetchone()
        assert sv is not None
