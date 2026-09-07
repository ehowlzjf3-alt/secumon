"""탐지기가 내놓은 증거는 제출 게이트를 통과해야 한다 — 왕복 불변식.

## 왜 (2026-08-27 실측)

`SecretHit.matched` 는 **값만**인데 `span` 은 **매치 전체**였고, 마스킹은 `text[span]` 을
`masked` 로 치환한다. 그래서 키 이름과 `=` 가 통째로 증발했다:

    OBSERVABILITY_API_KEY = "e6dc…"  →  OBSERVABILITY_e6dc****…
    api_key=e6dc…                    →  e6dc****…

그런데 제출 게이트는 **`key=value` 형태의 줄**을 증거로 요구한다. 탐지기가 지운 것을
게이트가 찾은 셈이라, 정당한 finding 이 "값 증거 없음" 으로 죽었다(dev_web 39건·
confluence 15건). 개인키 finding 이 같은 형태로 죽은 전례가 있다.

게다가 게이트의 이름 인식이 `\\b` 였는데 `\\b` 는 `_` 를 단어문자로 본다 —
`DB_PASSWORD=` · `AWS_SECRET_ACCESS_KEY=` 같은 접두어 붙은 실무 키가 전부 안 잡혔다.

이 테스트는 그 둘을 **한 계약으로 묶는다**: 탐지기 출력이 게이트를 통과하는가.
어느 한쪽만 고치면 여기서 깨진다.
"""
from __future__ import annotations

import pytest

from secu_agent.agent.evidence_judgment import _has_hardened_credential_value
from secu_agent.detectors import scan_text
from secu_agent.detectors.secrets import find_secrets
from secu_agent.detectors.text_scan import mask_scanned_text

#: 실무에서 실제로 보이는 형태. 값은 전부 가짜다.
_REAL_SHAPES = (
    'OBSERVABILITY_API_KEY = "e6dcQm7Lp3Zx91kQm7Lp3Zx91kQm7Lp3Zx91v1D0"',
    "DB_PASSWORD=Photocloud23xQ",
    "api_key=e6dcQm7Lp3Zx91kQm7Lp3Zx91kQm7Lp3Zx91v1D0",
    "export SPRING_DATASOURCE_PASSWORD=Sup3rS3cret2024x",
    "password: Sup3rS3cret2024x",
    "MYSQL_ROOT_PASSWORD=Kx7QmZp2Lv9Rt4Wy",
)


@pytest.mark.parametrize("line", _REAL_SHAPES)
def test_span_is_the_value_itself(line: str) -> None:
    """불변식: text[span] == matched. 어긋나면 마스킹이 엉뚱한 구간을 지운다."""
    hits = list(find_secrets(line))
    assert hits, f"탐지 0건: {line!r}"
    for hit in hits:
        assert line[hit.span[0]:hit.span[1]] == hit.matched, (hit.kind, hit.span)


@pytest.mark.parametrize("line", _REAL_SHAPES)
def test_masking_keeps_the_key_name(line: str) -> None:
    """키 이름은 비밀이 아니라 **증거**다. 값만 가린다."""
    key_name = line.split("=")[0].split(":")[0].strip()
    masked = mask_scanned_text(line)
    assert key_name in masked, f"{key_name!r} 이 사라졌다 → {masked!r}"


@pytest.mark.parametrize("line", _REAL_SHAPES)
def test_scanner_output_passes_the_submit_gate(line: str) -> None:
    """★ 왕복 불변식 — 탐지기가 만든 preview 가 제출 게이트를 통과해야 한다."""
    result = scan_text(line)
    assert result.hits, f"탐지 0건: {line!r}"
    hit = result.hits[0]
    assert _has_hardened_credential_value(
        hit.kind, hit.masked, hit.line_preview,
    ), f"게이트가 자기 탐지기 출력을 거부한다: {hit.line_preview!r}"


def test_xml_element_still_masks_the_whole_match() -> None:
    """⚠️ XML 원소만은 값 구간으로 좁히지 않는다.

    매치가 `<tag attr="…" host="…" account="…">값</tag>` 처럼 **속성까지** 포함한다.
    값만 가리면 host/account 가 평문으로 남는다.
    """
    line = (
        '<db-password host="vault.prod.internal" account="svc_edm">'
        "Zx91kQm7Lp3aBcDeFgH</db-password>"
    )
    hits = [h for h in find_secrets(line) if h.kind == "generic_secret_xml_element"]
    assert hits, "XML 원소 규칙이 안 걸렸다"
    assert line[hits[0].span[0]:hits[0].span[1]] == line, "속성까지 덮어야 한다"
    masked = mask_scanned_text(line)
    assert "vault.prod.internal" not in masked
    assert "svc_edm" not in masked


@pytest.mark.parametrize("line", _REAL_SHAPES)
def test_value_never_survives_masking(line: str) -> None:
    """구간을 좁혔다고 값이 새면 안 된다."""
    masked = mask_scanned_text(line)
    for hit in find_secrets(line):
        assert hit.matched not in masked, (hit.kind, masked)


#: 크리덴셜이 **아닌데** 크리덴셜처럼 보이는 줄. 경계를 `_` 너머로 푼 대가로
#: `disable_auth=yes` 류가 새로 걸렸었다 — 값 낱말 제외 + 접두어 거부로 막았다.
_NOT_CREDENTIALS = (
    "bypass=true", "passenger=John Smith", "compass: north", "hardpass: 3",
    "disable_auth=yes", "no_token=abc", "use_auth: yes", "is_password_set: yes",
    "authenticated=true", "author: kim", "tokenizer=bert-base",
    "password_hash_algo=bcrypt", "SESSION_TOKEN_TTL=3600", "PASSWORD_POLICY=strict",
    "api_key_name=prod", "auth_type=oidc", "secret_name=db-creds",
    "credential_provider=vault", "user_id = 12345", "id: 3",
    "enable_token=abc", "has_password=yes", "skip_auth=on",
)


@pytest.mark.parametrize("line", _NOT_CREDENTIALS)
def test_config_flags_are_not_credential_evidence(line: str) -> None:
    from secu_agent.agent.evidence_judgment import _CREDENTIAL_ASSIGNMENT_RE

    assert _CREDENTIAL_ASSIGNMENT_RE.search(line) is None, line


def test_excluded_value_word_still_allows_a_value_that_starts_with_it() -> None:
    """`yes` 를 값 낱말로 뺐다고 `yesterday…` 로 시작하는 진짜 값까지 막으면 안 된다."""
    from secu_agent.agent.evidence_judgment import _CREDENTIAL_ASSIGNMENT_RE

    assert _CREDENTIAL_ASSIGNMENT_RE.search("password=yesterday-key-9xQ") is not None


def test_id_only_assignment_is_not_credential_evidence() -> None:
    """⚠️ 이름 경계 완화는 **값 키에만** 적용한다.

    ID 키(id/user/email…)까지 완화하면 `user_id = 12345` 가 크리덴셜 증거로 통과한다 —
    실측에서 새로 생긴 유일한 오탐이라 여기서 못 박는다.
    """
    from secu_agent.agent.evidence_judgment import _CREDENTIAL_ASSIGNMENT_RE

    assert _CREDENTIAL_ASSIGNMENT_RE.search("user_id = 12345") is None
    assert _CREDENTIAL_ASSIGNMENT_RE.search("id: 3") is None
    # 값 키는 접두어가 붙어도 잡혀야 한다.
    assert _CREDENTIAL_ASSIGNMENT_RE.search("DB_PASSWORD=Photocloud23xQ") is not None


# ── #2 마스킹된 토큰 자기무효화 (2026-08-28) ──────────────────────────────
#
# 위 span 사고와 **같은 병의 다음 판**이다. 탐지기는 값을 마스킹해서 워커에게 주는데
# (`Hit.masked` = `mask_secret` 출력) 게이트는 접두어 뒤에 **원문 글자**를 요구했다.
# 그래서 파이프라인 자신의 출력이 "값 증거 없음" 으로 거부됐다 — 4개 증거트리
# 798개 파일에 4,687회 있던 형상이 전부.
#
#     AKIA************6FOK   ghp_********************************7k4N
#
# 게이트 코드의 주석은 이미 "부분 마스킹된 고정밀 토큰(prefix)도 인정" 이라고
# 적혀 있었다. 의도는 있었고 정규식이 안 따라갔다.

#: 접두어 4자가 마스킹을 견디는 계열. 값은 전부 가짜다.
_MASKABLE_TOKEN_LINES = (
    "AKIA2E0RM7NQJ4TP6VZK",
    "ASIA2E0RM7NQJ4TP6VZK",
    "ghp_" + "a1b2c3d4e5" * 3 + "f1g2h3",
    "npm_" + "a1b2c3d4e5" * 3 + "f1g2h3",
    "AIzaSy0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV",
)


@pytest.mark.parametrize("line", _MASKABLE_TOKEN_LINES)
def test_masked_token_still_passes_the_submit_gate(line: str) -> None:
    """★ 마스킹은 증거를 파괴하면 안 된다 — 키 이름 없는 맨 토큰으로.

    이 줄에는 `key=` 가 없으므로 대입 분기가 구제해주지 못한다. 마스킹 형상
    자체가 증거로 서야 한다.
    """
    result = scan_text(line)
    assert result.hits, f"탐지 0건: {line!r}"
    hit = result.hits[0]
    assert "*" in (hit.masked or ""), f"마스킹이 안 됐다 → {hit.masked!r}"
    assert _has_hardened_credential_value(
        hit.kind, hit.masked, hit.line_preview,
    ), f"게이트가 자기 탐지기의 마스킹 출력을 거부한다: {hit.masked!r}"


@pytest.mark.parametrize("masked", (
    "AKIA************6FOK",                       # 실측 250회
    "AKIA************B68",                        # 19자 — 워커 필사본이 한 글자 짧다
    "ghp_********************************7k4N",   # 실측 51회
    "ghp_********LLER",                           # 실측 48회
    "AIza*******************************1EAE",    # 실측 72회
    "GIT_SYNC_ghp_********************************jONL",  # 밑줄 앞 — 탐지기 경계와 같아야
))
def test_real_pipeline_mask_shapes_are_evidence(masked: str) -> None:
    """증거 디렉토리에서 실제로 나온 형상들. 전부 거부되고 있었다."""
    assert _has_hardened_credential_value("x", masked, "")


@pytest.mark.parametrize("masked", (
    "AKIA****",                 # 별표런이 짧다 — 손으로 지어내기 쉬운 모양
    "ghp_****",
    "TICK********ABCD",         # 접두어가 고정밀 계열이 아니다
    "AIza*******************************",  # 꼬리가 없다 = mask_secret 출력이 아니다
    "********************",
    "<masked,len=20>",
    "value_present",
))
def test_forged_or_shapeless_masks_are_still_rejected(masked: str) -> None:
    """게이트를 열되 **같은 문**만 연다. 산문·라벨·형상 미달은 그대로 거부."""
    assert not _has_hardened_credential_value("x", masked, "")


def test_preview_saying_it_was_already_redacted_beats_the_masked_field() -> None:
    """masked 는 형상을 갖췄는데 preview 가 "그 자리는 이미 지워졌다" 고 말하는 경우.

    실측 1건 — 그 masked 는 관찰이 아니라 조립이다.
    """
    assert not _has_hardened_credential_value(
        "google_api_key",
        "AIza*******************************RgNA",
        "<script src='//maps.googleapis.com/maps/api/js?key=%3Credacted%3E'>",
    )
