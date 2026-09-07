"""도메인-중립 finding 분류 헬퍼 — canonical task_type + 위험 분류(택소노미).

`agent/tools`(submit_finding) 와 `web/services`(domain_reports) 양쪽이 import 하는
중립 레이어. 한 곳에서 태깅/분류 규칙을 공유해 레이어 위반 없이 일관성을 유지한다.

- `canonical_task_type` : plugin 등록형(register_task_type_canonicalizer) task_type
  정규화 — 코어 기본은 passthrough. (구 v3.74 github/confluence/jenkins 자산기준
  교정 휴리스틱은 도메인 plugin 이 재공급.)
- `classify` : hit category(또는 asset_kind 폴백) → 사람이 읽는 한국어 분류 라벨.
"""
from __future__ import annotations

from collections import Counter
from typing import Any
from urllib.parse import urlparse


def host_of(value: str) -> str:
    """URL/경로/bare host 에서 host 부분만 소문자로."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        return (urlparse(raw if "://" in raw else f"//{raw}").hostname or "").lower()
    except Exception:
        return ""


# v3.82 U3b: task_type 정규화는 plugin 등록형 — 코어 기본 = passthrough.
# (구 코어 휴리스틱: github/confluence/wiki/jenkins host·prefix 매핑 — 도메인
# plugin 이 register_task_type_canonicalizer 로 재공급. asset identity dedup
# 함수(github/confluence_identity)는 소비자(domain_reports)와 함께 도메인
# 서비스로 이동.)
_TASK_TYPE_CANONICALIZERS: list = []


def register_task_type_canonicalizer(fn) -> None:
    """plugin task_type 정규화 등록. fn(task_type, asset) -> str | None (None=불변).

    등록 순서대로 시도, 첫 비-None 반환을 채택. 같은 함수 중복 등록은 명시 에러.
    """
    if fn in _TASK_TYPE_CANONICALIZERS:
        raise ValueError("task_type canonicalizer 이미 등록됨")
    _TASK_TYPE_CANONICALIZERS.append(fn)


def unregister_task_type_canonicalizer(fn) -> bool:
    try:
        _TASK_TYPE_CANONICALIZERS.remove(fn)
        return True
    except ValueError:
        return False


def canonical_task_type(task_type: str, asset: str) -> str:
    """자산기준 task_type 정규화 — 등록된 canonicalizer 순회, 없으면 입력 그대로."""
    for fn in _TASK_TYPE_CANONICALIZERS:
        mapped = fn(task_type, asset)
        if mapped:
            return str(mapped)
    return task_type


# hit category → 한국어 분류 라벨. de-domain (v3.81 T4, 확정 결정 ③):
# 코어 = 베이스 7종만. 도메인 분류(예: 구 semiconductor_process 7/'공정 정보',
# business_confidential 6/'경영 기밀')는 plugin 재부착이
# register_finding_category 로 등록한다 — 미등록 키는 라벨=원문, 우선순위=0.
_CLASSIFICATION_LABELS: dict[str, str] = {
    "secret": "시크릿 노출",
    "credential": "크리덴셜 노출",
    "pii": "개인정보 노출",
    "web_vuln": "웹 취약점",
    "misconfig": "설정 오류",
    "internal_system": "내부 시스템 정보",
    "attack_surface": "공격 표면",
}

# 대표 category 선택 우선순위 (민감/위험 높은 것 우선; 동률은 빈도로 tiebreak)
_CATEGORY_PRIORITY: dict[str, int] = {
    "credential": 9,
    "secret": 8,
    "pii": 5,
    "web_vuln": 4,
    "internal_system": 3,
    "misconfig": 2,
    "attack_surface": 1,
}


# content 증거(masked/preview) 필수 플래그가 켜진 plugin 분류 — evidence_judgment
# 의 코어 게이트(secret/pii/credential/internal_system)에 합류한다 (v3.82 U3a).
_CONTENT_EVIDENCE_KEYS: set[str] = set()


def register_finding_category(
    key: str, *, label: str, priority: int, requires_content_evidence: bool = False,
) -> None:
    """plugin 분류 등록 (v3.81 T4 plugin API) — 중복은 명시 에러.

    등록 즉시 classify/category_rank/classification_label 에 반영된다.
    priority 는 베이스 체계(1~9) 안에서 plugin 이 도메인 민감도에 맞게 배치.
    requires_content_evidence=True 면 evidence_judgment 의 content 증거 게이트
    (비어있지 않은 preview 또는 비-플레이스홀더 masked 필수)에 합류한다 —
    민감 분류(예: 공정/경영 기밀)는 켜서 증거 요구를 코어 4종과 동일하게.
    """
    k = str(key or "").strip()
    if not k:
        raise ValueError("category key 비어 있음")
    if k in _CLASSIFICATION_LABELS or k == _UNCATEGORIZED["key"]:
        raise ValueError(f"finding category {k!r} 이미 등록됨")
    _CLASSIFICATION_LABELS[k] = label
    _CATEGORY_PRIORITY[k] = int(priority)
    if requires_content_evidence:
        _CONTENT_EVIDENCE_KEYS.add(k)


def unregister_finding_category(key: str) -> bool:
    from secu_agent.agent.schema.finding import CORE_FINDING_CATEGORIES
    if key not in _CLASSIFICATION_LABELS or key in CORE_FINDING_CATEGORIES:
        return False  # 베이스 7종은 제거 불가
    _CLASSIFICATION_LABELS.pop(key, None)
    _CATEGORY_PRIORITY.pop(key, None)
    _CONTENT_EVIDENCE_KEYS.discard(key)
    return True


def plugin_content_evidence_categories() -> frozenset[str]:
    """requires_content_evidence=True 로 등록된 plugin 분류 집합 (evidence_judgment 소비)."""
    return frozenset(_CONTENT_EVIDENCE_KEYS)

# hit category 가 없을 때의 폴백 — 새 카테고리를 지어내지 않고 '미분류' 로만.
_UNCATEGORIZED = {"key": "uncategorized", "label": "미분류"}


def _hit_category(h: Any) -> str | None:
    if isinstance(h, dict):
        c = h.get("category")
    else:
        c = getattr(h, "category", None)
    return str(c) if c else None


def classify(*, hits: Any = None, asset_kind: str | None = None) -> dict[str, str]:
    """분류 = 등록된 category(베이스 7 + plugin 등록분)를 한국어 라벨로 매핑.

    대표 category = 우선순위 최댓값(동률 시 빈도). hit/category 가 없으면 '미분류'
    (등록 밖 신규 분류를 지어내지 않음). asset_kind 는 미사용.
    """
    cats = [c for c in (_hit_category(h) for h in (hits or [])) if c]
    if not cats:
        return dict(_UNCATEGORIZED)
    freq = Counter(cats)
    best = max(cats, key=lambda c: (_CATEGORY_PRIORITY.get(c, 0), freq[c]))
    return {"key": best, "label": _CLASSIFICATION_LABELS.get(best, best)}


def category_rank(key: str) -> int:
    """분류 key 의 정렬 우선순위 (높을수록 위험/우선). 미지/미분류는 0.

    v3.76: `_dedup`(여러 분류를 우선순위로 정렬) + facets 가 공유하는 단일 기준.
    """
    return _CATEGORY_PRIORITY.get(str(key or ""), 0)


def classification_label(key: str) -> str:
    """분류 key → 사람이 읽는 한국어 라벨. 미분류 key 는 '미분류', 그 외 미지 key 는 원문.

    v3.76: classification {key,label} 리스트를 만들 때 라벨을 일관되게 붙이는 단일 진입점.
    """
    k = str(key or "")
    if not k or k == _UNCATEGORIZED["key"]:
        return _UNCATEGORIZED["label"]
    return _CLASSIFICATION_LABELS.get(k, k)
