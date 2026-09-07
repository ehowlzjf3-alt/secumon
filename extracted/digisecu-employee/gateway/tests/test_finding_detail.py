"""단건 finding 상세 리치필드 투영 — 화이트리스트 + 경계 재마스킹(무DB). codex 적대검증 반영.

노출 결정(사용자): finding 상세에 마스킹된 리치필드(증거 hits·4부 위험서사·pivot·권장조치·도메인 메타)를
노출한다. 안전 불변식: (1) 화이트리스트 필드만 투영(미지의 extra_json 키는 절대 안 샘), (2) 모든 free-text 는
게이트웨이 경계 redact() 를 **마스킹→절단** 순서로 통과, (3) 구조필드(status/int/bool/commit/url)는 엄격 검증,
(4) malformed/과깊이/순환은 fail-closed(500 금지). 이 테스트는 그 불변식을 회귀 고정한다."""
import json
import time

import pytest

from digisecu_gateway.masking import redact, redact_deep
from digisecu_gateway.models import GatewayFindingDetail
from digisecu_gateway.repos import finding_repo as fr

SEC = "AKIAIOSFODNN7EXAMPLE"          # AWS 키 형태
PW = "hunter2SuperSecretPw"          # 토큰형 시크릿
EMAIL = "dev.person@corp.example.com"


def _row(extra: dict, **over) -> dict:
    base = {
        "id": 19060, "task_type": "github", "asset": "org/repo", "asset_kind": "repo",
        "severity": "high", "summary": "secret exposed", "status": "open",
        "owner": None, "ticket_ref": None, "first_seen": time.time(), "last_seen": time.time(),
        "seen_count": 3, "has_evidence": True, "extra_json": json.dumps(extra, ensure_ascii=False),
    }
    base.update(over)
    return base


def _detail(extra: dict, **over) -> GatewayFindingDetail:
    return fr._to_finding_detail(_row(extra, **over))


def _dump(m: GatewayFindingDetail) -> str:
    return m.model_dump_json()


# ── 기본/공백/malformed extra_json ──
def test_empty_and_malformed_extra_no_crash():
    for ej in (None, "", "{}", "not-json", "[]", "123"):
        m = fr._to_finding_detail(_row({}, extra_json=ej))
        assert isinstance(m, GatewayFindingDetail)
        assert m.hits is None and m.riskNarrative is None and m.pivot is None


def test_masked_hits_always_null():
    # 구 maskedHits 키를 담아도 절대 재활성화되지 않는다(extractor 제거됨).
    m = _detail({"masked_hits": [{"category": "secret", "kind": "k", "masked_preview": PW}]})
    assert m.maskedHits is None
    assert PW not in _dump(m)


# ── 모든 문자열 경로 sentinel 마스킹 ──
def test_secret_masked_in_every_string_path():
    extra = {
        "hits": [{"category": "secret", "kind": "aws_key", "line_no": 12,
                  "location": f"https://u:{PW}@h/p?q={SEC}", "preview": f"password: {PW} k={SEC}"}],
        "risk_narrative": {"what_is_data": f"pw={PW}", "how_discovered": f"found {SEC}",
                           "exploitation_path": f"pivot {PW}", "verification_method": f"repro {SEC}"},
        "recommended_actions": [f"rotate {SEC}", f"remove password={PW}"],
        "pivot_interpretation": f"reached host token={SEC}",
        "evidence_notes": {f"file://x?token={SEC}": {"what_this_is": f"creds {PW}",
                            "sensitive_fields": ["password_hash", PW], "context_note": f"has {SEC}"}},
        "pivot": {"exposed_count": 1, "probes": [
            {"url": f"https://user:{PW}@10.0.0.1/a?s={SEC}#f", "status": 200, "exposed": True,
             "content_type": "text/html", "evidence_masked": f"body password={PW}"}]},
        "verification": {"status": "live_in_HEAD", "method": "clone", "source": f"src {SEC}"},
        "metadata": {"repo": "org/repo", "path": f"cfg/{SEC}.yaml", "source": "worktree",
                     "scan_method": "api_search"},
        "target": f"https://scan/{SEC}", "confidence": 0.9, "asset_count_scanned": 5,
    }
    dumped = _dump(_detail(extra, asset=f"org/repo/{SEC}", summary=f"secret {PW}"))
    for tok in (SEC, PW):
        assert tok not in dumped, f"{tok!r} 누출: {dumped}"
    assert "«마스킹»" in dumped


def test_email_pii_masked():
    m = _detail({"metadata": {"repo": EMAIL}, "recommended_actions": [f"notify {EMAIL}"]})
    dumped = _dump(m)
    assert "dev.person" not in dumped
    assert EMAIL not in dumped


# ── 제외 필드는 절대 표면화 안 됨 ──
def test_excluded_fields_never_surface():
    # 계약 변경(로그인 검증 렌더 배선): hit.validation 은 **통째 제외**에서 "login_probe 하위의
    # 지정 키만 화이트리스트 투영"으로 좁혀졌다. 그 외 validation 키(reachable/cred 등)와 아래
    # 최상위 키들은 여전히 절대 표면화되지 않는다.
    extra = {
        "hits": [{"category": "secret", "kind": "k", "preview": "x",
                  "validation": {"reachable": True, "cred": PW}}],  # login_probe 없음 → 통째 제외
        "evidence_judgment": {"raw": PW}, "agent_provenance": {"reasoning": f"saw {SEC}"},
        "agent_observations": [f"note {PW}"], "agent_verification": {"status": "verified", "leak": PW},
        "metadata": {"author_email": EMAIL, "_private": PW, "repo": "org/r"},
        "source": "worktree", "report_updated": True,
    }
    m = _detail(extra)
    dumped = _dump(m)
    for tok in ('"validation"', "evidence_judgment", "agent_provenance", "agent_observations",
                "agent_verification", "author_email", "_private", "reachable"):
        assert tok not in dumped, f"제외 키 {tok!r} 노출"
    assert PW not in dumped and SEC not in dumped
    assert (m.hits or [])[0].loginValidation is None  # login_probe 없으면 투영 안 됨
    assert m.loginValidated is False


def test_no_unknown_top_level_keys():
    # 응답 키가 계약 스키마에만 존재(임의 extra 키 새는지). base + detail 필드만 허용.
    m = _detail({"totally_new_secret_key": PW, "hits": [{"category": "s", "kind": "k", "preview": "p"}]})
    allowed = set(GatewayFindingDetail.model_fields.keys())
    assert set(m.model_dump().keys()) <= allowed
    assert "totally_new_secret_key" not in _dump(m)


# ── hit 다형 스키마(제네릭 preview / github·service line_preview / 폴백 masked) ──
def test_hit_shape_variants():
    extra = {"hits": [
        {"category": "secret", "kind": "k1", "location": "a.py", "preview": "generic-preview"},
        {"category": "secret", "kind": "k2", "line_no": 7, "line_preview": "github-line-preview"},
        {"category": "pii", "kind": "k3", "masked": "masked-fallback"},
        {"category": "", "kind": "", "preview": ""},   # 내용無 → skip
        "not-a-dict",                                    # malformed → skip
    ]}
    m = _detail(extra)
    assert m.hits is not None and len(m.hits) == 3
    assert m.hits[0].preview == "generic-preview" and m.hits[0].lineNo is None
    assert m.hits[1].preview == "github-line-preview" and m.hits[1].lineNo == 7
    assert m.hits[2].preview == "masked-fallback"


def test_line_no_validation():
    extra = {"hits": [
        {"category": "s", "kind": "k", "preview": "p", "line_no": "bad"},   # 문자열 → None
        {"category": "s", "kind": "k", "preview": "p", "line_no": True},    # bool → None
        {"category": "s", "kind": "k", "preview": "p", "line_no": -3},      # 음수 → None
        {"category": "s", "kind": "k", "preview": "p", "line_no": 42},      # 정상
    ]}
    m = _detail(extra)
    assert [h.lineNo for h in (m.hits or [])] == [None, None, None, 42]


# ── 로그인 검증(hit.validation.login_probe) 투영 ────────────────────────────────
# 계약: top-level 은 judge 계약상 credential_reachability 로 남고, 로그인 증거는 login_probe 에
# 중첩된다. 게이트웨이는 그 하위의 **지정 키만** 고정어휘/엄격검증으로 투영한다.
def _lp(**over) -> dict:
    p = {"kind": "credential_login_probe", "result": "authenticated", "proves_validity": True,
         "engine": "mssql", "endpoint_host": "12.98.64.105", "endpoint_port": 1433,
         "principal_masked": "s*a", "single_attempt": True, "elapsed_ms": 137}
    p.update(over)
    return p


def _hit_with(proof, **hover) -> dict:
    h = {"category": "credential", "kind": "mssql_connection_string", "line_no": 22,
         "preview": "cn.Open \"Provider=SQLOLEDB;...\"",
         "validation": {"kind": "credential_reachability", "reachable": True, "login_probe": proof}}
    h.update(hover)
    return h


def test_login_validation_projected():
    m = _detail({"hits": [_hit_with(_lp())]})
    lv = (m.hits or [])[0].loginValidation
    assert lv is not None
    assert lv.result == "authenticated" and lv.provesValidity is True
    assert lv.engine == "mssql" and lv.endpoint == "12.98.64.105:1433"
    assert lv.principalMasked == "s*a" and lv.singleAttempt is True and lv.elapsedMs == 137
    assert m.loginValidated is True


def test_login_validation_forbidden_subkeys_never_surface():
    """auth_attempts(평문 username)·credential_fields·bound_masked·detail·policy 는 절대 안 나온다."""
    proof = _lp(
        auth_attempts=[{"credential_fields": {"username": "realadmin", "password_masked": f"hu{PW}er"}}],
        bound_masked=f"Password={PW}", detail=f"login ok banner {SEC}",
        policy=f"single attempt {SEC}", targets=[f"10.0.0.9:{SEC}"], raw_password=PW,
    )
    m = _detail({"hits": [_hit_with(proof)]})
    dumped = _dump(m)
    for tok in ("auth_attempts", "credential_fields", "bound_masked", "realadmin",
                "password_masked", "targets", "raw_password", "detail", "policy"):
        assert tok not in dumped, f"금지 키 {tok!r} 노출"
    assert PW not in dumped and SEC not in dumped
    assert (m.hits or [])[0].loginValidation is not None  # 그래도 요약 자체는 살아있음


@pytest.mark.parametrize("result,ok", [
    ("authenticated", True), ("auth_failed", True), ("account_locked", True),
    ("credential_expired", True), ("session_denied", True),
    ("skipped_repeat", False), ("not_performed", False), ("error", False), ("unreachable", False),
    ("로그인 성공", False), ("authenticated ", False), ("AUTHENTICATED", False), (True, False), (None, False),
])
def test_login_validation_result_allowlist(result, ok):
    """어휘 밖 result 는 통째 드롭 — DB 문자열이 UI 배지 문구로 올라오는 스푸핑 차단."""
    m = _detail({"hits": [_hit_with(_lp(result=result))]})
    lv = (m.hits or [])[0].loginValidation
    assert (lv is not None) is ok
    if ok and result != "authenticated":
        assert m.loginValidated is False  # authenticated 만 '악용 가능'


def test_login_validation_non_authenticated_not_flagged():
    m = _detail({"hits": [_hit_with(_lp(result="auth_failed", proves_validity=True))]})
    assert (m.hits or [])[0].loginValidation.result == "auth_failed"
    assert m.loginValidated is False


def test_login_validation_proves_validity_strict():
    """authenticated 인데 proves_validity 가 아니면 **모순** — 통째 드롭(fail-closed)."""
    for v in ("true", 1, "yes", None, [1]):
        m = _detail({"hits": [_hit_with(_lp(proves_validity=v))]})
        assert (m.hits or [])[0].loginValidation is None
        assert m.loginValidated is False
    # 성공이 아닌 결과는 proves_validity 없이도 정상 표면화된다.
    m = _detail({"hits": [_hit_with(_lp(result="auth_failed", proves_validity=False))]})
    assert (m.hits or [])[0].loginValidation.result == "auth_failed"


@pytest.mark.parametrize("engine,keep", [
    ("mssql", True), ("postgres", True), (None, True),   # engine 미상은 허용(요약은 유지)
    ("mysql", False), ("oracle", False), ("mssql; DROP", False), ("", False), (7, False),
])
def test_login_validation_engine_allowlist(engine, keep):
    """어휘 밖 engine 은 우리가 아는 프로브 경로가 아니다 → engine 만 비우면 성공 증거가 남아
    헤더 배지까지 켜진다. 통째 드롭해야 한다."""
    m = _detail({"hits": [_hit_with(_lp(engine=engine))]})
    lv = (m.hits or [])[0].loginValidation
    assert (lv is not None) is keep
    assert m.loginValidated is keep
    if keep:
        assert lv.engine == engine


@pytest.mark.parametrize("principal", [
    "realadmin*", "DOMAIN\\administrator*", "*admin", "adm*in*istrator", "ab*cd", "a**b*c",
])
def test_login_validation_near_plaintext_principal_rejected(principal):
    """'별표가 하나라도 있으면 통과' 규칙은 사실상 평문 계정을 노출한다 — 생산자 마스커의
    정확한 형상(가운데 전부 `*`)만 통과시켜 노출을 첫/끝 2글자로 묶는다."""
    m = _detail({"hits": [_hit_with(_lp(principal_masked=principal))]})
    lv = (m.hits or [])[0].loginValidation
    assert lv.principalMasked is None
    assert principal not in _dump(m)


def test_login_validation_survives_hit_cap():
    """검증 hit 이 _HIT_MAX 뒤에 있어도 잘려나가지 않는다(우선 배치)."""
    hits = [{"category": "c", "kind": f"k{i}", "preview": "p"} for i in range(30)]
    hits.append(_hit_with(_lp(), kind="VERIFIED"))
    m = _detail({"hits": hits})
    assert m.loginValidated is True
    assert m.hits[0].kind == "VERIFIED"
    assert len(m.hits) == fr._HIT_MAX


def test_hit_order_unchanged_without_validation():
    """검증 증거가 없으면 기존 표시 순서를 그대로 유지한다(무관한 회귀 금지)."""
    m = _detail({"hits": [{"category": "c", "kind": f"k{i}", "preview": "p"} for i in range(6)]})
    assert [h.kind for h in m.hits] == [f"k{i}" for i in range(6)]


def test_login_validation_accepts_tool_wrapper():
    """도구가 에이전트에 돌려주는 최상위 래퍼({kind,domain,probed,results:[...]})를 LLM 이 그대로
    인용하면 래퍼에는 result 가 없어 배지가 통째로 사라진다 → results[] 로 한 단계(성공 우선)."""
    wrapper = {"kind": "credential_login_probe", "domain": "smb", "probed": 1, "note": "n",
               "results": [{"kind": "credential_login_probe", "result": "error"}, _lp()]}
    m = _detail({"hits": [{"category": "c", "kind": "k", "preview": "p", "validation": wrapper}]})
    assert m.hits[0].loginValidation.result == "authenticated"
    assert m.loginValidated is True


def test_login_validation_accepts_public_dict_key_names():
    """같은 프로브가 두 이름을 쓴다: SMB 영속만 endpoint_host/port, to_public_dict()는 host/port.
    단 `user` 는 **평문 계정**이라 절대 표면화하지 않는다."""
    flat = {"kind": "credential_login_probe", "result": "authenticated", "proves_validity": True,
            "engine": "mssql", "host": "12.98.64.105", "port": 1433, "user": "sa",
            "detail": "login_accepted", "single_attempt": True, "elapsed_ms": 128}
    m = _detail({"hits": [{"category": "c", "kind": "k", "preview": "p", "validation": flat}]})
    lv = m.hits[0].loginValidation
    assert lv.endpoint == "12.98.64.105:1433"
    assert lv.principalMasked is None            # user(평문)를 계정으로 승격하지 않는다
    dumped = _dump(m)
    assert '"user"' not in dumped and '"detail"' not in dumped


@pytest.mark.parametrize("host", [
    "AKIAIOSFODNN7EXAMPLE.corp.example.com",              # AWS 키 형태 라벨
    "deadbeefcafebabe0123456789abcdef.example.com",       # 32자+ hex 라벨
    "a" * 60 + ".example.com",                            # 고엔트로피 긴 라벨
])
def test_login_validation_endpoint_not_a_redact_bypass(host):
    """endpoint 는 이 모듈에서 유일하게 redact 를 안 타는 free-text 가 될 수 있다 — redact 가
    봉인하는 값이면 표시하지 않는다(다른 필드였으면 마스킹됐을 값의 우회 통로 차단)."""
    m = _detail({"hits": [_hit_with(_lp(endpoint_host=host))]})
    lv = m.hits[0].loginValidation
    assert lv.endpoint is None
    assert host not in _dump(m)


def test_login_validation_principal_length_guard_is_fast():
    """redact 의 _EMAIL 정규식은 2차 — 3만자 principal 하나로 게이트웨이가 수 초 멈췄다."""
    import time as _t
    t0 = _t.perf_counter()
    m = _detail({"hits": [_hit_with(_lp(principal_masked="a" * 30000))]})
    elapsed = _t.perf_counter() - t0
    assert m.hits[0].loginValidation.principalMasked is None
    assert elapsed < 0.5, f"principal 길이 가드 없음: {elapsed:.2f}s"


def test_login_proof_multi_prefers_authenticated():
    """legacy multi 에서 첫 dict 를 반환하면 앞선 error 때문에 뒤의 진짜 성공이 묻힌다."""
    legacy = {"kind": "multi", "probes": [
        {"kind": "credential_login_probe", "result": "error"},
        {"kind": "credential_login_probe", "result": "auth_failed"},
        _lp(),
    ]}
    m = _detail({"hits": [{"category": "c", "kind": "k", "preview": "p", "validation": legacy}]})
    assert m.hits[0].loginValidation.result == "authenticated"
    assert m.loginValidated is True


@pytest.mark.parametrize("host,port,out", [
    ("12.98.64.105", 1433, "12.98.64.105:1433"),
    ("db-prod-01.corp.example.com", 5432, "db-prod-01.corp.example.com:5432"),
    ("2001:db8::1", 5432, "[2001:db8::1]:5432"),
    ("[2001:db8::1]", 5432, "[2001:db8::1]:5432"),
    ("012.1.1.1", 1433, None),                    # 8진수 위장 표기 → IP 파싱 실패·FQDN 아님
    ("fe80::1%eth0", 1433, None),                 # scope-id = 임의 원문 채널 → 전면 거부
    ("dbserver", 1433, None),                     # 점 없는 bare hostname → 거부
    ("Host=evil.com;Password=x", 1433, None),     # 주입형 문자열
    ("한글.example.com", 1433, None),              # 비ASCII
    ("-bad.example.com", 1433, None),             # 라벨 하이픈 시작
    ("a" * 300 + ".com", 1433, None),             # 과길이
    ("12.98.64.105", 0, "12.98.64.105"),          # 포트 0 → 포트 없이
    ("12.98.64.105", 70000, "12.98.64.105"),      # 범위 밖
    ("12.98.64.105", "1433", "12.98.64.105"),     # 문자열 포트(엄격)
    ("12.98.64.105", True, "12.98.64.105"),       # bool 배제
    (None, 1433, None), (1433, 1433, None),
])
def test_login_validation_endpoint_strict(host, port, out):
    m = _detail({"hits": [_hit_with(_lp(endpoint_host=host, endpoint_port=port))]})
    assert (m.hits or [])[0].loginValidation.endpoint == out


@pytest.mark.parametrize("principal,out", [
    ("s*a", "s*a"), ("**", "**"), ("a**********r", "a**********r"),
    ("administrator", None),        # 마스킹 표식 없음 → 원본 계정명일 수 있어 드롭
    ("sa", None), ("", None), (None, None), (123, None),
    ("dev.person@corp.example.com", None),   # 이메일(마스킹 표식 없음)
    ("a*b<script>", None),          # 문자셋 밖
])
def test_login_validation_principal_masked_guard(principal, out):
    m = _detail({"hits": [_hit_with(_lp(principal_masked=principal))]})
    assert (m.hits or [])[0].loginValidation.principalMasked == out


def test_login_validation_principal_secret_shaped_dropped():
    m = _detail({"hits": [_hit_with(_lp(principal_masked=PW))]})
    lv = (m.hits or [])[0].loginValidation
    assert lv.principalMasked is None
    assert PW not in _dump(m)


@pytest.mark.parametrize("elapsed,out", [
    (137, 137), (0, 0), (-5, None), (True, None), ("137", None), (10**9, None),
])
def test_login_validation_elapsed_ms(elapsed, out):
    m = _detail({"hits": [_hit_with(_lp(elapsed_ms=elapsed))]})
    assert (m.hits or [])[0].loginValidation.elapsedMs == out


def test_login_validation_flat_and_legacy_multi():
    """중첩 login_probe / 평면 kind / legacy multi 세 shape 모두 인식(스킬 _login_proof_of 동형)."""
    flat = {"hits": [{"category": "c", "kind": "k", "preview": "p", "validation": _lp()}]}
    assert _detail(flat).hits[0].loginValidation.result == "authenticated"
    legacy = {"hits": [{"category": "c", "kind": "k", "preview": "p",
                        "validation": {"kind": "multi", "probes": [{"kind": "other"}, _lp()]}}]}
    assert _detail(legacy).hits[0].loginValidation.result == "authenticated"


def test_login_validation_recursion_bounded():
    """악의적 깊은 중첩이 재귀로 터지지 않는다(깊이 상한 → 조용히 None)."""
    deep = _lp()
    for _ in range(50):
        deep = {"kind": "multi", "probes": [deep]}
    m = _detail({"hits": [{"category": "c", "kind": "k", "preview": "p", "validation": deep}]})
    assert m.hits[0].loginValidation is None
    assert m.loginValidated is False


@pytest.mark.parametrize("validation", [
    None, "login_probe", 42, [], {"login_probe": "yes"}, {"login_probe": []},
    {"kind": "credential_reachability"}, {"kind": "multi", "probes": "nope"},
])
def test_login_validation_malformed_is_none(validation):
    m = _detail({"hits": [{"category": "c", "kind": "k", "preview": "p", "validation": validation}]})
    assert m.hits is not None and len(m.hits) == 1
    assert m.hits[0].loginValidation is None


def test_login_validation_exception_does_not_kill_other_hits(monkeypatch):
    """한 hit 의 예외가 hits 전체를 None 으로 날리면 기존 증거가 통째 사라진다(무증상 회귀)."""
    def boom(h):
        if h.get("kind") == "bad":
            raise RuntimeError("x")
        return None
    monkeypatch.setattr(fr, "_project_login_validation", boom)
    m = _detail({"hits": [{"category": "c", "kind": "bad", "preview": "p1"},
                          {"category": "c", "kind": "ok", "preview": "p2"}]})
    assert m.hits is not None and [h.kind for h in m.hits] == ["bad", "ok"]


def test_login_validation_keeps_hit_without_text():
    """텍스트가 비어도 검증 증거가 있으면 hit 을 살린다(증거 소실 방지)."""
    m = _detail({"hits": [{"category": "", "kind": "", "preview": "", "validation": {"login_probe": _lp()}}]})
    assert m.hits is not None and len(m.hits) == 1
    assert m.hits[0].loginValidation.result == "authenticated"


def test_login_validated_flag_only_from_projected_hits():
    """화이트리스트를 통과 못한 값이 finding 단위 플래그로 되살아나지 않는다."""
    m = _detail({"hits": [_hit_with(_lp(result="skipped_repeat"))]})
    assert m.hits[0].loginValidation is None and m.loginValidated is False


# ── kind/식별자 보존(과마스킹 금지) ──
def test_kind_identifiers_preserved():
    extra = {"hits": [{"category": "secret", "kind": k, "preview": "p"}
                      for k in ("generic_password_assignment", "private_key_block", "aws_access_key_id")]}
    m = _detail(extra)
    kinds = [h.kind for h in (m.hits or [])]
    assert kinds == ["generic_password_assignment", "private_key_block", "aws_access_key_id"]


# ── commit: 유효 hex 보존, 그 외 마스킹 ──
def test_commit_hex_preserved_others_masked():
    good = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
    m = _detail({"metadata": {"commit": good}})
    assert m.metadata is not None and m.metadata.commit == good  # 엔트로피 마스킹에 파괴되지 않음
    bad = _detail({"metadata": {"commit": f"not-a-commit-{SEC}"}})
    assert bad.metadata is None or SEC not in _dump(bad)


# ── URL 살균: scheme/userinfo/query/fragment ──
def test_pivot_url_sanitized():
    extra = {"pivot": {"exposed_count": 0, "probes": [
        {"url": f"https://user:{PW}@10.0.0.1:8443/admin/panel?token={SEC}#frag",
         "status": 200, "exposed": True, "content_type": "text/html", "evidence_masked": "b"},
        {"url": "ftp://evil/x", "status": 200, "exposed": True},          # 비허용 scheme → skip
        {"url": "not a url", "status": 0, "exposed": False},              # 파싱실패 → skip
    ]}}
    m = _detail(extra)
    assert m.pivot is not None and len(m.pivot.probes) == 1
    url = m.pivot.probes[0].url
    assert url == "https://10.0.0.1:8443/admin/panel"  # userinfo/query/fragment 제거
    assert PW not in url and SEC not in url


def test_pivot_error_shaped_is_none():
    assert _detail({"pivot": {"version": 1, "error": "boom"}}).pivot is None
    assert _detail({"pivot": {"version": 1}}).pivot is None  # probes 없음


def test_pivot_http_status_validated():
    extra = {"pivot": {"exposed_count": 0, "probes": [
        {"url": "https://h/a", "status": "200 OK; DROP TABLE", "exposed": False},  # 비정상 → 000
        {"url": "https://h/b", "status": 404, "exposed": False},
        {"url": "https://h/c", "status": 999, "exposed": False},                    # 범위밖 → 000
    ]}}
    m = _detail(extra)
    statuses = [p.status for p in (m.pivot.probes if m.pivot else [])]
    assert statuses == ["000", "404", "000"]


# ── confidence 검증 ──
def test_confidence_validation():
    assert _detail({"confidence": 0.75}).confidence == 0.75
    assert _detail({"confidence": 1}).confidence == 1.0
    assert _detail({"confidence": True}).confidence is None       # bool 배제
    assert _detail({"confidence": 1.5}).confidence is None        # 범위밖
    assert _detail({"confidence": -0.1}).confidence is None
    assert _detail({"confidence": float("nan")}).confidence is None
    assert _detail({"confidence": float("inf")}).confidence is None
    assert _detail({"confidence": "0.9"}).confidence is None      # 문자열 배제


def test_asset_count_validation():
    assert _detail({"asset_count_scanned": 5}).assetCountScanned == 5
    assert _detail({"asset_count_scanned": 0}).assetCountScanned == 0
    assert _detail({"asset_count_scanned": -1}).assetCountScanned is None
    assert _detail({"asset_count_scanned": True}).assetCountScanned is None
    assert _detail({"asset_count_scanned": "5"}).assetCountScanned is None


# ── 캡/절단 ──
def test_caps_enforced():
    extra = {
        "hits": [{"category": "s", "kind": "k", "preview": "x" * 500} for _ in range(50)],
        "recommended_actions": ["a" * 999 for _ in range(50)],
        "pivot": {"exposed_count": 0, "probes": [
            {"url": f"https://h/{i}", "status": 200, "exposed": False} for i in range(50)]},
        "evidence_notes": {f"loc{i}": {"what_this_is": "w"} for i in range(50)},
    }
    m = _detail(extra)
    assert m.hits is not None and len(m.hits) == 20
    assert all(len(h.preview) <= 240 for h in m.hits)
    assert m.recommendedActions is not None and len(m.recommendedActions) == 20
    assert all(len(a) <= 400 for a in m.recommendedActions)
    assert m.pivot is not None and len(m.pivot.probes) == 12
    assert m.evidenceNotes is not None and len(m.evidenceNotes) == 20


def test_mask_before_truncate():
    # 시크릿이 절단 경계를 걸치게 배치 — 자르고 마스킹하면 토큰이 짧아져 누수. 마스킹→절단이면 안전.
    filler = "x" * 235
    extra = {"hits": [{"category": "s", "kind": "k", "preview": filler + SEC}]}  # 235+20=255>240
    m = _detail(extra)
    assert m.hits is not None
    assert SEC not in m.hits[0].preview  # 경계 걸친 SEC 도 마스킹됨
    assert SEC[:5] not in m.hits[0].preview


# ── 제로폭/BIDI/제어문자 ──
def test_zero_width_and_control_chars():
    zw = "AKIA​IOSFODNN7EXAMPLE"       # 제로폭 삽입으로 패턴 우회 시도
    bidi = "secret‮ZZZ"
    ctl = "tok\x00\x07en"
    extra = {"hits": [
        {"category": "s", "kind": "k", "preview": zw},
        {"category": "s", "kind": "k", "preview": bidi},
        {"category": "s", "kind": "k", "preview": ctl},
    ]}
    dumped = _dump(_detail(extra))
    assert "AKIAIOSFODNN7EXAMPLE" not in dumped  # 제로폭 제거 후 마스킹됨
    assert "‮" not in dumped and "\x00" not in dumped and "\x07" not in dumped


# ── redact_deep fail-closed ──
def test_redact_deep_cycle_and_depth():
    d = {}
    d["self"] = d
    assert redact_deep(d) == {"self": "«마스킹»"}
    deep = cur = {}
    for _ in range(30):
        cur["n"] = {}
        cur = cur["n"]
    out = redact_deep(deep)
    assert isinstance(out, dict)  # 크래시 없이 fail-closed


def test_redact_deep_unsupported_type_no_str():
    class Weird:
        def __repr__(self):
            return f"secret={PW}"
    out = redact_deep({"x": Weird()})
    assert out == {"x": "«마스킹»"}  # str()/repr() 호출 안 함 → PW 안 샘
    assert PW not in json.dumps(out)


# ── 정상 값 보존(과마스킹 회귀) ──
def test_clean_values_preserved():
    m = _detail({
        "verification": {"status": "historical_only", "method": "git_history"},
        "metadata": {"source": "history", "scan_method": "clone_scan"},
        "hits": [{"category": "secret", "kind": "exposed_file", "preview": "config.yaml present"}],
    })
    assert m.verification is not None and m.verification.status == "historical_only"
    assert m.metadata is not None and m.metadata.source == "history"
    assert m.hits is not None and m.hits[0].kind == "exposed_file"


# ── base free-text 재마스킹(asset/summary/owner) ──
def test_base_columns_remasked():
    m = _detail({}, asset=f"host path={PW}", summary=f"leaked {SEC}",
                owner=EMAIL, ticket_ref="OK-123")
    dumped = _dump(m)
    assert PW not in dumped and SEC not in dumped and "dev.person" not in dumped
    assert m.ticketRef == "OK-123"


# ── evidence_notes dict 키 redact ──
def test_evidence_note_key_redacted():
    m = _detail({"evidence_notes": {f"https://x/{SEC}?p={PW}": {"what_this_is": "creds"}}})
    assert m.evidenceNotes is not None
    loc = m.evidenceNotes[0].location
    assert SEC not in loc and PW not in loc


# ── redact() 스탠드얼론 회귀(codex D5: 짧은 시크릿·bearer·URL creds) ──
@pytest.mark.parametrize("raw,secret", [
    ("password: S3cr3tValue123", "S3cr3tValue123"),
    ("Bearer abcDEF1234567890xyz", "abcDEF1234567890xyz"),
    ("db_password=hunter2Pass", "hunter2Pass"),
    ("aws_secret_access_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"),
    ("https://user:p4ssw0rd@host/x", "p4ssw0rd"),
])
def test_redact_known_secret_forms(raw, secret):
    out = redact(raw)
    assert secret not in out, f"{raw!r} → {out!r}"


# ── 적대 감사 반영: 단일 케이스 hex/base32 토큰 누출 ──
@pytest.mark.parametrize("secret", [
    "deadbeefdeadbeefdeadbeefdeadbeef",       # 32자 all-lowercase hex(키 재료)
    "DEADBEEFDEADBEEFDEADBEEFDEADBEEF",       # 32자 all-uppercase hex
    "JBSWYDPEHPKPXPJBSWYDPEHPKPXP",           # 28자 all-uppercase base32(TOTP형·digit無)
])
def test_single_case_token_masked(secret):
    # 키워드 없이 free-text 에 등장해도 봉인(구멍이던 케이스). preview·metadata 양쪽 확인.
    assert secret not in (redact(f"found {secret} here") or "")
    m = _detail({"hits": [{"category": "s", "kind": "k", "preview": f"val {secret}"}],
                 "metadata": {"repo": secret}})
    assert secret not in _dump(m)


def test_dictionary_word_still_preserved():
    # 과마스킹 회귀 방지: hex/base32 밖 문자를 포함한 단일 케이스 단어는 보존.
    for w in ("supercalifragilisticexpialidocious", "generic_password_assignment", "internaldocumentation"):
        assert w in (redact(f"note {w} end") or "")


def test_cred_url_empty_username_masked():
    # scheme://:password@host (username 없는 password-only) 형태.
    for raw, sec in [("redis://:MyR3disPass@redishost", "MyR3disPass"),
                     ("postgres://:s3cr3tpw@db", "s3cr3tpw")]:
        assert sec not in (redact(f"conn {raw} ok") or "")


def test_underscore_glued_token_masked():
    # ghp_/xoxb_ 처럼 밑줄에 붙은 고엔트로피부(\b 가 밑줄을 경계로 안 봐 놓치던 구멍).
    for sec in ("ghp_16CharsAndMoreToken1234567890abcd", "xoxb_1234_ABCDefGHijkLMNopQRstUV"):
        assert sec not in (redact(f"token {sec} here") or "")
        m = _detail({"hits": [{"category": "s", "kind": "k", "preview": f"tok {sec}"}]})
        assert sec not in _dump(m)


def test_repo_and_path_preserved():
    # 라이브 관측: repo/파일경로는 시크릿이 아니라 UI가 봐야 할 식별자 — `/` 를 토큰 문자에서 빼
    # 과마스킹(Platform-Backend/PlatformAPI 통째 봉인)을 해소. 값 그대로 노출돼야 한다.
    m = _detail({"metadata": {"repo": "Platform-Backend/PlatformAPI",
                              "path": "src/PlatformAPICore/assets/base_contents/deployment_file.py"}})
    assert m.metadata is not None
    assert m.metadata.repo == "Platform-Backend/PlatformAPI"
    assert m.metadata.path == "src/PlatformAPICore/assets/base_contents/deployment_file.py"


def test_hex_glued_to_separator_masked():
    # 구분자(/-)에 붙은 32자 hex(키 재료) — _TOKEN_RUN 우회분을 _HEX16 이 봉인.
    hx = "deadbeefdeadbeefdeadbeefdeadbeef"
    for raw in (f"/path/{hx}", f"loc-{hx}", f"https://h/{hx}"):
        assert hx not in (redact(raw) or "")
    m = _detail({"hits": [{"category": "s", "kind": "k", "preview": "p", "location": f"/p/{hx}"}],
                 "target": f"https://t/{hx}",
                 "evidence_notes": {f"loc-{hx}": {"what_this_is": "w"}}})
    assert hx not in _dump(m)


# ── 적대 감사 반영: pivot URL 잘못된 포트 → 500 금지(probe skip) ──
@pytest.mark.parametrize("bad_url", [
    "http://internal.host:99999/admin",   # 포트 범위밖
    "http://internal.host:notaport/x",    # 비정수 포트
    "http://[::1]:x/",                     # IPv6 + 잘못된 포트
])
def test_sanitize_url_bad_port_no_crash(bad_url):
    # _sanitize_url 은 None(라우트 500 금지), _to_finding_detail 도 예외 없이 완주.
    assert fr._sanitize_url(bad_url) is None
    m = _detail({"pivot": {"exposed_count": 0, "probes": [
        {"url": bad_url, "status": 200, "exposed": True},
        {"url": "https://ok.host/a", "status": 200, "exposed": False}]}})
    assert isinstance(m, GatewayFindingDetail)
    urls = [p.url for p in (m.pivot.probes if m.pivot else [])]
    assert bad_url.split("//")[1].split(":")[0] not in " ".join(urls) or "ok.host" in " ".join(urls)


# ── 적대 감사 반영: commit hex passthrough — 정규 SHA 길이만 보존 ──
def test_commit_length_gating():
    sha1 = "a" * 40
    sha256 = "b" * 64
    short = "abc1234"
    secret32 = "0123456789abcdef0123456789abcdef"  # 32자 hex = 흔한 시크릿 길이 → 보존 금지
    assert _detail({"metadata": {"commit": sha1}}).metadata.commit == sha1
    assert _detail({"metadata": {"commit": sha256}}).metadata.commit == sha256
    assert _detail({"metadata": {"commit": short}}).metadata.commit == short
    m = _detail({"metadata": {"commit": secret32}})
    assert m.metadata is None or secret32 not in _dump(m)  # 32자는 마스킹됨


# ── 적대 감사 반영: 초대형 invalid 소스 리스트 — 스캔 상한(DoS) ──
def test_scan_cap_bounds_work():
    huge = [{"junk": True} for _ in range(200_000)] + [{"category": "s", "kind": "k", "preview": "real"}]
    m = _detail({"hits": huge})
    # 유효 hit 이 스캔 상한(_SCAN_MAX=500) 밖에 있어 안 잡혀도, 크래시 없이 완주하고 캡 준수.
    assert isinstance(m, GatewayFindingDetail)
    assert m.hits is None or len(m.hits) <= 20


def test_projection_exception_fails_closed_to_base(monkeypatch):
    # 어떤 투영이 예기치 못하게 raise 해도 500 이 아니라 base finding 으로 강등.
    def boom(_extra):
        raise RuntimeError("unexpected")
    monkeypatch.setattr(fr, "_project_hits", boom)
    m = _detail({"hits": [{"category": "s", "kind": "k", "preview": "x"}], "confidence": 0.5})
    assert isinstance(m, GatewayFindingDetail)
    assert m.hits is None                     # 해당 필드만 소실(_safe 격리)
    assert m.confidence == 0.5                # 나머지 리치필드는 정상
