"""egress 캡처·역할 프로파일 (Phase 3c/3d).

캡처는 **실측의 도구**다. 도구가 조용히 안 돌면 실측이 "깨끗함" 을 반환하고 그게 제일 나쁘다.
"""
from __future__ import annotations

import json
import os

import pytest

from _shared.egress_capture import (
    CAPTURE_ENV, CAPTURE_FILENAME, EgressCaptureClient, capture_path,
    wrap_egress_capture,
)


class _FakeClient:
    name = "fake-profile"

    def __init__(self):
        self.seen = []

    def stream(self, request):
        self.seen.append(request)
        return iter(())


def test_no_capture_env_means_no_wrapping(monkeypatch):
    """미설정이면 byte-for-byte 원본 — 프로덕션 경로에 비용 0."""
    monkeypatch.delenv(CAPTURE_ENV, raising=False)
    inner = _FakeClient()
    assert wrap_egress_capture(inner, role="lead", task_type="x") is inner
    assert capture_path() is None


def test_capture_records_the_whole_request(tmp_path, monkeypatch):
    monkeypatch.setenv(CAPTURE_ENV, str(tmp_path))
    from secu_agent.agent.llm.messages import TextBlock, UserMessage
    from secu_agent.agent.llm.types import LLMRequest, ToolSpec

    marker = "CANARY-DO-NOT-LEAK-9f3a"
    req = LLMRequest(
        system=f"리드 계약 {marker}",
        messages=[UserMessage(content=[TextBlock(text="타깃 672")])],
        tools=[ToolSpec(name="delegate_inspect", description="위임",
                        input_schema={"type": "object", "properties": {}})],
    )
    client = wrap_egress_capture(_FakeClient(), role="lead", task_type="github_lead")
    assert isinstance(client, EgressCaptureClient)
    client.stream(req)

    entry = json.loads((tmp_path / CAPTURE_FILENAME).read_text(encoding="utf-8").strip())
    blob = json.dumps(entry, ensure_ascii=False)
    assert entry["role"] == "lead" and entry["task_type"] == "github_lead"
    # ★ 캡처는 마스킹하지 않는다 — 마스킹된 것을 세면 아무것도 못 잡는다.
    assert marker in blob
    assert "타깃 672" in blob
    assert "delegate_inspect" in blob


def test_capture_is_transparent_to_provenance(tmp_path, monkeypatch):
    """폴백/프로파일 기록 코드가 래퍼를 뚫고 안쪽을 봐야 한다."""
    monkeypatch.setenv(CAPTURE_ENV, str(tmp_path))
    inner = _FakeClient()
    inner._profile_name = "gemma"          # noqa: SLF001 — provenance 가 보는 속성
    client = wrap_egress_capture(inner, role="lead", task_type="x")
    assert client.name == "fake-profile"
    assert client._profile_name == "gemma"


def test_capture_failure_does_not_break_the_hunt(tmp_path, monkeypatch):
    """캡처 기록 실패가 리드를 죽이면 실측 때문에 헌트를 잃는다."""
    monkeypatch.setenv(CAPTURE_ENV, str(tmp_path / "cap.jsonl"))
    client = wrap_egress_capture(_FakeClient(), role="lead", task_type="x")
    client._path = tmp_path / "없는디렉터리" / "deep" / "x.jsonl"   # noqa: SLF001
    client.stream(object())          # 예외가 새어 나오면 안 된다


# ── 역할별 프로파일 (3c) ───────────────────────────────────────────────

def test_lead_profile_env_name_is_not_the_global_pin():
    """`SA_CHAT_PROFILE` 핀 금지 불변식과 다른 축이다 — 이름이 겹치면 안 된다."""
    from _shared.lead_contract import LEAD_PROFILE_ENV

    assert LEAD_PROFILE_ENV == "SA_LEAD_PROFILE"
    assert LEAD_PROFILE_ENV != "SA_CHAT_PROFILE"


@pytest.mark.parametrize("value", ["없는프로파일오타", "gauss-o32", ""])
def test_bad_lead_profile_fails_safe_to_internal(value, monkeypatch):
    """★ 오타/은퇴한 이름이 **사외**로 떨어지면 안 된다 (Phase 1 에서 고친 그 함정)."""
    from service.agents import runtime

    monkeypatch.setenv("SA_LEAD_PROFILE", value)
    monkeypatch.delenv("SA_CHAT_PROFILE", raising=False)
    monkeypatch.delenv("SA_CHAT_PROFILE_CHAIN", raising=False)
    client = runtime._build_client(None, override=(value or None))
    served = str(getattr(client, "name", ""))
    assert "codex" not in served and "o4-mini" not in served, (
        f"사외 프로파일로 fail-open 했다: {served}")


def test_explicit_lead_profile_wins_over_global(monkeypatch):
    """역할 override 가 전역보다 세야 리드/검토원을 다른 모델로 나눌 수 있다."""
    from service.agents import runtime

    monkeypatch.setenv("SA_CHAT_PROFILE", "deepseek")
    monkeypatch.delenv("SA_CHAT_PROFILE_CHAIN", raising=False)
    client = runtime._build_client(None, override="gemma")
    assert "gemma" in str(getattr(client, "name", ""))


# ── 판정기 (3d) ────────────────────────────────────────────────────────

def test_audit_catches_a_planted_leak(tmp_path):
    """★ 판정기가 진짜로 잡는지 — 일부러 심어서 확인한다.

    실측 도구가 조용히 안 돌면 "깨끗함" 을 반환하고, 그게 제일 나쁜 결과다.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "egress_audit",
        os.path.join(os.path.dirname(__file__), "..", "..",
                     "docs", "probes", "egress_audit.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    sub = tmp_path / "sub-20260821T000000-aaa-inspector"
    sub.mkdir(parents=True)
    # 실제 코드처럼 긴 토큰이 없는 본문 — 토큰 기반 판정기는 이걸 못 잡았다(실측).
    body = ("def deploy():\n    conn = connect(host='db01', database='prod_billing_v2')\n"
            "    cur.execute('SELECT * FROM billing WHERE tenant=%s', (tenant,))")
    (sub / "worker_stdout.log").write_text(body, encoding="utf-8")

    # 깨끗한 경우
    (tmp_path / "egress.jsonl").write_text(json.dumps({
        "seq": 1, "profile": "codex",
        "request": {"system": "리드", "messages": [{"text": "타깃 672 를 봐라"}]},
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    assert mod.audit(tmp_path)["verdict"] == "PASS"

    # ① 모양 위반
    (tmp_path / "egress.jsonl").write_text(json.dumps({
        "seq": 1, "profile": "codex",
        "request": {"system": "ghp_abcdefghijklmnopqrstuvwxyz0123456789"},
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    r = mod.audit(tmp_path)
    assert r["verdict"] == "FAIL" and "github_pat" in r["shape_hits"]

    # ② 교차 대조 — 검토원만 알던 본문이 리드 요청에 나타남
    (tmp_path / "egress.jsonl").write_text(json.dumps({
        "seq": 1, "profile": "codex",
        "request": {"messages": [{"text": f"검토원 보고: {body}"}]},
    }, ensure_ascii=False) + "\n", encoding="utf-8")
    r = mod.audit(tmp_path)
    assert r["verdict"] == "FAIL", "본문 유출을 못 잡았다 — 판정기가 무용지물이다"
    assert r["crossed_total"] > 0

    # ③ ★ 봉투 차감이 판정기를 무력화하면 안 된다.
    #    1차 실측에서 판정기가 오탐 25건을 냈고(검토원 audit 사본·좌표 URL), 그걸
    #    "봉투가 정당하게 나른 것" 으로 차감했다. 그 차감이 **진짜 유출까지** 삼키면
    #    판정기가 영원히 PASS 만 낸다 — 여기서 그렇지 않음을 고정한다.
    (sub / "inspector_report.json").write_text(json.dumps({
        "verdict": "clean", "narrative": "봉투는 이 문장만 날랐다", "notable": [],
    }, ensure_ascii=False), encoding="utf-8")
    r = mod.audit(tmp_path)
    assert r["verdict"] == "FAIL", "봉투 차감이 진짜 유출을 삼켰다"
    assert r["crossed_before_envelope"] >= r["crossed_total"] > 0

    #    반대로 봉투가 실제로 나른 문장은 차감돼야 한다(오탐 없음).
    (sub / "inspector_report.json").write_text(json.dumps({
        "verdict": "blocked", "narrative": body, "notable": [],
    }, ensure_ascii=False), encoding="utf-8")
    r = mod.audit(tmp_path)
    assert r["verdict"] == "PASS", "봉투가 정당하게 나른 것을 유출로 셌다(오탐)"
    assert r["crossed_before_envelope"] > 0, "차감 전에는 잡혔어야 한다"
