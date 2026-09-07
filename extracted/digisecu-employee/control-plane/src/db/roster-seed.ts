/**
 * 명부 시드 스냅샷 — web/src/lib/org.ts 조직트리를 DB 초기 데이터로 승격.
 * (M1.3에서 web 조직도가 이 DB를 읽게 되면 org.ts mock은 은퇴.)
 *
 * taxonomy: 사람=SEED_EMPLOYEES, 잡(도구)=SEED_TOOLS(owner_id로 담당자 귀속).
 *
 * M2.2: heartbeat(가짜 "8초 전" 문자열) 제거 — 실 heartbeat 시각(heartbeat_at)은
 * 텔레메트리(M3)가 채운다. 시드는 heartbeat_at 을 설정하지 않는다(null).
 */
type SeedEmployee = {
  id: string;
  name: string;
  title?: string;
  kind: "person" | "orchestrator" | "strategy" | "partlead" | "worker" | "hr";
  domain?: "smb" | "dev_web" | "github" | "confluence";
  persona?: string;
  role?: string;
  status?: "working" | "investigating" | "idle" | "paused";
  hotStart?: boolean;
  accent?: string;
  workspaceKey?: string;
  managerId?: string;
};
type SeedTool = { id: string; name: string; role: string; ownerId: string };

type Dom = "smb" | "dev_web" | "github" | "confluence";
type St = "working" | "investigating" | "idle" | "paused";

// 워커 (핫스타트)
const wk = (id: string, name: string, persona: string, status: St, mgr: string, domain: Dom): SeedEmployee =>
  ({ id, name, kind: "worker", persona, status, hotStart: true, managerId: mgr, domain });
// 파트장
const pl = (id: string, name: string, title: string, persona: string, role: string, status: St, mgr: string, domain: Dom): SeedEmployee =>
  ({ id, name, title, kind: "partlead", persona, role, status, managerId: mgr, domain });
// 전략담당
const st = (id: string, name: string, persona: string, status: St, mgr: string, domain: Dom): SeedEmployee =>
  ({ id, name, kind: "strategy", persona, role: "타깃 전략 · 수집 운영", status, managerId: mgr, domain });

export const SEED_EMPLOYEES: SeedEmployee[] = [
  { id: "root", name: "박준호", title: "보안운영팀장", kind: "person" },
  { id: "hr", name: "한지원", title: "HR", kind: "hr", persona: "people_ops", role: "채용·배치·해고", status: "working", managerId: "root" },

  // ── SMB ──────────────────────────────────────────────
  { id: "smb", name: "김세연", title: "SMB팀장", kind: "orchestrator", domain: "smb", persona: "smb_sentinel", status: "working", accent: "#7a5c3e", workspaceKey: "smb", managerId: "root" },
  st("smb-strat", "한도경", "smb_strategist", "working", "smb", "smb"),
  pl("smb-task", "문태경", "task 파트장", "smb_task_lead", "셰어 점검 총괄", "working", "smb", "smb"),
  wk("smb-h1", "김유나", "smb_agent", "working", "smb-task", "smb"),
  wk("smb-h2", "이준호", "smb_agent", "working", "smb-task", "smb"),
  wk("smb-h3", "박서연", "smb_agent", "working", "smb-task", "smb"),
  wk("smb-h4", "정민재", "smb_agent", "idle", "smb-task", "smb"),
  wk("smb-h5", "최다은", "smb_agent", "idle", "smb-task", "smb"),
  pl("smb-report", "윤지아", "report 파트장", "smb_report_lead", "리포트 발송 총괄", "idle", "smb", "smb"),
  wk("smb-r1", "남도현", "smb_reporter", "idle", "smb-report", "smb"),
  wk("smb-r2", "유하린", "smb_reporter", "idle", "smb-report", "smb"),
  pl("smb-verify", "강하람", "reply-verify 파트장", "smb_verify_lead", "회신 재검증 총괄", "idle", "smb", "smb"),
  wk("smb-v1", "조은채", "smb_verifier", "idle", "smb-verify", "smb"),
  wk("smb-v2", "백지훈", "smb_verifier", "idle", "smb-verify", "smb"),

  // ── dev_web ──────────────────────────────────────────
  { id: "dev_web", name: "이도현", title: "dev_web팀장", kind: "orchestrator", domain: "dev_web", persona: "web_scout", status: "investigating", accent: "#5e6e4a", workspaceKey: "dev_web", managerId: "root" },
  st("dw-strat", "문가온", "web_strategist", "working", "dev_web", "dev_web"),
  pl("dw-task", "서준영", "task 파트장", "web_task_lead", "웹 취약점 점검 총괄", "investigating", "dev_web", "dev_web"),
  wk("dw-h1", "임채호", "web_agent", "investigating", "dw-task", "dev_web"),
  wk("dw-h2", "신유진", "web_agent", "investigating", "dw-task", "dev_web"),
  wk("dw-h3", "홍서율", "web_agent", "idle", "dw-task", "dev_web"),
  pl("dw-report", "권도윤", "report 파트장", "web_report_lead", "리포트 발송 총괄", "idle", "dev_web", "dev_web"),
  wk("dw-r1", "배하준", "web_reporter", "idle", "dw-report", "dev_web"),
  pl("dw-verify", "황예린", "reply-verify 파트장", "web_verify_lead", "회신 재검증 총괄", "idle", "dev_web", "dev_web"),
  wk("dw-v1", "노경민", "web_verifier", "idle", "dw-verify", "dev_web"),

  // ── github ───────────────────────────────────────────
  { id: "github", name: "정하늘", title: "GitHub팀장", kind: "orchestrator", domain: "github", persona: "repo_warden", status: "idle", accent: "#6b5563", workspaceKey: "github", managerId: "root" },
  st("gh-strat", "배시우", "repo_strategist", "idle", "github", "github"),
  pl("gh-task", "남궁현", "task 파트장", "repo_task_lead", "시크릿 스캔 총괄", "idle", "github", "github"),
  wk("gh-h1", "노아인", "repo_agent", "idle", "gh-task", "github"),
  wk("gh-h2", "하지원", "repo_agent", "idle", "gh-task", "github"),
  wk("gh-h3", "구본진", "repo_agent", "idle", "gh-task", "github"),
  pl("gh-report", "진서우", "report 파트장", "repo_report_lead", "리포트 발송 총괄", "idle", "github", "github"),
  wk("gh-r1", "표민석", "repo_reporter", "idle", "gh-report", "github"),
  pl("gh-verify", "류하은", "reply-verify 파트장", "repo_verify_lead", "회신 재검증 총괄", "idle", "github", "github"),
  wk("gh-v1", "여진우", "repo_verifier", "idle", "gh-verify", "github"),

  // ── confluence ───────────────────────────────────────
  { id: "confluence", name: "최민서", title: "Confluence팀장", kind: "orchestrator", domain: "confluence", persona: "space_auditor", status: "paused", accent: "#4f6472", workspaceKey: "confluence", managerId: "root" },
  st("cf-strat", "도예준", "space_strategist", "paused", "confluence", "confluence"),
  pl("cf-task", "곽민서", "task 파트장", "space_task_lead", "스페이스 점검 총괄", "paused", "confluence", "confluence"),
  wk("cf-h1", "선우진", "space_agent", "paused", "cf-task", "confluence"),
  wk("cf-h2", "방지호", "space_agent", "idle", "cf-task", "confluence"),
  wk("cf-h3", "봉하영", "space_agent", "idle", "cf-task", "confluence"),
  pl("cf-report", "탁유주", "report 파트장", "space_report_lead", "리포트 발송 총괄", "idle", "confluence", "confluence"),
  wk("cf-r1", "마준서", "space_reporter", "idle", "cf-report", "confluence"),
  pl("cf-verify", "연서진", "reply-verify 파트장", "space_verify_lead", "회신 재검증 총괄", "idle", "confluence", "confluence"),
  wk("cf-v1", "하윤", "space_verifier", "idle", "cf-verify", "confluence"),
];

export const SEED_TOOLS: SeedTool[] = [
  { id: "smb-strat-col", name: "collector", role: "enumerate·list·walk", ownerId: "smb-strat" },
  { id: "dw-strat-col", name: "discovery collector", role: "SIEM·crawl 열거", ownerId: "dw-strat" },
  { id: "gh-strat-col", name: "repo collector", role: "org·branch 열거", ownerId: "gh-strat" },
  { id: "cf-strat-col", name: "space collector", role: "API 열거", ownerId: "cf-strat" },
];
