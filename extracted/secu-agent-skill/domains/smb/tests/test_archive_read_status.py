"""아카이브 reader 가 실패 사유를 버리지 않는다.

배경 (2026-08-27~28 실측): `smb_archive_index` 는 8/27 하루에 완료 22건이 **전부**
`outcome=success` 로 찍혔는데 그중 21건이 `entry_count:0`, `bytes_transferred:0`,
`reads:0`, `detail:"offset 0 읽기 실패"` 였다. **왜** 못 읽었는지는 어디에도 없었다 —
reader 가 denied·not_found·error 를 전부 `None` 한 가지로 뭉갰기 때문이다.

이건 단순한 계측 누락이 아니다. 워커 계약(`smb_task/worker.md`)이 "목차를 **인용한 뒤**
`smb_archive_scan`" 순서를 요구하므로, **목차 실패 하나가 tar 안을 여는 경로 전체를
봉쇄한다.** 실측 8/27: `smb_archive_scan` 0회 · `smb_inspect_image` 0회.

같은 파일의 `smb_scan_share` 는 이미 `by_status` 로 사유를 세고 있다 — 그 전례를 따랐다.
사유가 남아야 "읽기 권한 문제인가, 파일이 없는 건가" 를 가릴 수 있고, 그게 안 되면
다음 수정(`desiredAccess`)을 **측정할 방법이 없다.**
"""
from __future__ import annotations

import ast
import pathlib

import pytest

_ROOT = pathlib.Path(__file__).resolve().parents[3]
_SOURCES = (
    "domains/smb/plugin/tools/smb_scan_tools.py",
    "domains/smb/plugin/tools/inspect_tools.py",
)


def _source(rel: str) -> str:
    return (_ROOT / rel).read_text(encoding="utf-8")


@pytest.mark.parametrize("rel", _SOURCES)
def test_every_range_reader_records_why_it_failed(rel: str) -> None:
    """`read_range_on` 을 쓰는 reader 는 실패 사유를 세고 나서 None 을 돌려준다.

    ⚠️ 여기서 세는 것은 **reader 클로저의 개수**다. 새 reader 를 추가하면서 사유
       기록을 빼먹으면 이 테스트가 잡는다 — 같은 결함이 이미 세 곳에 복제돼 있었다.
    """
    source = _source(rel)
    tree = ast.parse(source)

    readers = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "reader"
    ]
    assert readers, f"{rel}: reader 클로저를 못 찾았다 — 이름이 바뀌었으면 이 테스트도 고쳐라"

    for reader in readers:
        body = ast.get_source_segment(source, reader) or ""
        assert "read_range_on" in body, f"{rel}: reader 가 read_range_on 을 안 쓴다"
        assert "read_status[" in body, (
            f"{rel}:{reader.lineno} reader 가 실패 사유를 버린다 — "
            "denied/not_found/error 가 None 한 가지로 뭉개진다"
        )


@pytest.mark.parametrize("rel", _SOURCES)
def test_read_status_reaches_the_return_payload(rel: str) -> None:
    """세기만 하고 안 실어 보내면 증거에 안 남는다 — 이 저장소의 반복된 실패다."""
    source = _source(rel)
    assert '"read_status"' in source, f"{rel}: read_status 를 반환에 안 싣는다"


def test_archive_scan_reports_read_status_even_when_the_index_fails() -> None:
    """★ 목차 실패로 **조기 반환**하는 자리가 진짜 중요한 곳이다.

    실측 21/22 가 그 경로였고, 거기서 사유가 안 나오면 아무것도 못 잰다.
    """
    source = _source("domains/smb/plugin/tools/smb_scan_tools.py")
    marker = 'if not idx.get("ok"):'
    assert marker in source
    early_return = source.split(marker, 1)[1][:600]
    assert '"read_status"' in early_return, (
        "목차 실패 조기 반환이 read_status 를 안 싣는다 — "
        "tar 경로 전체를 막는 바로 그 지점이다"
    )


def test_counting_is_derived_from_the_status_not_reported_by_the_caller() -> None:
    """사유는 `read_range_on` 이 돌려준 status 로 센다 — 자기신고가 아니다.

    이 저장소는 자기신고 지표에 반복해서 속았다(`archive_index` 22/22 success 인데
    21건이 0바이트, `report_inspection` 145회 중 `files_seen` 전달 0회).
    """
    source = _source("domains/smb/plugin/tools/smb_scan_tools.py")
    assert "read_status[str(status)] = read_status.get(str(status), 0) + 1" in source
