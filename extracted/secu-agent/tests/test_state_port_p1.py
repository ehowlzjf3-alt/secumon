"""v3.88 StatePort P1 — 코어 FULL-MOVE 불변식 회귀.

- 코어 16테이블이 실제 `core` 스키마에 산다 (public 아님).
- 레거시 connect() 의 unqualified SQL 은 baseline search_path(public,core)로 코어=core resolve.
- 스킬식 unqualified CREATE(=connect())는 public 에 떨어진다 (전환기 함정 가드).
- finding_* 시그니처·dedup·RESTART IDENTITY 불변.
"""
from __future__ import annotations

import secu_agent.state as state


CORE_TABLES = {
    "state_meta", "memory_rule", "chat_session", "chat_message", "knox_room_session",
    "chat_plan_mode", "paste_cache", "chat_todo", "chat_goal", "token_usage",
    "schedule", "schedule_fire", "schedule_delivery", "approval_audit",
    "finding_lifecycle", "finding_index",
}


def _schema_of(conn, table: str) -> list[str]:
    rows = conn.execute(
        "SELECT table_schema FROM information_schema.tables WHERE table_name=? "
        "AND table_schema IN ('public','core','platform') ORDER BY table_schema",
        (table,),
    ).fetchall()
    return [r[0] for r in rows]


def test_core_tables_live_in_core_schema():
    with state.connect() as c:
        for t in CORE_TABLES:
            schemas = _schema_of(c, t)
            assert schemas == ["core"], f"{t} expected only in core, got {schemas}"


def test_platform_schema_exists_empty():
    with state.connect() as c:
        got = c.execute(
            "SELECT 1 FROM information_schema.schemata WHERE schema_name='platform'"
        ).fetchone()
        assert got is not None


def test_baseline_search_path_is_public_core():
    with state.connect() as c:
        path = c.execute("SHOW search_path").fetchone()[0]
        # psycopg 는 'public, core, pg_catalog' 형태(공백/따옴표 변형 허용).
        norm = path.replace('"', "").replace(" ", "")
        assert norm.split(",")[:2] == ["public", "core"], path


def test_legacy_unqualified_reads_resolve_core():
    # finding_upsert 는 unqualified INSERT/SELECT — core.finding_lifecycle 로 resolve 돼야.
    fid, created = state.finding_upsert(
        task_type="t", asset="a", asset_kind="host", severity="high",
        summary="s", fingerprint="fp-p1-legacy",
    )
    assert created is True and fid >= 1
    with state.connect() as c:
        # core 에서 직접 조회되면 resolve 정상.
        row = c.execute(
            "SELECT summary FROM core.finding_lifecycle WHERE id=?", (fid,)
        ).fetchone()
        assert row is not None and row[0] == "s"


def test_finding_upsert_dedup_and_id():
    a, ca = state.finding_upsert(
        task_type="t", asset="a", asset_kind="host", severity="high",
        summary="s1", fingerprint="fp-dedup",
    )
    b, cb = state.finding_upsert(
        task_type="t", asset="a", asset_kind="host", severity="high",
        summary="s2", fingerprint="fp-dedup",
    )
    assert a == b            # 동일 fingerprint → 동일 id
    assert ca is True and cb is False


def test_finding_id_restarts_at_1_each_test():
    # tmp_db autouse 가 매 테스트 전 TRUNCATE ... RESTART IDENTITY (core.finding_lifecycle 포함).
    fid, _ = state.finding_upsert(
        task_type="t", asset="a", asset_kind="host", severity="low",
        summary="s", fingerprint="fp-restart",
    )
    assert fid == 1


def test_skill_style_unqualified_create_lands_in_public():
    # 스킬 bootstrap 은 P2 전까지 state.connect() 로 unqualified CREATE — public 에 떨어져야
    # 코어를 오염시키지 않는다 (전환기 CREATE 함정 가드).
    with state.connect() as c:
        c.execute("CREATE TABLE IF NOT EXISTS _p1_skill_probe (id BIGINT)")
    try:
        with state.connect() as c:
            schemas = _schema_of(c, "_p1_skill_probe")
        assert schemas == ["public"], schemas
    finally:
        with state.connect() as c:
            c.execute("DROP TABLE IF EXISTS public._p1_skill_probe")


def test_doctor_detects_public_residue_split_brain():
    from secu_agent import runtime_doctor
    # public 에 코어 테이블 동명 잔존을 인위 생성 → doctor 가 split-brain fail 로 감지해야.
    with state.connect() as c:
        c.execute("CREATE TABLE IF NOT EXISTS public.chat_session (id BIGINT)")
    try:
        chk = runtime_doctor.check_postgres_state()
        assert chk.status == "fail"
        assert "chat_session" in chk.details.get("public_residue", [])
    finally:
        with state.connect() as c:
            c.execute("DROP TABLE IF EXISTS public.chat_session")
