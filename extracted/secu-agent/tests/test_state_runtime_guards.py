from __future__ import annotations


def test_state_meta_records_schema_version(tmp_db):
    """state_meta 의 schema_version 이 state.SCHEMA_VERSION 과 일치 (pg 단독 가드)."""
    from secu_agent import state

    with state.connect() as conn:
        row = conn.execute(
            "SELECT value FROM state_meta WHERE key='schema_version'"
        ).fetchone()

    assert row is not None
    assert row["value"] == str(state.SCHEMA_VERSION)
