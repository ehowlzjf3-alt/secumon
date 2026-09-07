import type { IconName } from "./icons";

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** 사이드바 우측 숫자. 라이브 집계에서 채운다(없으면 안 그린다). */
  countKey?: "sources" | "findings" | "threads" | "components" | "templates";
  end?: boolean;
}

/**
 * 관제 → 기록 → 설정 순. 손이 먼저 가는 것이 위다.
 *
 * 인사(HR) 은유는 버렸다 — 조직도·임직원·채용·승인·근무지. 이 시스템이 실제로 하는 일은
 * 4개 도메인 워커가 유출을 찾아 담당자에게 통보하는 것이고, 운영자가 보고 싶은 것은
 * "누가 몇 명인가" 가 아니라 "무엇이 어디서 발견됐고 조치가 어디까지 갔는가" 다.
 */
export const NAV_SECTIONS: { heading: string; items: NavItem[] }[] = [
  {
    heading: "관제",
    items: [
      { to: "/", label: "개요", icon: "grid", end: true },
      { to: "/tickets", label: "티켓", icon: "ticket", countKey: "sources" },
      { to: "/agents", label: "에이전트", icon: "pulse", countKey: "components" },
    ],
  },
  {
    heading: "기록",
    items: [
      { to: "/findings", label: "발견사항", icon: "list", countKey: "findings" },
      // ⚠️ "발송 이력" 이 아니다 — countKey="threads" 는 **스레드 수**이고, 실제 발송은
    //    그중 극소수다(2026-08-24 실측 1,639 중 1건). 라벨을 발송으로 되돌리지 말 것.
    { to: "/reports", label: "보고 스레드", icon: "mail", countKey: "threads" },
    ],
  },
  {
    heading: "설정",
    items: [{ to: "/mail-templates", label: "메일 서식", icon: "doc", countKey: "templates" }],
  },
];

const TITLES: Record<string, string> = {
  "/": "개요",
  "/tickets": "티켓",
  "/agents": "에이전트",
  "/findings": "발견사항",
  "/reports": "보고 스레드",
  "/mail-templates": "메일 서식",
};

export function titleForPath(pathname: string): string {
  if (pathname.startsWith("/tickets/")) return "티켓 상세";
  if (pathname.startsWith("/findings/")) return "발견 상세";
  // TITLES 는 **정확 일치**다 — 하위 경로는 위처럼 접두로 따로 잡아야 브랜드명으로 안 떨어진다.
  return TITLES[pathname] ?? "시큐몬";
}
