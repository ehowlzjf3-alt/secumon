import { NavLink } from "react-router-dom";
import { Icon } from "./icons";
import { Logo } from "./Logo";
import { NAV_SECTIONS } from "./nav";
import { useGatewayStats } from "../lib/queries";
import { num } from "../lib/guards";

/**
 * 사이드바 숫자는 **서버 집계**(/gw/stats)에서만 온다.
 * 목록을 받아서 세면 조용히 틀린다 — github 19,808건을 500건으로 자른 뒤 세던 것이 그랬다.
 * 집계를 못 불러오면 숫자를 안 그린다(0 으로 위장하지 않는다).
 */
export function Sidebar() {
  const { data: stats } = useGatewayStats();
  const counts: Record<string, number | undefined> = {
    sources: stats?.totals.sources,
    findings: stats?.totals.findings,
    threads: stats?.totals.threads,
    components: undefined, // 에이전트 수는 /gw/runtime/presence 가 소유 — 화면에서 센다
    templates: 7, // 메일 서식은 코드에 내장된 정적 카탈로그(mailTemplates.ts)
  };

  return (
    <aside className="flex flex-col border-r border-line bg-side">
      <div className="flex items-center gap-2.5 px-5 py-4">
        <Logo className="h-7 w-7 shrink-0" />
        <span className="font-serif text-[18px] leading-none tracking-tight">시큐몬</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {NAV_SECTIONS.map((section) => (
          <div key={section.heading} className="mt-2">
            <div className="px-3 py-1.5 text-[11px] tracking-[0.08em] text-muted">{section.heading}</div>
            <div className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const n = item.countKey ? counts[item.countKey] : undefined;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      [
                        "flex items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] transition-colors",
                        isActive ? "bg-sel text-walnut-ink" : "text-ink/85 hover:bg-sel/60",
                      ].join(" ")
                    }
                  >
                    <Icon name={item.icon} className="h-[15px] w-[15px] shrink-0" />
                    <span>{item.label}</span>
                    {typeof n === "number" ? (
                      <span className="ml-auto font-mono text-[11px] tabular-nums text-muted">{num(n)}</span>
                    ) : null}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* 이 화면이 메일을 보내지 않는다는 사실은 숨기지 않는다.
          ⚠️ 예전엔 여기 `dssoc_only · dev-safe` 라고 적혀 있었다. 두 가지가 틀렸다 —
          ① `dssoc_only` 모드는 2026-08-24 에 폐기됐다(수신처는 담당자 To + DSSOC Cc).
          ② 애초에 **콘솔은 발송 모드를 알 수 없다.** 그건 엔진 env(`*_REMEDIATION_MAIL_MODE`
             + `SA_DELIVERY_*`)이고 게이트웨이가 표면화하지 않는다. 하드코딩한 라벨은
             설정이 바뀌어도 안 따라가면서 운영자에게 확신을 준다.
          아는 것만 말한다: 이 콘솔은 읽기 전용이다(게이트웨이 롤이 `transaction_read_only`). */}
      <div className="border-t border-line px-4 py-3 text-[11.5px] text-muted">
        <div>이 콘솔</div>
        <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-sel px-2 py-1 font-mono text-[11px] text-walnut-ink">
          <Icon name="shield" className="h-3.5 w-3.5" />
          읽기 전용 · 발송하지 않음
        </div>
        <div className="mt-1 leading-snug">
          실제 발송 모드는 엔진 설정이라 여기서 알 수 없습니다.
        </div>
      </div>
    </aside>
  );
}
