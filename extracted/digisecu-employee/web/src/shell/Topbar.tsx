import { useLocation } from "react-router-dom";
import { titleForPath } from "./nav";
import { runSinceLabel } from "../lib/runScope";
import { useGatewayStats } from "../lib/queries";
import { stamp } from "../lib/guards";

/**
 * 제목 + **지금 무엇을 보고 있는지**.
 *
 * ★ `runSinceLabel()` 을 표면화한다. 예전엔 `VITE_RUN_SINCE` 가 기본값으로 조용히 걸려 있어서
 *   화면이 전체를 보여주는 줄 알았는데 실은 잘린 범위였다 — 필터가 걸렸으면 반드시 보인다.
 */
export function Topbar() {
  const { pathname } = useLocation();
  const since = runSinceLabel();
  const { data: stats } = useGatewayStats();

  return (
    <header className="flex items-center gap-3 border-b border-line px-5 py-3">
      <h1 className="font-serif text-[17px] font-medium">{titleForPath(pathname)}</h1>

      {since ? (
        <span className="rounded-md border border-[#e0cfa8] bg-[#f6efe2] px-2 py-0.5 text-[11.5px] text-[#8a5c10]">
          {since} 이후만 표시 중
        </span>
      ) : null}

      {stats ? (
        <span className="font-mono text-[11px] text-muted">
          기준 {stamp(stats.asOf)} · {stats.week}
        </span>
      ) : null}

      <div className="flex-1" />

      <span className="grid h-8 w-8 place-items-center rounded-full bg-sel font-serif text-[13px] text-walnut-ink">
        관
      </span>
    </header>
  );
}
