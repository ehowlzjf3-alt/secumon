"""paste_format — 사용자가 붙여넣은 long-text 의 구조 감지.

가벼운 regex 기반. 첫 1000 chars 만 샘플링. 70%+ 매치되면 hint 반환.
None 이면 hint 안 줌 (자연어 / 뒤죽박죽).

agent (특히 weaker model 인 gpt-oss-120b) 가 stub 만 보고도 "이건 CIDR list 1610개"
같은 판단 빠르게 하도록 도와주는 용도.
"""
from __future__ import annotations

import json as _json
import re

_SAMPLE_CHARS = 1000
_MAX_LINES = 30
_MIN_LINES = 3
_RATIO = 0.7


def _lines(sample: str) -> list[str]:
    return [l.strip() for l in sample.splitlines() if l.strip()][:_MAX_LINES]


def _ratio(lines: list[str], pat: re.Pattern[str]) -> float:
    if not lines:
        return 0.0
    c = sum(1 for l in lines if pat.match(l))
    return c / len(lines)


# 컴파일된 regex
# CIDR-like hinting is intentionally regex-only. Pasted inventory lists are often
# rough exports, and strict CIDR validation happens later in subnet tools.
_RE_CIDR = re.compile(r"^\d{1,3}(\.\d{1,3}){3,4}/\d{1,2}\s*[,;]?$")
_RE_IP = re.compile(r"^\d{1,3}(\.\d{1,3}){3}\s*[,;]?$")
_RE_HOST = re.compile(
    r"^[a-zA-Z0-9][a-zA-Z0-9-]*(\.[a-zA-Z0-9][a-zA-Z0-9-]*){1,}\s*[,;]?$",
)
_RE_URL = re.compile(r"^https?://")
_RE_HASH = re.compile(r"^[0-9a-fA-F]{32,128}$")
_RE_YAML_KV = re.compile(r"^[A-Za-z_][\w-]*\s*:\s*\S")
_RE_PY = re.compile(r"^(import |from \w+ import|def \w|class \w|@\w)")
_RE_LOG_ISO = re.compile(
    r"^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}"
    r"|\[\d{4}-\d{2}-\d{2}|\w{3}\s+\d{1,2}\s+\d{2}:\d{2})",
)


def _fmt_hint(name: str, ratio: float) -> str:
    pct = int(round(ratio * 100))
    return f"{name} ({pct}%)"


def _try_json(sample: str) -> bool:
    stripped = sample.lstrip()
    if not stripped or stripped[0] not in "{[":
        return False
    # truncated 라도 prefix 만으로 detect — 짧게 잘라서 try
    for end in (len(sample), 4000, 2000, 800):
        try:
            _json.loads(sample[:end])
            return True
        except Exception:
            continue
    return False


def _looks_like_csv(lines: list[str]) -> tuple[bool, float]:
    """모든 라인에 같은 개수의 콤마 (또는 탭) — 최소 2개."""
    if len(lines) < 3:
        return False, 0.0
    for sep in (",", "\t"):
        counts = [l.count(sep) for l in lines]
        first = counts[0]
        if first < 1:
            continue
        same = sum(1 for c in counts if c == first)
        ratio = same / len(counts)
        if ratio >= _RATIO and first >= 1:
            return True, ratio
    return False, 0.0


def detect_format(text: str) -> str | None:
    if not text or len(text.strip()) < 8:
        return None
    sample = text[:_SAMPLE_CHARS]
    lines = _lines(sample)
    if len(lines) < _MIN_LINES:
        # JSON 같이 한 줄 도 있을 수 있음 — JSON 만 검사
        if _try_json(sample):
            return "json"
        return None

    # 1) JSON — 시작이 { 또는 [
    if _try_json(sample):
        return "json"

    # 2) cidr_list — 강하게 매칭
    r = _ratio(lines, _RE_CIDR)
    if r >= _RATIO:
        return _fmt_hint("cidr_list", r)

    # 3) ip_list — CIDR 아닌 plain IP. CIDR 매칭 후에 검사 (선후순서 중요)
    # cidr 가 위에서 안 잡힌 라인들 대상으로 다시 검사하지 않고, IP 패턴 전체 비율로 본다.
    r = _ratio(lines, _RE_IP)
    if r >= _RATIO:
        return _fmt_hint("ip_list", r)

    # 4) url_list
    r = _ratio(lines, _RE_URL)
    if r >= _RATIO:
        return _fmt_hint("url_list", r)

    # 5) hash_list
    r = _ratio(lines, _RE_HASH)
    if r >= _RATIO:
        return _fmt_hint("hash_list", r)

    # 6) python_code — '들여쓰기 패턴' or import/def/class
    py_marker = sum(1 for l in lines if _RE_PY.match(l))
    indent = sum(1 for l in lines if l.startswith((" ", "\t")) or l != l.lstrip())
    if py_marker >= 2 or (py_marker >= 1 and indent >= 2):
        return f"python_code"

    # 7) yaml — 시작 '---' 또는 key:value 패턴 다수
    if lines[0] == "---" or _ratio(lines, _RE_YAML_KV) >= _RATIO:
        r = _ratio(lines, _RE_YAML_KV)
        if r > 0:
            return _fmt_hint("yaml", r)
        return "yaml"

    # 8) log_lines — ISO timestamp / syslog
    r = _ratio(lines, _RE_LOG_ISO)
    if r >= _RATIO:
        return _fmt_hint("log_lines", r)

    # 9) csv / tsv
    is_csv, r = _looks_like_csv(lines)
    if is_csv:
        return _fmt_hint("csv", r)

    # 10) hostname_list — IP / URL 안 잡히면 시도 (느슨한 패턴이라 마지막)
    r = _ratio(lines, _RE_HOST)
    if r >= _RATIO:
        return _fmt_hint("hostname_list", r)

    return None
