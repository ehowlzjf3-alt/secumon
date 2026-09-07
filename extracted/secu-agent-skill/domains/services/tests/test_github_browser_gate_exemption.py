"""github API repo 스캔 레인의 정책 A 면제 — provenance 로만 갈린다.

## 왜 (2026-08-27 실측)

`task_type='github'` 아래에 브라우저를 쥔 SSO 레인과 브라우저가 **없는** 스캔 레인이
같이 산다. 스캔 레인은 게이트를 만족시킬 방법이 원천적으로 없어서 그날 제출 14건이
14건 다 죽었고(요구된 '호스트' 13종은 전부 github 소유자 이름이었다), 워커가 진짜
시크릿을 찾아놓고 스스로 기각했다.

## 이 테스트가 지키는 것

면제 판단을 **자산 문자열**(target/hit.location)에 두면 곧바로 게이트 우회로가 된다.
그래서 근거는 **코드가 심은 metadata** 두 개뿐이고, 둘 다 있어야 면제한다. 이 테스트는
"둘 중 하나라도 없으면 면제 안 함" 을 못 박는다 — 여기가 느슨해지면 web/dev_web 까지
같이 열린다.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from domains.services.github.plugin.browser_gate_exemption import github_api_scan_exempt

_REPO = "DataService/hue-customization"
_SCAN_LANE = {
    "_collection_mode": "api_scan",
    "_github_task_scan_status": "ok",
    "github_target": {"id": 19125, "repo": _REPO},
}


def _finding(task_type: str = "github", target: str = _REPO, location: str = ""):
    # 게이트를 못 만족시키던 바로 그 형태 — repo slug target + 맨 파일 경로 location.
    return SimpleNamespace(
        task_type=task_type,
        target=target,
        hits=[SimpleNamespace(location=location or "desktop/core/src/desktop/views.py")],
    )


def _ctx(metadata):
    return SimpleNamespace(metadata=metadata)


def test_scan_lane_with_real_scan_is_exempt():
    assert github_api_scan_exempt(_finding(), _ctx(dict(_SCAN_LANE))) is True


@pytest.mark.parametrize("metadata, why", [
    ({}, "SSO 레인 — 플래그 자체가 없다"),
    ({"_collection_mode": "api_scan", "github_target": {"repo": _REPO}},
     "스캔 레인이라 주장만 하고 스캔은 안 돌았다"),
    ({"_github_task_scan_status": "ok", "github_target": {"repo": _REPO}},
     "스캔은 돌았지만 SSO 레인이다"),
    ({"_collection_mode": "browser", "_github_task_scan_status": "ok",
      "github_target": {"repo": _REPO}}, "다른 수집 방식"),
    ({"_web_browser_hosts": ["github.samsungds.net"]},
     "브라우저 기록은 면제 근거가 아니다"),
    ({"_collection_mode": "api_scan", "_github_task_scan_status": "ok"},
     "큐가 넘긴 저장소가 없다 — 무엇을 스캔했는지 모른다"),
    ({"_collection_mode": "api_scan", "_github_task_scan_status": "ok",
      "github_target": {"repo": ""}}, "저장소 이름이 비어 있다"),
])
def test_everything_else_is_not_exempt(metadata, why):
    assert github_api_scan_exempt(_finding(), _ctx(metadata)) is False, why


def test_finding_for_a_different_repo_is_not_exempt():
    """★ repo A 를 스캔하고 repo B 의 finding 을 제출하는 것은 면제 대상이 아니다.

    큐가 워커에게 넘긴 저장소는 코드가 아는 값이다. 여기 대조하는 것은 LLM 문자열을
    **믿는** 게 아니라 **강제**하는 것이다(codex 적대검증에서 나온 구멍).
    """
    other = _finding(target="SomeoneElse/other-repo",
                     location="https://github.samsungds.net/SomeoneElse/other-repo/blob/main/x.py")
    assert github_api_scan_exempt(other, _ctx(dict(_SCAN_LANE))) is False


def test_repo_named_in_the_hit_location_is_enough():
    """target 이 URL 이고 location 만 repo 를 담아도 통과한다 — 둘 중 하나면 된다."""
    f = _finding(target="",
                 location="https://github.samsungds.net/DataService/hue-customization/blob/main/x.py")
    assert github_api_scan_exempt(f, _ctx(dict(_SCAN_LANE))) is True


def test_scan_worker_md_teaches_the_repo_bearing_shape():
    """계약이 안 가르치면 워커가 맨 경로를 쓰고 면제가 조용히 실패한다."""
    from pathlib import Path

    md = Path("domains/services/github/skills/github_scan/worker.md").read_text(encoding="utf-8")
    assert "github_submit_finding(finding={" in md, "제출 스켈레톤이 없다"
    assert "<owner>/<repo>" in md


def test_other_domains_are_never_exempt():
    """플래그를 그대로 물려받아도 다른 도메인까지 면제되면 안 된다."""
    for task_type in ("web", "dev_web", "confluence", "devops"):
        assert github_api_scan_exempt(
            _finding(task_type), _ctx(dict(_SCAN_LANE))) is False, task_type


def test_broken_context_is_not_exempt():
    """fail-closed — metadata 가 없거나 이상하면 면제하지 않는다."""
    assert github_api_scan_exempt(_finding(), SimpleNamespace()) is False
    assert github_api_scan_exempt(_finding(), _ctx(None)) is False
    assert github_api_scan_exempt(_finding(), _ctx("not-a-dict")) is False


def test_scan_worker_plants_the_provenance_flag():
    """면제의 유일한 생산자 — 여기가 빠지면 훅이 조용히 죽은 배선이 된다."""
    import inspect

    from service.agents import github_scan_worker

    src = inspect.getsource(github_scan_worker)
    assert '"_collection_mode": "api_scan"' in src, (
        "github_scan_worker 가 provenance 플래그를 안 심으면 스캔 레인 제출이 다시 전량 거부된다")


def test_bootstrap_registers_the_exemption():
    """등록이 빠지면 훅은 있고 판정자는 없는 상태가 된다."""
    import inspect

    from plugin import bootstrap

    src = inspect.getsource(bootstrap)
    assert "github_api_scan_exempt" in src
    assert "register_browser_verification_exemption" in src
