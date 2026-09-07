/**
 * 워크스페이스 정적 레지스트리 — 구조만(도메인상태 없음). M2.3.
 *
 * 시작 시 fail-loud 검증: 각 항목 strict 계약 parse · workspace key 유일성 ·
 * sectionLayout key 유일성 · 모든 EmployeeDomain 이 registry key 로 존재(정적이라 FK 불가 대체).
 * 위반 시 부팅 throw — 잘못된 레지스트리로 서버가 뜨지 않는다.
 *
 * payload(Finding/ReportThread/KPI)는 여기 없다(불변식). M4 전엔 web mock, M4+엔 게이트웨이.
 */
import { EmployeeDomain, WorkspaceDescriptor } from "@digisecu/contracts";

// 점검 도메인 공통 레이아웃(성과→발견→보고). payload는 key로 바인딩(web mock/게이트웨이).
const TASK_LAYOUT = [
  { key: "performance", type: "performance", title: "성과 대시보드" },
  { key: "pipeline", type: "pipeline", title: "파이프라인 흐름" },
  { key: "runtime", type: "runtime", title: "가동 상태" },
  { key: "activity", type: "activity", title: "실행 이력" },
  { key: "findings", type: "findings", title: "발견" },
  { key: "reports", type: "reports", title: "보고" },
];

const RAW: unknown[] = [
  // domain 은 게이트웨이 taskType 으로도 쓰이므로 엔진 task_type('smb', 소문자)과 정확히 일치해야 한다.
  // (대문자 'SMB' 는 /gw/findings 의 _require_domain 에서 404 → 발견사항 전멸. 나머지 3개처럼 소문자로.)
  { key: "smb", label: "SMB 공유폴더", domain: "smb", blurb: "사내 SMB 셰어의 노출·크리덴셜 점검", icon: "folder", accent: "#7a5c3e", supportStage: "mock_preview", sectionLayout: TASK_LAYOUT },
  { key: "dev_web", label: "dev_web 개발웹", domain: "dev_web", blurb: "개발·스테이징 웹 서비스 취약점 점검", icon: "globe", accent: "#5e6e4a", supportStage: "mock_preview", sectionLayout: TASK_LAYOUT },
  { key: "github", label: "GitHub 저장소", domain: "github", blurb: "저장소 시크릿·민감정보 스캔", icon: "git", accent: "#6b5563", supportStage: "mock_preview", sectionLayout: TASK_LAYOUT },
  { key: "confluence", label: "Confluence 스페이스", domain: "confluence", blurb: "스페이스 접근제어·문서 노출 점검", icon: "book", accent: "#4f6472", supportStage: "mock_preview", sectionLayout: TASK_LAYOUT },
  // planned — 담당 배정·연동 전. 클릭 불가 preview(가짜 persist 없음).
  { key: "vuln", label: "취약점 점검", domain: "vuln", blurb: "예정 — 담당 배정·state_domain 연동 전", icon: "door", accent: "#8a7f6b", supportStage: "planned", sectionLayout: [] },
  { key: "soc", label: "SOC 티켓", domain: "soc", blurb: "예정 — 담당 배정·state_domain 연동 전", icon: "door", accent: "#8a7f6b", supportStage: "planned", sectionLayout: [] },
];

function buildRegistry() {
  const parsed = RAW.map((r, i) => {
    const res = WorkspaceDescriptor.safeParse(r);
    if (!res.success) {
      throw new Error(`[workspaces] registry[${i}] 계약 위반: ${JSON.stringify(res.error.flatten())}`);
    }
    return res.data;
  });
  const keys = new Set<string>();
  for (const w of parsed) {
    if (keys.has(w.key)) throw new Error(`[workspaces] 중복 workspace key: ${w.key}`);
    keys.add(w.key);
    const sectionKeys = new Set<string>();
    for (const s of w.sectionLayout) {
      if (sectionKeys.has(s.key)) throw new Error(`[workspaces] ${w.key} 내 중복 section key: ${s.key}`);
      sectionKeys.add(s.key);
    }
  }
  // assignment 유효성: 채용은 workspace_key=domain 을 쓰므로 모든 도메인이 등록돼야 한다.
  for (const d of EmployeeDomain.options) {
    if (!keys.has(d)) throw new Error(`[workspaces] EmployeeDomain '${d}' 에 대응하는 워크스페이스 미등록`);
  }
  return parsed;
}

export const WORKSPACE_REGISTRY = buildRegistry();
