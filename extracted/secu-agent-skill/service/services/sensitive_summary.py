"""조치요청 메일의 "확인된 민감 항목" — 4도메인 공용 (SSOT).

## 왜 공용인가

같은 개념을 도메인마다 적으면 어긋난다. 오늘만 두 번 봤다 — 개인키 armor 정규식(탐지기 vs
증거게이트)과 confluence space_key 파서(게이트웨이 vs 리포터). 분류표·라벨·조치문구는
**여기 하나뿐**이고 도메인은 렌더 결과만 끼워 넣는다.

## 경계 — 이 모듈의 본체는 "무엇을 안 싣는가" 다

조치요청 메일은 전달·회신으로 퍼지고 메일함에 남는다. 경로·파일명·마스킹 값·kind 이름이
실리면 **메일 자체가 새 노출 경로**가 된다. 그래서 여기서 나가는 건 **분류 라벨과 건수뿐**이다.
담당자가 우선순위를 정할 만큼만 알려주고 상세는 DS보안관제 문의로 돌린다.

실측 근거(2026-08-23 SMB): open finding 713건 중 개인키 계열 hit 73건 · 크리덴셜 115건.
그런데 메일은 "부서/전사 열람 공유 3건" 이라고만 말하고 있었다 — 담당자는 권한만 정리하면
끝나는 줄 알았다.

스타일은 인라인이다(도메인 CSS 클래스에 기대지 않는다 — 메일 클라이언트도 그래야 안전하다).
"""
from __future__ import annotations

from html import escape
from typing import Any

#: hit 분류 → 사람 말. 순서가 곧 표의 순서(급한 것부터).
#: `misconfig`(공유 권한 자체)는 없다 — 메일 본문이 이미 다루는 주제라 겹친다.
SENSITIVE_LABELS: tuple[tuple[str, str], ...] = (
    ("private_key", "개인키"),
    ("credential", "크리덴셜·비밀번호"),
    ("pii", "개인정보"),
    ("confidential", "공정·기밀 문서"),
    ("internal_system", "내부 시스템 정보"),
)

_CONFIDENTIAL_CATEGORIES = frozenset({
    "semiconductor_process", "internal_document", "business_confidential",
})

#: 분류별 추가 조치. 해당 분류가 **실제로 있을 때만** 붙인다 —
#: 없는 항목까지 나열하면 담당자가 무엇이 자기 일인지 못 고른다.
#:
#: ★ 공통 논지: 권한을 닫아도 **이미 열람된 자격증명은 계속 유효하다.** 그래서 교체와
#:   접속 이력 점검을 함께 말한다. 파일 삭제만으로는 끝나지 않는다.
SENSITIVE_ACTIONS: dict[str, tuple[str, ...]] = {
    "private_key": (
        "노출된 키는 **이미 회수되었다고 가정하고** 즉시 폐기·재발급해 주세요. "
        "파일만 지우는 것으로는 부족합니다.",
        "해당 키를 쓰는 서버·서비스의 최근 접속 로그를 점검해 비인가 접근 흔적이 있는지 "
        "확인해 주세요.",
        "같은 키가 다른 서버, 배포 스크립트, 백업본에 재사용되었는지 확인해 주세요.",
    ),
    "credential": (
        "노출된 비밀번호·접속 문자열은 즉시 변경해 주세요. 같은 값을 쓰는 계정이 있으면 "
        "함께 변경이 필요합니다.",
        "해당 계정의 최근 로그인·접속 이력을 점검해 비정상 접근이 있었는지 확인해 주세요.",
        "설정 파일·스크립트에 평문으로 남은 값은 환경변수나 자격증명 저장소로 옮겨 주세요.",
    ),
    "pii": (
        "개인정보가 포함된 파일은 보관 필요성을 먼저 검토하고, 불필요하면 삭제해 주세요.",
        "보관이 필요하면 접근 대상을 업무상 필요한 인원으로 한정해 주세요.",
    ),
    "confidential": (
        "공정·기밀 문서는 사내 문서관리 시스템으로 옮기고 공유 위치에는 사본을 남기지 "
        "말아 주세요.",
        "외부 공유가 필요한 문서라면 별도 승인 절차를 거쳐 주세요.",
    ),
    "internal_system": (
        "내부 시스템 구성 정보가 담긴 파일은 접근 범위를 운영 담당자로 제한해 주세요.",
    ),
}


def sensitive_bucket(category: Any, kind: Any) -> str | None:
    """hit 하나를 메일 분류로 접는다. 모르는 것은 None — 추측해서 겁주지 않는다."""
    cat = str(category or "").strip().lower()
    knd = str(kind or "").strip().lower()
    # 개인키는 secret/credential 어느 쪽에 있든 따로 센다 — 급한 정도가 다르다.
    if "private_key" in knd or "pkcs12" in knd:
        return "private_key"
    if cat in {"credential", "secret"}:
        return "credential"
    if cat == "pii":
        return "pii"
    if cat in _CONFIDENTIAL_CATEGORIES:
        return "confidential"
    if cat == "internal_system":
        return "internal_system"
    return None


def sensitive_counts(hits: Any) -> dict[str, int]:
    """hit 목록 → {분류: 건수}. 원시 hit 은 여기서 끝나고 밖으로 안 나간다."""
    out: dict[str, int] = {}
    for h in hits or []:
        if not isinstance(h, dict):
            continue
        bucket = sensitive_bucket(h.get("category"), h.get("kind"))
        if bucket:
            out[bucket] = out.get(bucket, 0) + 1
    return out


def merge_counts(*counts: dict[str, int] | None) -> dict[str, int]:
    out: dict[str, int] = {}
    for c in counts:
        for k, n in (c or {}).items():
            out[k] = out.get(k, 0) + int(n)
    return out


def _rich(text: str) -> str:
    """`**강조**` 만 허용하는 최소 마크업 — 그 외는 전부 escape."""
    safe = escape(str(text or ""))
    parts = safe.split("**")
    return "".join(p if i % 2 == 0 else f"<strong>{p}</strong>" for i, p in enumerate(parts))


def count_phrase(n: int) -> str:
    """건수 표기 — **"N건" 이 아니라 "N건 이상"** (사용자 결정 2026-09-02).

    우리가 세는 값은 정확한 개수가 아니다:
      · 스캔이 공유 전체를 다 열지 못한다(부분 훑기) → 실제는 더 많을 수 있다.
      · 오탐 판정된 것은 뺐다(`smb_exposure_summary.share_sensitive_counts`).
    그래서 하한으로 말한다. 정확한 수처럼 말하면 담당자가 목록을 요구했을 때
    우리가 그 수를 못 댄다 — 실제로 그렇게 되물음을 받았다(2026-09-01 김명규님).

    ⚠️ 반대 방향도 있다: 판정된 hit 이 전체의 2.5% 뿐이라 미판정분에 오탐이 더 섞여
       있을 수 있다. 그쪽만 보면 "이하" 가 맞다. 두 효과가 반대라 어느 쪽도 정확하지
       않지만, **부족하게 말하는 쪽**이 조치 누락보다 낫다는 판단이다.
    """
    return f"{int(n):,}건 이상"


def summary_html(counts: dict[str, int], *, container_word: str = "공유 폴더") -> str:
    """확인된 민감 항목 — **분류와 건수만.**

    `container_word`: 도메인마다 담는 그릇이 다르다(공유 폴더 / 저장소 / 스페이스 / 웹 서비스).
    빈 dict 면 빈 문자열 — 빈 표를 그리지 않는다("확인했는데 없음" 과 "확인 안 함" 이 섞인다).
    """
    rows = [(label, counts.get(key, 0)) for key, label in SENSITIVE_LABELS if counts.get(key)]
    if not rows:
        return ""
    body = "".join(
        '<tr><td style="border:1px solid #d9e2ec;padding:8px">' + escape(label) + "</td>"
        '<td style="border:1px solid #d9e2ec;padding:8px;text-align:right">'
        f"{escape(count_phrase(n))}</td></tr>"
        for label, n in rows
    )
    return (
        '<div class="section-title"><span>■</span>확인된 민감 항목</div>'
        f"<p>{escape(container_word)} 안에서 아래 유형이 확인되었습니다. "
        "권한 조치와 함께 확인해 주세요.</p>"
        '<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:13px">'
        '<thead><tr>'
        '<th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:left">유형</th>'
        '<th style="border:1px solid #d9e2ec;background:#f1f5f9;padding:8px;text-align:right">건수</th>'
        f"</tr></thead><tbody>{body}</tbody></table>"
        '<div class="note">점검이 공유 폴더 전체를 다 열람하지는 못하므로 '
        "표의 건수는 <b>확인된 최소 수치</b>입니다. "
        "보안상 파일 경로와 값은 메일에 포함하지 않습니다. "
        "상세 목록이 필요하시면 본 메일로 문의해 주세요.</div>"
    )


def actions_html(counts: dict[str, int]) -> str:
    """유형별 추가 조치 — 권한 제한만으로 끝나지 않는 것들."""
    blocks = []
    for key, label in SENSITIVE_LABELS:
        if not counts.get(key):
            continue
        items = "".join(f"<li>{_rich(a)}</li>" for a in SENSITIVE_ACTIONS.get(key, ()))
        if items:
            blocks.append(f"<p><strong>{escape(label)}</strong></p><ul>{items}</ul>")
    if not blocks:
        return ""
    return (
        '<div class="section-title"><span>■</span>유형별 추가 조치</div>'
        "<p>접근 권한 제한과 <strong>별개로</strong> 아래 조치가 필요합니다. "
        "이미 열람된 자격증명은 권한을 닫아도 계속 사용될 수 있습니다.</p>"
        + "".join(blocks)
    )


# ── 재검증 결과 라벨 (4도메인 공용) ────────────────────────────────────────
#
# 재확인 회신에 `now_closed` / `still_open` 같은 **엔진 내부 키가 그대로** 나가고 있었다.
# 행별 `결과` 열은 번역돼 있는데 표 위의 `재검증 상태` 는 원문이라 같은 메일 안에서
# 어긋나기까지 했다. 받는 사람은 사내 담당자다 — 우리 상태 어휘를 알 이유가 없다.
_RECHECK_STATUS_LABELS: dict[str, str] = {
    "now_closed": "조치 확인됨",
    "remediated": "조치 확인됨",
    "still_open": "아직 확인됨",
    "partially_remediated": "일부 조치됨",
    "partially_closed": "일부 조치됨",
    "recheck_requested": "재확인 대기",
    "rechecking": "재확인 중",
    "unknown": "판단 보류",
    "error": "확인 실패",
}


def recheck_status_label(value: object) -> str:
    """엔진 status → 담당자가 읽는 말. 모르는 값은 **그대로 두지 않고** 보류로 접는다 —
    영문 키가 메일에 노출되는 것보다 낫고, 새 어휘가 생기면 테스트가 먼저 깨진다."""
    key = str(value or "").strip().lower()
    return _RECHECK_STATUS_LABELS.get(key, "판단 보류")


#: 크리덴셜 계열이 있을 때 붙이는 **한 줄**. 상세는 `actions_html` 이 말한다.
#: ⚠️ 요지는 하나다 — 권한을 닫아도 **이미 열람된 자격증명은 계속 유효하다.**
_CREDENTIAL_ONE_LINER = (
    "크리덴셜·개인키가 포함된 경우 권한 조치와 별개로 <b>즉시 교체를 권장</b>합니다 — "
    "이미 열람된 값은 권한을 닫아도 계속 사용될 수 있습니다."
)


def exposure_metric_html(item_count: int, counts: dict[str, int] | None = None) -> str:
    """머리 지표의 "노출 항목" 한 칸 — 4도메인 동일 (사용자 지시 2026-08-31).

        노출 항목  6,373건 · 크리덴셜·비밀번호 232건 · 개인정보 15,235건

    ★ 규모가 머리에 없으면 담당자가 급한지 아닌지 판단할 숫자가 없다. 분류별 건수는
      아래 "확인된 민감 항목" 표와 같은 값이지만, 표까지 내려가기 전에 한 줄로 보인다.

    ⚠️ 건수만 낸다. 경로·파일명·값은 싣지 않는다 — 메일은 전달·회신으로 퍼진다.
    """
    counts = counts or {}
    if not item_count and not counts:
        return ""
    parts = [count_phrase(item_count)] if item_count else []
    parts += [f"{label} {count_phrase(counts[key])}"
              for key, label in SENSITIVE_LABELS if counts.get(key)]
    if not parts:
        return ""
    return ('<div class="metric"><small>노출 항목</small>'
            f'<strong>{" · ".join(parts)}</strong></div>')


def credential_notice_html(counts: dict[str, int] | None = None) -> str:
    """크리덴셜·개인키가 있을 때만 나오는 한 줄. 없으면 빈 문자열.

    없는 항목까지 경고하면 담당자가 무엇이 자기 일인지 못 고른다 —
    `SENSITIVE_ACTIONS` 가 "해당 분류가 실제로 있을 때만" 붙이는 것과 같은 규칙이다.
    """
    counts = counts or {}
    if not (counts.get("credential") or counts.get("private_key")):
        return ""
    return f'<div class="note">{_CREDENTIAL_ONE_LINER}</div>'
