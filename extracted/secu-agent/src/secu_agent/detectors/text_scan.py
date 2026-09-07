"""AgentType/agent에서 호출하는 통합 텍스트 스캐너.

text → secrets + PII hit 통합 결과(라인 컨텍스트 포함)를 돌려준다.
agent_type는 이걸 그대로 finding 후보로 쓰고, agent도 동일 결과를 도구로 본다.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
import json
from pathlib import Path
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from secu_agent.detectors.pii import find_pii, mask_pii
from secu_agent.detectors.secrets import find_high_entropy, find_secrets, mask_secret

# de-domain (v3.81 T4): category 는 string — 코어 스캐너는
# secret/secret_heuristic/pii 만 방출하고, document_sensitivity(plugin)가
# 자기 도메인 분류를 들고 들어온다 (FindingCategory=str 와 동일 결).
HitCategory = str
_ENTROPY_HIT_LIMIT_PER_SCAN = 4

# de-domain (v3.84 #6): 문서-신호 스캐너는 등록형. 코어는 특정 plugin 모듈 경로를
# 몰라야 한다 — plugin 이 register_text_signal_scanner 로 (text, label=...) -> signals
# 함수를 등록하고, include_document_signals=True 일 때 코어가 등록된 스캐너를 순회
# 호출한다. signal 은 .category/.kind/.matched/.span/.source 를 갖는 duck-typed 객체.
# 등록 없음(코어 단독) = 문서 신호 없이 동작 (graceful degrade, 기존과 동일).
_TEXT_SIGNAL_SCANNERS: list = []


def register_text_signal_scanner(fn) -> None:
    """문서/텍스트 도메인 신호 스캐너 등록 (plugin 부트스트랩용).

    fn(text: str, label: str) -> Iterable[signal]. signal 은 category/kind/matched/
    span/source 속성을 갖는다 (구 document_sensitivity.scan_document_sensitivity 계약).
    """
    if not callable(fn):
        raise TypeError("text signal scanner 는 callable 이어야 한다")
    _TEXT_SIGNAL_SCANNERS.append(fn)


def unregister_all_text_signal_scanners() -> None:
    """등록 전체 해제 (테스트/재부착 멱등 보장용)."""
    _TEXT_SIGNAL_SCANNERS.clear()


@dataclass(frozen=True, slots=True)
class Hit:
    category: HitCategory
    kind: str
    masked: str
    line_no: int           # 1-based
    line_preview: str      # 양옆 잘라 ±60자
    span: tuple[int, int]  # text 내 offset


_URL_RE = re.compile(r"https?://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+")
_DEFAULT_PORTS = {"http": 80, "https": 443}
_SENSITIVE_QUERY_KEYS = {
    "access_token",
    "api_key",
    "apikey",
    "auth",
    "code",
    "credential",
    "jwt",
    "key",
    "pass",
    "password",
    "secret",
    "session",
    "sid",
    "signature",
    "token",
}
_SENSITIVE_QUERY_EXACT_KEYS = {"sig"}
_SENSITIVE_QUERY_PREFIXES = ("x-amz-", "x-goog-")
_STRUCTURED_SECRET_KEYS = {
    "access_token",
    "accesstoken",
    "api_key",
    "apikey",
    "api_token",
    "apitoken",
    "auth",
    "authorization",
    "bearer",
    "client_secret",
    "clientsecret",
    "credential",
    "credentials",
    "id_token",
    "idtoken",
    "jwt",
    "pass",
    "passwd",
    "password",
    "private_key",
    "privatekey",
    "refresh_token",
    "refreshtoken",
    "secret",
    "session_secret",
    "session_token",
    "sessionsecret",
    "sessiontoken",
    "token",
}
_STRUCTURED_SECRET_FIELD_RE = re.compile(
    r"(?P<prefix>(?:[\"'](?P<quoted_key>[A-Za-z0-9_.:-]{1,80})[\"']|"
    r"(?P<bare_key>[A-Za-z_][A-Za-z0-9_.:-]{0,79}))\s*[:=]\s*)"
    r"(?P<value>\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[^,\s}\]\n\r&;]{1,2000})",
    re.IGNORECASE,
)


def _mask_secret_value(value: str) -> str:
    if len(value) <= 8:
        return "<secret>"
    return value[:3] + "***" + value[-2:]


def _structured_key_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").lower()).strip("_")


def _is_structured_secret_key(value: str) -> bool:
    key = _structured_key_name(value)
    compact = key.replace("_", "")
    return key in _STRUCTURED_SECRET_KEYS or compact in _STRUCTURED_SECRET_KEYS


def _mask_structured_secret_object(value: object) -> object:
    if isinstance(value, dict):
        out: dict[str, object] = {}
        for key, item in value.items():
            if _is_structured_secret_key(str(key)):
                out[str(key)] = _mask_secret_value(str(item))
            else:
                out[str(key)] = _mask_structured_secret_object(item)
        return out
    if isinstance(value, list):
        return [_mask_structured_secret_object(item) for item in value]
    return value


def mask_structured_secret_fields(text: str) -> str:
    """Mask credential-like values in JSON/key-value content."""
    raw = str(text or "")
    stripped = raw.strip()
    if stripped.startswith(("{", "[")):
        try:
            parsed = json.loads(raw)
        except Exception:
            pass
        else:
            return json.dumps(
                _mask_structured_secret_object(parsed),
                ensure_ascii=False,
                separators=(",", ":"),
            )

    def _replace(match: re.Match[str]) -> str:
        key = match.group("quoted_key") or match.group("bare_key") or ""
        if not _is_structured_secret_key(key):
            return match.group(0)
        value = match.group("value") or ""
        quote = value[:1] if value[:1] in {"'", '"'} else ""
        if quote and value.endswith(quote):
            inner = value[1:-1]
            return f"{match.group('prefix')}{quote}{_mask_secret_value(inner)}{quote}"
        return f"{match.group('prefix')}{_mask_secret_value(value)}"

    return _STRUCTURED_SECRET_FIELD_RE.sub(_replace, raw)


def _is_sensitive_query_key(key: str) -> bool:
    key_l = str(key or "").lower()
    if key_l in _SENSITIVE_QUERY_EXACT_KEYS:
        return True
    if key_l.startswith(_SENSITIVE_QUERY_PREFIXES):
        return True
    return key_l in _SENSITIVE_QUERY_KEYS or any(part in key_l for part in _SENSITIVE_QUERY_KEYS)


def _sanitize_url(value: str) -> str:
    parsed = urlparse(str(value or "").strip())
    if not parsed.scheme or not parsed.netloc:
        return str(value or "")
    host = parsed.hostname or ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = host
    try:
        port = parsed.port
    except ValueError:
        port = None
    if port and port != _DEFAULT_PORTS.get(parsed.scheme.lower()):
        netloc = f"{netloc}:{port}"
    pairs = []
    for key, query_value in parse_qsl(parsed.query, keep_blank_values=True):
        if _is_sensitive_query_key(key):
            query_value = "<redacted>"
        elif len(query_value) > 256:
            query_value = query_value[:256] + "...[truncated]"
        pairs.append((key, query_value))
    return urlunparse((
        parsed.scheme,
        netloc,
        parsed.path,
        parsed.params,
        urlencode(pairs),
        "",
    ))


def mask_credential_urls(text: str) -> str:
    """Mask URL userinfo and credential-bearing query values in arbitrary text."""
    raw = str(text or "")

    def _replace(match: re.Match[str]) -> str:
        value = match.group(0)
        stripped = value.rstrip("'\"),;")
        suffix = value[len(stripped):]
        return _sanitize_url(stripped) + suffix

    return _URL_RE.sub(_replace, raw)


def _apply_masked_spans(
    text: str,
    masked_spans: list[tuple[tuple[int, int], str]],
) -> str:
    if not masked_spans:
        return text
    pieces: list[str] = []
    cur = 0
    for (start, end), masked in sorted(masked_spans, key=lambda item: item[0][0]):
        start = max(0, min(start, len(text)))
        end = max(start, min(end, len(text)))
        if end <= cur:
            continue
        if start > cur:
            pieces.append(text[cur:start])
        pieces.append(masked)
        cur = end
    if cur < len(text):
        pieces.append(text[cur:])
    return "".join(pieces)


# ── 개인키 본문 — span 마스킹으로는 원리적으로 못 잡는다 ──────────────────
# `private_key_block` 룰은 **헤더만** 매칭하고, PEM 블록 안의 base64 줄은
# find_high_entropy 가 일부러 억제한다(키 1건이 수백 hit 로 폭발하는 걸 막으려고 —
# test_high_entropy_suppressed_inside_pem_block). 그래서 본문은 어떤 hit 의 span 도
# 아니고, span 기반 마스킹을 아무리 돌려도 **평문 그대로 영속된다.**
#
# 실측(2026-08-23): `core.finding_lifecycle` 최근 smb finding 400건 중 9건이 RSA/PGP
# 개인키 본문을 평문으로 담고 있었다(2026-08-16 ~ 08-23). 워커가 원문을 preview 에
# 붙여 넣으면 그대로 저장된다. `redact_sensitive_text` 의 PEM 규칙은 `-----END-----`
# 를 요구해서, 잘린 블록(워커가 흔히 붙이는 형태)은 걸리지 않았다.
#
# ★ 정책: **헤더는 증거, 본문은 비밀.** armor 마커는 남겨 게이트가 개인키임을 확인할
#   수 있게 하고(그게 없으면 개인키 finding 을 아예 낼 수 없다), 본문만 지운다.
#   END 마커가 없으면 문자열 끝까지가 본문이다.
_PRIVATE_KEY_BODY_RE = re.compile(
    r"(-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----)"
    r"([\s\S]*?)"
    r"(-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|\Z)",
    re.I,
)
_KEY_BODY_PLACEHOLDER = "[REDACTED KEY BODY]"


def redact_private_key_bodies(text: str) -> str:
    """armor 마커는 남기고 그 사이 본문만 지운다(영속/egress 경계 전용)."""
    def _sub(m: "re.Match[str]") -> str:
        body = m.group(2)
        if not body.strip():
            return m.group(0)
        return f"{m.group(1)}\n{_KEY_BODY_PLACEHOLDER}\n{m.group(3)}"
    return _PRIVATE_KEY_BODY_RE.sub(_sub, text)


def mask_scanned_text(
    text: str,
    *,
    max_chars: int | None = None,
    label: str | None = None,
    include_entropy: bool = False,
) -> str:
    """Canonical persisted-content mask: structured secrets, credential URLs, secrets, and PII."""
    raw = str(text or "")
    if max_chars is not None:
        raw = raw[:max(0, int(max_chars))]
    prepared = mask_credential_urls(mask_structured_secret_fields(raw))
    # span 마스킹 **전에** 본문을 지운다 — 본문은 어떤 span 도 아니라 뒤에 하면 늦다.
    prepared = redact_private_key_bodies(prepared)
    scan = scan_text(prepared, label=label, include_entropy=include_entropy)
    return _apply_masked_spans(prepared, [(hit.span, hit.masked) for hit in scan.hits])


# F3: 영속/egress 경계 전용 재귀 마스킹 placeholder(마스킹 실패/과깊이/순환 시 원문 통과 금지).
_MASK_DEEP_FAILCLOSED = "<masked:unwalkable>"


def mask_deep(
    obj: Any,
    *,
    preserve_keys: frozenset[str] = frozenset(),
    _depth: int = 0,
    _max_depth: int = 40,
    _seen: set[int] | None = None,
) -> Any:
    """dict/list/tuple/set 을 재귀하며 **모든 str leaf 를 `mask_scanned_text` 로 마스킹**한다.

    **영속/egress 경계 전용** — tool 반환·in-memory 증거 수집 계층엔 절대 쓰지 마라(실값
    유지해야 딥다이브가 산다). fail-closed: leaf 마스킹 중 예외/과깊이/순환이면 원문이 아니라
    고정 placeholder 로 대체(평문 유출 금지). 비-str leaf(int/float/bool/None)는 그대로.
    `preserve_keys`: dict 에서 값을 마스킹하지 않고 그대로 둘 키(비민감 제어 필드; 단 그 값이
    dict/list 면 재귀는 하되 마스킹만 생략하지 않음 — 정확히는 그 키의 str 값만 verbatim).
    """
    if _seen is None:
        _seen = set()
    if _depth > _max_depth:
        return _MASK_DEEP_FAILCLOSED
    if isinstance(obj, str):
        try:
            return mask_scanned_text(obj)
        except Exception:  # noqa: BLE001 — 마스킹 실패가 원문을 흘리면 안 됨
            return _MASK_DEEP_FAILCLOSED
    if isinstance(obj, (bool, int, float)) or obj is None:
        return obj
    if isinstance(obj, Mapping):
        oid = id(obj)
        if oid in _seen:
            return _MASK_DEEP_FAILCLOSED
        _seen.add(oid)
        out = {}
        for k, v in obj.items():
            if isinstance(k, str) and k in preserve_keys and isinstance(v, str):
                out[k] = v  # 비민감 제어 필드의 str 값은 verbatim 보존
            else:
                out[k] = mask_deep(
                    v, preserve_keys=preserve_keys, _depth=_depth + 1,
                    _max_depth=_max_depth, _seen=_seen,
                )
        _seen.discard(oid)
        return out
    if isinstance(obj, (list, tuple, set)):
        oid = id(obj)
        if oid in _seen:
            return _MASK_DEEP_FAILCLOSED
        _seen.add(oid)
        items = [
            mask_deep(v, preserve_keys=preserve_keys, _depth=_depth + 1,
                      _max_depth=_max_depth, _seen=_seen)
            for v in obj
        ]
        _seen.discard(oid)
        return items if isinstance(obj, list) else (
            tuple(items) if isinstance(obj, tuple) else items
        )
    # 알 수 없는 타입(객체 등) — str 화해 마스킹(원문 유출 방지).
    try:
        return mask_scanned_text(str(obj))
    except Exception:  # noqa: BLE001
        return _MASK_DEEP_FAILCLOSED


def _line_index(text: str) -> list[tuple[int, int]]:
    """각 라인의 (start_offset, end_offset_exclusive). 1-based 인덱싱 편의."""
    spans: list[tuple[int, int]] = []
    start = 0
    for i, ch in enumerate(text):
        if ch == "\n":
            spans.append((start, i))
            start = i + 1
    spans.append((start, len(text)))
    return spans


def _line_for_offset(line_spans: list[tuple[int, int]], offset: int) -> int:
    """offset → 1-based line. binary search 안 써도 텍스트 크기 한계로 충분."""
    for i, (s, e) in enumerate(line_spans, start=1):
        if s <= offset <= e:
            return i
    return len(line_spans)


def _span_overlaps(span: tuple[int, int], taken: list[tuple[int, int]]) -> bool:
    start, end = span
    return any(start < taken_end and end > taken_start for taken_start, taken_end in taken)


def _preview(
    text: str, span: tuple[int, int], radius: int = 60,
    *, masked_spans: list[tuple[tuple[int, int], str]] | None = None,
) -> str:
    """매치 주변 ±radius 미리보기.

    v3.79 ③-3: masked_spans(전체 hit 의 (span, masked)) 가 주어지면 윈도우와
    겹치는 모든 hit 구간을 masked 값으로 치환 — raw 시크릿/PII 가 preview 로
    DB/evidence 에 누출되던 것 차단 (자기 자신 + 같은 줄의 다른 hit 포함).
    """
    s = max(0, span[0] - radius)
    e = min(len(text), span[1] + radius)
    if not masked_spans:
        snippet = text[s:e]
    else:
        pieces: list[str] = []
        cur = s
        for (ms, me), mval in masked_spans:  # span 시작 오름차순 전제
            if me <= cur or ms >= e:
                continue  # 윈도우 밖 또는 이미 지난 구간
            if ms > cur:
                pieces.append(text[cur:ms])
            pieces.append(mval)
            cur = max(cur, me)
        if cur < e:
            pieces.append(text[cur:e])
        snippet = "".join(pieces)
    snippet = mask_credential_urls(mask_structured_secret_fields(snippet))
    snippet = snippet.replace("\n", " ⏎ ")
    return ("…" if s > 0 else "") + snippet + ("…" if e < len(text) else "")


@dataclass(slots=True)
class ScanResult:
    hits: list[Hit] = field(default_factory=list)
    bytes_scanned: int = 0

    @property
    def has_findings(self) -> bool:
        return bool(self.hits)


def scan_text(
    text: str,
    *,
    label: str | None = None,
    include_entropy: bool = False,
    include_document_signals: bool = False,
) -> ScanResult:
    """text 한 덩어리 스캔. label은 호출 측이 'file:<url>' 등 트레이싱용으로 사용."""
    result = ScanResult(bytes_scanned=len(text.encode("utf-8", errors="ignore")))
    if not text:
        if not include_document_signals:
            return result

    line_spans = _line_index(text)

    # v3.79 ③-3: 전체 hit 을 먼저 수집 — preview 생성 시 윈도우와 겹치는 모든
    # hit 구간(자기 자신 + 이웃 hit)을 masked 값으로 치환하기 위함.
    raw: list[tuple[HitCategory, str, str, tuple[int, int]]] = []
    for s_hit in find_secrets(text):
        raw.append(("secret", s_hit.kind, mask_secret(s_hit.matched), s_hit.span))
    if include_entropy:
        taken = [span for _, _, _, span in raw]
        for e_hit in find_high_entropy(text, max_hits=_ENTROPY_HIT_LIMIT_PER_SCAN):
            if _span_overlaps(e_hit.span, taken):
                continue
            raw.append((
                "secret_heuristic",
                e_hit.kind,
                mask_secret(e_hit.matched),
                e_hit.span,
            ))
            taken.append(e_hit.span)
    for p_hit in find_pii(text):
        raw.append(("pii", p_hit.kind, mask_pii(p_hit.matched, p_hit.kind), p_hit.span))
    raw.sort(key=lambda t: t[3][0])
    masked_spans = [(span, masked) for _, _, masked, span in raw]

    hits: list[Hit] = []
    for category, kind, masked, span in raw:
        hits.append(Hit(
            category=category,
            kind=kind,
            masked=masked,
            line_no=_line_for_offset(line_spans, span[0]),
            line_preview=_preview(text, span, masked_spans=masked_spans),
            span=span,
        ))

    if include_document_signals:
        # de-domain v3.84 #6: 등록된 문서-신호 스캐너를 순회 호출 (코어는 plugin 모듈
        # 경로를 모른다). 등록 없음 = 신호 없음 (graceful degrade, 기존과 동일).
        sigs: list = []
        for scanner in _TEXT_SIGNAL_SCANNERS:
            try:
                sigs.extend(scanner(text, label=label) or [])
            except Exception:
                continue
        for sig in sigs:
            span = sig.span or (0, 0)
            if sig.span is None:
                if sig.source == "path":
                    preview = f"path keyword: {sig.matched}; path={label or ''}"
                    line_no = 0
                else:
                    preview = sig.matched
                    line_no = 0
            else:
                preview = _preview(text, span, masked_spans=masked_spans)
                line_no = _line_for_offset(line_spans, span[0])
            hits.append(Hit(
                category=sig.category,
                kind=sig.kind,
                masked=sig.matched,
                line_no=line_no,
                line_preview=preview,
                span=span,
            ))

    result.hits = hits
    return result


def scan_file(
    path: str | Path,
    *,
    label: str | None = None,
    include_entropy: bool = False,
    include_document_signals: bool = False,
    chunk_chars: int = 1024 * 1024,
    overlap_chars: int = 4096,
) -> ScanResult:
    """Stream a text file through the canonical scan_text detector path.

    The caller gets the same ScanResult/Hit shape as scan_text while memory use
    stays bounded to one decoded chunk plus a small overlap window.
    """
    p = Path(path)
    chunk_size = max(4096, int(chunk_chars))
    overlap_size = max(0, int(overlap_chars))
    result = ScanResult()
    seen: set[tuple[str, str, int, int, str]] = set()
    overlap = ""
    chunk_start_char = 0
    line_no_at_chunk_start = 1

    with p.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        while True:
            chunk = fh.read(chunk_size)
            if not chunk:
                break

            window = overlap + chunk
            window_start_char = chunk_start_char - len(overlap)
            window_start_line = line_no_at_chunk_start - overlap.count("\n")
            scanned = scan_text(
                window,
                label=label,
                include_entropy=include_entropy,
                include_document_signals=include_document_signals,
            )

            for hit in scanned.hits:
                if hit.span == (0, 0) and window_start_char != 0:
                    continue
                if hit.span != (0, 0) and hit.span[1] <= len(overlap):
                    continue
                global_start = window_start_char + hit.span[0]
                global_end = window_start_char + hit.span[1]
                key = (
                    str(hit.category),
                    hit.kind,
                    global_start,
                    global_end,
                    hit.masked,
                )
                if key in seen:
                    continue
                seen.add(key)
                line_no = window_start_line + window.count("\n", 0, hit.span[0])
                result.hits.append(Hit(
                    category=hit.category,
                    kind=hit.kind,
                    masked=hit.masked,
                    line_no=line_no,
                    line_preview=hit.line_preview,
                    span=(global_start, global_end),
                ))

            chunk_start_char += len(chunk)
            line_no_at_chunk_start += chunk.count("\n")
            overlap = window[-overlap_size:] if overlap_size else ""

    try:
        result.bytes_scanned = p.stat().st_size
    except OSError:
        result.bytes_scanned = chunk_start_char
    return result
