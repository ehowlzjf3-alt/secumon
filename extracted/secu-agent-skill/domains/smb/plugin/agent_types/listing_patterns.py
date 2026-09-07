"""Listing path 자체를 evidence로 판단하는 패턴들.

share 안의 파일이 본문 fetch 안 돼도, 파일 이름/경로만으로 의심 분류 가능한 케이스.
"""
from __future__ import annotations

import re
import importlib.util
import sys
from pathlib import Path

try:
    from _shared.detectors.document_sensitivity import path_has_document_signal
except ImportError:
    _DOC_PATH = Path(__file__).resolve().parents[4] / "_shared" / "detectors" / "document_sensitivity.py"
    _SPEC = importlib.util.spec_from_file_location("secu_skill_document_sensitivity_fallback", _DOC_PATH)
    if _SPEC is not None and _SPEC.loader is not None:
        _MOD = importlib.util.module_from_spec(_SPEC)
        sys.modules[_SPEC.name] = _MOD
        _SPEC.loader.exec_module(_MOD)
        path_has_document_signal = _MOD.path_has_document_signal
    else:
        def path_has_document_signal(_path: str) -> bool:
            return False

# 즉시 의심으로 분류되는 파일명 (확장자 없어도)
_HOT_FILENAMES = frozenset({
    ".env", ".envrc", ".netrc", ".pgpass", ".my.cnf",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
    "credentials", "secrets",
    "kubeconfig", ".kube",
    "wp-config.php",
    "database.yml", "secrets.yml",
    "shadow", "passwd",
})

# 이름 중 일부에 들어가면 의심
_NAME_SUBSTRINGS = (
    "secret", "credential", "password", "passwd", "private",
    "backup", "dump", "export",
    "회원", "사원", "고객", "주민", "개인정보",
    "기밀", "대외비",
)

# 한글 사용자 폴더 패턴 — '님' 으로 끝나면 보통 사람 이름 폴더
_KOREAN_USER_FOLDER = re.compile(r"[가-힣]{2,4}님(?:/|$|\\)")

# 사내 분류 코드 패턴 — 회사마다 다르므로 env로 확장 가능. 기본은 흔한 한국 반도체 분야 코드.
_INTERNAL_CODE_DEFAULTS = (
    re.compile(r"\b(SSD|HDD|DRAM|NAND|PMIC|VRM|CPU|GPU|SoC|MCU)\b"),
    re.compile(r"\b[A-Z]\d[A-Z]{2,4}\d{2,4}[A-Z]?\b"),   # e.g. S2FPS02A02
)


def suspicious(path: str) -> bool:
    """share-root 기준 path (e.g. 'subdir/file.env') 를 받아 의심 여부 판정."""
    base = path.rsplit("/", 1)[-1].lower()
    if base in _HOT_FILENAMES:
        return True
    pl = path.lower()
    if any(sub in pl for sub in _NAME_SUBSTRINGS):
        return True
    if path_has_document_signal(path):
        return True
    if _KOREAN_USER_FOLDER.search(path):
        return True
    for pat in _INTERNAL_CODE_DEFAULTS:
        if pat.search(path):
            return True
    return False
