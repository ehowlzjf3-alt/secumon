/**
 * 라이프사이클 계약 — 상태·명령·런타임 표식 (M2.1).
 *
 * 경계(a2a codex 확정): contracts = 순수 구조·계약(상태/명령 enum)만.
 * 유효 전이표·가드는 control-plane 단일 policy 모듈이 권위를 가진다(여기 두지 않음).
 *
 * 주의: 실제 파드 런타임(Provisioning/Running/Unhealthy/Draining 전이)은 M3.
 * M2에서 DB가 쓰는 상태는 Running/Paused/Terminated 뿐이며, 그 Running은
 * 파드 실체화 전 placeholder다(→ runtimeMode 로 정직 표식).
 */
import { z } from "zod";

/**
 * 라이프사이클 상태기계 (§3-1). 7종.
 * M3부터 이 값은 **관측된 phase(observed)** — 드라이버(mock/파드)가 보고하는 실제 상태다.
 * 의도(desired)는 별도 필드(DesiredState). M2까진 단일 필드가 intent+observation을 겸했으나
 * (pause/terminate 경합·거짓 UI 위험) M3.0에서 분리했다(codex).
 */
export const LifecycleState = z.enum([
  "Hired",
  "Provisioning",
  "Running",
  "Paused",
  "Unhealthy",
  "Draining",
  "Terminated",
]);
export type LifecycleState = z.infer<typeof LifecycleState>;

/**
 * 의도(desired) 상태 — control-plane이 소유하는 "파드가 무엇이어야 하는가". 드라이버가 이 쪽으로 수렴.
 * pause/resume/terminate·예산 하드스톱이 desired를 바꾸고, 드라이버가 observed(LifecycleState)를 전이.
 */
export const DesiredState = z.enum(["Running", "Paused", "Terminated"]);
export type DesiredState = z.infer<typeof DesiredState>;

/**
 * 런타임 표식 — lifecycle 값이 실 파드 상태인지, 파드 실체화 전 placeholder인지.
 * M2엔 파드가 없어 항상 "mock". M3에서 파드 백엔드 임직원은 "live".
 * (codex: 물리 리네임 대신 기계판독 표식으로 실 런타임 오인 방지.)
 */
export const RuntimeMode = z.enum(["mock", "live"]);
export type RuntimeMode = z.infer<typeof RuntimeMode>;

/**
 * 라이프사이클 명령 — API가 노출하는 전이 트리거.
 *  - pause/resume: 게이트 없는 직접 전이.
 *  - terminate:    승인 게이트(요청 → pending → 승인 시 Terminated).
 * hire는 기존 임직원 전이가 아니라 생성이므로 명령이 아니다.
 */
export const LifecycleCommand = z.enum(["pause", "resume", "terminate"]);
export type LifecycleCommand = z.infer<typeof LifecycleCommand>;
