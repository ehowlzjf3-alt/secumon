"""공유 일괄 스캔 — 큐를 실제로 비우는가, 그리고 거짓말을 안 하는가.

배경: `state.files_pending_scan` 은 v3.72 에 만들어졌고 **2026-08-27 까지 생산 호출부가
0개였다.** 큐만 있고 비우는 쪽이 없어서 722,958건 중 5건만 스캔됐다. 그 배선이
다시 끊기면 아무도 모른다 — 그래서 등록 자체를 테스트한다.
"""
from __future__ import annotations

import contextlib

import pytest

from service import state_domain as state


# ── 배선: 도구가 워커 화이트리스트에 실제로 있는가 ─────────────────────────

def test_scan_tools_are_registered_for_the_worker():
    from domains.smb.plugin.toolsets import smb_task_tools
    names = {c.name for c in smb_task_tools()}
    assert "smb_scan_share" in names, "훑는 도구가 워커에 안 붙어 있으면 아무 일도 안 일어난다"
    assert "smb_archive_index" in names


def test_worker_contract_tells_it_to_sweep_first():
    """계약이 '골라서 열어라' 로 되돌아가면 다시 5건이 된다."""
    import pathlib
    md = pathlib.Path("domains/smb/skills/smb_task/worker.md").read_text(encoding="utf-8")
    assert "smb_scan_share" in md
    assert "Deep-dive only selected suspicious files" not in md, (
        "한 턴에 한 파일을 고르라는 옛 지시가 남아 있다")


def test_archive_tool_does_not_claim_unsupported_formats():
    from domains.smb.plugin.tools.smb_scan_tools import SmbArchiveIndexTool
    d = SmbArchiveIndexTool.description
    for ext in (".tar.gz", ".7z"):
        assert ext in d, f"{ext} 를 못 한다는 사실이 도구 설명에 없다"


# ── 큐 의미: '아직 안 한 것' 은 NULL 이다 ────────────────────────────────────

def _seed(tmp_db, *, n_text=3):
    sid = state.scan_start("smb", ["10.9.0.0/24"])
    _, share_id = state.upsert_smb_share(sid, "10.9.0.0/24", "10.9.0.1", "docs")
    ids = []
    for i in range(n_text):
        ids.append(state.upsert_smb_file(
            share_id, f"/f{i}.txt", size=100 + i, is_text_candidate=True,
            suspicious_name=False))
    return share_id, ids


def test_skipped_marker_leaves_the_queue(tmp_db):
    """★ denied 파일이 큐에 남으면 매 패스가 같은 파일에서 막힌다."""
    share_id, ids = _seed(tmp_db)
    assert state.count_files_pending_scan(share_id=share_id) == 3
    state.file_record_scan_skipped(ids[0], reason="denied")
    assert state.count_files_pending_scan(share_id=share_id) == 2
    left = {r["id"] for r in state.files_pending_scan(share_id=share_id, limit=10)}
    assert ids[0] not in left


def test_skipped_is_not_recorded_as_scanned(tmp_db):
    """안 읽힌 것을 읽었다고 적으면 커버리지 숫자가 거짓이 된다."""
    _, ids = _seed(tmp_db, n_text=1)
    state.file_record_scan_skipped(ids[0], reason="denied")
    meta = state.file_get_metadata(ids[0])
    assert meta is not None
    assert meta["scan_status"] == "skipped:denied"
    assert meta["scan_status"] != "scanned"


def test_max_size_filters_the_queue(tmp_db):
    sid = state.scan_start("smb", ["10.9.0.0/24"])
    _, share_id = state.upsert_smb_share(sid, "10.9.0.0/24", "10.9.0.2", "big")
    small = state.upsert_smb_file(share_id, "/s.txt", size=1000,
                                  is_text_candidate=True, suspicious_name=False)
    state.upsert_smb_file(share_id, "/b.txt", size=9_000_000,
                          is_text_candidate=True, suspicious_name=False)
    rows = state.files_pending_scan(share_id=share_id, limit=10, max_size=512 * 1024)
    assert {r["id"] for r in rows} == {small}
    assert state.count_files_pending_scan(share_id=share_id, max_size=512 * 1024) == 1
    # 상한 없이는 둘 다 보인다 — 큐에 **남아 있다**(표식하지 않았다).
    assert state.count_files_pending_scan(share_id=share_id) == 2


def test_count_is_not_the_list_length(tmp_db):
    """★ 목록은 limit 로 잘린다. 남은 수를 목록 길이로 세면 '남은 것 없음' 거짓말이 나온다."""
    share_id, _ = _seed(tmp_db, n_text=5)
    assert len(state.files_pending_scan(share_id=share_id, limit=2)) == 2
    assert state.count_files_pending_scan(share_id=share_id) == 5


def test_pending_prefers_suspicious_then_small(tmp_db):
    sid = state.scan_start("smb", ["10.9.0.0/24"])
    _, share_id = state.upsert_smb_share(sid, "10.9.0.0/24", "10.9.0.3", "mix")
    state.upsert_smb_file(share_id, "/big.txt", size=9000,
                          is_text_candidate=True, suspicious_name=False)
    small = state.upsert_smb_file(share_id, "/small.txt", size=10,
                                  is_text_candidate=True, suspicious_name=False)
    susp = state.upsert_smb_file(share_id, "/passwords.txt", size=50_000,
                                 is_text_candidate=True, suspicious_name=True)
    rows = state.files_pending_scan(share_id=share_id, limit=10)
    assert rows[0]["id"] == susp, "의심 이름이 먼저여야 한다"
    assert [r["id"] for r in rows[1:]] == [small, rows[2]["id"]]
    assert rows[1]["id"] == small, "그 다음은 작은 것부터여야 같은 시간에 더 본다"


# ── 스캔 본체: 세션 하나로 여러 파일, 본문 미반환 ───────────────────────────

class _FakeConn:
    """getFile 콜백 계약 + 범위 읽기(openFile/readFile) 계약을 흉내낸다.

    ⚠️ 범위 읽기가 없으면 큰 파일의 **앞부분만 읽기**를 테스트할 수 없다 —
    2026-08-29 이전엔 큐가 큰 파일을 아예 제외해서 이 경로가 필요 없었다.
    """

    def __init__(self, files: dict[str, bytes | Exception]):
        self.files = files
        self.reads: list[str] = []
        self.range_reads: list[tuple[str, int, int]] = []

    def getFile(self, share, winpath, callback, **kw):  # noqa: N802
        key = winpath.replace("\\", "/")
        self.reads.append(key)
        val = self.files.get(key)
        if isinstance(val, Exception):
            raise val
        callback(val if val is not None else b"")

    # ── 범위 읽기 ────────────────────────────────────────────────────────
    def connectTree(self, share):  # noqa: N802
        return 1

    def openFile(self, tid, winpath, **kw):  # noqa: N802
        key = winpath.replace("\\", "/")
        val = self.files.get(key)
        if isinstance(val, Exception):
            raise val
        self._open_key = key
        return 2

    def readFile(self, tid, fid, offset, length, **kw):  # noqa: N802
        key = getattr(self, "_open_key", "")
        self.reads.append(key)
        self.range_reads.append((key, int(offset), int(length)))
        val = self.files.get(key) or b""
        return val[int(offset):int(offset) + int(length)]

    def closeFile(self, tid, fid):  # noqa: N802
        return None

    def disconnectTree(self, tid):  # noqa: N802
        return None


@pytest.fixture()
def fake_smb(monkeypatch):
    import contextlib

    from domains.smb.plugin.agent_types import smb as smbmod

    state_box: dict[str, _FakeConn] = {}
    opened = {"n": 0}

    def make(files):
        conn = _FakeConn(files)
        state_box["conn"] = conn

        @contextlib.contextmanager
        def _open(host):
            opened["n"] += 1
            yield conn

        monkeypatch.setattr(smbmod, "open_session", _open)
        monkeypatch.setattr(smbmod, "_AUTH_DISABLED_REASON", None, raising=False)
        return conn, opened

    return make


def _run(share_id, **kw):
    from domains.smb.plugin.tools.smb_scan_tools import (
        SmbScanShareInput, _scan_share_blocking,
    )
    vi = SmbScanShareInput(share_id=share_id, **kw)
    return _scan_share_blocking(vi, ctx=None)


def test_one_session_for_many_files(tmp_db, fake_smb):
    """★ 이 도구의 존재 이유. 파일마다 로그인하면 배치가 성립하지 않는다."""
    share_id, _ = _seed(tmp_db, n_text=3)
    conn, opened = fake_smb({f"/f{i}.txt": b"hello world\n" for i in range(3)})
    out = _run(share_id)
    assert out["scanned"] == 3
    assert opened["n"] == 1, f"세션을 {opened['n']}번 열었다 — 하나여야 한다"
    assert len(conn.reads) == 3


def test_scan_persists_hits_and_empties_the_queue(tmp_db, fake_smb):
    share_id, ids = _seed(tmp_db, n_text=2)
    fake_smb({
        # ⚠️ AWS 키 문자열은 현행 detector 가 안 잡는다(2026-08-27 확인) — 별건이다.
        #    여기서는 실제로 잡히는 패턴을 쓴다. 안 그러면 이 테스트가 detector 갭을
        #    스캐너 버그로 오독하게 만든다.
        "/f0.txt": b"db.password=Sup3rS3cretP@ssw0rd!\n",
        "/f1.txt": b"nothing interesting here\n",
    })
    out = _run(share_id)
    assert out["scanned"] == 2
    assert out["remaining"] == 0
    assert state.count_files_pending_scan(share_id=share_id) == 0
    assert out["hits_total"] >= 1, "시크릿이 든 파일에서 hit 가 안 나왔다"
    assert state.hits_for_file(ids[0]), "hit 가 DB 에 영속되지 않았다"


def test_scan_returns_candidates_not_the_file(tmp_db, fake_smb):
    """본문을 돌려주면 워커 컨텍스트가 탄다.

    ⚠️ "본문이 하나도 안 나온다" 가 아니다 — hit 의 `line_preview` 는 **증거이고
       의도된 것**이다(`smb_fetch_scan` 도 같은 것을 낸다). 검사하는 것은
       hit 와 무관한 나머지 본문이 딸려 나오지 않는가 다.
    """
    share_id, _ = _seed(tmp_db, n_text=1)
    body = (b"db.password=Sup3rS3cretP@ssw0rd!\n"
            + b"filler line\n" * 60
            + b"UNIQUE_FAR_MARKER_9137\n")
    fake_smb({"/f0.txt": body})
    out = _run(share_id)
    import json
    blob = json.dumps(out, ensure_ascii=False)
    assert out["hits_total"] >= 1
    assert "UNIQUE_FAR_MARKER_9137" not in blob, "hit 와 무관한 본문이 딸려 나왔다"
    # preview 는 detector 가 이미 한 줄 남짓으로 자른다(실측 94자). 그 상한이 사라지면
    # 후보 40개 × hit 6개가 워커 컨텍스트를 통째로 먹는다.
    previews = [h["line_preview"] for c in out["candidates"] for h in c["hits"]]
    assert previews and all(len(p) <= 200 for p in previews), \
        f"preview 최대 {max(len(p) for p in previews)}자 — 상한이 풀렸다"


def test_denied_file_is_marked_and_does_not_come_back(tmp_db, fake_smb):
    share_id, ids = _seed(tmp_db, n_text=2)
    fake_smb({
        "/f0.txt": Exception("STATUS_ACCESS_DENIED"),
        "/f1.txt": b"ok\n",
    })
    out = _run(share_id)
    assert out["scanned"] == 1 and out["skipped"] == 1
    assert out["fetch_status"].get("denied") == 1
    assert state.count_files_pending_scan(share_id=share_id) == 0


def test_remaining_counts_the_whole_queue_not_the_batch(tmp_db, fake_smb):
    """★ 남은 수가 배치 크기로 계산되면 워커가 한 번만 부르고 끝낸다."""
    share_id, _ = _seed(tmp_db, n_text=5)
    fake_smb({f"/f{i}.txt": b"x\n" for i in range(5)})
    out = _run(share_id, max_files=2)
    assert out["scanned"] == 2
    assert out["remaining"] == 3, out
    assert "next" in out and "다시" in out["next"]


def test_big_file_is_head_read_instead_of_being_skipped(tmp_db, fake_smb):
    """★ 상한보다 큰 파일을 **건너뛰지 않고 앞부분만** 읽는다.

    2026-08-29 이전: `files_pending_scan(max_size=...)` 이 큐에서 통째로 빼서
    512K 초과 text 후보 33,553건(6.4TB)이 한 번도 안 열렸다. 부분읽기 코드는
    `fetch_file_on` 에 **이미 있었다** — 큐가 그 파일을 안 보여줬을 뿐이다.
    """
    sid = state.scan_start("smb", ["10.9.0.0/24"])
    _, share_id = state.upsert_smb_share(sid, "10.9.0.0/24", "10.9.0.9", "onlybig")
    body = b"noise\n" * 1000 + b"password=hunter2SECRET!\n" + b"tail\n" * 500_000
    state.upsert_smb_file(share_id, "/huge.txt", size=len(body),
                          is_text_candidate=True, suspicious_name=False)
    conn, _ = fake_smb({"/huge.txt": body})

    out = _run(share_id, max_bytes_per_file=512 * 1024)
    assert out["scanned"] == 1, out
    assert conn.range_reads == [("/huge.txt", 0, 512 * 1024)], (
        "전체 전송(getFile)이 아니라 범위 읽기여야 한다")
    assert out["partial_reads"]["files"] == 1
    assert "앞부분에는 없었다" in out["partial_reads"]["note"]


def test_head_read_is_recorded_as_partial_not_as_full_text(tmp_db, fake_smb):
    """★ 앞부분만 봤으면 그렇게 적는다 — 'text' 로 적으면 '다 봤다' 가 된다."""
    sid = state.scan_start("smb", ["10.9.0.0/24"])
    _, share_id = state.upsert_smb_share(sid, "10.9.0.0/24", "10.9.0.8", "mixed")
    big = b"a\n" * 400_000
    state.upsert_smb_file(share_id, "/big.txt", size=len(big),
                          is_text_candidate=True, suspicious_name=False)
    state.upsert_smb_file(share_id, "/small.txt", size=4,
                          is_text_candidate=True, suspicious_name=False)
    fake_smb({"/big.txt": big, "/small.txt": b"ok\n"})
    _run(share_id, max_bytes_per_file=64 * 1024)

    got = {r["path"]: r["fetch_status"] for r in state.files_for_share(share_id)}
    assert got["/big.txt"] == "text:head", got
    assert got["/small.txt"] == "text", got


def test_oversized_zip_container_is_not_closed_as_binary(tmp_db, fake_smb):
    """★ 앞부분만으로는 못 여는 포맷을 'binary' 로 닫으면 거짓말이다.

    잘린 zip 은 추출이 실패하고, 실패는 `binary` 로 떨어져 **종결** 표식이 찍힌다.
    크기 때문에 못 본 것은 크기 때문이라고 적어야 `unread_leads` 로 다시 나온다.
    """
    sid = state.scan_start("smb", ["10.9.0.0/24"])
    _, share_id = state.upsert_smb_share(sid, "10.9.0.0/24", "10.9.0.7", "docs")
    state.upsert_smb_file(share_id, "/직원명단.xlsx", size=9_000_000,
                          is_text_candidate=True, suspicious_name=False)
    conn, _ = fake_smb({})
    out = _run(share_id, max_bytes_per_file=512 * 1024)

    assert conn.reads == [], "열지 말았어야 한다"
    assert out["fetch_status"].get("too_large") == 1, out
    rows = state.files_for_share(share_id)
    assert rows[0]["scan_status"] == "skipped:too_large", rows[0]["scan_status"]
    assert out["remaining"] == 0, "표식을 안 하면 워커가 같은 배치를 무한히 다시 부른다"


# ── 노이즈: 게이트가 이미 거부할 것을 앞에 두지 않는다 ──────────────────────

@contextlib.contextmanager
def swap_category_judge(category: str, judge):
    """등록된 판정기를 잠시 바꿔치고 **원래 객체를 그대로** 되돌린다.

    ★ 픽스처 안에 인라인으로 두지 않는다 — 되돌리기가 맞는지 직접 테스트할 수 있어야 한다.
    """
    from secu_agent.agent import evidence_judgment as ej

    previous = ej._CATEGORY_JUDGES.get(category)
    ej.unregister_category_evidence_judge(category)
    ej.register_category_evidence_judge(category, judge)
    try:
        yield
    finally:
        ej.unregister_category_evidence_judge(category)
        if previous is not None:
            ej.register_category_evidence_judge(category, previous)


def test_swap_restores_the_original_object_not_ours():
    """★ 처음엔 bool 만 보고 **내 함수**를 다시 넣었다. 그건 남의 등록을 바꿔치기하는
    짓이고, 전역 레지스트리라 뒤 테스트로 샌다 — 전수 스위트에서만 다른 파일이 깨지고
    단독 실행은 통과해서 원인이 여기 있다는 게 안 보인다."""
    from secu_agent.agent import evidence_judgment as ej

    from plugin.pii_evidence_judge import judge_pii_hit

    def sentinel(finding, hit):
        return None

    saved = ej._CATEGORY_JUDGES.get("pii")
    ej.unregister_category_evidence_judge("pii")
    ej.register_category_evidence_judge("pii", sentinel)
    try:
        with swap_category_judge("pii", judge_pii_hit):
            assert ej._CATEGORY_JUDGES.get("pii") is judge_pii_hit
        assert ej._CATEGORY_JUDGES.get("pii") is sentinel, "남의 등록을 잃었다"
    finally:
        ej.unregister_category_evidence_judge("pii")
        if saved is not None:
            ej.register_category_evidence_judge("pii", saved)


def test_swap_leaves_nothing_behind_when_none_was_registered():
    from secu_agent.agent import evidence_judgment as ej

    from plugin.pii_evidence_judge import judge_pii_hit

    saved = ej._CATEGORY_JUDGES.get("pii")
    ej.unregister_category_evidence_judge("pii")
    try:
        with swap_category_judge("pii", judge_pii_hit):
            pass
        assert "pii" not in ej._CATEGORY_JUDGES, "없던 등록을 만들어 놓고 갔다"
    finally:
        if saved is not None:
            ej.unregister_category_evidence_judge("pii")
            ej.register_category_evidence_judge("pii", saved)


@pytest.fixture()
def pii_judge_registered():
    """★ 등록 안 됐다고 skip 하지 않는다 — 그러면 이 파일에서 가장 중요한 단언이 꺼진다.

    ⚠️ 되돌릴 때 **원래 있던 객체**를 되돌린다. 처음엔 `had`(bool)만 보고 `judge_pii_hit`
       를 다시 넣었는데, 그건 남이 등록해 둔 판정기를 내 것으로 **바꿔치기**하는 짓이다.
       전역 레지스트리라 그대로 뒤 테스트로 샌다 — 전수 스위트에서만 다른 파일이
       깨지고 단독 실행은 통과해서, 원인이 이 파일에 있다는 게 안 보인다.
    """
    from plugin.pii_evidence_judge import judge_pii_hit

    with swap_category_judge("pii", judge_pii_hit):
        yield


# 실측 2026-08-27 첫 라이브 배치에서 나온 모양 그대로 — 부동소수의 소수부다.
#
# ⚠️ 소수부 16자리는 **Luhn 을 통과해야** 한다. 처음에 아무 숫자나 넣었더니 탐지기가
#    hit 를 아예 안 만들어서, "오탐을 표식한다" 를 검사하려던 테스트가 조용히
#    아무것도 검사하지 않게 됐다. 라이브에서 걸린 값이 Luhn 유효했던 이유가 그거다.
_LUHN16 = "3836171234566829"
_FRACTION_LINE = (
    f"0.99242333604433,1.0079619307622065,0.{_LUHN16},1.1557154536247252\n"
)


def test_decimal_fraction_pii_is_marked_not_deleted(tmp_db, fake_smb, pii_judge_registered):
    """★ 표식하되 **지우지 않는다.** 스캔 단계 화이트리스트는 진짜 유출을 죽인다."""
    share_id, ids = _seed(tmp_db, n_text=1)
    fake_smb({"/f0.txt": _FRACTION_LINE.encode()})
    out = _run(share_id)

    assert out["hits_total"] >= 1, "hit 자체는 나야 한다 — 탐지기를 끄는 게 아니다"
    assert state.hits_for_file(ids[0]), "DB 에서 지워졌다 — 증거를 없애면 안 된다"
    assert out["gate_rejected"]["hits"] >= 1
    cand = out["candidates"][0]
    assert cand["all_hits_gate_rejected"] is True
    assert any("gate_rejects" in h for h in cand["hits"]), "왜 노이즈인지 안 말해준다"


def test_real_hit_sorts_ahead_of_noise(tmp_db, fake_smb, pii_judge_registered):
    """워커의 첫 화면이 노이즈면 판정이 노이즈에 탄다."""
    sid = state.scan_start("smb", ["10.9.0.0/24"])
    _, share_id = state.upsert_smb_share(sid, "10.9.0.0/24", "10.9.0.7", "mixed")
    for name in ("/noise.csv", "/real.ini"):
        state.upsert_smb_file(share_id, name, size=200,
                              is_text_candidate=True, suspicious_name=False)
    fake_smb({
        "/noise.csv": _FRACTION_LINE.encode(),
        "/real.ini": b"db.password=Sup3rS3cretP@ssw0rd!\n",
    })
    out = _run(share_id)
    paths = [c["path"] for c in out["candidates"]]
    assert paths.index("/real.ini") < paths.index("/noise.csv"), paths


def test_gate_rule_is_not_reimplemented_here():
    """규칙을 여기 베껴 쓰면 게이트가 바뀔 때 두 판정이 갈린다 — 등록된 것을 부른다."""
    import inspect

    from domains.smb.plugin.tools import smb_scan_tools as m

    src = inspect.getsource(m._gate_would_reject)
    assert "_CATEGORY_JUDGES" in src
    for leaked in ("credit_card", "kr_rrn", "소수부"):
        assert leaked not in src, f"게이트 규칙({leaked})이 여기 복사돼 있다"


def test_files_with_hits_is_not_the_truncated_list_length(tmp_db, fake_smb, monkeypatch):
    """★ 집계를 잘린 목록으로 세지 마라 — 이 저장소가 반복해서 당한 거짓말이다."""
    from domains.smb.plugin.tools import smb_scan_tools as m

    monkeypatch.setattr(m, "_CANDIDATE_CAP", 3)
    sid = state.scan_start("smb", ["10.9.0.0/24"])
    _, share_id = state.upsert_smb_share(sid, "10.9.0.0/24", "10.9.0.8", "many")
    for i in range(8):
        state.upsert_smb_file(share_id, f"/h{i}.ini", size=100,
                              is_text_candidate=True, suspicious_name=False)
    fake_smb({f"/h{i}.ini": b"db.password=Sup3rS3cretP@ssw0rd!\n" for i in range(8)})

    out = _run(share_id)
    assert len(out["candidates"]) == 3, "목록은 잘려야 한다"
    assert out["candidates_omitted"] == 5, "몇 건을 뺐는지 말해야 한다"
    assert out["files_with_hits"] == 8, out["files_with_hits"]
