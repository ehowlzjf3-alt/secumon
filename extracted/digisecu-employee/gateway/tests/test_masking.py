"""read 경계 재마스킹 — 고위험 원문 패턴이 게이트웨이 응답에 새지 않음(무DB). 적대적 검증 반영."""
from digisecu_gateway.masking import redact


def test_none_passthrough():
    assert redact(None) is None


def test_korean_rrn_masked():
    # 파일명 안 주민번호(적대적 검증 시나리오 A)
    out = redact(r"\\10.20.30.40\HR$\payroll\emp_921012-1234567.xlsx")
    assert "1234567" not in out
    assert "921012" in out or "«마스킹»" in out  # 앞 6자리는 남고 뒤 7자리 봉인


def test_us_ssn_masked():
    out = redact("확인됨: SSN 123-45-6789 노출")
    assert "123-45-6789" not in out


def test_aws_key_masked():
    out = redact("AWS key AKIAIOSFODNN7EXAMPLE in file")
    assert "AKIAIOSFODNN7EXAMPLE" not in out


def test_credential_in_url_masked():
    out = redact("https://admin:s3cr3tP@ss@git.internal/repo.git")
    assert "s3cr3tP" not in out


def test_kv_secret_masked():
    out = redact("config: password=hunter2 token=abc123")
    assert "hunter2" not in out


def test_email_local_masked():
    out = redact("owner hong.gildong@samsung.com")
    assert "hong.gildong" not in out
    assert "samsung.com" in out  # 도메인은 보존


def test_high_entropy_token_masked():
    out = redact("bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijklmnop")
    assert "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijklmnop" not in out


def test_json_quoted_secret_masked():
    out = redact('{"password": "hunter2", "note": "ok"}')
    assert "hunter2" not in out


def test_password_with_at_in_url_masked():
    out = redact("https://admin:s3cr3tP@ss@git.internal/repo.git")
    assert "s3cr3tP@ss" not in out and "s3cr3tP" not in out
    assert "git.internal" in out  # 호스트 보존


def test_benign_text_survives():
    # 평범한 자산 경로는 구조 보존(과마스킹으로 못 알아보게 하지 않음)
    out = redact("smb://fileserver01/공유폴더/보고서.docx")
    assert "fileserver01" in out and "공유폴더" in out


# ── 적대적 검증 반영: underscore/camelCase 키·짧은 토큰·미구분 SSN 봉인 회귀 ──
def test_underscore_key_secret_masked():
    # \b 우회 케이스(가장 흔한 시크릿 config 키 형태) — 값이 봉인돼야 함.
    for raw, secret in [
        ("db_password=hunter2Pass", "hunter2Pass"),
        ("DB_PASSWORD: SuperSecretPw99", "SuperSecretPw99"),
        ("client_secret = zzXyQ12345abcDEF6789", "zzXyQ12345abcDEF6789"),
        ("aws_secret_access_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"),
    ]:
        out = redact(raw)
        assert secret not in out, f"{raw!r} 값이 새어나감: {out!r}"


def test_camelcase_key_secret_masked():
    out = redact("authToken=abcd1234efgh5678ijkl9012")
    assert "abcd1234efgh5678ijkl9012" not in out


def test_short_high_entropy_token_masked():
    # 32자 hex(구 40자 하한 통과분) — 키워드 없어도 엔트로피로 봉인.
    out = redact("value 9f8e7d6c5b4a39281706f5e4d3c2b1a0 end")
    assert "9f8e7d6c5b4a39281706f5e4d3c2b1a0" not in out


def test_undelimited_ssn_with_label_masked():
    out = redact("ssn 123456789 확인")
    assert "123456789" not in out


def test_underscore_key_preserved_only_value_masked():
    # 키 접두(db_)는 보존, 값만 봉인 — 분석가가 무슨 키인지 알 수 있게.
    out = redact("db_password=hunter2Pass")
    assert "db_password" in out and "hunter2Pass" not in out


def test_snake_case_identifier_preserved():
    # 사전형 식별자(detector kind·룰명)는 20~39자여도 봉인하지 않는다(과마스킹 회귀 방지).
    for ident in ["generic_password_assignment", "generic_config_secret_assignment",
                  "high_entropy_string", "private_key_block"]:
        assert redact(ident) == ident, f"식별자 {ident!r}가 과마스킹됨"


def test_all_lowercase_word_run_preserved():
    # 언더스코어 없는 20+ 소문자 단어(엔트로피 신호 없음)는 보존.
    assert redact("supercalifragilisticexpialidocious") == "supercalifragilisticexpialidocious"
