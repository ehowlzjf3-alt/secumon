"""SELECT-only 가드 — 조회 외 SQL(write/DDL/다중문) 거부(무DB)."""
import pytest

from digisecu_gateway.db import QueryNotAllowed, _assert_select_only


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT 1",
        "  select * from finding_lifecycle",
        "WITH t AS (SELECT 1) SELECT * FROM t",
        "SELECT 1;",
    ],
)
def test_accepts_select(sql):
    _assert_select_only(sql)  # 예외 없어야 함


@pytest.mark.parametrize(
    "sql",
    [
        "UPDATE finding_lifecycle SET status='x'",
        "DELETE FROM smb_share",
        "INSERT INTO scan VALUES (1)",
        "CREATE TABLE y(a int)",
        "ALTER TABLE x ADD COLUMN y int",
        "DROP TABLE x",
        "GRANT SELECT ON x TO y",
        "SELECT 1; DROP TABLE x",  # 다중문
        "; SELECT 1",  # 선두 세미콜론
        "TRUNCATE smb_share",
    ],
)
def test_rejects_non_select(sql):
    with pytest.raises(QueryNotAllowed):
        _assert_select_only(sql)
