"""보고 본문은 **대상(src) 전체**를 묶는다 — 4도메인 동일 (사용자 결정 2026-08-30).

## 왜

콘솔의 티켓 축은 **src** 다(host/site/repo/space). 그런데 본문을 묶는 단위가 도메인마다
달랐다. 실측 2026-08-30:

    도메인      티켓 단위   본문이 묶는 단위       일치
    smb         host       host 전체 finding       ✓
    github      repo       repo 전체               ✓
    confluence  space      space 전체              ✓
    dev_web     site       finding **1건**          ✗   ← 사고

한 사이트에 finding 이 5건인 대상이 있는데 본문엔 1건만 남았다. 화면은 "발견 5" 인데
메일엔 1건만 적히는 상태다.

## 계약

    스레드(티켓)  제출 시점에 태어나 src 단위로 집계된다 (upsert 가 한다)
    본문          src 의 finding **전부**를 묶는다
                  제출마다 다시 만든다 → 마지막 제출 뒤에 완전해진다

"src 의 finding 이 전부 들어오면 만든다" 를 별도 완료 신호 없이 만족한다. 완료 신호를
따로 두면 그 신호가 안 오는 경로에서 본문이 영영 안 생긴다(이 저장소가 반복해서 당한 형태).
"""
from __future__ import annotations

import inspect

import pytest


def test_dev_web_body_aggregates_the_whole_site():
    from domains.dev_web.plugin.tools import dev_web_submit_finding_tool as t

    src = inspect.getsource(t._build_domain_report)
    assert "finding_lifecycle" in src, "사이트 전체 finding 을 조회하지 않는다"
    assert "finding_count" in src and "findings" in src


def test_dev_web_body_survives_a_failed_lookup():
    """⚠️ 본문 재료 조회 실패가 제출을 죽이면 안 된다 — 최소한 현재 finding 은 담는다."""
    from domains.dev_web.plugin.tools import dev_web_submit_finding_tool as t

    class _F:
        severity = "high"
        summary = "s"
        target = "https://x/y"
        risk_narrative = None
        recommended_actions = []

    out = t._build_domain_report("", current=_F(), note=None, evidence_ref="e")
    assert out["finding_count"] >= 1
    assert out["findings"]


@pytest.mark.parametrize(("domain", "path", "needle"), [
    ("smb", "service/services/smb_remediation_report.py", "mail_thread_find_by_subject_tag"),
    ("dev_web", "domains/dev_web/plugin/tools/dev_web_submit_finding_tool.py", "finding_lifecycle"),
])
def test_every_domain_body_reaches_beyond_one_finding(domain, path, needle):
    """★ 본문이 finding 1건만 담으면 티켓과 본문의 모수가 어긋난다."""
    import pathlib

    assert needle in pathlib.Path(path).read_text(encoding="utf-8"), domain
