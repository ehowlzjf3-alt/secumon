"""agent_verification — **4도메인 동일 계약** (사용자 결정 2026-08-30).

## 왜 이 파일이 있나

표식과 게이트가 **다른 자리**에 있어서 조합이 어긋나 있었다. 실측 2026-08-30:

    표식 O + 게이트 O   confluence   정상 19/19
    표식 X + 게이트 O   github       268개 대상이 스레드 없이 영구 차단   ★ 사고
    표식 O + 게이트 X   dev_web      게이트가 무의미 (45/45 통과)
    표식 X + 게이트 X   smb          게이트 없음 (24/24)

github finding 294건 중 표식이 있는 건 7건뿐이었고, 보고 패스는 매 tick
`skipped_unverified: 287` 을 찍고 있었다. 그 숫자는 `pipeline_run.detail` 에만 남아
화면 어디에도 없었다 — 몇 주간 아무도 몰랐다.

표식의 뜻은 "검증했다" 가 아니라 **"에이전트가 제출 도구로 냈다"** 이다. 표식 없는
294건도 `evidence_judgment`·`risk_narrative`·`task_id` 를 갖고 있었다 = 코어
`submit_finding` 을 거쳐 온 것이다. 즉 경로가 다른 게 아니라 **표식만 빠져 있었다.**
"""
from __future__ import annotations

import pathlib

import pytest

_TOOLS = {
    "smb": "domains/smb/plugin/tools/smb_submit_finding_tool.py",
    "dev_web": "domains/dev_web/plugin/tools/dev_web_submit_finding_tool.py",
    "github": "domains/services/github/plugin/tools/github_submit_finding_tool.py",
    "confluence": "domains/services/confluence/plugin/tools/confluence_submit_finding_tool.py",
}


@pytest.mark.parametrize("domain", sorted(_TOOLS))
def test_every_submit_tool_stamps_agent_verification(domain):
    """★ 네 도메인 **전부** 표식을 단다. 하나라도 빠지면 위 표가 다시 생긴다."""
    src = pathlib.Path(_TOOLS[domain]).read_text(encoding="utf-8")
    assert (
        "make_agent_verification" in src or "stamp_agent_verification" in src
    ), f"{domain} 제출 도구가 agent_verification 을 안 단다"


def test_the_marker_contract_requires_method_and_source():
    """표식은 **무엇으로 확인했나**(method)와 **누가 냈나**(source)를 요구한다.

    셋 중 하나라도 비면 게이트가 통과시키지 않는다 — 빈 표식으로 게이트를 여는 것을 막는다.
    """
    from service.services.finding_verification import (
        is_agent_verified_extra,
        make_agent_verification,
    )

    ok = {"agent_verification": make_agent_verification(method="m", source="s")}
    assert is_agent_verified_extra(ok)

    for bad in (
        {"agent_verification": make_agent_verification(method="", source="s")},
        {"agent_verification": make_agent_verification(method="m", source="")},
        {"agent_verification": {"status": "verified"}},
        {"agent_verification": "verified"},
        {},
        None,
    ):
        assert not is_agent_verified_extra(bad), bad


def test_shared_helper_exists_so_domains_do_not_reimplement():
    """⚠️ 도메인마다 따로 구현하면 조합 표가 다시 생긴다 — 한 함수로 모은다."""
    from service.services import finding_verification as fv

    assert callable(getattr(fv, "stamp_agent_verification", None))


# ── 게이트 2층: 스코프 ──────────────────────────────────────────────────────

@pytest.mark.parametrize(("asset", "expected"), [
    # ⚠️ asset 형태가 **둘**이다. 실측 2026-08-30(라이브 301건):
    #    https://... 294건 · github:... 7건. 한쪽만 벗기면 나머지가 통째로 "unknown" 이
    #    되어 보고 패스가 조용히 버린다(`skipped_unknown_scope: 294` 로 나타났다).
    ("https://github.samsungds.net/RTPMS/delaylotautonomous/commit/abc",
     "RTPMS/delaylotautonomous"),
    ("https://github.samsungds.net/EES-TC/dp/blob/main/.env", "EES-TC/dp"),
    ("github:MI-CD-Memory/CD-RAC/commit/xyz", "MI-CD-Memory/CD-RAC"),
    ("github:org/repo", "org/repo"),
])
def test_repo_scope_handles_both_asset_shapes(asset, expected):
    from domains.services.github.application.scanner import repo_from_finding

    assert repo_from_finding({"asset": asset}) == expected


@pytest.mark.parametrize("asset", [
    "", "https://github.samsungds.net/", "https://github.samsungds.net/onlyorg",
    "smb://host/share", "not-a-url",
])
def test_repo_scope_says_unknown_rather_than_guessing(asset):
    """★ 못 정하면 "unknown" 이다 — 반쪽짜리 스코프로 스레드를 만들면 남의 저장소에 붙는다."""
    from domains.services.github.application.scanner import repo_from_finding

    assert repo_from_finding({"asset": asset}) == "unknown"


def test_metadata_repo_wins_over_asset():
    from domains.services.github.application.scanner import repo_from_finding

    row = {"extra": {"metadata": {"repo": "a/b"}}, "asset": "https://x/y/z"}
    assert repo_from_finding(row) == "a/b"
