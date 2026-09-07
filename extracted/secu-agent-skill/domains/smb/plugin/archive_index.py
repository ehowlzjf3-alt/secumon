"""아카이브 목차 — 통째로 안 받고 헤더만 읽는다 (2026-08-27).

## 왜

실측 2026-08-27: `smb_file` 에 tar 34,069개(761GB) · zip 967개(626GB) · 7z 228개가 있고
**한 바이트도 열린 적이 없다**. `fetch_file_bytes` 가 `size > max_bytes` 에서 `too_large`
로 끝내기 때문이다. 그래서 SMSSIG$ 같은 공유에 대해 검토원이 낼 수 있는 최선이
"파일명 패턴(UUID.tar)과 공유 이름으로 보아 SCCM 배포 패키지로 **추정**됩니다" 였다.

추정을 안 한 게 아니라 확인할 방법이 없었다. tar 는 512바이트 헤더에 이름과 크기가
평문으로 들어 있고, zip 은 **꼬리**에 중앙 디렉터리가 있다. 둘 다 앞뒤 몇 KB 로 목차가 나온다.

## 계약

`reader(offset, length) -> bytes | None` 만 받는다. SMB 를 몰라서 테스트가 쉽다.
`None` 은 "못 읽었다" 다 — 빈 bytes(=파일 끝)와 **구분한다**. 섞으면 읽기 실패가
"빈 아카이브" 로 보인다.

## 못 하는 것은 못 한다고 답한다

    tar        ✅ 헤더 체인
    zip        ✅ 꼬리 EOCD → 중앙 디렉터리 (ZIP64 포함)
    tar.gz/tgz ❌ 앞에서부터 풀지 않으면 목차가 없다 — 원리적으로 불가
    7z/rar/cab ❌ 미구현. 지원한다고 말하지 않는다

★ 목차는 **이름과 크기**다. 내용이 아니다. "무슨 파일인지" 는 답하지만 "그 안에 시크릿이
  있는지" 는 답하지 않는다 — 그건 멤버를 실제로 꺼내야 하고, 이 모듈의 일이 아니다.
"""
from __future__ import annotations

import struct
from typing import Any, Callable

Reader = Callable[[int, int], "bytes | None"]

#: 한 번에 당겨 파싱하는 창. tar 에서 작은 파일이 연달아 있으면 이 안에서 여러 헤더를
#: 왕복 없이 읽는다(파일 하나에 read 한 번이면 수천 엔트리에서 수천 왕복이 된다).
_WINDOW = 64 * 1024
#: zip 꼬리에서 EOCD 를 찾는 범위. EOCD 코멘트 최대 65,535 + 레코드 22.
_ZIP_TAIL = 66 * 1024
_BLOCK = 512
#: 중앙 디렉터리를 한 번에 읽는 상한. 엔트리 수만 부풀린 zip 폭탄 방어.
RANGE_CAP = 4 * 1024 * 1024


def _octal(raw: bytes) -> int:
    """tar 의 8진수 필드. NUL/공백 패딩이고, GNU base-256 확장은 최상위 비트로 표시된다."""
    if raw and raw[0] & 0x80:
        # base-256: 최상위 비트를 뺀 나머지를 big-endian 정수로.
        val = raw[0] & 0x7F
        for b in raw[1:]:
            val = (val << 8) | b
        return val
    text = raw.split(b"\0", 1)[0].strip()
    if not text:
        return 0
    try:
        return int(text, 8)
    except ValueError:
        return 0


def _looks_like_tar(head: bytes) -> bool:
    return len(head) >= 265 and head[257:262] in (b"ustar", b"ustar".ljust(5))


def tar_index(reader: Reader, *, size: int, max_entries: int = 200) -> dict[str, Any]:
    """tar 헤더 체인을 따라 목차를 만든다."""
    entries: list[dict[str, Any]] = []
    offset = 0
    buf = b""
    buf_at = -1
    truncated = False
    long_name: str | None = None

    def _at(pos: int, need: int) -> bytes | None:
        """`pos` 에서 `need` 바이트. 창 안이면 재사용하고, 아니면 새로 당긴다."""
        nonlocal buf, buf_at
        if buf_at >= 0 and buf_at <= pos and pos + need <= buf_at + len(buf):
            return buf[pos - buf_at: pos - buf_at + need]
        chunk = reader(pos, max(_WINDOW, need))
        if chunk is None:
            return None
        buf, buf_at = chunk, pos
        return chunk[:need] if len(chunk) >= need else chunk

    while len(entries) < max_entries:
        if size and offset + _BLOCK > size:
            break
        head = _at(offset, _BLOCK)
        if head is None:
            return {"ok": False, "format": "tar", "entries": entries,
                    "detail": f"offset {offset} 읽기 실패"}
        if len(head) < _BLOCK or head[:_BLOCK] == b"\0" * _BLOCK:
            break  # 정상 종료 — 끝 블록
        if offset == 0 and not _looks_like_tar(head):
            return {"ok": False, "format": "tar", "entries": [],
                    "detail": "ustar 매직이 없다 — tar 가 아니거나 압축돼 있다"}

        name = head[:100].split(b"\0", 1)[0].decode("utf-8", "replace")
        prefix = head[345:500].split(b"\0", 1)[0].decode("utf-8", "replace")
        member_size = _octal(head[124:136])
        typeflag = head[156:157]

        if typeflag in (b"L", b"K"):
            # GNU long name/link — 다음 데이터 블록이 진짜 이름이다.
            raw = _at(offset + _BLOCK, min(member_size, _WINDOW))
            long_name = (raw.split(b"\0", 1)[0].decode("utf-8", "replace")
                         if raw else None)
        else:
            full = long_name or (f"{prefix}/{name}" if prefix else name)
            long_name = None
            if full:
                entries.append({
                    "name": full,
                    "size": member_size,
                    "kind": ("dir" if typeflag == b"5" or full.endswith("/")
                             else "file"),
                    # ★ 멤버 본문은 헤더 **바로 뒤** 512 정렬 위치에 **무압축**으로 있다.
                    #   그래서 tar 는 멤버 하나를 정확히 이 구간만 읽어 꺼낼 수 있다.
                    "offset": offset + _BLOCK,
                    "method": "store",
                })
        offset += _BLOCK + ((member_size + _BLOCK - 1) // _BLOCK) * _BLOCK

    else:
        # ★ while-else: break 없이 조건이 거짓이 되어 끝났다 = max_entries 도달.
        #   break 로 끝난 경우(끝 블록·크기 초과)는 여기 안 온다.
        truncated = True

    return {"ok": True, "format": "tar", "entries": entries,
            "truncated": truncated, "detail": ""}


def _zip_eocd(tail: bytes, tail_at: int) -> tuple[int, int] | None:
    """(중앙 디렉터리 offset, size). ZIP64 면 그쪽 레코드를 따라간다."""
    pos = tail.rfind(b"PK\x05\x06")
    if pos < 0 or pos + 22 > len(tail):
        return None
    cd_size, cd_off = struct.unpack_from("<II", tail, pos + 12)
    if cd_off != 0xFFFFFFFF and cd_size != 0xFFFFFFFF:
        return cd_off, cd_size
    # ZIP64: EOCD 바로 앞에 locator(PK\x06\x07)가 있고 거기 진짜 EOCD 위치가 있다.
    loc = tail.rfind(b"PK\x06\x07", 0, pos)
    if loc < 0 or loc + 16 > len(tail):
        return None
    (z64_at,) = struct.unpack_from("<Q", tail, loc + 8)
    rel = z64_at - tail_at
    if rel < 0 or rel + 56 > len(tail) or tail[rel:rel + 4] != b"PK\x06\x06":
        return None
    cd_size, cd_off = struct.unpack_from("<QQ", tail, rel + 40)
    return cd_off, cd_size


def zip_index(reader: Reader, *, size: int, max_entries: int = 200) -> dict[str, Any]:
    """zip 중앙 디렉터리(꼬리)에서 목차를 만든다."""
    if size <= 0:
        return {"ok": False, "format": "zip", "entries": [], "detail": "크기 미상"}
    tail_at = max(0, size - _ZIP_TAIL)
    tail = reader(tail_at, min(_ZIP_TAIL, size))
    if not tail:
        return {"ok": False, "format": "zip", "entries": [], "detail": "꼬리 읽기 실패"}

    found = _zip_eocd(tail, tail_at)
    if found is None:
        return {"ok": False, "format": "zip", "entries": [],
                "detail": "EOCD 를 못 찾았다 — zip 이 아니거나 분할 아카이브다"}
    cd_off, cd_size = found
    # ★ 중앙 디렉터리 **전체**를 당기지 않는다. 실측 2026-08-27: 59.8GB zip 에서 CD 가
    #   4MB 였고, 25개만 볼 건데 4MB 를 전송했다. 엔트리 하나는 헤더 46B + 이름이라
    #   512B 면 넉넉하다 — 모자라면 아래에서 truncated 로 말한다.
    want = min(cd_size, max(64 * 1024, max_entries * 512 + 4096), RANGE_CAP)
    cd = reader(cd_off, want) if cd_size else b""
    if not cd:
        return {"ok": False, "format": "zip", "entries": [],
                "detail": f"중앙 디렉터리 읽기 실패 (offset={cd_off}, size={cd_size})"}

    entries: list[dict[str, Any]] = []
    p = 0
    truncated = False
    while p + 46 <= len(cd) and cd[p:p + 4] == b"PK\x01\x02":
        (method,) = struct.unpack_from("<H", cd, p + 10)
        comp, uncomp = struct.unpack_from("<II", cd, p + 20)
        n_len, e_len, c_len = struct.unpack_from("<HHH", cd, p + 28)
        (lh_off,) = struct.unpack_from("<I", cd, p + 42)
        name = cd[p + 46: p + 46 + n_len].decode("utf-8", "replace")
        if len(entries) >= max_entries:
            truncated = True
            break
        entries.append({
            "name": name,
            "size": uncomp,
            "compressed": comp,
            "kind": "dir" if name.endswith("/") else "file",
            # ⚠️ 이건 **로컬 헤더** 위치지 데이터 위치가 아니다. 로컬 헤더의 이름/extra
            #    길이는 중앙 디렉터리의 것과 **다를 수 있어서**(spec 이 허용한다),
            #    데이터 오프셋은 로컬 헤더를 실제로 읽어야 안다. `read_member` 가 한다.
            "header_offset": lh_off,
            "method": _ZIP_METHODS.get(method, f"unsupported:{method}"),
        })
        p += 46 + n_len + e_len + c_len
    # 읽은 창이 CD 전체보다 짧으면 남은 엔트리가 있다 — 잘랐다고 말한다.
    if not truncated and len(cd) < cd_size:
        truncated = True
    return {"ok": True, "format": "zip", "entries": entries,
            "truncated": truncated, "detail": ""}


#: 목차를 낼 수 있는 확장자 → 파서.
_PARSERS = {"tar": tar_index, "zip": zip_index}
#: 압축 컨테이너라 **앞에서부터 풀어야** 목차가 나오는 것들. 사유를 명시한다.
_UNSUPPORTED = {
    "gz": "gzip 스트림은 앞에서부터 풀지 않으면 목차가 없다 — 부분 읽기로는 원리적으로 불가",
    "tgz": "gzip 스트림은 앞에서부터 풀지 않으면 목차가 없다 — 부분 읽기로는 원리적으로 불가",
    "bz2": "bzip2 스트림은 부분 읽기로 목차를 못 낸다",
    "xz": "xz 스트림은 부분 읽기로 목차를 못 낸다",
    "7z": "7z 헤더 파서 미구현 — 지원한다고 말하지 않는다",
    "rar": "rar 헤더 파서 미구현 — 지원한다고 말하지 않는다",
    "cab": "cab 헤더 파서 미구현 — 지원한다고 말하지 않는다",
    "iso": "iso9660 파서 미구현 — 지원한다고 말하지 않는다",
}


def archive_kind(path: str) -> str:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    if path.lower().endswith(".tar.gz") or path.lower().endswith(".tar.bz2"):
        return "tgz"
    return ext


def can_index(path: str) -> tuple[bool, str]:
    """목차를 낼 수 있는 형식인가. → (가능, 못 하면 사유).

    ★ 세션을 열기 **전에** 물어본다. 못 할 것을 알면서 로그인하면 lockout 예산만 먹는다.
    """
    kind = archive_kind(path)
    if kind in _UNSUPPORTED:
        return False, _UNSUPPORTED[kind]
    if kind not in _PARSERS:
        return False, f"목차를 낼 수 있는 형식이 아니다(.{kind or '확장자없음'})"
    return True, ""


def index_archive(
    path: str, reader: Reader, *, size: int, max_entries: int = 200,
) -> dict[str, Any]:
    """확장자로 파서를 고르고 목차를 만든다. 못 하는 형식은 사유를 돌려준다."""
    kind = archive_kind(path)
    ok, why = can_index(path)
    if not ok:
        return {"ok": False, "format": kind or "?", "entries": [], "detail": why}
    return _PARSERS[kind](reader, size=size, max_entries=max_entries)


#: zip 압축 방식 코드 → 우리가 풀 수 있는 이름. 나머지는 `unsupported:<코드>` 로 남긴다.
_ZIP_METHODS = {0: "store", 8: "deflate"}

#: 멤버 하나를 꺼낼 때의 상한. 아카이브 안 파일이 크면 그것도 통째로 안 받는다.
MEMBER_READ_CAP = 4 * 1024 * 1024


def read_member(
    reader: Reader, entry: dict[str, Any], *, max_bytes: int = MEMBER_READ_CAP,
) -> tuple[bytes | None, str]:
    """아카이브 안 파일 **하나**를 꺼낸다 → (bytes, 사유).

    ★ 이게 목차와 다른 점: 목차는 "무슨 파일인지" 만 답했다. 이건 그 안을 본다.
      아카이브 전체를 받지 않는다 — 그 멤버가 있는 구간만 읽는다.

    ⚠️ `bytes=None` 은 **못 꺼냈다**는 뜻이고 사유가 따라온다. 빈 파일(`b""`)과 다르다.
    """
    kind = str(entry.get("kind") or "file")
    if kind != "file":
        return None, "디렉터리 엔트리라 본문이 없다"
    size = int(entry.get("size") or 0)
    if size <= 0:
        return b"", ""
    method = str(entry.get("method") or "")

    # tar — 헤더 바로 뒤가 본문이고 무압축이다.
    if "offset" in entry:
        want = min(size, max_bytes)
        data = reader(int(entry["offset"]), want)
        if data is None:
            return None, "멤버 구간 읽기 실패"
        return data, ("상한까지만 읽었다" if size > max_bytes else "")

    # zip — 로컬 헤더를 먼저 읽어 **실제** 데이터 시작점을 구한다.
    if "header_offset" not in entry:
        return None, "이 엔트리에는 위치 정보가 없다"
    if method.startswith("unsupported"):
        return None, f"지원하지 않는 압축 방식({method.split(':', 1)[1]})"

    head = reader(int(entry["header_offset"]), 30)
    if head is None or len(head) < 30 or head[:4] != b"PK\x03\x04":
        return None, "로컬 헤더를 못 읽었다(분할 아카이브이거나 오프셋이 어긋났다)"
    n_len, e_len = struct.unpack_from("<HH", head, 26)
    data_at = int(entry["header_offset"]) + 30 + n_len + e_len
    comp = int(entry.get("compressed") or 0) or size

    if method == "store":
        data = reader(data_at, min(comp, max_bytes))
        if data is None:
            return None, "멤버 구간 읽기 실패"
        return data, ("상한까지만 읽었다" if comp > max_bytes else "")

    # deflate — 압축 구간을 읽어 스트리밍 해제한다. 풀린 크기가 상한을 넘으면 거기서 끊는다
    # (zip 폭탄 방어: 압축비가 1000:1 이면 4MB 가 4GB 가 된다).
    import zlib

    raw = reader(data_at, min(comp, max_bytes))
    if raw is None:
        return None, "멤버 구간 읽기 실패"
    try:
        out = zlib.decompressobj(-15).decompress(raw, max_bytes)
    except zlib.error as e:  # noqa: BLE001
        return None, f"압축 해제 실패: {e}"
    partial = comp > max_bytes or len(out) >= max_bytes
    return out, ("상한까지만 풀었다" if partial else "")
