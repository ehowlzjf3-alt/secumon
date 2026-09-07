/**
 * (B) 컨트롤 플레인 — 회사 API (Express 5).
 *
 * M1.1: 첫 실 DB 왕복(읽기). 명부 목록/상세.
 * M1.2: 첫 DB 쓰기 mutation + 위험행동 승인 게이트.
 *  - POST /api/hires                     채용 제안 → pending 승인 (fail-closed)
 *  - GET  /api/approvals?state=          승인 목록(+pendingCount)
 *  - GET  /api/approvals/:id             승인 상세
 *  - POST /api/approvals/:id/approve     승인(원자 전이) → hire=임직원 생성, terminate=Terminated
 *  - POST /api/approvals/:id/reject      반려
 *  - POST /api/employees/:id/pause|resume  라이프사이클 직접 전이(게이트 없음)
 *  - POST /api/employees/:id/terminate   퇴사 승인 요청(게이트)
 * 프로비저닝·계정·발송·파드는 전부 mock. 실제인 것은 게이트(DB pending→approved)뿐.
 * 도메인 상태(state_domain 28테이블)는 M4 Python read 게이트웨이 경유(여기서 접근 안 함).
 */
// env(CONTROL_PG_DSN) 로드는 ./db/client 가 import 시점에 수행.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { and, asc, count, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  ApprovalDecision,
  ApprovalListResponse,
  ApprovalRecord,
  ApprovalResponse,
  ApprovalState,
  AUDIT_ACTION_META,
  AuditListResponse,
  AuditQuery,
  BudgetOverrideRequest,
  EmployeeDetailResponse,
  EmployeeRecord,
  HireDraft,
  HireRequest,
  OrgResponse,
  RosterListResponse,
  RosterQuery,
  AddTriageNoteRequest,
  SetTriageStatusRequest,
  TriageBatchQuery,
  TriageBatchResponse,
  UsageRequest,
  WorkspaceListResponse,
  type ApprovalAction,
  type AuditRecord,
  type TriageNote,
  type TriageRecord,
  type TriageStatus,
  type DesiredState,
  type EmployeeDomain,
  type EmployeeKind,
  type EmployeeStatus,
  type LifecycleCommand,
  type LifecycleState,
  MailSendDraft,
  OwnerAssignDraft,
  TicketStatusDraft,
  MailSendResult,
  type MailSendMode,
  type Tool,
} from "@digisecu/contracts";
import { db, pool } from "./db/client.js";
import { runMailSend, runOwnerAssign, runTicketStatus } from "./mail-send.js";
import { candidateActions, directTransition, TERMINABLE_FROM } from "./lifecycle-policy.js";
import { runtimeModeFor, startEmployeeRuntimeDriver } from "./runtime-driver.js";
import { computeAdmission, currentPeriodStart } from "./budget.js";
import { WORKSPACE_REGISTRY } from "./workspaces.js";
import {
  approvals,
  auditLog,
  budgetGrants,
  employees,
  findingTriage,
  findingTriageNote,
  tools,
  usageEvents,
  type ApprovalRow,
  type AuditRow,
  type EmployeeRow,
  type FindingTriageNoteRow,
  type FindingTriageRow,
  type ToolRow,
} from "./db/schema.js";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";

// 신규 채용 서버측 상수(계약값 발명 금지 — 도메인 악센트/한글 라벨만).
const DOMAIN_ACCENT: Record<string, string> = { smb: "#7a5c3e", dev_web: "#5e6e4a", github: "#6b5563", confluence: "#4f6472" };
const KIND_LABEL_KO: Record<string, string> = { person: "총괄", orchestrator: "팀장", strategy: "전략담당", partlead: "파트장", worker: "워커", hr: "HR" };
// 승인자/요청자 (HR 제안 → 보안운영팀장 승인).
const REQUESTER = { id: "hr", name: "한지원" };
const APPROVER = { id: "root", name: "박준호" };

// P4 하드닝(권한분리 실제 강제): **실행·운영 조작은 사람 승인자만**. APPROVER_TOKEN 설정 시
// approve/reject + operator mutation(pause/resume/disable-send/usage/telemetry)에 `Authorization: Bearer <token>`
// 강제 → 자율 role 에이전트(egress MCP 경유)가 self-approve·kill-switch 무력화 불가. 제안(요청) 엔드포인트는
// 개방 유지(에이전트가 제안하는 건 정상). 미설정: dev=무인증(경고), **prod=fail-closed(전부 거부)**(codex B).
// 기본 deny(codex D): 토큰 미설정 시 NODE_ENV 판정에 의존하지 않는다(prod/Production/unset 오타로 fail-open 회피).
// 무인증 dev를 원하면 **명시적** ALLOW_INSECURE_DEV_APPROVER=true 로만 연다. 운영은 이 플래그를 절대 켜지 않음.
const ALLOW_INSECURE_DEV_APPROVER = process.env.ALLOW_INSECURE_DEV_APPROVER === "true";
const APPROVER_TOKEN = process.env.APPROVER_TOKEN ?? "";
const APPROVER_TOKEN_DIGEST = APPROVER_TOKEN ? createHash("sha256").update(`Bearer ${APPROVER_TOKEN}`).digest() : null;
function approverTokenOk(authHeader: string | undefined): boolean {
  // 토큰 미설정: 기본 **deny**(fail-closed). 오직 ALLOW_INSECURE_DEV_APPROVER=true 명시 opt-in 때만 allow.
  if (!APPROVER_TOKEN_DIGEST) return ALLOW_INSECURE_DEV_APPROVER;
  if (!authHeader) return false;
  // 상수시간 비교(타이밍 오라클 차단): 양쪽 sha256(고정 32B)으로 timingSafeEqual 길이-throw 회피.
  const actual = createHash("sha256").update(authHeader).digest();
  return timingSafeEqual(APPROVER_TOKEN_DIGEST, actual);
}

// approve/reject + operator mutation 공통 게이트. 미인증이면 403 응답하고 false 반환(호출측 즉시 return).
// 제안/요청 엔드포인트(hire/terminate/budget-override/reclaim/enable-send)는 이 게이트를 쓰지 않음(개방 — 에이전트 propose).
function requireApprover(req: express.Request, res: express.Response): boolean {
  if (!approverTokenOk(req.header("authorization") ?? undefined)) {
    res.status(403).json({ error: "approver_unauthenticated", detail: "실행/운영 조작은 승인자 토큰 필요(제안≠실행 분리)" });
    return false;
  }
  return true;
}

// dev/demo 사용액 기록 feature-gate — 기본 OFF(명시적 opt-in만). 켜두면 원장을 통한 하드스톱 DoS 가능(codex#5).
// 실 spend 소스는 M3 파드 텔레메트리. 데모 시 DEV_USAGE_ENABLED=true 로 명시 활성화.
const DEV_USAGE_ENABLED = process.env.DEV_USAGE_ENABLED === "true";

// M3.3b 파드 usage 텔레메트리 인입 게이트 — 기본 OFF(명시 opt-in). 무인증 열린 채면 위조 spend로 임직원 강제
// 하드스톱 DoS 가능(M2 codex#5와 동형) → dev/E2E는 TELEMETRY_ENABLED=true. 실 reporter 인증은 M4.
const TELEMETRY_ENABLED = process.env.TELEMETRY_ENABLED === "true";

/**
 * 승인 실행 중 가드 위반 — 던지면 트랜잭션이 롤백되어 승인 전이까지 되돌린다(pending 유지).
 * (codex: 액션 실행/G6 실패 시 approval 전이도 롤백.) 바깥에서 잡아 409로 매핑.
 */
class GuardError extends Error {
  constructor(public code: string, public detail: Record<string, unknown> = {}) {
    super(code);
  }
}

/**
 * Postgres unique_violation(23505) 탐지 — Drizzle은 pg 에러를 DrizzleQueryError 로 감싸 실제 code 를
 * `e.cause.code`(또는 더 깊이)에 둔다. 표층 `e.code`만 보면 놓치므로 cause 체인을 순회한다(codex #3).
 */
function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    if ((cur as { code?: string }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 지금 이 임직원에게 허용되는 라이프사이클 명령 — 서버 policy 산출.
 * candidateActions(순수 상태머신) 위에 org·G6·pending 가드 합성. (M2.4: budget 가드 추가.)
 */
function allowedActionsFor(
  emp: Pick<EmployeeRow, "kind" | "desired">,
  hasActiveReports: boolean,
  hasPendingTerminate: boolean,
  budgetBlocksResume: boolean,
): LifecycleCommand[] {
  let acts = candidateActions(emp.desired as DesiredState | null); // M3.0: 명령은 desired(intent) 기준
  // person(보안운영팀장 루트) 보호 · 활성 직속부하 있는 매니저(G6 고아 방지) · 이미 pending terminate → terminate 제거.
  if (emp.kind === "person" || hasActiveReports || hasPendingTerminate) {
    acts = acts.filter((a) => a !== "terminate");
  }
  // 예산 초과(admission 차단)면 resume 숨김(UX). 실 강제는 resume 트랜잭션의 admission 재검증(409).
  if (budgetBlocksResume) {
    acts = acts.filter((a) => a !== "resume");
  }
  return acts;
}

/** 채용 상사 조직 무결성(B4) — 존재·비종료(intent)·동일 도메인·비워커. 위반 시 에러코드, OK면 null. */
function validateManager(mgr: EmployeeRow | undefined, draftDomain: string): string | null {
  if (!mgr) return "invalid_manager";
  if (mgr.desired === "Terminated") return "manager_terminated"; // 종료 의도된 매니저 하위 채용 차단
  if (mgr.domain !== draftDomain) return "manager_domain_mismatch"; // 하위 직급은 동일 도메인 상사 아래만
  if (mgr.kind === "worker") return "manager_not_supervisor"; // 워커는 관리 직급 아님
  return null;
}

// DB row → 계약 레코드.
function toRecord(r: EmployeeRow): EmployeeRecord {
  return {
    id: r.id,
    name: r.name,
    title: r.title,
    kind: r.kind as EmployeeKind,
    domain: r.domain as EmployeeDomain | null,
    persona: r.persona,
    role: r.role,
    status: r.status as EmployeeStatus | null,
    lifecycle: r.lifecycle as LifecycleState | null, // 관측 phase(driver 보고)
    desired: r.desired as DesiredState | null, // 의도(control-plane 소유)
    runtimeMode: runtimeModeFor(r.id), // M3.2: live scope 포함 → live(kubernetes), 아니면 mock(하드코딩 제거)
    heartbeatAt: r.heartbeatAt ? r.heartbeatAt.toISOString() : null, // lastObservedAt(mock=전이 시 / live=성공 관측 tick마다 갱신)
    hotStart: r.hotStart,
    accent: r.accent,
    workspaceKey: r.workspaceKey,
    managerId: r.managerId,
    mailSendMode: (r.mailSendMode ?? "dssoc_only") as MailSendMode, // 임직원별 발송 모드(per_owner는 enable_send 승인 경유)
    createdAt: r.createdAt.toISOString(),
  };
}
const toTool = (t: ToolRow): Tool => ({ id: t.id, name: t.name, role: t.role, ownerId: t.ownerId });

function toAudit(r: AuditRow): AuditRecord {
  return {
    id: r.id,
    ts: r.ts.toISOString(),
    actor: r.actor,
    action: r.action,
    targetId: r.targetId,
    summary: r.summary,
    meta: (r.meta ?? null) as Record<string, unknown> | null,
  };
}

function toApproval(r: ApprovalRow): ApprovalRecord {
  return {
    id: r.id,
    action: r.action as ApprovalAction,
    state: r.state as ApprovalState,
    targetId: r.targetId,
    summary: r.summary,
    payload: (r.payload ?? null) as Record<string, unknown> | null,
    requestedBy: r.requestedBy,
    requestedByName: r.requestedByName,
    gate: r.gate,
    note: r.note,
    decidedBy: r.decidedBy,
    decidedByName: r.decidedByName,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
  };
}

// 명부 정렬: 도메인 → 직급 → 이름 (root/hr 우선).
const DOMAIN_RANK: Record<string, number> = { "": 0, smb: 1, dev_web: 2, github: 3, confluence: 4 };
const KIND_RANK: Record<string, number> = { person: 0, hr: 1, orchestrator: 2, strategy: 3, partlead: 4, worker: 5 };
function rosterSort(a: EmployeeRecord, b: EmployeeRecord): number {
  const dr = (DOMAIN_RANK[a.domain ?? ""] ?? 9) - (DOMAIN_RANK[b.domain ?? ""] ?? 9);
  if (dr) return dr;
  const kr = (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9);
  if (kr) return kr;
  return a.name.localeCompare(b.name, "ko");
}

// liveness — 프로세스 생존만(DB 미접촉). DB 준비상태는 /readyz 로 별도 확인(cx-13).
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "digisecu-control-plane", milestone: "M2" });
});

// readiness — digisecu_control 왕복 가능한지 SELECT 1(+타임아웃). threat_hunter 는 접근 안 함.
app.get("/readyz", async (_req, res) => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("db_timeout")), 2000);
  });
  try {
    await Promise.race([pool.query("select 1"), timeout]);
    res.json({ ready: true, db: "digisecu_control" });
  } catch (e) {
    res.status(503).json({ ready: false, db: "digisecu_control", error: (e as Error).message });
  } finally {
    if (timer) clearTimeout(timer);
  }
});

// 명부 목록.
app.get("/api/employees", async (req, res) => {
  const parsed = RosterQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_query", detail: parsed.error.flatten() });
    return;
  }
  const q = parsed.data;
  const filters = [
    q.domain ? eq(employees.domain, q.domain) : undefined,
    q.kind ? eq(employees.kind, q.kind) : undefined,
    q.status ? eq(employees.status, q.status) : undefined,
    q.lifecycle ? eq(employees.lifecycle, q.lifecycle) : undefined,
  ].filter(Boolean);

  const rows = await db.select().from(employees).where(filters.length ? and(...filters) : undefined);
  const list = rows.map(toRecord).sort(rosterSort);
  res.json(RosterListResponse.parse({ employees: list, total: list.length }));
});

// 감사로그 — 최근순 + 주체·분류 필터 + 전체 카운트(로비 최근활동 슬라이스 + M1.5 뷰어).
app.get("/api/audit", async (req, res) => {
  const parsed = AuditQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_query", detail: parsed.error.flatten() });
    return;
  }
  const q = parsed.data;
  const limit = q.limit ?? 20;

  // 분류 → action 집합. other = 알려진 action 외.
  const knownActions = Object.keys(AUDIT_ACTION_META);
  let actionFilter;
  if (q.category === "other") {
    actionFilter = notInArray(auditLog.action, knownActions);
  } else if (q.category) {
    const acts = knownActions.filter((a) => AUDIT_ACTION_META[a]?.category === q.category);
    if (acts.length) actionFilter = inArray(auditLog.action, acts);
  }
  // ★ 티켓 단위 조회 — `meta.domain`·`meta.threadId` 로 좁힌다(2026-09-01).
  //   워크스페이스가 "이 티켓에 무슨 일이 있었나" 를 그리는 유일한 경로다.
  //   ⚠️ jsonb 필드 비교라 인덱스를 안 탄다. 그래서 **둘 다 있을 때만** 건다 —
  //      한쪽만으로 전체 감사를 훑으면 느려진다.
  const threadFilter =
    q.domain && q.threadId
      ? sql`${auditLog.meta}->>'domain' = ${q.domain} AND (${auditLog.meta}->>'threadId')::int = ${q.threadId}`
      : undefined;
  const filters = [
    q.actor ? eq(auditLog.actor, q.actor) : undefined,
    actionFilter,
    threadFilter,
  ].filter(Boolean);
  const where = filters.length ? and(...filters) : undefined;

  const rows = await db.select().from(auditLog).where(where).orderBy(desc(auditLog.ts)).limit(limit);
  const [cnt] = await db.select({ c: count() }).from(auditLog).where(where);
  res.json(AuditListResponse.parse({ events: rows.map(toAudit), total: cnt?.c ?? 0 }));
});

// 워크스페이스 정적 레지스트리 — 구조만(도메인상태 없음). read-only. (M2.3)
app.get("/api/workspaces", (_req, res) => {
  res.json(WorkspaceListResponse.parse({ workspaces: WORKSPACE_REGISTRY }));
});

// ── 트리아지 오버레이(제품 소유) — finding 관리 상태·코멘트 영속. finding 자체는 게이트웨이(threat_hunter) 소유. ──
function toTriageNote(n: FindingTriageNoteRow): TriageNote {
  return { id: n.id, body: n.body, actor: n.actor, at: n.createdAt.toISOString() };
}
function toTriageRecord(ref: string, row: FindingTriageRow | undefined, notes: FindingTriageNoteRow[]): TriageRecord {
  return {
    findingRef: ref,
    status: (row?.status ?? "unclassified") as TriageStatus,
    version: row?.version ?? 0, // 0 = 상태 미영속(코멘트만 있거나 전무)
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    notes: notes.map(toTriageNote),
  };
}

// 노트 응답 상한(codex #6): 단건 ref 최근 N, 배치 전체 안전 상한. 분석가 note 원문 노출 방지 위해 조회도 운영자 인증(#2).
const TRIAGE_NOTES_PER_REF = 200;
const TRIAGE_BATCH_NOTES_CAP = 2000;

// 배치 조회 — 요청 refs 중 상태행 또는 코멘트가 하나라도 있는 것만 반환. note 원문을 담으므로 requireApprover(프록시가 토큰 주입).
app.get("/api/triage", async (req, res) => {
  if (!requireApprover(req, res)) return;
  const parsed = TriageBatchQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_query", detail: parsed.error.flatten() });
    return;
  }
  const refs = Array.from(new Set(parsed.data.refs.split(",").map((r) => r.trim()).filter(Boolean))).slice(0, 200);
  if (refs.length === 0) {
    res.json(TriageBatchResponse.parse({ items: [] }));
    return;
  }
  const rows = await db.select().from(findingTriage).where(inArray(findingTriage.findingRef, refs));
  const notes = await db.select().from(findingTriageNote)
    .where(inArray(findingTriageNote.findingRef, refs))
    .orderBy(asc(findingTriageNote.createdAt), asc(findingTriageNote.id))
    .limit(TRIAGE_BATCH_NOTES_CAP);
  const rowByRef = new Map(rows.map((r) => [r.findingRef, r]));
  const notesByRef = new Map<string, FindingTriageNoteRow[]>();
  for (const n of notes) {
    const arr = notesByRef.get(n.findingRef) ?? [];
    arr.push(n);
    notesByRef.set(n.findingRef, arr);
  }
  const present = new Set<string>([...rowByRef.keys(), ...notesByRef.keys()]);
  const items = [...present].map((ref) => toTriageRecord(ref, rowByRef.get(ref), notesByRef.get(ref) ?? []));
  res.json(TriageBatchResponse.parse({ items }));
});

// 상태 변경 — 낙관적 동시성(expectedVersion). requireApprover(운영자만) + 감사(원문 미복제) 동일 tx.
app.post("/api/triage/status", async (req, res) => {
  if (!requireApprover(req, res)) return;
  const parsed = SetTriageStatusRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
    return;
  }
  const { findingRef, status, expectedVersion } = parsed.data;
  try {
    const record = await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(findingTriage).where(eq(findingTriage.findingRef, findingRef)).for("update");
      const curVersion = cur?.version ?? 0;
      if (curVersion !== expectedVersion) {
        throw new GuardError("version_conflict", { findingRef, expected: expectedVersion, actual: curVersion });
      }
      let saved: FindingTriageRow | undefined;
      if (!cur) {
        [saved] = await tx.insert(findingTriage)
          .values({ findingRef, status, version: 1, updatedBy: APPROVER.id })
          .returning();
      } else {
        [saved] = await tx.update(findingTriage)
          .set({ status, version: cur.version + 1, updatedBy: APPROVER.id, updatedAt: new Date() })
          .where(and(eq(findingTriage.findingRef, findingRef), eq(findingTriage.version, expectedVersion)))
          .returning();
      }
      if (!saved) throw new GuardError("version_conflict", { findingRef, expected: expectedVersion });
      await tx.insert(auditLog).values({
        id: randomUUID(), actor: APPROVER.id, action: "triage_status_changed", targetId: findingRef,
        summary: `트리아지 상태 ${cur?.status ?? "unclassified"}→${status}`,
        meta: { findingRef, from: cur?.status ?? "unclassified", to: status, version: saved.version },
      });
      const notesDesc = await tx.select().from(findingTriageNote).where(eq(findingTriageNote.findingRef, findingRef))
        .orderBy(desc(findingTriageNote.createdAt), desc(findingTriageNote.id)).limit(TRIAGE_NOTES_PER_REF);
      return toTriageRecord(findingRef, saved, notesDesc.reverse());
    });
    res.json(record);
  } catch (e) {
    if (e instanceof GuardError) {
      res.status(e.code === "version_conflict" ? 409 : 400).json({ error: e.code, ...e.detail });
      return;
    }
    // 신규 ref 동시 INSERT 경합: FOR UPDATE는 미존재 행을 못 잠그므로 패자가 PK unique violation(23505).
    // 이는 곧 다른 tx가 먼저 v1을 만든 것 → version_conflict 로 매핑(500 아님). Drizzle wrap 대비 cause 체인 순회.
    if (isUniqueViolation(e)) {
      res.status(409).json({ error: "version_conflict", findingRef, expected: expectedVersion, actual: 1 });
      return;
    }
    throw e;
  }
});

// 코멘트 추가 — append-only. requireApprover + 감사(원문 미복제, 길이만) 동일 tx.
app.post("/api/triage/note", async (req, res) => {
  if (!requireApprover(req, res)) return;
  const parsed = AddTriageNoteRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
    return;
  }
  const { findingRef, body } = parsed.data;
  const record = await db.transaction(async (tx) => {
    const noteId = randomUUID();
    await tx.insert(findingTriageNote).values({ id: noteId, findingRef, body, actor: APPROVER.id });
    await tx.insert(auditLog).values({
      id: randomUUID(), actor: APPROVER.id, action: "triage_note_added", targetId: findingRef,
      summary: "트리아지 코멘트 추가", // 원문은 감사에 복제하지 않음
      meta: { findingRef, noteId, length: body.length },
    });
    const [row] = await tx.select().from(findingTriage).where(eq(findingTriage.findingRef, findingRef));
    const notesDesc = await tx.select().from(findingTriageNote).where(eq(findingTriageNote.findingRef, findingRef))
      .orderBy(desc(findingTriageNote.createdAt), desc(findingTriageNote.id)).limit(TRIAGE_NOTES_PER_REF);
    return toTriageRecord(findingRef, row, notesDesc.reverse());
  });
  res.json(record);
});

// 조직도 — 전체 명부(정렬) + 전체 도구. web이 트리 조립(M1.3).
app.get("/api/org", async (_req, res) => {
  const emps = (await db.select().from(employees)).map(toRecord).sort(rosterSort);
  const tls = (await db.select().from(tools)).map(toTool);
  res.json(OrgResponse.parse({ employees: emps, tools: tls }));
});

// 상세.
app.get("/api/employees/:id", async (req, res) => {
  const id = req.params.id;
  const [row] = await db.select().from(employees).where(eq(employees.id, id));
  if (!row) {
    res.status(404).json({ error: "not_found", id });
    return;
  }
  const emp = toRecord(row);

  const manager = emp.managerId
    ? (await db.select().from(employees).where(eq(employees.id, emp.managerId)))[0]
    : undefined;
  const reports = await db.select().from(employees).where(eq(employees.managerId, id));
  const owned = await db.select().from(tools).where(eq(tools.ownerId, id));

  // 허용 명령 산출 — 활성 직속부하(G6)·중복 pending terminate·예산(admission) 가드용 사실을 모아 policy 합성.
  const hasActiveReports = reports.some((r) => r.lifecycle !== "Terminated");
  const [pendingTerm] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.action, "terminate"), eq(approvals.targetId, id), eq(approvals.state, "pending")));
  const admission = await computeAdmission(id, row.budgetMonthlyCents);

  res.json(
    EmployeeDetailResponse.parse({
      employee: emp,
      manager: manager ? toRecord(manager) : null,
      reports: reports.map(toRecord).sort(rosterSort),
      tools: owned.map(toTool),
      allowedActions: allowedActionsFor(row, hasActiveReports, Boolean(pendingTerm), admission.blocksAdmission),
      admission,
    }),
  );
});

// ── M1.2 쓰기: 채용 제안 (→ pending 승인, fail-closed) ────────────────────
/**
 * 콘솔 발송 요청 — ★ 여기서 **보내지 않는다.** 승인 대기만 만든다.
 *
 * 되돌릴 수 없는 바깥 행위라 채용과 같은 승인 게이트를 태운다.
 * ⚠️ 요청 본문에 **메일 내용이 없다**(도메인·스레드번호뿐). 담으면 그게 곧 2026-08-25 에
 *    지운 `/api/findings/owner-mail-send` 다 — 요청 본문을 그대로 Knox MCP 로 보내던 문.
 *    수신자·제목·본문은 발송 시점에 서버(파이썬)가 DB 에서 다시 읽는다.
 */
app.post("/api/mail-sends", async (req, res) => {
  const parsed = MailSendDraft.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
    return;
  }
  const draft = parsed.data;
  const id = randomUUID();
  const summary = `${draft.domain} 스레드 ${draft.threadId} 조치요청 메일 발송`;
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .insert(approvals)
      .values({
        id,
        action: "send_mail",
        state: "pending",
        targetId: null,
        summary,
        payload: draft,
        requestedBy: REQUESTER.id,
        requestedByName: REQUESTER.name,
        gate: "fail_closed",
      })
      .returning();
    await tx.insert(auditLog).values({
      id: randomUUID(),
      actor: REQUESTER.id,
      action: "send_mail_requested",
      targetId: null,
      summary,
      meta: { approvalId: id, domain: draft.domain, threadId: draft.threadId },
    });
    return r;
  });
  res.status(201).json(ApprovalResponse.parse({ approval: toApproval(row!) }));
});

/**
 * 담당자 지정 요청 — 티켓의 담당자를 사람이 고른 사람으로 바꾼다.
 *
 * 발송과 같은 승인 게이트를 태운다. 담당자를 바꾸면 **다음 메일이 그 사람에게 간다** —
 * 되돌릴 수 있지만 그 사이에 나간 메일은 되돌릴 수 없다.
 * ⚠️ 본문에 이름·부서를 담지 않는다. Knox 가 정본이고 서버가 조회한다.
 */
/**
 * 티켓 상태 지정 — 사람이 콘솔 필터와 **같은 어휘**로 티켓 상태를 고친다.
 *
 * ## 왜 승인 큐를 안 타나 (담당자 지정과 다른 점)
 *
 * `set_owner` 는 **다음 메일의 수신처**를 바꾼다 — 틀리면 남에게 나간다. 그래서 승인이다.
 * 상태 지정은 운영자가 자기 큐를 정리하는 일상 행위라 같은 무게를 씌우면 아무도 안 쓴다.
 * 대신 트리아지 라우트와 같은 문(`requireApprover`)을 쓰고 감사로그를 남긴다 —
 * **누가 언제 무엇을 무엇으로** 는 반드시 남는다.
 *
 * ⚠️ `replied`(회신 옴)로 바꾸면 공용 러너가 그 스레드를 집어 **회신 메일을 보낸다.**
 *    되돌릴 수 없다 — 화면이 누르기 전에 그렇게 말한다(`TICKET_STATUS_DRIVES_PIPELINE`).
 */
app.post("/api/ticket-status", async (req, res) => {
  if (!requireApprover(req, res)) return;
  const parsed = TicketStatusDraft.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
    return;
  }
  const draft = parsed.data;
  const out = await runTicketStatus(draft.domain, draft.threadId, draft.status, APPROVER.id);
  if (!out.ok) {
    // ★ CLI 종료코드를 그대로 옮긴다. 2=못 함(스레드 없음·이미 그 상태) 는 400 이고
    //   1=해석 실패/크래시 는 500 이다 — 둘을 같은 칸에 넣으면 운영자가 고장과
    //   "원래 안 되는 것" 을 구분 못 한다.
    const status = out.code === 2 || out.code === 3 ? 400 : 500;
    await db.insert(auditLog).values({
      id: randomUUID(), actor: APPROVER.id, action: "ticket_status_failed", targetId: null,
      summary: `${draft.domain} 스레드 ${draft.threadId} 상태 변경 실패`,
      meta: { domain: draft.domain, threadId: draft.threadId, to: draft.status, error: out.error },
    });
    res.status(status).json({ error: "ticket_status_failed", detail: out.error });
    return;
  }
  const result = out.result as Record<string, unknown>;
  await db.insert(auditLog).values({
    id: randomUUID(), actor: APPROVER.id, action: "ticket_status_changed", targetId: null,
    summary: `티켓 상태 ${String(result.previous ?? "?")} → ${String(result.status ?? draft.status)}`,
    meta: {
      domain: draft.domain, threadId: draft.threadId,
      from: result.previous ?? null, to: result.status ?? null, ticketStatus: draft.status,
    },
  });
  res.json(result);
});

app.post("/api/owner-assigns", async (req, res) => {
  const parsed = OwnerAssignDraft.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
    return;
  }
  const draft = parsed.data;
  const id = randomUUID();
  const summary = `${draft.domain} 스레드 ${draft.threadId} 담당자 지정 → ${draft.knoxId}`;
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .insert(approvals)
      .values({
        id,
        action: "set_owner",
        state: "pending",
        targetId: null,
        summary,
        payload: draft,
        requestedBy: REQUESTER.id,
        requestedByName: REQUESTER.name,
        gate: "fail_closed",
      })
      .returning();
    await tx.insert(auditLog).values({
      id: randomUUID(),
      actor: REQUESTER.id,
      action: "set_owner_requested",
      targetId: null,
      summary,
      meta: { approvalId: id, domain: draft.domain, threadId: draft.threadId, knoxId: draft.knoxId },
    });
    return r;
  });
  res.status(201).json(ApprovalResponse.parse({ approval: toApproval(row!) }));
});

app.post("/api/hires", async (req, res) => {
  const parsed = HireRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
    return;
  }
  const draft = parsed.data;
  // 상사 조직 무결성 서버검증(B4: UI 제약을 API에서도 강제 — 교차도메인·워커·종료 매니저 차단).
  const [mgr] = await db.select().from(employees).where(eq(employees.id, draft.managerId));
  if (!mgr) {
    res.status(400).json({ error: "invalid_manager", managerId: draft.managerId });
    return;
  }
  const mgrErr = validateManager(mgr, draft.domain);
  if (mgrErr) {
    res.status(400).json({ error: mgrErr, managerId: draft.managerId });
    return;
  }
  const id = randomUUID();
  const summary = `${draft.name} · ${draft.domain} · ${KIND_LABEL_KO[draft.kind] ?? draft.kind} 채용 (상사 ${mgr.name})`;
  // 승인 생성 + 감사쓰기를 한 트랜잭션으로 (approve/reject와 대칭 — 부분커밋 방지).
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .insert(approvals)
      .values({
        id,
        action: "hire",
        state: "pending",
        targetId: null,
        summary,
        payload: draft,
        requestedBy: REQUESTER.id,
        requestedByName: REQUESTER.name,
        gate: "fail_closed",
      })
      .returning();
    await tx.insert(auditLog).values({
      id: randomUUID(),
      actor: REQUESTER.id,
      action: "hire_requested",
      targetId: null,
      summary,
      meta: { approvalId: id },
    });
    return r;
  });
  res.status(201).json(ApprovalResponse.parse({ approval: toApproval(row!) }));
});

// 승인 목록 (+pendingCount).
app.get("/api/approvals", async (req, res) => {
  const stateRaw = req.query.state;
  const s = typeof stateRaw === "string" && stateRaw.length > 0 ? ApprovalState.safeParse(stateRaw) : null;
  if (s && !s.success) {
    res.status(400).json({ error: "bad_query", detail: s.error.flatten() });
    return;
  }
  const filter = s && s.success ? eq(approvals.state, s.data) : undefined;
  const rows = await db.select().from(approvals).where(filter).orderBy(desc(approvals.createdAt));
  const all = await db.select({ state: approvals.state }).from(approvals);
  const pendingCount = all.filter((a) => a.state === "pending").length;
  res.json(
    ApprovalListResponse.parse({ approvals: rows.map(toApproval), pendingCount, total: all.length }),
  );
});

// 승인 상세.
app.get("/api/approvals/:id", async (req, res) => {
  const id = req.params.id;
  const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
  if (!row) {
    res.status(404).json({ error: "not_found", id });
    return;
  }
  res.json(ApprovalResponse.parse({ approval: toApproval(row) }));
});

// 승인 — 원자 전이(WHERE state='pending') + 액션 실행. 멱등: 재승인은 409.
app.post("/api/approvals/:id/approve", async (req, res) => {
  // P4 하드닝: 승인 실행은 승인자 토큰(사람)만 — 자율 에이전트 self-approve 차단.
  if (!requireApprover(req, res)) return;
  const parsed = ApprovalDecision.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
    return;
  }
  const id = req.params.id;
  const note = parsed.data.note ?? null;

  try {
    const result = await db.transaction(async (tx) => {
      const [appr] = await tx.select().from(approvals).where(eq(approvals.id, id));
      if (!appr) return { kind: "not_found" as const };
      if (appr.state !== "pending") return { kind: "conflict" as const, row: appr };
      // SoD: 요청자는 자기 요청을 승인 못 한다(요청자≠승인자). 신원이 실체화되면 실효.
      if (appr.requestedBy === APPROVER.id) return { kind: "self_approval" as const, row: appr };

      // targetId 있는 액션(terminate/budget_override)은 대상 employee를 approval CAS **전에** 잠근다 —
      // 요청 경로(employee→approval)와 lock 순서를 통일해 request↔approve deadlock(codex#8) 방지.
      let lockedTarget: EmployeeRow | undefined;
      if (appr.targetId) {
        [lockedTarget] = await tx.select().from(employees).where(eq(employees.id, appr.targetId)).for("update");
      }

      const [updated] = await tx
        .update(approvals)
        .set({ state: "approved", decidedBy: APPROVER.id, decidedByName: APPROVER.name, note, decidedAt: new Date() })
        .where(and(eq(approvals.id, id), eq(approvals.state, "pending")))
        .returning();
      if (!updated) return { kind: "conflict" as const, row: appr };

      if (appr.action === "hire") {
        const draft = HireDraft.parse(appr.payload);
        // 승인시점 매니저 재검증 — 행 잠금(FOR UPDATE)으로 동시 매니저 terminate 승인과 직렬화(TOCTOU 봉쇄).
        const [mgr] = await tx.select().from(employees).where(eq(employees.id, draft.managerId)).for("update");
        const mgrErr = validateManager(mgr, draft.domain); // B4: 도메인·직급·비종료 재검증
        if (mgrErr) throw new GuardError(mgrErr, { managerId: draft.managerId });
        // budget=0 이면 태어날 때부터 예산 초과(0>=0) → desired=Paused. M3.0: 실 Provisioning 관측(드라이버가 수렴).
        const bornPaused = draft.budgetMonthlyCents === 0;
        const empId = randomUUID();
        await tx.insert(employees).values({
          id: empId,
          name: draft.name,
          title: draft.title,
          kind: draft.kind,
          domain: draft.domain,
          persona: draft.persona,
          role: draft.role,
          status: "working", // 의도 presence. observed→Paused 시 드라이버가 'paused'로 보정.
          lifecycle: "Provisioning", // observed phase — 드라이버가 desired 향해 Provisioning→Running|Paused 수렴.
          desired: bornPaused ? "Paused" : "Running", // 의도
          hotStart: false,
          accent: DOMAIN_ACCENT[draft.domain] ?? null,
          workspaceKey: draft.domain,
          managerId: draft.managerId,
          budgetMonthlyCents: draft.budgetMonthlyCents,
          mailSendMode: "dssoc_only", // per_owner는 M5 enable_send 게이트 경유만 — 채용 승인으로는 dev-safe 고정
        });
        // 승인만 기록 — 실 provisioned(→Running) 감사는 mock 드라이버가 수렴 시 emit.
        await tx.insert(auditLog).values({
          id: randomUUID(), actor: APPROVER.id, action: "hire_approved", targetId: empId,
          summary: `${draft.name} 채용 승인 → 프로비저닝(desired ${bornPaused ? "Paused" : "Running"})`, meta: { approvalId: id },
        });
        return { kind: "ok" as const, row: updated };
      }

      if (appr.action === "terminate" && appr.targetId) {
        // 대상은 CAS 전에 이미 잠금됨(lockedTarget) — 동시 hire(매니저 잠금)와 직렬화(TOCTOU 봉쇄).
        const tgt = lockedTarget;
        if (!tgt) throw new GuardError("target_not_found", { targetId: appr.targetId });
        if (tgt.desired === "Terminated") throw new GuardError("already_terminated", { id: appr.targetId }); // 이미 종료 의도됨
        // G6: 활성 직속부하 있으면 종료 차단(고아 방지). observed !== Terminated 를 활성으로(Draining도 아직 present).
        const reps = await tx.select({ life: employees.lifecycle }).from(employees).where(eq(employees.managerId, appr.targetId));
        const activeReports = reps.filter((r) => r.life !== "Terminated").length;
        if (activeReports > 0) throw new GuardError("has_active_reports", { id: appr.targetId, activeReports });
        // desired=Terminated 로 CAS(desired ∈ Running|Paused 에서만). 실 Draining→Terminated 는 드라이버가 수렴.
        const [u] = await tx
          .update(employees)
          .set({ desired: "Terminated" })
          .where(and(eq(employees.id, appr.targetId), inArray(employees.desired, [...TERMINABLE_FROM])))
          .returning();
        if (!u) throw new GuardError("already_terminated", { id: appr.targetId });
        // "terminated" 감사는 observed 가 Terminated 에 도달할 때 드라이버가 emit(실제 종료 시점).
        return { kind: "ok" as const, row: updated };
      }

      if (appr.action === "budget_override" && appr.targetId) {
        // 대상은 CAS 전에 이미 잠금됨(lockedTarget) — usage/resume와 직렬화.
        const tgt = lockedTarget;
        if (!tgt) throw new GuardError("target_not_found", { targetId: appr.targetId });
        // A5: 승인 시점 종료 의도 재검증 — 요청 후 종료 의도됐으면 쓸 수 없는 grant 방지(롤백→pending 유지).
        if (tgt.desired === "Terminated") throw new GuardError("already_terminated", { id: appr.targetId });
        const payload = (appr.payload ?? {}) as { additionalLimitCents?: number; periodStart?: string };
        const additional = payload.additionalLimitCents;
        const periodStart = payload.periodStart;
        if (typeof additional !== "number" || additional <= 0 || !periodStart) {
          throw new GuardError("bad_override_payload", { approvalId: id });
        }
        // stale period 거부 — 지난달 pending은 자동 현재월 변경 없이 재요청해야 한다(codex).
        if (periodStart !== currentPeriodStart()) {
          throw new GuardError("stale_period", { approvalId: id, periodStart, current: currentPeriodStart() });
        }
        // grant 영속(approval_id UNIQUE=멱등). 자동재개 없음 — lifecycle 그대로, 명시적 resume 재요구.
        await tx.insert(budgetGrants).values({
          id: randomUUID(), employeeId: appr.targetId, periodStart, additionalLimitCents: additional, approvalId: id, actor: APPROVER.id,
        });
        await tx.insert(auditLog).values({ id: randomUUID(), actor: APPROVER.id, action: "budget_override_approved", targetId: appr.targetId, summary: appr.summary ?? "예산 상향 승인", meta: { approvalId: id, additionalLimitCents: additional, periodStart } });
        return { kind: "ok" as const, row: updated };
      }

      // delete_pod = 런타임 회수(2단계 종료의 2단계) — CR/파드 최종 삭제. 실제 CR delete는 승인 트랜잭션이
      // 아니라 드라이버 tick이 비동기·멱등 수행(되돌릴 수 없는 K8s 콜을 롤백 경계·FOR UPDATE 락 안에 두지 않음).
      if (appr.action === "delete_pod" && appr.targetId) {
        const tgt = lockedTarget; // targetId 액션이라 CAS 전에 FOR UPDATE 잠금됨
        if (!tgt) throw new GuardError("target_not_found", { targetId: appr.targetId });
        // 게이트 = 관측 lifecycle===Terminated(파드 실제 회수 완료). desired만으론 부족(Draining 중 삭제 시 감사 누락).
        // Terminated는 흡수 상태(탈출 없음)라 잠금 하 재검증만으로 충분(TOCTOU 없음).
        if (tgt.lifecycle !== "Terminated") throw new GuardError("not_terminated", { id: appr.targetId, lifecycle: tgt.lifecycle });
        await tx.insert(auditLog).values({
          id: randomUUID(), actor: APPROVER.id, action: "runtime_reclaim_approved", targetId: appr.targetId,
          summary: appr.summary ?? `${tgt.name} 런타임 회수 승인`, meta: { approvalId: id, note: "CR 삭제는 드라이버가 비동기 수행" },
        });
        return { kind: "ok" as const, row: updated };
      }

      // enable_send(M5) — per-owner 발송 활성화. 락 하 §6 재검증(TOCTOU 봉쇄) 후 mail_send_mode=per_owner 전환.
      // 주의: 이 효과는 control-plane DB intent(거버넌스)만 바꾼다. 실 egress는 런타임 게이트(SMB_REMEDIATION_MAIL_MODE
      // + SA_DELIVERY_RECIPIENT_ALLOW=dssoc+shaneee.baek + Knox MCP + redact scan)가 별도로 fail-closed 강제한다.
      if (appr.action === "enable_send" && appr.targetId) {
        const tgt = lockedTarget; // targetId 액션 → CAS 전 FOR UPDATE 잠금됨
        if (!tgt) throw new GuardError("target_not_found", { targetId: appr.targetId });
        if (tgt.desired === "Terminated" || tgt.lifecycle === "Terminated") throw new GuardError("employee_terminated", { id: appr.targetId });
        if (tgt.kind !== "worker" || !tgt.domain) throw new GuardError("not_send_capable", { id: appr.targetId, kind: tgt.kind }); // 발송 주체(도메인 워커)만
        await tx.update(employees).set({ mailSendMode: "per_owner" }).where(eq(employees.id, appr.targetId));
        await tx.insert(auditLog).values({
          id: randomUUID(), actor: APPROVER.id, action: "enable_send_approved", targetId: appr.targetId,
          summary: appr.summary ?? `${tgt.name} 개별발송(per_owner) 활성화 승인`,
          meta: { approvalId: id, mailSendMode: "per_owner", recipientPolicy: "런타임 egress allowlist(dssoc+shaneee.baek)가 실제 강제" },
        });
        return { kind: "ok" as const, row: updated };
      }

      // 그 외 미배선 액션 — 승인만 기록(폴백).
      await tx.insert(auditLog).values({ id: randomUUID(), actor: APPROVER.id, action: `${appr.action}_approved`, targetId: appr.targetId, summary: appr.summary ?? appr.action, meta: { approvalId: id, note: "no-op (미배선)" } });
      return { kind: "ok" as const, row: updated };
    });

    if (result.kind === "not_found") {
      res.status(404).json({ error: "not_found", id });
      return;
    }
    if (result.kind === "conflict") {
      res.status(409).json({ error: "not_pending", approval: toApproval(result.row) });
      return;
    }
    if (result.kind === "self_approval") {
      res.status(409).json({ error: "self_approval", detail: "요청자는 자기 요청을 승인할 수 없다", approval: toApproval(result.row) });
      return;
    }
    // ★★ 발송은 **트랜잭션이 커밋된 뒤** 별도 단계로 한다.
    //    메일은 회수 경로가 없어서, 트랜잭션 안에서 보내면 롤백이 '보낸 메일' 을
    //    되돌리지 못한 채 DB 만 되돌아간다(delete_pod 분기가 이미 경계한 함정).
    if (result.row.action === "set_owner") {
      const draft = OwnerAssignDraft.safeParse(result.row.payload);
      if (!draft.success) {
        res.status(500).json({ error: "bad_payload", detail: draft.error.flatten() });
        return;
      }
      const out = await runOwnerAssign(
        draft.data.domain, draft.data.threadId, draft.data.knoxId, APPROVER.id);
      await db.insert(auditLog).values({
        id: randomUUID(),
        actor: APPROVER.id,
        action: out.ok ? "set_owner_executed" : "set_owner_failed",
        targetId: null,
        summary: result.row.summary ?? "set_owner",
        meta: { approvalId: id, ...(out.ok ? out.result : { error: out.error, code: out.code }) },
      });
      if (!out.ok) {
        res.status(422).json({ error: "owner_assign_failed", detail: out.error,
                               approval: toApproval(result.row) });
        return;
      }
      res.json({ approval: toApproval(result.row), result: out.result });
      return;
    }
    if (result.row.action === "send_mail") {
      const draft = MailSendDraft.safeParse(result.row.payload);
      if (!draft.success) {
        res.status(500).json({ error: "bad_payload", detail: draft.error.flatten() });
        return;
      }
      const out = await runMailSend(draft.data.domain, draft.data.threadId, APPROVER.id);
      // 결과를 감사에 남긴다 — **차단도 남긴다.** 안 남기면 "왜 안 갔지" 를 못 되짚는다.
      await db.insert(auditLog).values({
        id: randomUUID(),
        actor: APPROVER.id,
        action: out.ok ? "send_mail_executed" : "send_mail_failed",
        targetId: null,
        summary: result.row.summary ?? "send_mail",
        meta: { approvalId: id, ...(out.ok ? out.result : { error: out.error, code: out.code }) },
      });
      if (!out.ok) {
        // 실행 실패(스레드 없음·본문 없음·인자 오류). ★ 게이트 차단은 여기로 오지 않는다.
        res.status(422).json({
          error: "send_failed", detail: out.error,
          approval: toApproval(result.row),
        });
        return;
      }
      res.json({
        approval: toApproval(result.row),
        // ★ mode="dry_run" 은 오류가 아니라 게이트 판정이다 — 200 으로 내고 화면이 사유를 그린다.
        result: MailSendResult.parse(out.result),
      });
      return;
    }

    res.json(ApprovalResponse.parse({ approval: toApproval(result.row) }));
  } catch (e) {
    if (e instanceof GuardError) {
      res.status(409).json({ error: e.code, ...e.detail });
      return;
    }
    throw e;
  }
});

// 반려 — 원자 전이. hire면 임직원 미생성.
app.post("/api/approvals/:id/reject", async (req, res) => {
  // P4 하드닝: 반려도 승인자 결정 — 승인자 토큰(사람)만.
  if (!requireApprover(req, res)) return;
  const parsed = ApprovalDecision.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
    return;
  }
  const id = req.params.id;
  const note = parsed.data.note ?? null;

  const [appr] = await db.select().from(approvals).where(eq(approvals.id, id));
  if (!appr) {
    res.status(404).json({ error: "not_found", id });
    return;
  }
  if (appr.state !== "pending") {
    res.status(409).json({ error: "not_pending", approval: toApproval(appr) });
    return;
  }
  // 상태 전이 + 감사쓰기를 한 트랜잭션으로 (approve와 대칭 — 부분커밋 방지).
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(approvals)
      .set({ state: "rejected", decidedBy: APPROVER.id, decidedByName: APPROVER.name, note, decidedAt: new Date() })
      .where(and(eq(approvals.id, id), eq(approvals.state, "pending")))
      .returning();
    if (!row) return null;
    await tx.insert(auditLog).values({ id: randomUUID(), actor: APPROVER.id, action: `${appr.action}_rejected`, targetId: appr.targetId, summary: appr.summary ?? appr.action, meta: { approvalId: id } });
    return row;
  });
  if (!updated) {
    res.status(409).json({ error: "not_pending", approval: toApproval(appr) });
    return;
  }
  res.json(ApprovalResponse.parse({ approval: toApproval(updated) }));
});

// 라이프사이클 직접 전이(승인 게이트 아님, 단 P4: 운영자 토큰 필요 — 에이전트 kill-switch 무력화 차단): pause / resume.
async function transition(res: express.Response, id: string, cmd: "pause" | "resume") {
  const { from, to } = directTransition(cmd); // M3.0: desired 전이(intent). observed는 드라이버가 수렴.
  const [row] = await db.select().from(employees).where(eq(employees.id, id));
  if (!row) {
    res.status(404).json({ error: "not_found", id });
    return;
  }
  try {
    // 정책 산출 정확한 desired-from 으로 CAS + 감사 단일 트랜잭션. 0행이면 전이 불가(감사 없음).
    const updated = await db.transaction(async (tx) => {
      // resume는 재개 전 admission 재검증(하드스톱 실 강제 — allowedActions 숨김만으론 API 우회됨).
      // employee row-lock으로 동시 usage 기록과 직렬화.
      if (cmd === "resume") {
        const [locked] = await tx.select().from(employees).where(eq(employees.id, id)).for("update");
        if (!locked) throw new GuardError("not_found", { id });
        // tx로 조회(전역 db면 pool 재진입 데드락 — codex#4).
        const adm = await computeAdmission(id, locked.budgetMonthlyCents, tx);
        if (adm.blocksAdmission) throw new GuardError("blocked_over_budget", { id, admission: adm });
      }
      const [u] = await tx
        .update(employees)
        .set({ desired: to })
        .where(and(eq(employees.id, id), eq(employees.desired, from)))
        .returning();
      if (!u) return null;
      await tx.insert(auditLog).values({
        id: randomUUID(),
        actor: APPROVER.id,
        action: cmd === "pause" ? "paused" : "resumed",
        targetId: id,
        summary: `${row.name} ${cmd === "pause" ? "일시정지" : "재개"}(의도)`,
        meta: null,
      });
      return u;
    });
    if (!updated) {
      // 현재 desired 가 요구 from 이 아님(Terminated거나 이미 목표 intent) → 전이 불가.
      res.status(409).json({ error: "invalid_transition", id, command: cmd, from: row.desired, expected: from });
      return;
    }
    res.json({ employee: EmployeeRecord.parse(toRecord(updated)) });
  } catch (e) {
    if (e instanceof GuardError) {
      res.status(e.code === "not_found" ? 404 : 409).json({ error: e.code, ...e.detail });
      return;
    }
    throw e;
  }
}
app.post("/api/employees/:id/pause", async (req, res) => { if (!requireApprover(req, res)) return; await transition(res, req.params.id, "pause"); });
app.post("/api/employees/:id/resume", async (req, res) => { if (!requireApprover(req, res)) return; await transition(res, req.params.id, "resume"); });

// 퇴사 — 승인 요청 생성(게이트). 루트 보호. 사전검사·insert·dedup 재조회를 employee 잠금 아래 단일 트랜잭션으로
// (B5 TOCTOU 제거·A2 폴백 널참조 제거: 잠금 보유 중이라 기존 pending이 동시 결정될 수 없어 안전 재조회).
app.post("/api/employees/:id/terminate", async (req, res) => {
  const id = req.params.id;
  try {
    const result = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(employees).where(eq(employees.id, id)).for("update");
      if (!row) throw new GuardError("not_found", { id });
      if (row.kind === "person") throw new GuardError("cannot_terminate_root", { id });
      if (row.desired === "Terminated") throw new GuardError("already_terminated", { id });
      const reps = await tx.select({ life: employees.lifecycle }).from(employees).where(eq(employees.managerId, id));
      const activeReports = reps.filter((r) => r.life !== "Terminated").length;
      if (activeReports > 0) throw new GuardError("has_active_reports", { id, activeReports });
      const apprId = randomUUID();
      const summary = `${row.name}(${row.title ?? KIND_LABEL_KO[row.kind] ?? row.kind}) 퇴사`;
      const [a] = await tx
        .insert(approvals)
        .values({
          id: apprId, action: "terminate", state: "pending", targetId: id, summary,
          payload: { targetId: id, targetName: row.name, domain: row.domain },
          requestedBy: REQUESTER.id, requestedByName: REQUESTER.name, gate: "fail_closed",
        })
        .onConflictDoNothing({ target: [approvals.action, approvals.targetId], where: sql`${approvals.state} = 'pending'` })
        .returning();
      if (a) {
        await tx.insert(auditLog).values({ id: randomUUID(), actor: REQUESTER.id, action: "terminate_requested", targetId: id, summary, meta: { approvalId: apprId } });
        return { created: true as const, row: a };
      }
      // 충돌 = 이미 pending. employee 잠금 보유 중이라 그 pending은 동시 결정 불가 → 안전 재조회.
      const [existing] = await tx.select().from(approvals).where(and(eq(approvals.action, "terminate"), eq(approvals.targetId, id), eq(approvals.state, "pending")));
      if (!existing) throw new GuardError("conflict_no_pending", { id });
      return { created: false as const, row: existing };
    });
    res.status(result.created ? 201 : 200).json(ApprovalResponse.parse({ approval: toApproval(result.row) }));
  } catch (e) {
    if (e instanceof GuardError) {
      const status = e.code === "not_found" ? 404 : e.code === "cannot_terminate_root" ? 400 : 409;
      res.status(status).json({ error: e.code, ...e.detail });
      return;
    }
    throw e;
  }
});

// 수동 사용액 기록(dev/demo) — 증가 전용. 실 spend 소스는 M3 파드 텔레메트리(같은 포트).
app.post("/api/employees/:id/usage", async (req, res) => {
  if (!requireApprover(req, res)) return; // P4: 사용액 기록(원장→하드스톱)도 운영자만 — 위조 spend DoS 차단(codex B).
  if (!DEV_USAGE_ENABLED) {
    res.status(403).json({ error: "dev_usage_disabled" });
    return;
  }
  const parsed = UsageRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
    return;
  }
  const { amountCents, idempotencyKey, note } = parsed.data;
  const id = req.params.id;
  try {
    const emp = await db.transaction(async (tx) => {
      const [e] = await tx.select().from(employees).where(eq(employees.id, id)).for("update");
      if (!e) throw new GuardError("not_found", { id });
      // idempotency 원자 claim(A3): 전역 unique(idempotency_key)에 onConflictDoNothing — cross-employee 경합도
      // 500 없이 직렬화. 충돌 시 기존 이벤트의 의미필드(employee·amount) 일치면 replay, 아니면 409.
      const [inserted] = await tx
        .insert(usageEvents)
        .values({
          id: randomUUID(), employeeId: id, periodStart: currentPeriodStart(), amountCents,
          source: "operator_manual", actor: APPROVER.id, idempotencyKey, note: note ?? null,
        })
        .onConflictDoNothing({ target: usageEvents.idempotencyKey })
        .returning();
      if (inserted) {
        await tx.insert(auditLog).values({
          id: randomUUID(), actor: APPROVER.id, action: "usage_recorded", targetId: id,
          summary: `${e.name} 사용액 ${amountCents}c 기록(dev)`, meta: { amountCents, source: "operator_manual", mock: true },
        });
        return e;
      }
      const [existing] = await tx.select().from(usageEvents).where(eq(usageEvents.idempotencyKey, idempotencyKey));
      if (!existing || existing.employeeId !== id || existing.amountCents !== amountCents) {
        throw new GuardError("idempotency_conflict", { idempotencyKey });
      }
      return e; // 정확 replay.
    });
    // 커밋 후 계산(방금 기록 반영). 표시용 스냅샷.
    const admission = await computeAdmission(id, emp.budgetMonthlyCents);
    res.status(201).json({ admission });
  } catch (e) {
    if (e instanceof GuardError) {
      res.status(e.code === "not_found" ? 404 : 409).json({ error: e.code, ...e.detail });
      return;
    }
    throw e;
  }
});

// 파드 usage 텔레메트리(M3.3b) — 실 spend 소스(source=pod_telemetry). 증가전용·멱등(idempotencyKey UNIQUE).
// spent>=effectiveBudget 교차 시 **running 임직원을 자동 하드스톱**(desired=Paused CAS)→드라이버가 파드 정지.
// 경계: usage_events(자체 소유)만 write, state_domain 무접촉. 재개는 budget_override 승인 후 명시 resume만(자동재개 없음).
app.post("/api/employees/:id/telemetry", async (req, res) => {
  // P4: 현재는 approverTokenOk 로 닫아 둔다(위조 usage→auto-hardstop DoS 차단, codex B). 단 telemetry 는 pod(기계)
  // 리포트 표면이라 실제 배선 시 사람 승인자 토큰을 재사용하면 안 됨(pod가 approve까지 얻음, codex D) — 별도 TELEMETRY_TOKEN/
  // workload identity/mTLS 로 scope 분리한 뒤 그 인증으로 교체할 것. 지금은 caller 없음·TELEMETRY_ENABLED 기본 off.
  if (!requireApprover(req, res)) return;
  if (!TELEMETRY_ENABLED) {
    res.status(403).json({ error: "telemetry_disabled" });
    return;
  }
  const parsed = UsageRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
    return;
  }
  const { amountCents, idempotencyKey, note } = parsed.data;
  const id = req.params.id;
  try {
    const result = await db.transaction(async (tx) => {
      const [e] = await tx.select().from(employees).where(eq(employees.id, id)).for("update");
      if (!e) throw new GuardError("not_found", { id });
      // idempotency 원자 claim(A3 계승) — 전역 unique에 onConflictDoNothing.
      const [inserted] = await tx
        .insert(usageEvents)
        .values({
          id: randomUUID(), employeeId: id, periodStart: currentPeriodStart(), amountCents,
          source: "pod_telemetry", actor: "system", idempotencyKey, note: note ?? null,
        })
        .onConflictDoNothing({ target: usageEvents.idempotencyKey })
        .returning();
      if (!inserted) {
        // 정확 replay면 부수효과(하드스톱) 재적용 없이 현재 admission만. 불일치면 409.
        const [existing] = await tx.select().from(usageEvents).where(eq(usageEvents.idempotencyKey, idempotencyKey));
        if (!existing || existing.employeeId !== id || existing.amountCents !== amountCents) {
          throw new GuardError("idempotency_conflict", { idempotencyKey });
        }
        const adm = await computeAdmission(id, e.budgetMonthlyCents, tx);
        return { admission: adm, hardStopped: false as const, replay: true as const };
      }
      await tx.insert(auditLog).values({
        id: randomUUID(), actor: "system", action: "usage_recorded", targetId: id,
        summary: `${e.name} 사용액 ${amountCents}c(파드 텔레메트리)`, meta: { amountCents, source: "pod_telemetry" },
      });
      // 하드스톱: 방금 기록 반영해 admission 재계산(tx로 — pool 재진입 데드락 회피, A1). 초과+Running이면 auto-pause.
      const adm = await computeAdmission(id, e.budgetMonthlyCents, tx);
      let hardStopped = false;
      if (adm.blocksAdmission && e.desired === "Running") {
        const [u] = await tx
          .update(employees)
          .set({ desired: "Paused" })
          .where(and(eq(employees.id, id), eq(employees.desired, "Running"))) // Running에서만(경합·이미 Paused/Terminated 무해)
          .returning({ id: employees.id });
        if (u) {
          hardStopped = true;
          await tx.insert(auditLog).values({
            id: randomUUID(), actor: "system", action: "budget_hardstop", targetId: id,
            summary: `${e.name} 예산 하드스톱 — 자동 일시정지(사용 ${adm.spentCents}c ≥ 예산 ${adm.effectiveBudgetCents}c)`,
            meta: { spentCents: adm.spentCents, effectiveBudgetCents: adm.effectiveBudgetCents, source: "pod_telemetry" },
          });
        }
      }
      return { admission: adm, hardStopped, replay: false as const };
    });
    res.status(201).json(result);
  } catch (e) {
    if (e instanceof GuardError) {
      res.status(e.code === "not_found" ? 404 : 409).json({ error: e.code, ...e.detail });
      return;
    }
    throw e;
  }
});

// 예산 상향(override) 요청 — 승인 게이트. budget NULL 대상 거부. 중복 pending은 dedup(M2.1 partial unique).
app.post("/api/employees/:id/budget-override", async (req, res) => {
  const parsed = BudgetOverrideRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
    return;
  }
  const { additionalLimitCents, note } = parsed.data;
  const id = req.params.id;
  const periodStart = currentPeriodStart();
  try {
    const result = await db.transaction(async (tx) => {
      const [emp] = await tx.select().from(employees).where(eq(employees.id, id)).for("update");
      if (!emp) throw new GuardError("not_found", { id });
      if (emp.budgetMonthlyCents === null) throw new GuardError("not_configured", { id }); // 미설정 대상 override 무의미.
      if (emp.desired === "Terminated") throw new GuardError("already_terminated", { id });
      const apprId = randomUUID();
      const summary = `${emp.name} 예산 상향 ${additionalLimitCents}c (${periodStart})`;
      const [a] = await tx
        .insert(approvals)
        .values({
          id: apprId, action: "budget_override", state: "pending", targetId: id, summary,
          payload: { additionalLimitCents, periodStart, note: note ?? null },
          requestedBy: REQUESTER.id, requestedByName: REQUESTER.name, gate: "fail_closed",
        })
        .onConflictDoNothing({ target: [approvals.action, approvals.targetId], where: sql`${approvals.state} = 'pending'` })
        .returning();
      if (a) {
        await tx.insert(auditLog).values({
          id: randomUUID(), actor: REQUESTER.id, action: "budget_override_requested", targetId: id, summary,
          meta: { approvalId: apprId, additionalLimitCents, periodStart },
        });
        return { created: true as const, row: a };
      }
      // 충돌 = 이미 pending override. 잠금 보유 중 안전 재조회. 금액·기간이 정확히 같을 때만 replay, 다르면 409
      // (A4: 다른 금액을 성공 재시도로 취급하면 승인 시 요청과 다른 grant가 부여됨).
      const [existing] = await tx.select().from(approvals).where(and(eq(approvals.action, "budget_override"), eq(approvals.targetId, id), eq(approvals.state, "pending")));
      if (!existing) throw new GuardError("conflict_no_pending", { id });
      const p = (existing.payload ?? {}) as { additionalLimitCents?: number; periodStart?: string };
      if (p.additionalLimitCents !== additionalLimitCents || p.periodStart !== periodStart) {
        throw new GuardError("override_pending_differs", { id, pending: { additionalLimitCents: p.additionalLimitCents ?? null, periodStart: p.periodStart ?? null } });
      }
      return { created: false as const, row: existing };
    });
    res.status(result.created ? 201 : 200).json(ApprovalResponse.parse({ approval: toApproval(result.row) }));
  } catch (e) {
    if (e instanceof GuardError) {
      res.status(e.code === "not_found" ? 404 : 409).json({ error: e.code, ...e.detail });
      return;
    }
    throw e;
  }
});

// 런타임 회수 요청(M3.2b) — 승인 게이트. 2단계 종료의 2단계(terminate=파드정지·CR유지 → reclaim=CR 최종 삭제).
// 게이트 = 관측 lifecycle===Terminated(파드 실제 회수 완료). 중복 pending은 dedup(terminate/override와 동일).
app.post("/api/employees/:id/reclaim", async (req, res) => {
  const id = req.params.id;
  try {
    const result = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(employees).where(eq(employees.id, id)).for("update");
      if (!row) throw new GuardError("not_found", { id });
      // 요청 시점 빠른-실패(권위 게이트는 approve 트랜잭션의 lockedTarget 재검증). Terminated 흡수라 TOCTOU 없음.
      if (row.lifecycle !== "Terminated") throw new GuardError("not_terminated", { id, lifecycle: row.lifecycle });
      const apprId = randomUUID();
      const summary = `${row.name}(${row.title ?? KIND_LABEL_KO[row.kind] ?? row.kind}) 런타임 회수(파드/CR 삭제)`;
      const [a] = await tx
        .insert(approvals)
        .values({
          id: apprId, action: "delete_pod", state: "pending", targetId: id, summary,
          payload: { targetId: id, targetName: row.name },
          requestedBy: REQUESTER.id, requestedByName: REQUESTER.name, gate: "fail_closed",
        })
        .onConflictDoNothing({ target: [approvals.action, approvals.targetId], where: sql`${approvals.state} = 'pending'` })
        .returning();
      if (a) {
        await tx.insert(auditLog).values({ id: randomUUID(), actor: REQUESTER.id, action: "runtime_reclaim_requested", targetId: id, summary, meta: { approvalId: apprId } });
        return { created: true as const, row: a };
      }
      // 충돌 = 이미 pending 회수. employee 잠금 보유 중 안전 재조회.
      const [existing] = await tx.select().from(approvals).where(and(eq(approvals.action, "delete_pod"), eq(approvals.targetId, id), eq(approvals.state, "pending")));
      if (!existing) throw new GuardError("conflict_no_pending", { id });
      return { created: false as const, row: existing };
    });
    res.status(result.created ? 201 : 200).json(ApprovalResponse.parse({ approval: toApproval(result.row) }));
  } catch (e) {
    if (e instanceof GuardError) {
      res.status(e.code === "not_found" ? 404 : 409).json({ error: e.code, ...e.detail });
      return;
    }
    throw e;
  }
});

// 개별발송(per_owner) 활성화 요청(M5) — 위험행동 승인 게이트. budget_override/reclaim 미러.
// 게이트(fail-closed): 발송 주체(도메인 워커)·미종료·현재 dssoc_only. 승인 시 mail_send_mode=per_owner(거버넌스 intent).
// 실 메일 발송은 이 요청과 무관하게 런타임 egress 게이트(allowlist=dssoc+shaneee.baek·Knox MCP·redact)가 별도 강제.
app.post("/api/employees/:id/enable-send", async (req, res) => {
  const parsed = ApprovalDecision.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", detail: parsed.error.flatten() });
    return;
  }
  const { note } = parsed.data;
  const id = req.params.id;
  try {
    const result = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(employees).where(eq(employees.id, id)).for("update");
      if (!row) throw new GuardError("not_found", { id });
      if (row.desired === "Terminated") throw new GuardError("already_terminated", { id });
      // 발송 주체(실제 조치요청 메일을 보내는 도메인 fanout 워커)만. root/hr/오케/전략 차단.
      if (row.kind !== "worker" || !row.domain) throw new GuardError("not_send_capable", { id, kind: row.kind });
      if (row.mailSendMode === "per_owner") throw new GuardError("already_per_owner", { id });
      const apprId = randomUUID();
      const summary = `${row.name}(${row.title ?? KIND_LABEL_KO[row.kind] ?? row.kind}) 개별발송(per_owner) 활성화`;
      const [a] = await tx
        .insert(approvals)
        .values({
          id: apprId, action: "enable_send", state: "pending", targetId: id, summary,
          payload: { targetId: id, targetName: row.name, from: "dssoc_only", to: "per_owner", note: note ?? null },
          requestedBy: REQUESTER.id, requestedByName: REQUESTER.name, gate: "fail_closed",
        })
        .onConflictDoNothing({ target: [approvals.action, approvals.targetId], where: sql`${approvals.state} = 'pending'` })
        .returning();
      if (a) {
        await tx.insert(auditLog).values({ id: randomUUID(), actor: REQUESTER.id, action: "enable_send_requested", targetId: id, summary, meta: { approvalId: apprId } });
        return { created: true as const, row: a };
      }
      const [existing] = await tx.select().from(approvals).where(and(eq(approvals.action, "enable_send"), eq(approvals.targetId, id), eq(approvals.state, "pending")));
      if (!existing) throw new GuardError("conflict_no_pending", { id });
      return { created: false as const, row: existing };
    });
    res.status(result.created ? 201 : 200).json(ApprovalResponse.parse({ approval: toApproval(result.row) }));
  } catch (e) {
    if (e instanceof GuardError) {
      res.status(e.code === "not_found" ? 404 : 409).json({ error: e.code, ...e.detail });
      return;
    }
    throw e;
  }
});

// 개별발송 비활성화(per_owner→dssoc_only) — safe-revert(안전 방향)라 승인 게이트 없이 즉시 반영 + 감사.
app.post("/api/employees/:id/disable-send", async (req, res) => {
  if (!requireApprover(req, res)) return; // P4: safe-revert지만 운영자만 — 가용성 공격+root 감사 위조 차단(codex B).
  const id = req.params.id;
  try {
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(employees).where(eq(employees.id, id)).for("update");
      if (!row) throw new GuardError("not_found", { id });
      const [u] = await tx.update(employees).set({ mailSendMode: "dssoc_only" }).where(eq(employees.id, id)).returning();
      if (!u) throw new GuardError("not_found", { id });
      await tx.insert(auditLog).values({ id: randomUUID(), actor: APPROVER.id, action: "disable_send", targetId: id, summary: `${row.name} 개별발송 비활성화(→dssoc_only)`, meta: { note: "safe-revert(무승인)" } });
      return u;
    });
    res.json({ employee: toRecord(updated) });
  } catch (e) {
    if (e instanceof GuardError) {
      res.status(e.code === "not_found" ? 404 : 409).json({ error: e.code, ...e.detail });
      return;
    }
    throw e;
  }
});

app.listen(PORT, HOST, () => {
  // 런타임 드라이버 매니저 시작 — desired 향해 observed phase 수렴. RUNTIME_LIVE_SCOPE 임직원은 kubernetes(live),
  // 나머지는 mock(M3.2 하이브리드). 빈 스코프=전원 mock=M3.0 무회귀.
  startEmployeeRuntimeDriver();
  // eslint-disable-next-line no-console
  console.log(`[control-plane] http://${HOST}:${PORT} (M3.2 · digisecu_control · hybrid driver)`);
  if (!APPROVER_TOKEN_DIGEST) {
    if (ALLOW_INSECURE_DEV_APPROVER) {
      // 명시 opt-in — 무인증 dev. 운영에서 절대 켜지 말 것.
      // eslint-disable-next-line no-console
      console.warn("[control-plane] ⚠ ALLOW_INSECURE_DEV_APPROVER=true — 승인/운영 조작이 무인증(dev)입니다. 운영 배포에선 APPROVER_TOKEN 을 설정하고 이 플래그를 끄세요.");
    } else {
      // 기본 fail-closed: 승인/운영 조작 전부 403. 사람 승인 dev를 원하면 APPROVER_TOKEN 설정(권장) 또는 ALLOW_INSECURE_DEV_APPROVER=true.
      // eslint-disable-next-line no-console
      console.error("[control-plane] ⛔ APPROVER_TOKEN 미설정 — 승인/운영 조작이 전부 거부(fail-closed)됩니다. APPROVER_TOKEN 을 설정하거나(권장) 무인증 dev면 ALLOW_INSECURE_DEV_APPROVER=true.");
    }
  }
});
