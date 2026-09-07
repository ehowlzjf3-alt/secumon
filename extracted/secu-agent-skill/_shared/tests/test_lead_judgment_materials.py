"""값을 안 주면서 판단 재료를 주는가 (Phase 3a/3b).

Phase 2 는 "안 새는가" 만 봤다. 그것만으로는 부족하다 — **과잉 마스킹도 결함**이다.
리드가 좌표를 잃으면 판단을 못 하고, 그러면 2단 구조가 비용만 남는다.

여기서 두 방향을 같이 고정한다: 차단 목록 100% 차단 / 허용 목록 100% 통과.
"""
from __future__ import annotations

import json

import pytest

from _shared.lead_masking import (
    MAX_CONTEXT_LINES, fingerprint, mask_context_lines, mask_text_for_lead,
    partial_mask, shape_of,
)

# ── 차단: 리드(=codex, 사외)가 보면 안 되는 값 ─────────────────────────
BLOCKED = [
    # ★ 2026-08-21 실측에서 **통과하던** 것들 — `\b` 가 `_` 앞에서 성립하지 않아서였다.
    ("SCREAMING_SNAKE aws", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
     "wJalrXUtnFEMI"),
    ("SCREAMING_SNAKE db", "DB_PASSWORD=Hunter2Hunter", "Hunter2Hunter"),
    ("SCREAMING_SNAKE gh", "GITHUB_TOKEN=ghs_abcdefghijklmnopqrst", "ghs_abcdefghijklmnopqrst"),
    ("yaml password", "spring.datasource.password=P@ssw0rd123", "P@ssw0rd123"),
    ("dotted secret", "app.secret-key: s3cr3tv4lue", "s3cr3tv4lue"),
    ("aws key id", "여기 AKIAIOSFODNN7EXAMPLE 가 있다", "AKIAIOSFODNN7EXAMPLE"),
    ("github pat", "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
     "ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
    ("rrn", "주민 900101-1234568", "900101-1234568"),
    ("card", "카드 4111-1111-1111-1111", "4111-1111-1111-1111"),
    ("cred url", "https://user:p4ssw0rd@intra.samsungds.net/x", "p4ssw0rd"),
    ("jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
     "eyJzdWIiOiIxMjM0NTY3ODkw"),
]

# ── 허용: 판단에 필요한 좌표 (실기동에서 실제로 나온 모양들) ─────────────
ALLOWED = [
    ("smb 파일경로(GUID)",
     "Default/NTUSER.DAT{8ebe95f7-3dcb-11e8-a9d9-7cfe90913f50}.TMContainer0001.regtrans-ms"),
    ("jdbc url", "spring.datasource.url=jdbc:postgresql://db01:5432/prod"),
    ("환경변수 이름", "SPRING_DATASOURCE_URL, AWS_REGION, JENKINS_URL 3개 노출"),
    ("host/포트/담당자", "10.135.69.244:445 / SMSSIG$ / 4904 files / 김철수(21001234)"),
    ("repo blob + 라인", "samsungds/bios-fw blob/main/src/main.py 라인 42-58"),
    ("k8s ingress", "k8s ingress apex-dev.cdep.samsungds.net port 8443"),
    ("크리덴셜 파일 **이름**", "id_rsa, .npmrc, .aws/credentials 3개 파일명"),
    ("일반 산문", "the password policy is weak"),
    ("space key", "confluence space ER25SI, 페이지 412건"),
    ("크기 표기", "config/application-prod.yml (11KB), deploy.yml (2.4KB)"),
]


@pytest.mark.parametrize("name,text,secret", BLOCKED, ids=[b[0] for b in BLOCKED])
def test_blocked_value_never_reaches_the_lead(name, text, secret):
    assert secret not in mask_text_for_lead(text), f"{name}: 값이 그대로 나간다"


@pytest.mark.parametrize("name,text", ALLOWED, ids=[a[0] for a in ALLOWED])
def test_coordinate_survives_verbatim(name, text):
    """★ 과잉 마스킹도 결함이다 — 리드가 좌표를 잃으면 판단을 못 한다."""
    assert mask_text_for_lead(text) == text, f"{name}: 좌표가 뭉개졌다"


# ── 판단 재료 ──────────────────────────────────────────────────────────

def _entropy(shape: str) -> float:
    return float(shape.split("entropy=")[1].rstrip(">"))


def test_shape_separates_placeholder_from_real_secret():
    """리드가 답해야 하는 첫 질문 — 진짜인가 placeholder 인가."""
    ph = shape_of("changeme")
    real = shape_of("P@ssw0rd123")
    assert "len=8" in ph and "alpha" in ph
    assert "len=11" in real and "alnum+sym" in real
    assert _entropy(real) > _entropy(ph)


def test_fingerprint_correlates_without_exposing():
    """★ 재사용 판정은 부분마스킹이 아니라 지문으로 한다 — 노출 0, 상관 완벽."""
    a, b, c = fingerprint("P@ssw0rd123"), fingerprint("P@ssw0rd123"), fingerprint("other-value")
    assert a == b and a != c
    assert "P@ssw0rd" not in a
    assert len(a) == 8


def test_fingerprint_is_salted_per_run(monkeypatch):
    """salt 없는 sha256 은 짧은 비번을 사전 대입으로 확인시켜 준다."""
    import hashlib

    from _shared.lead_masking import FINGERPRINT_SALT_ENV

    monkeypatch.setenv(FINGERPRINT_SALT_ENV, "salt-a")
    a = fingerprint("Hunter2")
    monkeypatch.setenv(FINGERPRINT_SALT_ENV, "salt-b")
    b = fingerprint("Hunter2")
    assert a != b
    assert a != hashlib.sha256(b"Hunter2").hexdigest()[:8]


@pytest.mark.parametrize("value,max_ratio", [
    ("sa", 0.0), ("changeme", 0.0), ("P@ssw0rd123", 0.0),
    ("Hunter2HunterX", 0.25), ("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", 0.25),
])
def test_partial_mask_exposure_is_length_bounded(value, max_ratio):
    """★ 8자 비번에서 3자를 보이면 그건 마스킹이 아니다."""
    out = partial_mask(value)
    revealed = sum(1 for ch in value if ch in out)
    # 정확한 노출 문자수 계산: `<앞…뒤 len=N>` 형태에서 앞/뒤만 실제 노출
    exposed = 0
    if "…" in out and not out.startswith("<len="):
        head = out[1:out.index("…")]
        tail = out[out.index("…") + 1:out.index(" len=")]
        exposed = len(head) + len(tail)
    assert exposed <= max(0, int(len(value) * max_ratio)), (
        f"{value!r} 에서 {exposed}자 노출 — 상한 초과 (out={out})")
    del revealed


def test_context_lines_are_masked_and_capped():
    lines = [f"{i}| password=Sup3rSecret{i}" for i in range(20)]
    out = mask_context_lines(lines)
    assert len(out) <= MAX_CONTEXT_LINES
    blob = "\n".join(out)
    assert "Sup3rSecret" not in blob


def test_context_masking_is_stricter_than_core_alone():
    """★ 순서 문제 — 코어가 먼저 돌면 11자 비번의 8자가 드러난다(실측)."""
    from secu_agent.detectors.text_scan import mask_scanned_text

    line = "42| spring.datasource.password=P@ssw0rd123"
    core_only = mask_scanned_text(line)
    ours = mask_context_lines([line])[0]
    assert "P@ss" in core_only, "코어 동작이 바뀌었다 — 이 테스트의 전제를 확인하라"
    assert "P@ss" not in ours
    assert "spring.datasource" in ours, "좌표까지 지우면 맥락의 의미가 없다"


# ── 검토원 보고 ────────────────────────────────────────────────────────

def test_report_stores_derived_forms_only(tmp_path):
    """★ 원문 value 는 검토원 프로세스를 나가지 않는다."""
    from _shared.inspector_report import ReportInspectionInput, build_report

    secret = "P@ssw0rd123"
    rep = build_report(ReportInspectionInput(
        verdict="confirmed", narrative="평문 DB 비번",
        notable=[{"path": "a/b.yml", "line": 42, "kind": "db_connection_string",
                  "why": "평문", "value": secret,
                  "context": [f"42| password={secret}"]}],
    ))
    blob = json.dumps(rep, ensure_ascii=False)
    assert secret not in blob
    n = rep["notable"][0]
    assert n["path"] == "a/b.yml" and n["line"] == 42     # 좌표는 원문
    assert "len=11" in n["shape"] and len(n["fingerprint"]) == 8


def test_report_narrative_cap_is_1000(tmp_path):
    """사용자 요구(2026-08-21): 500 → 1000."""
    from _shared.inspector_report import MAX_NARRATIVE, ReportInspectionInput, build_report

    assert MAX_NARRATIVE == 1000
    rep = build_report(ReportInspectionInput(verdict="clean", narrative="가" * 1000))
    assert len(rep["narrative"]) == 1000


def test_report_notable_truncation_is_not_silent():
    """조용한 절단 금지 — 리드가 '전부 봤다' 로 읽으면 안 된다."""
    from _shared.lead_masking import MAX_NOTABLE
    from _shared.inspector_report import ReportInspectionInput, build_report

    rep = build_report(ReportInspectionInput(
        verdict="suspicious", narrative="많다",
        notable=[{"path": f"f{i}", "kind": "k", "why": "w"} for i in range(MAX_NOTABLE + 5)],
    ))
    assert len(rep["notable"]) == MAX_NOTABLE
    assert rep["notable_dropped"] == 5


def test_reinspect_round_trips_to_a_delegate_call():
    """재검토 요청이 리드가 바로 쓸 수 있는 모양인가."""
    from _shared.inspector_report import ReportInspectionInput, build_report

    rep = build_report(ReportInspectionInput(
        verdict="suspicious", narrative="예산 소진",
        reinspect=[{"path": "src/deploy.sh", "line_from": 88, "line_to": 120,
                    "why": "base64 블록 3건"}],
    ))
    r = rep["reinspect"][0]
    assert r["path"] == "src/deploy.sh" and r["line_from"] == 88
    assert "base64" in r["why"]


# ── 서식 보정 (2026-08-26) ──────────────────────────────────────────────
#
# 검토원이 **판단은 맞게 하고 그릇을 틀려서** 보고를 못 남기는 자리를 막는다.
# 실측(smb 리드 세션 s1): `context` 를 리스트가 아니라 문자열로 넘겨 turn 5 가
# `err:validation`, turn 6 에 자력 교정. 엔진 `repeat_error` 는 같은 도구가 같은
# 에러로 **두 번**이면 작업을 멈춘다 — 한 번만 더 틀렸으면 판단 전체를 잃었다.
#
# ★ 보정이 마스킹 경계를 넓히지 않는다는 것이 여기서 지켜야 할 핵심이다.


def test_context_accepts_a_bare_string():
    """대괄호 하나 때문에 보고를 잃지 않는다."""
    from _shared.inspector_report import NotableItem

    n = NotableItem(path="a.cfg", kind="k", why="w", context="한 줄뿐이다")
    assert n.context == ["한 줄뿐이다"]


def test_context_string_with_newlines_becomes_real_lines():
    """줄바꿈이 든 한 덩어리는 실제 줄로 쪼갠다 — 리드가 400자 뭉텅이 대신 줄을 본다."""
    from _shared.inspector_report import NotableItem

    n = NotableItem(path="a.cfg", kind="k", why="w", context="a\nb\nc")
    assert n.context == ["a", "b", "c"]


def test_coerced_context_cannot_widen_the_masking_boundary():
    """★ 보정이 만들 수 있는 결과는 **손으로 리스트를 넘겼을 때의 부분집합**이다.

    캡(줄 5 · 줄당 400자 · 총 4000자 · 줄마다 마스킹)이 보정 **뒤**의
    `mask_context_lines` 에 있으므로 우회가 성립하지 않는다. 벌크 본문을 한 덩어리로
    밀어넣어도 같은 캡에 걸린다.
    """
    from _shared.inspector_report import ReportInspectionInput, build_report

    bulk = "\n".join(f"line{i}: password=Sup3rS3cret{i}!" for i in range(200))
    rep = build_report(ReportInspectionInput(
        verdict="suspicious", narrative="벌크",
        notable=[{"path": "a.cfg", "kind": "k", "why": "w", "context": bulk}],
    ))
    ctx = rep["notable"][0]["context"]
    assert len(ctx) <= 5, "줄 수 캡이 보정을 우회당했다"
    assert sum(len(x) for x in ctx) <= 4000
    assert "Sup3rS3cret" not in "".join(ctx), "보정 경로에서 값이 마스킹을 건너뛰었다"


def test_container_fields_accept_json_strings():
    """약모델이 list 를 JSON 문자열로 보내도 판단이 리드에 닿는다.

    엔진이 submit_verdict·submit_finding·triage_candidates 에 이미 단 배선이고
    (`_arg_coercion`), report_inspection 만 빠져 있었다.
    """
    import json

    from _shared.inspector_report import ReportInspectionInput

    vi = ReportInspectionInput(
        verdict="clean", narrative="요약",
        notable=json.dumps([{"path": "a.cfg", "kind": "k", "why": "w"}]),
        reinspect="[]",
    )
    assert len(vi.notable) == 1 and vi.notable[0].path == "a.cfg"
    assert vi.reinspect == []


def test_coercion_never_invents_a_pass():
    """★ 보정은 **새 실패를 만들지도, 없앨 것을 없애지도 않는다.**

    컨테이너가 아닌 평문은 그대로 pydantic 에 넘어가 거부돼야 한다 — 여기가 무너지면
    보정이 검증을 대체해버린다(엔진 `_arg_coercion` 규약: 검증은 pydantic 이 한다).
    """
    import pytest as _pytest

    from _shared.inspector_report import ReportInspectionInput

    with _pytest.raises(Exception):
        ReportInspectionInput(verdict="clean", narrative="n", notable="이건 리스트가 아니다")


def test_raw_value_field_has_no_coercion():
    """⚠️ `value` 에는 보정을 달지 않는다 — 시크릿 원문이 들어오는 자리다.

    보정을 얹으면 '무엇이 값인가' 판정이 흔들린다. 지금은 문자열 하나만 받고,
    도구가 shape/fingerprint/masked 로 바꾼 뒤 원문을 버린다.
    """
    from _shared.inspector_report import NotableItem

    fields = NotableItem.__pydantic_decorators__.field_validators
    guarded = {f for d in fields.values() for f in d.info.fields}
    assert "value" not in guarded, "value 에 보정이 달렸다 — 원문 판정이 흔들린다"
    assert "context" in guarded
