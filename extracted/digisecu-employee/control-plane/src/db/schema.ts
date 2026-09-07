/**
 * Drizzle 스키마 — control-plane 전용 DB `digisecu_control`.
 *
 * 불가침: 이 DB는 secu-agent 도메인 DB(`threat_hunter`, state_domain 28테이블)와
 * 물리적으로 분리된다(ADR 0005). Drizzle는 오직 이 DB만 소유·마이그레이션한다.
 *
 * taxonomy(ADR 0008): 사람=employees, 잡(도구)=tools(owner_id로 담당자 귀속).
 */
import { boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** 임직원(사람) — 조직 로스터. manager_id 자기참조로 조직트리 구성. */
export const employees = pgTable(
  "employees",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    title: text("title"),
    kind: text("kind").notNull(), // person|orchestrator|strategy|partlead|worker|hr
    domain: text("domain"), // smb|dev_web|github|confluence | null(root/hr)
    persona: text("persona"),
    role: text("role"),
    status: text("status"), // working|investigating|idle|paused | null (presence)
    lifecycle: text("lifecycle").notNull().default("Running"), // **관측 phase**(driver 보고). M3.0부터 driver가 씀.
    desired: text("desired").notNull().default("Running"), // **의도**(control-plane 소유): Running|Paused|Terminated (M3.0)
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }), // 마지막 관측 시각(lastPodObservedAt). mock 드라이버가 채움(M3.0), 실 heartbeat는 M3.3.
    hotStart: boolean("hot_start").notNull().default(false),
    accent: text("accent"),
    workspaceKey: text("workspace_key"),
    managerId: text("manager_id"), // → employees.id
    budgetMonthlyCents: integer("budget_monthly_cents"), // 월 예산(선택). 하드스톱은 M2.
    mailSendMode: text("mail_send_mode").notNull().default("dssoc_only"), // dev-safe 기본
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // M2.1: lifecycle(observed phase) 상태기계 7종 제약. M3.0: desired 3종 제약.
  (t) => [
    check(
      "employees_lifecycle_check",
      sql`${t.lifecycle} in ('Hired','Provisioning','Running','Paused','Unhealthy','Draining','Terminated')`,
    ),
    check("employees_desired_check", sql`${t.desired} in ('Running','Paused','Terminated')`),
    // M5: 발송 모드 DB 레벨 enum 방어(다른 CHECK와 대칭). per_owner 전환은 enable_send 승인 경유만.
    check("employees_mail_send_mode_check", sql`${t.mailSendMode} in ('dssoc_only','per_owner')`),
  ],
);

/** 잡(도구) — collector 등. 임직원이 아니라 담당자(owner)의 도구. */
export const tools = pgTable("tools", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role"),
  ownerId: text("owner_id").notNull(), // → employees.id
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 승인(위험행동 게이트) — hire/terminate 등. pending → approved|rejected.
 * fail-closed: 요청은 항상 pending으로 태어나고, 자동 승인 없음.
 */
export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    action: text("action").notNull(), // hire|terminate|enable_send|delete_pod|budget_override|send_mail
    state: text("state").notNull().default("pending"), // pending|approved|rejected
    targetId: text("target_id"), // 대상 임직원 id (terminate). hire는 null.
    summary: text("summary"), // 사람이 읽는 한 줄 요약
    payload: jsonb("payload"), // hire 초안 원문 또는 terminate 대상 참조
    requestedBy: text("requested_by").notNull(),
    requestedByName: text("requested_by_name"),
    gate: text("gate"), // 적용 게이트 정책 (fail_closed)
    note: text("note"), // 결정 메모
    decidedBy: text("decided_by"),
    decidedByName: text("decided_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    // M2.1: action/state 를 계약 enum으로 제약(Zod 외 DB 레벨 방어).
    check(
      "approvals_action_check",
      // ★ `set_owner` 추가 2026-09-01 — 담당자 지정도 승인 게이트를 탄다.
      //   어휘를 DB 에서 닫아 두는 이유는 그대로다: 코드가 새 action 을 만들어도
      //   여기 없으면 들어가지 않는다(Zod 밖 방어).
      sql`${t.action} in ('hire','terminate','enable_send','delete_pod','budget_override','send_mail','set_owner')`,
    ),
    check("approvals_state_check", sql`${t.state} in ('pending','approved','rejected')`),
    // M2.1(gate-2): 대상당 pending 승인 1건만 — SELECT-then-INSERT dedup 경합을 인덱스로 원자 봉쇄.
    // target_id NULL(hire)은 Postgres에서 서로 distinct → 다건 pending hire 허용(의도).
    uniqueIndex("approvals_pending_target_uniq")
      .on(t.action, t.targetId)
      .where(sql`${t.state} = 'pending'`),
  ],
);

/**
 * 감사로그 — 라이프사이클·승인 이력. payload 원문이 아니라 요약+actor+decision+ts.
 * (뷰어 화면은 M1.5. 지금은 게이트가 요구하는 쓰기만.)
 */
export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  actor: text("actor").notNull(), // root|hr|system
  action: text("action").notNull(), // hire_requested|hire_approved|provisioned|terminated|paused|resumed|…
  targetId: text("target_id"),
  summary: text("summary").notNull(),
  meta: jsonb("meta"),
});

/**
 * 사용액 원장(M2.4) — spent의 SSOT. spent는 컬럼이 아니라 이 원장에서 읽기 시 계산한다.
 * 증가 전용(amount>0 CHECK, 감소/reversal 경로 없음 = 하드스톱 우회 차단). M3 텔레메트리도 같은 포트.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    employeeId: text("employee_id").notNull(), // → employees.id (앱레벨 무결성, FK 없음=코드베이스 관례)
    periodStart: date("period_start").notNull(), // KST 월 1일 (YYYY-MM-01)
    amountCents: integer("amount_cents").notNull(),
    source: text("source").notNull(), // operator_manual (M3: pod_telemetry)
    actor: text("actor").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    idempotencyKey: text("idempotency_key").notNull(),
    approvalId: text("approval_id"),
    note: text("note"),
  },
  (t) => [
    check("usage_events_amount_positive", sql`${t.amountCents} > 0`),
    check("usage_events_source_check", sql`${t.source} in ('operator_manual', 'pod_telemetry')`),
    uniqueIndex("usage_events_idempotency_uniq").on(t.idempotencyKey),
    index("usage_events_emp_period_idx").on(t.employeeId, t.periodStart),
  ],
);

/** 예산 상향(override) grant(M2.4) — 승인 시 영속. effectiveBudget = budget + 이번달 grant 합. */
export const budgetGrants = pgTable(
  "budget_grants",
  {
    id: text("id").primaryKey(),
    employeeId: text("employee_id").notNull(),
    periodStart: date("period_start").notNull(),
    additionalLimitCents: integer("additional_limit_cents").notNull(),
    approvalId: text("approval_id").notNull(), // 승인당 1건(멱등)
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("budget_grants_amount_positive", sql`${t.additionalLimitCents} > 0`),
    uniqueIndex("budget_grants_approval_uniq").on(t.approvalId),
    index("budget_grants_emp_period_idx").on(t.employeeId, t.periodStart),
  ],
);

/**
 * 트리아지 오버레이(제품 소유) — finding 관리 상태. finding 자체는 게이트웨이(threat_hunter)가
 * 소유하므로 여기엔 참조 키(finding_ref='finding:th:<id>')만 둔다(교차 DB, FK 없음=관례).
 * version=낙관적 동시성(동시 상태변경 충돌 감지). 코멘트는 별 테이블(append-only).
 */
export const findingTriage = pgTable(
  "finding_triage",
  {
    findingRef: text("finding_ref").primaryKey(), // finding:<source>:<id>
    status: text("status").notNull().default("unclassified"),
    version: integer("version").notNull().default(1),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "finding_triage_status_check",
      sql`${t.status} in ('unclassified','investigating','action_requested','resolved','on_hold')`,
    ),
    check("finding_triage_version_positive", sql`${t.version} >= 1`),
  ],
);

/** 트리아지 코멘트 — append-only(수정/삭제 경로 없음). finding_ref로 finding_triage에 귀속(FK 없음=관례). */
export const findingTriageNote = pgTable(
  "finding_triage_note",
  {
    id: text("id").primaryKey(),
    findingRef: text("finding_ref").notNull(),
    body: text("body").notNull(),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("finding_triage_note_ref_idx").on(t.findingRef, t.createdAt)],
);

export type EmployeeRow = typeof employees.$inferSelect;
export type ToolRow = typeof tools.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
export type UsageEventRow = typeof usageEvents.$inferSelect;
export type BudgetGrantRow = typeof budgetGrants.$inferSelect;
export type FindingTriageRow = typeof findingTriage.$inferSelect;
export type FindingTriageNoteRow = typeof findingTriageNote.$inferSelect;
