"""보고 sync 카운터 — 파이프라인이 이미 세고 있던 것을 화면으로 꺼낸다.

## 왜 필요한가

콘솔이 "열린 github finding 19,808" 과 "이번 주 보고 85" 를 나란히 그리면 담당자는 그 간극의
이유를 알 방법이 없다. 그런데 `sync_report_threads()` 는 **이미 단계별로 세고 있다** —
그 값이 `pipeline_run.detail` 에 남는데 아무도 안 읽었다.

    sync={'seen': 10, 'new': 1, 'skipped_unverified': 9, 'owner_missing_count': 1}
    handled=0 reports=0 sent=0 errors=0

## ⚠️ detail 은 JSON 이 아니다

`str(dict)` 다(작은따옴표). 그래서 `json.loads` 로 못 읽는다. `ast.literal_eval` 로 판다 —
리터럴만 평가하므로 코드 실행 위험이 없다.

## ⚠️⚠️ "마지막 실행" 은 거의 항상 빈 tick 이다

보고 컴포넌트는 30초 주기로 돈다. 실측 2026-08-29:

    github.report      2,739 run 중 보고 생성 103 (3.8%)   마지막 생성 08-27 07:35
    confluence.report  5,321 run 중 보고 생성 616 (11.6%)  마지막 생성 08-29 05:13
    dev_web_report     2,922 run 중 보고 생성 517 (17.7%)  마지막 생성 08-28 03:30

그래서 그냥 `ORDER BY started_at DESC LIMIT 1` 을 쓰면 화면이 **항상 0** 을 그린다 —
숫자가 틀린 게 아니라 **질문이 틀렸다**. 두 시각을 따로 낸다:
  `at`         마지막 확인(빈 tick 포함) — 파이프라인이 살아 있는가
  `lastWorkAt` 마지막으로 **보고를 만든** 실행 — 카운터는 이쪽 것을 싣는다

★ 파싱 실패를 0 으로 내리지 않는다. 0 은 "그 단계에서 아무것도 안 걸렸다" 로 읽히는데
  실제로는 "못 읽었다" 다. `parsed=False` + 값 없음으로 낸다.

## 기밀성

정수 카운터만 투영한다. `detail` 은 free-text 라 저장소명·이유 문자열이 섞일 수 있는데,
**알려진 키의 int 값만** 뽑고 나머지는 버린다 — 마스킹을 고민할 필요 자체를 없앤다.
"""
from __future__ import annotations

import ast
import re
from typing import Any

from ..db import ReadOnlyPool
from ..domains import DOMAIN_TABLES
from ..models import SyncCounters, SyncList, SyncReport

#: 도메인 → pipeline_run.component. 이름 규칙이 도메인마다 다르다(점/언더바가 섞여 있다).
#:
#: 2026-08-29 사용자 결정: **4도메인 모두** 보고 칸을 낸다. 다만 도메인마다 남기는 것이
#: 다르므로 `stage` 로 무엇을 보고 있는지 밝힌다 — 없는 것을 0 으로도, "못 읽음" 으로도
#: 그리지 않는다.
#:
#:   sync         github·confluence — `sync={...}` 단계별 카운터 전부
#:   report_only  dev_web           — 보고 패스는 도는데 sync 단계가 없다.
#:                                    detail 실측: `dev_web_reports=0 sent=0`
#:   absent       smb               — 보고 패스 자체가 없다. finding **제출 시점**에
#:                                    스레드를 만든다(`smb_submit_finding_tool`).
#:
#: ⚠️ 예전 주석이 "없는 도메인을 넣고 '카운터를 못 읽었다' 로 그리면 안 된다" 고 경고했다.
#:    그 경고는 유효하다 — 그래서 넣되 `parsed` 가 아니라 `stage` 로 가른다.
_COMPONENTS: dict[str, str] = {
    "github": "github.report",
    "confluence": "confluence.report",
    "dev_web": "dev_web_report",
}

#: `sync={...}` 를 남기는 도메인. 나머지는 결과 카운터(reports/sent)만 본다.
_SYNC_STAGE_DOMAINS = frozenset({"github", "confluence"})

#: 보고 패스 자체가 없는 도메인 — 행은 내되 단계가 없다고 말한다.
_STAGELESS_DOMAINS: tuple[str, ...] = ("smb",)

#: sync dict 에서 꺼낼 정수 카운터 — snake_case 원본 → camelCase 표면.
#: 여기 없는 키는 버린다(문자열·리스트가 섞여 들어오는 것을 구조적으로 차단).
_COUNTER_MAP: dict[str, str] = {
    "seen": "seen",
    "repos_seen": "reposSeen",
    "new": "created",              # `new` 는 TS 예약어와 헷갈린다 — 표면에서 이름을 바꾼다
    "merged": "merged",
    "recurred": "recurred",
    "dup": "dup",
    "skipped_unverified": "skippedUnverified",
    "skipped_unknown_scope": "skippedUnknownScope",
    "owner_recipient_count": "ownerFound",
    "owner_from_repo_count": "ownerFromRepo",
    "owner_missing_count": "ownerMissing",
}

#: detail 뒤쪽의 `key=int` 결과값.
_OUTCOME_MAP: dict[str, str] = {
    # dev_web 은 도메인 접두를 붙여 남긴다 — 표면 이름은 다른 도메인과 같아야 한다.
    "dev_web_reports": "reports",
    "handled": "handled",
    "reports": "reports",
    "sent": "sent",
    "dry_run": "dryRun",
    "errors": "errors",
}

_SYNC_RE = re.compile(r"sync=(\{.*?\})\s", re.S)
_KV_RE = re.compile(r"\b([a-z_]+)=(\d+)\b")


def _parse_sync(detail: str) -> dict[str, int] | None:
    """`sync={...}` → 정수만 남긴 dict. 못 읽으면 None(0 이 아니다)."""
    m = _SYNC_RE.search(detail or "")
    if not m:
        return None
    try:
        raw = ast.literal_eval(m.group(1))
    except (ValueError, SyntaxError):
        return None
    if not isinstance(raw, dict):
        return None
    return {k: int(v) for k, v in raw.items() if isinstance(v, int) and not isinstance(v, bool)}


def _counters(detail: str) -> tuple[SyncCounters | None, dict[str, int]]:
    parsed = _parse_sync(detail)
    outcome = {
        _OUTCOME_MAP[k]: int(v)
        for k, v in _KV_RE.findall(detail or "")
        if k in _OUTCOME_MAP
    }
    if parsed is None:
        return None, outcome
    return SyncCounters(**{
        surface: parsed[src] for src, surface in _COUNTER_MAP.items() if src in parsed
    }), outcome


def latest_sync(pool: ReadOnlyPool) -> SyncList:
    """도메인별 **가장 최근** 보고 패스의 sync 결과.

    ⚠️ smb·dev_web 은 없다 — 제출 시점에 스레드를 만들고 보고 패스에 sync 호출이 없다.
    빠진 것이 아니라 그 단계가 존재하지 않는다.
    """
    items: list[SyncReport] = []
    for domain, component in _COMPONENTS.items():
        wants_sync = domain in _SYNC_STAGE_DOMAINS
        stage = "sync" if wants_sync else "report_only"
        # 마지막 확인 — 빈 tick 이어도 좋다. "파이프라인이 도는가" 에만 답한다.
        tick = pool.fetch_one(
            "SELECT started_at, status FROM pipeline_run "
            "WHERE component = %s ORDER BY started_at DESC LIMIT 1",
            [component],
        )
        # 마지막으로 **일한** 실행. 카운터는 여기서 싣는다(빈 tick 의 0 을 싣지 않는다).
        # sync 도메인은 `sync=` 도 요구한다 — 없으면 카운터를 못 그린다.
        work_sql = (
            "SELECT started_at, status, detail FROM pipeline_run "
            "WHERE component = %s AND detail ~ %s "
            + ("AND detail LIKE %s " if wants_sync else "")
            + "ORDER BY started_at DESC LIMIT 1"
        )
        work_args: list[str] = [component, "reports=[1-9]"]
        if wants_sync:
            work_args.append("%%sync=%%")
        work = pool.fetch_one(work_sql, work_args)

        if not tick and not work:
            items.append(SyncReport(domain=domain, stage=stage, parsed=False))
            continue
        counters, outcome = _counters(str((work or {}).get("detail") or ""))
        items.append(SyncReport(
            domain=domain,
            stage=stage,
            at=(float(tick["started_at"]) if tick and tick.get("started_at") is not None else None),
            lastWorkAt=(
                float(work["started_at"]) if work and work.get("started_at") is not None else None
            ),
            status=str((tick or {}).get("status") or "") or None,
            # ★ 일한 실행이 아예 없으면 "못 읽음" 이 아니다 — 읽을 것이 없었던 것이다.
            #   그건 lastWorkAt=None 이 말한다. parsed 는 detail 을 못 판 경우만 False 다.
            parsed=(counters is not None) if wants_sync else bool(outcome),
            counters=counters,
            **outcome,
        ))

    # ── 보고 패스가 없는 도메인 — 대신 **티켓이 언제 만들어졌는지**를 낸다 ──────
    # 비워 두면 화면이 "이 도메인은 아무것도 안 한다" 로 읽힌다. 실제로는 제출 시점에
    # 티켓을 만들고 있다(실측 2026-08-29: smb 22건, 마지막 16:33 — 리드가 도는 중).
    for domain in _STAGELESS_DOMAINS:
        table = DOMAIN_TABLES[domain].report_thread_table
        row = pool.fetch_one(
            f"SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM {table}"
        )
        items.append(SyncReport(
            domain=domain,
            stage="absent",
            parsed=False,
            tickets=int(row["n"]) if row and row.get("n") is not None else None,
            lastWorkAt=(
                float(row["last_at"]) if row and row.get("last_at") is not None else None
            ),
        ))

    as_of = pool.fetch_one("SELECT extract(epoch FROM now()) AS now")
    return SyncList(asOf=float(as_of["now"]) if as_of else 0.0, items=items)
