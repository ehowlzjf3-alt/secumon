"""SMB 노출 표면 — 한 호스트의 공유 → 디렉터리.

## 이 화면이 답하는 질문

티켓 상세의 발견 목록은 "**무엇이** 걸렸나" 를 답한다(파일 하나하나). 이건 "**어디까지
열려 있나**" 를 답한다 — finding 이 없는 폴더도 읽기 가능하면 노출 표면이다.

같은 화면이 스킬쪽 SMB 운영 웹앱(:8767)에 이미 있다. 거긴 엔진 쓰기 롤이라 파일 단위까지
그리는데, 여기는 **디렉터리까지만** 한다:

  · 공유당 디렉터리 평균 51 · 최대 4,503 (실측 2026-08-25, 195,277행 / 3,797공유)
  · 공유당 파일     평균 3,442 · 최대 66,375 (2,020,402행)

파일 축을 열면 GRANT 도 커지고(2백만 행) 같은 사실의 출처가 둘이 된다 — 파일 단위 증거는
`/gw/findings/{id}` 의 `hits[].location` 이 이미 답한다. 공유별 파일 **수**는
`smb_share.walk_file_count` 로 충분하다.

## 경로는 마스킹하지 않는다

사용자 결정(2026-08-25). 경로 자체가 공정 정보를 담을 수 있지만(`…/SEMES_IPDT#…jpg`),
:8767 이 같은 ACL 안에서 원문을 그대로 보여주고 있고 콘솔도 같은 사내 ACL 사이트다.
**두 화면이 같은 대상에 다른 값을 보이는 쪽이 더 나쁘다.**
⚠️ 다만 `smb_share.summary`·`listing_review` 는 투영하지 않는다 — 자유 텍스트라 무엇이
   들어 있는지 계약으로 말할 수 없다. 여는 것은 **구조**(경로·권한 플래그)뿐이다.
"""
from __future__ import annotations

from ..db import ReadOnlyPool
from ..models import SmbDirectory, SmbShare, SmbTree
from .source_repo import src_key_sql

#: **공유당** 디렉터리 상한.
#: ⚠️ 처음엔 호스트 전체에 2,000 을 걸었다가 갈아엎었다 — `ORDER BY share_id` 로 뽑으니
#:    앞쪽 공유 하나가 캡을 다 먹고 **나머지 공유가 전부 `dirs=0`** 이 됐다.
#:    "이 공유엔 폴더가 없다" 와 "화면이 잘라서 안 보여준다" 가 같은 모양이 되는 것,
#:    그게 이 프로젝트에서 계속 고쳐온 실패다. 공유별로 나눠 자른다.
DIRECTORY_CAP_PER_SHARE = 200

#: 공유 상한. 실측 최다는 호스트 하나에 20개.
SHARE_CAP = 64

_readable: bool | None = None


def reset_probe() -> None:
    """테스트용 — 프로브 캐시를 비운다."""
    global _readable
    _readable = None


def directory_readable(pool: ReadOnlyPool) -> bool:
    """`smb_directory` 를 읽을 수 있는가(sql/006).

    ★ 못 읽는 것을 "디렉터리 없음" 으로 그리면 거짓말이다. 예외를 삼키지 않고 값으로
      돌려보내, 화면이 "권한 없음" 과 "정말 비었음" 을 구분하게 한다.
    """
    global _readable
    if _readable is None:
        try:
            pool.fetch_one("SELECT 1 AS ok FROM smb_directory LIMIT 1")
            _readable = True
        except Exception:  # noqa: BLE001 — 42501(미부여)·42P01(미생성)
            _readable = False
    return _readable


#: 실측 채움률(2026-08-25, 195,277행) — 화면이 빈 열을 만들지 않게 여기 적어 둔다.
#:   listable 195,277(100%, 참 189,084) · readable 4,065(2%) · **writable 0(한 건도 없음)**
#:   error 6,193 · 루트 경로(path='') 3,797 = 공유당 1
#: ⚠️ writable 을 "쓰기 불가" 로 그리면 안 된다 — 워커가 **아예 안 채운다**.
#:    값이 있을 때만 그리는 것이 규칙이고, 그래서 세 플래그를 전부 nullable 로 둔다.


def _flag(v: object) -> bool | None:
    """0/1/NULL → False/True/None. **NULL 은 False 가 아니다** — '안 됨' 과 '모름' 은 다르다."""
    if v is None:
        return None
    try:
        return bool(int(v))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


_SHARE_COLS = (
    "id, host, share, status, severity, share_read, share_write, "
    "null_login_ok, guest_login_ok, auth_login_ok, walk_file_count, "
    "walk_done_at, last_seen, cycle_key"
)


def smb_tree(pool: ReadOnlyPool, *, src_key: str) -> SmbTree:
    """srcKey(=smb 호스트) 한 곳의 공유·디렉터리.

    ⚠️ 호스트 원문을 인자로 받지 않는다 — srcKey 로만 되묻는다. 라벨(`src`)은 마스킹값이라
       서로 다른 두 대상이 같은 라벨로 보일 수 있고, 그게 키를 따로 두는 이유다.
    """
    key_expr = src_key_sql("'smb'", "s.host")
    shares = pool.fetch_all(
        f"SELECT {_SHARE_COLS} FROM smb_share s "
        f"WHERE {key_expr} = %s ORDER BY s.share ASC, s.id ASC LIMIT %s",
        [src_key, SHARE_CAP + 1],
    )
    shares_truncated = len(shares) > SHARE_CAP
    shares = shares[:SHARE_CAP]

    if not shares:
        return SmbTree(
            srcKey=src_key, host=None, access="ok" if directory_readable(pool) else "denied",
            shares=[], directoryTotal=0, directoriesTruncated=False, sharesTruncated=False,
        )

    host = str(shares[0].get("host") or "") or None
    share_ids = [int(r["id"]) for r in shares]

    if not directory_readable(pool):
        # 권한이 없으면 공유는 보여주되 디렉터리는 **"못 읽음"** 으로 명시한다.
        return SmbTree(
            srcKey=src_key, host=host, access="denied",
            shares=[_to_share(r, [], 0) for r in shares],
            directoryTotal=0, directoriesTruncated=False, sharesTruncated=shares_truncated,
        )

    # 공유별 전체 개수 — 목록 길이로 세지 않는다(잘린 값을 전부인 척하게 된다).
    totals = {
        int(r["share_id"]): int(r["n"])
        for r in pool.fetch_all(
            "SELECT share_id, COUNT(*) AS n FROM smb_directory "
            "WHERE share_id = ANY(%s) GROUP BY share_id",
            [share_ids],
        )
    }
    directory_total = sum(totals.values())

    # ★ 공유별로 나눠 자른다. 전체에 LIMIT 을 걸면 앞쪽 공유가 다 먹는다.
    rows = pool.fetch_all(
        "SELECT share_id, path, depth, listable, readable, writable, error, last_seen FROM ("
        "  SELECT *, ROW_NUMBER() OVER ("
        "    PARTITION BY share_id ORDER BY depth ASC, path ASC) AS rn"
        "  FROM smb_directory WHERE share_id = ANY(%s)"
        ") t WHERE rn <= %s ORDER BY share_id ASC, depth ASC, path ASC",
        [share_ids, DIRECTORY_CAP_PER_SHARE],
    )

    by_share: dict[int, list[SmbDirectory]] = {}
    for r in rows:
        by_share.setdefault(int(r["share_id"]), []).append(
            SmbDirectory(
                path=str(r.get("path") or ""),
                depth=int(r.get("depth") or 0),
                listable=_flag(r.get("listable")),
                readable=_flag(r.get("readable")),
                writable=_flag(r.get("writable")),
                error=str(r["error"]) if r.get("error") else None,
                lastSeen=_num(r.get("last_seen")),
            )
        )

    return SmbTree(
        srcKey=src_key,
        host=host,
        access="ok",
        shares=[
            _to_share(r, by_share.get(int(r["id"]), []), totals.get(int(r["id"]), 0))
            for r in shares
        ],
        directoryTotal=directory_total,
        directoriesTruncated=directory_total > len(rows),
        sharesTruncated=shares_truncated,
    )


def _num(v: object) -> float | None:
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _to_share(r: dict, dirs: list[SmbDirectory], dir_total: int) -> SmbShare:
    return SmbShare(
        share=str(r.get("share") or ""),
        status=str(r["status"]) if r.get("status") else None,
        severity=str(r["severity"]) if r.get("severity") else None,
        shareRead=_flag(r.get("share_read")),
        shareWrite=_flag(r.get("share_write")),
        nullLogin=_flag(r.get("null_login_ok")),
        guestLogin=_flag(r.get("guest_login_ok")),
        authLogin=_flag(r.get("auth_login_ok")),
        fileCount=None if r.get("walk_file_count") is None else int(r["walk_file_count"]),
        walkDoneAt=_num(r.get("walk_done_at")),
        lastSeen=_num(r.get("last_seen")),
        cycleKey=str(r["cycle_key"]) if r.get("cycle_key") else None,
        #: 이 공유의 **전체** 디렉터리 수. `len(directories)` 와 다르면 잘린 것이다.
        directoryTotal=dir_total,
        directories=dirs,
    )
