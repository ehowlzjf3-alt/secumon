/**
 * 리포트 스레드 상세 · 파이프라인 상태 계약 (SSOT) — 4도메인 정규화.
 *
 * `gateway.ts` 의 `ReportThreadItem`(목록)과 **별개 타입**이다. 목록은 `/reports`·티켓 상세가
 * 이미 쓰고 있어 대체하면 두 화면이 같이 깨진다 — 여기서는 상세·파이프라인만 추가한다.
 *
 * ## 왜 정규화가 필요한가
 *
 * 4개 리포트 스레드 테이블은 공통 17컬럼으로 이미 거의 동형인데, **상태 어휘가 두 계열**이다.
 * 같은 생애주기를 다르게 부를 뿐이다(엔진 `state_domain` 의 status 집합 실측):
 *
 * | 뜻 | github·confluence | smb·dev_web |
 * |---|---|---|
 * | 담당자 응답 대기 | `awaiting_owner` | `awaiting_reply` |
 * | 재확인 요청 | `recheck_requested` | `re_requested` |
 * | 재확인 진행 | `rechecking` | `reverifying` |
 *
 * UI 가 이 차이를 알 필요는 없다. `stage`(정규)로 그리고, 원본은 `nativeStatus` 로 보존한다 —
 * 접기만 하고 **버리지는 않는다**(운영자가 엔진 로그와 대조할 때 원본이 필요하다).
 *
 * ## 경계 (gateway.ts 와 동일 규율)
 *
 * - **본문 원문은 이 계약에 없다.** `report_html`/`report_json` 은 egress `_redact` **이전**
 *   값이라 실제 나간 메일보다 덜 가려져 있다. 보유 여부·크기(`ReportBodyMeta`)만 계약하고,
 *   본문 표시는 마스킹 경계를 다시 세운 뒤 별도 슬라이스로 간다.
 * - 되묻기 키는 `srcKey`(불투명 해시)다. `src` 는 표시용 마스킹 라벨이라 필터로 쓰면
 *   남의 것이 섞인다(dev_web 은 35개 대상이 라벨 하나로 접힌다).
 * - 게이트웨이는 read-only 다. 운영 액션(재확인 요청·담당자 재지정·예외 승인/반려)은 **쓰기**라
 *   `/gw` 로 못 간다 — control-plane + 승인 게이트가 갈 곳이다(후속 슬라이스).
 *
 * ⚠️ 이 파일은 `gateway/src/digisecu_gateway/models.py` 와 **쌍**이다. 한쪽만 고치면 런타임
 *    검증이 없어 조용히 어긋난다. `contracts/tests/report-mirror.test.ts` 가 그걸 고정한다.
 */
import { z } from "zod";

/**
 * 정규 단계 — 4도메인 status 어휘의 합집합을 뜻 기준으로 접은 것.
 *
 * 순서는 생애주기 순이다(UI 정렬에 그대로 쓸 수 있게). 종결은 remediated/closed 둘.
 */
export const ReportStage = z.enum([
  "draft", // 초안 — 아직 보고서가 없다
  "report_built", // 보고서 생성됨, 미발송 (gh/cf 전용)
  "notified", // 통보됨
  "awaiting_owner", // 담당자 응답 대기
  "reply_received", // 답장 수신 (smb/dev_web 전용)
  "recheck_requested", // 재확인 요청됨
  "rechecking", // 재확인 진행 중
  "still_open", // 재확인 결과 미조치 (gh/cf 전용)
  "partially_remediated",
  "remediated", // 종결(조치 완료)
  "exception_review", // 예외 심사
  "owner_update_needed", // 담당자 정보 갱신 필요
  "owner_reassignment_review", // 담당자 재지정 심사
  "reassigned",
  "escalated",
  "closed", // 종결(그 외)
  "error", // 워커가 실패함
  // ★ "모르는 상태" 와 "실패" 는 다른 뜻이다. 엔진이 status 를 추가하면 여기로 떨어지고,
  //    error 로 접으면 운영자가 "워커가 깨졌다" 로 오독한다(quality 계약의 noData≠clean 과 같은 규율).
  "unknown",
]);
export type ReportStage = z.infer<typeof ReportStage>;

/** 화면 라벨 — 안정적 영문 키 ↔ 한국어. */
export const REPORT_STAGE_LABEL: Record<ReportStage, string> = {
  draft: "초안",
  report_built: "보고서 생성",
  notified: "통보됨",
  awaiting_owner: "담당자 응답 대기",
  reply_received: "답장 수신",
  recheck_requested: "재확인 요청",
  rechecking: "재확인 중",
  still_open: "미조치 확인",
  partially_remediated: "일부 조치",
  remediated: "조치 완료",
  exception_review: "예외 심사",
  owner_update_needed: "담당자 확인 필요",
  owner_reassignment_review: "담당자 재지정 심사",
  reassigned: "담당자 재지정됨",
  escalated: "에스컬레이션",
  closed: "종결",
  error: "오류",
  unknown: "알 수 없음",
};

/**
 * 종결 단계 — "처리 중" 은 이 여집합으로 도출한다(손나열 금지).
 *
 * ★ SSOT 는 게이트웨이 `domains.REPORT_THREAD_TERMINAL`(status 축)이고 이건 그걸 stage 축으로
 *   옮긴 것이다. 따로 정하면 **같은 스레드가 화면 A 에선 종결, B 에선 진행 중**으로 보인다
 *   (`/gw/stats.closedThreads` · `/gw/sources?threadState=closed` 가 그 SSOT 를 쓴다).
 *   `resolved`/`false_positive` 는 어느 도메인 어휘에도 없어 stage 로 안 접힌다.
 *
 * ⚠️ `partially_remediated` 는 **종결이 아니다** — 일부만 조치된 것을 완료로 세면 안 된다
 *    (`stats_service._REVERIFY_CLOSED` 가 `now_closed` 만 세는 것과 같은 이유).
 */
export const REPORT_TERMINAL_STAGES: readonly ReportStage[] = [
  "remediated", "escalated", "closed", "exception_review",
];

/**
 * 상위 그룹 — 목록 화면의 필터 칩 축.
 *
 * `stage` 17종은 **상세**에 맞고 목록엔 너무 잘다(칩이 한 줄에 안 들어간다). 서버·클라이언트가
 * **같은 기준**으로 접어야 숫자가 맞으므로 접기표를 계약에 둔다 — 다만 접기는 게이트웨이가 한다.
 * 어휘는 web `soarMeta.THREAD_STATE_FILTER` · `source_repo._THREAD_STATE_SQL` 과 맞췄다.
 */
export const ReportStageGroup = z.enum([
  "prepare", // 준비
  "notified", // 통보
  "waiting", // 대기
  "recheck", // 재확인
  "closed", // 종결
  "error", // 오류 — 워커가 실패함
  // ★ stage 축에서 갈라 놓고 group 축에서 합치면 구분이 무너진다. 그리고 **group 이 곧 필터 칩**,
  //   운영자가 실제로 클릭하는 면이다 — 목록에서 "엔진이 status 를 추가함" 과 "워커가 죽음" 이
  //   같은 칩 아래 섞이면 상세를 열어야만 구분이 보인다.
  "unknown", // 알 수 없음
]);
export type ReportStageGroup = z.infer<typeof ReportStageGroup>;

export const REPORT_STAGE_GROUP_LABEL: Record<ReportStageGroup, string> = {
  prepare: "준비",
  notified: "통보",
  waiting: "대기",
  recheck: "재확인",
  closed: "종결",
  error: "워커 실패",
  unknown: "알 수 없음",
};

/** stage → 그룹. 17종 전부가 정확히 한 그룹에 속해야 한다(테스트가 전수 고정). */
export const STAGE_TO_GROUP: Record<ReportStage, ReportStageGroup> = {
  draft: "prepare",
  report_built: "prepare",
  notified: "notified",
  reassigned: "notified",
  awaiting_owner: "waiting",
  reply_received: "waiting",
  owner_update_needed: "waiting",
  owner_reassignment_review: "waiting",
  recheck_requested: "recheck",
  rechecking: "recheck",
  still_open: "recheck",
  partially_remediated: "recheck",
  remediated: "closed",
  closed: "closed",
  escalated: "closed",
  exception_review: "closed",
  error: "error",
  unknown: "unknown",
};

/**
 * 도메인별 native status → 정규 stage.
 *
 * ⚠️ **클라이언트에서 이 맵으로 인덱싱하지 마라.** 접기는 게이트웨이가 하고 UI 는 `stage` 만
 *    받는다. 서버 문자열로 객체를 인덱싱하면 프로토타입 체인이 열리고(`"constructor"`),
 *    엔진이 status 를 추가하면 `undefined` 가 되어 그 스레드가 화면에서 조용히 사라진다.
 *    여기 있는 건 **테스트·문서용**이다.
 *
 * ★ 엔진 `state_domain` 의 status 집합 **전부**가 여기 있어야 한다. 빠지면 그 스레드가
 *   화면에서 사라진다(조용한 누락).
 *
 * ⚠️ 원래 여기 "`report.test.ts` 가 전수를 고정한다" 고 적혀 있었는데 **그 파일은 없다**
 *    (2026-08-31 확인). 실제로 있는 것은 `gateway/tests/test_report_contract_mirror.py` 이고,
 *    그건 이 표와 파이썬 표가 **서로 같은지**만 본다 — 둘이 나란히 틀리면 안 잡는다.
 *    엔진이 status 를 추가했는지는 아무도 안 본다. 실제로 `report_ready` 가 smb·dev_web
 *    양쪽에서 빠져 있었고, 최초 발송 게이트가 스레드를 바로 거기 세우는 바람에 드러났다.
 */
export const STATUS_TO_STAGE: Record<string, Record<string, ReportStage>> = {
  // github·confluence 계열 (_GITHUB_REPORT_THREAD_STATUSES / _CONFLUENCE_...)
  github: {
    draft: "draft",
    reported: "notified",
    report_ready: "report_built",
    awaiting_owner: "awaiting_owner",
    recheck_requested: "recheck_requested",
    rechecking: "rechecking",
    partially_remediated: "partially_remediated",
    remediated: "remediated",
    still_open: "still_open",
    exception_review: "exception_review",
    owner_update_needed: "owner_update_needed",
    owner_reassignment_review: "owner_reassignment_review",
    reassigned: "reassigned",
    escalated: "escalated",
    closed: "closed",
    error: "error",
  },
  confluence: {
    draft: "draft",
    reported: "notified",
    report_ready: "report_built",
    awaiting_owner: "awaiting_owner",
    recheck_requested: "recheck_requested",
    rechecking: "rechecking",
    remediated: "remediated",
    still_open: "still_open",
    partially_remediated: "partially_remediated",
    exception_review: "exception_review",
    owner_update_needed: "owner_update_needed",
    owner_reassignment_review: "owner_reassignment_review",
    reassigned: "reassigned",
    escalated: "escalated",
    closed: "closed",
    error: "error",
  },
  // smb·dev_web 계열 (_MAIL_THREAD_STATUSES / _DEV_WEB_REPORT_STATUSES — 어휘 동일)
  smb: {
    draft: "draft",
    reported: "notified",
    // ★ 최초 발송 게이트가 스레드를 여기 세운다(본문은 만들었고 발송만 안 했다).
    //   빠져 있으면 그 스레드가 stage `unknown` 으로 빠져 화면에서 사라진다.
    report_ready: "report_built",
    awaiting_reply: "awaiting_owner",
    reply_received: "reply_received",
    reverifying: "rechecking",
    remediated: "remediated",
    re_requested: "recheck_requested",
    escalated: "escalated",
    closed: "closed",
    exception_review: "exception_review",
    owner_update_needed: "owner_update_needed",
    owner_reassignment_review: "owner_reassignment_review",
    reassigned: "reassigned",
    partially_remediated: "partially_remediated",
  },
  dev_web: {
    draft: "draft",
    reported: "notified",
    // ★ 최초 발송 게이트가 스레드를 여기 세운다(본문은 만들었고 발송만 안 했다).
    //   빠져 있으면 그 스레드가 stage `unknown` 으로 빠져 화면에서 사라진다.
    report_ready: "report_built",
    awaiting_reply: "awaiting_owner",
    reply_received: "reply_received",
    reverifying: "rechecking",
    remediated: "remediated",
    re_requested: "recheck_requested",
    escalated: "escalated",
    closed: "closed",
    exception_review: "exception_review",
    owner_update_needed: "owner_update_needed",
    owner_reassignment_review: "owner_reassignment_review",
    reassigned: "reassigned",
    partially_remediated: "partially_remediated",
  },
};

/**
 * 보고서 본문 **메타데이터** — 본문 자체는 담지 않는다.
 *
 * `redaction` 이 이 계약의 핵심이다. 저장된 본문은 워커가 deliver 에 넘긴 payload 라
 * egress `_redact` 를 거치기 **전** 값이다 — 실제 나간 메일보다 덜 가려져 있을 수 있다.
 * 화면에 띄우려면 이 사실을 알고 마스킹 경계를 다시 세워야 한다.
 */
export const ReportBodyMeta = z.object({
  /**
   * 본문을 읽을 수 있는가 — **"본문 없음" 과 "권한 없음" 은 다른 뜻**이다.
   *  · `ok`      : 조회 가능(스레드 테이블에 본문 컬럼 보유)
   *  · `denied`  : GRANT 로 차단됨 — smb 본문은 `mail_message` 에 있는데 게이트웨이 롤
   *                (`digisecu_gw_ro`)에 부여돼 있지 않다(42501). 없는 게 아니라 못 읽는 것이다.
   *  · `unavailable`: 그 도메인 스레드 테이블에 본문 컬럼 자체가 없다.
   */
  access: z.enum(["ok", "denied", "unavailable"]),
  hasHtml: z.boolean(),
  hasJson: z.boolean(),
  htmlBytes: z.number().int().nullable().optional(),
  /** 저장 시점 기준 마스킹 상태. `pre_egress` = 발송 전 값이라 추가 마스킹 필요. */
  redaction: z.enum(["pre_egress", "unknown"]),
});
export type ReportBodyMeta = z.infer<typeof ReportBodyMeta>;

/** 도메인 고유 좌표 — 정규 필드로 접히지 않는 것만. 전부 nullable(도메인마다 컬럼이 다르다). */
export const ReportDomainRef = z.object({
  shareId: z.number().int().nullable().optional(), // smb
  host: z.string().nullable().optional(), // smb (마스킹 라벨)
  repo: z.string().nullable().optional(), // github
  spaceKey: z.string().nullable().optional(), // confluence
  targetId: z.number().int().nullable().optional(), // dev_web
  url: z.string().nullable().optional(), // dev_web (마스킹 라벨)
});
export type ReportDomainRef = z.infer<typeof ReportDomainRef>;

/** 리포트 스레드 1건 상세. 목록(`ReportThreadItem`)의 상위집합이 아니라 별개 표현이다. */
export const ReportThreadDetail = z.object({
  domain: z.string(),
  id: z.number().int(),
  /** 정규 단계 — 화면은 이걸로 그린다. */
  stage: ReportStage,
  /** 엔진 원본 status — 접기만 하고 버리지 않는다(로그 대조용). */
  nativeStatus: z.string(),
  severity: z.string().nullable().optional(),
  subjectTag: z.string(),
  /** 표시용 마스킹 라벨. 되묻기에 쓰지 말 것. */
  src: z.string().nullable().optional(),
  /** 되묻기 키(sha256 앞 16자). 필터·URL 은 전부 이것. */
  srcKey: z.string(),
  findingId: z.number().int().nullable().optional(),
  findingCount: z.number().int().default(1),
  findingSummary: z.string().nullable().optional(), // 저장시점 마스킹 봉인값
  recipient: z.string().nullable().optional(),
  ownerRecipient: z.string().nullable().optional(),
  deliveryTarget: z.string().nullable().optional(), // "DSSOC" / "담당자 개별" 고정 라벨
  createdAt: z.number().nullable().optional(),
  updatedAt: z.number().nullable().optional(),
  firstReportedAt: z.number().nullable().optional(),
  notifiedAt: z.number().nullable().optional(),
  attemptCount: z.number().int().nullable().optional(),
  cycleKeys: z.array(z.string()).default([]),
  firstCycleKey: z.string().nullable().optional(),
  lastCycleKey: z.string().nullable().optional(),
  lastReason: z.string().nullable().optional(), // free-text — 게이트웨이에서 redact
  /** ⚠️ smb(mail_thread) 전용 — 나머지 3종엔 컬럼 자체가 없어 항상 null. */
  recurrenceCount: z.number().int().nullable().optional(),
  lastErrorKind: z.string().nullable().optional(),
  body: ReportBodyMeta,
  domainRef: ReportDomainRef,
});
export type ReportThreadDetail = z.infer<typeof ReportThreadDetail>;

/**
 * 파이프라인 구성요소 1개의 실행 이력 — `pipeline_run` 투영.
 *
 * ★ `sinceLastRunSeconds` 가 이 계약을 만든 이유다. 보고·재확인 파이프라인이 6주 넘게 멈춰 있어도
 *   지금은 화면 어디에도 안 나온다. "마지막으로 언제 돌았나" 를 1급 시민으로 올린다.
 */
export const PipelineComponentRun = z.object({
  component: z.string(), // "github.report" · "confluence.recheck" 등 엔진 component 값
  lastRunAt: z.number().nullable().optional(), // pipeline_run.started_at 최댓값
  lastFinishedAt: z.number().nullable().optional(),
  lastStatus: z.string().nullable().optional(),
  runCount: z.number().int().default(0),
  /**
   * 마지막 **실행**으로부터 경과(초). null = 한 번도 안 돎.
   *
   * ⚠️ `/gw/runtime/presence` 의 heartbeat staleness 와 **다른 축**이다. heartbeat 은
   * "프로세스가 신호를 보내는가", 이건 "그 컴포넌트가 실제로 일한 게 언제인가" 다.
   * 지금 데이터가 정확히 둘을 가른다 — 탐지는 08-22 까지 돌았고 report·recheck 는 07-10 이후
   * 멈춰 있다. 화면에서 두 숫자를 나란히 놓을 수 있게 이름에 "run" 을 넣는다.
   */
  sinceLastRunSeconds: z.number().nullable().optional(),
});
export type PipelineComponentRun = z.infer<typeof PipelineComponentRun>;

/** 도메인 1개의 파이프라인 현황 — 단계별 적체 + 구성요소 실행 이력. */
export const PipelineOverview = z.object({
  domain: z.string(),
  /** 정규 stage → 스레드 수. 0인 stage 는 생략될 수 있다. */
  stageCounts: z.record(z.string(), z.number().int()).default({}),
  /** 상위 그룹 → 스레드 수. 접기는 게이트웨이가 한다(UI 가 다시 접지 않게). */
  groupCounts: z.record(z.string(), z.number().int()).default({}),
  components: z.array(PipelineComponentRun).default([]),
  /** 이 도메인 스레드 총계(stageCounts 합과 같아야 한다 — 검산용). */
  threadTotal: z.number().int().default(0),
});
export type PipelineOverview = z.infer<typeof PipelineOverview>;
