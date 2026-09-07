"""도메인 ↔ state_domain 테이블/task_type 매핑 (엔진 SSOT 기반).

엔진 agent_type(=도메인)을 각 도메인의 작업큐 테이블·리포트 스레드·task_type 집합에 결부한다.
적대적 검증 반영:
- **domain→task_type는 1:1이 아니다**: github = ('github','jenkins')(엔진 domain_reports._DOMAIN_DEFS SSOT).
  1:1로 잡으면 jenkins finding이 github 워크스페이스에서 은닉된다.
- **큐 '대기'는 손나열 대신 '비종결(종결 status의 여집합)'로 도출**: 새 status가 생겨도 자동으로 대기에 잡혀
  과소집계(undercount)를 막는다. 종결 집합은 엔진 domain_reports SSOT(_SMB_TERMINAL_STATUSES 등) 기반.
persona 문자열을 엔진에 직접 전달하지 않는다(runtime-mapping 불변식) — 키는 (agentType=domain).
"""
from __future__ import annotations

import os
from dataclasses import dataclass

# 엔진 agent_type = 보안 도메인 (contracts EmployeeDomain 정합).
DOMAINS = ("smb", "dev_web", "github", "confluence")

# domain → finding task_type 집합(엔진 domain_reports._DOMAIN_DEFS SSOT).
# - github은 jenkins 포함(엔진 SSOT).
# - 엔진 'web' 도메인(task_type='web')은 dev_web이 재사용하는 **웹점검 베이스 툴킷** → digisecu는 dev_web에 통합
#   (실데이터상 web-점검 결과는 쓰기시점에 이미 'dev_web'으로 canon 태깅되어 'web' finding은 사실상 0건, 방어적 포함).
DOMAIN_TASK_TYPES: dict[str, tuple[str, ...]] = {
    "smb": ("smb",),
    "dev_web": ("dev_web", "web"),
    "github": ("github", "jenkins"),
    "confluence": ("confluence",),
}

# 큐 테이블 종결(=처리완료, 대기 아님) status. 여집합 = 비종결 = 대기.
# smb_share vocab(엔진 _SMB_TERMINAL_STATUSES) vs *_target vocab(관측+_TERMINAL_TARGET_STATUSES) 상이.
_SMB_SHARE_TERMINAL = (
    "walked",
    "listing_reviewed",
    "triaged_completed",
    "triaged_errored",
    "ignored",
    "closed",
)
# 엔진 SSOT _TERMINAL_TARGET_STATUSES{tasked,skipped,error} + 실측 done 상태 'hunted'(dev_web_target).
# 추정 status(scanned/done/closed)는 실측·SSOT 근거 없어 제거 — 비종결을 종결로 오분류한 undercount 방지.
# (미관측 status는 종결셋에 없어 자동으로 대기 집계=안전방향.)
_TARGET_TERMINAL = ("tasked", "skipped", "error", "hunted")


@dataclass(frozen=True)
class DomainTables:
    domain: str
    queue_table: str  # task 스테이지 큐(도메인 타깃/셰어)
    report_thread_table: str  # report/verify 스테이지 리포트 스레드
    report_label_col: str  # 도메인 식별 라벨(host/domain/repo/space_key)
    queue_terminal: tuple[str, ...]  # 이 큐 테이블의 종결 status(여집합=대기)


DOMAIN_TABLES: dict[str, DomainTables] = {
    "smb": DomainTables("smb", "smb_share", "mail_thread", "host", _SMB_SHARE_TERMINAL),
    "dev_web": DomainTables("dev_web", "dev_web_target", "dev_web_report_thread", "domain", _TARGET_TERMINAL),
    "github": DomainTables("github", "github_repo_target", "github_report_thread", "repo", _TARGET_TERMINAL),
    "confluence": DomainTables(
        "confluence", "confluence_space_target", "confluence_report_thread", "space_key", _TARGET_TERMINAL
    ),
}

# 리포트 스레드 종결(대기 아님) status — 이외 전부 비종결=대기. 실측 vocab + 보수적 확장.
REPORT_THREAD_TERMINAL = (
    "remediated",
    "escalated",
    "closed",
    "exception_review",
    "resolved",
    "false_positive",
)
# 비종결 중 재검증(verify) 단계 status(회신 수신/재점검 진행). 이외 비종결 = report 단계.
# 실측(mail: reply_received/re_requested, github/confluence: recheck_requested/rechecking) + 보수적.
VERIFY_STAGE_STATUS = (
    "reply_received",
    "recheck_requested",
    "rechecking",
    "re_requested",
    "partially_remediated",
    "awaiting_verify",
)


# ── src(대상) 파싱 SSOT ──────────────────────────────────────────────────────
# finding.asset 하나하나가 아니라 **그 자산이 속한 곳**(IP·저장소·도메인·스페이스)이 티켓의 단위다.
# 도메인 밀도가 1,980:1(github 19,808 : confluence 10)이라 finding 건수로는 4열이 무너지지만,
# src 로 세면 640/230/91/9 라 균형이 맞는다(2026-08-23 실측).
#
# ⚠️ task_type 이 아니라 **도메인** 축으로 분기한다 — github 은 ('github','jenkins') 라
#    task_type='github' 로만 잡으면 jenkins finding 이 미상으로 흘러간다(app.py:124 의 기존 버그와 동형).
# ⚠️ 파싱 실패(NULL)를 버리지 않는다 — smb 의 `Data/test.json`·`.ssh/id_rsa` 처럼 asset 에 host 가
#    아예 없는 행이 실재한다(실측 14건). 호출부가 "미상" 1급 버킷으로 렌더한다.
SRC_EXPR: dict[str, str] = {
    # → 'org/repo'. asset 은 **두 가지 폼**으로 들어온다:
    #     'github:org/repo/path/to/file'                       (API 스캔 레인)
    #     'https://github.samsungds.net/org/repo/blob/...'      (SSO/브라우저 레인)
    # 둘 다 벗겨야 한다. scheme+host 를 먼저 걷어내고, 그 다음 'github:' 접두를 벗긴다.
    #
    # ⚠️ 실측 2026-08-28: URL 폼을 안 벗겨서 `split_part('https://host/org/repo','/',1|2)`
    #    가 'https:' + '' → **'https:/' 라는 가짜 src 하나**가 됐고, github finding 38건 중
    #    31건이 그 한 티켓으로 접혔다(실제 저장소는 30개). 티켓이 4개로 보인 이유다.
    #    URL 폼이 전체의 82% 라 이 누락은 조용하지 않았어야 했다.
    #
    # 한 조각뿐이면 'org/' 가 아니라 NULL(=미상) 이 되도록 NULLIF 로 걸러낸다.
    "github": (
        "NULLIF("
        "split_part(regexp_replace(regexp_replace({col}, '^https?://[^/]+/', ''),"
        " '^github:', ''), '/', 1) || '/' || "
        "split_part(regexp_replace(regexp_replace({col}, '^https?://[^/]+/', ''),"
        " '^github:', ''), '/', 2)"
        ", '/')"
    ),
    # 'smb://IP/share/..' | '\\\\IP\\share\\..' | 'file:smb://..' → IP.
    # 역슬래시를 슬래시로 바꾼 뒤 scheme/선행 슬래시를 벗기고 선두 IPv4 만 취한다.
    "smb": (
        "substring("
        "regexp_replace(replace({col}, '\\', '/'), '^(file:)?smb:/*|^/+', '')"
        " from '^([0-9]{{1,3}}(?:\\.[0-9]{{1,3}}){{3}})')"
    ),
    # 'https://host/path?q' → 'host'. scheme 이 없으면 첫 경로 조각을 host 로 본다.
    "dev_web": (
        "COALESCE(substring({col} from '^https?://([^/:]+)'), NULLIF(split_part({col}, '/', 1), ''))"
    ),
    # '.../spaces/KEY/pages/123' → 'KEY'.
    "confluence": "substring({col} from '/spaces/([^/]+)')",
}

# src 가 무엇인지 — UI 가 열 제목/툴팁에 쓴다(자유텍스트 아님, 게이트웨이가 생성).
SRC_KIND: dict[str, str] = {
    "smb": "host",
    "dev_web": "domain",
    "github": "repo",
    "confluence": "space",
}


def src_case_sql(column: str = "asset", type_column: str = "task_type") -> str:
    """4개 도메인 전체를 한 번에 파싱하는 CASE 식(도메인 축).

    도메인 필터가 걸린 단일 도메인 조회에도 그대로 쓸 수 있다 — 해당 task_type 만 남으므로
    다른 분기는 평가되지 않는다. 미지 task_type(exposure/generic 등)은 NULL 로 떨어진다.
    """
    parts = []
    for domain, expr in SRC_EXPR.items():
        tts = DOMAIN_TASK_TYPES[domain]
        lst = ", ".join(f"'{t}'" for t in tts)  # 리터럴은 SSOT 상수뿐(사용자 입력 아님)
        parts.append(f"WHEN {type_column} IN ({lst}) THEN {expr.format(col=column)}")
    return "CASE " + " ".join(parts) + " END"


def domain_case_sql(type_column: str = "task_type") -> str:
    """task_type → 도메인 CASE 식. github=jenkins·dev_web=web 흡수(SSOT)."""
    parts = []
    for domain in DOMAINS:
        lst = ", ".join(f"'{t}'" for t in DOMAIN_TASK_TYPES[domain])
        parts.append(f"WHEN {type_column} IN ({lst}) THEN '{domain}'")
    return "CASE " + " ".join(parts) + " END"


def all_domain_task_types() -> tuple[str, ...]:
    """4개 도메인이 흡수하는 task_type 전체(중복 제거, 순서 안정)."""
    seen: list[str] = []
    for d in DOMAINS:
        for t in DOMAIN_TASK_TYPES[d]:
            if t not in seen:
                seen.append(t)
    return tuple(seen)


# ── 리포트 스레드 테이블별 컬럼 보유(실측) ─────────────────────────────────────
# 4종이 균질하지 않다. 없는 컬럼을 그냥 SELECT 하면 undefined-column 이 나고, 그걸 catch-무시하면
# 도메인 하나가 조용히 빠진다 — 그래서 **per-source 명시 projection** 으로 없는 것은 타입 지정 NULL alias.
REPORT_HAS_OWNER = frozenset({"github_report_thread", "confluence_report_thread"})
REPORT_HAS_NOTIFIED = frozenset({"github_report_thread", "confluence_report_thread"})
REPORT_HAS_FINDING_IDS = frozenset({"github_report_thread", "confluence_report_thread", "mail_thread"})
# smb(mail_thread) 만 보유 — 재발 횟수·마지막 오류 종류.
REPORT_HAS_RECURRENCE = frozenset({"mail_thread"})
# 보고서 본문. ⚠️ 보유 ≠ 채워짐 — 4종 다 6주간 파이프라인이 안 돌아 실제로는 거의 비어 있다
# (github 0/299 실측). 그래서 상세는 본문이 아니라 **보유 여부**를 계약한다.
REPORT_HAS_HTML = frozenset({"github_report_thread", "confluence_report_thread"})
REPORT_HAS_JSON = frozenset({
    # 2026-08-29: smb 도 합류. 그 전엔 smb 본문이 발송 시점의 `mail_message` 에만 생겼고
    # 그 테이블은 GRANT 밖이라, 발송 전 단계의 smb 티켓 24건이 콘솔에서 전부 빈 칸이었다.
    # 이제 제출 시점에 `mail_thread.report_json` 에 초안이 실린다(3도메인과 같은 자리).
    "github_report_thread", "confluence_report_thread", "dev_web_report_thread",
    "mail_thread",
})
# 티켓 번호 — 4종 모두 보유(2026-08-31 마이그레이션).
# ★ 게이트웨이는 **읽기만** 한다. 접두 규칙(SMB/GH/CF/DW)은 스킬의
#   `_shared/ticket_id.py` 가 정본이고, 저장은 `state_domain.thread_ensure_ticket_no`
#   하나가 한다. 여기서 규칙을 다시 갖고 있으면 사본이 되고, 한쪽만 바뀌면 메일에
#   찍힌 번호를 콘솔이 못 읽는다(조용한 실패).
REPORT_HAS_TICKET_NO = frozenset({
    "mail_thread", "github_report_thread",
    "confluence_report_thread", "dev_web_report_thread",
})
# 도메인 고유 좌표 — report_label_col 로 안 접히는 것들.
REPORT_HAS_SHARE_ID = frozenset({"mail_thread"})
REPORT_HAS_REPO = frozenset({"github_report_thread"})
REPORT_HAS_SPACE_KEY = frozenset({"confluence_report_thread"})
REPORT_HAS_TARGET_ID = frozenset({"dev_web_report_thread"})
REPORT_HAS_URL = frozenset({"dev_web_report_thread"})

# ── pipeline_run component → 도메인 ────────────────────────────────────────────
# 엔진이 소유하는 이름이고 **접두 규칙이 균질하지 않다**(실측): github/confluence 는 점 접두
# (`github.report`), dev_web 은 밑줄 접두(`dev_web_report`), smb 는 접두가 아예 없다
# (`hunt`/`task`/`mail`/`reverify`/`collector` — smb 가 먼저 생겨서 이름을 선점했다).
# 그래서 smb 만 명시 집합이다. 새 component 가 생기면 어디에도 안 잡히므로,
# `unclassified` 를 값으로 노출한다(조용히 빠지지 않게 — QualityCandidates 와 같은 규율).
_SMB_COMPONENTS = frozenset({"hunt", "task", "mail", "reverify", "collector"})


def component_domain(component: str) -> str | None:
    """pipeline_run.component → 도메인. 모르면 None(호출부가 unclassified 로 센다)."""
    c = str(component or "").strip()
    if not c:
        return None
    if c in _SMB_COMPONENTS or c.startswith("smb"):
        return "smb"
    for domain in ("dev_web", "github", "confluence"):
        if c == domain or c.startswith(f"{domain}.") or c.startswith(f"{domain}_"):
            return domain
    return None


# 본문을 **읽을 수 있는가** — "본문 없음" 과 "권한 없음" 은 다른 뜻이다.
#  · github/confluence : 스레드 테이블에 report_html/report_json 보유, GRANT 도 있음 → ok
#  · dev_web           : report_json 만 보유 → ok (html 은 애초에 없다)
#  · smb               : mail_thread 엔 본문 컬럼이 없다. 본문은 `mail_message` 에 있는데
#                        게이트웨이 롤(digisecu_gw_ro)에 부여돼 있지 않다(42501) → denied.
#                        없는 게 아니라 못 읽는 것이라 화면에 그렇게 말해야 한다.
REPORT_BODY_ACCESS: dict[str, str] = {
    "github": "ok",
    "confluence": "ok",
    "dev_web": "ok",
    # 2026-08-29: `mail_thread.report_json` 신설로 읽을 수 있게 됐다. 예전 "denied" 는
    # "본문 없음" 이 아니라 "못 읽음"(mail_message 가 GRANT 밖) 이라는 뜻이었다.
    "smb": "ok",
}


REPORT_TABLES = frozenset(t.report_thread_table for t in DOMAIN_TABLES.values())


#: 발송 근거 어휘 — "메일이 실제로 나갔는가" 를 무엇으로 판정하는지.
#: ★ 도메인마다 다르다. github/confluence 만 notified_at 컬럼이 있고, smb/dev_web 은 없다.
#:   화면이 이 차이를 모르면 `notifiedAt=null` 을 "안 나갔다" 로 읽는데, 뒤 둘에서는
#:   그냥 "알 수 없다" 다. 근거를 **값으로** 내려보내 그 구분을 넘긴다.
DELIVERY_EVIDENCE_TIMESTAMP = "timestamp"      # notified_at 보유 — 발송 시각이 사실로 남는다
DELIVERY_EVIDENCE_STATUS_ONLY = "status_only"  # 컬럼 없음 — status 로만 추론 가능


def delivery_evidence(domain: str) -> str:
    """이 도메인의 발송 판정 근거. REPORT_TABLES 가 SSOT 이므로 별도 목록을 두지 않는다."""
    spec = DOMAIN_TABLES.get(str(domain or "").lower())
    table = spec.report_thread_table if spec else None
    return (
        DELIVERY_EVIDENCE_TIMESTAMP
        if table in REPORT_HAS_NOTIFIED
        else DELIVERY_EVIDENCE_STATUS_ONLY
    )


# ── DSSOC 신원 판정 ──────────────────────────────────────────────────────────
#: 스킬 `service/services/owner_recipients.DSSOC_ENV_NAMES` 의 미러.
#: ⚠️ 이건 **발송 목록이 아니라 신원 판정**이다 — "누구에게 보낼까" 가 아니라 "이 주소가
#:    우리인가". 게이트웨이는 읽기 전용이라 발송 목록은 아예 필요 없다.
DSSOC_ENV_NAMES: tuple[str, ...] = (
    "SMB_REMEDIATION_DSSOC_RECIPIENT",
    "GITHUB_REMEDIATION_DSSOC_RECIPIENT",
    "CONFLUENCE_REMEDIATION_DSSOC_RECIPIENT",
    "DEV_WEB_REMEDIATION_DSSOC_RECIPIENT",
    "SA_DSSOC_MAIL_RECIPIENT",
)

#: local part 접두 백스톱 — env 가 안 붙은 배포에서도 팀함 계열을 잡는다.
#: `noreply`/`no-reply` 는 팀함은 아니지만 **담당자가 아닌 것**은 같아서 함께 둔다.
DSSOC_LOCALPART_PREFIXES: tuple[str, ...] = ("dssoc", "soc", "noreply", "no-reply")


def is_dssoc(email: object) -> bool:
    """이 주소가 우리(팀함·자동발신)인가 — 즉 **담당자가 아닌가**.

    ★ env 를 먼저 본다. 하드코딩 접두만 보면 팀함 주소를 바꿨을 때 판정이 안 따라가고,
      화면은 팀함을 담당자로 그린다. 엔진 쪽에서 정확히 그 일이 있었다
      (`state_domain._service_owner_recipient_hint`, 2026-08-24 수정).
    ★ 같은 함수가 `finding_repo._is_dssoc_email` 과 `workspace_repo._is_dssoc` 로 **두 벌**
      복사돼 있었고, workspace_repo 는 제 사본과 finding_repo 사본을 한 파일 안에서
      섞어 쓰고 있었다. 여기가 유일한 정의다.
    """
    e = str(email or "").strip().lower()
    if not e:
        return False
    for name in DSSOC_ENV_NAMES:
        for raw in str(os.environ.get(name) or "").split(","):
            known = raw.strip().lower()
            if known and (e == known or e.split("@", 1)[0] == known.split("@", 1)[0]):
                return True
    local = e.split("@", 1)[0]
    return any(local == d or local.startswith(d) for d in DSSOC_LOCALPART_PREFIXES)


def report_col(table: str, col: str, sql_type: str) -> str:
    """그 테이블에 col 이 있으면 `t.col`, 없으면 `NULL::<type>`.

    보유 여부는 위 frozenset 이 SSOT — 예외를 삼키는 대신 미보유를 값으로 표현한다."""
    have = {
        "owner_recipient": REPORT_HAS_OWNER,
        "notified_at": REPORT_HAS_NOTIFIED,
        "finding_ids": REPORT_HAS_FINDING_IDS,
        "recurrence_count": REPORT_HAS_RECURRENCE,
        "last_error_kind": REPORT_HAS_RECURRENCE,
        "report_html": REPORT_HAS_HTML,
        "report_json": REPORT_HAS_JSON,
        "ticket_no": REPORT_HAS_TICKET_NO,
        "share_id": REPORT_HAS_SHARE_ID,
        "repo": REPORT_HAS_REPO,
        "space_key": REPORT_HAS_SPACE_KEY,
        "target_id": REPORT_HAS_TARGET_ID,
        "url": REPORT_HAS_URL,
    }[col]
    return f"t.{col}" if table in have else f"NULL::{sql_type}"


def report_union_sql() -> str:
    """4개 리포트 스레드 테이블을 (domain, src, ...) 공통 스키마로 세로 결합.

    라벨 컬럼 이름이 도메인마다 달라(host/domain/repo/space_key) 그대로는 조인이 안 된다 —
    여기서 `src` 로 통일한다. 테이블·컬럼 식별자는 전부 이 모듈의 고정 SSOT 에서 온다(사용자 입력 아님).
    """
    parts = []
    for domain in DOMAINS:
        dt = DOMAIN_TABLES[domain]
        table = dt.report_thread_table
        parts.append(
            f"SELECT '{domain}'::text AS domain, t.{dt.report_label_col}::text AS src, "
            # 본문을 되물으려면 스레드 id 가 필요하다 — `/gw/reports/{{key}}/{{id}}/body`.
            # 이게 없어서 티켓 상세는 6주간 발송 이력을 '언제' 까지만 그리고 '무엇을'
            # 은 못 그렸다(본문 라우트는 그동안 정상 응답 중이었다).
            f"t.id::bigint AS thread_id, "
            f"t.status::text AS status, t.updated_at AS updated_at, "
            f"t.first_reported_at AS first_reported_at, t.attempt_count AS attempt_count, "
            f"{report_col(table, 'notified_at', 'double precision')} AS notified_at, "
            f"{report_col(table, 'owner_recipient', 'text')} AS owner_recipient, "
            # 티켓 번호는 **계산하지 않고 읽는다.** 생산자는 스킬의
            # `state_domain.thread_ensure_ticket_no` 하나뿐이다 — 여기서 접두 지도를
            # 다시 갖고 있으면 사본이 되고, 한쪽만 바뀌면 메일에 찍힌 번호를 콘솔이
            # 못 읽는다(조용한 실패).
            f"{report_col(table, 'ticket_no', 'text')} AS ticket_no, "
            f"t.recipient::text AS recipient "
            f"FROM {table} t"
        )
    return " UNION ALL ".join(parts)
