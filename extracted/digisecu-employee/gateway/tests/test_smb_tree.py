"""SMB 노출 표면 — 공유 → 디렉터리 (`/gw/sources/{srcKey}/smb-tree`).

발견 목록은 "무엇이 걸렸나", 이건 "어디까지 열려 있나" 다. 같은 화면이 스킬쪽 :8767 에
이미 있고, 이건 그것을 읽기전용 롤 위로 옮긴 것이다.
"""
import os

import pytest

LIVE = pytest.mark.skipif(
    not os.environ.get("SECU_AGENT_PG_DSN"),
    reason="라이브 threat_hunter DSN(SECU_AGENT_PG_DSN) 필요",
)


@pytest.fixture()
def pool():
    os.environ.setdefault("GATEWAY_TOKEN", "test")
    from digisecu_gateway.config import Config
    from digisecu_gateway.db import ReadOnlyPool

    p = ReadOnlyPool(Config.load())
    p.open()
    yield p
    p.close()


# ── DB 없이 ──────────────────────────────────────────────────────────────────


def test_cap_is_per_share_not_per_host():
    """★ 처음엔 호스트 전체에 캡을 걸었다가 앞쪽 공유 하나가 다 먹었다.

    나머지 공유는 `directories: []` 가 됐는데, 그건 "폴더가 없다" 와 화면에서 구분되지
    않는다 — 이 프로젝트에서 계속 고쳐온 실패 모양이다.
    """
    from digisecu_gateway.repos import smb_tree_repo as r

    assert hasattr(r, "DIRECTORY_CAP_PER_SHARE")
    assert not hasattr(r, "DIRECTORY_CAP"), "호스트 단위 캡이 되살아났다"
    assert 0 < r.DIRECTORY_CAP_PER_SHARE <= 1000


def test_flags_keep_unknown_distinct_from_false():
    """0/1/NULL → False/True/**None**. 실측상 writable 은 한 건도 안 채워진다(0/195,277)."""
    from digisecu_gateway.repos.smb_tree_repo import _flag

    assert _flag(1) is True
    assert _flag(0) is False
    assert _flag(None) is None, "NULL 을 False 로 접으면 '안 됨' 과 '모름' 이 같아진다"
    assert _flag("헛소리") is None


def test_share_projection_excludes_free_text():
    """`summary`·`listing_review` 는 투영하지 않는다 — 무엇이 들어 있는지 계약으로 말 못 한다."""
    from digisecu_gateway.models import SmbShare
    from digisecu_gateway.repos.smb_tree_repo import _SHARE_COLS

    assert "summary" not in _SHARE_COLS
    assert "listing_review" not in _SHARE_COLS
    assert "summary" not in SmbShare.model_fields
    assert "evidence_dir" not in _SHARE_COLS


# ── 라이브 ───────────────────────────────────────────────────────────────────


@LIVE
def test_tree_answers_by_src_key_only(pool):
    from digisecu_gateway.repos import smb_tree_repo, source_repo

    src = source_repo.list_sources(pool, domain="smb", limit=1)
    assert src.items, "smb 대상이 없다"
    key = src.items[0].srcKey

    tree = smb_tree_repo.smb_tree(pool, src_key=key)
    assert tree.srcKey == key
    assert tree.shares, "이 호스트에 공유가 하나도 없다"
    assert tree.host, "host 를 못 풀었다 — srcKey 해시 규칙이 source_repo 와 어긋났나"


@LIVE
def test_every_share_gets_directories_not_just_the_first(pool):
    """★ 캡이 공유별인지 실데이터로 확인한다.

    공유가 여럿이고 디렉터리 총계가 있는 호스트에서, **첫 공유만** 비어있지 않은 상태가
    되면 안 된다.
    """
    from digisecu_gateway.repos import smb_tree_repo, source_repo

    checked = 0
    for item in source_repo.list_sources(pool, domain="smb", order="findings", limit=25).items:
        tree = smb_tree_repo.smb_tree(pool, src_key=item.srcKey)
        if tree.access != "ok" or len(tree.shares) < 3 or tree.directoryTotal < 100:
            continue
        with_dirs = [s for s in tree.shares if s.directories]
        have_any = [s for s in tree.shares if s.directoryTotal > 0]
        assert len(with_dirs) == len(have_any), (
            f"폴더가 있는 공유 {len(have_any)}개 중 {len(with_dirs)}개만 채워졌다 — "
            "캡이 앞쪽 공유에 쏠렸다"
        )
        checked += 1
        if checked >= 2:
            break
    if checked == 0:
        pytest.skip("공유 3개 이상 + 폴더 100개 이상인 호스트가 없다")


@LIVE
def test_per_share_total_is_server_counted_not_list_length(pool):
    """잘린 목록의 길이를 전부인 척하면 안 된다 — 총계는 서버가 센 값이어야 한다."""
    from digisecu_gateway.repos import smb_tree_repo, source_repo

    for item in source_repo.list_sources(pool, domain="smb", order="findings", limit=25).items:
        tree = smb_tree_repo.smb_tree(pool, src_key=item.srcKey)
        if tree.access != "ok":
            continue
        for s in tree.shares:
            assert s.directoryTotal >= len(s.directories)
        if tree.directoriesTruncated:
            assert any(s.directoryTotal > len(s.directories) for s in tree.shares)
            return
    pytest.skip("잘린 호스트를 못 찾았다")


@LIVE
def test_unknown_src_key_is_empty_not_error(pool):
    """없는 키는 빈 결과다 — 500 이 아니라."""
    from digisecu_gateway.repos import smb_tree_repo

    tree = smb_tree_repo.smb_tree(pool, src_key="0" * 16)
    assert tree.shares == []
    assert tree.host is None
