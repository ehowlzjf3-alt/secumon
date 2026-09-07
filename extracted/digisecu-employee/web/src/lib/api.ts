/**
 * control-plane API 클라이언트 — /api 는 vite dev 프록시로 control-plane(8080) 왕복.
 * 타입은 @digisecu/contracts 단일 진실원.
 */
import { runSinceEpoch } from "./runScope";
import type {
  AuditListResponse,
  AuditQuery,
  FindingList,
  GatewayFindingDetail,
  MailBody,
  MailSendResult,
  OwnerAssignResult,
  TicketStatus,
  TicketStatusResult,
  SmbTree,
  GatewayStats,
  SyncList,
  QualityCandidates,
  QueueDepthList,
  ReportThreadItem,
  RuntimeActivityList,
  RuntimePresence,
  SourceList,
  TriageBatchResponse,
  TriageRecord,
  TriageStatus,
  WorkspacePayload,
} from "@digisecu/contracts";

export interface HealthInfo {
  status: string;
  service: string;
  milestone: string;
}

/** readiness — DB 왕복 가능 여부. control-plane 다운이면 fetch 자체가 reject(→ isError). */
export interface ReadinessInfo {
  ready: boolean;
  db: string;
  error?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`요청 실패 (${res.status})`);
  }
  return (await res.json()) as T;
}

// 쓰기(mutation) — POST + JSON. 서버 에러 코드를 메시지에 실어 UI가 구분 가능하게.
async function sendJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    let code = "";
    try {
      const j = (await res.json()) as { error?: string };
      code = j?.error ? ` — ${j.error}` : "";
    } catch {
      /* 본문 없음 */
    }
    throw new Error(`요청 실패 (${res.status})${code}`);
  }
  return (await res.json()) as T;
}

/** 감사로그 — 최근순 슬라이스(로비 최근 활동). */
export function fetchAudit(limit = 20): Promise<AuditListResponse> {
  return getJson<AuditListResponse>(`/api/audit?limit=${limit}`);
}

/** control-plane liveness(프로세스 생존만 — DB 미접촉). */
export function fetchHealth(): Promise<HealthInfo> {
  return getJson<HealthInfo>("/health");
}

/** control-plane readiness(digisecu_control SELECT 1). 503(ready:false)도 유효 신호라 본문을 읽는다. */
export async function fetchReadiness(): Promise<ReadinessInfo> {
  const res = await fetch("/readyz", { headers: { accept: "application/json" } });
  const body = (await res.json().catch(() => null)) as Partial<ReadinessInfo> | null;
  if (!body) throw new Error(`readiness 응답 파싱 실패 (${res.status})`);
  return { ready: Boolean(body.ready), db: body.db ?? "digisecu_control", error: body.error };
}

/** 감사로그 뷰어 — limit + 주체·분류 필터. */
export function fetchAuditLog(q: AuditQuery = {}): Promise<AuditListResponse> {
  const params = new URLSearchParams();
  if (q.limit) params.set("limit", String(q.limit));
  if (q.actor) params.set("actor", q.actor);
  if (q.category) params.set("category", q.category);
  // ★ 티켓 단위 — 워크스페이스가 "이 티켓에 무슨 일이 있었나" 를 그린다(2026-09-01).
  if (q.domain) params.set("domain", q.domain);
  if (q.threadId) params.set("threadId", String(q.threadId));
  const qs = params.toString();
  return getJson<AuditListResponse>(`/api/audit${qs ? `?${qs}` : ""}`);
}

// ── 트리아지 오버레이(제품 소유) — 관리 상태·코멘트 영속(control-plane). finding 자체는 게이트웨이 소유. ──
/** 배치 조회 — refs(finding:th:<id>) 중 영속된 것만. 없는 ref는 web이 기본값(unclassified/version 0) 표시. */
export function fetchTriageBatch(refs: string[]): Promise<TriageBatchResponse> {
  return getJson<TriageBatchResponse>(`/api/triage?refs=${encodeURIComponent(refs.join(","))}`);
}
/** 상태 변경 — 낙관적 동시성(expectedVersion). 운영자 토큰은 프록시 서버측 주입. */
export function setTriageStatus(findingRef: string, status: TriageStatus, expectedVersion: number): Promise<TriageRecord> {
  return sendJson<TriageRecord>("/api/triage/status", { findingRef, status, expectedVersion });
}
/**
 * 조치요청 메일 발송 — ★ **되돌릴 수 없다.** 메일은 회수 경로가 없다.
 *
 * 두 단계다: 요청(승인 대기 생성) → 승인(실행). 승인자 토큰은 vite 프록시가 서버측에서
 * 실어 주므로 브라우저는 토큰을 모른다.
 *
 * ⚠️ 요청 본문에 **메일 내용이 없다**(도메인·스레드번호뿐). 담으면 그게 곧 2026-08-25 에
 *    지운 무방비 발송 라우트다 — 수신자·제목·본문은 서버가 DB 에서 다시 읽는다.
 * ★ 결과의 `mode="dry_run"` 은 **오류가 아니라 게이트 판정**이다. `reasons` 를 그려야
 *   운영자가 "고장" 과 "정책상 안 나감" 을 가른다.
 */
export async function requestAndSendMail(
  domain: string,
  threadId: number,
): Promise<MailSendResult> {
  const created = await sendJson<{ approval: { id: string } }>("/api/mail-sends", {
    domain,
    threadId,
  });
  const id = created?.approval?.id;
  requireShape(typeof id === "string" && !!id, "mailSendApproval");
  const done = await sendJson<{ result?: MailSendResult }>(
    `/api/approvals/${encodeURIComponent(id)}/approve`,
    { note: "콘솔에서 발송" },
  );
  requireShape(isObj(done?.result), "mailSendResult");
  return done.result as MailSendResult;
}

/**
 * 담당자 지정 — 요청 후 즉시 승인까지(발송과 같은 흐름).
 *
 * ⚠️ 이름이 아니라 **Knox ID**(또는 사내 메일 주소)를 보낸다. Knox MCP 의 임직원 도구는
 *    정확 조회만 되고 이름 검색이 없다(2026-09-01 확인). 이름·부서는 **서버가** 조회해
 *    돌려준다 — 화면이 보낸 값을 서버가 믿게 만들지 않는다.
 */
export async function assignOwner(
  domain: string,
  threadId: number,
  knoxId: string,
): Promise<OwnerAssignResult> {
  const created = await sendJson<{ approval: { id: string } }>("/api/owner-assigns", {
    domain,
    threadId,
    knoxId,
  });
  const id = created?.approval?.id;
  requireShape(typeof id === "string" && !!id, "ownerAssignApproval");
  const done = await sendJson<{ result?: OwnerAssignResult }>(
    `/api/approvals/${encodeURIComponent(id)}/approve`,
    { note: "콘솔에서 담당자 지정" },
  );
  requireShape(isObj(done?.result), "ownerAssignResult");
  return done!.result as OwnerAssignResult;
}


/**
 * 티켓 상태 지정 — 사람이 콘솔 필터와 같은 어휘로 티켓 상태를 바꾼다.
 *
 * ⚠️ 승인 큐를 안 탄다(담당자 지정·발송과 다르다). 상태 정리는 운영자의 일상 행위라
 *    승인 왕복을 씌우면 아무도 안 쓴다 — 대신 서버가 감사로그를 남긴다.
 * ⚠️ 도메인 native status(`awaiting_reply` 대 `awaiting_owner`)로의 번역은 **서버**가 한다.
 *    화면은 필터 어휘만 보낸다.
 */
export function setTicketStatus(
  domain: string,
  threadId: number,
  status: TicketStatus,
): Promise<TicketStatusResult> {
  return sendJson<TicketStatusResult>("/api/ticket-status", { domain, threadId, status });
}


/** 코멘트 추가(append-only). */
export function addTriageNote(findingRef: string, body: string): Promise<TriageRecord> {
  return sendJson<TriageRecord>("/api/triage/note", { findingRef, body });
}

// ── M2.4 예산 하드스톱 ────────────────────────────────────────────────────
// ── M5 개별발송(per_owner) 활성화 ─────────────────────────────────────────
// ── M4 state_domain read 게이트웨이 클라이언트 ──────────────────────────────
// control-plane과 **별개 백엔드**(/gw, vite 프록시→게이트웨이 8091, threat_hunter read-only).
// Bearer 토큰은 프록시가 서버측 주입(브라우저 미노출). 게이트웨이 다운 시 fetch reject→훅 isError→UI는 mock 폴백.
async function getGwJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`게이트웨이 요청 실패 (${res.status})`);
  return (await res.json()) as T;
}

// 계약위반 200(shape drift) 방어: 필수 형태 미충족이면 throw → 훅 isError → mock 폴백(화이트스크린 방지).
// web은 zod 직접 의존이 없어 경량 구조 가드로 최소 형태만 검증(소비처가 .map/for 로 순회하는 필드).
function requireShape(ok: boolean, what: string): void {
  if (!ok) throw new Error(`게이트웨이 응답 계약 위반(${what}) — mock 폴백`);
}
/** 워크스페이스 목록 상한 — 게이트웨이 하드캡(le=500) 안에서 넉넉히. */
const WORKSPACE_FINDING_LIMIT = 500;
const WORKSPACE_REPORT_LIMIT = 300;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 축1: (agentType=domain) 실행 큐 대기 깊이. */
export async function fetchQueueDepth(): Promise<QueueDepthList> {
  const d = await getGwJson<QueueDepthList>("/gw/queue/depth");
  requireShape(isObj(d) && Array.isArray((d as QueueDepthList).items), "queue/depth");
  return d;
}

/** 축2: finding(마스킹) 목록. taskType=도메인. */
export async function fetchGatewayFindings(
  q: {
    taskType?: string; status?: string; category?: string; limit?: number; offset?: number;
    since?: number; week?: string; severity?: string; srcKey?: string;
  } = {},
): Promise<FindingList> {
  const p = new URLSearchParams();
  if (q.taskType) p.set("taskType", q.taskType);
  if (q.status) p.set("status", q.status);
  if (q.category) p.set("category", q.category);
  if (q.limit) p.set("limit", String(q.limit));
  // 게이트웨이는 offset 을 지원하는데 web 이 한 번도 보내지 않았다 — 그래서 목록이 늘
  // 첫 페이지에서 끊겼다(github 19,808건). 서버 페이지네이션을 켠다.
  if (q.offset) p.set("offset", String(q.offset));
  if (q.week) p.set("week", q.week);
  if (q.severity) p.set("severity", q.severity);
  // 대상 한 곳으로 좁히기. ⚠️ 라벨(src)이 아니라 불투명 키로만 되묻는다 —
  // 마스킹 때문에 서로 다른 두 대상이 같은 라벨로 보일 수 있다.
  if (q.srcKey) p.set("srcKey", q.srcKey);
  // "이번 run 만 보기" — 게이트웨이는 since 를 지원하는데 웹이 안 보내고 있었다.
  // 미설정이면 undefined → 파라미터 자체를 안 붙인다(전체 표시, fail-open).
  const since = q.since ?? runSinceEpoch();
  if (since !== undefined) p.set("since", String(since));
  const qs = p.toString();
  const d = await getGwJson<FindingList>(`/gw/findings${qs ? `?${qs}` : ""}`);
  requireShape(isObj(d) && Array.isArray((d as FindingList).items), "findings");
  return d;
}

/** 축0: 대상(src) 목록 — 티켓의 단위.
 *
 * ⚠️ 필터·링크는 `srcKey` 로만. `src` 는 마스킹된 표시용 라벨이라 되묻기 키로 쓰면 안 된다.
 * ⚠️ `ownerLookup === "denied"` 면 담당자를 **못 읽은 것**이지 없는 게 아니다 —
 *    화면은 '담당자 없음' 대신 '권한 없음' 으로 그려야 한다(asset_owner 는 sql/004 GRANT).
 */
export async function fetchSources(
  q: {
    domain?: string;
    threadState?: "none" | "reported" | "ready" | "awaiting" | "replied" | "closed";
    /** 한 건 조회(티켓 상세 딥링크). 라벨이 아니라 게이트웨이가 낸 불투명 키다. */
    srcKey?: string;
    /** 대상 찾기(부분 일치). 서버가 **원문**으로 찾고 LIKE 메타문자를 이스케이프한다. */
    q?: string;
    /** 데이터 분류(canon 키). 대상 하나가 여러 분류에 걸치므로 "그 분류가 있는 대상" 이다.
     *  미지 키는 서버가 422 로 거부한다(조용한 무시 금지). */
    category?: string;
    /** "그 등급이 있는 대상". 모르는 값은 서버가 400 으로 거부한다(조용히 무시 금지). */
    severity?: "critical" | "high";
    assignee?: "none" | "resolved";
    order?: "firstSeen" | "findings" | "critical" | "lastSeen" | "stale";
    limit?: number;
    offset?: number;
  } = {},
): Promise<SourceList> {
  const p = new URLSearchParams();
  if (q.domain) p.set("domain", q.domain);
  if (q.threadState) p.set("threadState", q.threadState);
  if (q.srcKey) p.set("srcKey", q.srcKey);
  if (q.q) p.set("q", q.q);
  if (q.category) p.set("category", q.category);
  if (q.severity) p.set("severity", q.severity);
  if (q.assignee) p.set("assignee", q.assignee);
  if (q.order) p.set("order", q.order);
  p.set("limit", String(q.limit ?? 50));
  if (q.offset) p.set("offset", String(q.offset));
  const d = await getGwJson<SourceList>(`/gw/sources?${p.toString()}`);
  requireShape(isObj(d) && Array.isArray((d as SourceList).items), "sources");
  return d;
}

/** candidate 품질(#1 눈) — 워커가 "무엇을 봤고 무엇을 정산했는지".
 *
 * ⚠️ status="noData" 는 깨끗함이 아니라 **아무것도 모르는 상태**다(attempt 0건).
 * ⚠️ truncated / unclassifiedRows 를 화면에서 숨기면 fail-open 이 된다 — 그대로 표시할 것.
 */
export async function fetchQualityCandidates(windowDays = 30): Promise<QualityCandidates> {
  const d = await getGwJson<QualityCandidates>(`/gw/quality/candidates?windowDays=${windowDays}`);
  requireShape(isObj(d) && Array.isArray((d as QualityCandidates).domains), "quality candidates");
  return d;
}

/** 개요 집계 — 4도메인 1회 호출.
 *
 * ⚠️ `weekly[].resolved` 는 항상 0 이다(신뢰할 수 있는 '처리' 정의가 없다).
 *    조치 건수는 `domains[].remediated` 를 쓰고, 무엇을 셌는지는 `remediationBasis` 로 표기한다.
 */
export async function fetchGatewayStats(): Promise<GatewayStats> {
  const d = await getGwJson<GatewayStats>("/gw/stats");
  requireShape(isObj(d) && Array.isArray((d as GatewayStats).domains), "stats");
  return d;
}

/** 보고 sync 카운터 — "열린 finding 다수 vs 이번 주 보고 소수" 의 간극을 설명하는 값. */
export async function fetchPipelineSync(): Promise<SyncList> {
  const d = await getGwJson<SyncList>("/gw/pipeline/sync");
  requireShape(isObj(d) && Array.isArray((d as SyncList).items), "pipeline/sync");
  return d;
}

/** 리포트 스레드만(주차 필터) — 주차 전환 시 payload 전체 재조회를 피한다. */
export async function fetchWorkspaceReports(
  key: string, q: { cycleKey?: string; limit?: number } = {},
): Promise<ReportThreadItem[]> {
  const p = new URLSearchParams();
  if (q.cycleKey) p.set("cycleKey", q.cycleKey);
  p.set("limit", String(q.limit ?? 300));
  const d = await getGwJson<ReportThreadItem[]>(
    `/gw/workspaces/${encodeURIComponent(key)}/reports?${p.toString()}`,
  );
  requireShape(Array.isArray(d), "workspace reports");
  return d;
}

export interface PipelineStage { status: string; count: number; terminal: boolean }
export interface PipelineView { domain: string; cycleKey: string | null; cycles: string[]; stages: PipelineStage[] }

/** 파이프라인 흐름 — 큐 status 분포(+주차). 8767 대시보드 이식분. */
export async function fetchWorkspacePipeline(key: string, cycleKey?: string): Promise<PipelineView> {
  const qs = cycleKey ? `?cycleKey=${encodeURIComponent(cycleKey)}` : "";
  const d = await getGwJson<PipelineView>(`/gw/workspaces/${encodeURIComponent(key)}/pipeline${qs}`);
  requireShape(isObj(d) && Array.isArray((d as PipelineView).stages), "workspace pipeline");
  return d;
}

/** 리포트 주차 목록 + 상태 분포(8767 mail 탭 미러). 주차 기준은 `last_cycle_key`. */
export async function fetchReportCycles(
  key: string, cycleKey?: string,
): Promise<{ cycles: string[]; statusCounts: Record<string, number> }> {
  const qs = cycleKey ? `?cycleKey=${encodeURIComponent(cycleKey)}` : "";
  const d = await getGwJson<{ cycles: string[]; statusCounts: Record<string, number> }>(
    `/gw/workspaces/${encodeURIComponent(key)}/report-cycles${qs}`,
  );
  requireShape(isObj(d) && Array.isArray(d.cycles), "report cycles");
  return d;
}

/** 카테고리별 건수 — 칩 숫자용. 화면에 걸린 필터를 그대로 넘겨 같은 조건으로 센다. */
export async function fetchFindingCategoryCounts(
  q: { taskType?: string; status?: string; since?: number; week?: string; severity?: string } = {},
): Promise<{ counts: Record<string, number>; labels: Record<string, string> }> {
  const p = new URLSearchParams();
  if (q.taskType) p.set("taskType", q.taskType);
  if (q.status) p.set("status", q.status);
  // ★ 목록과 **같은 기본 범위**를 쓴다. 여기서 since 를 안 넘기면 목록은 8/15+ 인데
  //   칩 숫자는 전 기간이 되어 조용히 어긋난다(실제로 그렇게 쓸 뻔했다).
  const since = q.since ?? runSinceEpoch();
  if (since !== undefined) p.set("since", String(since));
  if (q.week) p.set("week", q.week);
  if (q.severity) p.set("severity", q.severity);
  const qs = p.toString();
  const d = await getGwJson<{ counts: Record<string, number>; labels: Record<string, string> }>(
    `/gw/findings/categories${qs ? `?${qs}` : ""}`,
  );
  requireShape(isObj(d) && isObj((d as { counts: unknown }).counts), "finding categories");
  return d;
}

/** 관측된 주차 목록(최신순, `2026-W34` 형식 — smb cycle_key 와 동일). 주차 선택기용. */
export async function fetchFindingWeeks(taskType?: string): Promise<string[]> {
  const qs = taskType ? `?taskType=${encodeURIComponent(taskType)}` : "";
  const d = await getGwJson<{ weeks: string[] }>(`/gw/findings/weeks${qs}`);
  requireShape(isObj(d) && Array.isArray((d as { weeks: string[] }).weeks), "finding weeks");
  return d.weeks;
}

/** 노출 표면(smb) — 한 호스트의 공유 → 디렉터리.
 *  ⚠️ 경로는 마스킹하지 않는다(사용자 결정 2026-08-25) — :8767 이 같은 ACL 안에서
 *     이미 원문을 보여준다. 두 화면이 같은 대상에 다른 값을 보이는 쪽이 더 나쁘다. */
export async function fetchSmbTree(srcKey: string): Promise<SmbTree> {
  const d = await getGwJson<SmbTree>(`/gw/sources/${encodeURIComponent(srcKey)}/smb-tree`);
  requireShape(isObj(d) && Array.isArray((d as SmbTree).shares), "smbTree");
  return d;
}

/** 발송 **요청** 본문. ★ "발송본" 이 아니다 — 게이트웨이가 읽기 시점에 재마스킹하므로
 *  실제 나간 메일보다 더 가려져 있다. */
export async function fetchMailBody(domain: string, threadId: number): Promise<MailBody> {
  const d = await getGwJson<MailBody>(
    `/gw/reports/${encodeURIComponent(domain)}/${threadId}/body`,
  );
  requireShape(isObj(d) && typeof (d as MailBody).access === "string", "mailBody");
  return d;
}

/** 축2 상세: 단건 finding(마스킹). 리스트엔 없는 리치필드(hits·위험서사·pivot·메타) 포함. */
export async function fetchGatewayFinding(id: number): Promise<GatewayFindingDetail> {
  const d = await getGwJson<GatewayFindingDetail>(`/gw/findings/${id}`);
  requireShape(isObj(d) && typeof (d as GatewayFindingDetail).id === "number", "finding");
  return d;
}

/** 축3: 워크스페이스 payload(구조 sectionLayout은 control-plane 소유).
 *
 * 발견사항/리포트 목록 상한은 게이트웨이가 60/50 으로 하드코딩돼 있었다 — 한 run 의
 * 결과도 잘려 보였다(smb 한 사이클만 234 타깃·96 finding). 이제 파라미터라 여기서 올린다.
 * `since` 는 "이번 run 만 보기"(= /gw/findings 와 동일 의미, last_seen 기준).
 */
export async function fetchWorkspacePayload(key: string): Promise<WorkspacePayload> {
  const p = new URLSearchParams();
  p.set("findingLimit", String(WORKSPACE_FINDING_LIMIT));
  p.set("reportLimit", String(WORKSPACE_REPORT_LIMIT));
  const since = runSinceEpoch();
  if (since !== undefined) p.set("since", String(since));
  const d = await getGwJson<WorkspacePayload>(
    `/gw/workspaces/${encodeURIComponent(key)}/payload?${p.toString()}`,
  );
  requireShape(
    isObj(d) && Array.isArray((d as WorkspacePayload).findings) && Array.isArray((d as WorkspacePayload).reports) && isObj((d as WorkspacePayload).kpi),
    "workspace payload",
  );
  return d;
}

/** 도메인 런타임 상태(4도메인, platform.pipeline_* 기반). 개인 아님 — 공유 워커 집계. */
export async function fetchRuntimePresence(): Promise<RuntimePresence> {
  const d = await getGwJson<RuntimePresence>("/gw/runtime/presence");
  requireShape(isObj(d) && Array.isArray((d as RuntimePresence).domains), "runtime/presence");
  return d;
}

/** 도메인 런타임 활동 피드(pipeline_run, redact됨). */
export async function fetchRuntimeActivity(domain: string, limit = 20): Promise<RuntimeActivityList> {
  const d = await getGwJson<RuntimeActivityList>(`/gw/runtime/domains/${encodeURIComponent(domain)}/activity?limit=${limit}`);
  requireShape(isObj(d) && Array.isArray((d as RuntimeActivityList).items), "runtime/activity");
  return d;
}
