"""Document sensitivity signals for SMB content triage.

This detector is deliberately keyword/score based. It does not create findings by
itself; callers surface the signals so the agent can confirm the file context
before submitting semiconductor process or business-confidential findings.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Literal


DocumentCategory = Literal["semiconductor_process", "business_confidential"]


@dataclass(frozen=True, slots=True)
class DocumentSignal:
    category: DocumentCategory
    kind: str
    matched: str
    span: tuple[int, int] | None
    source: Literal["path", "title", "body", "classifier"]
    score: int = 0


_PROCESS_PATH_TERMS = (
    "공정", "공정조건", "레시피", "recipe", "wafer", "웨이퍼", "수율",
    "yield", "불량", "defect", "fab", "mask", "reticle", "euv",
    "litho", "photo", "etch", "cvd", "pvd", "ald", "cmp", "implant",
    "spc", "fdc", "dram", "nand", "반도체",
)
_PROCESS_TITLE_TERMS = (
    "공정 조건", "공정조건", "공정 레시피", "process recipe",
    "recipe sheet", "wafer map", "수율 분석", "불량 분석", "defect review",
    "etch 조건", "implant dose", "spc report", "fdc report",
)
_PROCESS_BODY_TERMS = (
    "공정 조건", "공정조건", "레시피", "recipe id", "wafer id", "lot id",
    "mask layer", "reticle", "implant dose", "etch rate", "deposition",
    "thickness", "cd uniformity", "overlay", "defect density", "yield loss",
    "spc", "fdc", "euv", "photoresist", "노광", "식각", "증착",
    "이온주입", "박막", "계측", "웨이퍼맵", "수율", "불량률",
)

_BUSINESS_PATH_TERMS = (
    "경영", "사업계획", "사업 전략", "매출", "손익", "영업이익", "원가",
    "단가", "견적", "가격표", "고객사", "계약", "입찰", "예산",
    "투자계획", "실적", "forecast", "revenue", "margin", "pnl", "p&l",
    "budget", "pricing", "quotation", "contract", "customer", "roadmap",
    "m&a", "임원회의",
)
_BUSINESS_TITLE_TERMS = (
    "경영 계획", "사업계획", "사업 전략", "매출 계획", "손익 계획",
    "영업이익", "원가 분석", "가격 전략", "고객사 전략", "입찰 전략",
    "투자 계획", "budget plan", "revenue forecast", "pricing strategy",
    "quarterly business review", "executive meeting",
)
_BUSINESS_BODY_TERMS = (
    "매출 계획", "매출액", "영업이익", "손익", "원가율", "매출총이익",
    "고객사", "계약금액", "입찰", "견적", "단가", "가격 정책",
    "사업계획", "투자계획", "분기 실적", "gross margin",
    "operating profit", "revenue forecast", "customer pipeline",
    "pricing", "quotation", "contract value", "budget", "p&l",
)

_CONFIDENTIAL_MARKERS = (
    "대외비", "사외비", "기밀", "confidential", "internal only",
    "restricted", "nda",
)

_WORDISH = re.compile(r"[A-Za-z0-9가-힣]+")


# ASCII 용어는 **단어 경계**를 요구한다. 한글은 요구하지 않는다.
#
# ★ 왜 — 이 목록엔 `fab`·`fdc`·`etch`·`cmp`·`euv`·`ald`·`nda` 같은 3~4글자 ASCII 가 있고,
#   경계 없이 substring 매치하면 **hex·GUID·base64 안에서 상시 걸린다.**
#   실측 2026-08-29 (smb_file_hit, semiconductor_process):
#       path_keyword  1,588건 중 1,185건(74.6%) 오탐 — 전부 SHA256 파일명 안의 fab/fdc
#       body/title    2,519건 중   933건(37.0%) 오탐 — GUID 안의 fdc
#       합계 4,107건 중 2,118건(51.6%)이 오탐
#   표본: `...A7F5DC73DE317F972AFDCC3830...` 에서 `fdc`,
#         `...C02923D0F3757BD93FFABE6FB6C598.INI` 에서 `fab`.
#
# ⚠️ 한글에 경계를 걸면 안 된다 — 교착어라 `공정자료`·`레시피를` 처럼 붙어 쓴다.
#    `(?<![A-Za-z0-9])` 는 한글 앞뒤를 막지 않으므로 `fab공정` 같은 혼용은 계속 잡힌다.
#
# 경계 표현은 엔진 전례를 따른다 — `secu_agent/detectors/secrets.py:36 _TOKEN_PRE`,
# `agent/evidence_judgment.py:131`. `\b` 는 `_` 를 단어문자로 봐서 `p&l`·`m&a` 처럼
# 비단어 문자가 든 용어에서 어긋난다.
_ASCII_BOUNDARY_PRE = r"(?<![A-Za-z0-9])"
_ASCII_BOUNDARY_POST = r"(?![A-Za-z0-9])"


def _find_phrase(text: str, phrase: str) -> re.Match[str] | None:
    if phrase.isascii():
        pat = _ASCII_BOUNDARY_PRE + re.escape(phrase) + _ASCII_BOUNDARY_POST
        return re.search(pat, text, re.IGNORECASE)
    return re.search(re.escape(phrase), text, 0)


def _first_match(text: str, terms: tuple[str, ...]) -> tuple[str, tuple[int, int]] | None:
    best: tuple[int, str, tuple[int, int]] | None = None
    for term in terms:
        m = _find_phrase(text, term)
        if not m:
            continue
        item = (m.start(), term, m.span())
        if best is None or item[0] < best[0]:
            best = item
    if best is None:
        return None
    return best[1], best[2]


def _title_region(text: str) -> tuple[str, int]:
    """Return likely title/header text and its starting offset in the original body."""
    if not text:
        return "", 0
    pos = 0
    lines: list[str] = []
    first_offset: int | None = None
    for raw_line in text.splitlines(keepends=True)[:30]:
        stripped = raw_line.strip()
        if stripped:
            if first_offset is None:
                first_offset = pos + raw_line.find(stripped)
            lines.append(stripped)
        pos += len(raw_line)
        if len(lines) >= 8 or sum(len(x) for x in lines) >= 1600:
            break
    return "\n".join(lines)[:2000], (first_offset or 0)


def _terms_present(text: str, terms: tuple[str, ...]) -> set[str]:
    found: set[str] = set()
    for term in terms:
        if _find_phrase(text, term):
            found.add(term)
    return found


def _marker_score(text: str) -> int:
    return 2 if _terms_present(text, _CONFIDENTIAL_MARKERS) else 0


def _body_score(
    body_text: str,
    label_text: str,
    title_text: str,
    *,
    category: DocumentCategory,
) -> tuple[int, set[str]]:
    if category == "semiconductor_process":
        path_terms = _terms_present(label_text, _PROCESS_PATH_TERMS)
        title_terms = _terms_present(title_text, _PROCESS_TITLE_TERMS)
        body_terms = _terms_present(body_text, _PROCESS_BODY_TERMS)
    else:
        path_terms = _terms_present(label_text, _BUSINESS_PATH_TERMS)
        title_terms = _terms_present(title_text, _BUSINESS_TITLE_TERMS)
        body_terms = _terms_present(body_text, _BUSINESS_BODY_TERMS)

    matched = path_terms | title_terms | body_terms
    score = len(path_terms) * 2 + len(title_terms) * 3 + len(body_terms)
    score += _marker_score(label_text) + _marker_score(title_text) + _marker_score(body_text[:8000])

    # Dense tabular/list documents with many domain words are more likely real
    # business/process material than a one-off mention in a README.
    if len(_WORDISH.findall(body_text[:12000])) >= 80 and len(body_terms) >= 3:
        score += 2
    return score, matched


def path_has_document_signal(path: str) -> bool:
    raw = str(path or "")
    return bool(
        _first_match(raw, _PROCESS_PATH_TERMS)
        or _first_match(raw, _BUSINESS_PATH_TERMS)
    )


def scan_document_sensitivity(
    text: str,
    *,
    label: str | None = None,
    max_hits: int = 8,
) -> list[DocumentSignal]:
    """Return path/title/body/classifier signals for valuable internal documents."""
    raw = str(text or "")
    label_text = str(label or "")
    title_text, title_offset = _title_region(raw)
    signals: list[DocumentSignal] = []

    def add(
        category: DocumentCategory,
        kind: str,
        matched: str,
        span: tuple[int, int] | None,
        source: Literal["path", "title", "body", "classifier"],
        score: int = 0,
    ) -> None:
        key = (category, kind, matched.lower(), source)
        if any((s.category, s.kind, s.matched.lower(), s.source) == key for s in signals):
            return
        signals.append(DocumentSignal(category, kind, matched, span, source, score))

    path_match = _first_match(label_text, _PROCESS_PATH_TERMS)
    if path_match:
        add("semiconductor_process", "path_keyword", path_match[0], None, "path")
    path_match = _first_match(label_text, _BUSINESS_PATH_TERMS)
    if path_match:
        add("business_confidential", "path_keyword", path_match[0], None, "path")

    title_match = _first_match(title_text, _PROCESS_TITLE_TERMS)
    if title_match:
        term, span = title_match
        add(
            "semiconductor_process",
            "document_title_keyword",
            term,
            (title_offset + span[0], title_offset + span[1]),
            "title",
        )
    title_match = _first_match(title_text, _BUSINESS_TITLE_TERMS)
    if title_match:
        term, span = title_match
        add(
            "business_confidential",
            "document_title_keyword",
            term,
            (title_offset + span[0], title_offset + span[1]),
            "title",
        )

    body_match = _first_match(raw, _PROCESS_BODY_TERMS)
    if body_match:
        add("semiconductor_process", "document_body_keyword", body_match[0], body_match[1], "body")
    body_match = _first_match(raw, _BUSINESS_BODY_TERMS)
    if body_match:
        add("business_confidential", "document_body_keyword", body_match[0], body_match[1], "body")

    process_score, process_terms = _body_score(
        raw[:200_000], label_text, title_text, category="semiconductor_process",
    )
    if process_score >= 5 and len(process_terms) >= 2:
        terms = ", ".join(sorted(process_terms)[:5])
        add(
            "semiconductor_process",
            "sample_body_classifier",
            f"score={process_score}; terms={terms}",
            None,
            "classifier",
            process_score,
        )

    business_score, business_terms = _body_score(
        raw[:200_000], label_text, title_text, category="business_confidential",
    )
    if business_score >= 5 and len(business_terms) >= 2:
        terms = ", ".join(sorted(business_terms)[:5])
        add(
            "business_confidential",
            "sample_body_classifier",
            f"score={business_score}; terms={terms}",
            None,
            "classifier",
            business_score,
        )

    def rank(sig: DocumentSignal) -> tuple[int, int]:
        source_weight = {"classifier": 4, "title": 3, "body": 2, "path": 1}[sig.source]
        return source_weight, sig.score

    return sorted(signals, key=rank, reverse=True)[:max(0, int(max_hits))]
