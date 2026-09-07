/**
 * 라이프사이클 전이 정책 — 단일 권위 모듈 (M2.1 → M3.0 desired 기준으로 이전).
 *
 * 경계(codex): 순수 상태머신. admission(예산)·org·pending 무지. API가 candidateActions(desired) 위에
 * org/pending/G6/budget 가드를 합성해 allowedActions 산출(web은 결과만 렌더).
 *
 * M3.0: 명령(pause/resume/terminate)은 **desired(intent)**를 전이시킨다. observed phase(lifecycle)는
 * 드라이버가 수렴시키므로 여기서 다루지 않는다(desired ⟂ observed 분리).
 */
import type { DesiredState, LifecycleCommand } from "@digisecu/contracts";

/** pause/resume 가 바꾸는 desired 의 정확한 from→to. transition CAS 근거(0행이면 전이 불가). */
const DIRECT: Record<"pause" | "resume", { from: DesiredState; to: DesiredState }> = {
  pause: { from: "Running", to: "Paused" },
  resume: { from: "Paused", to: "Running" },
};

/** terminate 후보 desired 상태 — 승인 실행 시 이 집합에서만 desired=Terminated 로 전이. */
export const TERMINABLE_FROM: readonly DesiredState[] = ["Running", "Paused"];

/** pause/resume 의 desired from/to (CAS 근거). */
export function directTransition(cmd: "pause" | "resume"): { from: DesiredState; to: DesiredState } {
  return DIRECT[cmd];
}

/**
 * 구조적으로 유효한 lifecycle 명령 — desired(intent) 기준. Terminated 는 흡수(빈 배열).
 */
export function candidateActions(desired: DesiredState | null): LifecycleCommand[] {
  const out: LifecycleCommand[] = [];
  if (desired === DIRECT.pause.from) out.push("pause");
  if (desired === DIRECT.resume.from) out.push("resume");
  if (desired !== null && TERMINABLE_FROM.includes(desired)) out.push("terminate");
  return out;
}
