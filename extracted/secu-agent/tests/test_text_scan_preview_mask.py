"""v3.79 ③-3: detector preview 마스킹 — raw 민감값이 line_preview 로 누출 (codex C3).

기존: Hit.masked 는 가리지만 line_preview 는 매치 주변 ±60자 raw 원문 — 매치값
자체와 같은 줄의 다른 시크릿/PII 가 평문으로 DB(smb_file_hit 등)/evidence 에 저장.
마스킹 정책(평문 시크릿/PII 저장 금지) 위반.

수정: scan_text 가 전체 hit 을 먼저 수집한 뒤, 각 preview 윈도우와 겹치는 모든
hit span 을 그 hit 의 masked 값으로 치환해 preview 생성.
"""
from __future__ import annotations

from secu_agent.detectors.text_scan import mask_scanned_text, scan_text


SECRET_LINE = 'password="agent_type2secretXX"'
TEXT = (
    "config line one here\n"
    + SECRET_LINE + "\n"
    + "tail line after\n"
)


def test_preview_does_not_contain_raw_secret():
    r = scan_text(TEXT)
    assert r.hits, "테스트 전제: secret 1건 매치"
    for h in r.hits:
        assert "agent_type2secretXX" not in h.line_preview, (
            f"raw 시크릿이 preview 로 누출: {h.line_preview!r}"
        )


def test_preview_contains_masked_value_and_context():
    r = scan_text(TEXT)
    h = next(x for x in r.hits if x.kind == "generic_password_envline")
    # 마스킹된 값(요약)이 preview 에 들어가 사람이 위치/맥락 파악 가능해야
    assert h.masked.strip('"') in h.line_preview or "***" in h.line_preview
    # 주변 비민감 컨텍스트는 보존
    assert "config line one" in h.line_preview or "tail line" in h.line_preview


def test_preview_masks_other_hits_on_same_window():
    """윈도우(±60자) 안에 든 '다른' hit 의 raw 값도 누출되면 안 됨.

    (detector 가 탐지한 hit 만 마스킹 가능 — 미탐값은 C2 recall 백로그.)
    """
    text = 'password="topsecretAAA11"\npassword="topsecretBBB22"\nend line'
    r = scan_text(text)
    assert len(r.hits) >= 2, f"전제: 2건 매치 (실제 {len(r.hits)})"
    for h in r.hits:
        assert "topsecretAAA11" not in h.line_preview, h.line_preview
        assert "topsecretBBB22" not in h.line_preview, h.line_preview


def test_masked_field_unchanged_semantics():
    """기존 masked 필드 의미/형식 회귀 가드."""
    r = scan_text(TEXT)
    h = next(x for x in r.hits if x.kind == "generic_password_envline")
    assert "agent_type2secretXX" not in h.masked
    assert h.masked  # 비어있지 않음


def test_canonical_mask_scanned_text_covers_json_creds_urls_and_non_email_pii():
    password = "plain-password-value"
    token = "url-token-value-12345"
    text = (
        '{"name":"Jane Doe","phone":"010-1234-5678",'
        '"address":"129 Samsung-ro, Yeongtong-gu, Suwon-si, Gyeonggi-do",'
        f'"password":"{password}",'
        f'"callback":"https://user:pass@host.example/p?token={token}"}}'
    )

    masked = mask_scanned_text(text)
    assert "Jane Doe" not in masked
    assert "010-1234-5678" not in masked
    assert "129 Samsung-ro, Yeongtong-gu, Suwon-si, Gyeonggi-do" not in masked
    assert password not in masked
    assert "user:pass@" not in masked
    assert token not in masked


def test_scan_text_line_preview_uses_canonical_mask_for_neighbor_json_creds():
    password = "passw0rd"
    text = (
        '{"password":"%s","phone":"010-1234-5678",'
        '"address":"129 Samsung-ro, Yeongtong-gu, Suwon-si"}'
    ) % password

    r = scan_text(text)
    assert r.hits
    for h in r.hits:
        assert password not in h.line_preview
        assert "010-1234-5678" not in h.line_preview
        assert "129 Samsung-ro, Yeongtong-gu, Suwon-si" not in h.line_preview
