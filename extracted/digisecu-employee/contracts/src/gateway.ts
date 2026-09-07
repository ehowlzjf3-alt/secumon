/**
 * M4 state_domain read 게이트웨이 응답 계약 (SSOT).
 *
 * 게이트웨이(별도 Python 서비스, threat_hunter read-only)가 3축을 공급한다:
 *  - 업무/큐(QueueDepth), finding[마스킹](GatewayFinding), 워크스페이스 payload(WorkspacePayload).
 * control-plane(digisecu_control)은 state_domain 미접근 — web은 이 계약을 control-plane 아닌
 * 게이트웨이(`/gw`)에 요청한다.
 *
 * 이름공간(codex/조사): UI 위임 엔티티(delegatedTask)와 구분해, 엔진 실행 큐는 **queueDepth/runtimeQueueItem**로
 * 표면화한다. 게이트웨이는 persona가 아닌 (agentType=domain, stage) 키로 질의한다(runtime-mapping 불변식).
 * 마스킹: summary는 저장시점 봉인값. 원문(extra_json)·evidence 경로·finding_index는 계약에 없다.
 */
import { z } from "zod";
import { EmployeeDomain } from "./roster";

/**
 * finding 상세 마스킹 증거 hit. **단건 엔드포인트(/gw/findings/{id})에서만** 채워진다.
 * 원문이 아니라 detector(scan_text) 마스킹 + 게이트웨이 read 경계 재마스킹(masking.redact)을 거친
 * ±컨텍스트 preview다. extra_json.masked_hits 의 화이트리스트 키만 투영(note·경로 등은 미노출).
 */
export const MaskedHit = z.object({
  category: z.string(), // secret | secret_heuristic | pii
  kind: z.string(), // 탐지 규칙명(generic_password_assignment, private_key_block 등)
  lineNo: z.number().int().nullable().optional(),
  preview: z.string(), // 마스킹된 line preview(원문/시크릿 원값 복원 불가)
});
export type MaskedHit = z.infer<typeof MaskedHit>;

/** finding 데이터 분류(고정 어휘). key=엔진 category, label=한국어. extra_json.hits[].category 도출. */
export const FindingCategory = z.object({ key: z.string(), label: z.string() });
export type FindingCategory = z.infer<typeof FindingCategory>;

/** finding_lifecycle 마스킹 projection. 원문 컬럼 미포함. */
export const GatewayFinding = z.object({
  id: z.number().int(),
  taskType: z.string(), // 엔진 task_type(=도메인). finding에는 4도메인 외 값도 가능 → string.
  asset: z.string(),
  assetKind: z.string(),
  severity: z.string(),
  summary: z.string(), // 저장시점 마스킹 봉인됨
  status: z.string(),
  owner: z.string().nullable().optional(), // 엔진 finding_lifecycle.owner(미사용) — 담당자는 detail.assignee
  ticketRef: z.string().nullable().optional(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  seenCount: z.number().int(),
  hasEvidence: z.boolean(), // evidence_ref 존재 여부만(경로 미노출)
  // 데이터 분류(리스트/payload/detail). category=대표(없으면 미분류), categories=전체(우선순위 내림차순).
  category: FindingCategory,
  categories: z.array(FindingCategory).default([]),
  maskedHits: z.array(MaskedHit).nullable().optional(), // DEPRECATED(항상 null) — 상세 증거는 detail.hits
});
export type GatewayFinding = z.infer<typeof GatewayFinding>;

export const FindingList = z.object({
  total: z.number().int(),
  items: z.array(GatewayFinding),
});
export type FindingList = z.infer<typeof FindingList>;

// ── 단건 finding 상세 리치 필드(codex 적대검증 반영) ─────────────────────────────
// 전부 상세 엔드포인트(/gw/findings/{id})에서만 채워진다(리스트/payload=null). 모든 free-text 는
// 게이트웨이 경계 redact()(마스킹→절단)를 통과했고, 구조필드(status/int/bool)는 엄격 검증됐다.
// 화이트리스트 투영 — 미지의 extra_json 키는 절대 노출되지 않는다. 구 maskedHits 는 deprecated(항상 null).

/** 이 hit 의 크리덴셜로 **실제 로그인 1회**를 시도한 결과(extra_json.hits[].validation.login_probe).
 * "평문 노출"과 "악용 가능(확인됨)"을 가르는 사실. 게이트웨이가 고정 어휘 allowlist + 엄격검증으로
 * 투영한 값만 온다 — result/engine 은 어휘 밖이면 객체 자체가 드롭되고, endpoint 는 IP/FQDN+포트를
 * 재조립한 값이며, principalMasked 는 마스킹 표식이 있는 값만 통과한다.
 * 프로브의 auth_attempts/credential_fields/bound_masked 는 **절대 오지 않는다**(평문 계정·부분마스킹
 * 비밀번호 보유). 안전정책 문구는 서버 값이 아니라 UI 고정 문구로 렌더한다. */
export const HitLoginValidation = z.object({
  result: z.string(), // authenticated|auth_failed|account_locked|credential_expired|session_denied
  provesValidity: z.boolean().default(false), // 크리덴셜 생존 증명(authenticated 만 '악용 가능')
  engine: z.string().nullable().optional(), // mssql|postgres
  endpoint: z.string().nullable().optional(), // host:port(IPv6 는 [addr]:port)
  principalMasked: z.string().nullable().optional(), // 마스킹된 계정 — 원본 아님
  singleAttempt: z.boolean().default(false), // 단발 시도(재시도·쿼리 없음)
  elapsedMs: z.number().int().nullable().optional(),
});
export type HitLoginValidation = z.infer<typeof HitLoginValidation>;

/** 증거 hit(마스킹). preview 는 detector 마스킹 + 게이트웨이 경계 재마스킹 — 원값 복원 불가. */
export const DetailHit = z.object({
  category: z.string(),
  kind: z.string(), // 탐지 규칙명(generic_password_assignment 등)
  lineNo: z.number().int().nullable().optional(),
  location: z.string().nullable().optional(), // 발견 위치(URL/파일경로), 마스킹됨
  preview: z.string(), // 증거 본문 미리보기(마스킹)
  loginValidation: HitLoginValidation.nullable().optional(), // 로그인 검증 증거(있을 때만)
});
export type DetailHit = z.infer<typeof DetailHit>;

/** 4부 위험내용(agent 작성, 값 아닌 유형 서술 + 경계 재마스킹). 없는 항목은 null. */
export const RiskNarrative = z.object({
  whatIsData: z.string().nullable().optional(),
  howDiscovered: z.string().nullable().optional(),
  exploitationPath: z.string().nullable().optional(),
  verificationMethod: z.string().nullable().optional(),
});
export type RiskNarrative = z.infer<typeof RiskNarrative>;

/** 한 증거 위치 해설. sensitiveFields=필드명/유형(값 아님, 그래도 방어 재마스킹). */
export const EvidenceNote = z.object({
  location: z.string(),
  whatThisIs: z.string().nullable().optional(),
  sensitiveFields: z.array(z.string()),
  contextNote: z.string().nullable().optional(),
});
export type EvidenceNote = z.infer<typeof EvidenceNote>;

/** pivot 후보 URL 도달 probe. url 은 scheme+host+path 만(userinfo/query/fragment 제거·비클릭). */
export const PivotProbe = z.object({
  url: z.string(),
  status: z.string(), // HTTP status 숫자문자열 or '000'
  exposed: z.boolean(),
  contentType: z.string().nullable().optional(),
  evidenceMasked: z.string().nullable().optional(), // 응답 본문 샘플(마스킹)
});
export type PivotProbe = z.infer<typeof PivotProbe>;

/** 측면이동(pivot) 요약 — 이 finding 이 도달 가능케 한 내부 표면. */
export const PivotSummary = z.object({
  exposedCount: z.number().int(),
  probes: z.array(PivotProbe),
});
export type PivotSummary = z.infer<typeof PivotSummary>;

/** 검증 상태 — github: live_in_HEAD/historical_only 등. */
export const Verification = z.object({
  status: z.string().nullable().optional(),
  method: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
});
export type Verification = z.infer<typeof Verification>;

/** 도메인 메타(화이트리스트 키만). github: repo/path/source(worktree|history)/commit. */
export const FindingMetadata = z.object({
  repo: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  commit: z.string().nullable().optional(),
  scanMethod: z.string().nullable().optional(),
});
export type FindingMetadata = z.infer<typeof FindingMetadata>;

/** finding 담당자(매칭 결과 · **표시 전용, 발송 아님**). base owner(엔진 컬럼)와 구분해 assignee 로.
 * status: resolved | unresolved(매칭 시도했으나 없음) | dssoc_only(개별 담당자 개념 없음). */
export const Assignee = z.object({
  status: z.string(),
  name: z.string().nullable().optional(),
  dept: z.string().nullable().optional(),
  /** 직급(knox 대장). 사번은 투영하지 않는다 — 화면에 쓸 데가 없고 식별력은 이름보다 강하다. */
  title: z.string().nullable().optional(),
  email: z.string().nullable().optional(), // 검증된 사내 메일박스 1개(발송 아님)
  sourceLabel: z.string().nullable().optional(), // "저장소 소유자"·"커밋 작성자" 등 고정 라벨
  ambiguous: z.boolean().default(false),
  /**
   * false = **추정**. 조직 저장소는 GHES 에 담당자 개념이 없어(collaborators 404 ·
   * CODEOWNERS 부재 · org members 가 전원 admin) 1위 기여자로 대신한다.
   * 확정과 같은 칸에 넣으면 추정이 확정으로 위장하므로 화면이 반드시 구분해야 한다.
   */
  confirmed: z.boolean().default(true),
});
export type Assignee = z.infer<typeof Assignee>;

/** 단건 상세 = GatewayFinding + extra_json 리치필드 투영. 상세 증거는 maskedHits 아닌 hits 를 쓴다. */
export const GatewayFindingDetail = GatewayFinding.extend({
  assignee: Assignee.nullable().optional(), // 매칭된 담당자(표시 전용)
  hits: z.array(DetailHit).nullable().optional(),
  riskNarrative: RiskNarrative.nullable().optional(),
  recommendedActions: z.array(z.string()).nullable().optional(),
  pivotInterpretation: z.string().nullable().optional(),
  evidenceNotes: z.array(EvidenceNote).nullable().optional(),
  pivot: PivotSummary.nullable().optional(),
  verification: Verification.nullable().optional(),
  metadata: FindingMetadata.nullable().optional(),
  confidence: z.number().nullable().optional(),
  target: z.string().nullable().optional(),
  assetCountScanned: z.number().int().nullable().optional(),
  // hits 중 하나라도 로그인 검증(authenticated)을 가지면 true — 상세를 펼치지 않고도 헤더에서
  // '악용 가능 확인'을 알리기 위한 파생 플래그(투영된 hits 에서만 계산됨).
  loginValidated: z.boolean().default(false),
});
export type GatewayFindingDetail = z.infer<typeof GatewayFindingDetail>;

/** (agentType=domain) 파이프라인 스테이지별 대기 깊이. strategy=수집(collector 소스 대기). */
export const QueueDepth = z.object({
  agentType: EmployeeDomain,
  strategy: z.number().int(), // 수집 소스 대기(smb=subnet·dev_web=web도메인). 롤링수집(github/confluence)=0
  task: z.number().int(),
  report: z.number().int(),
  verify: z.number().int(),
});
export type QueueDepth = z.infer<typeof QueueDepth>;

export const QueueDepthList = z.object({
  items: z.array(QueueDepth),
});
export type QueueDepthList = z.infer<typeof QueueDepthList>;

/** 리포트 스레드 진행상태 ⨝ finding 마스킹 summary(dangling finding_id 시 null). */
export const ReportThreadItem = z.object({
  id: z.number().int(),
  status: z.string(),
  severity: z.string().nullable().optional(),
  subjectTag: z.string(),
  label: z.string(), // 도메인 식별(host/domain/repo/space_key)
  findingId: z.number().int().nullable().optional(),
  findingSummary: z.string().nullable().optional(), // 마스킹됨
  updatedAt: z.number().nullable().optional(),
  ownerRecipient: z.string().nullable().optional(),  // 담당자 메일(검증됨, dssoc 제외) — 사내 사이트라 목록 노출 허용
  deliveryTarget: z.string().nullable().optional(),  // 발송대상 고정라벨("DSSOC"/"담당자 개별", 담당자 아님)
  findingCount: z.number().int().default(1),         // finding_id ∪ finding_ids 중복제거 수
  /**
   * ★ null 의 뜻이 deliveryEvidence 에 달려 있다.
   *   "timestamp"   → 컬럼이 있는데 비었다 = **안 나갔다**(사실)
   *   "status_only" → 컬럼 자체가 없다   = **알 수 없다**
   * 이 구분이 없으면 화면이 smb 를 "전부 미발송" 으로 단정한다.
   */
  notifiedAt: z.number().nullable().optional(),
  /** 발송 판정 근거. github·confluence = "timestamp", smb·dev_web = "status_only". */
  deliveryEvidence: z.string().default("status_only"),
  // ── 발송 이력. 값은 이미 DB 에 다 있었고 게이트웨이가 투영을 안 했을 뿐이다. ──
  // firstReportedAt~updatedAt 사이가 곧 "이 건이 밀린 기간".
  firstReportedAt: z.number().nullable().optional(),
  attemptCount: z.number().int().nullable().optional(),  // 재시도 횟수
  cycleKeys: z.array(z.string()).default([]),            // 발송이 걸친 주차들(["2026-W27",...])
  lastReason: z.string().nullable().optional(),          // free-text — 게이트웨이에서 redact 됨
  // ⚠️ smb(mail_thread) 전용 — 나머지 3종엔 컬럼 자체가 없어 항상 null 이다.
  recurrenceCount: z.number().int().nullable().optional(),
  lastErrorKind: z.string().nullable().optional(),
});
export type ReportThreadItem = z.infer<typeof ReportThreadItem>;

/** 대상(src) 1건 — 티켓의 단위.
 *
 * finding 은 파일/URL 하나하나지만 사람이 조치하는 단위는 그것이 **속한 곳**이다(IP·저장소·
 * 웹도메인·스페이스). 도메인 밀도가 1,980:1 이라 finding 건수로는 4열이 무너지고, src 로 세면
 * 640/231/91/9 라 균형이 맞는다.
 *
 * ⚠️ `src` 는 표시용 마스킹 라벨, 되묻기 키는 `srcKey`(불투명 해시). 라벨로 필터하면 마스킹
 * 충돌 때문에 남의 것이 섞인다 — 필터는 반드시 srcKey 로. `src=null` 은 파싱 실패(=미상)다. */
export const SourceItem = z.object({
  domain: z.string(),
  srcKind: z.string(),                                   // host | repo | domain | space
  src: z.string().nullable().optional(),                 // 마스킹 라벨. null = 미상
  srcKey: z.string(),                                    // /gw/findings?srcKey= 로 되묻는 키
  findings: z.number().int(),
  openFindings: z.number().int(),
  critical: z.number().int(),
  high: z.number().int(),
  /** 이 대상 발견들의 데이터 분류. 대표(없으면 null=미분류) + 전체(우선순위 내림차순).
   *  finding 상세와 같은 taxonomy 산출물이라 화면 간 어휘가 갈리지 않는다. */
  category: FindingCategory.nullable().optional(),
  categories: z.array(FindingCategory).default([]),
  firstSeen: z.number().nullable().optional(),
  lastSeen: z.number().nullable().optional(),
  threads: z.number().int().default(0),
  threadStatus: z.string().nullable().optional(),
  /**
   * 가장 최근 스레드의 id — 본문을 되묻는 키다(`/gw/reports/{domain}/{threadId}/body`).
   *
   * ⚠️ 한 대상에 스레드가 여럿이다(smb 230호스트 / 509스레드 — 주차마다 새로 열린다).
   *    이건 "이 티켓의 본문" 이 아니라 **가장 최근 본문**이다. 화면이 그렇게 말해야 한다.
   */
  threadId: z.number().int().nullable().optional(),
  /**
   * 메일 제목에 실제로 나가는 티켓 번호(`SMB00024`·`GH00137`·`CF00019`·`DW00045`).
   * 담당자가 이 번호로 문의하면 운영자가 목록 검색창에 그대로 붙여넣어 찾는다
   * (게이트웨이가 `q` 를 티켓 번호로도 해석한다).
   * ⚠️ `threadId` 와 마찬가지로 **가장 최근 스레드**의 번호다.
   */
  ticketNo: z.string().nullable().optional(),
  /**
   * ★ null 의 뜻이 deliveryEvidence 에 달려 있다.
   *   "timestamp"   → 컬럼이 있는데 비었다 = **안 나갔다**(사실)
   *   "status_only" → 컬럼 자체가 없다   = **알 수 없다**
   * 이 구분이 없으면 화면이 smb 를 "전부 미발송" 으로 단정한다.
   */
  notifiedAt: z.number().nullable().optional(),
  /** 발송 판정 근거. github·confluence = "timestamp", smb·dev_web = "status_only". */
  deliveryEvidence: z.string().default("status_only"),
  lastActivityAt: z.number().nullable().optional(),
  firstReportedAt: z.number().nullable().optional(),
  attemptCount: z.number().int().nullable().optional(),
  deliveryTarget: z.string().nullable().optional(),
  assignee: Assignee.nullable().optional(),
});
export type SourceItem = z.infer<typeof SourceItem>;

/** 대상 목록. `ownerLookup="denied"` 면 담당자를 **못 읽은 것**이지 없는 게 아니다 —
 * UI 는 '담당자 없음' 대신 '권한 없음' 을 보여야 한다(asset_owner 는 sql/004 로 GRANT). */
export const SourceList = z.object({
  total: z.number().int(),
  items: z.array(SourceItem),
  ownerLookup: z.enum(["ok", "denied"]).default("ok"),
  asOf: z.number().nullable().optional(),
});
export type SourceList = z.infer<typeof SourceList>;

/** 도메인 1개의 발생·조치 현황.
 *
 * ⚠️ `remediated` 의 근거가 도메인마다 다르다 — `remediationBasis` 로 무엇을 세었는지 밝힌다.
 *  - verification_gone: 재스캔에서 사라진 finding(github/confluence)
 *  - reverify_now_closed: 재검증 판정이 now_closed(smb)
 *  - none: 근거 테이블을 못 읽음 → remediationLookup="denied" 와 함께 온다 */
export const DomainStats = z.object({
  domain: z.string(),
  sources: z.number().int(),
  unparsedFindings: z.number().int().default(0),
  findings: z.number().int(),
  openFindings: z.number().int(),
  falsePositive: z.number().int(),
  critical: z.number().int(),
  high: z.number().int(),
  weekNew: z.number().int(),
  weekRemediated: z.number().int(),
  remediated: z.number().int(),
  remediationBasis: z.enum(["verification_gone", "reverify_now_closed", "none"]),
  remediationLookup: z.enum(["ok", "denied"]).default("ok"),
  threads: z.number().int().default(0),
  /** ⚠️ 예전 이름 notifiedSources — 세는 것은 "스레드가 하나라도 있는 대상" 이지 통보 여부가 아니었다. */
  sourcesWithThread: z.number().int().default(0),
  sourcesWithoutThread: z.number().int().default(0),
  /**
   * 발송이 **사실로 확인된** 대상. 근거 없는 도메인(smb·dev_web)은 null.
   * ★ 0 으로 내리면 "한 통도 안 나갔다" 는 거짓 주장이 된다 — 모르는 것은 모른다고 낸다.
   * ⚠️ 모수가 /gw/sources 목록과 다를 수 있다 — 이 셋은 스레드에서, 목록은 finding 에서 온다.
   *    finding 이 정리됐는데 스레드만 남은 대상이 실제로 있다(버그 아님, 모수 차이).
   */
  sourcesDelivered: z.number().int().nullable().default(null),
  deliveryEvidence: z.string().default("status_only"),
  awaitingThreads: z.number().int().default(0),
  closedThreads: z.number().int().default(0),
  /** ★ **대상(src) 단위** — 콘솔의 "티켓" 은 대상 1건이며 `/gw/sources` total 과 모수가 같다.
   *  스레드 수(`threads`)와 1:1 이 아니다(dev_web 34→101, github 177→3). */
  sourcesAwaiting: z.number().int().default(0),
  sourcesClosed: z.number().int().default(0),
  queueWaiting: z.number().int().default(0),
});
export type DomainStats = z.infer<typeof DomainStats>;

/** 개요 한 판 — 4도메인을 1회 호출로.
 *
 * `asOf` 는 서버 epoch. 쿼리 간 스냅샷 일관성이 없어 합계가 도메인 합과 1~2 어긋날 수 있고,
 * 숨기는 대신 기준 시각을 같이 낸다.
 * ⚠️ `weekly.resolved` 는 항상 0 이다 — 이 축에 신뢰할 수 있는 '처리' 정의가 없다. 조치는
 * domains[].remediated 를 쓸 것(기존 performance() 의 resolved 는 사실상 false_positive 였다). */
export const GatewayStats = z.object({
  asOf: z.number(),
  week: z.string(),                                      // 2026-W34 (smb cycle_key 와 같은 형식)
  totals: z.object({
    findings: z.number().int(),
    sources: z.number().int(),
    openFindings: z.number().int(),
    falsePositive: z.number().int(),
    threads: z.number().int(),
    weekNew: z.number().int(),
    weekRemediated: z.number().int(),
    remediated: z.number().int(),
    sourcesWithoutThread: z.number().int(),
    awaitingThreads: z.number().int(),
    sourcesAwaiting: z.number().int().default(0),
    sourcesClosed: z.number().int().default(0),
  }),
  domains: z.array(DomainStats),
  weekly: z.array(z.object({ week: z.string(), inflow: z.number().int(), resolved: z.number().int() })),
  categories: z.array(z.object({ key: z.string(), label: z.string(), count: z.number().int() })),
  ownerLookup: z.enum(["ok", "denied"]).default("ok"),
});
export type GatewayStats = z.infer<typeof GatewayStats>;

export const WorkspaceKpi = z.object({
  openFindings: z.number().int(),
  queueTargets: z.number().int(),
  reportThreads: z.number().int(),
});
export type WorkspaceKpi = z.infer<typeof WorkspaceKpi>;

/** 성과 대시보드 실집계 — 퍼널(severity 분포)·주간추이(finding 유입/처리). */
export const GatewayPerformance = z.object({
  kpis: z.array(z.object({ label: z.string(), value: z.union([z.string(), z.number()]), sub: z.string().optional() })),
  funnel: z.array(z.object({ label: z.string(), value: z.number().int() })),
  weekly: z.array(z.object({ week: z.string(), inflow: z.number().int(), resolved: z.number().int() })),
});
export type GatewayPerformance = z.infer<typeof GatewayPerformance>;

/** 워크스페이스 payload — 구조(sectionLayout)는 control-plane 소유, 게이트웨이는 payload만. */
export const WorkspacePayload = z.object({
  key: EmployeeDomain,
  findings: z.array(GatewayFinding),
  reports: z.array(ReportThreadItem),
  kpi: WorkspaceKpi,
  performance: GatewayPerformance,
});
export type WorkspacePayload = z.infer<typeof WorkspacePayload>;

/**
 * 도메인 런타임 상태/활동 — platform.pipeline_* 기반. **개인(employee) 아님**: heartbeat/run은 공유
 * 도메인 워커(component) 키다. employees.status(개인 presence, seed)와 별개 축으로 노출한다.
 * codex: per-employee 귀속=범주 오류. pipeline_run엔 phase 없음(activity=heartbeat 현재값). detail은 redact됨.
 */
export const ComponentRuntime = z.object({
  component: z.string(),
  liveness: z.string(), // live|delayed|stale|unknown (heartbeat 나이)
  activity: z.string(), // active|idle|disabled|unknown (heartbeat phase)
  phase: z.string().nullable().optional(),
  lastBeatAt: z.number().nullable().optional(), // epoch
});
export type ComponentRuntime = z.infer<typeof ComponentRuntime>;

export const ComponentCounts = z.object({
  total: z.number().int(), live: z.number().int(), delayed: z.number().int(),
  stale: z.number().int(), unknown: z.number().int(),
});
export type ComponentCounts = z.infer<typeof ComponentCounts>;

export const DomainRuntime = z.object({
  domain: z.string(),
  liveness: z.string(),
  activity: z.string(),
  health: z.string(), // ok|degraded|unknown (최신 terminal run)
  lastBeatAt: z.number().nullable().optional(),
  componentCounts: ComponentCounts,
  components: z.array(ComponentRuntime),
});
export type DomainRuntime = z.infer<typeof DomainRuntime>;

export const RuntimePresence = z.object({
  scope: z.string(), // "domain_runtime"
  asOf: z.number(),
  policyVersion: z.string(),
  domains: z.array(DomainRuntime),
});
export type RuntimePresence = z.infer<typeof RuntimePresence>;

/** pipeline_run 1건 — 공유 도메인 워커의 실행 기록(개인 작업 이력 아님). detail은 redact됨. */
export const RuntimeActivityItem = z.object({
  component: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().nullable().optional(),
  status: z.string(),
  counters: z.record(z.string(), z.number().int()),
  detailRedacted: z.string().nullable().optional(),
});
export type RuntimeActivityItem = z.infer<typeof RuntimeActivityItem>;

export const RuntimeActivityList = z.object({
  scope: z.string(),
  domain: z.string(),
  asOf: z.number(),
  items: z.array(RuntimeActivityItem),
});
export type RuntimeActivityList = z.infer<typeof RuntimeActivityList>;

/** candidate 품질 read-model (#1 눈) — /gw/quality/candidates.
 *
 * ⚠️ `status="noData"` 는 **깨끗함이 아니다** — attempt 가 0건이라 아무것도 모르는 상태다.
 * ⚠️ `zeroSignal` 도 깨끗함이 아니다 — 후보 신호가 0이었다는 뜻(못 찾은 것과 없는 것은 다르다).
 * ⚠️ `degradedOk` 가 최우선 관전 지표다 — ok 로 보고됐지만 실제로는 침묵한 실행.
 * `rawCandidateSignals` 는 도구별 단위가 이질(hit/페이지/finding)이라 비율·차감 계산 금지. */
export const QualityDomainReport = z.object({
  domain: z.string(),
  status: z.enum(["present", "noData"]),
  attempts: z.number().int(),
  reported: z.number().int(),
  invalid: z.number().int(),
  missing: z.number().int(),
  soloAttempts: z.number().int(),
  accounted: z.number().int(),
  silent: z.number().int(),
  zeroSignal: z.number().int(),
  unknownLedger: z.number().int(),
  degradedOk: z.number().int(),
  failedSilent: z.number().int(),
  enforcementDisabled: z.number().int(),
  rawCandidateSignals: z.number().int(),
  rawCandidatesAccounted: z.number().int(),
  telemetryCoverage: z.number().nullable().optional(),
  lastObservedAt: z.number().nullable().optional(),
  byWorkerType: z.record(z.string(), z.number().int()),
  byExecutionState: z.record(z.string(), z.number().int()),
});
export type QualityDomainReport = z.infer<typeof QualityDomainReport>;

/** 침묵 attempt 1건 — 식별은 attemptId(UUID)만. 라벨/경로는 노출되지 않는다(기밀성 경계). */
export const QualitySilentAttempt = z.object({
  attemptId: z.string(),
  domain: z.string(),
  workerType: z.string(),
  component: z.string(),
  candidatesSeen: z.number().int().nullable().optional(),
  executionState: z.string(),
  lastAt: z.number(),
});
export type QualitySilentAttempt = z.infer<typeof QualitySilentAttempt>;

export const QualityCandidates = z.object({
  scope: z.string(),
  asOf: z.number(),
  windowDays: z.number().int(),
  policyVersion: z.string(),
  metricsVersion: z.number().int(),
  unclassifiedRows: z.number().int(),  // 어휘 밖 행 — 숨기면 fail-open 이라 카운트로 노출
  truncated: z.boolean(),              // 조용한 절단 금지
  domains: z.array(QualityDomainReport),
  recentSilent: z.array(QualitySilentAttempt),
});
export type QualityCandidates = z.infer<typeof QualityCandidates>;


/**
 * 보고 sync 의 단계별 카운터. **없는 키는 null** — 0 과 다르다.
 * 0 = "그 단계에서 아무것도 안 걸렸다", null = "그 실행이 이 값을 안 냈다".
 */
export const SyncCounters = z.object({
  seen: z.number().int().nullable().optional(),
  reposSeen: z.number().int().nullable().optional(),   // 묶인 저장소 수(통보 단위가 저장소다)
  created: z.number().int().nullable().optional(),     // 서버 원본 키는 `new`
  merged: z.number().int().nullable().optional(),
  recurred: z.number().int().nullable().optional(),    // 이전 주차 것이 이번 주차로 되살아남
  dup: z.number().int().nullable().optional(),
  skippedUnverified: z.number().int().nullable().optional(),
  skippedUnknownScope: z.number().int().nullable().optional(),
  ownerFound: z.number().int().nullable().optional(),
  ownerFromRepo: z.number().int().nullable().optional(),
  ownerMissing: z.number().int().nullable().optional(),
});
export type SyncCounters = z.infer<typeof SyncCounters>;

/** ★ parsed=false 는 "못 읽었다" 이지 "0" 이 아니다(detail 이 JSON 이 아니라 str(dict) 다).
 *
 * `stage` 는 그것과 **다른 축**이다 — 이 도메인이 보고 단계에서 무엇을 남기는가.
 *   sync         github·confluence · 단계별 카운터 전부
 *   report_only  dev_web           · 보고 결과(reports/sent)만
 *   absent       smb               · 보고 패스 자체가 없다(제출 시점에 스레드 생성)
 * absent 를 parsed=false 로 그리면 "못 읽었다" 가 되는데, 읽을 게 없는 것이다. */
export const SyncReport = z.object({
  domain: z.string(),
  stage: z.enum(["sync", "report_only", "absent"]).default("sync"),
  /** 마지막 확인(빈 tick 포함). 파이프라인이 도는가. */
  at: z.number().nullable().optional(),
  /** 마지막으로 **일한** 실행. 보고 컴포넌트는 30초 주기라 96%가 빈 tick 이다 —
   *  `at` 의 카운터를 그리면 화면이 항상 0 이다. absent 도메인은 티켓 생성 시각. */
  lastWorkAt: z.number().nullable().optional(),
  /** absent 도메인이 대신 내는 값 — 제출 시점에 만든 티켓 수. */
  tickets: z.number().int().nullable().optional(),
  status: z.string().nullable().optional(),
  parsed: z.boolean().default(false),
  counters: SyncCounters.nullable().optional(),
  handled: z.number().int().nullable().optional(),
  reports: z.number().int().nullable().optional(),
  sent: z.number().int().nullable().optional(),
  dryRun: z.number().int().nullable().optional(),
  errors: z.number().int().nullable().optional(),
});
export type SyncReport = z.infer<typeof SyncReport>;

/** 4도메인 전부 나온다(2026-08-29). 무엇을 남기는 도메인인지는 `stage` 가 말한다. */
export const SyncList = z.object({ asOf: z.number(), items: z.array(SyncReport) });
export type SyncList = z.infer<typeof SyncList>;

// ── SMB 노출 표면(공유 → 디렉터리) ───────────────────────────────────────────
// 발견 목록은 "무엇이 걸렸나", 이건 "어디까지 열려 있나" 다.
// ⚠️ 경로는 마스킹하지 않는다(사용자 결정 2026-08-25) — :8767 이 같은 ACL 안에서 원문을
//    이미 보여준다. 두 화면이 같은 대상에 다른 값을 보이는 쪽이 더 나쁘다.

/** 디렉터리 한 칸. listable/readable/writable 은 **nullable** — "안 됨" 과 "모름" 은 다르다. */
export const SmbDirectory = z.object({
  path: z.string(),
  depth: z.number().int().default(0),
  listable: z.boolean().nullable().optional(),
  readable: z.boolean().nullable().optional(),
  writable: z.boolean().nullable().optional(),
  error: z.string().nullable().optional(),
  lastSeen: z.number().nullable().optional(),
});
export type SmbDirectory = z.infer<typeof SmbDirectory>;

/** 공유 하나. `fileCount` 는 워커가 센 수이고 파일 **목록**은 주지 않는다
 *  (2백만 행 · 파일 단위 증거는 GatewayFindingDetail.hits[].location 이 답한다). */
export const SmbShare = z.object({
  share: z.string(),
  status: z.string().nullable().optional(),
  severity: z.string().nullable().optional(),
  shareRead: z.boolean().nullable().optional(),
  shareWrite: z.boolean().nullable().optional(),
  nullLogin: z.boolean().nullable().optional(),
  guestLogin: z.boolean().nullable().optional(),
  authLogin: z.boolean().nullable().optional(),
  fileCount: z.number().int().nullable().optional(),
  walkDoneAt: z.number().nullable().optional(),
  lastSeen: z.number().nullable().optional(),
  cycleKey: z.string().nullable().optional(),
  /** 이 공유의 **전체** 디렉터리 수. `directories.length` 와 다르면 잘린 것이다. */
  directoryTotal: z.number().int().default(0),
  directories: z.array(SmbDirectory).default([]),
});
export type SmbShare = z.infer<typeof SmbShare>;

/** 한 호스트의 노출 표면.
 *  ★ `access="denied"` 는 **못 읽은 것**이지 "없는 것" 이 아니다(sql/006 미적용). */
export const SmbTree = z.object({
  srcKey: z.string(),
  host: z.string().nullable().optional(),
  access: z.string().default("ok"),
  shares: z.array(SmbShare).default([]),
  directoryTotal: z.number().int().default(0),
  directoriesTruncated: z.boolean().default(false),
  sharesTruncated: z.boolean().default(false),
});
export type SmbTree = z.infer<typeof SmbTree>;

/** 발송 **요청** 본문(읽기 시점 재마스킹).
 *  ★ "발송본" 이 아니다 — 저장값은 deliver() 호출 전 payload 이고, 실제로 나간 본문은
 *    DB 어디에도 없다. 게이트웨이가 redact() 를 다시 걸어 내보내므로 화면 값은 실제
 *    나간 메일보다 **더** 가려져 있다.
 *  ⚠️ `access="denied"`(GRANT 미적용)와 `hasBody=false`(본문 없음)는 다른 뜻이다. */
export const MailBody = z.object({
  domain: z.string(),
  threadId: z.number().int(),
  access: z.string().default("ok"),
  hasBody: z.boolean().default(false),
  subject: z.string().nullable().optional(),
  mailTo: z.string().nullable().optional(),
  mailCc: z.string().nullable().optional(),
  sentAt: z.number().nullable().optional(),
  /** HTML 이면 sandbox iframe 으로, 아니면 평문으로 그린다. */
  isHtml: z.boolean().default(false),
  body: z.string().nullable().optional(),
  truncated: z.boolean().default(false),
  /**
   * 이 본문이 실제로 나갔는가. `"sent" | "draft" | "unknown"`.
   *
   * ⚠️ `unknown` 은 "안 나갔다" 가 **아니다** — 못 판정한다는 뜻이다.
   *    github·confluence·dev_web 본문은 리포트 생성 시점 산출물이라 발송 여부와 무관하고,
   *    그 셋은 항상 `unknown` 이다(정상). 발송 판정은 `SourceItem.deliveryEvidence` 축이다.
   * smb 만 `sent`/`draft` 를 가른다 — 2026-08-27 부터 안 나간 본문도 남기기 때문이다.
   */
  state: z.string().default("unknown"),
  /** 초안이 왜 안 나갔는지(게이트 사유). `state="draft"` 일 때만 채워진다. */
  stateDetail: z.string().nullable().optional(),
});
export type MailBody = z.infer<typeof MailBody>;
