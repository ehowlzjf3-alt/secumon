"""v3.70 S1: detectors/secrets.py 확장 — allowlist(placeholder 오탐 차단) +
find_high_entropy(키워드 없는 하드코딩 시크릿) TDD.

기존 find_secrets/mask_secret 회귀 + 신규 동작."""
from __future__ import annotations

from secu_agent.detectors.secrets import (
    find_secrets,
    find_high_entropy,
    mask_secret,
    _is_placeholder,
    _shannon_entropy,
)


def _kinds(text):
    return {h.kind for h in find_secrets(text)}


# ---------------------------------------------------------------------------
# 기존 룰 회귀 (확장이 깨면 안 됨)
# ---------------------------------------------------------------------------

def test_real_aws_key_still_detected():
    hits = list(find_secrets('aws_key = "AKIA1234567890ABCDEF"'))
    assert any(h.kind == "aws_access_key_id" for h in hits)


def test_real_github_pat_still_detected():
    pat = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"  # 36 chars
    assert "github_pat" in _kinds(f'token={pat}')


def test_real_private_key_block_detected():
    assert "private_key_block" in _kinds("-----BEGIN RSA PRIVATE KEY-----\nMIIE...")


def test_real_generic_password_detected():
    # 평범하지 않은(엔트로피 충분) 값 → 잡힘
    assert "generic_password_assignment" in _kinds('password = "Tr0ub4dor3xKpzQ"')


def test_config_prefixed_secret_key_detected():
    text = "aws.secretAccessKey = AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
    hits = list(find_secrets(text))
    assert any(h.kind == "generic_config_secret_assignment" for h in hits)


def test_xml_secret_element_detected():
    text = (
        "<project><properties>"
        "<clientSecret>AbCdEfGhIjKlMnOpQrStUvWxYz0123456789</clientSecret>"
        "</properties></project>"
    )
    hits = list(find_secrets(text))
    assert any(h.kind == "generic_secret_xml_element" for h in hits)


def test_named_env_value_config_detected():
    text = """
    env:
      - name: DB_PASSWORD
        value: AbCdEfGhIjKlMnOpQrStUvWxYz0123456789
    """
    hits = list(find_secrets(text))
    assert any(h.kind == "generic_named_env_value" for h in hits)


# ---------------------------------------------------------------------------
# allowlist — placeholder 오탐 차단
# ---------------------------------------------------------------------------

def test_aws_example_key_is_allowlisted():
    # AWS 공식 문서 예시 키 — 절대 finding 아님
    assert "aws_access_key_id" not in _kinds('aws = "AKIAIOSFODNN7EXAMPLE"')


def test_placeholder_dollar_brace_not_flagged():
    assert _kinds('password = "${DB_PASSWORD}"') == set()


def test_placeholder_your_token_not_flagged():
    assert _kinds('api_key = "your-api-key-here"') == set()


def test_placeholder_angle_bracket_not_flagged():
    assert _kinds('secret = "<your-secret>"') == set()


def test_placeholder_changeme_not_flagged():
    assert _kinds('password = "changeme123"') == set()


def test_is_placeholder_helper():
    assert _is_placeholder("AKIAIOSFODNN7EXAMPLE")
    assert _is_placeholder("${SECRET}")
    assert _is_placeholder("your-token-here")
    assert _is_placeholder("xxxxxxxxxx")
    assert _is_placeholder("changeme")
    assert _is_placeholder("REDACTED")
    assert not _is_placeholder("Tr0ub4dor3xKpzQ")
    assert not _is_placeholder("AKIA1234567890ABCDEF")


# ---------------------------------------------------------------------------
# find_high_entropy — 키워드 없는 하드코딩 시크릿
# ---------------------------------------------------------------------------

def test_high_entropy_random_token_detected():
    # 변수명 평범, 키워드 없음 — 기존 룰은 못 잡지만 엔트로피로 포착
    line = 'x = "kJ8xQ2mP9zL4vR7nW1cB5dF3gH6jK0sAeT"'
    hits = list(find_high_entropy(line))
    assert any(h.kind == "high_entropy_string" for h in hits)
    # 기존 find_secrets 로는 안 잡힘 (키워드/패턴 없음)
    assert _kinds(line) == set()


def test_high_entropy_skips_git_sha():
    # 40-hex git sha — 시크릿 아님(해시), 오탐 방지
    assert list(find_high_entropy("commit a1b2c3d4e5f6789012345678901234567890abcd")) == []


def test_high_entropy_skips_md5_hex():
    assert list(find_high_entropy("hash=5d41402abc4b2a76b9719d911017c592")) == []


def test_high_entropy_skips_uuid():
    assert list(find_high_entropy("id = 550e8400-e29b-41d4-a716-446655440000")) == []


def test_high_entropy_skips_data_uri_media_payload():
    text = (
        '<img src="data:image/png;base64,'
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9p9s='
        '">'
    )
    assert list(find_high_entropy(text)) == []


def test_high_entropy_skips_minified_bundle_context():
    token = "kJ8xQ2mP9zL4vR7nW1cB5dF3gH6jK0sAeT"
    text = "(()=>{" + ";".join(
        f'const v{i}="{token[:-2]}{i:02d}"' for i in range(18)
    ) + "})();"
    assert list(find_high_entropy(text)) == []


def test_high_entropy_skips_hashed_asset_filename():
    token = "kJ8xQ2mP9zL4vR7nW1cB5dF3gH6jK0sAeT"
    assert list(find_high_entropy(f'<script src="/assets/app.{token}.js"></script>')) == []


def test_high_entropy_skips_jwt_shaped_token():
    jwt = (
        "eyJhbGciOiJIUzI1NiJ9."
        "abCDefGhIjKlMnOpQrStUvWxYz012345."
        "ZyXwVuTsRqPoNmLkJiHgFeDcBa987654"
    )
    assert list(find_high_entropy(f"jwt = {jwt}")) == []


def test_high_entropy_skips_plain_prose():
    assert list(find_high_entropy("the quick brown fox jumps over the lazy dog")) == []


def test_high_entropy_skips_placeholder():
    assert list(find_high_entropy('token = "YOUR_VERY_LONG_PLACEHOLDER_VALUE_HERE"')) == []


def test_high_entropy_threshold_respected():
    # 낮은 엔트로피 긴 문자열(반복) → 임계 미달
    assert list(find_high_entropy("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")) == []


def test_high_entropy_suppressed_inside_pem_block():
    # S1b: PEM private key 본문(BEGIN~END) 의 base64 줄들은 고엔트로피로 안 잡음.
    # private_key_block 룰이 키 1건으로 대표 → 줄마다 188건 폭발 방지.
    pem = (
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "MIIJkJ8xQ2mP9zL4vR7nW1cB5dF3gH6jK0sAeT2uV8wX1yZ3aB4cD5eF6gH7iJ9yAw\n"
        "0K7bQ2mP9zL4vR7nW1cB5dF3gH6jK0sAeT2uV8wX1yZ3aB4cD5eF6gH7iJxfb4ZZZZ\n"
        "Rk1mQ2mP9zL4vR7nW1cB5dF3gH6jK0sAeT2uV8wX1yZ3aB4cD5eF6gH7iJDeP9aBcD\n"
        "-----END RSA PRIVATE KEY-----\n"
    )
    assert list(find_high_entropy(pem)) == []        # 본문 줄 억제
    # 단, find_secrets 는 여전히 private_key_block 1건
    assert "private_key_block" in {h.kind for h in find_secrets(pem)}


def test_high_entropy_still_fires_outside_pem():
    # PEM 밖의 고엔트로피는 그대로 잡혀야
    txt = (
        "x = kJ8xQ2mP9zL4vR7nW1cB5dF3gH6jK0sAeT\n"
        "-----BEGIN RSA PRIVATE KEY-----\nMIIJaaaa\n-----END RSA PRIVATE KEY-----\n"
    )
    kinds = [h.kind for h in find_high_entropy(txt)]
    assert "high_entropy_string" in kinds  # 첫 줄 토큰은 여전히 잡힘
    assert len(kinds) == 1                  # PEM 본문 줄은 억제


# ---------------------------------------------------------------------------
# 마스킹 (기존 재사용, 평문 미노출 보장)
# ---------------------------------------------------------------------------

def test_mask_never_reveals_full():
    v = "AKIA1234567890ABCDEF"
    m = mask_secret(v)
    assert v not in m
    assert m.startswith("AKIA")
    assert m.endswith("CDEF")
    assert "*" in m


def test_mask_short_value_fully_masked():
    assert mask_secret("abc") == "***"
    assert set(mask_secret("shortpw")) == {"*"}


def test_shannon_entropy_basic():
    assert _shannon_entropy("") == 0.0
    assert _shannon_entropy("aaaa") == 0.0
    assert _shannon_entropy("abcd") == 2.0  # 4 균등 → log2(4)
