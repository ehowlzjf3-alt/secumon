"""대상(src) 축 — 티켓 목록의 원천.

【왜 src 인가】 finding 은 파일/URL 하나하나지만, 사람이 조치하는 단위는 그것이 **속한 곳**이다.
게다가 도메인 밀도가 1,980:1(github 19,808 : confluence 10)이라 finding 건수로 4열을 만들면
한 칸만 보인다. src 로 세면 640/230/91/9 라 네 도메인이 다 보인다(2026-08-23 실측).

【집계는 서버에서】 web 이 `/gw/findings?limit=500` 을 받아 클라이언트에서 세던 것을 여기로 옮긴다 —
github 19,808 건을 500 건으로 자른 뒤 세면 **조용히 틀린 숫자**가 나온다.

【마스킹 경계】 ⚠️ redact() 를 걸고 나서 GROUP BY 하면 안 된다. redact 는 16자+ hex·20~39자 토큰·
이메일 local-part 를 봉인하므로, 서로 다른 두 대상이 같은 «마스킹» 라벨로 **충돌**할 수 있다.
그래서 **SQL 은 원문으로 group by/count 하고, Python 에서 라벨만 redact** 한다. 충돌한 라벨은
병합하지 않고 srcKey 접두를 붙여 구분한다(원문은 끝까지 응답에 넣지 않는다).
"""
from __future__ import annotations

import hashlib

from ..db import ReadOnlyPool
from ..domains import (
    DOMAIN_TABLES,
    SRC_KIND,
    all_domain_task_types,
    domain_case_sql,
    report_union_sql,
    src_case_sql,
    delivery_evidence,
)
from ..masking import redact
from .. import taxonomy
from ..models import Assignee, SourceItem, SourceList
from . import finding_repo

# 열린 것으로 보는 finding status(엔진 어휘). finding_repo 와 같은 정의를 쓴다.
_OPEN_STATUSES = finding_repo._OPEN_STATUSES

# srcKey — 원문을 되묻기 키로 쓰지 않기 위한 불투명 토큰. SQL/Python 양쪽에서 같은 값이 나와야
# `/gw/findings?srcKey=` 필터가 성립하므로, 두 구현을 나란히 두고 테스트로 묶는다.
_SRC_KEY_LEN = 16


def src_key(domain: str, raw_src: str | None) -> str:
    payload = f"{domain}|{raw_src or ''}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:_SRC_KEY_LEN]


def src_key_sql(domain_expr: str, src_expr: str) -> str:
    """src_key() 의 SQL 판. 반드시 같은 값이 나와야 한다(test_sources 가 대조한다)."""
    return (
        f"left(encode(sha256(convert_to({domain_expr} || '|' || COALESCE({src_expr}, ''), 'UTF8')), "
        f"'hex'), {_SRC_KEY_LEN})"
    )


# ── asset_owner 가용성 프로브 ────────────────────────────────────────────────
# sql/004 를 아직 안 돌렸으면 이 테이블은 못 읽는다. 그때 예외를 삼키면 화면이 "담당자 없음" 으로
# 보이는데 그건 거짓말이다(데이터는 100% 매칭된다). 한 번만 확인하고 결과를 응답에 실어 보낸다.
_asset_owner_ok: bool | None = None


def _asset_owner_readable(pool: ReadOnlyPool) -> bool:
    global _asset_owner_ok
    if _asset_owner_ok is None:
        try:
            pool.fetch_one("SELECT 1 AS ok FROM asset_owner LIMIT 1")
            _asset_owner_ok = True
        except Exception:  # noqa: BLE001 — 권한/부재 어느 쪽이든 "못 읽음" 하나로 취급
            _asset_owner_ok = False
    return _asset_owner_ok


def reset_owner_probe() -> None:
    """테스트/재기동용 — 프로브 캐시 초기화."""
    global _asset_owner_ok
    _asset_owner_ok = None


def _named(row: dict, assignee: Assignee) -> Assignee:
    """CTE 가 조인해 온 임직원 대장 값으로 이름·부서·직급을 채운다(이미 있으면 안 덮는다).

    행 단위로 되묻지 않는다 — 목록에서 행마다 조회하면 페이지당 수십 왕복이라 pool_max=4 를 굶긴다.
    """
    return assignee.model_copy(update={
        "name": assignee.name or finding_repo._owner_line(row.get("emp_name"), 80),
        "dept": assignee.dept or finding_repo._owner_line(row.get("emp_dept"), 120),
        "title": assignee.title or finding_repo._owner_line(row.get("emp_title"), 60),
    })


def _assignee(domain: str, row: dict, owner_readable: bool) -> Assignee | None:
    """도메인별 담당자 해석. resolve_owner() 와 같은 규칙이되 **행 단위 재조회 없이** 조인 결과로.

    (목록에서 행마다 resolve_owner 를 부르면 페이지당 수십 왕복이 된다 — pool_max=4 를 굶긴다.)
    """
    if domain == "smb":
        if not owner_readable:
            return Assignee(status="lookup_denied", sourceLabel=finding_repo._OWNER_SOURCE_LABELS["smb"])
        email = finding_repo._owner_email(row.get("owner_email"))
        if finding_repo._is_dssoc_email(email):  # dssoc 는 발송대상이지 담당자가 아니다
            email = None
        name = finding_repo._owner_line(row.get("owner_name"), 80)
        dept = finding_repo._owner_line(row.get("owner_dept"), 120)
        status = "resolved" if (email or name) else "unresolved"
        return _named(row, Assignee(
            status=status, name=name, dept=dept, email=email,
            sourceLabel=finding_repo._OWNER_SOURCE_LABELS["smb"],
        ))
    if domain in ("github", "confluence"):
        # 저장소 담당자 우선 — 커밋 작성자는 파일 검색 finding 엔 없고(대다수),
        # 있어도 "그 줄을 쓴 사람" 이지 저장소를 책임지는 사람이 아니다.
        repo_knox = str(row.get("repo_knox_id") or "").strip().lower()
        src = str(row.get("repo_owner_source") or "")
        if repo_knox:
            email = finding_repo._owner_email(f"{repo_knox}@samsung.com")
            if email:
                return _named(row, Assignee(
                    status="resolved", email=email,
                    sourceLabel=finding_repo._OWNER_SOURCE_LABELS.get(
                        src, finding_repo._OWNER_SOURCE_LABELS[domain]),
                    confirmed=src not in finding_repo._UNCONFIRMED_SOURCES,
                ))
        # ★ owner_recipient 는 **한 명이 아닐 수 있다** — 스레드가 여러 finding 을 모으면
        #   담당자가 합집합(", " 결합)으로 쌓인다. 단건 검증기에 그대로 넣으면 통째로
        #   거부돼 "담당자 없음" 이 된다(실측 2026-08-28: confluence 12개 중 5개가 이것).
        #   Assignee 모델에 `ambiguous` 가 이미 있다 — 설계는 이 경우를 예상했다.
        emails = [
            e for e in finding_repo._owner_emails(row.get("owner_recipient"))
            if not finding_repo._is_dssoc_email(e)   # dssoc 는 발송대상이지 담당자가 아니다
        ]
        if not emails:
            return Assignee(status="unresolved", sourceLabel=finding_repo._OWNER_SOURCE_LABELS[domain])
        return _named(row, Assignee(
            status="resolved", email=emails[0], ambiguous=len(emails) > 1,
            sourceLabel=finding_repo._OWNER_SOURCE_LABELS[domain],
        ))
    if domain == "dev_web":
        # 담당자 개념 자체가 없다 — DevWebReportDeliverTool 이 수신자를 DSSOC 로 덮어쓴다.
        return Assignee(status="dssoc_only")
    return None


def _delivery_target(recipient: object, owner_recipient: object) -> str | None:
    """workspace_repo._delivery_target 과 같은 규칙 — raw 수신자는 끝까지 응답에 넣지 않는다."""
    from .workspace_repo import _delivery_target as _dt  # 순환 import 회피(런타임 지연)

    return _dt(recipient, owner_recipient if isinstance(owner_recipient, str) else None)


_dir_ok: bool | None = None


def _directory_readable(pool: ReadOnlyPool) -> bool:
    """employee_directory + github_repo_owner 조인 가능 여부(sql/005).

    ⚠️ 둘을 한 프로브로 묶는다 — 목록 CTE 가 둘을 같이 조인하므로 하나만 없어도 쿼리가 깨진다.
    없으면 조인을 통째로 빼고 예전대로(메일만) 나간다. 조용히 빈 이름이 되지 않도록
    응답의 `ownerLookup` 과 별개로 여기서 결정한다.
    """
    global _dir_ok
    if _dir_ok is None:
        try:
            pool.fetch_one("SELECT 1 AS ok FROM employee_directory LIMIT 1")
            pool.fetch_one("SELECT 1 AS ok FROM github_repo_owner LIMIT 1")
            _dir_ok = True
        except Exception:  # noqa: BLE001 — 42501(미부여)·42P01(미생성)
            _dir_ok = False
    return _dir_ok


def reset_directory_probe() -> None:
    """테스트/재기동용."""
    global _dir_ok
    _dir_ok = None


#: 검색어 상한. 길이 제한이 없으면 정규식·LIKE 비용이 무한정 커진다.
_Q_MAX = 120


def _base_cte(owner_join: bool, dir_join: bool = False) -> str:
    """대상 집계 CTE. 도메인/파싱/스레드 결합 규칙은 전부 domains.py SSOT 에서 온다."""
    dom = domain_case_sql()
    src = src_case_sql()
    key = src_key_sql("b.domain", "b.src")
    owner_select = (
        "ao.user_name AS owner_name, ao.user_dept AS owner_dept, ao.email AS owner_email"
        if owner_join
        else "NULL::text AS owner_name, NULL::text AS owner_dept, NULL::text AS owner_email"
    )
    owner_clause = (
        "LEFT JOIN asset_owner ao ON a.domain = 'smb' AND ao.ip = a.src" if owner_join else ""
    )
    # 저장소 담당자 + 임직원 대장. knox_id 는 사내 메일 local part 다 — 저장소 담당자가 있으면
    # 그것이, 없으면 스레드의 owner_recipient(커밋 작성자)가 대장 키가 된다.
    dir_select = (
        "gro.knox_id AS repo_knox_id, gro.source AS repo_owner_source, "
        "ed.full_name AS emp_name, ed.department AS emp_dept, ed.title AS emp_title"
        if dir_join
        else "NULL::text AS repo_knox_id, NULL::text AS repo_owner_source, "
             "NULL::text AS emp_name, NULL::text AS emp_dept, NULL::text AS emp_title"
    )
    dir_clause = (
        "LEFT JOIN github_repo_owner gro ON a.domain = 'github' AND gro.repo = a.src\n"
        "  LEFT JOIN employee_directory ed ON ed.knox_id = COALESCE("
        "gro.knox_id, lower(split_part(t.owner_recipient, '@', 1)))"
        if dir_join
        else ""
    )
    return f"""
WITH b AS (
  SELECT {dom} AS domain, {src} AS src, severity, status, first_seen, last_seen, extra_json
  FROM finding_lifecycle
  WHERE task_type IN ({", ".join(["%s"] * len(all_domain_task_types()))})
),
-- 대상별 **발견사항 분류**. 티켓 목록에 별도 필드로 낸다(2026-08-29 사용자 요청).
-- `extra_json.hits[].category` ∪ `hit_categories` — finding 상세·개요와 같은 출처다.
-- ⚠️ b 를 LATERAL 로 펼치면 행이 분류 수만큼 불어나 COUNT(*)=findings 가 부풀어 오른다.
--    그래서 **따로 세고 나중에 조인**한다.
-- ⚠️ `IS JSON` 은 컬럼 전체를 파싱하므로 빈도 큰 축부터 걸러낸다(개요 쪽 선례).
cat AS MATERIALIZED (
  SELECT b.domain, b.src, x.k AS cat, COUNT(*) AS n
  FROM b, LATERAL (
    SELECT jsonb_array_elements_text(
      COALESCE(jsonb_path_query_array(b.extra_json::jsonb, '$.hits[*].category'), '[]'::jsonb)
      || COALESCE((b.extra_json::jsonb) -> 'hit_categories', '[]'::jsonb)) AS k
  ) x
  WHERE b.domain IS NOT NULL AND b.extra_json IS JSON
  GROUP BY b.domain, b.src, x.k
),
cats AS (
  SELECT domain, src, array_agg(cat ORDER BY n DESC, cat) AS cats
  FROM cat GROUP BY domain, src
),
a AS (
  SELECT b.domain, b.src, {key} AS src_key,
         COUNT(*) AS findings,
         COUNT(*) FILTER (WHERE b.status IN ({", ".join(["%s"] * len(_OPEN_STATUSES))})) AS open_findings,
         COUNT(*) FILTER (WHERE lower(b.severity) = 'critical') AS critical,
         COUNT(*) FILTER (WHERE lower(b.severity) = 'high') AS high,
         MIN(b.first_seen) AS first_seen,
         MAX(b.last_seen) AS last_seen,
         -- src 가 NULL 인 그룹(파싱 실패=미상)도 있으므로 `IS NOT DISTINCT FROM` 이어야
         -- 조인이 성립한다. `=` 로 쓰면 그 그룹만 조용히 분류를 잃는다.
         (SELECT c.cats FROM cats c
           WHERE c.domain = b.domain AND c.src IS NOT DISTINCT FROM b.src) AS cats
  FROM b WHERE b.domain IS NOT NULL
  GROUP BY b.domain, b.src
),
th AS ({report_union_sql()}),
t AS (
  SELECT th.domain, th.src,
         COUNT(*) AS threads,
         MAX(th.updated_at) AS last_activity_at,
         MAX(th.notified_at) AS notified_at,
         MIN(th.first_reported_at) AS first_reported_at,
         MAX(th.attempt_count) AS attempt_count,
         -- 발송 대기 = 본문까지 만들었고 게이트가 발송만 잡고 있는 자리.
         -- ★ 운영자가 실제로 클릭하는 칸이다(여기서 수동 발송한다). 칩이 없으면
         --    26건 중에서 눈으로 찾아야 한다(2026-09-01 사용자 요청).
         COUNT(*) FILTER (WHERE th.status = 'report_ready') AS ready_n,
         COUNT(*) FILTER (WHERE th.status IN ('awaiting_reply', 'awaiting_owner')) AS awaiting_n,
         COUNT(*) FILTER (WHERE th.status IN
            ('reply_received', 're_requested', 'recheck_requested', 'rechecking')) AS replied_n,
         COUNT(*) FILTER (WHERE th.status IN
            ('remediated', 'escalated', 'closed', 'exception_review', 'resolved')) AS closed_n,
         (array_agg(th.status ORDER BY th.updated_at DESC NULLS LAST))[1] AS thread_status,
         -- 가장 최근 스레드의 id. 티켓 상세가 `/gw/reports/{key}/{id}/body` 로 본문을
         -- 되묻는 유일한 키다. ⚠️ 한 대상에 스레드가 여럿이라(smb 230호스트/509스레드)
         --    "그 티켓의 본문" 이 아니라 **가장 최근 것**이다 — 화면이 그렇게 말해야 한다.
         (array_agg(th.thread_id ORDER BY th.updated_at DESC NULLS LAST))[1] AS thread_id,
         (array_agg(th.ticket_no ORDER BY th.updated_at DESC NULLS LAST))[1] AS ticket_no,
         -- 티켓 번호 검색용 — 이 대상이 가진 **전체** 번호. 위 `ticket_no` 는 최신
         -- 하나라 그걸로 찾으면 지난 주차 번호가 안 잡힌다(한 대상에 스레드가 여럿).
         array_agg(th.ticket_no) FILTER (WHERE th.ticket_no IS NOT NULL) AS ticket_nos,
         (array_agg(th.recipient ORDER BY th.updated_at DESC NULLS LAST))[1] AS recipient,
         (array_agg(th.owner_recipient ORDER BY th.updated_at DESC NULLS LAST)
            FILTER (WHERE th.owner_recipient IS NOT NULL))[1] AS owner_recipient
  FROM th WHERE th.src IS NOT NULL AND th.src <> '' GROUP BY th.domain, th.src
),
j AS (
  SELECT a.*, t.threads, t.thread_status, t.thread_id, t.ticket_no, t.ticket_nos,
         t.notified_at, t.last_activity_at,
         t.ready_n, t.awaiting_n, t.replied_n, t.closed_n,
         t.first_reported_at, t.attempt_count, t.recipient, t.owner_recipient,
         {owner_select},
         {dir_select}
  FROM a
  LEFT JOIN t ON t.domain = a.domain AND t.src = a.src
  {owner_clause}
  {dir_clause}
)
"""


# 통보 상태 필터 — 어휘는 domains.REPORT_THREAD_TERMINAL/VERIFY_STAGE_STATUS 와 나란히 둔다.
# ⚠️ **가장 최근 스레드의 status 가 아니라 "그 상태인 스레드가 하나라도 있는가"** 로 거른다.
#    한 대상에 스레드가 여러 개다(smb 는 230 호스트에 509 스레드 — 주차마다 새로 열린다).
#    최신 하나만 보면 답장을 기다리는 대상이 더 새 스레드에 가려 목록에서 사라진다.
_THREAD_STATE_SQL = {
    "none": "j.threads IS NULL OR j.threads = 0",
    "reported": "j.threads > 0",
    "ready": "COALESCE(j.ready_n, 0) > 0",
    "awaiting": "COALESCE(j.awaiting_n, 0) > 0",
    "replied": "COALESCE(j.replied_n, 0) > 0",
    "closed": "COALESCE(j.closed_n, 0) > 0",
}

#: 추가 필터. 실측 분포(985 대상, 표본 500)로 **갈리는 것만** 넣었다 —
#:   critical>0 5% · 담당자 없음 24% · high>0 77%(무의미) · notifiedAt 0%(신호 없음).
#: ⚠️ 77%/0% 짜리를 칩으로 만들면 화면만 복잡해지고 아무것도 안 좁혀진다.
_SEVERITY_SQL = {
    # "심각 있음" 이지 "심각만" 이 아니다 — 대상 하나에 여러 심각도가 섞인다.
    "critical": "COALESCE(j.critical, 0) > 0",
    "high": "COALESCE(j.critical, 0) > 0 OR COALESCE(j.high, 0) > 0",
}

#: 담당자 해석 결과. ★ "없음" 은 **보낼 곳을 모른다**는 뜻이라 조치가 멈추는 자리다.
#: 담당자 컬럼은 두 갈래로 온다(smb=asset_owner · github=repo/커밋 + 임직원 대장) —
#: 한쪽만 보면 그 도메인이 통째로 "담당자 없음" 이 된다.
_ASSIGNEE_SQL = {
    "none": (
        "COALESCE(NULLIF(TRIM(j.owner_name), ''), NULLIF(TRIM(j.owner_email), ''), "
        "NULLIF(TRIM(j.emp_name), ''), NULLIF(TRIM(j.owner_recipient), '')) IS NULL"
    ),
    "resolved": (
        "COALESCE(NULLIF(TRIM(j.owner_name), ''), NULLIF(TRIM(j.owner_email), ''), "
        "NULLIF(TRIM(j.emp_name), ''), NULLIF(TRIM(j.owner_recipient), '')) IS NOT NULL"
    ),
}

_ORDERS = {
    # 2026-08-29: 목록 기본 정렬. "최근 관측"(last_seen)은 뒤 run 이 같은 것을 다시 보기만
    # 해도 올라와서 순서가 흔들린다 — **처음 발견된 때**가 티켓의 나이다.
    "firstSeen": "j.first_seen DESC NULLS LAST, j.findings DESC, j.domain ASC",
    "findings": "j.findings DESC, j.domain ASC, j.src ASC NULLS LAST",
    "critical": "j.critical DESC, j.high DESC, j.findings DESC, j.domain ASC",
    "lastSeen": "j.last_seen DESC NULLS LAST, j.findings DESC",
    "stale": "j.first_reported_at ASC NULLS LAST, j.findings DESC",
}


def list_sources(
    pool: ReadOnlyPool,
    *,
    domain: str | None = None,
    thread_state: str | None = None,
    src_key: str | None = None,
    q: str | None = None,
    category: str | None = None,
    severity: str | None = None,
    assignee: str | None = None,
    order: str = "findings",
    limit: int = 50,
    offset: int = 0,
) -> SourceList:
    """대상 목록(서버 group-by). total 은 필터 적용 후 전체 개수 — 목록을 세지 않는다."""
    owner_readable = _asset_owner_readable(pool)
    tts = all_domain_task_types()
    base_params: list[object] = [*tts, *_OPEN_STATUSES]

    where: list[str] = []
    params: list[object] = []
    if domain:
        where.append("j.domain = %s")
        params.append(domain)
    if thread_state:
        clause = _THREAD_STATE_SQL.get(thread_state)
        if clause is None:
            raise ValueError(f"unknown thread_state: {thread_state}")
        where.append(f"({clause})")
    if category:
        # canon 키 → DB 원시 값들(credential ↔ secret 병합). 미지 키는 조용히 무시하지
        # 않고 거부한다 — "필터가 걸린 줄 아는" 화면이 제일 나쁘다.
        canon = taxonomy.canon_param(category)
        if canon is None:
            raise ValueError(f"unknown category: {category}")
        # `cats` 는 대상별 **원시** 분류 배열이다. 겹치면 통과(대상 하나가 여러 분류에 걸린다).
        # ⚠️ cats 가 NULL 인 대상(분류 근거 없음)은 `&&` 가 NULL 이라 자동 제외된다 — 맞는 동작.
        where.append("j.cats && %s::text[]")
        params.append(taxonomy.expand_db_values(canon))
    if severity:
        clause = _SEVERITY_SQL.get(severity)
        if clause is None:
            # 모르는 값을 조용히 무시하면 "필터가 걸린 줄 아는" 화면이 된다 — 거부한다.
            raise ValueError(f"unknown severity: {severity}")
        where.append(f"({clause})")
    if assignee:
        clause = _ASSIGNEE_SQL.get(assignee)
        if clause is None:
            raise ValueError(f"unknown assignee: {assignee}")
        where.append(f"({clause})")
    if src_key:
        # 티켓 상세 딥링크 — 새로고침해도 그 한 건을 다시 찾을 수 있어야 한다.
        where.append("j.src_key = %s")
        params.append(src_key)
    if q:
        # 대상 찾기(부분 일치, 대소문자 무시).
        #
        # ★ **원문(j.src)으로 찾는다.** 응답의 `src` 는 마스킹 라벨이라 그걸로는 못 찾고,
        #   `srcKey` 는 불투명 해시라 타이핑할 수 없다. 페이지네이션은 "목록을 훑는" 문제고
        #   검색은 "아는 것을 확인하는" 문제라 서로 대체가 안 된다 — 담당자가 "우리 서버
        #   어떻게 됐냐" 고 물으면 호스트로 찾아야 한다.
        #
        # ⚠️ LIKE 메타문자는 반드시 이스케이프한다. `_` 하나만 넣어도 전건이 매칭돼
        #   "필터가 걸린 줄 아는 빈 필터" 가 된다(가장 나쁜 실패 모양이다).
        needle = str(q).strip()[:_Q_MAX]
        if needle:
            escaped = needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            # ★ 티켓 번호로도 찾는다. 2026-08-31 부터 메일 제목에 `[티켓 SMB00024]` 가
            #   나가므로, 담당자가 그 번호로 문의하면 운영자가 그대로 붙여넣어 찾아야 한다.
            #   ⚠️ `j.thread_id`(최신 하나)가 아니라 `j.thread_ids`(전체)로 찾는다 —
            #      한 대상에 스레드가 여럿이라 지난 주차 번호가 새어 나간다.
            # ★ 접두 지도를 **갖지 않는다.** 저장된 번호와 그대로 대조한다 —
            #   생산자는 스킬 하나뿐이고 여기는 소비자다. 운영자가 메일에서 통째로
            #   복사해 붙일 수 있게 대괄호·"티켓" 접두·대소문자만 벗긴다.
            probe = needle.strip().strip("[]").replace("티켓", "").strip().upper()
            where.append(
                "(j.src ILIKE %s ESCAPE '\\' OR %s = ANY(j.ticket_nos))"
            )
            params.extend([f"%{escaped}%", probe])
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""

    cte = _base_cte(owner_readable, _directory_readable(pool))
    total_row = pool.fetch_one(
        f"{cte} SELECT COUNT(*) AS n FROM j{where_sql}", [*base_params, *params]
    )
    total = int(total_row["n"]) if total_row else 0

    order_sql = _ORDERS.get(order) or _ORDERS["findings"]
    rows = pool.fetch_all(
        f"{cte} SELECT * FROM j{where_sql} ORDER BY {order_sql} LIMIT %s OFFSET %s",
        [*base_params, *params, limit, offset],
    )

    as_of_row = pool.fetch_one("SELECT extract(epoch FROM now()) AS now")
    as_of = float(as_of_row["now"]) if as_of_row and as_of_row.get("now") is not None else None

    items = [_to_item(r, owner_readable) for r in rows]
    _disambiguate(items)
    return SourceList(
        total=total, items=items,
        ownerLookup="ok" if owner_readable else "denied", asOf=as_of,
    )


# 마스킹된 라벨에 붙이는 구분 접미 길이. 4 는 같은 페이지 안에서도 겹칠 수 있어(실측: dev_web 에
# `«마스킹».cdep.samsungds.net` 하나로 35개가 접힌다) 6 으로 둔다. 겹치면 _disambiguate 가 늘린다.
_SUFFIX = 6


def _categories(raw: object) -> dict[str, object]:
    """DB array_agg → {category, categories}. 미지/빈 값은 대표=None(미분류)."""
    keys = [str(k) for k in raw] if isinstance(raw, (list, tuple)) else []
    rep, all_cats = taxonomy.classify(keys)
    return {"category": rep, "categories": all_cats}


def _to_item(r: dict, owner_readable: bool) -> SourceItem:
    domain = str(r["domain"])
    raw_src = r.get("src")
    key = str(r["src_key"])
    label = redact(raw_src) if raw_src is not None else None
    # ★ 마스킹이 라벨을 바꿨으면 **항상** 구분 접미를 붙인다 — 충돌이 났을 때만 붙이면
    #   그 판정이 "지금 이 페이지에 같이 실렸는가" 에 좌우된다. 실측에서 정확히 그 구멍이 났다:
    #   35개가 같은 라벨로 접히는데 페이지가 갈리면 한쪽엔 접미가 안 붙어 구분 불가였다.
    #   원문이 그대로 살아남은 라벨(IP·평범한 repo 경로)은 건드리지 않는다.
    if label is not None and raw_src is not None and label != str(raw_src):
        label = f"{label} ·{key[:_SUFFIX]}"
    threads = int(r["threads"]) if r.get("threads") is not None else 0
    return SourceItem(
        domain=domain,
        srcKind=SRC_KIND.get(domain, "src"),
        src=label,
        srcKey=key,
        findings=int(r["findings"]),
        openFindings=int(r["open_findings"]),
        critical=int(r["critical"]),
        high=int(r["high"]),
        # 분류는 finding 상세·개요와 **같은 함수**를 통과시킨다(secret→credential 병합,
        # 우선순위 정렬). 화면마다 다른 어휘가 나오면 그때부터 두 벌이 된다.
        **_categories(r.get("cats")),
        firstSeen=_f(r.get("first_seen")),
        lastSeen=_f(r.get("last_seen")),
        threads=threads,
        threadStatus=(str(r["thread_status"]) if r.get("thread_status") else None),
        threadId=(int(r["thread_id"]) if r.get("thread_id") is not None else None),
        ticketNo=(str(r["ticket_no"]) if r.get("ticket_no") else None),
        notifiedAt=_f(r.get("notified_at")),
        # 근거를 값으로 — notifiedAt=null 이 "안 나갔다" 인지 "알 수 없다" 인지 가른다.
        deliveryEvidence=delivery_evidence(domain),
        lastActivityAt=_f(r.get("last_activity_at")),
        firstReportedAt=_f(r.get("first_reported_at")),
        attemptCount=(int(r["attempt_count"]) if r.get("attempt_count") is not None else None),
        deliveryTarget=_delivery_target(r.get("recipient"), r.get("owner_recipient")),
        assignee=_assignee(domain, r, owner_readable),
    )


def _f(v: object) -> float | None:
    return float(v) if v is not None else None  # type: ignore[arg-type]


def _disambiguate(items: list[SourceItem]) -> None:
    """2차 방어 — 접미를 붙이고도 라벨이 겹치면 접미를 키 전체로 늘린다.

    1차는 _to_item 이 한다(마스킹된 라벨엔 무조건 접미). 여기는 그 접미 6자리마저 겹치는
    경우만 처리한다. **병합하지 않는다** — 서로 다른 대상 둘을 한 줄로 합치면 조치가
    한쪽으로만 간다."""
    seen: dict[tuple[str, str], list[SourceItem]] = {}
    for it in items:
        if it.src is None:
            continue
        seen.setdefault((it.domain, it.src), []).append(it)
    for group in seen.values():
        if len(group) < 2:
            continue
        for it in group:
            base = it.src.split(" ·")[0] if it.src else ""
            it.src = f"{base} ·{it.srcKey}"
