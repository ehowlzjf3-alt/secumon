/**
 * 채용/라이프사이클 승인 계약 — M1.2 (첫 DB 쓰기 + 위험행동 승인 게이트).
 *
 * 위험행동(§3-4)은 fail-closed + 명시적 승인 게이트 + 감사로그 뒤에 둔다.
 *  - HR가 채용을 "제안"하면 곧바로 재직이 아니라 pending 승인으로 들어가고,
 *  - 사람(보안운영팀장)이 승인해야 임직원 레코드가 생성·프로비저닝(mock)된다.
 *
 * M1.2 라이브 액션은 hire·terminate 둘뿐. 나머지 3종(enable_send/delete_pod/
 * budget_override)은 enum·게이트 타입으로 정의만 하고 배선은 후속 마일스톤.
 */
import { z } from "zod";
import { EmployeeDomain, EmployeeKind } from "./roster";
// MailSendMode는 roster.ts로 이동(EmployeeRecord와 동거, 순환 import 방지). barrel(index)에서 roster로부터 노출.

/** 게이트 대상 위험행동 (DISCOVERY §3 초안 그대로). */
export const ApprovalAction = z.enum([
  "hire", // 채용 (→ 임직원 생성)
  "terminate", // 퇴사 (→ Terminated)
  "enable_send", // 실발송 활성화 (M4·M5)
  "delete_pod", // 파드 삭제 (M3)
  "budget_override", // 예산 초과 (M2)
  // ★ 콘솔 발송 (2026-08-25). 되돌릴 수 없는 **바깥으로 나가는** 행위라 승인 게이트를 탄다.
  //   실제 발송은 승인 커밋 **뒤에** 별도 단계로 일어난다 — 트랜잭션 안에서 보내면
  //   롤백이 '보낸 메일' 을 되돌리지 못한 채 DB 만 되돌아간다.
  "send_mail",
  // ★ 담당자 지정 (2026-09-01). 바꾸면 **다음 메일이 그 사람에게 간다** — 되돌릴 수는
  //   있지만 그 사이 나간 메일은 못 되돌린다. 그래서 발송과 같은 승인 게이트를 탄다.
  "set_owner",
]);
export type ApprovalAction = z.infer<typeof ApprovalAction>;

/** 승인 상태기계 — pending → approved | rejected (멱등 원자 전이). */
export const ApprovalState = z.enum(["pending", "approved", "rejected"]);
export type ApprovalState = z.infer<typeof ApprovalState>;

/** 채용 가능한 직급 — 구조적 역할(person/orchestrator/hr)은 API에서도 fail-closed. Hire.tsx WIZARD_KINDS와 1:1. */
export const HireableKind = EmployeeKind.extract(["strategy", "partlead", "worker"]);
export type HireableKind = z.infer<typeof HireableKind>;

/** 채용 위저드가 수집하는 초안. 승인되는 순간 임직원으로 실체화된다. */
export const HireDraft = z.object({
  // 자유텍스트는 상한 필수(A8) — 코드베이스의 .max 규율과 대칭, 무제한 페이로드 영속·확산 방지.
  name: z.string().min(1).max(120),
  title: z.string().min(1).max(120).nullable().default(null),
  kind: HireableKind,
  domain: EmployeeDomain,
  persona: z.string().min(1).max(120).nullable().default(null),
  role: z.string().min(1).max(120).nullable().default(null),
  managerId: z.string().min(1).max(120), // → employees.id (상사)
  // 신규 채용은 예산 필수(B1) — NULL(=not_configured 비차단)로 태어나 영구 하드스톱 우회하는 경로 봉쇄.
  // 시드 46명은 NULL 유지(grandfathered). 0이면 born-Paused. PG int32 상한.
  budgetMonthlyCents: z.number().int().nonnegative().max(2_147_483_647),
  // per_owner 발송은 M5 enable_send 승인 게이트 경유만 — HR 인입 채널은 dev-safe 고정(fail-closed 400).
  mailSendMode: z.literal("dssoc_only").default("dssoc_only"),
});
export type HireDraft = z.infer<typeof HireDraft>;

/** POST /api/hires 요청 = 채용 초안. */
export const HireRequest = HireDraft;
export type HireRequest = z.infer<typeof HireRequest>;

/** 승인/반려 요청 — 결정 메모(선택). 결정자는 서버가 스탬프(무인증 M1.2). */
export const ApprovalDecision = z.object({
  note: z.string().max(500).optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/** 승인 레코드 — pending 큐/이력의 단위. payload는 초안 원문(hire) 또는 대상 참조(terminate). */
export const ApprovalRecord = z.object({
  id: z.string(),
  action: ApprovalAction,
  state: ApprovalState,
  targetId: z.string().nullable(), // 대상 임직원 id (terminate). hire는 승인 전이라 null.
  summary: z.string().nullable(), // 사람이 읽는 한 줄 요약 (서버 계산).
  payload: z.record(z.string(), z.unknown()).nullable(),
  requestedBy: z.string(), // 요청자 id (hire·terminate = hr)
  requestedByName: z.string().nullable(),
  gate: z.string().nullable(), // 적용 게이트 정책 (fail_closed)
  note: z.string().nullable(), // 결정 메모
  decidedBy: z.string().nullable(), // 결정자 id (승인 시 root)
  decidedByName: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;

/** 승인 목록 응답 — pendingCount는 nav 배지 원천. */
export const ApprovalListResponse = z.object({
  approvals: z.array(ApprovalRecord),
  pendingCount: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type ApprovalListResponse = z.infer<typeof ApprovalListResponse>;

/** 단건 승인 응답 (생성/결정). */
export const ApprovalResponse = z.object({ approval: ApprovalRecord });
export type ApprovalResponse = z.infer<typeof ApprovalResponse>;

/** 승인 목록 쿼리 필터. */
export const ApprovalQuery = z.object({ state: ApprovalState.optional() });
export type ApprovalQuery = z.infer<typeof ApprovalQuery>;

/** 콘솔 발송 요청 초안 — ★ **메일 내용이 없다.**
 *
 * 수신자·제목·본문을 담으면 그게 곧 2026-08-25 에 지운 `/api/findings/owner-mail-send` 다
 * (요청 본문을 그대로 Knox MCP 로 보내던 무방비 문). 서버가 DB 에서 다시 읽는다. */
export const MailSendDraft = z.object({
  domain: EmployeeDomain,
  threadId: z.number().int().positive(),
});
export type MailSendDraft = z.infer<typeof MailSendDraft>;

/**
 * 담당자 지정 요청 — 티켓의 담당자를 사람이 고른 사람으로 바꾼다.
 *
 * ⚠️ 이름이 아니라 **Knox ID**(또는 사내 메일 주소)를 받는다. Knox MCP 가 주는 임직원
 *    도구는 `knox_get_employee_info` 하나이고 **정확 조회만** 된다 — 이름 검색 API 가 없다
 *    (2026-09-01 실측: 서버 도구 5개 중 검색 없음). 서버가 조회해 이름·부서를 돌려준다.
 * ⚠️ 요청 본문에 이름·부서를 담지 않는다. 담으면 화면이 보낸 값을 서버가 그대로 믿게 된다 —
 *    담당자는 Knox 가 정본이다.
 */
export const OwnerAssignDraft = z.object({
  domain: EmployeeDomain,
  threadId: z.number().int().positive(),
  knoxId: z.string().min(1).max(120),
});
export type OwnerAssignDraft = z.infer<typeof OwnerAssignDraft>;

/** 담당자 지정 결과 — 무엇이 무엇으로 바뀌었는지 화면이 그대로 보여준다. */
export const OwnerAssignResult = z.object({
  domain: z.string(),
  threadId: z.number().int(),
  previous: z.string().nullable().optional(),
  owner: z.object({
    knoxId: z.string(),
    email: z.string(),
    name: z.string().nullable().optional(),
    dept: z.string().nullable().optional(),
  }),
  scope: z.object({ kind: z.string(), value: z.string() }).partial().optional(),
  requestedBy: z.string().nullable().optional(),
  at: z.number().optional(),
});
export type OwnerAssignResult = z.infer<typeof OwnerAssignResult>;

/** 발송 실행 결과. ★ `mode="dry_run"` 은 **오류가 아니라 게이트 판정**이다 —
 *  화면이 사유를 그려야 운영자가 "고장" 과 "정책상 안 나감" 을 가른다. */
export const MailSendResult = z.object({
  domain: z.string(),
  threadId: z.number().int(),
  mode: z.enum(["sent", "dry_run"]),
  detail: z.string().default(""),
  reasons: z.array(z.string()).default([]),
  scanHits: z.array(z.string()).default([]),
  recipients: z.array(z.string()).default([]),
  cc: z.array(z.string()).default([]),
  subject: z.string().default(""),
  /** 수신처 판정(normal | no_owner | dry_run). `mode` 와 **다른 축**이다 —
   *  이건 "누구에게" 이고 mode 는 "실제로 나갔나" 다. */
  targetMode: z.string().default(""),
});
export type MailSendResult = z.infer<typeof MailSendResult>;
