"""리드의 눈 — 타깃별 탐지 결과를 **모양**으로 요약한다 (v3.98).

## 왜 이게 생겼나

Phase 2~4 의 리드는 파일/URL **목록**만 봤다. 그래서 "이름이 위험해 보인다" 수준으로만
지시하고, 검토원이 통째로 다 보고 온 요약을 받아 큐를 닫았다 — 판단할 재료가 없으니
피벗도 없었다(실측: `record_pivot` 8런 0건).

그런데 재료는 DB 에 **이미 있었다**. 2026-08-21 라이브 실측:

    smb_file_hit                          127,843건 / hit 보유 공유 419개
    secret/generic_password_assignment      8,369건
      └ 그중 .NET PublicKeyToken 오탐        4,361건 (52%) — pending 4,253건
        └ 그 4,361건의 masked 값은 사실상 **2종**(mscorlib / Microsoft 강제서명 키)

"같은 값이 4,253번" 은 위임 없이도 오탐임을 말해 준다. 이 모듈은 그 신호를 리드에게
넘기되, 넘어가면 안 되는 것은 넘기지 않는다.

## ★ 경계 규칙 — `masked` 는 값이 아니라 **모양**으로 취급한다

사용자 결정(2026-08-21): hit view 는 **롤업 + masked 값만**. `line_preview`(본문 줄)는
리드에게 가지 않는다. Phase 3 에서 승인된 "주변 맥락 + 부분 마스킹" 은 *검토원이 지목해
준 지점*에 한한 것이고, 여기는 리드가 **스스로** 끌어오는 경로라 성격이 다르다.
본문 한 줄이 필요하면 리드가 좌표를 들고 `ask_inspector` 로 물어본다 — 그게 2단의 요점이다.

그런데 `masked` 필드가 **항상 마스킹된 게 아니다**. 실측:

    smb_file_hit  secret/generic_password_assignment  'b77a********e089'       마스킹됨
    smb_file_hit  pii/email                           'ja***@samsungds.net'    마스킹됨
    smb_file_hit  semiconductor_process/*_keyword     'fdc' / 'fab'            키워드
    smb_file_hit  credential/ntlm_proxy_authorization 'Proxy-Authorization: NTLM
                                                       TlRMTVNTUAAD…'          ⚠️ 값 조각
    finding extra confluence/document_body_keyword    'Ulysses 수율 확보 목표는
                                                       양산 초기 최대…'         ⚠️ 본문 문장

카테고리 화이트리스트로 거르면 새 카테고리·새 소스에서 조용히 샌다. **내용 기반 +
fail-closed** 로 간다 — `value_view()` 참조.

## 마스킹은 여기서 하지 않는다

`LeadTool.execute` 가 반환 전체에 `mask_tool_content` 를 건다. 여기서 또 걸면 진실이
둘이 되고, 이중 마스킹이 좌표를 뭉갠다(Phase 3 에서 데인 것). 이 모듈이 하는 일은
**모양 규칙 + 캡 + 표시 순서** 뿐이다.
"""
from __future__ import annotations

import json
from typing import Any

from _shared.lead_masking import shape_of

# ── 캡 (전부 상수, 도구 입력이 아니라 여기서 강제) ─────────────────────
MAX_ROLLUP_ROWS = 30
MAX_SHAPE_ROWS = 20
MAX_MASKED_CHARS = 64
MAX_REF_CHARS = 200
MAX_FINDINGS_SCANNED = 200      # finding_lifecycle 경로에서 파이썬으로 끌어오는 상한

# 마스킹 표식. 코어/도메인 탐지기가 모두 `*` 런을 쓴다.
_MASK_MARK = "***"

# ── 표시 순서 (게이트 아님 — 아무것도 지우지 않는다) ────────────────────
#
# 순수 count desc 로 정렬하면 email 30,065건이 aws_access_key_id 2건을 덮는다.
# 리드가 봐야 하는 것은 "가장 많은 것" 이 아니라 "가장 위험한 것" 이다.
CATEGORY_PRIORITY: tuple[str, ...] = ("credential", "secret", "pii")
_PRIORITY_FALLBACK = len(CATEGORY_PRIORITY)


def category_rank(category: Any) -> int:
    cat = str(category or "").strip().lower()
    try:
        return CATEGORY_PRIORITY.index(cat)
    except ValueError:
        return _PRIORITY_FALLBACK


def value_view(masked: Any) -> str:
    """`masked` 필드를 리드에게 보일 형태로. **값이 아니라 모양이다.**

    통과 조건 두 개를 **모두** 만족할 때만 원문이 나간다:
      1. 마스킹 표식(`***`)을 포함한다
      2. 공백이 없다 — 즉 단일 토큰이다

    2번이 있어야 `'Proxy-Authorization: NTLM TlRMTVNTUAAD… (…,user=jh***,…)'` 같은
    "일부만 마스킹된 값 조각" 과 `'Ulysses 수율 확보 목표는 양산 초기…'` 같은 본문
    문장이 걸린다. 둘 다 `***` 가 있거나 없거나로는 못 가른다.

    통과 못 하면 값을 **아예 안 보내고** `shape_of()` 로 대체한다. `'fdc'` →
    `<len=3 charset=alpha entropy=1.6>` 가 되는데, 키워드 카테고리는 롤업 카운트가
    정보의 전부라 손실이 없다.
    """
    raw = str(masked if masked is not None else "").strip()
    if not raw:
        return "<empty>"
    if _MASK_MARK in raw and not any(ch.isspace() for ch in raw):
        if len(raw) > MAX_MASKED_CHARS:
            return raw[:MAX_MASKED_CHARS] + "…"
        return raw
    return shape_of(raw)


def _ref_view(ref: Any) -> str:
    raw = str(ref if ref is not None else "")
    return raw[:MAX_REF_CHARS] + ("…" if len(raw) > MAX_REF_CHARS else "")


def _int(v: Any) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _sort_key(row: dict[str, Any]) -> tuple[int, int, str, str]:
    return (category_rank(row.get("category")), -_int(row.get("count")),
            str(row.get("kind") or ""), str(row.get("verdict") or ""))


def shape_rollup(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`{category, kind, verdict, count, files}` 행 정리 — 우선순위 정렬 + 캡."""
    out = [{
        "category": str(r.get("category") or ""),
        "kind": str(r.get("kind") or ""),
        "verdict": str(r.get("verdict") or ""),
        "count": _int(r.get("count")),
        "files": _int(r.get("files")),
    } for r in (rows or [])]
    out.sort(key=_sort_key)
    return out[:MAX_ROLLUP_ROWS]


def shape_values(
    rows: list[dict[str, Any]], *, limit: int = MAX_SHAPE_ROWS,
) -> list[dict[str, Any]]:
    """`masked` 를 낀 행 정리 — 값은 `value_view` 를 통과한 것만 나간다."""
    out: list[dict[str, Any]] = []
    for r in (rows or []):
        item = {
            "category": str(r.get("category") or ""),
            "kind": str(r.get("kind") or ""),
            "verdict": str(r.get("verdict") or ""),
            "value": value_view(r.get("masked")),
            "count": _int(r.get("count")),
            "files": _int(r.get("files")),
        }
        ref = r.get("sample_ref")
        if ref:
            item["sample_ref"] = _ref_view(ref)
        line = r.get("sample_line")
        if line is not None:
            item["sample_line"] = _int(line)
        out.append(item)
    out.sort(key=_sort_key)
    return out[:max(1, min(int(limit), MAX_SHAPE_ROWS))]


def pending_by_category(rollup: list[dict[str, Any]] | None) -> dict[str, int] | None:
    """아직 판정 안 한 hit 을 카테고리별로 — **rollup 에서 파생한다(새 쿼리 0).**

    `share_hit_rollup` 이 `GROUP BY category, kind, agent_verdict` 라 판정 축이 이미
    행마다 들어 있다. 따로 세면 쿼리가 늘고(실측 +45~93%, `smb_file_hit.category`
    인덱스가 없다) 값이 갈릴 수 있다.

    ⚠️ **raw hit 이 없는 도메인은 `None`** 이다. 0 이 아니다.
       smb 만 finding 이전 raw hit 을 갖는다. 나머지 셋은 `finding_lifecycle` 기반이라
       verdict 자리에 finding.status 가 들어간다 — 거기서 0을 내보내면 리드가
       "판정 끝났다" 로 읽는다. 그 실패 모드는 이 파일이 이미 경고하고 있다.
    """
    if rollup is None:
        return None
    out: dict[str, int] = {}
    for row in rollup:
        if str((row or {}).get("verdict") or "") != "pending":
            continue
        cat = str((row or {}).get("category") or "?")
        out[cat] = out.get(cat, 0) + _int((row or {}).get("count"))
    return out


def build_hit_summary(
    *, domain: str, target_id: int, source: str, total: int,
    rollup: list[dict[str, Any]] | None = None,
    shapes: list[dict[str, Any]] | None = None,
    note: str = "",
    limit: int = MAX_SHAPE_ROWS,
) -> dict[str, Any]:
    """리드가 받는 봉투. **닫힌 필드 집합** — 여기 없는 것은 리드에게 가지 않는다.

    `limit` 은 도구 입력이지만 상한은 여기가 정한다(`MAX_SHAPE_ROWS`) — 입력이
    캡을 넘길 수 없다.
    """
    roll_in = list(rollup or [])
    shape_in = list(shapes or [])
    roll = shape_rollup(roll_in)
    vals = shape_values(shape_in, limit=limit)
    out: dict[str, Any] = {
        "domain": domain,
        "target_id": int(target_id),
        "source": source,
        "total": _int(total),
        "rollup": roll,
        "shapes": vals,
    }
    # ★ 판정 대기 — 리드가 "이 공유 닫아도 되나" 를 정할 때 쓰는 유일한 숫자다.
    #   이게 없어서 리드가 secret 241건이 미판정인 공유를 닫았다(실측 2026-08-29).
    #   ⚠️ `rollup` 이 None(=raw hit 축이 없는 도메인)이면 키 자체를 안 넣는다 — 0 금지.
    pending = pending_by_category(rollup)
    if pending:
        out["pending_verdict"] = pending
    if len(roll_in) > len(roll):
        out["rollup_truncated"] = len(roll_in) - len(roll)
    if len(shape_in) > len(vals):
        out["shapes_truncated"] = len(shape_in) - len(vals)
    if note:
        out["note"] = note
    return out


# ── finding_lifecycle 경로 (smb 외 3도메인 공용) ──────────────────────
#
# pre-finding hit 을 영속하는 것은 smb 뿐이다. github/dev_web/confluence 는
# `finding_lifecycle.extra_json.hits[]` 가 유일한 소스다 — 모양은 4도메인 동일하다
# (`{category, kind, masked, line_no|location, ...}`). 세 도메인이 같은 집계를
# 쓰도록 여기 둔다(원칙 ②: 도메인 구현방법 동일).

_LOCATION_KEYS = ("location", "path", "url")


def _hit_ref(hit: dict[str, Any], fallback: str) -> str:
    for k in _LOCATION_KEYS:
        v = hit.get(k)
        if v:
            return str(v)
    return fallback


def aggregate_finding_hits(
    findings: list[dict[str, Any]], *,
    category: str | None = None, kind: str | None = None,
    verdict: str | None = None,
) -> tuple[int, list[dict[str, Any]], list[dict[str, Any]]]:
    """finding 목록 → `(total, rollup_rows, shape_rows)`.

    per-hit verdict 이 없으므로 finding 의 `status`(open/closed/…)를 verdict 자리에
    쓴다. 없는 것을 있는 척하지 않는다 — 리드가 읽을 때 "이건 finding 상태" 로 읽힌다.
    """
    roll: dict[tuple[str, str, str], dict[str, Any]] = {}
    shapes: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    total = 0
    for f in (findings or [])[:MAX_FINDINGS_SCANNED]:
        extra = f.get("extra") if isinstance(f.get("extra"), dict) else None
        if extra is None:
            raw = f.get("extra_json")
            try:
                extra = json.loads(raw) if isinstance(raw, str) else (raw or {})
            except ValueError:
                extra = {}
        hits = extra.get("hits") if isinstance(extra, dict) else None
        asset = str(f.get("asset") or "")
        status = str(f.get("status") or "")
        for h in (hits or []):
            if not isinstance(h, dict):
                continue
            cat = str(h.get("category") or "")
            knd = str(h.get("kind") or "")
            if category and cat != category:
                continue
            if kind and knd != kind:
                continue
            if verdict and status != verdict:
                continue
            total += 1
            rk = (cat, knd, status)
            rrow = roll.setdefault(
                rk, {"category": cat, "kind": knd, "verdict": status,
                     "count": 0, "_assets": set()})
            rrow["count"] += 1
            rrow["_assets"].add(asset)

            masked = str(h.get("masked") or "")
            sk = (cat, knd, status, masked)
            srow = shapes.setdefault(
                sk, {"category": cat, "kind": knd, "verdict": status,
                     "masked": masked, "count": 0, "_assets": set(),
                     "sample_ref": _hit_ref(h, asset),
                     "sample_line": h.get("line_no")})
            srow["count"] += 1
            srow["_assets"].add(asset)

    roll_rows = []
    for r in roll.values():
        r["files"] = len(r.pop("_assets"))
        roll_rows.append(r)
    shape_rows = []
    for s in shapes.values():
        s["files"] = len(s.pop("_assets"))
        shape_rows.append(s)
    return total, roll_rows, shape_rows


def finding_hit_summary(
    *, task_type: str, asset_like: str,
    category: str | None = None, kind: str | None = None,
    verdict: str | None = None, note: str = "",
) -> dict[str, Any]:
    """`finding_lifecycle` 기반 hit 요약 — github/dev_web/confluence 공용.

    세 도메인이 각자 집계를 쓰면 그만큼 갈린다(원칙 ②). 조회는 lazy import 로
    미뤄 이 모듈의 순수함수 부분이 DB 없이도 테스트되게 둔다.

    ★ `source` 를 `finding_lifecycle` 로 정직하게 적는다. 이건 스캐너의 raw hit 이
    아니라 **이미 finding 이 된 것**이다 — 리드가 "스캔했는데 깨끗하다" 로 읽으면 안 된다.
    """
    from service import state_domain as state

    rows = state.findings_for_asset(
        task_type, asset_like=asset_like, limit=MAX_FINDINGS_SCANNED)
    total, roll, shapes = aggregate_finding_hits(
        rows, category=category, kind=kind, verdict=verdict)
    msg = note or (
        "이 도메인은 finding 이전 raw hit 을 영속하지 않는다 — 여기 보이는 것은 "
        "**이미 finding 이 된 것**뿐이다. 0건이 '깨끗함' 을 뜻하지 않는다."
    )
    if rows and not total:
        msg += f" (이 타깃 관련 finding {len(rows)}건은 있으나 hit 상세가 비었다)"
    return {"source": "finding_lifecycle", "total": total,
            "rollup": roll, "shapes": shapes, "note": msg}
