"""v3.72 (a)(b): 서브넷 점진 스윕 추적 + 미스캔 전수 스캔 큐 + 무제한 walk.

세션25 분석 — 1637 subnet 중 어디까지 스윕했는지 추적 불가 + readable share
text 후보 1651개 중 778개 미스캔. 그 갭을 닫는 state 헬퍼 / walk 변경 검증.
"""
from __future__ import annotations

from service import state_domain as state
from domains.smb.plugin.agent_types import smb


# ---- (a) subnets_pending_sweep / subnet_mark_swept / overview --------------

def test_subnets_pending_sweep_default_limit_one(tmp_db):
    """기본 limit=1 — 40만 IP 한방 금지, 하나씩."""
    for i in range(3):
        state.smb_target_add(f"10.{i}.0.0/24", charter_ref="c", added_by="d")
    rows = state.subnets_pending_sweep()
    assert len(rows) == 1


def test_subnets_pending_sweep_excludes_swept_and_disabled(tmp_db):
    a = state.smb_target_add("10.0.0.0/24", charter_ref="c", added_by="d")
    b = state.smb_target_add("10.1.0.0/24", charter_ref="c", added_by="d")
    c = state.smb_target_add("10.2.0.0/24", charter_ref="c", added_by="d")
    state.subnet_mark_swept("10.0.0.0/24", scan_id=1, hosts_found=2, shares_found=5)
    state.smb_target_set_enabled(c, False)

    rows = state.subnets_pending_sweep(limit=50)
    ids = {r["id"] for r in rows}
    assert a not in ids        # swept
    assert b in ids            # pending
    assert c not in ids        # disabled


def test_subnet_mark_swept_records_counts_and_is_resumable(tmp_db):
    state.smb_target_add("10.0.0.0/24", charter_ref="c", added_by="d")
    state.subnet_mark_swept("10.0.0.0/24", scan_id=7, hosts_found=3, shares_found=9)

    row = next(r for r in state.smb_target_list() if r["subnet"] == "10.0.0.0/24")
    assert row["swept_at"] is not None
    assert row["sweep_scan_id"] == 7
    assert row["hosts_found"] == 3
    assert row["shares_found"] == 9
    # 재개: 이미 swept 이면 다시 pending 으로 안 잡힘
    assert state.subnets_pending_sweep(limit=50) == []


def test_subnet_mark_swept_normalizes_cidr(tmp_db):
    # host bit 포함 입력도 정규화돼서 매칭돼야 함
    state.smb_target_add("10.0.0.0/24", charter_ref="c", added_by="d")
    state.subnet_mark_swept("10.0.0.5/24", scan_id=1)
    assert state.subnets_pending_sweep(limit=50) == []


def test_subnets_pending_never_first_then_oldest(tmp_db):
    """v3.76 rolling: 안 본(swept_at NULL) subnet 먼저 → 본 지 오래된 순."""
    import time
    a = state.smb_target_add("10.0.0.0/24", charter_ref="c", added_by="d")  # never
    state.smb_target_add("10.1.0.0/24", charter_ref="c", added_by="d")      # swept old
    state.smb_target_add("10.2.0.0/24", charter_ref="c", added_by="d")      # swept newer
    state.subnet_mark_swept("10.1.0.0/24", scan_id=1)
    state.subnet_mark_swept("10.2.0.0/24", scan_id=1)
    # 두 swept 의 swept_at 을 과거(cooldown 풀림)로, old < newer
    with state.connect() as c:
        c.execute("UPDATE smb_target_subnet SET swept_at=? WHERE subnet=?",
                  (time.time() - 1_000_000, "10.1.0.0/24"))
        c.execute("UPDATE smb_target_subnet SET swept_at=? WHERE subnet=?",
                  (time.time() - 900_000, "10.2.0.0/24"))
    rows = state.subnets_pending_sweep(limit=1, cooldown_seconds=0)
    assert rows[0]["id"] == a            # never 먼저
    rows3 = state.subnets_pending_sweep(limit=3, cooldown_seconds=0)
    assert [r["subnet"] for r in rows3] == ["10.0.0.0/24", "10.1.0.0/24", "10.2.0.0/24"]


def test_subnets_cooldown_re_sweep(tmp_db):
    """swept subnet 도 cooldown(SMB_SUBNET_RESCAN_SECONDS) 지나면 재스윕 대상."""
    state.smb_target_add("10.0.0.0/24", charter_ref="c", added_by="d")
    state.subnet_mark_swept("10.0.0.0/24", scan_id=1)
    # 방금 스윕(기본 7d cooldown 내) → pending 없음
    assert state.subnets_pending_sweep(limit=50) == []
    # cooldown 0 → 재스윕 대상으로 복귀
    rows = state.subnets_pending_sweep(limit=50, cooldown_seconds=0)
    assert [r["subnet"] for r in rows] == ["10.0.0.0/24"]


def test_subnets_sweep_overview(tmp_db):
    for i in range(4):
        state.smb_target_add(f"10.{i}.0.0/24", charter_ref="c", added_by="d")
    state.subnet_mark_swept("10.0.0.0/24", scan_id=1)
    state.subnet_mark_swept("10.1.0.0/24", scan_id=1)
    ov = state.subnets_sweep_overview()
    assert ov == {"total": 4, "swept": 2, "pending": 2}


# ---- close_unseen_since subnet 스코프 (per-subnet 점진 스윕 안전) ----------

def test_close_unseen_since_scoped_to_subnets(tmp_db):
    s1 = state.scan_start("smb", ["10.0.0.0/24"])
    _, a = state.upsert_smb_share(s1, "10.0.0.0/24", "10.0.0.1", "sh_a")
    _, b = state.upsert_smb_share(s1, "10.1.0.0/24", "10.1.0.1", "sh_b")
    # 새 scan 은 subnet1 만 봄 — subnet1 share 는 안 보였다 치고 scope=subnet1 로 close
    s2 = state.scan_start("smb", ["10.0.0.0/24"])
    closed = state.close_unseen_since(s2, subnets=["10.0.0.0/24"])
    with state.connect() as c:
        st_a = c.execute("SELECT status FROM smb_share WHERE id=?", (a,)).fetchone()["status"]
        st_b = c.execute("SELECT status FROM smb_share WHERE id=?", (b,)).fetchone()["status"]
    assert closed == 1
    assert st_a == "closed"        # 스윕한 subnet 의 미관측 share 만 닫힘
    assert st_b == "pending"        # 다른 subnet 은 보존


def test_close_unseen_since_global_default_unchanged(tmp_db):
    s1 = state.scan_start("smb", ["10.0.0.0/24"])
    _, a = state.upsert_smb_share(s1, "10.0.0.0/24", "10.0.0.1", "sh_a")
    _, b = state.upsert_smb_share(s1, "10.1.0.0/24", "10.1.0.1", "sh_b")
    s2 = state.scan_start("smb", ["x"])
    closed = state.close_unseen_since(s2)   # subnets=None → 전역 (기존 동작)
    assert closed == 2


# ---- (b) files_pending_scan -----------------------------------------------

def _seed_share_with_files(tmp_db):
    sid = state.scan_start("smb", ["10.0.0.0/24"])
    _, share_id = state.upsert_smb_share(sid, "10.0.0.0/24", "10.0.0.1", "data")
    # text candidate, 미스캔
    f_unscanned = state.upsert_smb_file(
        share_id, "/a.txt", size=10, is_text_candidate=True, suspicious_name=False)
    # text candidate, 이미 스캔됨
    f_scanned = state.upsert_smb_file(
        share_id, "/b.txt", size=10, is_text_candidate=True, suspicious_name=False)
    state.file_record_scan(f_scanned, hits_count=0)
    # 비-text candidate (스캔 대상 아님)
    state.upsert_smb_file(
        share_id, "/c.bin", size=10, is_text_candidate=False, suspicious_name=False)
    return share_id, f_unscanned, f_scanned


def test_files_pending_scan_only_unscanned_text(tmp_db):
    share_id, f_unscanned, f_scanned = _seed_share_with_files(tmp_db)
    rows = state.files_pending_scan(limit=100)
    ids = {r["id"] for r in rows}
    assert f_unscanned in ids
    assert f_scanned not in ids          # 이미 scanned 제외
    # 비-text candidate 제외 확인
    assert all(r["is_text_candidate"] == 1 for r in rows)


def test_files_pending_scan_joins_host_share(tmp_db):
    _seed_share_with_files(tmp_db)
    rows = state.files_pending_scan(limit=100)
    assert rows and rows[0]["host"] == "10.0.0.1" and rows[0]["share"] == "data"


def test_files_pending_scan_share_filter(tmp_db):
    share_id, f_unscanned, _ = _seed_share_with_files(tmp_db)
    sid = state.scan_start("smb", ["10.0.0.0/24"])
    _, other = state.upsert_smb_share(sid, "10.0.0.0/24", "10.0.0.2", "other")
    state.upsert_smb_file(
        other, "/x.txt", size=5, is_text_candidate=True, suspicious_name=False)

    rows = state.files_pending_scan(share_id=share_id, limit=100)
    assert {r["id"] for r in rows} == {f_unscanned}


# ---- (b) walk_share max_files=None unlimited -------------------------------

def test_walk_share_accepts_none_max_files():
    """무제한 옵션 시그니처/가드 회귀 — None 이 캡 비교에서 TypeError 안 내야 함.

    네트워크 세션은 monkeypatch 로 차단, 큐 루프 가드만 검증.
    """
    import contextlib

    class _FakeConn:
        def listPath(self, share, pattern):
            return []

    @contextlib.contextmanager
    def _fake_session(host):
        yield _FakeConn()

    orig = smb._smb_session
    smb._smb_session = _fake_session
    try:
        # max_files=None 으로 호출 시 `emitted < max_files` 가 None 비교로 안 터짐
        assert list(smb.walk_share("h", "s", max_files=None)) == []
        assert list(smb.walk_share("h", "s", max_files=5)) == []
    finally:
        smb._smb_session = orig


def test_walk_share_detailed_records_directory_errors(monkeypatch):
    """디렉터리 listing 실패는 debug 로그로만 사라지면 coverage gap 이 숨겨진다."""
    import contextlib

    class _Entry:
        def __init__(self, name, *, directory=False, size=10):
            self._name = name
            self._directory = directory
            self._size = size

        def get_longname(self):
            return self._name

        def is_directory(self):
            return self._directory

        def get_filesize(self):
            return self._size

    class _FakeConn:
        def listPath(self, share, pattern):
            if pattern == "*":
                return [_Entry("ok.txt"), _Entry("denied", directory=True)]
            if pattern == "denied\\*":
                raise Exception("STATUS_ACCESS_DENIED")
            return []

    @contextlib.contextmanager
    def _fake_session(host):
        yield _FakeConn()

    monkeypatch.setattr(smb, "_smb_session", _fake_session)

    result = smb.walk_share_detailed("h", "s", max_files=None)

    assert [f.path for f in result.files] == ["ok.txt"]
    assert len(result.directory_errors) == 1
    assert result.directory_errors[0].path == "denied"
    assert "STATUS_ACCESS_DENIED" in result.directory_errors[0].error


def test_walk_share_detailed_checkpoint_resumes_after_file_cap(monkeypatch):
    """file cap 이후 현재 디렉터리와 pending dir 큐를 checkpoint 로 이어 걷는다."""
    import contextlib

    class _Entry:
        def __init__(self, name, *, directory=False, size=10):
            self._name = name
            self._directory = directory
            self._size = size

        def get_longname(self):
            return self._name

        def is_directory(self):
            return self._directory

        def get_filesize(self):
            return self._size

    class _FakeConn:
        def listPath(self, share, pattern):
            if pattern == "*":
                return [
                    _Entry("f1.txt"),
                    _Entry("f2.txt"),
                    _Entry("sub", directory=True),
                ]
            if pattern == "sub\\*":
                return [_Entry("f3.txt")]
            return []

    @contextlib.contextmanager
    def _fake_session(host):
        yield _FakeConn()

    monkeypatch.setattr(smb, "_smb_session", _fake_session)

    first = smb.walk_share_detailed("h", "s", max_files=1)
    assert [f.path for f in first.files] == ["f1.txt"]
    assert first.truncated is True
    assert first.checkpoint

    second = smb.walk_share_detailed(
        "h", "s", max_files=None, checkpoint=first.checkpoint,
    )
    assert [f.path for f in second.files] == ["f2.txt", "sub/f3.txt"]
    assert second.truncated is False


# ---- 라이브 pg (DSN 있을 때만) ----------------------------------------------

def test_pg_subnet_sweep_helpers_no_error():
    """pg 백엔드에서 신규 헬퍼/마이그레이션 무에러 (별칭/플레이스홀더/컬럼)."""
    state.smb_target_add("203.0.113.0/24", charter_ref="c", added_by="d")
    state.smb_target_add("203.0.113.128/25", charter_ref="c", added_by="d")
    assert len(state.subnets_pending_sweep(limit=1)) == 1
    state.subnet_mark_swept("203.0.113.0/24", scan_id=1, hosts_found=2, shares_found=4)
    ov = state.subnets_sweep_overview()
    assert ov["total"] == 2 and ov["swept"] == 1 and ov["pending"] == 1
    # files_pending_scan 도 pg 에서 JOIN/플레이스홀더 무에러
    assert state.files_pending_scan(limit=10) == []
