/**
 * 감사로그 읽기 계약 — 라이프사이클·승인 이력.
 *
 * 쓰기는 M1.2(승인 게이트)에서 도입됨(control-plane `audit_log`). 여기선 읽기 슬라이스만
 * 계약한다. 로비 "최근 활동"이 최소 목록을 소비하고, 전용 감사 뷰어 화면은 M1.5.
 */
import { z } from "zod";

/** 감사 이벤트 — audit_log 한 줄. payload 원문이 아니라 요약+actor+ts. */
export const AuditRecord = z.object({
  id: z.string(),
  ts: z.string(),
  actor: z.string(), // root|hr|system
  action: z.string(), // hire_requested|hire_approved|provisioned|terminated|paused|resumed|…
  targetId: z.string().nullable(),
  summary: z.string(),
  meta: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditRecord = z.infer<typeof AuditRecord>;

/** 감사 목록 응답 — events는 페이지(최근순), total은 필터 매칭 전체 카운트. */
export const AuditListResponse = z.object({
  events: z.array(AuditRecord),
  total: z.number().int().nonnegative(),
});
export type AuditListResponse = z.infer<typeof AuditListResponse>;

/** 활동 분류 — 필터·배지 색의 축. */
export const AuditCategory = z.enum(["hire", "terminate", "lifecycle", "budget", "mail", "triage", "other"]);
export type AuditCategory = z.infer<typeof AuditCategory>;

/**
 * 활동(action) → 라벨·분류. 서버 필터(분류→action 집합)와 web 배지가 공유하는 단일 정의.
 * 미상 action은 auditActionMeta가 other로 폴백한다.
 */
export const AUDIT_ACTION_META: Record<string, { label: string; category: AuditCategory }> = {
  hire_requested: { label: "채용 요청", category: "hire" },
  hire_approved: { label: "채용 승인", category: "hire" },
  provisioned: { label: "프로비저닝", category: "hire" },
  hire_rejected: { label: "채용 반려", category: "hire" },
  terminate_requested: { label: "퇴사 요청", category: "terminate" },
  terminated: { label: "퇴사 처리", category: "terminate" },
  terminate_rejected: { label: "퇴사 반려", category: "terminate" },
  paused: { label: "일시정지", category: "lifecycle" },
  resumed: { label: "재개", category: "lifecycle" },
  usage_recorded: { label: "사용액 기록", category: "budget" },
  budget_override_requested: { label: "예산 상향 요청", category: "budget" },
  budget_override_approved: { label: "예산 상향 승인", category: "budget" },
  budget_override_rejected: { label: "예산 상향 반려", category: "budget" },
  enable_send_requested: { label: "개별발송 활성화 요청", category: "mail" },
  enable_send_approved: { label: "개별발송 활성화 승인", category: "mail" },
  enable_send_rejected: { label: "개별발송 활성화 반려", category: "mail" },
  disable_send: { label: "개별발송 비활성화", category: "mail" },
  triage_status_changed: { label: "트리아지 상태 변경", category: "triage" },
  // ★ 담당자 지정 (2026-09-01). 티켓 워크스페이스가 이 세 줄로 변경 이력을 그린다 —
  //   여기 없으면 "other" 로 떨어져 라벨이 원문 그대로 나온다.
  set_owner_requested: { label: "담당자 지정 요청", category: "mail" },
  set_owner_executed: { label: "담당자 지정", category: "mail" },
  set_owner_failed: { label: "담당자 지정 실패", category: "mail" },
  // ★ 티켓 상태를 사람이 바꾼 기록(2026-09-01). 파이프라인이 옮긴 것과 **사람이 옮긴 것**을
  //   워크스페이스 이력에서 갈라 보여준다 — 안 갈라 두면 "왜 갑자기 종결됐지" 가 안 풀린다.
  ticket_status_changed: { label: "티켓 상태 변경", category: "mail" },
  ticket_status_failed: { label: "티켓 상태 변경 실패", category: "mail" },
  triage_note_added: { label: "트리아지 코멘트 추가", category: "triage" },
};

export function auditActionMeta(action: string): { label: string; category: AuditCategory } {
  return AUDIT_ACTION_META[action] ?? { label: action, category: "other" };
}

/** 감사 목록 쿼리 — limit(1~200) + 주체·분류 필터. */
export const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  actor: z.string().min(1).optional(),
  category: AuditCategory.optional(),
  // ★ 티켓 단위 조회 (2026-09-01). 워크스페이스가 "이 티켓에 무슨 일이 있었나" 를
  //   그리려면 스레드로 좁힐 수 있어야 한다 — 전체 감사에서 눈으로 찾을 수는 없다.
  //   `meta.domain` · `meta.threadId` 로 거른다(그 두 값은 요청 시점에 기록된다).
  domain: z.string().min(1).max(32).optional(),
  threadId: z.coerce.number().int().positive().optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;
