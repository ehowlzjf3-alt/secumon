"""finding 카테고리 분류 — 엔진 finding_taxonomy 의 read-경계 복제(엔진 무import·격리 유지).

카테고리는 finding_lifecycle 에 컬럼이 없고 오직 `extra_json.hits[].category`(+ confluence 수동
finding 의 상위 `hit_categories`)에만 있다. 여기서 hits 카테고리로 **대표 카테고리 + 전체 집합**을
도출한다(엔진 classify() 복제: 최고 우선순위 카테고리, 빈도 tiebreak).

카테고리 키는 **고정 어휘(allowlist)** — 미지 키는 드롭한다. 자유 텍스트가 아니라 열거값이므로
마스킹이 필요 없고, allowlist 밖 값은 애초에 표면화되지 않는다(주입/누출 표면 없음).
"""
from __future__ import annotations

from typing import Any

# 엔진 _CLASSIFICATION_LABELS(secu_agent.finding_taxonomy) + 스킬 bootstrap 등록
# (semiconductor_process=공정 정보, business_confidential=경영 기밀) 복제.
# 주의: 'secret' 은 출력 어휘에서 제외한다 — credential 로 병합(_ALIAS)되기 때문.
_LABELS: dict[str, str] = {
    "credential": "크리덴셜 노출",
    "pii": "개인정보 노출",
    "web_vuln": "웹 취약점",
    "misconfig": "설정 오류",
    "internal_system": "내부 시스템 정보",
    "attack_surface": "공격 표면",
    "semiconductor_process": "공정 정보",
    "business_confidential": "경영 기밀",
}
# 엔진 _CATEGORY_PRIORITY + 플러그인 우선순위(공정7·경영6). secret 은 credential 로 병합돼 별도 우선순위 없음.
_PRIORITY: dict[str, int] = {
    "credential": 9, "semiconductor_process": 7, "business_confidential": 6,
    "pii": 5, "web_vuln": 4, "internal_system": 3, "misconfig": 2, "attack_surface": 1,
}
# secret↔credential 은 개념적으로 겹친다(크리덴셜=시크릿의 일종) — 사용자 결정으로 'secret' 을
# 'credential' 로 병합해 중복 카테고리를 없앤다. DB hits[].category 의 'secret' 은 표시·필터·분류
# 전 경로에서 credential 로 canon 된다(_canon). 출력 어휘(_LABELS/칩)엔 secret 이 없다.
_ALIAS: dict[str, str] = {"secret": "credential"}


def _canon(c: Any) -> str | None:
    """입력 카테고리 → alias 적용 후 출력 어휘(_LABELS)에 있으면 canonical key, 아니면 None."""
    if not isinstance(c, str):
        return None
    c = _ALIAS.get(c, c)
    return c if c in _LABELS else None


def canon_param(c: str) -> str | None:
    """필터 파라미터 canon(secret→credential). 미지 키는 None(라우트에서 422)."""
    return _canon(c)


def expand_db_values(key: str) -> list[str]:
    """canonical key → 이 키로 canon 되는 DB 원시 카테고리 값들(필터 매칭용).
    credential → ['credential','secret'](병합), 그 외 → [key]."""
    return [key] + [raw for raw, canon in _ALIAS.items() if canon == key]


def known_keys() -> frozenset[str]:
    """유효 카테고리 키 allowlist(필터 파라미터 검증용) — 출력 어휘(secret 제외)."""
    return frozenset(_LABELS)


def all_categories() -> list[dict[str, str]]:
    """전 카테고리 {key,label} 우선순위 내림차순 — UI 필터 칩 어휘."""
    return [_cat(k) for k in sorted(_LABELS, key=lambda k: (-_PRIORITY.get(k, 0), k))]


def _cat(key: str) -> dict[str, str]:
    return {"key": key, "label": _LABELS[key]}


def categories_from_extra(extra: dict[str, Any]) -> list[str]:
    """extra_json 에서 hits[].category(우선) → 없으면 confluence 수동 finding 의 hit_categories.
    allowlist 밖·비문자열은 제외."""
    out: list[str] = []
    hits = extra.get("hits")
    if isinstance(hits, list):
        for h in hits:
            if isinstance(h, dict):
                cc = _canon(h.get("category"))
                if cc:
                    out.append(cc)
    if not out:
        hc = extra.get("hit_categories")
        if isinstance(hc, list):
            out = [cc for c in hc if (cc := _canon(c))]
    return out


def classify(hit_categories: list[str]) -> tuple[dict[str, str] | None, list[dict[str, str]]]:
    """알려진 카테고리 키 리스트 → (대표 {key,label} | None, 전체 [{key,label}] 우선순위 내림차순).

    빈/전부 미지면 대표=None(미분류). 대표 = 최고 _PRIORITY(동률이면 빈도 큰 쪽)."""
    freq: dict[str, int] = {}
    for c in hit_categories:
        cc = _canon(c)
        if cc:
            freq[cc] = freq.get(cc, 0) + 1
    if not freq:
        return None, []
    rep = max(freq, key=lambda k: (_PRIORITY.get(k, 0), freq[k]))
    ordered = sorted(freq, key=lambda k: (-_PRIORITY.get(k, 0), k))
    return _cat(rep), [_cat(k) for k in ordered]


def labels() -> dict[str, str]:
    """카테고리 키 → 한국어 라벨(출력 어휘). 웹 칩 라벨의 단일 진실원."""
    return dict(_LABELS)
