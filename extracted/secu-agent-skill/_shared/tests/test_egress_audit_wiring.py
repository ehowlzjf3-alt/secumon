"""egress 판정이 **평소 런에서** 돌아간다 (2026-08-22).

## 무엇이 있었나

경계는 프롬프트가 아니라 세 겹(도구 등록·닫힌 봉투·마스킹)이고, 그게 지켜졌는지는
**리드가 보낸 바이트**로만 알 수 있다. 판정기(`docs/probes/egress_audit.py`)는 있었지만
두 가지 때문에 사실상 안 돌았다:

  ① `SA_EGRESS_CAPTURE` 미설정 = 캡처 없음 → 어느 .env 에도 없어서 평소 런은
     검사 대상이 **아예 안 남았다.**
  ② 판정기를 손으로 돌려야 했다.

둘 다 고쳤다. 캡처는 증거 디렉터리로 기본 낙하하고(코어가 `SA_EVIDENCE_DIR` 를
setdefault 한다), 리드 정리 훅이 판정을 돌려 `egress_audit.json` 을 남긴다.

## 실패시키지 않는 이유

정리 훅에 도달했을 땐 바이트가 **이미 나갔다.** 런을 실패로 만들어도 되돌릴 수 없고,
정리(세션 닫기)까지 같이 죽이면 더 나쁘다 — 검토원 브라우저가 남는다.
그래서 기록 + 큰 로그다. INCONCLUSIVE 도 PASS 가 아니다(코퍼스가 비면 "검사 안 함").
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from _shared import egress_capture as ec


# ── ① 캡처 기본값 ───────────────────────────────────────────────────────
def test_capture_falls_back_to_the_evidence_dir(tmp_path, monkeypatch):
    monkeypatch.delenv(ec.CAPTURE_ENV, raising=False)
    monkeypatch.setenv("SA_EVIDENCE_DIR", str(tmp_path))
    assert ec.capture_path() == tmp_path / ec.CAPTURE_FILENAME


def test_explicit_capture_env_still_wins(tmp_path, monkeypatch):
    """운영이 언제나 되찾아올 수 있어야 한다 — 명시가 기본을 이긴다."""
    explicit = tmp_path / "elsewhere" / "out.jsonl"
    monkeypatch.setenv(ec.CAPTURE_ENV, str(explicit))
    monkeypatch.setenv("SA_EVIDENCE_DIR", str(tmp_path))
    assert ec.capture_path() == explicit


def test_no_capture_when_neither_is_set(monkeypatch):
    monkeypatch.delenv(ec.CAPTURE_ENV, raising=False)
    monkeypatch.delenv("SA_EVIDENCE_DIR", raising=False)
    assert ec.capture_path() is None


def test_missing_evidence_dir_does_not_create_one(tmp_path, monkeypatch):
    """없는 경로면 조용히 만들지 않는다 — 캡처가 엉뚱한 데 쌓이면 안 된다."""
    monkeypatch.delenv(ec.CAPTURE_ENV, raising=False)
    monkeypatch.setenv("SA_EVIDENCE_DIR", str(tmp_path / "nope"))
    assert ec.capture_path() is None


def test_core_exports_the_evidence_dir_env():
    """스킬이 읽는 이름과 코어가 쓰는 이름이 같아야 한다."""
    from secu_agent.agent.cli import EVIDENCE_DIR_ENV

    assert EVIDENCE_DIR_ENV == "SA_EVIDENCE_DIR"


def test_core_sets_it_before_build_client():
    """★ 순서가 이 배선의 전제다.

    `build_client` 훅이 `build_user_message` 보다 먼저 불리는데, evidence_dir 를 인자로
    받는 건 뒤쪽 훅뿐이다. 그래서 앞쪽 훅이 알 수 있게 env 로 내보낸다 — 그 setdefault 가
    `contract.build_client` 호출보다 **위**에 있어야 한다.
    """
    import inspect

    from secu_agent.agent import cli

    src = inspect.getsource(cli._run)
    i = src.index("EVIDENCE_DIR_ENV")
    j = src.index("contract.build_client(")
    assert i < j, "evidence dir env 를 build_client 훅보다 늦게 세우면 캡처가 안 걸린다"


# ── ② 정리 훅이 판정을 돌린다 ─────────────────────────────────────────
def _lead_cleanup(monkeypatch, report: dict):
    from _shared import lead_contract as lc

    monkeypatch.setattr("docs.probes.egress_audit.audit", lambda _d: report)
    contract = lc.build_lead_contract(domain="smb", agents_dir=Path("/nonexistent"))
    return contract.on_submit


@pytest.mark.parametrize("verdict", ["PASS", "FAIL", "INCONCLUSIVE"])
def test_cleanup_writes_the_verdict_as_evidence(tmp_path, monkeypatch, verdict):
    import asyncio

    cleanup = _lead_cleanup(monkeypatch, {"verdict": verdict, "requests": 3,
                                          "shape_hits": [], "crossed_total": 0,
                                          "corpus_empty": verdict == "INCONCLUSIVE",
                                          "inspector_windows": 10})
    asyncio.run(cleanup(tmp_path))
    out = tmp_path / "egress_audit.json"
    assert out.is_file(), "판정 결과가 증거로 안 남는다"
    assert json.loads(out.read_text(encoding="utf-8"))["verdict"] == verdict


def test_non_pass_is_logged_loudly(tmp_path, monkeypatch, caplog):
    import asyncio
    import logging

    cleanup = _lead_cleanup(monkeypatch, {"verdict": "FAIL", "requests": 1,
                                          "shape_hits": [["aws_key", 1]],
                                          "crossed_total": 2, "corpus_empty": False,
                                          "inspector_windows": 99})
    with caplog.at_level(logging.ERROR, logger="shared.lead_contract"):
        asyncio.run(cleanup(tmp_path))
    assert any(r.levelno >= logging.ERROR for r in caplog.records), "조용히 넘어갔다"


def test_inconclusive_is_not_treated_as_pass(tmp_path, monkeypatch, caplog):
    """코퍼스가 비면 '검사를 안 한 것' 이다 — 성공으로 읽히면 최악이다."""
    import asyncio
    import logging

    cleanup = _lead_cleanup(monkeypatch, {"verdict": "INCONCLUSIVE", "requests": 5,
                                          "shape_hits": [], "crossed_total": 0,
                                          "corpus_empty": True, "inspector_windows": 0})
    with caplog.at_level(logging.INFO, logger="shared.lead_contract"):
        asyncio.run(cleanup(tmp_path))
    assert any(r.levelno >= logging.ERROR for r in caplog.records)


def test_audit_failure_does_not_break_cleanup(tmp_path, monkeypatch):
    """판정기가 터져도 세션 정리는 끝나야 한다 — 브라우저가 남으면 더 나쁘다."""
    import asyncio

    from _shared import lead_contract as lc

    def _boom(_d):
        raise RuntimeError("판정기 고장")

    monkeypatch.setattr("docs.probes.egress_audit.audit", _boom)
    contract = lc.build_lead_contract(domain="smb", agents_dir=Path("/nonexistent"))
    assert asyncio.run(contract.on_submit(tmp_path)) == 0
