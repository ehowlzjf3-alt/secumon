"""4개 도메인 대시보드가 하트비트 **신선도**를 표시하는지 고정.

배경(2026-08-16): `pipeline_heartbeat.detail` 은 그 컴포넌트가 **마지막으로 돌았을 때의
결과 문자열**이 그대로 박혀 있는 값이다. 나이를 같이 보여주지 않으면 오래된 숫자를
오늘 결과로 읽는다.

실제로 그랬다 — github 대시보드의 `github.scan: claimed=5 scanned=5 errors=5` 를 보고
"오늘 스캔에서 5건 실패"로 읽었는데, `last_beat` 이 **25일 전**이었다. 그 시점
`github_repo_target` 에는 error 행이 하나도 없었다(전부 pending).

전수 실측: 하트비트 31개 중 **24시간 내는 5개뿐**, 26개가 낡았고 최고 45일이었다.
그런데 github·confluence 대시보드는 하트비트를 **아예 렌더링하지 않았고**, smb 도
표가 없었다. dev_web 만 표를 갖고 있었으나 alive/stale 이진 판정이라 6시간 cron 이
항상 빨갛게 보였다.

API 는 처음부터 `age_sec` 과 `alive`(600초 기준)를 정확히 내려주고 있었다 —
**빠진 것은 렌더링뿐이었다.** 그래서 이 테스트는 HTML 을 본다.
"""
from __future__ import annotations

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]

UIS = {
    "smb": ROOT / "domains/smb/webapp/ui/index.html",
    "dev_web": ROOT / "domains/dev_web/webapp/ui/index.html",
    "github": ROOT / "domains/services/github/webapp/ui/index.html",
    "confluence": ROOT / "domains/services/confluence/webapp/ui/index.html",
}


@pytest.mark.parametrize("domain", sorted(UIS))
def test_dashboard_renders_heartbeats(domain: str) -> None:
    """하트비트 표 자체가 있어야 한다 — github·confluence 는 아예 없었다."""
    html = UIS[domain].read_text(encoding="utf-8")
    assert "heartbeats" in html, f"{domain} UI 가 heartbeats 를 읽지 않는다"
    assert "Heartbeats" in html, f"{domain} UI 에 하트비트 패널이 없다"


@pytest.mark.parametrize("domain", sorted(UIS))
def test_dashboard_shows_heartbeat_age(domain: str) -> None:
    """★ 나이를 같이 보여줘야 detail 을 오늘 결과로 오독하지 않는다."""
    html = UIS[domain].read_text(encoding="utf-8")
    assert "age(h.last_beat)" in html, (
        f"{domain} UI 가 하트비트 나이를 렌더링하지 않는다 — detail 만 보면 "
        "한 달 전 숫자를 오늘 결과로 읽는다"
    )


@pytest.mark.parametrize("domain", sorted(UIS))
def test_heartbeat_freshness_is_tiered_not_binary(domain: str) -> None:
    """alive(600초)만 쓰면 6시간 cron 이 항상 빨갛다 — 24h/7d 구간을 둔다."""
    html = UIS[domain].read_text(encoding="utf-8")
    assert "function hbTier(" in html, f"{domain} UI 에 신선도 구간 판정이 없다"
    # 24시간(86400) · 7일(604800) 경계가 실제로 쓰여야 한다.
    assert "86400" in html and "604800" in html, (
        f"{domain} UI 의 hbTier 가 24h/7d 경계를 쓰지 않는다"
    )


@pytest.mark.parametrize("domain", sorted(UIS))
def test_heartbeat_rows_are_newest_first(domain: str) -> None:
    """가장 최근 것이 위에 와야 '지금 뭐가 도는지'가 한눈에 보인다."""
    html = UIS[domain].read_text(encoding="utf-8")
    assert "last_beat||0)-Number" in html, f"{domain} UI 가 하트비트를 최신순 정렬하지 않는다"
