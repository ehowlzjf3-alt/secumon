"""게이트웨이 응답 모델 (pydantic). contracts zod 계약과 1:1 대응(SSOT는 contracts).

이름공간: UI 위임 엔티티(delegatedTask)와 구분해 엔진 실행 큐는 queueDepth/runtimeQueueItem로 표면화.
마스킹: finding.summary 는 저장시점 봉인(SELECT=마스킹값). extra_json/evidence_ref 경로/ finding_index 는
미표면화(마스킹 seal 우회 방지). evidence 존재는 hasEvidence 불리언으로만.
"""
from __future__ import annotations

from pydantic import BaseModel


class MaskedHit(BaseModel):
    """finding 상세 마스킹 증거 hit(단건 엔드포인트 전용). preview는 detector 마스킹 +
    게이트웨이 read 경계 재마스킹을 거친 값 — 원문/시크릿 원값 복원 불가."""
    category: str
    kind: str
    lineNo: int | None = None
    preview: str


class FindingCategory(BaseModel):
    """finding 데이터 분류(고정 어휘). key=엔진 category, label=한국어. extra_json.hits[].category
    (+confluence hit_categories)에서 도출. 자유텍스트 아님 — 게이트웨이가 라벨 생성(마스킹 불요)."""
    key: str
    label: str


class GatewayFinding(BaseModel):
    """finding_lifecycle 마스킹 projection. 원문 컬럼(extra_json)·evidence 경로 미노출.
    maskedHits는 단건 상세에서만 채워짐(extra_json.masked_hits 화이트리스트 투영·재마스킹)."""
    id: int
    taskType: str  # 엔진 task_type = 도메인
    asset: str
    assetKind: str
    severity: str
    summary: str  # 저장시점 마스킹 봉인됨
    status: str
    owner: str | None = None
    ticketRef: str | None = None
    firstSeen: float
    lastSeen: float
    seenCount: int
    hasEvidence: bool  # evidence_ref IS NOT NULL — 경로 자체는 미노출(불투명)
    # 데이터 분류(리스트/payload/detail 모두). category=대표(그룹핑용, 없으면 미분류),
    # categories=전체 집합(배지·필터용, 우선순위 내림차순). extra_json.hits[].category 도출.
    category: FindingCategory
    categories: list[FindingCategory] = []
    # DEPRECATED(codex 적대검증): 과거 extra_json.masked_hits 화이트리스트 투영. 그 키를 쓰는
    # 실 스캐너가 없어 항상 null 이었다. extractor 를 제거하고 상시 None 으로 고정한다(미래 masked_hits
    # 키가 우연히 재활성화되는 것 차단). 상세 증거는 GatewayFindingDetail.hits 를 쓴다.
    maskedHits: list[MaskedHit] | None = None


class FindingList(BaseModel):
    total: int
    items: list[GatewayFinding]


# ── 단건 finding 상세 리치 필드(codex 적대검증 반영) ─────────────────────────────
# 전부 detail 엔드포인트(/gw/findings/{id})에서만 채워지고 리스트/payload=None. 모든 free-text 는
# 게이트웨이 경계 redact() 를 마스킹→절단 순서로 통과하고, 구조 필드(status/int/bool)는 엄격 검증된다.
# 화이트리스트 투영(blacklist 아님) — 미지의 새 extra_json 키는 절대 표면화되지 않는다.
class HitLoginValidation(BaseModel):
    """이 hit 의 크리덴셜로 **실제 로그인 1회**를 시도한 결과(extra_json.hits[].validation.login_probe).

    "평문 노출"과 "악용 가능(확인됨)"을 가르는 사실이라 상세에 표면화한다. 투영 원칙:
      - result/engine 은 **고정 어휘 allowlist** 만 통과(미지 값이면 이 객체 자체를 드롭) —
        DB 문자열이 UI 배지 문구로 그대로 올라가는 스푸핑을 막는다.
      - endpoint 는 IP/FQDN + 포트를 엄격 검증해 재조립한 값만(원문 문자열 통과 아님).
      - principalMasked 는 **마스킹 표식(`*`)이 실제로 있는 값만** 통과 — 원본 계정명 누출 차단.
      - login_probe 하위의 `auth_attempts`/`credential_fields`/`bound_masked` 는 **절대 투영하지
        않는다**(각각 평문 username·부분마스킹 비밀번호·detector masked 원문 사본을 담는다).
      - 안전정책 문구(policy)는 DB 값을 쓰지 않고 UI 가 고정 문구로 렌더한다.
    """
    result: str                        # authenticated|auth_failed|account_locked|credential_expired|session_denied
    provesValidity: bool = False       # 크리덴셜이 살아있음이 증명됨(authenticated 만 '악용 가능')
    engine: str | None = None          # mssql|postgres
    endpoint: str | None = None        # host:port — 검증 통과분만(IPv6 는 [addr]:port)
    principalMasked: str | None = None  # 마스킹된 계정(예: a**********r) — 원본 아님
    singleAttempt: bool = False        # 단발 시도(재시도·쿼리 없음)
    elapsedMs: int | None = None


class DetailHit(BaseModel):
    """증거 hit(마스킹). preview 는 detector 마스킹 + 게이트웨이 경계 재마스킹 — 원값 복원 불가."""
    category: str
    kind: str
    lineNo: int | None = None
    location: str | None = None  # 발견 위치(URL/파일경로) — 마스킹됨
    preview: str = ""            # 증거 본문 미리보기(마스킹)
    # 로그인 검증 증거(있을 때만). 없는 hit 이 절대다수이므로 기본 None — UI 는 None 일 때
    # 배지/구분선/빈 표를 그리지 않는다.
    loginValidation: HitLoginValidation | None = None


class RiskNarrative(BaseModel):
    """4부 위험내용(agent 작성, 값 아닌 유형 서술 원칙 + 경계 재마스킹). 없는 항목은 None."""
    whatIsData: str | None = None
    howDiscovered: str | None = None
    exploitationPath: str | None = None
    verificationMethod: str | None = None


class EvidenceNote(BaseModel):
    """한 증거 위치 해설. sensitiveFields 는 값이 아니라 필드명/유형(그래도 방어 재마스킹)."""
    location: str = ""
    whatThisIs: str | None = None
    sensitiveFields: list[str] = []
    contextNote: str | None = None


class PivotProbe(BaseModel):
    """pivot 후보 URL 도달 probe. url 은 scheme+host+path 만(userinfo/query/fragment 제거)."""
    url: str
    status: str          # HTTP status 숫자문자열 or '000'
    exposed: bool
    contentType: str | None = None
    evidenceMasked: str | None = None  # 응답 본문 샘플(마스킹)


class PivotSummary(BaseModel):
    """측면이동(pivot) 요약 — 이 finding 이 도달 가능케 한 내부 표면."""
    exposedCount: int
    probes: list[PivotProbe] = []


class Verification(BaseModel):
    """검증 상태 — github: live_in_HEAD/historical_only 등."""
    status: str | None = None
    method: str | None = None
    source: str | None = None


class FindingMetadata(BaseModel):
    """도메인 메타(화이트리스트 키만). github: repo/path/source(worktree|history)/commit."""
    repo: str | None = None
    path: str | None = None
    source: str | None = None
    commit: str | None = None
    scanMethod: str | None = None


class Assignee(BaseModel):
    """finding 담당자(매칭 결과 · **표시 전용, 발송 아님**). base GatewayFinding.owner(엔진
    finding_lifecycle.owner, 미사용)와 구분해 assignee 로 표면화한다.
    SMB=Splunk asset_owner(IP), github/confluence=report_thread.owner_recipient, dev_web=DSSOC 기본.

    status: resolved(담당자 확인) | unresolved(매칭 시도했으나 없음) | dssoc_only(개별 담당자 없음).
    email 은 검증된 사내 메일박스 1개만(secret redact 우회, 대신 문법검증). name/dept 는 redact.
    source 는 raw 미노출 — 고정 라벨(sourceLabel)만. 다수 담당자 존재 시 ambiguous=True.

    name/dept/title 은 employee_directory(knox 대장) 조인으로 붙는다. 게이트웨이는 knox 를
    부르지 않으므로(격리 불변식) 스킬 수집기가 적재한 것만 보인다 — sql/005 GRANT 가 없으면
    이름 없이 메일만 나간다.
    ★ confirmed=False 는 **추정**이다. 조직 저장소는 GHES 에 담당자 개념이 없어(collaborators
    404·CODEOWNERS 부재·org members 전원 admin) 1위 기여자로 대신한다. 확정과 합치면
    추정이 확정으로 위장하므로 필드로 분리한다."""
    status: str
    name: str | None = None
    dept: str | None = None
    title: str | None = None       # 직급(knox). 없을 수 있다 — 사번은 투영하지 않는다.
    email: str | None = None
    sourceLabel: str | None = None
    ambiguous: bool = False
    confirmed: bool = True         # False = 추정(조직 저장소의 주 기여자). 화면이 구분해야 한다.


class GatewayFindingDetail(GatewayFinding):
    """단건 상세 = GatewayFinding + extra_json 리치 필드 투영. 리스트 계약은 lean 유지.

    구 maskedHits 는 base 에서 deprecated(항상 None) — 이 상세는 fixed `hits` 를 쓴다.
    assignee = 매칭된 담당자(표시 전용). base owner(엔진 컬럼)와 다름."""
    assignee: Assignee | None = None
    hits: list[DetailHit] | None = None
    riskNarrative: RiskNarrative | None = None
    recommendedActions: list[str] | None = None
    pivotInterpretation: str | None = None
    evidenceNotes: list[EvidenceNote] | None = None
    pivot: PivotSummary | None = None
    verification: Verification | None = None
    metadata: FindingMetadata | None = None
    confidence: float | None = None
    target: str | None = None
    assetCountScanned: int | None = None
    # hits 중 하나라도 로그인 검증(authenticated·proves_validity)을 가지면 True — 헤더에서 상세를
    # 펼치지 않고도 '악용 가능 확인'을 알리기 위한 파생 플래그(hits 투영 결과에서만 계산).
    loginValidated: bool = False


class QueueDepth(BaseModel):
    """(agentType=domain) 파이프라인 스테이지별 대기 깊이. strategy=수집(collector 소스 대기)."""
    agentType: str
    strategy: int  # 수집 소스 대기(smb=subnet·dev_web=web도메인). 롤링수집(github/confluence)=0
    task: int
    report: int
    verify: int


class QueueDepthList(BaseModel):
    items: list[QueueDepth]


class ReportThreadItem(BaseModel):
    """리포트 스레드 진행상태. finding_id opaque → LEFT JOIN finding_lifecycle(마스킹 summary).

    고도화(codex 반영): 담당자(ownerRecipient=검증 메일박스, 없으면 null)·findingCount(다건 스레드)·
    deliveryTarget(발송대상 고정라벨; DSSOC 등은 담당자 아님) 추가. raw recipient/lastReason 은 미노출."""
    id: int
    status: str
    severity: str | None = None
    subjectTag: str
    label: str  # 도메인 식별(host/domain/repo/space_key)
    findingId: int | None = None
    findingSummary: str | None = None  # 마스킹됨, dangling finding_id 시 null
    updatedAt: float | None = None
    # 담당자 이메일(검증된 사내 메일박스, dssoc 계열 제외). 사용자 결정: 사내 ACL 사이트라 목록 노출 허용.
    # (안전장치 유지: 문법검증·CRLF/리스트 거부·dssoc 제외·payload no-store.)
    ownerRecipient: str | None = None
    #: 발송 판정 근거(domains.delivery_evidence). notifiedAt=null 의 뜻을 결정한다.
    deliveryEvidence: str = "status_only"
    deliveryTarget: str | None = None   # 발송대상 고정라벨("DSSOC"/"담당자 개별") — raw 메일 아님
    findingCount: int = 1               # finding_id ∪ finding_ids 중복제거 수
    notifiedAt: float | None = None
    # ── 발송 이력(값은 이미 DB 에 다 있었고 게이트웨이가 투영을 안 했을 뿐) ──
    # 4/4 테이블 공통 컬럼. firstReportedAt~updatedAt 사이가 곧 "이 건이 밀린 기간" 이다.
    firstReportedAt: float | None = None
    attemptCount: int | None = None     # 재시도 횟수(무응답 → 재발송 카운터)
    cycleKeys: list[str] = []           # 발송이 걸친 주차들(예 ["2026-W27","2026-W30"])
    lastReason: str | None = None       # 마지막 처리 사유 — free-text 라 redact 통과시킨다
    # ── smb(mail_thread) 전용 — 나머지 3종엔 컬럼 자체가 없다. nullable 필수. ──
    recurrenceCount: int | None = None  # 같은 대상이 다시 걸린 횟수
    lastErrorKind: str | None = None    # 마지막 오류 종류(enum 성 문자열, redact 통과)


class WeeklyPoint(BaseModel):
    week: str
    inflow: int
    resolved: int


class DomainStats(BaseModel):
    """도메인 1개의 발생·조치 현황.

    ⚠️ `remediated` 의 근거가 도메인마다 다르다 — `remediationBasis` 로 무엇을 세었는지 밝힌다.
    같은 열에 다른 뜻의 숫자를 담고 침묵하면 그건 거짓말이 된다."""
    domain: str
    sources: int                     # 대상 종수(파싱된 것)
    unparsedFindings: int = 0        # src 파싱 실패 — 버리지 않고 "미상" 으로 센다
    findings: int
    openFindings: int
    falsePositive: int
    critical: int
    high: int
    weekNew: int                     # 이번 주 발생(first_seen 기준)
    weekRemediated: int
    remediated: int
    remediationBasis: str            # verification_gone | reverify_now_closed | none
    remediationLookup: str = "ok"    # ok | denied — 못 읽은 것과 0건을 구분
    threads: int = 0
    # ⚠️ 예전 이름은 notifiedSources 였는데 세는 것은 "스레드가 하나라도 있는 대상" 이다.
    #    통보 여부가 아니라 스레드 존재 여부라 이름이 거짓말이었다.
    sourcesWithThread: int = 0
    sourcesWithoutThread: int = 0
    #: 발송이 **사실로 확인된** 대상. 근거가 없는 도메인(smb·dev_web)은 None 이다.
    #: ★ 0 으로 내리면 "한 통도 안 나갔다" 는 거짓 주장이 된다 — 모르는 것은 모른다고 낸다.
    #: ⚠️ 모수가 /gw/sources 목록과 다를 수 있다. 이 셋은 **스레드**에서 세는데, 대상 목록은
    #:    finding 에서 만들어진다. finding 이 정리됐는데 스레드만 남은 대상이 실제로 있다
    #:    (codex/pop3-inbox-test-20260701: 스레드 1·발송 1·finding 0). 그래서 여기 숫자가
    #:    목록에서 찾을 수 없는 경우가 생긴다 — 버그가 아니라 모수 차이다.
    sourcesDelivered: int | None = None
    deliveryEvidence: str = "status_only"
    awaitingThreads: int = 0
    closedThreads: int = 0
    #: ★ **대상(src) 단위** — 콘솔의 "티켓" 은 대상 1건이다(`/gw/sources` total 과 같은 모수).
    #: 스레드 수(`threads`)와 1:1 이 아니다: dev_web 대상 34에 스레드 101, github 대상 177에
    #: 스레드 3. 대시보드에 스레드 수를 "티켓" 으로 그렸더니 목록(250)과 어긋났다(2026-08-29).
    sourcesAwaiting: int = 0
    sourcesClosed: int = 0
    queueWaiting: int = 0


class CategoryCount(BaseModel):
    key: str
    label: str
    count: int


class StatsTotals(BaseModel):
    findings: int
    sources: int
    openFindings: int
    falsePositive: int
    threads: int
    weekNew: int
    weekRemediated: int
    remediated: int
    sourcesWithoutThread: int
    awaitingThreads: int
    sourcesAwaiting: int = 0
    sourcesClosed: int = 0


class GatewayStats(BaseModel):
    """개요 한 판 — 4도메인을 1회 호출로.

    도메인 루프로 짜면 payload 8왕복 × 4 = 32왕복이라 pool_max=4 를 굶긴다(선존 Reports 팬아웃).
    여기서는 finding_lifecycle **1스캔** + 스레드 union 1회로 끝낸다.

    `asOf` 는 서버 epoch — db.py 에 트랜잭션 헬퍼가 없어 **쿼리 간 스냅샷 일관성이 없다**.
    합계가 도메인 합과 1~2 어긋날 수 있다는 뜻이고, 숨기는 대신 기준 시각을 같이 낸다."""
    asOf: float
    week: str                        # 현재 ISO 주차(smb cycle_key 와 같은 형식: 2026-W34)
    totals: StatsTotals
    domains: list[DomainStats]
    weekly: list[WeeklyPoint]
    categories: list[CategoryCount]
    ownerLookup: str = "ok"


class SourceItem(BaseModel):
    """대상(src) 1건 — 티켓의 단위.

    finding 은 파일/URL 하나하나지만 사람이 조치하는 단위는 그것이 **속한 곳**이다(IP·저장소·
    웹도메인·스페이스). asset 을 도메인별 규칙으로 파싱해 묶는다(domains.SRC_EXPR SSOT).

    ⚠️ `src` 는 표시용 마스킹 라벨이고, 되묻는 키는 `srcKey`(불투명 해시)다 — 마스킹으로 서로 다른
    두 대상이 같은 라벨이 되는 경우가 있어(967종이면 무시 못 할 확률) 라벨로 필터하면 섞인다.
    `src=null` 은 파싱 실패(=미상)이며 버리지 않고 1급 버킷으로 낸다."""
    domain: str
    srcKind: str                        # host | repo | domain | space (고정 어휘)
    src: str | None = None              # 마스킹 라벨. null = 미상(asset 에 host 가 없는 상대경로 등)
    srcKey: str                         # 되묻기용 불투명 키(원문 미노출). /gw/findings?srcKey= 로 사용
    findings: int
    openFindings: int
    critical: int
    high: int
    #: 이 대상 발견들의 **데이터 분류**. category=대표(없으면 None=미분류),
    #: categories=전체(우선순위 내림차순). finding 상세와 같은 taxonomy.classify 산출물.
    category: dict[str, str] | None = None
    categories: list[dict[str, str]] = []
    firstSeen: float | None = None
    lastSeen: float | None = None
    # ── 통보(리포트 스레드) 결합. 스레드가 없으면 threads=0·threadStatus=null 이며
    #    그건 "미통보" 이거나 "연결 없음"(confluence: finding 의 space 와 큐의 space 가 서로소)이다.
    threads: int = 0
    threadStatus: str | None = None     # 가장 최근 스레드의 status
    # 가장 최근 스레드의 id. 본문을 되묻는 키다 — `/gw/reports/{domain}/{threadId}/body`.
    # ⚠️ 한 대상에 스레드가 여럿이다(smb 230호스트/509스레드 — 주차마다 새로 열린다).
    #    이건 "이 티켓의 본문" 이 아니라 **가장 최근 본문**이다.
    threadId: int | None = None
    #: 메일 제목에 나가는 티켓 번호(`SMB00024`). 담당자가 이 번호로 문의하면 운영자가
    #: 그대로 검색해 찾을 수 있어야 한다. 정본은 스킬의 `_shared/ticket_id.py`.
    #: ⚠️ `threadId` 와 마찬가지로 **가장 최근 스레드**의 번호다.
    ticketNo: str | None = None
    # ★ notifiedAt=null 의 뜻은 deliveryEvidence 에 달려 있다.
    #   "timestamp"   → 컬럼이 있는데 비었다 = **안 나갔다**(사실)
    #   "status_only" → 컬럼 자체가 없다   = **알 수 없다**
    #   이 구분이 없으면 화면이 smb 를 "전부 미발송" 으로 단정한다.
    notifiedAt: float | None = None
    deliveryEvidence: str = "status_only"   # domains.delivery_evidence() 미러
    lastActivityAt: float | None = None
    firstReportedAt: float | None = None
    attemptCount: int | None = None
    deliveryTarget: str | None = None
    assignee: Assignee | None = None    # 담당자(표시 전용 · 발송 아님)


class SourceList(BaseModel):
    """대상 목록.

    `ownerLookup` 은 담당자 조회 **가능 여부**다 — "담당자 없음" 과 "못 읽음" 을 구분하기 위해 낸다.
    asset_owner 는 sql/004 로 GRANT 해야 읽히는데, 없으면 조용히 전원 미배정으로 보인다(선존 버그).
    denied 면 UI 는 '담당자 없음' 이 아니라 '권한 없음' 을 보여야 한다."""
    total: int
    items: list[SourceItem]
    ownerLookup: str = "ok"             # ok | denied
    asOf: float | None = None           # 서버 epoch(스냅샷 일관성 없음을 드러내기 위해)


class WorkspaceKpi(BaseModel):
    openFindings: int
    queueTargets: int
    reportThreads: int


class PerfKpi(BaseModel):
    label: str
    value: str | int
    sub: str | None = None


class FunnelItem(BaseModel):
    label: str
    value: int


class GatewayPerformance(BaseModel):
    """성과 대시보드 실집계 — 퍼널(severity 분포)·주간추이(유입/처리)."""
    kpis: list[PerfKpi]
    funnel: list[FunnelItem]
    weekly: list[WeeklyPoint]


class WorkspacePayload(BaseModel):
    """워크스페이스 payload — 구조(sectionLayout)는 control-plane 소유, 게이트웨이는 payload만."""
    key: str
    findings: list[GatewayFinding]
    reports: list[ReportThreadItem]
    kpi: WorkspaceKpi
    performance: GatewayPerformance


# ── 도메인 런타임(presence/activity) — component(공유 워커) 키. employee_id/employees.status/과거 phase 미포함(codex). ──
class ComponentRuntime(BaseModel):
    """컴포넌트 1개 현재 상태(as-of). phase는 heartbeat 현재값만(과거 run에 붙이지 않음)."""
    component: str
    liveness: str  # live|delayed|stale|unknown
    activity: str  # active|idle|disabled|unknown
    phase: str | None = None
    lastBeatAt: float | None = None  # epoch


class ComponentCounts(BaseModel):
    total: int
    live: int
    delayed: int
    stale: int
    unknown: int


class DomainRuntime(BaseModel):
    """도메인 단위 집계(개인 아님). 공유 워커들의 liveness/activity/health 요약."""
    domain: str
    liveness: str
    activity: str
    health: str  # ok|degraded|unknown (최신 terminal run 기준)
    lastBeatAt: float | None = None
    componentCounts: ComponentCounts
    components: list[ComponentRuntime]


class RuntimePresence(BaseModel):
    """GET /gw/runtime/presence — 도메인 런타임 상태(4도메인). scope로 개인상태 아님을 못박음."""
    scope: str = "domain_runtime"
    asOf: float
    policyVersion: str
    domains: list[DomainRuntime]


class RuntimeActivityItem(BaseModel):
    """pipeline_run 1건 — 공유 도메인 워커의 실행 기록(개인 작업 이력 아님). detail은 redact됨."""
    component: str
    startedAt: float
    finishedAt: float | None = None
    status: str
    counters: dict[str, int]
    detailRedacted: str | None = None


class RuntimeActivityList(BaseModel):
    scope: str = "domain_runtime"
    domain: str
    asOf: float
    items: list[RuntimeActivityItem]


class QualitySilentAttempt(BaseModel):
    """침묵 attempt 1건(드릴다운) — 식별은 attemptId(UUID)만, 라벨/경로 미노출(기밀성 경계)."""
    attemptId: str
    domain: str
    workerType: str
    component: str
    candidatesSeen: int | None = None
    executionState: str
    lastAt: float


class QualityDomainReport(BaseModel):
    """도메인 1개의 candidate 품질 집계 — '모르면 모른다고 말하는' 응답 계약.

    status=noData(attempt 0건)는 clean 이 아니다. rawCandidateSignals 는 도구별 단위가
    이질(hit/페이지/finding)이라 비율·차감 계산 금지(존재 신호로만).
    """
    domain: str
    status: str  # present | noData — 데이터 존재 여부(품질 양호 의미 아님, codex #12)
    attempts: int
    reported: int              # worker_result 이벤트 존재(텔레메트리 분자)
    invalid: int               # 부모가 전달 실패 관측(워커 자기보고 ok 여도 invalid 우선)
    missing: int               # started 만 남긴 행방불명
    soloAttempts: int          # started 없는 워커 이벤트 — 레거시/수동 구동, coverage 캐비앗(codex #4)
    accounted: int
    silent: int
    zeroSignal: int            # seen=0 — 깨끗함이 아니라 '후보 신호 없음'
    unknownLedger: int         # candidates 미상(크래시/legacy/미계측/해명 미상)
    degradedOk: int            # ok 로 위장된 침묵(enforced) — 최우선 관전 지표
    failedSilent: int
    enforcementDisabled: int   # kill-switch 로 ledger 꺼진 attempt
    rawCandidateSignals: int
    rawCandidatesAccounted: int
    telemetryCoverage: float | None = None  # reported/attempts — 레거시 미계측 실행은 분모 밖(soloAttempts 참조)
    lastObservedAt: float | None = None
    byWorkerType: dict[str, int]
    byExecutionState: dict[str, int]  # 2축 중 execution 축 전체 분포 — silent 아니어도 실패가 소실되지 않게(codex #2)


class QualityCandidates(BaseModel):
    """GET /gw/quality/candidates — 4도메인 candidate 침묵 read-model (#1 눈)."""
    scope: str = "candidate_quality"
    asOf: float
    windowDays: int
    policyVersion: str
    metricsVersion: int
    unclassifiedRows: int      # 도메인 어휘 밖 행 수 — 숨기면 fail-open 이라 카운트로 노출
    truncated: bool            # hard limit 절단 여부 — 조용한 절단 금지
    domains: list[QualityDomainReport]
    recentSilent: list[QualitySilentAttempt]


from .domains import REPORT_THREAD_TERMINAL

# ── 리포트 상세 · 파이프라인 상태 (contracts/src/report.ts 미러) ──────────────
#
# ⚠️ 이 블록은 `contracts/src/report.ts` 와 **쌍**이다. 한쪽만 고치면 런타임 검증이 없어
#    조용히 어긋난다 — 필드 추가/삭제/개명은 반드시 양쪽 동시에.
#
# 경계(gateway.ts 와 동일 규율):
#  · 본문 원문(report_html/report_json)은 **여기 없다**. egress `_redact` 이전 값이라 실제
#    나간 메일보다 덜 가려져 있다 — 보유 여부·크기만 계약하고 표시는 별도 슬라이스.
#  · 되묻기 키는 srcKey(불투명 해시). src 는 표시용 마스킹 라벨이라 필터로 쓰면 남의 것이 섞인다.

#: 4도메인 status 어휘의 합집합을 뜻 기준으로 접은 정규 단계. 생애주기 순.
REPORT_STAGES: tuple[str, ...] = (
    "draft", "report_built", "notified", "awaiting_owner", "reply_received",
    "recheck_requested", "rechecking", "still_open", "partially_remediated",
    "remediated", "exception_review", "owner_update_needed",
    "owner_reassignment_review", "reassigned", "escalated", "closed", "error",
    # ★ "모르는 상태" 와 "워커 실패" 는 다른 뜻이다. error 로 접으면 운영자가 오독한다
    #    (quality 계약의 noData≠clean 과 같은 규율).
    "unknown",
)

#: 상위 그룹 — 목록 화면 필터 칩 축. 접기는 **게이트웨이가 한다**(UI 가 서버 문자열로 맵을
#: 인덱싱하면 프로토타입 체인이 열리고, 매핑 누락이 undefined 로 조용히 사라진다).
REPORT_STAGE_GROUPS: tuple[str, ...] = (
    "prepare", "notified", "waiting", "recheck", "closed", "error",
    # ★ stage 축에서 갈라 놓고 group 축에서 합치면 구분이 무너진다 — 그리고 group 이 곧 필터 칩,
    #   운영자가 실제로 클릭하는 면이다.
    "unknown",
)
STAGE_TO_GROUP: dict[str, str] = {
    "draft": "prepare", "report_built": "prepare",
    "notified": "notified", "reassigned": "notified",
    "awaiting_owner": "waiting", "reply_received": "waiting",
    "owner_update_needed": "waiting", "owner_reassignment_review": "waiting",
    "recheck_requested": "recheck", "rechecking": "recheck",
    "still_open": "recheck", "partially_remediated": "recheck",
    "remediated": "closed", "closed": "closed",
    "escalated": "closed", "exception_review": "closed",
    "error": "error", "unknown": "unknown",
}


def group_for(stage: str) -> str:
    """stage → 상위 그룹. 미지의 stage 는 `unknown` 그룹.

    ⚠️ 폴백을 `error` 로 두면 안 된다 — "우리가 모르는 것" 이 "워커가 실패함" 으로 보인다.
    stage 축에서 지킨 구분을 group 축이 되돌리면 필터 칩에서 둘이 섞인다."""
    return STAGE_TO_GROUP.get(str(stage or ""), "unknown")

#: 도메인별 native status → 정규 stage. 엔진 state_domain 의 status 집합 **전부**가 있어야
#: 한다 — 빠지면 그 스레드가 화면에서 조용히 사라진다.
_COMMON_STAGES = {
    "draft": "draft",
    "reported": "notified",
    "partially_remediated": "partially_remediated",
    "remediated": "remediated",
    "exception_review": "exception_review",
    "owner_update_needed": "owner_update_needed",
    "owner_reassignment_review": "owner_reassignment_review",
    "reassigned": "reassigned",
    "escalated": "escalated",
    "closed": "closed",
}
#: github·confluence 계열 전용.
_THREAD_STAGES = {
    **_COMMON_STAGES,
    "report_ready": "report_built",
    "awaiting_owner": "awaiting_owner",
    "recheck_requested": "recheck_requested",
    "rechecking": "rechecking",
    "still_open": "still_open",
    "error": "error",
}
#: smb·dev_web 계열 전용 — 같은 생애주기를 다르게 부른다.
_MAIL_STAGES = {
    **_COMMON_STAGES,
    # ★ 2026-08-31: 최초 발송 게이트가 **여기에 스레드를 세운다** — 본문은 만들었고
    #   발송만 안 한 자리다. 이 줄이 없어서 그 스레드가 stage `unknown` 으로 빠졌다.
    #   위 주석("엔진 status 집합 전부가 있어야 한다")이 약속한 것을 지키는 테스트가
    #   실제로는 없었다(`test_report_contract_mirror` 는 TS↔Py 만 본다).
    "report_ready": "report_built",
    "awaiting_reply": "awaiting_owner",
    "reply_received": "reply_received",
    "reverifying": "rechecking",
    "re_requested": "recheck_requested",
}
STATUS_TO_STAGE: dict[str, dict[str, str]] = {
    "github": dict(_THREAD_STAGES),
    "confluence": dict(_THREAD_STAGES),
    "smb": dict(_MAIL_STAGES),
    "dev_web": dict(_MAIL_STAGES),
}

#: 종결 단계 — "처리 중" 은 이 여집합으로 도출한다(손나열 금지).
#
# ★ SSOT 는 `domains.REPORT_THREAD_TERMINAL`(status 축)이고 여기서 **도출**한다. 손나열하면
#   `/gw/stats.closedThreads`·`/gw/sources?threadState=closed` 와 어긋나 **같은 스레드가 화면
#   A 에선 종결, B 에선 진행 중**으로 보인다. `resolved`/`false_positive` 는 어느 도메인
#   어휘에도 없어 stage 로 안 접히고 자연히 빠진다.
# ⚠️ `partially_remediated` 는 여기 없다 — 일부 조치를 완료로 세면 안 된다.
_ANY_STATUS_STAGES: dict[str, str] = {**_THREAD_STAGES, **_MAIL_STAGES}
REPORT_TERMINAL_STAGES: frozenset[str] = frozenset(
    st for st in (_ANY_STATUS_STAGES.get(s) for s in REPORT_THREAD_TERMINAL) if st
)


def stage_for(domain: str, native_status: str | None) -> str:
    """native status → 정규 stage. 미지의 값은 삼키지 않고 'error' 로 드러낸다.

    ⚠️ 조용히 버리면 그 스레드가 화면에서 사라진다. 어휘가 늘면 테스트가 먼저 깨지게 두고,
    런타임은 보이는 쪽으로 실패한다. `unknown`("우리가 모르는 상태") 과 `error`("워커가 실패함")
    는 다른 뜻이라 섞지 않는다."""
    table = STATUS_TO_STAGE.get(domain) or {}
    return table.get(str(native_status or ""), "unknown")


class ReportBodyMeta(BaseModel):
    """보고서 본문 **메타데이터** — 이 모델은 본문을 담지 않는다.

    본문 자체는 `GET /gw/reports/{key}/{thread_id}/body` → `MailBody` 가 낸다(2026-08-25).
    거기서 읽기 시점 재마스킹을 건다.

    redaction='pre_egress': 저장값은 워커가 deliver 에 넘긴 payload 라 egress redact 전이다.
    access: **"본문 없음" 과 "권한 없음" 은 다른 뜻**이다 — smb 본문은 mail_message 에 있는데
    게이트웨이 롤(digisecu_gw_ro)에 부여돼 있지 않다(42501). 없는 게 아니라 못 읽는 것이다."""
    access: str = "ok"          # ok | denied | unavailable
    hasHtml: bool = False
    hasJson: bool = False
    htmlBytes: int | None = None
    redaction: str = "pre_egress"


class ReportDomainRef(BaseModel):
    """도메인 고유 좌표 — 정규 필드로 접히지 않는 것만. 컬럼이 없는 도메인은 항상 null."""
    shareId: int | None = None      # smb
    host: str | None = None         # smb (마스킹 라벨)
    repo: str | None = None         # github
    spaceKey: str | None = None     # confluence
    targetId: int | None = None     # dev_web
    url: str | None = None          # dev_web (마스킹 라벨)


class ReportThreadDetail(BaseModel):
    """GET /gw/reports/{domain}/{thread_id} — 리포트 스레드 1건 상세.

    목록(ReportThreadItem)의 상위집합이 아니라 **별개 표현**이다. 목록은 /reports·티켓 상세가
    쓰고 있어 대체하지 않는다."""
    domain: str
    id: int
    stage: str                      # 정규 단계 — 화면은 이걸로 그린다
    nativeStatus: str               # 엔진 원본 — 접기만 하고 버리지 않는다(로그 대조용)
    severity: str | None = None
    subjectTag: str
    src: str | None = None          # 표시용 마스킹 라벨 (되묻기에 쓰지 말 것)
    srcKey: str                     # 되묻기 키 (sha256 앞 16자)
    findingId: int | None = None
    findingCount: int = 1
    findingSummary: str | None = None
    recipient: str | None = None
    ownerRecipient: str | None = None
    deliveryTarget: str | None = None
    createdAt: float | None = None
    updatedAt: float | None = None
    firstReportedAt: float | None = None
    notifiedAt: float | None = None
    attemptCount: int | None = None
    cycleKeys: list[str] = []
    firstCycleKey: str | None = None
    lastCycleKey: str | None = None
    lastReason: str | None = None
    recurrenceCount: int | None = None   # smb 전용 — 나머지는 항상 null
    lastErrorKind: str | None = None     # smb 전용
    body: ReportBodyMeta
    domainRef: ReportDomainRef


class PipelineComponentRun(BaseModel):
    """pipeline_run 투영 — 구성요소 1개의 마지막 실행.

    ★ staleSeconds 가 이 모델을 만든 이유다. 보고·재확인 파이프라인이 6주 넘게 멈춰 있어도
      지금은 화면 어디에도 안 나온다."""
    component: str
    lastRunAt: float | None = None       # pipeline_run.started_at 최댓값
    lastFinishedAt: float | None = None
    lastStatus: str | None = None
    runCount: int = 0
    # ⚠️ /gw/runtime/presence 의 heartbeat staleness 와 **다른 축**이다. heartbeat 은
    # "프로세스가 신호를 보내는가", 이건 "그 컴포넌트가 실제로 일한 게 언제인가" 다.
    sinceLastRunSeconds: float | None = None   # None = 한 번도 안 돎


class PipelineOverview(BaseModel):
    """GET /gw/pipeline/{domain} — 단계별 적체 + 구성요소 실행 이력."""
    domain: str
    stageCounts: dict[str, int] = {}
    groupCounts: dict[str, int] = {}     # 접기는 게이트웨이가 한다(UI 가 다시 접지 않게)
    components: list[PipelineComponentRun] = []
    threadTotal: int = 0


class SyncCounters(BaseModel):
    """보고 sync 의 단계별 카운터. **없는 키는 None** — 0 과 다르다.

    0 은 "그 단계에서 아무것도 안 걸렸다", None 은 "그 실행이 이 값을 안 냈다" 다.
    도메인마다 내는 카운터가 다르고(예: reposSeen 은 github 만), 코드가 바뀌면 늘거나 준다.
    """
    seen: int | None = None                  # 이번 패스가 훑은 finding 수
    reposSeen: int | None = None             # 묶인 저장소 수(github — 통보 단위가 저장소다)
    created: int | None = None               # 새 스레드(원본 키 `new`)
    merged: int | None = None
    recurred: int | None = None              # 이전 주차에 있던 것이 이번 주차로 되살아남
    dup: int | None = None
    skippedUnverified: int | None = None     # agent_verification 게이트에서 탈락
    skippedUnknownScope: int | None = None   # 대상 파싱 실패로 탈락
    ownerFound: int | None = None
    ownerFromRepo: int | None = None         # 저장소 담당자 폴백으로 채워진 수
    ownerMissing: int | None = None


class SyncReport(BaseModel):
    """도메인 1개의 가장 최근 보고 패스.

    ★ `parsed=False` 는 "카운터를 못 읽었다" 이지 "0 이었다" 가 아니다. detail 이 JSON 이
    아니라 `str(dict)` 라 파싱이 깨질 수 있고, 그때 0 을 내면 조용한 거짓말이 된다.
    """
    domain: str
    #: sync | report_only | absent — 이 도메인이 보고 단계에서 **무엇을 남기는가**.
    #: `parsed=False` 와 뜻이 다르다: absent 는 "그 단계가 없다", parsed=False 는 "못 읽었다".
    stage: str = "sync"
    #: 마지막 **확인**(빈 tick 포함) — 파이프라인이 도는가.
    at: float | None = None
    #: 마지막으로 **일한** 실행. 보고 컴포넌트는 30초마다 돌고 96%가 빈 tick 이라
    #: `at` 의 카운터를 실으면 화면이 항상 0 이 된다. absent 도메인은 티켓 생성 시각.
    lastWorkAt: float | None = None
    #: absent 도메인(보고 패스 없음)이 대신 내는 값 — 제출 시점에 만든 티켓 수.
    tickets: int | None = None
    status: str | None = None
    parsed: bool = False
    counters: SyncCounters | None = None
    handled: int | None = None
    reports: int | None = None
    sent: int | None = None
    dryRun: int | None = None
    errors: int | None = None


class SyncList(BaseModel):
    """4도메인 전부 나온다(2026-08-29 사용자 결정).

    도메인마다 보고 단계에서 남기는 것이 다르다 — `SyncReport.stage` 가 그것을 말한다.
    옛 주석의 경고("없는 도메인을 넣고 '못 읽음' 으로 그리면 안 된다")는 그대로 유효하다.
    그래서 넣되 `parsed` 가 아니라 `stage` 로 가른다: smb 는 `absent`(단계 없음),
    dev_web 은 `report_only`(sync 는 없고 결과만), github·confluence 는 `sync`.
    """
    asOf: float
    items: list[SyncReport]


# ── SMB 노출 표면(공유 → 디렉터리) ────────────────────────────────────────────
# 발견 목록은 "무엇이 걸렸나", 이건 "어디까지 열려 있나" 다. finding 이 없는 폴더도
# 읽기 가능하면 노출 표면이다.
# ⚠️ 경로는 **마스킹하지 않는다**(사용자 결정 2026-08-25) — 같은 값을 :8767 이 이미
#    같은 ACL 안에서 원문으로 보여준다. 두 화면이 다른 값을 보이는 쪽이 더 나쁘다.
# ⚠️ `smb_share.summary`·`listing_review` 는 **투영하지 않는다** — 자유 텍스트라 무엇이
#    들어 있는지 계약으로 말할 수 없다. 여는 것은 구조(경로·권한 플래그)뿐이다.

class SmbDirectory(BaseModel):
    path: str
    depth: int = 0
    # ★ 셋 다 nullable. 0/1 뿐 아니라 NULL 이 온다 — "안 됨" 과 "모름" 은 다르다.
    listable: bool | None = None
    readable: bool | None = None
    writable: bool | None = None
    error: str | None = None
    lastSeen: float | None = None


class SmbShare(BaseModel):
    share: str
    status: str | None = None
    severity: str | None = None
    shareRead: bool | None = None
    shareWrite: bool | None = None
    #: 인증 없이 붙었는가. null/guest 가 True 면 그 공유는 사실상 공개다.
    nullLogin: bool | None = None
    guestLogin: bool | None = None
    authLogin: bool | None = None
    #: 워커가 센 파일 수(`walk_file_count`). 파일 **목록**은 안 준다 — 2백만 행이고
    #: 파일 단위 증거는 `/gw/findings/{id}` 의 hits[].location 이 답한다.
    fileCount: int | None = None
    walkDoneAt: float | None = None
    lastSeen: float | None = None
    cycleKey: str | None = None
    #: 이 공유의 **전체** 디렉터리 수. `len(directories)` 와 다르면 잘린 것이다.
    directoryTotal: int = 0
    directories: list[SmbDirectory] = []


class SmbTree(BaseModel):
    """한 호스트의 노출 표면.

    access: "ok" = 읽음 · "denied" = `smb_directory` 미부여(sql/006 미적용).
    ★ denied 를 "디렉터리 없음" 으로 그리면 거짓말이다 — 화면이 반드시 구분해야 한다.
    """
    srcKey: str
    host: str | None = None
    access: str = "ok"
    shares: list[SmbShare] = []
    #: 서버가 센 전체 개수. 목록 길이로 세지 않는다.
    directoryTotal: int = 0
    directoriesTruncated: bool = False
    sharesTruncated: bool = False


class MailBody(BaseModel):
    """발송 **요청** 본문(읽기 시점 재마스킹).

    ★ "발송본" 이 아니다. 저장값은 `deliver()` 호출 전 payload 라 egress redact 이전이고,
      실제로 나간 본문은 DB 어디에도 없다. 여기서 `redact()` 를 다시 걸어 내보내므로
      화면에 보이는 것은 실제 나간 메일보다 **더** 가려진 값이다.
    access: ok | denied(GRANT 미적용) | unavailable(모르는 도메인).
      ⚠️ `access="denied"` 와 `hasBody=False` 는 **다른 뜻**이다 — 못 읽은 것과 없는 것.
    """
    domain: str
    threadId: int
    access: str = "ok"
    hasBody: bool = False
    subject: str | None = None
    mailTo: str | None = None
    mailCc: str | None = None
    sentAt: float | None = None
    #: 본문이 HTML 인가(아니면 JSON/평문). 화면은 HTML 만 sandbox iframe 으로 그린다.
    isHtml: bool = False
    body: str | None = None
    truncated: bool = False
    #: 이 본문이 실제로 나간 것인가. "sent" | "draft" | "unknown"
    #: ★ 2026-08-27 부터 smb 는 **안 나간 본문도** 남긴다(그전엔 sent 일 때만 남겨
    #:   mail_message 가 0행이었다). 초안을 "발송됨" 으로 그리면 1,639 대 1 과 같은
    #:   종류의 거짓말이 된다 — 화면이 둘을 구분할 근거를 여기서 준다.
    #: ⚠️ github·confluence·dev_web 은 리포트 생성 시점 본문이라 발송 여부를 이 값으로
    #:   판정할 수 없다 → "unknown". 발송 판정은 `SourceItem.deliveryEvidence` 축이다.
    state: str = "unknown"
    #: 초안이 왜 안 나갔는지(게이트 사유). draft 일 때만 채워진다.
    stateDetail: str | None = None
