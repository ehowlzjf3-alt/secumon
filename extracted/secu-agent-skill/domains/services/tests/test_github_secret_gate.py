"""github 시크릿 정오탐 게이트 — 두 생성 경로 공용 규칙의 계약 고정.

배경: 게이트를 clone 스캐너(`scanner.py`)에만 달았는데 실제로 도는 건 LLM 워커 경로
(`service_task_tools`, source='github_task_scan')였다. 그 경로로 오탐 149건이 들어왔다.
여기서는 ①규칙 자체 ②두 경로가 같은 규칙을 쓰는지 ③confluence 에 새지 않는지를 고정한다.

masked 샘플은 전부 **실제 오탐 데이터에서 가져온 형태**다.
"""
from __future__ import annotations

import pytest

from domains.services.github.application import secret_gate


# ── 규칙 자체 ────────────────────────────────────────────────────────────
@pytest.mark.parametrize("kind,masked,path", [
    ("github_pat", "ghp_****abcd", "src/main.py"),          # 확장자·코드경로 무관 통과
    ("private_key_block", "----****----", "docs/readme.md"),
    ("database_url_with_password", "post****5432", "conf/app.java"),
])
def test_structured_secrets_pass_regardless_of_code_path(kind, masked, path):
    """구조화 시크릿은 `_CODE_OR_SAMPLE_PATH_RE`(확장자·docs) 로 죽이지 않는다.

    ⚠️ v3.94 에서 이 계약이 **한 가지만** 좁아졌다: 픽스처/샘플/벤더 경로는 예외다
    (`test_structured_secrets_rejected_in_fixture_or_vendor_paths`). 원래 이 케이스에
    `test/conf.java` 가 있었는데, 그 경로가 정확히 오탐 #18788 의 모양이라 옮겼다.
    """
    assert secret_gate.is_reportable_secret(kind, masked, path) is True


@pytest.mark.parametrize("kind", ["email", "person_name_with_label", "person_name"])
def test_low_value_pii_never_a_github_secret(kind):
    assert secret_gate.is_reportable_secret(kind, "a***@b.com", "conf/app.yml") is False


@pytest.mark.parametrize("masked", [
    "$(_r*****oken",        # shell 명령치환
    "$(ge****ken)",
    "$(py****3 -c",
    "${AB****CDE}",
    "__DS*************EN__",  # 템플릿 플레이스홀더
    "__GE***********RD__",
    "max_**kens",             # ML/파서 어휘
    "args*******kens",
    "num_******kens",
])
def test_code_shaped_values_rejected_even_without_path(masked):
    """path='' (commit_patch) 라 경로 규칙이 발화 못 해도 값 형상으로 잡아야 한다."""
    assert secret_gate.is_reportable_secret(
        "generic_password_assignment", masked, "") is False


@pytest.mark.parametrize("masked", [
    "N7Q9****sD8f",   # 고엔트로피 토큰이 하필 n/N 으로 시작
    "num1****xyz9",
    "maxi****9876",
    "self****4321",
    "context-aware-secret",
])
def test_non_credential_vocab_rule_does_not_eat_real_secrets(masked):
    """어휘 규칙은 '어휘로 시작 + 토큰이름으로 끝남'을 **둘 다** 요구해야 한다.

    초안이 접두만 봐서 `N7Q9pL4x…` 류 고엔트로피 시크릿을 전부 죽였다
    (`test_github_task_scan_high_entropy_enabled_for_api_artifacts` 가 잡음).
    """
    assert secret_gate.is_reportable_secret("high_entropy_string", masked, "config/prod.env") is True


def test_generic_keyname_in_source_path_rejected():
    assert secret_gate.is_reportable_secret(
        "generic_password_assignment", "abcd****wxyz", "src/Main.java") is False


def test_generic_keyname_in_real_config_kept():
    """진짜 있을 법한 곳(운영 설정)의 generic 매치는 남긴다 — 과차단 방지."""
    assert secret_gate.is_reportable_secret(
        "generic_password_assignment", "abcd****wxyz", "deploy/prod.properties") is True


def test_unknown_kind_conservative_keep():
    assert secret_gate.is_reportable_secret("brand_new_kind", "abcd****wxyz", "a/b.properties") is True


def test_kill_switch_passes_everything(monkeypatch):
    monkeypatch.setenv("SA_GITHUB_SECRET_GATE", "0")
    assert secret_gate.is_reportable_secret("email", "a***@b.com", "docs/x.md") is True


# ── any_reportable_hit ───────────────────────────────────────────────────
def test_any_hit_passing_keeps_the_finding():
    hits = [
        {"kind": "email", "masked": "a***@b.com"},
        {"kind": "github_pat", "masked": "ghp_****abcd"},   # 이거 하나로 유지
    ]
    assert secret_gate.any_reportable_hit(hits, "docs/x.md") is True


def test_all_hits_failing_drops_the_finding():
    hits = [
        {"kind": "email", "masked": "a***@b.com"},
        {"kind": "generic_password_assignment", "masked": "$(ge****ken)"},
    ]
    assert secret_gate.any_reportable_hit(hits, "") is False


def test_no_hits_is_not_this_gates_business():
    """hit 없는 finding 판정은 코어 judge 소관 — 여기서 죽이지 않는다."""
    assert secret_gate.any_reportable_hit([], "docs/x.md") is True


def test_accepts_objects_not_just_dicts():
    class H:
        kind = "github_pat"
        masked = "ghp_****abcd"
    assert secret_gate.any_reportable_hit([H()], "src/a.py") is True


# ── 두 경로가 같은 규칙을 쓰는지 ─────────────────────────────────────────
def test_the_scanner_path_is_gone_entirely():
    """★ 스캐너 결정론 경로가 **삭제됐다** (2026-08-27).

    예전엔 `scanner._is_reportable_secret` 이 공유 게이트에 위임하는지 확인했다.
    그 경로 자체가 사라졌다 — 정규식 스캔 결과를 `finding_upsert` 로 바로 넣어
    LLM 판정을 건너뛰었기 때문이다(그렇게 들어온 27,414건 중 판정을 거친 것은 7건).

    게이트가 붙어 있느냐보다 **경로가 없느냐**가 더 강한 보장이다. 규칙은 통과해도
    "에이전트가 판단했다" 는 아니었다.
    """
    from domains.services.github.application import scanner

    for gone in ("_is_reportable_secret", "_persist_scan_findings", "scan_repo_target"):
        assert not hasattr(scanner, gone), f"결정론 경로가 되살아났다: {gone}"
    # 규칙 본체는 여전히 한 곳이어야 한다 — 사본을 만들면 또 어긋난다.
    assert not hasattr(scanner, "_STRUCTURED_SECRET_KINDS")


def test_service_task_path_applies_gate():
    from domains.services.plugin.tools import service_task_tools as stt

    art = stt._Artifact(
        task_type="github", asset="gh://o/r", asset_kind="repository_file",
        label="o/r", text="", metadata={"path": "docs/guide.md"},
    )
    fp = [{"kind": "generic_password_assignment", "masked": "$(ge****ken)"}]
    real = [{"kind": "github_pat", "masked": "ghp_****abcd"}]
    assert stt._github_secret_gate_pass(art, fp) is False
    assert stt._github_secret_gate_pass(art, real) is True


def test_confluence_is_never_gated_by_github_rules():
    """⚠️ 계약: confluence 근거는 위키 본문이라 .md 제외 규칙을 먹이면 전량 사라진다.

    `_persist_scanned_findings` 는 task_type=='github' 일 때만 게이트를 태운다.
    여기서는 그 조건이 실제로 confluence 를 살려두는지 규칙 수준에서 확인한다.
    """
    from domains.services.plugin.tools import service_task_tools as stt

    cf_hits = [{"kind": "generic_password_assignment", "masked": "abcd****wxyz"}]
    cf_art = stt._Artifact(
        task_type="confluence", asset="cf://SPACE/1", asset_kind="wiki_page",
        label="page", text="", metadata={"path": "page.md"},
    )
    gh_art = stt._Artifact(
        task_type="github", asset="gh://o/r", asset_kind="repository_file",
        label="o/r", text="", metadata={"path": "page.md"},
    )
    # 같은 hit·같은 path 라도 github 이면 .md 규칙에 걸려 떨어진다
    assert stt._github_secret_gate_pass(gh_art, cf_hits) is False
    # confluence 는 애초에 이 게이트를 태우지 않는다는 것이 계약(호출부 조건)
    src = stt._persist_scanned_findings.__code__.co_consts
    assert any(c == "github" for c in src if isinstance(c, str)), (
        "_persist_scanned_findings 에서 task_type=='github' 한정 조건이 사라졌다"
    )


# ── v3.92 보강 규칙 2차 ──────────────────────────────────────────────────
# masked 는 전부 **실측 데이터**(2026-07-29 통과 hit 10,099건 역적용)에서 가져왔다.
@pytest.mark.parametrize("masked,rule", [
    # R-a 코드 구두점 종결
    ("this**************mon[", "code_punctuation_tail"),
    ("os.e*************D'),", "code_punctuation_tail"),
    ("Bear*************ing)", "code_punctuation_tail"),
    # R-b 코드 연산자/호출/정규식 리터럴
    ("os.e********et(\\", "code_operator_in_value"),
    ("/\\b(**********\\b/i", "code_operator_in_value"),
    # `||` 는 R-a(꼬리)와 R-b(연산자) 양쪽에 걸린다 — 판정 순서상 R-a 가 사유가 된다.
    ("meta********d ||", "code_punctuation_tail"),
    # R-c 근거 0
    ("********", "fully_masked_no_evidence"),
])
def test_code_shaped_values_are_rejected(masked, rule):
    assert secret_gate._code_shaped_value(masked) == rule
    assert secret_gate.is_reportable_secret(
        "generic_config_secret_assignment", masked, "config/app.conf") is False


@pytest.mark.parametrize("masked", [
    "1q2w*e4r!",        # 실제 비밀번호 — `!` 종결
    "post***s12!",      # 실제 비밀번호 — `!` 종결
    "qkzF********zg==", # base64 값 — `==` 는 패딩이지 연산자가 아니다
    "sha5********Ww==",
    "ABCD********9+/=", # base64 알파벳/패딩
])
def test_real_secret_shapes_are_not_rejected_by_the_new_rules(masked):
    """⚠️ 초안 규칙이 죽였던 값들이다.

    `!`/`?` 를 코드 구두점에 넣으면 **비밀번호 특수문자**를 죽이고,
    `==`/`++` 를 연산자에 넣으면 **base64 패딩**을 죽인다. 둘 다 실측으로 잡혔다.
    규칙 문자는 base64 문자집합과 비밀번호 특수문자에 없는 것만 써야 한다.
    """
    assert secret_gate._code_shaped_value(masked) is None


@pytest.mark.parametrize("path,excluded", [
    ("install/recon/llm_usage.mjs", True),    # v3.92 추가 — 이게 없어서 27건이 샜다
    ("scripts/dispatch.cjs", True),
    ("src/types.mts", True),
    ("src/types.cts", True),
    ("src/app.js", True),                     # 기존
    ("config/prod.env", False),               # 진짜 시크릿이 사는 곳 — 제외하면 안 된다
    ("application.yml", False),
    ("terraform.tfvars", False),
])
def test_esm_extensions_join_the_code_path_rule(path, excluded):
    """`js|ts` 는 있는데 `mjs|cjs` 만 빠져 있었다 — 같은 언어의 확장자다.

    ⚠️ `.env`/`.yml`/`.tfvars` 는 **절대 넣으면 안 된다**. 진짜 시크릿이 거기 산다.
    """
    hit = bool(secret_gate._CODE_OR_SAMPLE_PATH_RE.search(path))
    assert hit is excluded


# ── v3.94 fixture/vendor 경로 + location 정규화 ──────────────────────────
@pytest.mark.parametrize("path", [
    "tests/test_search_compressor.py",                       # 실측 오탐 #18788
    "test/conf.java",
    "src/__tests__/auth.spec.ts",
    "spec/models/user_spec.rb",
    "backend/test_settings.py",
    "internal/server_test.go",
    "conftest.py",
    ".env.example",                                          # 실측 오탐 #18693
    "config/app.yml.sample",
    "Engine/Plugins/Firebase/Source/ThirdParty/IOS/include/FIROptions.h",  # 실측 #18823
    "vendor/github.com/aws/creds.go",
    "web/node_modules/pkg/config.js",
    "ios/Pods/Firebase/opts.h",
])
def test_structured_secrets_rejected_in_fixture_or_vendor_paths(path):
    """v3.94 계약 변경 — 픽스처/샘플/벤더 경로는 **구조화 시크릿이라도** 우리 노출이 아니다.

    이 세 경로 모양이 submit_finding 경로 오탐 3건의 실제 정체였다. 값 형상이
    진짜처럼 생겨서(`postgres://…`·`AIzaSy…`) 코어 값-형상 계약으로는 못 걸렀다.
    """
    assert secret_gate.is_reportable_secret(
        "database_url_with_password", "post****5432", path) is False
    assert secret_gate.is_reportable_secret(
        "google_api_key", "AIzaSy***********", path) is False


@pytest.mark.parametrize("path", [
    "javasource/ds_simplesaml/onelogin/saml2/util/Util.java",  # KEEP #18333
    "confluence-curation/scripts/feedback_store.py",           # KEEP #18393
    "config/prod.env",
    "deploy/prod.properties",
    "terraform.tfvars",
    "src/latest/main.py",          # 'test' 가 부분문자열로 들어간 경로 아님 확인
    "protests/summary.md",         # `tests/` 가 디렉터리 경계 없이 붙은 경우
    "src/contest_runner.py",       # `test_` 접두가 파일명 시작이 아닌 경우
    "vendors/report.env",          # `vendor/` 아님(복수형 디렉터리 오탐 방지)
])
def test_fixture_rule_is_narrow_enough_not_to_eat_real_paths(path):
    """⚠️ 이 규칙이 넓어지면 진짜가 죽는다.

    `_CODE_OR_SAMPLE_PATH_RE`(확장자 포함)를 그대로 구조화 시크릿에 먹이면
    **#18333(진짜 private key, `.java`)** 이 즉시 죽는다. 그래서 확장자는 넣지 않고
    디렉터리 경계·파일명 규약·샘플 접미만 본다. 부분문자열 매칭도 금지.
    """
    assert not secret_gate._FIXTURE_OR_VENDOR_PATH_RE.search(path), (
        f"fixture/vendor 규칙이 너무 넓다 — {path} 를 잡았다"
    )


@pytest.mark.parametrize("kind", [
    "kr_rrn", "credit_card", "bank_account_with_label", "kr_phone", "passport",
])
def test_fixture_rule_never_suppresses_hard_guarded_pii(kind):
    """⚠️ 코어 계약: 진짜 민감 PII 는 **어떤 등록 정책도 제외할 수 없다**
    (`evidence_judgment._is_identifier_only_pii` 의 SAFETY-KEEP 하드 가드).

    이 게이트는 시크릿 정오탐 전용이므로 PII 판단을 가로채면 안 된다.
    실측으로 잡힌 사례: `output/test_20250918_201202.csv`(계측 결과 CSV) 5,007건이
    파일명 `test_` 접두만으로 fixture 규칙에 걸렸다. 이미 false_positive 로 정리된
    건이라 실해는 없었지만 규칙이 RRN 을 죽일 수 있다는 것 자체가 계약 위반이다.
    """
    assert secret_gate.is_reportable_secret(
        kind, "5455****3210", "output/test_20250918_201202.csv") is True
    assert secret_gate.is_reportable_secret(
        kind, "5455****3210", "vendor/lib/data.csv") is True


@pytest.mark.parametrize("location,expected", [
    # submit_finding 경로: 전체 blob URL + 라인 앵커
    ("https://github.samsungds.net/mira-eom/mirror-headroom/blob/main/tests/t.py#L60",
     "tests/t.py"),
    ("https://github.samsungds.net/o/r/blob/master/servicehub/.env.dev", "servicehub/.env.dev"),
    ("https://github.samsungds.net/o/r/raw/main/a/b.py?raw=1", "a/b.py"),
    ("https://github.samsungds.net/o/r/blame/main/a/b.py", "a/b.py"),
    # scan 경로 asset 표기
    ("github:o/r/src/main.py", "src/main.py"),
    ("github:o/r/commit/d57d126dcb7d:config.txt", "config.txt"),
    # 이미 상대경로면 no-op (스캔 경로 byte-for-byte 동일 보장)
    ("tests/t.py", "tests/t.py"),
    ("", ""),
    # blob URL 이 아닌 노출 URL — host 만 벗기고 보존(KEEP #18562)
    ("https://h3cln.cdep.samsungds.net/.git/config", ".git/config"),
])
def test_repo_relative_path_normalizes_locations(location, expected):
    """정규화가 없으면 `#L60` 때문에 접미 규칙이 **조용히 발화하지 않는다**.

    오탐이 통과한 실제 원인 중 하나 — 규칙은 있는데 입력 모양이 달라서 안 걸린 것.
    """
    assert secret_gate.repo_relative_path(location) == expected


def test_submit_path_location_url_is_actually_gated():
    """정규화 + 규칙이 **엔드투엔드로** 붙었는지 — 오탐 3건의 실제 location 으로 확인."""
    for location in (
        "https://github.samsungds.net/mira-eom/mirror-headroom/blob/main/"
        "tests/test_search_compressor.py#L60",
        "https://github.samsungds.net/NeuralGraphics/NSD_DB/blob/main/Engine/Plugins/"
        "Runtime/Firebase/Source/ThirdParty/IOS/include/FIROptions.h",
        "https://github.samsungds.net/jong-hun-lee/gitdiagram/blob/main/.env.example",
    ):
        assert secret_gate.is_reportable_secret(
            "database_url_with_password", "post****5432", location) is False


def test_new_rules_keep_the_human_confirmed_real_findings():
    """회수 검산 — 사람이 KEEP 판정한 4건(#18333 #18343 #18393 #18562)의 hit 형상.

    실측 역적용에서 이 6개 hit 은 전부 생존했다(finding 유지 9881→9817, 진짜는 0건 제거).
    """
    survivors = [
        ("private_key_block", "----*******----", "javasource/.../Util.java"),
        ("github_pat", "ghp_******scAP", "confluence-curation/scripts/feedback_store.py"),
        ("database_url_with_password", "post******ndix", ""),
        ("github_pat", "ghp_******F1IO", ""),
    ]
    for kind, masked, path in survivors:
        assert secret_gate.is_reportable_secret(kind, masked, path) is True, (
            f"진짜 시크릿 {kind} 를 새 규칙이 죽였다"
        )


# ── 공개 인증서 자료 (2026-08-16, finding #18900) ────────────────────────────
# PEM 인증서 한 덩어리를 detector 가 high_entropy_string 8조각으로 쪼갠다. 8개의 비밀이
# 아니라 하나의 인증서다. 인증서는 공개가 전제고 유출되는 건 개인키다.
# ⚠️ 개인키가 한 조각이라도 섞이면 절대 제외하면 안 된다 — KEEP #18333 이 그 경우다.

_CERT_PEM = (
    "-----BEGIN CERTIFICATE-----\n"
    "MIIERTCCAy2gAwIBAgIJAPirWAe96NTFMA0GCSqGSIb3DQEBCwUAMIG4MQswCQYD\n"
    "VQQGEwJLUjERMA8GA1UECAwISHdhc2VvbmcxFDASBgNVBAcMC0Jhbndvbc1kb25n\n"
    "-----END CERTIFICATE-----\n"
)
_PRIVATE_KEY_PEM = (
    "-----BEGIN RSA PRIVATE KEY-----\n"
    "MIIEowIBAAKCAQEAyzL9wQ8vJ2n0aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4\n"
    "-----END RSA PRIVATE KEY-----\n"
)
# #18900 의 실제 hit 형상 — 마스킹된 base64 조각이라 조각만 보면 인증서인지 알 수 없다.
_CERT_BODY_FRAGMENTS = [
    {"kind": "high_entropy_string", "masked": "MIIE" + "*" * 56 + "CQYD"},
    {"kind": "high_entropy_string", "masked": "VQQG" + "*" * 56 + "b25n"},
]


def test_certificate_body_fragments_are_not_secrets_when_document_is_given():
    """#18900 재현 — 인증서만 든 파일의 고엔트로피 조각은 finding 이 되면 안 된다."""
    assert secret_gate.any_reportable_hit(
        _CERT_BODY_FRAGMENTS, "ca-cert.pem", document=_CERT_PEM) is False


def test_private_key_in_the_same_document_defeats_the_certificate_rule():
    """★ 개인키가 섞이면 인증서 규칙이 발동하면 안 된다. 이 순서를 뒤집으면 진짜가 죽는다."""
    mixed = _CERT_PEM + _PRIVATE_KEY_PEM
    assert secret_gate.is_public_certificate_material(mixed) is False
    assert secret_gate.any_reportable_hit(
        _CERT_BODY_FRAGMENTS, "ca-cert.pem", document=mixed) is True


def test_real_secret_inside_a_certificate_file_still_reports():
    """인증서 파일이라고 전부 봐주지 않는다 — 섞여 있는 진짜 키는 계속 잡는다."""
    hits = _CERT_BODY_FRAGMENTS + [
        {"kind": "aws_secret_access_key", "masked": "AKIA1234567890ABCDEF"},
    ]
    assert secret_gate.any_reportable_hit(hits, "ca-cert.pem", document=_CERT_PEM) is True


def test_certificate_rule_is_inert_without_the_document():
    """본문을 못 구하는 호출부(clone 스캐너)는 기존 동작 그대로 — 무영향이어야 한다."""
    assert secret_gate.any_reportable_hit(_CERT_BODY_FRAGMENTS, "ca-cert.pem") is True


def test_submit_path_rejects_certificate_values_but_not_private_keys():
    """submit 경로는 모델이 값 전문을 담으므로 masked 만으로 판정된다."""
    loc = "https://github.samsungds.net/jerryan-leem/pub/blob/main/ca-cert.pem"
    assert secret_gate.is_reportable_submitted_secret("certificate", _CERT_PEM, loc) is False
    # 개인키가 섞였거나 kind 가 개인키면 통과해야 한다(모델이 kind 를 지어내도 값이 이긴다).
    assert secret_gate.is_reportable_submitted_secret(
        "certificate", _CERT_PEM + _PRIVATE_KEY_PEM, loc) is True
    assert secret_gate.is_reportable_submitted_secret(
        "private_key", _PRIVATE_KEY_PEM, loc) is True


def test_scan_gate_passes_the_document_from_the_artifact():
    """배선 회귀 방지 — service_task_tools 가 artifact.text 를 게이트에 넘겨야 한다.

    본문을 안 넘기면 규칙이 영원히 안 돌고, 테스트는 secret_gate 단위로만 통과해
    '고쳤다'는 착시가 생긴다(#18900 이 정확히 그 배선 구멍이었다).
    """
    import inspect

    from domains.services.plugin.tools import service_task_tools

    src = inspect.getsource(service_task_tools._github_secret_gate_pass)
    assert "document=" in src and "artifact.text" in src, (
        "_github_secret_gate_pass 가 artifact.text 를 document 로 넘기지 않는다"
    )
