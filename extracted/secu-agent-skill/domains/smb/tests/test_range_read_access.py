"""범위 읽기는 **읽기 권한만** 요구한다.

## 왜 (2026-08-28 라이브 프로브로 확정)

impacket 의 `openFile` 기본값은 `desiredAccess=3` =
`FILE_READ_DATA(1) | FILE_WRITE_DATA(2)` 다. 우리는 그 인자를 안 넘겨서 범위 읽기를
할 때마다 **쓰기 권한까지 함께** 요구했고, 읽기전용 공유가 그걸 거부했다.

    openFile(tid, path)                    → STATUS_ACCESS_DENIED (0xc0000022)
    openFile(tid, path, desiredAccess=1)   → OK, 512 bytes

두 대상(12.98.34.139 / 12.56.23.54, 둘 다 SMSSIG$ 의 .tar)에서 동일하게 재현됐고,
수정 후 같은 대상의 tar 목차가 실제로 읽혔다(ok=True, 항목 16개, 655KB만 전송).

## 무엇을 막고 있었나

`smb_archive_index` 는 완료 44건이 **전부 `outcome=success`** 로 찍혔는데 본문은
**44건 전부 `ok=false`**, 그중 41건이 "offset 0 읽기 실패" 였다. 아무도 본문을
안 읽었으므로 성공으로 집계됐다.

그리고 워커 계약(`smb_task/worker.md`)이 "목차를 **인용한 뒤** `smb_archive_scan`"
순서를 요구하므로, 목차 실패 하나가 그 뒤 경로 전체를 봉쇄했다:

    smb_archive_scan   8/27 호출 0회      tar          34,069건
    smb_inspect_image  8/27 호출 0회      이미지      170,284건

⚠️ 이 파이프라인은 **아무것도 쓰지 않는다**(읽기전용 불변식). 쓰기 권한을 요구할
   이유가 애초에 없었다.
"""
from __future__ import annotations

import inspect

from domains.smb.plugin.agent_types import smb


def test_range_read_asks_for_read_access_only():
    """★ 이 한 줄이 tar·이미지 20만 4천 건으로 가는 길을 막고 있었다."""
    src = inspect.getsource(smb.read_range_on)
    assert "desiredAccess=_FILE_READ_DATA" in src, (
        "openFile 이 desiredAccess 를 안 주면 impacket 기본값 3(읽기+쓰기)이 나가고 "
        "읽기전용 공유가 거부한다"
    )


def test_the_constant_is_the_read_bit_only():
    assert smb._FILE_READ_DATA == 0x00000001
    assert smb._FILE_READ_DATA & smb._FILE_WRITE_DATA == 0, "쓰기 비트가 섞이면 안 된다"


def test_impacket_default_would_still_ask_for_write():
    """의존 라이브러리의 기본값이 바뀌면 이 테스트가 먼저 알려준다.

    기본값이 읽기 전용으로 바뀌면 우리 인자는 무해한 중복이 되고, 지금처럼
    읽기+쓰기면 인자를 계속 넘겨야 한다.
    """
    from impacket.smbconnection import SMBConnection

    default = inspect.signature(SMBConnection.openFile).parameters["desiredAccess"].default
    assert default == 3, (
        f"impacket openFile 기본 desiredAccess 가 {default} 로 바뀌었다 — "
        "read_range_on 의 명시 인자가 여전히 필요한지 다시 보라"
    )


def test_no_other_openfile_call_site_slipped_in():
    """호출부가 하나뿐이라는 사실이 이 수정의 완결성 근거다."""
    import pathlib

    src = pathlib.Path(smb.__file__).read_text(encoding="utf-8")
    assert src.count("conn.openFile(") == 1, (
        "openFile 호출부가 늘었다 — 새 자리도 읽기 권한만 요구하는지 확인하라"
    )
