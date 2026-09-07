"""confluence space_key 파서 — 게이트웨이와 **같은 형식**을 읽어야 한다.

## 왜 이 파일이 있는가

`reporter.space_key_from_finding` 이 신형 URL `/spaces/KEY` 를 몰라서 신규 finding 의
space_key 가 전부 `unknown` 이 됐고, `sync_report_threads` 가 `skipped_unknown_scope` 로
버려 **리포트 스레드가 0행**이었다(실측 2026-08-23: finding 10건 중 5건).

★ 그런데 게이트웨이(`digisecu-employee/gateway/.../domains.py` 의 `SRC_EXPR["confluence"]`)는
  `/spaces/([^/]+)` 하나로 **10/10 을 이미 읽고 있었다** — 구형 표기도 URL 부분에
  `/spaces/KEY` 를 포함하기 때문이다(`confluence:DSSOC:https://.../spaces/DSSOC`).
  즉 게이트웨이는 멀쩡했고 **리포터만 어긋나 있었다.** 같은 개념을 두 곳에 적으면
  이렇게 한쪽만 낡는다 — 개인키 armor 정규식에서 똑같이 당했다.
  여기서는 **형식 목록과 양쪽 일치를 테스트로 고정**한다.
"""
from __future__ import annotations

import pytest

from domains.services.confluence.application.reporter import space_key_from_finding

#: 게이트웨이 SRC_EXPR 및 실측 asset 형식. 새 형식이 생기면 **양쪽을 같이** 고친다.
_CASES = [
    # 신형 Confluence URL — 게이트웨이가 이미 읽던 것
    ("https://confluence.samsungds.net/spaces/TPYE/pages/393447", "TPYE"),
    ("https://confluence.samsungds.net/spaces/4SEASON", "4SEASON"),
    ("https://confluence.samsungds.net/spaces/bizinnovation/pages/1/x", "bizinnovation"),
    # 구형 내부 표기
    ("confluence:SSIRAITF:https://confluence.samsungds.net/x", "SSIRAITF"),
    # 레거시 Confluence URL
    ("https://confluence.samsungds.net/display/ITINFO/Page+Title", "ITINFO"),
]


@pytest.mark.parametrize("asset,expected", _CASES)
def test_every_known_asset_shape_yields_a_space_key(asset, expected):
    assert space_key_from_finding({"asset": asset, "extra": {}}) == expected


def test_metadata_space_key_wins():
    """워커가 명시로 준 값이 URL 파싱보다 우선이다."""
    row = {"asset": "https://confluence.samsungds.net/spaces/TPYE",
           "extra": {"metadata": {"space_key": "EXPLICIT"}}}
    assert space_key_from_finding(row) == "EXPLICIT"


def test_unparseable_asset_is_unknown_not_a_guess():
    """모르면 `unknown` 이다 — 추측한 키로 스레드를 만들면 남의 스페이스에 붙는다."""
    assert space_key_from_finding({"asset": "https://example.com/nothing", "extra": {}}) == "unknown"


def test_space_key_matches_gateway_parser():
    """★ 게이트웨이 `SRC_EXPR["confluence"]` 와 **같은 형식**을 읽는지 대조.

    게이트웨이는 별도 저장소(digisecu-employee)라 import 할 수 없다. 그 정규식을 여기 적어
    두고 두 구현이 같은 답을 내는지 본다 — 한쪽만 고치면 이 테스트가 먼저 깨진다."""
    import re
    gateway_re = re.compile(r"/spaces/([^/]+)")   # SRC_EXPR["confluence"] 미러
    for asset, expected in _CASES:
        m = gateway_re.search(asset)
        if m is None:
            # 게이트웨이가 못 읽는 형식(예: /display/) — 리포터만 아는 게 정상이다.
            assert space_key_from_finding({"asset": asset, "extra": {}}) == expected
            continue
        # 둘 다 읽는 형식이면 **같은 답**이어야 한다.
        assert m.group(1) == expected, f"{asset}: 게이트웨이={m.group(1)} 기대={expected}"
        assert space_key_from_finding({"asset": asset, "extra": {}}) == m.group(1), (
            f"{asset}: 리포터가 게이트웨이와 다른 답을 낸다")
