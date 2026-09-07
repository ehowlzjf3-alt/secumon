"""v3.88 P2 — platform 네임스페이스 provision 불변식 (코어 ASK 문서).

코어가 provision 하는 횡단 5테이블이 `platform` 스키마에 실재하고, connect()(baseline) 로
unqualified resolve 되며, id-less 2테이블은 RETURNING id 가 안 붙는다.
"""
from __future__ import annotations

import time

import secu_agent.state as state

PLATFORM_TABLES = {
    "control_flag", "pipeline_heartbeat", "pipeline_run",
    "service_reply_message", "devops_target",
}


def _schema_of(conn, table: str) -> list[str]:
    rows = conn.execute(
        "SELECT table_schema FROM information_schema.tables WHERE table_name=? "
        "AND table_schema IN ('public','core','platform') ORDER BY table_schema",
        (table,),
    ).fetchall()
    return [r[0] for r in rows]


def test_platform_tables_live_in_platform_schema():
    with state.connect() as c:
        for t in PLATFORM_TABLES:
            assert _schema_of(c, t) == ["platform"], f"{t} expected only in platform"


def test_platform_schema_and_asset_owner_not_here():
    # asset_owner/scan/screenshot 은 skill_smb 로 재귀속 — platform 에 있으면 안 됨.
    with state.connect() as c:
        for t in ("asset_owner", "scan", "screenshot"):
            got = c.execute(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema='platform' AND table_name=?",
                (t,),
            ).fetchone()
            assert got is None, f"{t} 는 platform 에 있으면 안 됨(skill_smb 소유)"


def test_platform_resolves_via_connect_baseline():
    # baseline search_path 에 platform 포함 → connect() unqualified 로 platform 테이블 resolve.
    with state.connect() as c:
        c.execute(
            "INSERT INTO devops_target(url, service, source, day_bucket, discovered_at, last_seen_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            ("http://x", "web", "test", "2026-07-12", time.time(), time.time()),
        )
        row = c.execute("SELECT service FROM devops_target WHERE url=?", ("http://x",)).fetchone()
        assert row is not None and row[0] == "web"
        # platform 에 저장됐는지 명시 확인.
        got = c.execute("SELECT to_regclass('platform.devops_target')").fetchone()[0]
        assert got is not None


def test_platform_idless_no_returning_id():
    # control_flag/pipeline_heartbeat 는 component PK·id 없음 → RETURNING id 자동부착되면 에러.
    assert "control_flag" in state._PG_IDLESS_TABLES
    assert "pipeline_heartbeat" in state._PG_IDLESS_TABLES
    with state.connect() as c:
        c.execute(
            "INSERT INTO control_flag(component, updated_at) VALUES (?, ?)",
            ("smb", time.time()),
        )
        c.execute(
            "INSERT INTO pipeline_heartbeat(component, last_beat) VALUES (?, ?)",
            ("smb", time.time()),
        )
        assert c.execute(
            "SELECT enabled FROM control_flag WHERE component=?", ("smb",)
        ).fetchone()[0] == 1


def test_r3_1_insert_re_captures_table_not_schema():
    # R3-1: schema-qualified INSERT 도 group(1)=테이블명이어야 idless 판정이 맞는다(구 정규식은
    # 스키마명을 캡처해 오판). bare/qualified/대소문자/공백 케이스 전수.
    cases = {
        "INSERT INTO control_flag(component) VALUES (?)": "control_flag",           # bare idless
        "INSERT INTO platform.control_flag(component) VALUES (?)": "control_flag",  # qualified idless
        "INSERT INTO skill_smb.asset_owner(x) VALUES (?)": "asset_owner",           # qualified idless(skill)
        "INSERT INTO core.finding_lifecycle(x) VALUES (?)": "finding_lifecycle",    # qualified id-having
        "  insert into chat_session(x) values (?)": "chat_session",                 # bare id-having, ci
        "INSERT INTO platform . control_flag (x) VALUES (?)": "control_flag",       # 점 주변 공백
    }
    for sql, table in cases.items():
        m = state._PG_INSERT_RE.match(sql)
        assert m is not None and m.group(1) == table, (sql, m and m.group(1))
    # qualified idless 도 idless set 에 매칭(RETURNING id 억제 조건) — 스키마와 무관.
    m = state._PG_INSERT_RE.match("INSERT INTO platform.control_flag(c) VALUES(?)")
    assert m.group(1).lower() in state._PG_IDLESS_TABLES


def test_r3_1_qualified_idless_insert_no_returning():
    # R3-1 통합: schema-qualified INSERT INTO platform.control_flag 가 idless 로 인식돼 RETURNING id
    # 가 안 붙는다. 구 코드는 스키마명 'platform' 을 테이블로 오인 → RETURNING id → UndefinedColumn:id.
    with state.connect() as c:
        c.execute(
            "INSERT INTO platform.control_flag(component, updated_at) VALUES (?, ?)",
            ("r3qual", time.time()),
        )
        assert c.execute(
            "SELECT enabled FROM platform.control_flag WHERE component=?", ("r3qual",)
        ).fetchone()[0] == 1


def test_r3_1_qualified_id_having_insert_still_returns_lastrowid():
    # R3-1 회귀 방어(codex): qualified **id-having** 테이블 INSERT 는 여전히 RETURNING id 로
    # lastrowid 를 돌려줘야 한다 — 수정이 qualified id-having 경로를 깨지 않음을 고정.
    # pipeline_run 은 id BIGINT IDENTITY PK → idless 아님 → RETURNING id 부착돼야.
    with state.connect() as c:
        cur = c.execute(
            "INSERT INTO platform.pipeline_run(component, started_at) VALUES (?, ?)",
            ("r3id", time.time()),
        )
        assert isinstance(cur.lastrowid, int) and cur.lastrowid > 0


def test_relocate_two_pass_no_partial_move_on_split_brain():
    import pytest
    # _rl_a=public만(이동대상), _rl_b=public+platform 동시(split-brain). 2-pass 라 b에서 raise 전
    # a를 이동하지 않아야(부분이관 방지).
    with state.connect() as c:
        c.execute("CREATE TABLE IF NOT EXISTS public._rl_a (id BIGINT)")
        c.execute("CREATE TABLE IF NOT EXISTS public._rl_b (id BIGINT)")
        c.execute("CREATE TABLE IF NOT EXISTS platform._rl_b (id BIGINT)")
    try:
        with state.connect() as c:
            with pytest.raises(RuntimeError):
                state._relocate_tables(c.raw, ["_rl_a", "_rl_b"], "platform")
            assert c.execute("SELECT to_regclass('public._rl_a')").fetchone()[0] is not None
            assert c.execute("SELECT to_regclass('platform._rl_a')").fetchone()[0] is None
    finally:
        with state.connect() as c:
            for s, t in (("public", "_rl_a"), ("public", "_rl_b"),
                         ("platform", "_rl_a"), ("platform", "_rl_b")):
                c.execute(f"DROP TABLE IF EXISTS {s}.{t}")


def test_provision_platform_rejects_reattributed_residue():
    import pytest
    # asset_owner/scan/screenshot 가 platform 에 있으면(과거 잔재) fail-closed.
    with state.connect() as c:
        c.execute("CREATE TABLE IF NOT EXISTS platform.asset_owner (id BIGINT)")
    try:
        with state.connect() as c:
            with pytest.raises(RuntimeError):
                state._provision_platform_schema(c.raw, c)
    finally:
        with state.connect() as c:
            c.execute("DROP TABLE IF EXISTS platform.asset_owner")


def test_r2_1_old_shape_relocate_adds_columns_before_index():
    # R2-1: 구 shape(cycle_key 등 누락) public.devops_target 를 relocate 하면 인덱스 생성 前
    # ADD COLUMN 이 돌아 컬럼 보장·인덱스 성공. (fresh CREATE 만 하면 인덱스가 누락 컬럼 참조로 실패.)
    try:
        with state.connect() as c:  # 파괴적 setup 도 try 안 — 실패해도 finally 가 정상 shape 복원.
            c.execute("DROP TABLE IF EXISTS platform.devops_target CASCADE")
            c.execute("DROP TABLE IF EXISTS public.devops_target CASCADE")
            c.execute(
                "CREATE TABLE public.devops_target ("
                "id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, url TEXT NOT NULL, "
                "service TEXT NOT NULL, source TEXT NOT NULL, day_bucket TEXT NOT NULL, "
                "status TEXT NOT NULL DEFAULT 'pending', access_count BIGINT DEFAULT 0, "
                "discovered_at DOUBLE PRECISION NOT NULL, last_seen_at DOUBLE PRECISION NOT NULL, "
                "last_task_at DOUBLE PRECISION, finding_count BIGINT DEFAULT 0, last_reason TEXT, "
                "claimed_by BIGINT, claimed_at DOUBLE PRECISION, "
                # 구 shape: 나중에 추가된 cycle_key/cycle_scanned_at/cycle_finding_count/retry_after 없음.
                "UNIQUE(url, day_bucket))"
            )
        with state.connect() as c:
            state._provision_platform_schema(c.raw, c)
        with state.connect() as c:
            assert c.execute("SELECT to_regclass('platform.devops_target')").fetchone()[0] is not None
            assert c.execute("SELECT to_regclass('public.devops_target')").fetchone()[0] is None
            col = c.execute(
                "SELECT 1 FROM information_schema.columns WHERE table_schema='platform' "
                "AND table_name='devops_target' AND column_name='cycle_key'"
            ).fetchone()
            assert col is not None  # 구 shape 에 컬럼 추가됨
            assert c.execute("SELECT to_regclass('platform.idx_devops_target_cycle')").fetchone()[0] is not None
    finally:
        with state.connect() as c:  # 정상 shape 로 복원(다른 테스트가 기대).
            c.execute("DROP TABLE IF EXISTS platform.devops_target CASCADE")
            c.execute("DROP TABLE IF EXISTS public.devops_target CASCADE")
            state._provision_platform_schema(c.raw, c)


def _dt_has_col(c, col: str) -> bool:
    return c.execute(
        "SELECT 1 FROM information_schema.columns WHERE table_schema='platform' "
        "AND table_name='devops_target' AND column_name=?", (col,),
    ).fetchone() is not None


def _restore_devops_target_shape():
    with state.connect() as c:  # 정상 shape 로 복원(다른 테스트가 기대).
        c.execute("DROP TABLE IF EXISTS platform.devops_target CASCADE")
        c.execute("DROP TABLE IF EXISTS public.devops_target CASCADE")
        state._provision_platform_schema(c.raw, c)


def _seed_public_devops_target(*, cols: str, values_sql: str = "", params: tuple = ()):
    # 구 shape public.devops_target 를 심는다(relocate 대상). cols 는 last_* 계열만 가변.
    with state.connect() as c:  # 파괴적 setup — 실패해도 finally(_restore)가 복원.
        c.execute("DROP TABLE IF EXISTS platform.devops_target CASCADE")
        c.execute("DROP TABLE IF EXISTS public.devops_target CASCADE")
        c.execute(
            "CREATE TABLE public.devops_target ("
            "id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, url TEXT NOT NULL, "
            "service TEXT NOT NULL, source TEXT NOT NULL, day_bucket TEXT NOT NULL, "
            "status TEXT NOT NULL DEFAULT 'pending', access_count BIGINT DEFAULT 0, "
            "discovered_at DOUBLE PRECISION NOT NULL, last_seen_at DOUBLE PRECISION NOT NULL, "
            f"{cols} "
            "finding_count BIGINT DEFAULT 0, last_reason TEXT, "
            "claimed_by BIGINT, claimed_at DOUBLE PRECISION, "
            "UNIQUE(url, day_bucket))"
        )
        if values_sql:
            c.execute(values_sql, params)


def test_devops_target_last_hunt_at_renamed_preserving_data():
    # CORE-ASK ⑤: de-domain(hunt→task) 시대의 구 DB 는 platform.devops_target 에 last_hunt_at 잔존 →
    # 클레임 SQL 이 기대하는 last_task_at 부재로 UndefinedColumn(github/confluence SSO claim 즉사).
    # provision 이 relocate **후** 리네임 수렴 — 그리고 리네임이라 기존 타임스탬프 데이터가 보존된다.
    import time
    ts = round(time.time(), 3)
    try:
        _seed_public_devops_target(
            cols="last_hunt_at DOUBLE PRECISION,",  # 구 컬럼명 (last_task_at 부재)
            values_sql=(
                "INSERT INTO public.devops_target(url, service, source, day_bucket, "
                "discovered_at, last_seen_at, last_hunt_at) VALUES (?,?,?,?,?,?,?)"
            ),
            params=("http://legacy", "github", "seed", "2026-07-20", ts, ts, ts),
        )
        with state.connect() as c:
            state._provision_platform_schema(c.raw, c)
        with state.connect() as c:
            assert _dt_has_col(c, "last_task_at"), "last_task_at 로 리네임됐어야"
            assert not _dt_has_col(c, "last_hunt_at"), "last_hunt_at 잔존하면 안 됨"
            # 리네임(≠ADD)이라 기존 행의 타임스탬프가 새 컬럼으로 그대로 옮겨짐.
            row = c.execute(
                "SELECT last_task_at FROM platform.devops_target WHERE url=?", ("http://legacy",),
            ).fetchone()
            assert row is not None and abs(row[0] - ts) < 1e-6, "리네임이 데이터를 보존해야"
        # 멱등: 이미 last_task_at 인 상태로 재-provision — 조건부 introspection 이라 리네임 skip,
        # 예외 없이 통과(신규 DB 경로와 동형).
        with state.connect() as c:
            state._provision_platform_schema(c.raw, c)
        with state.connect() as c:
            assert _dt_has_col(c, "last_task_at") and not _dt_has_col(c, "last_hunt_at")
    finally:
        _restore_devops_target_shape()


def test_devops_target_both_columns_no_duplicate_error():
    # codex R1: last_hunt_at·last_task_at 둘 다 존재하는 shape 에서 무차별 RENAME 은 DuplicateColumn 을
    # 던진다. 조건부 introspection 은 신 컬럼 존재 시 리네임 skip → 에러 없이 provision 완료,
    # last_task_at(정본) 보존. (last_hunt_at 는 무해한 잔재로 남되 claim SQL 은 정상.)
    try:
        _seed_public_devops_target(cols="last_hunt_at DOUBLE PRECISION, last_task_at DOUBLE PRECISION,")
        with state.connect() as c:
            state._provision_platform_schema(c.raw, c)  # DuplicateColumn 나면 여기서 raise
        with state.connect() as c:
            assert _dt_has_col(c, "last_task_at")
    finally:
        _restore_devops_target_shape()


def test_devops_target_neither_column_gets_last_task_at():
    # codex R1(fail-open 봉쇄): last_hunt_at·last_task_at **둘 다 없는** 초-구 shape. 리네임은 skip 되지만
    # _PLATFORM_MIGRATIONS_DDL 의 ADD COLUMN IF NOT EXISTS last_task_at 안전망이 컬럼을 보장 →
    # provision 후 claim SQL 이 UndefinedColumn 을 만나지 않는다(미수렴 DB 를 ready 로 만들지 않음).
    try:
        _seed_public_devops_target(cols="")  # last_* 타임스탬프 컬럼 자체가 없음
        with state.connect() as c:
            state._provision_platform_schema(c.raw, c)
        with state.connect() as c:
            assert _dt_has_col(c, "last_task_at"), "안전망 ADD COLUMN 이 last_task_at 을 보장해야"
    finally:
        _restore_devops_target_shape()


def test_readonly_bootstrap_rejects_stale_last_hunt_at():
    # codex R1(Medium-high): read-only 롤은 hunt→task 리네임을 못 하므로, 구 shape(last_hunt_at 잔존,
    # last_task_at 부재)를 validate 브랜치가 fail-closed 로 잡아야 한다. 안 잡으면 ready 로 표시된 뒤
    # 첫 claim 쿼리가 UndefinedColumn 으로 죽는다. 전용(비-풀) 커넥션으로 read-only 강제 → 풀 무오염.
    import os

    import psycopg
    import pytest
    # migration 6컬럼은 다 있지만 last_task_at 만 없는(대신 last_hunt_at) stale shape 를 platform 에 구성.
    stale_cols = (
        "last_hunt_at DOUBLE PRECISION, retry_after DOUBLE PRECISION, "
        "cycle_key TEXT, cycle_scanned_at DOUBLE PRECISION, "
        "cycle_finding_count BIGINT NOT NULL DEFAULT 0,"
    )
    try:
        with state.connect() as c:
            c.execute("DROP TABLE IF EXISTS platform.devops_target CASCADE")
            c.execute("DROP TABLE IF EXISTS public.devops_target CASCADE")
            c.execute(
                "CREATE TABLE platform.devops_target ("
                "id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, url TEXT NOT NULL, "
                "service TEXT NOT NULL, source TEXT NOT NULL, day_bucket TEXT NOT NULL, "
                "status TEXT NOT NULL DEFAULT 'pending', access_count BIGINT DEFAULT 0, "
                "discovered_at DOUBLE PRECISION NOT NULL, last_seen_at DOUBLE PRECISION NOT NULL, "
                f"{stale_cols} finding_count BIGINT DEFAULT 0, last_reason TEXT, "
                "claimed_by BIGINT, claimed_at DOUBLE PRECISION, UNIQUE(url, day_bucket))"
            )
        # 전용 read-only 커넥션(풀 밖) — 닫아도 풀 세션상태 오염 없음.
        ro = psycopg.connect(os.environ["SECU_AGENT_PG_DSN"])
        try:
            ro.read_only = True  # 이후 트랜잭션이 read-only → _txn_read_only True
            assert state._txn_read_only(ro) is True
            with pytest.raises(RuntimeError) as ei:
                state._bootstrap_core_schema(ro, None)  # validate 브랜치는 raw 만 사용(conn 미접근)
            assert "last_task_at" in str(ei.value)
        finally:
            ro.close()
    finally:
        _restore_devops_target_shape()


def test_r2_2_pool_reset_normalizes_session_state(monkeypatch):
    # R2-2/R2-3: 세션 상태(lock_timeout·search_path·advisory lock)를 오염 후 반환 → reset 콜백이
    # 재정규화하고 누수 lock 을 해제. 다음 borrower 는 baseline.
    # codex R2: size-1 풀로 강제 → 같은 backend 재대여 보장(reset 콜백이 실제로 도는 경로를 검증;
    # 다른 backend 면 configure 로도 baseline 이라 reset 을 우회해 통과하는 위양성이 된다).
    saved = state._PG_POOL
    monkeypatch.setenv("SA_PG_POOL_MAX_SIZE", "1")
    monkeypatch.setenv("SA_PG_POOL_MIN_SIZE", "1")
    state._PG_POOL = None
    try:
        with state.connect() as c:
            pid1 = c.raw.execute("SELECT pg_backend_pid()").fetchone()[0]
            c.raw.execute("SET lock_timeout='9s'")
            c.raw.execute("SET search_path TO pg_catalog")
            c.raw.execute("SELECT pg_advisory_lock(hashtext('test:r2reset'))")
        with state.connect() as c:
            pid2 = c.raw.execute("SELECT pg_backend_pid()").fetchone()[0]
            lt = c.raw.execute("SHOW lock_timeout").fetchone()[0]
            sp = c.raw.execute("SHOW search_path").fetchone()[0]
            held = c.raw.execute(
                "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()"
            ).fetchone()[0]
        assert pid1 == pid2       # 같은 backend 재대여 → reset 콜백 경로가 실제로 검증됨
        assert lt == "0"          # lock_timeout 복원(0=default)
        # baseline 전체 동등 비교 — 부분비교(norm[:3]+norm[-1])는 중간에 끼워진 'evil' 스키마를
        # 통과시킨다(codex R2). 코드가 SET 하는 baseline 상수와 정확히 일치해야 한다.
        norm = [s.strip() for s in sp.split(",")]
        assert norm == [s.strip() for s in state._BASELINE_SEARCH_PATH.split(",")]
        assert held == 0          # 누수 advisory lock 해제
    finally:
        pool = state._PG_POOL
        state._PG_POOL = saved
        if pool is not None and pool is not saved:
            pool.close()
