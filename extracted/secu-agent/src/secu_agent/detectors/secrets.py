"""Credential / API key detectors.

Regex 패턴 + Shannon entropy 보조. 한 라인 단위로 hit을 돌려준다.
오탐을 줄이려고 패턴이 매치된 후에도 entropy 필터로 한 번 더 거른다.
"""
from __future__ import annotations

import math
import re


# ── 개인키 armor 헤더 — **정본 하나** ─────────────────────────────────────
# 여기가 유일한 정의다. 탐지 룰·마스킹·증거 게이트가 전부 이걸 쓴다.
#
# ★ 왜 정본이어야 하는가: 예전엔 탐지 정규식엔 `( BLOCK)?` 가 있는데 증거 게이트의
#   정규식엔 없었다. 그래서 **탐지는 되는데 제출은 안 되는** PGP 개인키가 생겼다
#   (2026-08-22 smb target 1766 arcashield.asc — 검토원이 3회 제출 시도, 3회 거부).
#   같은 개념을 두 곳에 적으면 언젠가 어긋난다.
#
# `ENCRYPTED` 를 포함한 임의 접두어를 받는다 — 어차피 "PRIVATE KEY" 가 리터럴이라
# PUBLIC KEY 는 절대 매칭되지 않는다.
_PRIVATE_KEY_ARMOR_RE = re.compile(
    r"-----BEGIN [A-Z0-9]*[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----", re.I,
)
from collections.abc import Iterable
from dataclasses import dataclass

# (kind, regex, min_entropy) — kind는 finding.detector_id로 그대로 들어감.
# entropy 0이면 패턴만으로 충분 (AWS access key 처럼 prefix가 강함).
# 고정밀 토큰 접두어 규칙의 **경계**. `\b` 는 `_` 를 단어문자로 보기 때문에
# `SECRET_ghp_<PAT>` · `MY_AKIA…` 처럼 **밑줄 뒤에 박힌 진짜 토큰**을 통째로 못 잡았다.
# 지금까지는 바깥의 `key=value` 규칙이 줄 전체를 마스킹하며 우연히 덮고 있었지만,
# span 을 값 구간으로 좁히면서(아래 `_VALUE_SPAN_GROUPS`) 그 우연이 사라졌다
# — 실측으로 평문 PAT 4건이 노출됐다. 접두어 자체가 고정밀(`ghp_`+36자 등)이라 앞뒤를
# 풀어도 오탐이 늘지 않는다(실측: 정탐 2/7 → 7/7, 오탐 0/4 → 0/4).
_TOKEN_PRE = r"(?<![A-Za-z0-9])"
_TOKEN_POST = r"(?![A-Za-z0-9])"
_SECRET_RULES: tuple[tuple[str, re.Pattern[str], float], ...] = (
    ("aws_access_key_id", re.compile(_TOKEN_PRE + r"(AKIA|ASIA)[0-9A-Z]{16}" + _TOKEN_POST), 0.0),
    ("aws_secret_access_key",
     re.compile(r"(?i)aws[_\-]?secret[_\-]?(access[_\-]?)?key\s*[:=]\s*['\"]?([A-Za-z0-9/+=]{40})['\"]?"),
     4.0),
    ("github_pat", re.compile(_TOKEN_PRE + r"ghp_[A-Za-z0-9]{36}" + _TOKEN_POST), 0.0),
    ("github_oauth", re.compile(_TOKEN_PRE + r"gho_[A-Za-z0-9]{36}" + _TOKEN_POST), 0.0),
    ("github_server_token", re.compile(_TOKEN_PRE + r"ghs_[A-Za-z0-9]{36}" + _TOKEN_POST), 0.0),
    ("github_app_token", re.compile(_TOKEN_PRE + r"(ghu|ghr)_[A-Za-z0-9]{36}" + _TOKEN_POST), 0.0),
    ("slack_bot_token", re.compile(_TOKEN_PRE + r"xox[baprs]-[A-Za-z0-9-]{10,}" + _TOKEN_POST), 0.0),
    ("slack_webhook",
     re.compile(r"https://hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+"), 0.0),
    ("google_api_key", re.compile(_TOKEN_PRE + r"AIza[0-9A-Za-z\-_]{35}" + _TOKEN_POST), 0.0),
    ("stripe_secret", re.compile(_TOKEN_PRE + r"(sk|rk)_(live|test)_[A-Za-z0-9]{24,}" + _TOKEN_POST), 0.0),
    ("private_key_block", _PRIVATE_KEY_ARMOR_RE, 0.0),
    ("jwt_token",
     re.compile(_TOKEN_PRE + r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"
                + _TOKEN_POST), 0.0),
    ("npm_token", re.compile(_TOKEN_PRE + r"npm_[A-Za-z0-9]{36}" + _TOKEN_POST), 0.0),
    ("pypi_token", re.compile(_TOKEN_PRE + r"pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\-]{50,}" + _TOKEN_POST), 0.0),
    # 사내 Jenkins token 노출 패턴 (URL 안에 user:token@ 형태)
    ("jenkins_basic_auth_in_url",
     re.compile(r"https?://[A-Za-z0-9_\-.]+:[A-Za-z0-9]{20,}@[^\s\"'<>]+jenkins[^\s\"'<>]*"), 0.0),
    # 일반 password=... 식. value 길이/엔트로피로 거른다.
    ("generic_password_assignment",
     re.compile(
         r"(?i)['\"]?(password|passwd|pwd|secret|token|access[_\-]?token|"
         r"refresh[_\-]?token|id[_\-]?token|client[_\-]?secret|api[_\-]?key|"
         r"apikey|authorization|auth|jwt|private[_\-]?key|credential)['\"]?"
         r"\s*[:=]\s*['\"]?([^'\"\r\n,}\]]{8,200})['\"]?"
     ),
     3.2),
    ("generic_password_envline",
     re.compile(r"(?i)^\s*(PASSWORD|PASSWD|API_?KEY|SECRET|TOKEN)\s*=\s*([^\s#]{8,80})\s*$",
                re.MULTILINE),
     3.2),
    ("generic_config_secret_assignment",
     re.compile(
         r"(?im)^\s*(?:-\s*)?(?:export\s+)?"
         r"(?:[A-Za-z0-9_.-]{0,80}"
         r"(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|"
         r"client[_-]?secret|credential|authorization|bearer|jwt)"
         r"[A-Za-z0-9_.-]{0,80})\s*[:=]\s*"
         r"['\"]?([^'\"\r\n#,\]}]{8,200})['\"]?"
     ),
     3.0),
    ("generic_secret_xml_element",
     re.compile(
         r"(?is)<[A-Za-z0-9_.:-]*"
         r"(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|"
         r"client[_-]?secret|credential|authorization|bearer|jwt)"
         r"[A-Za-z0-9_.:-]*\b[^>]*>\s*([^<\s][^<]{7,200}?)\s*</[^>]+>"
     ),
     3.0),
    ("generic_named_env_value",
     re.compile(
         r"(?im)^\s*(?:-\s*)?name\s*:\s*['\"]?"
         r"[A-Za-z0-9_.-]{0,80}"
         r"(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|"
         r"client[_-]?secret|credential|authorization|bearer|jwt)"
         r"[A-Za-z0-9_.-]{0,80}['\"]?\s*$"
         r"\s*^\s*value\s*:\s*['\"]?([^'\"\r\n#]{8,200})['\"]?"
     ),
     3.0),
    # DB URL with creds embedded
    ("database_url_with_password",
     re.compile(r"\b(postgres(?:ql)?|mysql|mongodb|redis|amqp)://[A-Za-z0-9_.\-]+:[^@\s'\"]+@[^\s'\"]+"),
     0.0),
)


@dataclass(frozen=True, slots=True)
class SecretHit:
    kind: str
    matched: str        # 매치된 raw 문자열 (masked 추천)
    span: tuple[int, int]  # offset in text


# v3.70: placeholder / 예시값 마커 — 매치돼도 finding 아님(오탐 차단).
# 부분일치(소문자) — AWS 공식예시 키, ${VAR}, your-token, <secret>, changeme 등.
_PLACEHOLDER_MARKERS: tuple[str, ...] = (
    "example", "changeme", "changeit", "your-", "your_", "yourapi", "yourtoken",
    "placeholder", "redacted", "dummy", "sample", "fixme", "to_be_", "insert_",
    "xxxx", "...", "${", "{{", "<", ">", "*****", "replace_me", "replaceme",
    "notreal", "fake", "test_key", "test-key", "secret_here", "secrethere",
)
_CONFIG_OVERLAP_DEDUP_KINDS = {
    "generic_config_secret_assignment",
    "generic_secret_xml_element",
    "generic_named_env_value",
}


def _is_placeholder(value: str) -> bool:
    """예시/placeholder 값이면 True (finding 제외)."""
    if not value:
        return True
    low = value.lower()
    if any(mark in low for mark in _PLACEHOLDER_MARKERS):
        return True
    # 한 글자 반복(aaaa…, 0000…) → placeholder
    stripped = value.strip("\"' ")
    if stripped and len(set(stripped)) == 1:
        return True
    return False


# v3.70: 키워드 없는 하드코딩 시크릿 탐지용 보조 패턴.
_HE_TOKEN_CACHE: dict[tuple[int, int], "re.Pattern[str]"] = {}
_HE_MAX_SCAN_CHARS = 1024 * 1024
_HE_DEFAULT_MAX_LEN = 128
_HE_DEFAULT_MAX_HITS = 8
_HE_TOKEN_CHARS = r"A-Za-z0-9+/=_\-"
_HEX_RE = re.compile(r"^[0-9a-fA-F]+$")
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_JWT_SHAPED_RE = re.compile(
    r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b"
)
_ASSET_HASH_EXTENSIONS = (
    ".js", ".mjs", ".cjs", ".css", ".map", ".png", ".jpg", ".jpeg", ".gif",
    ".svg", ".webp", ".woff", ".woff2", ".ttf", ".ico",
)
# v3.70-S1b: PEM private key 블록 — 본문(base64) 줄이 줄마다 고엔트로피로 잡혀
# 키 1개가 수십~백건으로 폭발. 블록 전체를 1건(private_key_block)으로 대표하고
# 본문 토큰은 고엔트로피 스캔에서 억제.
_PEM_BLOCK_RE = re.compile(
    r"-----BEGIN [^-]*?PRIVATE KEY( BLOCK)?-----.*?-----END [^-]*?PRIVATE KEY( BLOCK)?-----",
    re.DOTALL,
)


def _pem_spans(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in _PEM_BLOCK_RE.finditer(text)]


def _jwt_spans(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in _JWT_SHAPED_RE.finditer(text)]


def _shannon_entropy(s: str) -> float:
    if not s:
        return 0.0
    freq: dict[str, int] = {}
    for ch in s:
        freq[ch] = freq.get(ch, 0) + 1
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in freq.values())


def _has_high_entropy_secret_shape(value: str) -> bool:
    """Conservative shape gate for keywordless entropy candidates."""
    if not value or not value.isascii():
        return False
    has_lower = any(ch.islower() for ch in value)
    has_upper = any(ch.isupper() for ch in value)
    has_digit = any(ch.isdigit() for ch in value)
    has_symbol = any(ch in "+/=_-" for ch in value)
    if not has_digit:
        return False
    if sum((has_lower, has_upper, has_digit, has_symbol)) < 3:
        return False
    if len(set(value)) < 12:
        return False
    return True


def _in_data_uri_context(text: str, start: int) -> bool:
    prefix = text[max(0, start - 160):start].lower()
    data_pos = prefix.rfind("data:")
    if data_pos < 0:
        return False
    return ";base64" in prefix[data_pos:] and "," in prefix[data_pos:]


def _in_sourcemap_context(text: str, start: int, end: int) -> bool:
    ctx = text[max(0, start - 160):min(len(text), end + 48)].lower()
    return (
        "sourcemappingurl" in ctx
        or '"sourcescontent"' in ctx
        or "'sourcescontent'" in ctx
        or '"mappings"' in ctx
        or "'mappings'" in ctx
    )


def _looks_like_asset_hash_context(text: str, start: int, end: int) -> bool:
    before = text[max(0, start - 96):start].lower()
    after = text[end:min(len(text), end + 16)].lower()
    if (
        "integrity=" in before
        or "sha256-" in before
        or "sha384-" in before
        or "sha512-" in before
    ):
        return True
    if not after.startswith(_ASSET_HASH_EXTENSIONS):
        return False
    return (
        "/" in before
        or before.endswith((".", "-", "_"))
        or "src=" in before
        or "href=" in before
        or "url(" in before
    )


def _looks_minified_bundle_context(text: str, start: int, end: int) -> bool:
    ctx = text[max(0, start - 320):min(len(text), end + 320)]
    if len(ctx) < 240:
        return False
    whitespace = sum(1 for ch in ctx if ch.isspace())
    punct = sum(1 for ch in ctx if ch in "{}[]();,:=+")
    if whitespace / max(1, len(ctx)) > 0.04:
        return False
    if punct < 18:
        return False
    low = ctx.lower()
    return (
        "function(" in low
        or "=>{" in low
        or "const " in low
        or "var " in low
        or "let " in low
        or "webpack" in low
        or "app." in low
    )


def _blocked_span_contains(
    spans: list[tuple[int, int]], index: int, start: int,
) -> tuple[bool, int]:
    while index < len(spans) and spans[index][1] <= start:
        index += 1
    if index < len(spans) and spans[index][0] <= start < spans[index][1]:
        return True, index
    return False, index


def _extract_secret_value(kind: str, m: re.Match[str]) -> str:
    """패턴마다 '진짜 비밀'에 해당하는 그룹을 추려서 엔트로피 검사 대상으로."""
    if kind == "aws_secret_access_key":
        return m.group(2)
    if kind in ("generic_password_assignment",):
        return m.group(2).strip()
    if kind == "generic_password_envline":
        return m.group(2)
    if kind in (
        "generic_config_secret_assignment",
        "generic_secret_xml_element",
        "generic_named_env_value",
    ):
        return m.group(1).strip()
    return m.group(0)


# 값 구간(span) 을 갖는 kind → `_extract_secret_value` 가 고른 그룹 번호.
#
# ## 왜 필요한가 (2026-08-27 실측)
#
# `SecretHit.matched` 는 **값만**인데 `span` 은 **매치 전체**였다. 그런데 마스킹은
# `text[span]` 을 `masked` 로 치환한다(`text_scan._apply_masked_spans`). 그래서
# 키 이름과 `=` 까지 통째로 사라졌다:
#
#     원문     OBSERVABILITY_API_KEY = "e6dc…v1D0"
#     결과     OBSERVABILITY_e6dc****************v1D0     ← `API_KEY = ` 이 증발
#     원문     api_key=e6dc…v1D0
#     결과     e6dc****************v1D0                    ← 키 이름이 통째로 증발
#
# 그리고 제출 게이트(`evidence_judgment._has_hardened_credential_value`)는
# **`key=value` 형태의 줄**을 증거로 요구한다. 즉 탐지기가 지운 것을 게이트가 찾았고,
# 정당한 finding 이 "값 증거 없음" 으로 죽었다(dev_web 39건·confluence 15건 실측).
# 개인키 finding 이 같은 형태로 죽었던 전례가 있다(공개 마커를 비밀처럼 마스킹).
#
# 키 이름은 **비밀이 아니라 증거다.** 값만 가린다.
#
# ⚠️ `generic_secret_xml_element` 는 **일부러 뺐다.** 매치가
#   `<foo password="…" host="vault.prod" account="svc_edm">값</foo>` 처럼 **속성까지**
#   포함하는데, 값 구간만 가리면 그 속성들이 평문으로 남는다. 여기서는 매치 전체를
#   가리는 것이 맞다.
#
# ⚠️ 중복제거용 `taken_spans` 는 계속 **매치 전체**를 쓴다(아래 find_secrets 참조).
#   좁히면 같은 줄에서 규칙끼리 겹치는 걸 못 걸러낸다.
_VALUE_SPAN_GROUPS: dict[str, int] = {
    "aws_secret_access_key": 2,
    "generic_password_assignment": 2,
    "generic_password_envline": 2,
    "generic_config_secret_assignment": 1,
    "generic_named_env_value": 1,
}


def _secret_value_span(kind: str, m: re.Match[str], value: str) -> tuple[int, int]:
    """`matched`(=값) 가 원문에서 차지하는 구간. 못 정하면 매치 전체로 폴백.

    불변식: `text[span[0]:span[1]] == hit.matched`. `_extract_secret_value` 가
    `.strip()` 하는 kind 가 있어 그룹 span 을 그대로 쓰면 이 불변식이 깨진다 —
    그래서 그룹 문자열 안에서 값의 위치를 다시 찾는다.
    """
    index = _VALUE_SPAN_GROUPS.get(kind)
    if index is None or not value:
        return m.span()
    try:
        raw = m.group(index)
        start, end = m.span(index)
    except (IndexError, re.error):
        return m.span()
    if raw is None or start < 0 or end < 0:
        return m.span()
    offset = raw.find(value)
    if offset < 0:
        return m.span()
    return (start + offset, start + offset + len(value))


def _span_overlaps_any(span: tuple[int, int], spans: list[tuple[int, int]]) -> bool:
    start, end = span
    return any(start < taken_end and end > taken_start for taken_start, taken_end in spans)


def find_secrets(text: str) -> Iterable[SecretHit]:
    """text에서 known secret 패턴을 모두 찾는다. yield 순서는 offset asc."""
    seen: set[tuple[str, int]] = set()
    hits: list[SecretHit] = []
    taken_spans: list[tuple[int, int]] = []
    for kind, pattern, min_entropy in _SECRET_RULES:
        for m in pattern.finditer(text):
            value = _extract_secret_value(kind, m)
            if _is_placeholder(value):  # v3.70: 예시/placeholder 오탐 차단
                continue
            if min_entropy > 0 and _shannon_entropy(value) < min_entropy:
                continue
            # 중복제거는 **값 구간**으로 판정한다. 매치 전체로 보면 키 이름 안에 박힌
            # 다른 비밀(`SECRET_ghp_<PAT>=<진짜값>`)이 먼저 잡혔을 때 이 규칙이 통째로
            # 탈락해서 **값이 마스킹조차 안 된다**(실측 3건). 중복제거의 목적은 "같은 값을
            # 두 규칙이 각각 보고하는 것" 을 막는 거지, 다른 비밀 옆에 있다고 죽이는 게 아니다.
            value_span = _secret_value_span(kind, m, value)
            if (
                kind in _CONFIG_OVERLAP_DEDUP_KINDS
                and _span_overlaps_any(value_span, taken_spans)
            ):
                continue
            key = (kind, m.start())
            if key in seen:
                continue
            seen.add(key)
            # span 은 **값 구간**(키 이름은 증거라 안 가린다) — _secret_value_span 참조.
            hits.append(SecretHit(kind=kind, matched=value, span=value_span))
            # ⚠️ 중복제거는 계속 **매치 전체** 기준이다. 좁히면 같은 줄에서
            #    규칙끼리 겹치는 것을 못 걸러낸다.
            taken_spans.append((m.start(), m.end()))
    hits.sort(key=lambda h: h.span[0])
    return hits


def find_high_entropy(
    text: str,
    *,
    min_entropy: float = 4.5,
    min_len: int = 32,
    max_len: int = _HE_DEFAULT_MAX_LEN,
    max_hits: int = _HE_DEFAULT_MAX_HITS,
    max_scan_chars: int = _HE_MAX_SCAN_CHARS,
) -> Iterable[SecretHit]:
    """키워드/패턴 없이 '랜덤해 보이는 긴 토큰' 을 엔트로피로 포착.

    변수명이 평범해 find_secrets 가 못 잡는 하드코딩 시크릿(고엔트로피 키)용.
    오탐 방지: placeholder, UUID, 해시길이 순수 hex(md5/sha…), data URI,
    sourcemap/minified bundle/asset hash 컨텍스트는 제외.
    find_secrets 와 별개(opt-in) — 기존 scan_text 노이즈 프로파일을 안 바꾼다.
    """
    if not text:
        return []
    if min_len <= 0 or max_len < min_len or max_hits <= 0:
        return []
    scan = str(text)[:max(0, int(max_scan_chars))]
    pattern_key = (int(min_len), int(max_len))
    pattern = _HE_TOKEN_CACHE.get(pattern_key)
    if pattern is None:
        pattern = re.compile(
            rf"(?<![{_HE_TOKEN_CHARS}])([{_HE_TOKEN_CHARS}]"
            rf"{{{int(min_len)},{int(max_len)}}})(?![{_HE_TOKEN_CHARS}])"
        )
        _HE_TOKEN_CACHE[pattern_key] = pattern
    hits: list[SecretHit] = []
    seen_tokens: set[str] = set()
    blocked = sorted(
        _pem_spans(scan) + _jwt_spans(scan)
    )  # PEM/JWT 본문은 대표 deterministic hit 이 담당.
    blocked_index = 0
    for m in pattern.finditer(scan):
        tok = m.group(1)
        start, end = m.span(1)
        blocked_here, blocked_index = _blocked_span_contains(blocked, blocked_index, start)
        if blocked_here:
            continue
        if tok in seen_tokens:
            continue
        if _is_placeholder(tok):
            continue
        if _UUID_RE.match(tok):
            continue
        if _HEX_RE.match(tok) and len(tok) >= 7:
            continue
        if not _has_high_entropy_secret_shape(tok):
            continue
        if _in_data_uri_context(scan, start):
            continue
        if _in_sourcemap_context(scan, start, end):
            continue
        if _looks_like_asset_hash_context(scan, start, end):
            continue
        if _looks_minified_bundle_context(scan, start, end):
            continue
        if _shannon_entropy(tok) < min_entropy:
            continue
        seen_tokens.add(tok)
        hits.append(SecretHit(kind="high_entropy_string", matched=tok,
                              span=(start, end)))
        if len(hits) >= max_hits:
            break
    return hits


def mask_secret(value: str) -> str:
    """저장/리포트용 마스킹 — 양끝 4자 외 *. 짧으면 전체 *.

    ★ 예외 하나: 개인키 armor 헤더는 **비밀이 아니다.** `-----BEGIN RSA PRIVATE
    KEY-----` 는 고정된 공개 문자열이고, 실제 키는 뒤따르는 base64 본문이다
    (`private_key_block` 룰은 헤더만 매칭한다). 그런데 양끝 4자 규칙이 armor 의
    다섯째 대시를 별표로 만들어 `----***…----` 를 낳았고, 그 결과 증거 게이트가
    요구하는 바로 그 "PEM 헤더" 를 파이프라인이 **스스로 파괴**했다 — 개인키
    finding 은 원리적으로 제출 불가였다(실측: 5개 형식 전부 거부, smb hit 39건).
    비밀을 가리는 게 아니라 증거만 지우고 있었으므로 그대로 둔다.

    ⚠️ 값 **전체**가 armor 헤더일 때만이다. 본문이 한 글자라도 섞여 있으면
    예전대로 마스킹한다 — 그 경계를 `test_secret_detector` 가 고정한다.
    """
    if _PRIVATE_KEY_ARMOR_RE.fullmatch((value or "").strip()):
        return value
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}{'*' * (len(value) - 8)}{value[-4:]}"
