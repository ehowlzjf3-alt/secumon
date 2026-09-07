"""print/spool 폴더 제외 (smb_domain_e2e 요구 2).

프린터 공유/스풀/드라이버 폴더는 walk 하강을 멈추고 파일 upsert 를 생략한다.
프린터 share 는 `smb_share.excluded_reason='print'` 로 제외하고, 하위 폴더 제외는
`smb_directory.error='excluded:print'` 호환 마커를 남긴다.
패턴은 env 로 확장 가능(`SMB_PRINT_SHARE_NAMES` / `SMB_PRINT_DIR_PATTERNS`, CSV).
"""
from __future__ import annotations

import os
import re

EXCLUDED_MARKER = "excluded:print"

# 프린터/스풀 share 명 (소문자 비교). 관리공유 print$/prnproc$ 포함.
_DEFAULT_SHARE_NAMES = frozenset({
    "print$", "prnproc$", "printer$", "drivers", "print", "spool",
})

# dir 경로(파트) 정규식 — 프린터·스풀·드라이버 스토어.
_DEFAULT_DIR_PATTERNS = (
    r"print",            # print, printers, printing
    r"프린터",
    r"프린트",
    r"spool",
    r"\bpcl\b",
    r"\bdrivers?\b",       # driver / drivers (프린터 드라이버 폴더)
    r"driverstore",
    r"driver[_\- ]?store",
    r"prnproc",
    r"\bw32x86\b",
    r"\bx64\b.*driver",
)


def _csv_env(name: str) -> tuple[str, ...]:
    raw = os.environ.get(name, "") or ""
    return tuple(p.strip() for p in raw.split(",") if p.strip())


def print_share_names() -> frozenset[str]:
    extra = {s.lower() for s in _csv_env("SMB_PRINT_SHARE_NAMES")}
    return _DEFAULT_SHARE_NAMES | frozenset(extra)


def _dir_regex() -> "re.Pattern[str]":
    pats = list(_DEFAULT_DIR_PATTERNS) + list(_csv_env("SMB_PRINT_DIR_PATTERNS"))
    return re.compile("|".join(f"(?:{p})" for p in pats), re.IGNORECASE)


_DIR_RE = _dir_regex()


def is_print_share(share: str) -> bool:
    """share 명이 프린터/드라이버 공유면 True (walk 자체를 건너뜀)."""
    return str(share or "").strip().lower() in print_share_names()


def is_print_dir(path: str) -> bool:
    """디렉터리 경로(또는 파일의 부모 경로)가 프린터/스풀/드라이버면 True."""
    p = str(path or "").strip().strip("/")
    if not p:
        return False
    return bool(_DIR_RE.search(p))


def is_print_path(path: str) -> bool:
    """파일/디렉터리 share-relative 경로가 프린터 폴더 하위면 True (파일 upsert 제외)."""
    p = str(path or "").strip().strip("/")
    if not p:
        return False
    # 경로의 어느 한 세그먼트라도 프린터 패턴이면 제외.
    for seg in p.split("/"):
        if _DIR_RE.search(seg):
            return True
    return False
