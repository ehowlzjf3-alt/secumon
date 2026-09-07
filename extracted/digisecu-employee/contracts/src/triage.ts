/**
 * 트리아지 오버레이 계약 (SSOT) — 제품 소유 상태, 스킬 finding 데이터와 별개.
 *
 * finding 자체(finding_lifecycle)는 게이트웨이(threat_hunter, read-only)가 소유하고 마스킹해 공급한다.
 * 관리 상태(트리아지)·코멘트는 **분석가의 제품 행위**라 control-plane(digisecu_control)에 영속한다.
 * 교차 DB 참조라 FK 없음(코드베이스 관례) — finding_ref 문자열로 느슨히 가리킨다. finding이
 * 삭제/재사용돼도 cascade하지 않고 감사 보존한다(eventual consistency 허용). 엔진 lifecycle status로
 * 관리 상태를 추론하지 않는다(둘은 별개 축).
 */
import { z } from "zod";

/** 관리 상태 — 안정적 영문 키(DB 저장값). 한글 라벨은 TRIAGE_STATUS_LABEL. */
export const TriageStatus = z.enum([
  "unclassified", // 미분류
  "investigating", // 확인중
  "action_requested", // 조치요청
  "resolved", // 처리완료
  "on_hold", // 보류
]);
export type TriageStatus = z.infer<typeof TriageStatus>;

export const TRIAGE_STATUS_LABEL: Record<TriageStatus, string> = {
  unclassified: "미분류",
  investigating: "확인중",
  action_requested: "조치요청",
  resolved: "처리완료",
  on_hold: "보류",
};
export const TRIAGE_STATUS_ORDER = TriageStatus.options;

/**
 * finding 참조 키 — `finding:<source>:<id>`. source는 finding 출처 인스턴스(현재 threat_hunter=`th`).
 * 교차 DB라 숫자 id만으론 불충분할 미래 대비. 마스킹된 게이트웨이 finding의 숫자 id로 구성한다.
 */
export const FINDING_SOURCE = "th" as const;
export const TriageFindingRef = z.string().regex(/^finding:[a-z0-9_]+:\d+$/, "finding:<source>:<id> 형식이어야 함");
export type TriageFindingRef = z.infer<typeof TriageFindingRef>;

/**
 * 티켓(대상) 참조 키 — `ticket:<source>:<srcKey>`.
 *
 * finding 은 파일/URL 하나하나지만 **사람이 조치하는 단위는 그것이 속한 곳**이다
 * (IP·저장소·웹도메인·스페이스). 담당자가 진행사항을 적는 곳도 거기다 —
 * finding 20,644건에 하나씩 적으라고 할 수는 없다.
 *
 * `srcKey` 는 게이트웨이가 만드는 16자 sha256 접두다(`source_repo.src_key`).
 * 원문(IP·repo 이름)을 키로 쓰지 않는 이유가 그쪽에 적혀 있다 — 여기서도 원문은 안 쓴다.
 *
 * ⚠️ 저장은 **finding 과 같은 테이블**(`finding_triage`/`finding_triage_note`)이다.
 *    `finding_ref` 는 text PK 라 스키마 변경 없이 들어간다. 컬럼 이름이 `finding_` 인 채로
 *    티켓 ref 를 담는 게 이상해 보이지만, 이름을 바꾸는 마이그레이션보다 **낫다** —
 *    낙관동시성·append-only 코멘트·감사 기록이 이미 거기 붙어 있고, 두 벌로 만들면
 *    그 셋 중 하나가 반드시 한쪽에만 붙는다.
 */
export const TriageTicketRef = z.string().regex(
  /^ticket:[a-z0-9_]+:[0-9a-f]{16}$/,
  "ticket:<source>:<srcKey(16 hex)> 형식이어야 함",
);
export type TriageTicketRef = z.infer<typeof TriageTicketRef>;

/** 트리아지가 붙을 수 있는 것 — finding 하나 또는 티켓(대상) 하나. */
export const TriageRef = z.union([TriageFindingRef, TriageTicketRef]);
export type TriageRef = z.infer<typeof TriageRef>;

/** 게이트웨이 finding 숫자 id → 참조 키. web/서버 공용(한 곳에서만 구성). */
export function triageRefFor(findingId: number): string {
  return `finding:${FINDING_SOURCE}:${findingId}`;
}

/** 게이트웨이 srcKey → 티켓 참조 키. web/서버 공용(한 곳에서만 구성). */
export function triageRefForTicket(srcKey: string): string {
  return `ticket:${FINDING_SOURCE}:${srcKey}`;
}

/** 코멘트 — append-only, 원문은 audit_log에 복제하지 않는다. */
export const TriageNote = z.object({
  id: z.string(),
  body: z.string(),
  actor: z.string(),
  at: z.string(), // ISO
});
export type TriageNote = z.infer<typeof TriageNote>;

/** 트리아지 레코드 — 상태 1개 + 코멘트 N개. version=낙관적 동시성. */
export const TriageRecord = z.object({
  findingRef: TriageRef,
  status: TriageStatus,
  version: z.number().int().nonnegative(), // 0=미영속(기본). 상태 변경 시마다 +1.
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(), // ISO
  notes: z.array(TriageNote),
});
export type TriageRecord = z.infer<typeof TriageRecord>;

/** 배치 조회 응답 — 요청 refs 중 영속된 것만(없으면 web이 기본 unclassified/version 0으로 표시). */
export const TriageBatchResponse = z.object({
  items: z.array(TriageRecord),
});
export type TriageBatchResponse = z.infer<typeof TriageBatchResponse>;

/** 배치 조회 쿼리 — 쉼표구분 refs(최대 200). */
export const TriageBatchQuery = z.object({
  refs: z.string().min(1), // "finding:th:1,finding:th:2"
});
export type TriageBatchQuery = z.infer<typeof TriageBatchQuery>;

/** 상태 변경 요청 — expectedVersion으로 낙관적 동시성(미지정=강제 upsert 금지, 0=신규). */
export const SetTriageStatusRequest = z.object({
  findingRef: TriageRef,
  status: TriageStatus,
  expectedVersion: z.number().int().nonnegative(), // 클라가 아는 현재 version(신규=0)
});
export type SetTriageStatusRequest = z.infer<typeof SetTriageStatusRequest>;

/** 코멘트 추가 요청. */
export const AddTriageNoteRequest = z.object({
  findingRef: TriageRef,
  body: z.string().min(1).max(2000),
});
export type AddTriageNoteRequest = z.infer<typeof AddTriageNoteRequest>;

/**
 * 티켓 상태 — **콘솔 필터(`THREAD_STATE_FILTER`)와 같은 어휘**로 사람이 직접 고친다.
 *
 * ## 왜 트리아지와 별개인가 (2026-09-01 사용자 요청)
 *
 * 위 `TriageStatus` 는 제품 DB 에만 사는 오버레이라 **파이프라인이 모른다**. 운영자가
 * "처리완료" 를 눌러도 티켓은 그대로였다(실측: 스레드 129 를 다섯 번 눌렀는데 smb 는
 * 계속 `awaiting_reply`). 사용자 결정 — 필터에 있는 상태값을 사람이 고칠 수 있게 한다.
 *
 * ⚠️ `none`(보고 없음)·`reported`(보고 생성)는 여기 **없다.** 둘 다 "스레드가 있느냐" 를
 *    말하는 파생값이지 고를 수 있는 상태가 아니다.
 * ⚠️ 도메인 native status 로의 번역은 **서버가 한다**(skill `services/ticket_status.py`).
 *    어휘가 도메인마다 다르다 — 회신 대기는 smb 가 `awaiting_reply`, github 은
 *    `awaiting_owner` 다. 화면이 native 값을 보내면 그 차이를 화면이 떠안게 된다.
 */
export const TicketStatus = z.enum(["ready", "awaiting", "replied", "closed"]);
export type TicketStatus = z.infer<typeof TicketStatus>;

/** 라벨 — 필터 칩(`THREAD_STATE_FILTER`)과 **같은 말**이어야 한다. 다르면 같은 걸 두 이름으로 부른다. */
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  ready: "발송 대기",
  awaiting: "회신 대기",
  replied: "회신 옴",
  // ★ 파이프라인이 성공에 붙이는 라벨과 **같은 말**을 쓴다(2026-09-01 사용자 결정: "조치완료로 통일").
  //   버튼이 "종결" 이고 파이프라인이 "조치 완료" 면 같은 결과가 두 이름을 갖는다 —
  //   목록 필터는 둘 다 "종결" 그룹이라 티가 안 나고 **상세 화면에서만** 갈렸다.
  closed: "조치 완료",
};
export const TICKET_STATUS_ORDER = TicketStatus.options;

/**
 * ★ 누르면 파이프라인이 **움직이는** 상태. 화면이 그렇게 말해야 한다.
 *
 * `replied`(회신 옴)는 공용 러너가 집어 가는 큐다 — 재검증을 돌리고 담당자에게
 * **회신 메일을 보낸다.** 되돌릴 수 없다.
 * `ready`(발송 대기)는 파킹 자리라 자동으로 나가지 않는다(운영자가 수동 발송).
 */
export const TICKET_STATUS_DRIVES_PIPELINE: Record<TicketStatus, string | null> = {
  ready: null,
  awaiting: null,
  replied: "러너가 재검증을 돌리고 담당자에게 회신 메일을 보냅니다.",
  closed: null,
};

/** 상태 변경 요청 — 도메인 + 스레드 + 고른 값. native status 는 서버가 정한다. */
export const TicketStatusDraft = z.object({
  domain: z.string().min(1).max(40),
  threadId: z.number().int().positive(),
  status: TicketStatus,
});
export type TicketStatusDraft = z.infer<typeof TicketStatusDraft>;

/** 결과 — 무엇이 무엇으로 바뀌었는지 화면이 그대로 보여준다. */
export const TicketStatusResult = z.object({
  domain: z.string(),
  threadId: z.number().int(),
  ticketStatus: TicketStatus,
  previous: z.string().nullable().optional(),
  status: z.string(),
  requestedBy: z.string().nullable().optional(),
  at: z.number().optional(),
});
export type TicketStatusResult = z.infer<typeof TicketStatusResult>;

/**
 * 도메인 native status → 티켓 상태(필터 키). **화면이 "지금 어디" 를 아는 유일한 길.**
 *
 * ⚠️ 서버의 정방향 맵(`skill service/services/ticket_status.py::TICKET_STATUS_MAP`)과
 *    **반드시 짝이 맞아야 한다.** 갈라지면 눌러도 같은 칸이 켜진 채로 남는다.
 *    skill `service/tests/test_ticket_status.py` 가 이 파일을 읽어 대조한다
 *    (`src_key()` 의 SQL/Python 두 판을 테스트로 묶어 둔 것과 같은 규율).
 * ⚠️ 여기 없는 native status 는 `null` 이다 — "모른다" 를 아무 칸으로 접지 않는다.
 *    (`draft`·`reverifying`·`escalated` 등은 사람이 고를 수 있는 상태가 아니다.)
 */
export const NATIVE_TO_TICKET_STATUS: Record<string, TicketStatus> = {
  report_ready: "ready",
  awaiting_reply: "awaiting",
  awaiting_owner: "awaiting",
  reply_received: "replied",
  recheck_requested: "replied",
  // 서버가 쓰는 값은 `remediated` 다.
  remediated: "closed",
  // `closed` 는 **읽기 전용** — 파이프라인이나 예전 운영자가 남긴 값이라 칸은 켜 주되,
  // 버튼이 그 값을 새로 만들지는 않는다(그래서 "서버가 쓰는 값" 검사에서 면제한다).
  closed: "closed",
};

/** native status 를 티켓 상태로 접는다. 모르면 null — 어느 칸도 켜지 않는다. */
export function ticketStatusOf(native: string | null | undefined): TicketStatus | null {
  return NATIVE_TO_TICKET_STATUS[String(native ?? "")] ?? null;
}
