/**
 * 워크스페이스(근무지) 구조 계약 — M2.3 (web-only → contracts+control-plane 승격).
 *
 * 경계(불변식): 이 계약은 **구조/레이아웃만** 담는다. Finding/ReportThread/KPI 등
 * 도메인상태(state_domain, M4 게이트웨이 유일 경로)는 절대 포함하지 않는다 — `.strict()`가
 * items/count/status/query/endpoint 같은 도메인데이터·파생값 유입을 API 경계에서 거부한다.
 * payload는 M4 전까진 web mock, M4+엔 게이트웨이가 sectionLayout.key 로 채운다.
 */
import { z } from "zod";

/** 섹션 렌더러 타입 — web sections 렌더러 키와 1:1. */
// runtime/activity 는 게이트웨이 /gw/runtime/* 를 그대로 읽는다(payload 불필요) —
// 8767 도메인 UI 의 "Heartbeats"·"Operator/Worker Console" 을 5180 으로 옮긴 것.
export const WorkspaceSectionType = z.enum([
  "performance", "findings", "reports", "runtime", "activity", "pipeline",
]);
export type WorkspaceSectionType = z.infer<typeof WorkspaceSectionType>;

/** 지원 단계 — mock 미리보기 | 예정(미배정) | 게이트웨이 연동(M4+ 실 payload). `ready` 불리언 대체. */
export const WorkspaceSupportStage = z.enum(["mock_preview", "planned", "gateway_backed"]);
export type WorkspaceSupportStage = z.infer<typeof WorkspaceSupportStage>;

/** 레이아웃 슬롯 — payload 없음(key로 바인딩). strict로 도메인데이터 유입 차단. */
export const WorkspaceSectionLayout = z
  .object({
    key: z.string().min(1), // payload 바인딩 키(안정적, 워크스페이스 내 유일)
    type: WorkspaceSectionType, // 렌더러 선택
    title: z.string().min(1),
  })
  .strict();
export type WorkspaceSectionLayout = z.infer<typeof WorkspaceSectionLayout>;

/** 워크스페이스 구조 서술자 — 담당자(employee)는 여기 없음(employees.workspace_key로 조인). */
export const WorkspaceDescriptor = z
  .object({
    key: z.string().min(1), // 라우트·employees.workspace_key 조인 키
    label: z.string().min(1),
    domain: z.string().min(1), // 짧은 표시 태그
    blurb: z.string(),
    icon: z.string().min(1), // web IconName 토큰
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/), // 악센트 hex
    supportStage: WorkspaceSupportStage,
    sectionLayout: z.array(WorkspaceSectionLayout),
  })
  .strict();
export type WorkspaceDescriptor = z.infer<typeof WorkspaceDescriptor>;

/** GET /api/workspaces 응답 — 정적 레지스트리(read-only). */
export const WorkspaceListResponse = z.object({ workspaces: z.array(WorkspaceDescriptor) });
export type WorkspaceListResponse = z.infer<typeof WorkspaceListResponse>;
