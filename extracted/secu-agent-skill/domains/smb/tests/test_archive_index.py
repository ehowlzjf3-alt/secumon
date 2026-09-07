"""아카이브 목차 파서 — 진짜 tar/zip 바이트로 검사한다.

손으로 만든 픽스처를 쓰지 않는다. `tarfile`/`zipfile` 이 쓴 바이트를 파서에 먹인다 —
우리가 상상한 포맷이 아니라 실제 포맷을 읽는지가 요점이다.
"""
from __future__ import annotations

import io
import tarfile
import zipfile

import pytest

from domains.smb.plugin import archive_index as ai


def _reader(blob: bytes):
    """SMB ranged read 흉내. 파일 끝 너머는 짧게 돌려준다(실제 readFile 과 같다)."""
    def read(offset: int, length: int) -> bytes | None:
        if offset < 0 or offset >= len(blob):
            return b""
        return blob[offset: offset + length]
    return read


def _make_tar(names_sizes, *, fmt=tarfile.GNU_FORMAT) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=fmt) as tf:
        for name, size in names_sizes:
            info = tarfile.TarInfo(name)
            info.size = size
            tf.addfile(info, io.BytesIO(b"x" * size))
    return buf.getvalue()


def _make_zip(names_sizes, *, stored: bool = False) -> bytes:
    buf = io.BytesIO()
    mode = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(buf, "w", mode) as zf:
        for name, size in names_sizes:
            zf.writestr(name, b"y" * size)
    return buf.getvalue()


# ── tar ──────────────────────────────────────────────────────────────────────

def test_tar_index_reads_names_and_sizes():
    blob = _make_tar([("pkg/setup.ini", 120), ("pkg/deploy.xml", 4096)])
    out = ai.index_archive("x.tar", _reader(blob), size=len(blob))
    assert out["ok"] is True and out["format"] == "tar"
    got = {e["name"]: e["size"] for e in out["entries"]}
    assert got == {"pkg/setup.ini": 120, "pkg/deploy.xml": 4096}


def test_tar_skips_member_bodies_without_reading_them():
    """★ 요점: 130MB 멤버를 건너뛸 때 그 바이트를 당기지 않는다."""
    big = 3 * 1024 * 1024
    blob = _make_tar([("huge.bin", big), ("after.txt", 10)])
    pulled = 0
    base = _reader(blob)

    def counting(offset: int, length: int):
        nonlocal pulled
        data = base(offset, length)
        pulled += len(data or b"")
        return data

    out = ai.index_archive("x.tar", counting, size=len(blob))
    assert [e["name"] for e in out["entries"]] == ["huge.bin", "after.txt"]
    # 멤버 본문(3MB)의 1/10 도 안 당겨야 한다. 창(64KB) 두어 번이면 충분하다.
    assert pulled < big // 10, f"{pulled} bytes 를 당겼다 — 건너뛰기가 안 되고 있다"


def test_tar_long_gnu_name():
    long_name = "deep/" * 25 + "config.ini"   # 100자 헤더 필드를 넘긴다
    blob = _make_tar([(long_name, 8)])
    out = ai.index_archive("x.tar", _reader(blob), size=len(blob))
    assert [e["name"] for e in out["entries"]] == [long_name]


def test_tar_pax_prefix_name():
    """POSIX(pax)/ustar prefix 분할 이름도 이어 붙인다."""
    long_name = "a" * 80 + "/" + "b" * 60 + "/c.txt"
    blob = _make_tar([(long_name, 4)], fmt=tarfile.USTAR_FORMAT)
    out = ai.index_archive("x.tar", _reader(blob), size=len(blob))
    assert out["ok"] is True
    assert [e["name"] for e in out["entries"]] == [long_name]


def test_tar_max_entries_says_it_truncated():
    blob = _make_tar([(f"f{i}.txt", 1) for i in range(20)])
    out = ai.index_archive("x.tar", _reader(blob), size=len(blob), max_entries=5)
    assert len(out["entries"]) == 5
    assert out["truncated"] is True, "잘랐으면 잘랐다고 말해야 한다"


def test_tar_complete_index_is_not_marked_truncated():
    blob = _make_tar([("a.txt", 1), ("b.txt", 1)])
    out = ai.index_archive("x.tar", _reader(blob), size=len(blob), max_entries=50)
    assert out["truncated"] is False


def test_not_a_tar_is_reported_not_guessed():
    out = ai.index_archive("x.tar", _reader(b"not a tar at all" * 100), size=1600)
    assert out["ok"] is False
    assert "ustar" in out["detail"]


def test_read_failure_is_not_an_empty_archive():
    """★ None(못 읽음)과 b''(끝)은 다르다. 섞으면 읽기 실패가 '빈 아카이브'로 보인다."""
    out = ai.index_archive("x.tar", lambda o, n: None, size=4096)
    assert out["ok"] is False and out["entries"] == []


# ── zip ──────────────────────────────────────────────────────────────────────

def test_zip_index_reads_central_directory():
    blob = _make_zip([("app/web.config", 300), ("app/readme.md", 50)])
    out = ai.index_archive("x.zip", _reader(blob), size=len(blob))
    assert out["ok"] is True and out["format"] == "zip"
    got = {e["name"]: e["size"] for e in out["entries"]}
    assert got == {"app/web.config": 300, "app/readme.md": 50}


def test_zip_reads_only_the_tail():
    """중앙 디렉터리는 꼬리에 있다 — 앞쪽 본문을 당기면 안 된다."""
    # ⚠️ DEFLATE 는 반복 바이트를 거의 0 으로 줄인다 — 처음에 그렇게 썼다가 zip 전체가
    #    4KB 로 나와 "꼬리만 읽었다" 가 자동으로 참이 되는 무의미한 테스트가 됐다.
    #    무압축(STORED)으로 실제 크기를 만든다.
    blob = _make_zip([(f"f{i}.txt", 4096) for i in range(40)], stored=True)
    lowest = len(blob)
    base = _reader(blob)

    def watching(offset: int, length: int):
        nonlocal lowest
        lowest = min(lowest, offset)
        return base(offset, length)

    out = ai.index_archive("x.zip", watching, size=len(blob))
    assert out["ok"] is True and len(out["entries"]) == 40
    # 파일이 꼬리창(66KB)보다 커야 이 단언이 의미가 있다.
    assert len(blob) > 66 * 1024
    assert lowest > 0, "offset 0 을 읽었다 — 꼬리만 읽는다는 주장이 거짓이다"


def test_zip_not_a_zip():
    out = ai.index_archive("x.zip", _reader(b"\x00" * 5000), size=5000)
    assert out["ok"] is False and "EOCD" in out["detail"]


# ── 못 하는 것 ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("path", ["a.tar.gz", "a.tgz", "a.7z", "a.rar", "a.cab", "a.iso"])
def test_unsupported_formats_say_why(path):
    out = ai.index_archive(path, _reader(b""), size=100)
    assert out["ok"] is False
    assert out["detail"], f"{path}: 사유 없이 실패하면 '빈 아카이브'와 구분이 안 된다"
    assert out["entries"] == []


def test_gzip_reason_names_the_real_limit():
    out = ai.index_archive("a.tar.gz", _reader(b""), size=100)
    assert "원리적으로 불가" in out["detail"]


# ── 멤버 추출 — 목차에서 그친 것을 안까지 본다 ─────────────────────────────

_SECRET = b"db.password=Sup3rS3cretP@ssw0rd!\n"


def _counting(blob: bytes):
    """읽은 바이트 총량을 세는 reader."""
    base = _reader(blob)
    pulled = {"bytes": 0}

    def read(offset: int, length: int):
        data = base(offset, length)
        pulled["bytes"] += len(data or b"")
        return data
    return read, pulled


def test_tar_member_is_read_without_pulling_the_archive():
    """★ 요점: 멤버 하나를 꺼내는데 아카이브 전체를 받지 않는다."""
    big = 3 * 1024 * 1024
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for name, data in (("padding.bin", b"x" * big), ("conf/app.ini", _SECRET)):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    blob = buf.getvalue()

    idx = ai.index_archive("x.tar", _reader(blob), size=len(blob))
    entry = next(e for e in idx["entries"] if e["name"] == "conf/app.ini")

    read, pulled = _counting(blob)
    data, note = ai.read_member(read, entry)
    assert data == _SECRET, (data, note)
    assert pulled["bytes"] < big // 10, f"{pulled['bytes']} bytes — 통째로 받았다"


@pytest.mark.parametrize("stored", [True, False])
def test_zip_member_is_read_and_inflated(stored):
    """store 도 deflate 도 꺼낸다. deflate 는 압축 구간만 읽어 푼다."""
    buf = io.BytesIO()
    mode = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(buf, "w", mode) as zf:
        zf.writestr("pad.bin", b"z" * (200 * 1024))
        zf.writestr("conf/app.ini", _SECRET)
    blob = buf.getvalue()

    idx = ai.index_archive("x.zip", _reader(blob), size=len(blob))
    entry = next(e for e in idx["entries"] if e["name"] == "conf/app.ini")
    assert entry["method"] == ("store" if stored else "deflate")

    data, note = ai.read_member(_reader(blob), entry)
    assert data == _SECRET, (data, note)


def test_zip_member_reads_local_header_not_the_central_one():
    """⚠️ 로컬 헤더의 extra 길이는 중앙 디렉터리의 것과 **다를 수 있다**.

    중앙 디렉터리 값으로 데이터 위치를 계산하면 조용히 어긋난 바이트를 읽는다.
    zipfile 이 만드는 아카이브에서 두 extra 가 실제로 다른 경우가 있어, 여기서는
    '헤더를 실제로 읽는지' 를 오프셋 접근 패턴으로 확인한다.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("conf/app.ini", _SECRET)
    blob = buf.getvalue()
    idx = ai.index_archive("x.zip", _reader(blob), size=len(blob))
    entry = idx["entries"][0]

    seen: list[tuple[int, int]] = []
    base = _reader(blob)

    def watching(offset: int, length: int):
        seen.append((offset, length))
        return base(offset, length)

    data, _ = ai.read_member(watching, entry)
    assert data == _SECRET
    assert (entry["header_offset"], 30) in seen, seen


def test_member_cap_is_reported_not_silent():
    """상한에서 끊었으면 끊었다고 말한다 — 조용히 자르면 '이게 전부' 로 읽힌다."""
    body = b"A" * 5000
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        info = tarfile.TarInfo("big.txt")
        info.size = len(body)
        tf.addfile(info, io.BytesIO(body))
    blob = buf.getvalue()
    entry = ai.index_archive("x.tar", _reader(blob), size=len(blob))["entries"][0]

    data, note = ai.read_member(_reader(blob), entry, max_bytes=1000)
    assert data is not None and len(data) == 1000
    assert note, "잘랐는데 아무 말이 없다"


def test_directory_entry_has_no_body():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        info = tarfile.TarInfo("adir/")
        info.type = tarfile.DIRTYPE
        tf.addfile(info)
    blob = buf.getvalue()
    entry = ai.index_archive("x.tar", _reader(blob), size=len(blob))["entries"][0]
    data, note = ai.read_member(_reader(blob), entry)
    assert data is None and note


def test_unsupported_zip_method_is_refused_not_guessed():
    entry = {"name": "a.bin", "size": 10, "kind": "file",
             "header_offset": 0, "method": "unsupported:93", "compressed": 5}
    data, note = ai.read_member(lambda o, n: b"\x00" * n, entry)
    assert data is None and "93" in note


def test_read_failure_is_distinguished_from_empty_member():
    """★ None(못 읽음) 과 b''(빈 파일) 은 다르다."""
    entry = {"name": "a.txt", "size": 10, "kind": "file", "offset": 512, "method": "store"}
    data, note = ai.read_member(lambda o, n: None, entry)
    assert data is None and note

    empty = {"name": "e.txt", "size": 0, "kind": "file", "offset": 512, "method": "store"}
    data2, _ = ai.read_member(lambda o, n: None, empty)
    assert data2 == b"", "빈 파일은 빈 bytes 다 — 읽기 실패가 아니다"
