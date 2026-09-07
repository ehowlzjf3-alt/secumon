/**
 * persona ↔ 엔진 런타임 바인딩 (M1~M3 리비전 — secu-agent v3.85+ 정합).
 *
 * 엔진 리비전으로 `hunter→agent_type`, `hunt→task`. 엔진에서 **agent_type = 보안 도메인**
 * (smb/dev_web/github/confluence; 코어 시드는 'agent', 도메인 plugin이 register_agent_type),
 * **task_type = 도메인**(finding 제출이 `submit_finding(task_type='smb')`), 파이프라인 스테이지는
 * 스킬 TaskPlan(`<domain>_task | <domain>_report_mail | <domain>_reply_verify`).
 *
 * **불변식(codex 최상위 리스크)**: digisecu persona 문자열(smb_agent 등)을 **엔진에 직접 전달 금지** —
 * 반드시 이 매핑을 경유해 agent_type/task_type로 변환한다(누락 시 UI 역할↔런타임 조용한 불일치).
 * persona는 digisecu HR 소유 식별자, 엔진 식별자는 여기서 파생한다.
 */
import { z } from "zod";
import { EmployeeDomain } from "./roster";

/** 엔진 agent_type = 보안 도메인. */
export const EngineAgentType = EmployeeDomain; // smb | dev_web | github | confluence
export type EngineAgentType = z.infer<typeof EngineAgentType>;

/** 파이프라인 스테이지 — 구 hunt/report/verify. 스킬 TaskPlan으로 결부. */
export const TaskStage = z.enum(["task", "report", "verify"]);
export type TaskStage = z.infer<typeof TaskStage>;

/** persona → 엔진 런타임 바인딩 결과. fanout 워커/파트장만 바인딩. */
export interface RuntimeBinding {
  agentType: EngineAgentType; // = domain
  taskType: EngineAgentType; // 엔진 finding task_type (= domain)
  stage: TaskStage;
  /** 스킬 register_task_plan 기준 실제 TaskPlan 이름(도메인×스테이지). 아래 DOMAIN_TASK_PLANS 참조. */
  taskPlan: string;
}

/**
 * 도메인×스테이지 → 엔진 실제 TaskPlan 이름.
 * secu-agent-skill v3.85+ 레지스트리 **실측**값(SA_PLUGINS load_plugins 후 `list_task_plans()` 확인):
 *   smb        → smb_task / smb_report_mail / smb_reply_verify
 *   dev_web    → dev_web_task / dev_web_report / dev_web_reply_verify
 *   github     → github_task / github_report / github_recheck
 *   confluence → confluence_task / confluence_report / confluence_recheck
 * **주의**: report/verify 이름은 도메인마다 다르다 — 균일 파생(`<domain>_report_mail`)은 SMB에만 맞고
 * github/confluence(verify=recheck)·dev_web(report=report)에서 조용한 불일치를 낳으므로 하드코딩하지 말 것.
 */
const DOMAIN_TASK_PLANS: Record<EngineAgentType, Record<TaskStage, string>> = {
  smb: { task: "smb_task", report: "smb_report_mail", verify: "smb_reply_verify" },
  dev_web: { task: "dev_web_task", report: "dev_web_report", verify: "dev_web_reply_verify" },
  github: { task: "github_task", report: "github_report", verify: "github_recheck" },
  confluence: { task: "confluence_task", report: "confluence_report", verify: "confluence_recheck" },
};

/** persona 접미사 → 스테이지. fanout 워커 아님(오케스트레이터/전략/HR)이면 null. */
export function stageOfPersona(persona: string | null | undefined): TaskStage | null {
  if (!persona) return null;
  if (/(_agent|_task_lead)$/.test(persona)) return "task";
  if (/(_reporter|_report_lead)$/.test(persona)) return "report";
  if (/(_verifier|_verify_lead)$/.test(persona)) return "verify";
  return null; // _strategist / _sentinel / _scout / _warden / _auditor / people_ops 등
}

/**
 * 도메인 + persona → 엔진 런타임 바인딩. fanout 워커/파트장만 바인딩되고, 그 외(오케스트레이터·전략·HR·root)는 null.
 * 엔진 spawn 시 이 결과의 agentType/taskType/taskPlan만 사용하고 persona 문자열은 전달하지 않는다.
 */
export function runtimeBindingFor(
  domain: EmployeeDomain | null | undefined,
  persona: string | null | undefined,
): RuntimeBinding | null {
  if (!domain) return null;
  const stage = stageOfPersona(persona);
  if (!stage) return null;
  return { agentType: domain, taskType: domain, stage, taskPlan: DOMAIN_TASK_PLANS[domain][stage] };
}

/**
 * role 스킬 (P4) — 조직 역할을 엔진 role agent_type/스킬에 바인딩.
 * work 스킬(도메인 점검)과 별개 축: HR·매니저·전략은 도메인 work가 아니라 role 스킬로 뜬다.
 * (secu-agent-skill/roles/{hr,orchestrator,strategy}, register_agent_type + task_contract.)
 */
export const RoleSkill = z.enum(["hr", "orchestrator", "strategy"]);
export type RoleSkill = z.infer<typeof RoleSkill>;

/**
 * persona → role 스킬(엔진 agent_type). role 워커가 아니면 null(그 경우 work 스킬 runtimeBindingFor 시도).
 * - people_ops → hr
 * - *_sentinel/_scout/_warden/_auditor(도메인 오케스트레이터) → orchestrator
 * - *_strategist → strategy
 * orchestrator/strategy는 도메인 파라미터화(임직원의 domain이 어느 도메인을 관리·전략하는지 공급).
 */
export function roleSkillFor(persona: string | null | undefined): RoleSkill | null {
  if (!persona) return null;
  if (persona === "people_ops") return "hr";
  if (/(_sentinel|_scout|_warden|_auditor)$/.test(persona)) return "orchestrator";
  if (/_strategist$/.test(persona)) return "strategy";
  return null;
}

/** persona → 엔진 스킬 바인딩(role 우선, 없으면 work). digisecu가 임직원 파드를 어느 스킬로 띄울지 결정. */
export function skillBindingFor(
  domain: EmployeeDomain | null | undefined,
  persona: string | null | undefined,
): { kind: "role"; roleSkill: RoleSkill; domain: EmployeeDomain | null } | ({ kind: "work" } & RuntimeBinding) | null {
  const role = roleSkillFor(persona);
  if (role) return { kind: "role", roleSkill: role, domain: domain ?? null };
  const work = runtimeBindingFor(domain, persona);
  return work ? { kind: "work", ...work } : null;
}
