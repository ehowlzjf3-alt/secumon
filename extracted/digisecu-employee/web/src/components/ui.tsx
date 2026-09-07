/**
 * SOAR 콘솔 공용 프리미티브 — 종이·먹 팔레트 위에서만 쓴다.
 *
 * 규칙 하나: **없는 것은 "없음"으로 그린다.** 빈 배열을 조용히 아무것도 아닌 것으로
 * 두면 "고장" 과 "정상적으로 비었음" 이 구분되지 않는다. `Empty` 는 왜 비었는지를 받는다.
 */
import type { ReactNode } from "react";

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <section className={`rounded-xl border border-line bg-card ${className}`}>{children}</section>
  );
}

export function SectionTitle({
  title, meta, action,
}: { title: string; meta?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-baseline gap-2.5">
      <h2 className="font-serif text-[15px]">{title}</h2>
      {meta ? <span className="text-[12px] text-muted">{meta}</span> : null}
      {action ? <div className="ml-auto">{action}</div> : null}
    </div>
  );
}

/** 표 머리 칸. 한국어 라벨이라 uppercase 를 걸지 않는다. */
export function Th({
  children, align = "left", className = "",
}: { children?: ReactNode; align?: "left" | "right"; className?: string }) {
  return (
    <div
      className={`px-3 pb-2 text-[11px] font-normal text-muted ${align === "right" ? "text-right" : "text-left"} ${className}`}
    >
      {children}
    </div>
  );
}

export function Chip({
  active = false, onClick, children, tone,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  tone?: { bg: string; fg: string };
}) {
  const style = active && tone ? { background: tone.bg, color: tone.fg, borderColor: tone.bg } : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={style}
      className={[
        "rounded-full border px-2.5 py-1 text-[12px] transition-colors",
        active && !tone
          ? "border-sel bg-sel text-walnut-ink"
          : "border-line text-muted hover:border-[#d8c9a8] hover:bg-card",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

/** 상태 알약 — 어휘 밖 값은 원문을 회색으로 그린다(숨기면 상태가 사라진다). */
export function Pill({ tone, children }: { tone?: { bg: string; fg: string }; children: ReactNode }) {
  return (
    <span
      className="inline-block rounded-md px-2 py-0.5 text-[11.5px]"
      style={tone ? { background: tone.bg, color: tone.fg } : { background: "#efe8d8", color: "#8a7f6b" }}
    >
      {children}
    </span>
  );
}

/** 도메인 배지. */
export function DomainTag({ domain, label, color, tint }: {
  domain: string; label: string; color: string; tint: string;
}) {
  return (
    <span
      className="inline-block rounded px-2 py-0.5 text-[10.5px]"
      style={{ background: tint, color }}
      title={domain}
    >
      {label}
    </span>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div className="grid place-items-center gap-2 px-4 py-10 text-[12.5px] text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-walnut" />
      {what} 불러오는 중
    </div>
  );
}

/**
 * 빈 상태 — `why` 가 필수다.
 * "결과가 없음"과 "권한이 없어 못 읽음"과 "이 도메인엔 원래 없음"은 전부 다른 상태다.
 */
export function Empty({ why, hint }: { why: string; hint?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <div className="text-[13px] text-ink/70">{why}</div>
      {hint ? <div className="mx-auto mt-1.5 max-w-md text-[11.5px] text-muted">{hint}</div> : null}
    </div>
  );
}

/** 조회 실패 — 화이트스크린 대신. 게이트웨이가 안 뜬 상태를 정직하게 말한다. */
export function LoadError({ what, error }: { what: string; error?: unknown }) {
  const msg = error instanceof Error ? error.message : null;
  return (
    <div className="rounded-xl border border-[#e0bfb2] bg-[#fbf0ec] px-4 py-6 text-center">
      <div className="text-[13px] text-[#8f2f18]">{what}을(를) 불러오지 못했습니다</div>
      {msg ? <div className="mt-1.5 font-mono text-[11px] text-muted">{msg}</div> : null}
      <div className="mt-2 text-[11.5px] text-muted">
        게이트웨이가 떠 있는지, 토큰이 설정돼 있는지 확인하세요.
      </div>
    </div>
  );
}

/** 가로 스택 막대 — 조치 현황·품질 분포처럼 합이 의미 있는 것에만. */
export function StackBar({ parts, height = 7 }: { parts: { w: string; color: string; title?: string }[]; height?: number }) {
  return (
    <div className="flex overflow-hidden rounded" style={{ height, background: "#f2ece0" }}>
      {parts.map((p, i) => (
        <span key={i} style={{ width: p.w, background: p.color }} title={p.title} />
      ))}
    </div>
  );
}

/** 숫자 카드 — 개요의 "밀린 조치". */
export function StatCard({
  label, value, of, note, dot, line, onClick, to,
}: {
  label: string; value: string; of?: string; note?: ReactNode;
  dot: string; line: string; onClick?: () => void; to?: string;
}) {
  const inner = (
    <>
      <div className="flex items-center gap-2">
        <span className="h-[7px] w-[7px] rounded-full" style={{ background: dot }} />
        <span className="text-[12.5px] text-walnut-ink">{label}</span>
        {to || onClick ? (
          <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-walnut">
            보기
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M5 12h13m0 0-5-5m5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        ) : null}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-serif text-[34px] leading-none tabular-nums" style={{ color: dot }}>{value}</span>
        {of ? <span className="font-mono text-[11.5px] text-muted">/ {of}</span> : null}
      </div>
      {note ? <div className="text-[11.5px] leading-snug text-muted">{note}</div> : null}
    </>
  );
  const cls = "flex flex-col gap-1.5 rounded-xl border bg-card px-4 py-3.5 text-left transition-shadow";
  const style = { borderColor: line };
  if (onClick) {
    return (
      <button type="button" onClick={onClick} style={style} className={`${cls} hover:shadow-[0_2px_7px_rgba(44,38,32,0.07)]`}>
        {inner}
      </button>
    );
  }
  return <div style={style} className={cls}>{inner}</div>;
}

// ── 단건 상세용 프리미티브 ───────────────────────────────────────────────────

/** 라벨-값 한 쌍. 값이 없으면 아예 부르지 않는다(호출부에서 거른다) — 여기서 "—" 를
 *  기본값으로 깔면 "없음" 과 "모름" 이 같은 글자가 된다. */
export function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] text-muted">{label}</div>
      <div className={`break-words text-[12px] text-ink ${mono ? "font-mono text-[11.5px]" : ""}`}>
        {value}
      </div>
    </div>
  );
}

/** 절단 고지. **조용한 절단 금지** — 자른 것을 안 말하면 화면이 "이게 전부"라고 거짓말한다. */
export function CapNote({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <p className="mt-1.5 font-mono text-[10.5px] text-muted">
      {total}건 중 {shown}건만 표시 — 나머지 {total - shown}건은 화면에 없습니다.
    </p>
  );
}
