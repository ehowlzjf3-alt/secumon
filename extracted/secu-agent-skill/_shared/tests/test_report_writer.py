"""entity HTML 리포트 생성기.

de-domain v3.84 #2b: 구 코어 test_report_writer.py 이관. report_writer 는 코어 런타임
호출자가 없는 도메인 리포트 생성기라 skill _shared/report_writer.py 로 옮겨졌다
(skill-상대 경로 import — pytest pythonpath="." 로 resolve).
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path as _Path

from _shared import report_writer as rw
from secu_agent import state
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.types import (
    LLMRequest, StreamMessageStop, StreamTextDelta, StreamUsage,
)


class _FakeReportLLM(LLMClient):
    def __init__(self, text: str):
        self._text = text

    @property
    def name(self) -> str:
        return "fake-report"

    async def stream(self, request: LLMRequest) -> AsyncIterator:
        yield StreamTextDelta(text=self._text)
        yield StreamMessageStop(
            stop_reason="end_turn",
            usage=StreamUsage(input_tokens=1, output_tokens=1),
        )


def _run(coro):
    return asyncio.run(coro)


def _seed_host_with_finding(tmp_db=None):
    fp = state.finding_fingerprint(
        task_type="smb", asset="192.0.2.50/data/conf/app.env",
        asset_kind="file", discriminator="secret",
    )
    state.finding_upsert(
        task_type="smb", asset="192.0.2.50/data/conf/app.env",
        asset_kind="file", severity="critical", summary="AWS access key 평문 노출",
        fingerprint=fp, evidence_ref="/tmp/e.json",
    )
    state.finding_upsert(
        task_type="smb", asset="192.0.2.50/data/users.xlsx",
        asset_kind="file", severity="medium", summary="개인정보 추정 파일",
        evidence_ref="/tmp/e2.json",
    )
    state.finding_upsert(
        task_type="smb", asset="192.0.2.50/backup/old.zip",
        asset_kind="file", severity="low", summary="오래된 백업 아카이브",
        evidence_ref="/tmp/e3.json",
    )


def test_summarize_entity(tmp_db):
    _seed_host_with_finding()
    data = rw.summarize_entity("host", "192.0.2.50")
    assert data["finding_count"] == 3
    assert data["severity_counts"].get("critical") == 1
    assert data["event_count"] >= 3
    assert "smb" in data["sources"]


def test_fallback_narrative_no_client(tmp_db):
    _seed_host_with_finding()
    data = rw.summarize_entity("host", "192.0.2.50")
    nar = _run(rw.render_narrative(None, data))
    assert "192.0.2.50" in nar["summary"]
    assert nar["recommendation"]


def test_llm_narrative_parsed(tmp_db):
    _seed_host_with_finding()
    data = rw.summarize_entity("host", "192.0.2.50")
    text = (
        "## SUMMARY\n호스트에서 자격증명 노출이 확인되었습니다.\n"
        "## RECOMMENDATION\n- 키 회수\n- 부서 통보\n"
    )
    nar = _run(rw.render_narrative(_FakeReportLLM(text), data))
    assert "자격증명 노출" in nar["summary"]
    assert "키 회수" in nar["recommendation"]


def test_llm_bad_output_falls_back(tmp_db):
    _seed_host_with_finding()
    data = rw.summarize_entity("host", "192.0.2.50")
    nar = _run(rw.render_narrative(_FakeReportLLM("마커 없는 잡소리"), data))
    assert "192.0.2.50" in nar["summary"]


def test_generate_report_writes_file(tmp_db, tmp_path):
    _seed_host_with_finding()
    text = "## SUMMARY\n요약입니다.\n## RECOMMENDATION\n- 조치1\n"
    res = _run(rw.generate_entity_report(
        client=_FakeReportLLM(text), entity_type="host",
        entity_id="192.0.2.50", out_dir=tmp_path, charter_ref="CHARTER-1",
        generated_at=1_700_000_000.0,
    ))
    p = _Path(res["path"])
    assert p.exists()
    assert p.suffix == ".html"
    assert "reports" in p.parts
    html = p.read_text(encoding="utf-8")
    assert "<!DOCTYPE html>" in html
    assert "192.0.2.50" in html
    assert "요약입니다" in html
    assert "조치1" in html
    assert "AWS access key" in html
    assert "critical" in html.lower()
    assert res["finding_count"] == 3


def test_generate_report_empty_entity(tmp_db, tmp_path):
    res = _run(rw.generate_entity_report(
        client=None, entity_type="host", entity_id="10.9.9.9",
        out_dir=tmp_path, generated_at=1_700_000_000.0,
    ))
    assert _Path(res["path"]).exists()
    assert res["event_count"] == 0
    assert res["finding_count"] == 0
