/**
 * 임직원 명부(roster) 계약 — M1.1 실 DB 왕복 대상.
 *
 * ADR 0008 taxonomy: 사람(임직원)과 잡(도구)은 별개다.
 *  - EmployeeRecord = 사람 (보안운영팀장/도메인팀장/전략담당/파트장/워커/HR).
 *  - Tool          = 잡 (collector 등). 임직원이 아니라 담당자(owner)의 도구.
 *
 * 예산·admission 등 리치 필드는 M2.4에서 EmployeeRecord를 additive 확장(별도 리치 엔티티 안 둠).
 * 지금은 조직 로스터의 평면 표현만 계약한다.
 */
import { z } from "zod";
import { DesiredState, LifecycleCommand, LifecycleState, RuntimeMode } from "./lifecycle";
import { AdmissionSnapshot } from "./budget";

/** 조직 구성원 종류 (잡 제외 — 잡은 Tool). */
export const EmployeeKind = z.enum([
  "person", // 보안운영팀장(루트)
  "orchestrator", // 도메인팀장 (SMB팀장 …)
  "strategy", // 전략담당
  "partlead", // 파트장 (task/report/reply-verify)
  "worker", // 워커 (핫스타트)
  "hr", // 인사담당
]);
export type EmployeeKind = z.infer<typeof EmployeeKind>;

/** presence 상태 (인사기록부 팔레트와 정렬). */
export const EmployeeStatus = z.enum(["working", "investigating", "idle", "paused"]);
export type EmployeeStatus = z.infer<typeof EmployeeStatus>;

/** 소속 보안 도메인 (root/hr는 없음). */
export const EmployeeDomain = z.enum(["smb", "dev_web", "github", "confluence"]);
export type EmployeeDomain = z.infer<typeof EmployeeDomain>;

/** 메일 발송 모드 — dev-safe 기본(dssoc_only). per_owner 발송은 M5 enable_send 승인 게이트 경유만. */
export const MailSendMode = z.enum(["dssoc_only", "per_owner"]);
export type MailSendMode = z.infer<typeof MailSendMode>;

/** 담당자의 도구(잡). collector 등. 임직원 명부에는 포함되지 않는다. */
export const Tool = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  ownerId: z.string(),
});
export type Tool = z.infer<typeof Tool>;

/** 명부 레코드 — 조직 로스터의 평면 표현. */
export const EmployeeRecord = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().nullable(), // 직책 (SMB팀장, task 파트장 …). 워커엔 없을 수 있음
  kind: EmployeeKind,
  domain: EmployeeDomain.nullable(),
  persona: z.string().nullable(),
  role: z.string().nullable(),
  status: EmployeeStatus.nullable(), // presence(런타임) 상태 — 고용 상태와 별개
  lifecycle: LifecycleState.nullable(), // **관측 phase**(driver 보고). Provisioning/Running/…/Draining/Terminated
  desired: DesiredState.nullable(), // **의도**(control-plane 소유). driver가 이 쪽으로 수렴 (M3.0 분리)
  runtimeMode: RuntimeMode, // observed phase의 출처: mock(in-process 드라이버) | live(M3 파드 백엔드)
  heartbeatAt: z.string().datetime().nullable(), // 마지막 실 heartbeat 시각(ISO). M2엔 텔레메트리 없어 null, M3에서 채움.
  hotStart: z.boolean(),
  accent: z.string().nullable(),
  workspaceKey: z.string().nullable(),
  managerId: z.string().nullable(), // → EmployeeRecord.id (조직트리)
  // 임직원별 발송 모드(control-plane 소유 SSOT). per_owner 전환은 enable_send 승인 게이트 경유만(M5).
  mailSendMode: MailSendMode,
  createdAt: z.string(),
});
export type EmployeeRecord = z.infer<typeof EmployeeRecord>;

/** 목록 응답 (필터 적용 후). */
export const RosterListResponse = z.object({
  employees: z.array(EmployeeRecord),
  total: z.number().int().nonnegative(),
});
export type RosterListResponse = z.infer<typeof RosterListResponse>;

/** 조직도 응답 — 평탄 명부 + 전체 도구. web이 managerId/ownerId로 트리를 조립한다. */
export const OrgResponse = z.object({
  employees: z.array(EmployeeRecord),
  tools: z.array(Tool),
});
export type OrgResponse = z.infer<typeof OrgResponse>;

/** 상세 응답 — 본인 + 상사 + 직속 부하 + 보유 도구(잡). */
export const EmployeeDetailResponse = z.object({
  employee: EmployeeRecord,
  manager: EmployeeRecord.nullable(),
  reports: z.array(EmployeeRecord), // 직속 부하 (사람만)
  tools: z.array(Tool), // 본인이 운영하는 잡
  // 지금 이 임직원에게 허용되는 라이프사이클 명령 — 서버 policy 모듈이 산출(web 전이표 복제 금지).
  // candidateActions(lifecycle) + org(person 보호)·pending(중복 terminate)·G6(활성 부하)·admission(예산) 가드 합성.
  allowedActions: z.array(LifecycleCommand),
  // 예산 admission 스냅샷(상세에서만 계산). blocksAdmission면 resume/activate 거부(서버 강제).
  admission: AdmissionSnapshot,
});
export type EmployeeDetailResponse = z.infer<typeof EmployeeDetailResponse>;

/** 목록 쿼리 필터. */
export const RosterQuery = z.object({
  domain: EmployeeDomain.optional(),
  kind: EmployeeKind.optional(),
  status: EmployeeStatus.optional(),
  lifecycle: LifecycleState.optional(),
});
export type RosterQuery = z.infer<typeof RosterQuery>;
