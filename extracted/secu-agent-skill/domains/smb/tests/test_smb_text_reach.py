"""파일을 **열 수 있게** 하는 세 배선 — 확장자·UTF-16·못 읽은 것의 단서.

## 왜 (2026-08-29 실측, 라이브 smb_file 전수)

    확장자 화이트리스트 밖              1,622건   전부 is_text_candidate=0
      config 476 · frm 330 · asp 294 · inc 189 · cs 81 · reg 75 · bas 60 · vbs 51
    skipped:binary                      2,814건   그중 .ini 282 · .txt 52 는 UTF-16
    이름은 의심인데 본문을 못 본 파일   32,555건   아무 데도 안 나타났다

`MDbS/dbLink.bas` 안의 MSSQL `sa` 평문은 4대(12.98.64.103/105/107/119)에 똑같이
있는데 `.105`/`.119` 만 finding 이 있다 — 그 둘은 LLM 검토원이 우연히 열었을 뿐,
코드는 넷 다 못 봤다. `.bas` 가 목록에 없어서다.
"""
from __future__ import annotations

import pytest

from domains.smb.plugin.agent_types import smb as m


# ── ① 확장자: 실제로 존재하는데 한 번도 안 열린 것들 ────────────────────────

@pytest.mark.parametrize("name", [
    "dbLink.bas", "frm_Part_History.frm", "mySingle.Messenger.App.Updater.exe.config",
    "class.User.asp", "Sconfig_01.aspx", "Settings.Designer.cs",
    "install.vbs", "conn.inc", "NGSRegBackup.reg", "db.udl",
])
def test_files_that_actually_exist_on_shares_are_text_candidates(name):
    assert m._is_text_candidate(name), f"{name} 이 큐에 못 들어간다"


@pytest.mark.parametrize("name", ["a.dll", "a.exe", "a.pyd", "a.jpg", "a.pfx", "a.p12"])
def test_binaries_and_keystores_stay_out_of_the_text_queue(name):
    """★ 키스토어(pfx/p12)는 **텍스트가 아니다** — 이름 축(단서)으로 다뤄야 한다.

    텍스트 큐에 넣으면 매번 열어서 binary 로 종결시킨다.
    """
    assert not m._is_text_candidate(name)


# ── ② UTF-16: NUL 휴리스틱이 텍스트를 binary 로 종결시키던 자리 ─────────────

_REG = ("Windows Registry Editor Version 5.00\r\n\r\n"
        "[HKLM\\SOFTWARE\\App]\r\n\"Password\"=\"P@ssw0rd!\"\r\n")


@pytest.mark.parametrize(("label", "raw"), [
    ("utf16le+BOM", b"\xff\xfe" + _REG.encode("utf-16-le")),
    ("utf16be+BOM", b"\xfe\xff" + _REG.encode("utf-16-be")),
    ("utf16le, BOM 없음", _REG.encode("utf-16-le")),
])
def test_utf16_is_text_not_binary(label, raw):
    status, body = m._classify_fetched("app.reg", raw)
    assert status == "text", f"{label}: {body[:60]}"
    assert "P@ssw0rd!" in body, label


@pytest.mark.parametrize(("label", "raw"), [
    ("png", b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 40),
    ("mz", b"MZ\x90\x00\x03\x00\x00\x00" + b"\x00" * 200 + bytes(range(256)) * 20),
    ("utf32le BOM", b"\xff\xfe\x00\x00" + "hi".encode("utf-32-le")[4:] + b"\x00" * 40),
])
def test_real_binaries_are_still_binary(label, raw):
    assert m._classify_fetched("x.dat", raw)[0] == "binary", label


def test_truncated_utf16_does_not_explode():
    """앞부분만 읽으면 코드유닛 한가운데가 잘린다 — 홀수 바이트를 버린다."""
    raw = (b"\xff\xfe" + _REG.encode("utf-16-le"))[:51]
    status, body = m._classify_fetched("app.reg", raw)
    assert status == "text"
    assert body.startswith("Windows Registry Editor")


def test_utf16_sniff_needs_the_other_side_to_be_clean():
    """★ 한쪽 자리가 NUL 이라는 것만으로 UTF-16 이라고 하면 바이너리를 삼킨다."""
    noisy = bytes(b for i in range(2000) for b in (i % 251, 0 if i % 3 else 7))
    assert m._decode_utf16(noisy) is None
