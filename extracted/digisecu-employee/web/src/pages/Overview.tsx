/**
 * 개요 — 4도메인 실집계 한 판(`/gw/stats`) + 도메인 런타임 presence(`/gw/runtime/presence`).
 *
 * 원칙 셋:
 *  1) **목록을 세지 않는다.** 모든 숫자는 서버가 준 totals/counts 다. `items.length` 로 만든
 *     숫자는 페이지네이션 밖을 못 보고 조용히 거짓말을 한다.
 *  2) **못 읽은 것과 없는 것을 구분한다.** `remediationLookup="denied"` 인 도메인은 조치 칸을
 *     0 으로 위장하지 않고 "측정 불가" 로 그린다(REMEDIATION_BASIS.none).
 *  3) **서버 문자열로 객체를 인덱싱하지 않는다.** 라벨/색은 전부 guards.label 을 통과시킨다
 *     (`table[key]` 는 `"constructor"` 같은 키에 프로토타입 체인이 뚫린다).
 *
 * 화면에 해설 문구를 쓰지 않는다 — 단위·기준·개수 라벨만 둔다. 근거 설명은 title(툴팁)로 뺀다.
 */
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type {
  ComponentRuntime,
  DomainRuntime,
  DomainStats,
  GatewayStats,
  RuntimePresence,
} from "@digisecu/contracts";
import { Card, Empty, Loading, LoadError, SectionTitle, StatCard, Th } from "../components/ui";
import { ago, asArr, asNum, asStr, label, num, pct } from "../lib/guards";
import { DOMAIN_COLOR, DOMAIN_LABEL, DOMAIN_TINT, REMEDIATION_BASIS } from "../lib/soarMeta";
import { useGatewayStats, useRuntimePresence } from "../lib/queries";

/** 조치 현황 표의 열 폭 — 머리 2줄과 본문·계 행이 같은 값을 공유해야 칸이 어긋나지 않는다.
 *
 * 2026-08-29: **티켓 축을 앞에, Finding 축을 뒤에** 둔다(사용자 결정). 이전 표는 전부
 * Finding 축이었고 티켓은 한 칸도 없었다 — `closedThreads`·`awaitingThreads` 는
 * 게이트웨이가 도메인별로 이미 세고 있었는데(`stats_service._thread_stats`) 화면이
 * 한 번도 안 읽었다. 조치는 "메일 보낸 건이 닫혔는가"(티켓)와 "노출이 사라졌는가"
 * (Finding) 두 축이고, 둘은 모수도 근거도 다르다.
 *
 * 도메인 · 티켓4 · Finding5
 *
 * ⚠️ 고정 px 로 두면 카드가 전폭인데 표만 656px 이라 왼쪽에 쏠린다. `fr` 로 카드 폭을
 *    채우되 `minmax` 로 숫자가 줄바꿈되는 하한을 지킨다(머리 2줄·본문·계 행이 같은 값을
 *    공유하므로 여기만 고치면 전부 따라온다). */
const COLS = "minmax(112px, 1.5fr) repeat(9, minmax(62px, 1fr))";

/** 노출 유형 막대 색 — 순서 고정(카테고리 키에 색을 묶지 않는다: 어휘가 늘면 순서로 흡수). */
const CAT_COLORS = [
  "#9a3620", "#5b6b45", "#8a5c10", "#4f6472", "#7a5c3e", "#6b5563", "#8a7f6b", "#c9bda6",
] as const;

/** REMEDIATION_BASIS 어휘 밖 basis 가 와도 툴팁이 비지 않게. */
const BASIS_FALLBACK = { short: "측정 불가", full: "조치를 확인할 근거를 알 수 없다." };

type WeeklyPoint = GatewayStats["weekly"][number];
type CategoryCount = GatewayStats["categories"][number];

/** presence 요약 — 컴포넌트 수는 서버 componentCounts 를 합산한다(components 배열을 세지 않는다). */
function summarizeRuntime(p: RuntimePresence | undefined): { stale: number; total: number; lastBeatAt: number | null } | null {
  if (!p) return null;
  let stale = 0;
  let total = 0;
  let lastBeatAt: number | null = null;
  for (const d of asArr<DomainRuntime>(p.domains)) {
    stale += asNum(d.componentCounts?.stale) ?? 0;
    total += asNum(d.componentCounts?.total) ?? 0;
    // 도메인 heartbeat 가 비어도 컴포넌트 쪽에 남아 있을 수 있어 둘 다 본다.
    const beats: (number | null)[] = [asNum(d.lastBeatAt)];
    for (const c of asArr<ComponentRuntime>(d.components)) beats.push(asNum(c.lastBeatAt));
    for (const b of beats) if (b !== null && (lastBeatAt === null || b > lastBeatAt)) lastBeatAt = b;
  }
  return { stale, total, lastBeatAt };
}

/** 표 본문 칸. 숫자는 mono+tabular-nums 로 자릿수를 맞춘다. */
function Td({
  children, align = "right", muted = false, mono = true, title, className = "",
}: {
  children: ReactNode;
  align?: "left" | "right";
  muted?: boolean;
  mono?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <div
      title={title}
      className={[
        "px-3 py-[7px] text-[12.5px]",
        align === "right" ? "text-right" : "text-left",
        mono ? "font-mono tabular-nums" : "",
        muted ? "text-muted" : "text-ink",
        className,
      ].join(" ")}
    >
      {children}
    </div>
  );
}

export function Overview() {
  const statsQ = useGatewayStats();
  const presenceQ = useRuntimePresence();
  const navigate = useNavigate();

  if (statsQ.isLoading) {
    return (
      <div className="px-5 py-4">
        <Loading what="개요 집계" />
      </div>
    );
  }
  if (statsQ.isError || !statsQ.data) {
    return (
      <div className="px-5 py-4">
        <LoadError what="개요 집계" error={statsQ.error} />
      </div>
    );
  }

  const stats = statsQ.data;
  // totals 는 계약상 필수지만 requireShape 는 domains 배열만 본다 — 필드는 전부 가드로 통과시킨다.
  const t = (stats.totals ?? {}) as Partial<GatewayStats["totals"]>;
  const week = asStr(stats.week);

  // 발견 수 내림차순 — 밀도(GitHub 쏠림)가 첫 화면에서 보이도록. 카드와 표가 같은 순서를 쓴다.
  const domains = asArr<DomainStats>(stats.domains)
    .slice()
    .sort((a, b) => (asNum(b.findings) ?? 0) - (asNum(a.findings) ?? 0));

  const unnotifiedNote = domains
    .filter((d) => (asNum(d.sourcesWithoutThread) ?? 0) > 0)
    .map((d) => `${label(DOMAIN_LABEL, d.domain, asStr(d.domain) ?? "미상")} ${num(d.sourcesWithoutThread)}`)
    .join(" · ");

  const runtime = summarizeRuntime(presenceQ.data);

  // 조치 근거를 못 읽은 도메인 — 계 행 툴팁에 밝힌다(합계가 그만큼 덜 세어진다).
  const deniedLabels = domains
    .filter((d) => asStr(d.remediationLookup) === "denied")
    .map((d) => label(DOMAIN_LABEL, d.domain, asStr(d.domain) ?? "미상"));

  const totalFindings = asNum(t.findings) ?? 0;
  const totalFp = asNum(t.falsePositive) ?? 0;
  const totalRemediated = asNum(t.remediated) ?? 0;

  const weekly = asArr<WeeklyPoint>(stats.weekly)
    .map((p) => ({ week: asStr(p.week), inflow: asNum(p.inflow) ?? 0 }))
    .filter((p): p is { week: string; inflow: number } => p.week !== null);
  const maxInflow = weekly.reduce((m, p) => Math.max(m, p.inflow), 0);

  const cats = asArr<CategoryCount>(stats.categories)
    .map((c) => ({ key: asStr(c.key), label: asStr(c.label), count: asNum(c.count) ?? 0 }))
    .filter((c): c is { key: string; label: string | null; count: number } => c.key !== null);
  const maxCat = cats.reduce((m, c) => Math.max(m, c.count), 0);

  return (
    <div className="px-5 py-4 space-y-4">
      {/* ── 1. 밀린 조치 ─────────────────────────────────────────────────── */}
      <section>
        <SectionTitle title="밀린 조치" />
        <div className="grid grid-cols-3 gap-3">
          <StatCard
            label="스레드 없는 대상"
            value={num(t.sourcesWithoutThread)}
            of={num(t.sources)}
            note={unnotifiedNote || null}
            dot="#7f1d1d"
            line="#dcc3bb"
            onClick={() => navigate("/tickets?threadState=none")}
          />
          <StatCard
            label="답장 없는 스레드"
            value={num(t.awaitingThreads)}
            of={num(t.threads)}
            dot="#b07d1a"
            line="#e6d6ae"
            onClick={() => navigate("/tickets?threadState=awaiting")}
          />
          <StatCard
            label="멎은 에이전트"
            value={runtime ? num(runtime.stale) : "—"}
            of={runtime ? num(runtime.total) : undefined}
            note={
              runtime
                ? `최근 신호 ${ago(runtime.lastBeatAt)}`
                : presenceQ.isLoading
                  ? "확인 중"
                  : "런타임 상태 조회 실패"
            }
            dot="#c2683a"
            line="#e8cbbb"
            onClick={() => navigate("/agents")}
          />
        </div>
      </section>

      {/* ── 2. 도메인 ────────────────────────────────────────────────────── */}
      <section>
        <SectionTitle title="도메인" meta={`대상 ${num(t.sources)} · 발견 ${num(t.findings)}`} />
        {domains.length === 0 ? (
          <Card>
            <Empty why="도메인 집계가 없습니다" hint="게이트웨이가 4도메인 중 어느 것도 읽지 못했습니다." />
          </Card>
        ) : (
          <div className="grid grid-cols-4 gap-3">
            {domains.map((d) => {
              const key = asStr(d.domain) ?? "";
              const name = label(DOMAIN_LABEL, key, key || "미상");
              const color = label(DOMAIN_COLOR, key, "#8a7f6b");
              const tint = label(DOMAIN_TINT, key, "#efe8d8");
              const sources = asNum(d.sources) ?? 0;
              const notified = asNum(d.sourcesWithThread) ?? 0;
              const barW = sources > 0 ? Math.min(100, Math.max(0, (notified / sources) * 100)) : 0;
              return (
                <Link
                  key={key || name}
                  to={`/tickets?domain=${encodeURIComponent(key)}`}
                  className="overflow-hidden rounded-xl border border-line bg-card transition-shadow hover:shadow-[0_2px_7px_rgba(44,38,32,0.07)]"
                >
                  <div className="flex items-center gap-2 px-3 py-2" style={{ background: tint }}>
                    <span className="h-[7px] w-[7px] rounded-full" style={{ background: color }} />
                    <span className="font-serif text-[13.5px] text-walnut-ink">{name}</span>
                    <span className="ml-auto font-mono text-[11px] tabular-nums text-muted">
                      큐 {num(d.queueWaiting)}
                    </span>
                  </div>
                  <div className="px-3 py-2.5">
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-serif text-[26px] leading-none tabular-nums">{num(d.sources)}</span>
                      <span className="text-[11px] text-muted">대상</span>
                    </div>
                    <div className="mt-2 h-[6px] overflow-hidden rounded" style={{ background: "#f2ece0" }}>
                      <span className="block h-full" style={{ width: `${barW}%`, background: color }} />
                    </div>
                    {/* ★ "통보" 가 아니라 "스레드" 다. 보고서가 만들어졌다는 뜻이지 발송이 아니다.
                        실제 발송은 sourcesDelivered 로 따로 그리고, 근거가 없는 도메인은
                        0 이 아니라 "—" 다(0 은 "한 통도 안 나갔다" 는 거짓 주장이 된다). */}
                    <div className="mt-1 flex items-baseline justify-between text-[11px] text-muted">
                      <span>
                        스레드 <span className="font-mono tabular-nums">{num(d.sourcesWithThread)}</span>
                      </span>
                      <span className="font-mono tabular-nums">{pct(d.sourcesWithThread, d.sources, 0)}</span>
                    </div>
                    <div className="mt-0.5 flex items-baseline justify-between text-[11px]">
                      <span className="text-muted">발송 확인</span>
                      <span
                        className="font-mono tabular-nums"
                        style={{ color: d.sourcesDelivered === null ? "#9a9a94" : "#2f6b45" }}
                        title={
                          d.sourcesDelivered === null
                            ? "이 도메인은 발송 시각을 남기지 않습니다 — 나갔는지 알 수 없습니다."
                            : undefined
                        }
                      >
                        {d.sourcesDelivered === null ? "—" : num(d.sourcesDelivered)}
                      </span>
                    </div>
                    <div className="mt-2 flex items-baseline justify-between border-t border-dashed border-line pt-2 text-[11.5px] text-muted">
                      <span>
                        발견 <span className="font-mono tabular-nums text-ink">{num(d.findings)}</span>
                      </span>
                      <span>
                        오탐 <span className="font-mono tabular-nums text-ink">{num(d.falsePositive)}</span>
                      </span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 3. 조치 현황 ─────────────────────────────────────────────────── */}
      {/*
        축이 둘이다. 섞으면 안 된다 —
          티켓    담당자에게 나간 요청이 닫혔는가.        모수 = 스레드 수
          Finding 노출 자체가 사라졌는가.                 모수 = 발견 − 오탐
        같은 도메인에서 두 수가 크게 다를 수 있다(스레드 하나가 finding 여럿을 묶는다).
        그래서 한 열에 합치지 않고 나란히 둔다.
      */}
      <section>
        <SectionTitle title="조치 현황" meta={`이번 주 ${week ?? "—"}`} />
        <Card className="px-1 py-2">
          {/* 머리 1줄: 축 묶음 */}
          <div className="grid" style={{ gridTemplateColumns: COLS }}>
            <div />
            <div className="col-span-4 mx-3 border-b border-line/60 pb-1 text-[11px] text-muted">
              티켓 <span className="text-[10.5px]">· 대상 1건 = 티켓 1건, 목록과 같은 모수</span>
            </div>
            <div className="col-span-5 mx-3 border-b border-line/60 pb-1 text-[11px] text-muted">
              Finding <span className="text-[10.5px]">· 노출 기준</span>
            </div>
          </div>
          {/* 머리 2줄: 열 이름 */}
          <div className="grid border-b border-line pt-1.5" style={{ gridTemplateColumns: COLS }}>
            <Th>도메인</Th>
            <Th align="right">총</Th>
            <Th align="right">회신 대기</Th>
            <Th align="right">종결</Th>
            <Th align="right">처리율</Th>
            <Th align="right">이번 주</Th>
            <Th align="right">발생</Th>
            <Th align="right">오탐</Th>
            <Th align="right">조치 완료</Th>
            <Th align="right">조치율</Th>
          </div>

          {domains.length === 0 ? (
            <Empty why="조치 집계가 없습니다" hint="도메인 집계가 비어 있습니다." />
          ) : (
            <>
              {domains.map((d) => {
                const key = asStr(d.domain) ?? "";
                const name = label(DOMAIN_LABEL, key, key || "미상");
                const color = label(DOMAIN_COLOR, key, "#8a7f6b");
                const denied = asStr(d.remediationLookup) === "denied";
                const basis = label(REMEDIATION_BASIS, d.remediationBasis, BASIS_FALLBACK);
                const findings = asNum(d.findings) ?? 0;
                const fp = asNum(d.falsePositive) ?? 0;
                const remediated = asNum(d.remediated) ?? 0;
                // ★ 티켓 축의 모수는 **대상(sources)** 이다 — 티켓 목록(`/gw/sources`)과
                //   같은 수여야 한다. 스레드 수를 쓰면 목록 250 · 대시보드 148 로 갈린다
                //   (스레드는 대상 하나에 여럿 달릴 수도, 하나도 없을 수도 있다).
                const sources = asNum(d.sources) ?? 0;
                const awaiting = asNum(d.sourcesAwaiting) ?? 0;
                const closed = asNum(d.sourcesClosed) ?? 0;
                // 분모는 오탐을 뺀 진짜 발견. pct 가 분모 0 을 대시로 떨어뜨린다(0% 로 위장 금지).
                const rate = denied ? "—" : pct(remediated, findings - fp, 1);
                return (
                  <div
                    key={key || name}
                    className="grid border-b border-line/60 hover:bg-[#fdf9ef]"
                    style={{ gridTemplateColumns: COLS }}
                  >
                    <Td align="left" mono={false}>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-[6px] w-[6px] rounded-full" style={{ background: color }} />
                        {name}
                      </span>
                    </Td>
                    {/* ── 티켓 축(대상 단위) ── */}
                    <Td
                      muted={sources === 0}
                      title={`메일 스레드 ${num(d.threads)}개 — 대상 하나에 여럿 달릴 수 있다`}
                    >
                      {num(d.sources)}
                    </Td>
                    <Td muted={awaiting === 0}>{num(d.sourcesAwaiting)}</Td>
                    <Td muted={closed === 0}>{num(d.sourcesClosed)}</Td>
                    <Td muted={closed === 0}>{pct(closed, sources, 0)}</Td>
                    {/* ── Finding 축 ── */}
                    <Td muted={(asNum(d.weekNew) ?? 0) === 0}>{num(d.weekNew)}</Td>
                    <Td>{num(d.findings)}</Td>
                    <Td muted>{num(d.falsePositive)}</Td>
                    <Td
                      muted={denied || remediated === 0}
                      mono={!denied}
                      title={basis.full}
                      className={denied ? "text-[11.5px]" : ""}
                    >
                      {denied ? "측정 불가" : num(d.remediated)}
                    </Td>
                    <Td muted={denied || remediated === 0} title={basis.full}>{rate}</Td>
                  </div>
                );
              })}
              {/* 계 — totals 로. 도메인 합과 1~2 어긋날 수 있다(스냅샷 비일관, 계약 주석).
                  ⚠️ 티켓 종결은 totals 에 없다 — 도메인 값을 여기서 더한다. 모수가 같은
                     union 한 판이라 합산이 성립한다(`stats_service._thread_stats`). */}
              <div className="grid border-t border-line" style={{ gridTemplateColumns: COLS }}>
                <Td align="left" mono={false} className="text-walnut-ink">계</Td>
                <Td
                  muted={(asNum(t.sources) ?? 0) === 0}
                  title={`메일 스레드 ${num(t.threads)}개`}
                >
                  {num(t.sources)}
                </Td>
                <Td muted={(asNum(t.sourcesAwaiting) ?? 0) === 0}>{num(t.sourcesAwaiting)}</Td>
                <Td muted={(asNum(t.sourcesClosed) ?? 0) === 0}>{num(t.sourcesClosed)}</Td>
                <Td muted={(asNum(t.sourcesClosed) ?? 0) === 0}>
                  {pct(asNum(t.sourcesClosed) ?? 0, asNum(t.sources) ?? 0, 0)}
                </Td>
                <Td muted={(asNum(t.weekNew) ?? 0) === 0}>{num(t.weekNew)}</Td>
                <Td>{num(t.findings)}</Td>
                <Td muted>{num(t.falsePositive)}</Td>
                <Td
                  muted={totalRemediated === 0}
                  title={deniedLabels.length > 0 ? `측정 불가 도메인 제외: ${deniedLabels.join(", ")}` : undefined}
                >
                  {num(t.remediated)}
                </Td>
                <Td muted={totalRemediated === 0}>{pct(totalRemediated, totalFindings - totalFp, 1)}</Td>
              </div>
            </>
          )}
        </Card>
      </section>

      {/* ── 4. 주차별 발견 · 노출 유형 ───────────────────────────────────── */}
      <div className="grid grid-cols-[1.25fr_1fr] gap-3">
        <Card className="px-3.5 py-3">
          <SectionTitle title="주차별 발견" meta="처음 발견된 주 기준" />
          {weekly.length === 0 ? (
            <Empty why="주차별 집계가 없습니다" hint="발견에 주차를 매길 first_seen 기록이 없습니다." />
          ) : (
            <div className="flex h-[132px] items-end gap-1.5 overflow-x-auto">
              {weekly.map((p) => {
                // 비선형 압축 — 최근 주차 급증이 나머지를 1px 로 눌러버리지 않게.
                const h = maxInflow > 0 ? Math.max(8, 96 * Math.pow(p.inflow / maxInflow, 0.42)) : 8;
                const current = week !== null && p.week === week;
                return (
                  <button
                    key={p.week}
                    type="button"
                    onClick={() => navigate(`/findings?week=${encodeURIComponent(p.week)}`)}
                    className="flex h-full w-10 shrink-0 flex-col items-center justify-end gap-1 rounded hover:bg-[#fdf9ef]"
                  >
                    <span className="font-mono text-[10px] tabular-nums text-muted">{num(p.inflow)}</span>
                    <span
                      className="w-full rounded-t"
                      style={{ height: `${h}px`, background: current ? "#7a5c3e" : "#c9bda6" }}
                    />
                    <span
                      className={`font-mono text-[10px] tabular-nums ${current ? "text-walnut-ink" : "text-muted"}`}
                    >
                      {p.week.split("-")[1] ?? p.week}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <Card className="px-3.5 py-3">
          <SectionTitle title="노출 유형" meta="한 건이 여러 분류에 걸친다" />
          {cats.length === 0 ? (
            <Empty why="분류가 없습니다" hint="발견에 분류 근거(hits)가 남아 있지 않습니다." />
          ) : (
            <div className="space-y-[3px]">
              {cats.map((c, i) => {
                const w = maxCat > 0 ? Math.max(2, (c.count / maxCat) * 100) : 0;
                const color = CAT_COLORS[i % CAT_COLORS.length] ?? "#c9bda6";
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => navigate(`/findings?category=${encodeURIComponent(c.key)}`)}
                    className="flex w-full items-center gap-2 rounded px-1 py-[3px] text-left hover:bg-[#fdf9ef]"
                  >
                    <span className="w-24 shrink-0 truncate text-[12px]">{c.label ?? c.key}</span>
                    <span className="h-[9px] flex-1 overflow-hidden rounded" style={{ background: "#f2ece0" }}>
                      <span className="block h-full rounded" style={{ width: `${w}%`, background: color }} />
                    </span>
                    <span className="w-14 shrink-0 text-right font-mono text-[11.5px] tabular-nums">
                      {num(c.count)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
