/**
 * 발견사항 원장 — 필터(도메인·심각도·분류·주차·대상) + 서버 페이지네이션 표.
 *
 * 이 화면의 규칙 셋:
 *  1) 숫자는 전부 서버 집계다. `items.length` 로 총계를 만들지 않는다 — 한 페이지는 50건인데
 *     실제 총계는 20,648건이라 목록을 세면 즉시 거짓말이 된다.
 *  2) 페이지네이션은 **서버 offset**으로 한다. web 이 offset 을 안 보내던 시절 목록이 늘
 *     첫 페이지에서 끊겼다(github 19,808건).
 *  3) 서버 문자열로 어휘표를 인덱싱할 때는 guards.lookup/label 만 쓴다(`table[key]` 금지 —
 *     `"constructor"` 가 프로토타입 체인을 뚫는다).
 *
 * URL 이 유일한 상태 저장소다(taskType/category/severity/week/srcKey/page). 개요·티켓에서
 * `/findings?category=credential`, `?week=2026-W34`, `?srcKey=…` 로 넘어온다.
 */
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ago, asArr, asNum, asStr, label, lookup, num } from "../lib/guards";
import {
  DOMAINS,
  DOMAIN_COLOR,
  DOMAIN_LABEL,
  DOMAIN_TINT,
  SEV,
  SRC_KIND_LABEL,
} from "../lib/soarMeta";
import { Card, Chip, DomainTag, Empty, LoadError, Loading, Pill, Th } from "../components/ui";
import {
  useFindingCategoryCounts,
  useFindingWeeks,
  useGatewayFindings,
  useGatewayStats,
  useSource,
} from "../lib/queries";

/** 한 페이지 50건 — 게이트웨이 offset 과 짝. */
const PAGE_SIZE = 50;
/** 심각도 / 도메인 / 분류 / 요약·자산 / 관측 / 최근 */
const COLS = "62px 80px 96px minmax(0,1fr) 76px 74px";
const WEEK_CHIPS = 8;

/** 4단계 유지. medium/low 는 집계가 없어 숫자를 안 그린다(없는 숫자를 지어내지 않는다). */
const SEV_CHIPS = ["critical", "high", "medium", "low"] as const;

/** 칩 순서는 실측 물량 순(GitHub 19,808 : SMB 707 : Dev Web 123 : Confluence 10). */
const DOMAIN_RANK: Record<string, number> = { github: 0, smb: 1, dev_web: 2, confluence: 3 };
const DOMAIN_CHIPS = [...DOMAINS].sort((a, b) => label(DOMAIN_RANK, a, 9) - label(DOMAIN_RANK, b, 9));

/** 52px 라벨 + 칩들. */
function FilterRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-[52px] shrink-0 pt-1.5 text-[11px] text-muted">{name}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/** 칩에 붙는 서버 집계 숫자. 값이 없으면 아무것도 안 그린다(0 으로 위장 금지). */
function Count({ n }: { n: number | null }) {
  if (n === null) return null;
  return <span className="ml-1.5 font-mono text-[11px] tabular-nums opacity-70">{num(n)}</span>;
}

export function Findings() {
  const [sp, setSp] = useSearchParams();
  const taskType = sp.get("taskType") ?? "";
  const category = sp.get("category") ?? "";
  const severity = sp.get("severity") ?? "";
  const week = sp.get("week") ?? "";
  const srcKey = sp.get("srcKey") ?? "";
  const page = Math.max(1, asNum(Number(sp.get("page"))) ?? 1);
  const offset = (page - 1) * PAGE_SIZE;

  /** 필터를 바꾸면 항상 1페이지로 되돌린다 — 3페이지에 머무른 채 필터만 바뀌면 빈 화면이 된다. */
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(sp);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setSp(next);
  };

  const list = useGatewayFindings({
    taskType: taskType || undefined,
    category: category || undefined,
    severity: severity || undefined,
    week: week || undefined,
    srcKey: srcKey || undefined,
    limit: PAGE_SIZE,
    offset,
  });
  // 칩 숫자는 목록과 같은 필터 축을 쓴다(category 는 제외 — 자기 자신을 좁히면 안 된다).
  const cats = useFindingCategoryCounts({
    taskType: taskType || undefined,
    week: week || undefined,
    severity: severity || undefined,
  });
  const weeks = useFindingWeeks(taskType || undefined);
  const stats = useGatewayStats();
  // 대상 필터가 걸렸을 때만 fire. srcKey 는 불투명 키라 사람이 읽을 라벨을 여기서 받아온다.
  const src = useSource(srcKey || undefined);

  // ── 칩 숫자(전부 서버 집계) ───────────────────────────────────────────────
  const domainStats = asArr<{
    domain: string;
    findings: number;
    critical: number;
    high: number;
  }>(stats.data?.domains);
  const totalFindings = stats.data ? asNum(stats.data.totals.findings) : null;
  // 심각도 숫자는 현재 도메인 필터 범위에 맞춘다(전체면 4도메인 합).
  const sevScope = taskType ? domainStats.filter((d) => d.domain === taskType) : domainStats;
  const sevCount = (key: string): number | null => {
    if (!stats.data) return null;
    if (key !== "critical" && key !== "high") return null; // medium/low 는 집계 없음
    return sevScope.reduce((acc, d) => acc + (asNum(key === "critical" ? d.critical : d.high) ?? 0), 0);
  };

  const catCounts = cats.data?.counts ?? {};
  const catLabels = cats.data?.labels ?? {};
  const catKeys = Object.keys(catCounts).sort(
    (a, b) => (asNum(lookup(catCounts, b)) ?? 0) - (asNum(lookup(catCounts, a)) ?? 0),
  );
  // URL 로 넘어온 분류가 집계에 없더라도(0건) 칩은 남긴다 — 안 그리면 필터를 풀 수가 없다.
  const catChips = category && !catKeys.includes(category) ? [category, ...catKeys] : catKeys;
  const catLabelOf = (key: string) => label(catLabels, key, key);

  const weekList = asArr<string>(weeks.data);
  const topWeeks = weekList.slice(0, WEEK_CHIPS);
  const weekChips = week && !topWeeks.includes(week) ? [week, ...topWeeks] : topWeeks;

  // ── 표 ────────────────────────────────────────────────────────────────────
  const total = asNum(list.data?.total) ?? 0;
  const items = list.data?.items ?? [];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  // 빈 상태의 "왜" — 조건 때문에 없는 것과 원래 없는 것을 구분한다.
  const active: string[] = [];
  if (taskType) active.push(`도메인 ${label(DOMAIN_LABEL, taskType, taskType)}`);
  if (severity) active.push(`심각도 ${lookup(SEV, severity)?.label ?? severity}`);
  if (category) active.push(`분류 ${catLabelOf(category)}`);
  if (week) active.push(`주차 ${week}`);
  if (srcKey) active.push("대상 1곳");

  const srcItem = src.item;
  const srcLabel = asStr(srcItem?.src) ?? (srcItem ? "미상" : null);
  const srcKind = label(SRC_KIND_LABEL, srcItem?.srcKind, "대상");
  const srcDomain = asStr(srcItem?.domain);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2.5">
        <h1 className="font-serif text-[17px]">발견사항</h1>
        {list.data ? (
          <span className="font-mono text-[12px] tabular-nums text-muted">{num(total)}건</span>
        ) : null}
      </div>

      {srcKey ? (
        <div className="flex items-center gap-1.5 text-[12px]">
          <Link to="/tickets" className="text-walnut hover:underline">
            티켓
          </Link>
          <span className="text-muted">›</span>
          <Link
            to={`/tickets/${encodeURIComponent(srcKey)}`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-card px-2 py-0.5 hover:bg-[#fdf9ef]"
            title={srcLabel ?? srcKey}
          >
            {srcDomain ? (
              <DomainTag
                domain={srcDomain}
                label={label(DOMAIN_LABEL, srcDomain, srcDomain)}
                color={label(DOMAIN_COLOR, srcDomain, "#8a7f6b")}
                tint={label(DOMAIN_TINT, srcDomain, "#efe8d8")}
              />
            ) : null}
            <span className="text-[11px] text-muted">{srcKind}</span>
            <span className="max-w-[38ch] truncate font-mono text-[11.5px] text-walnut-ink">
              {srcLabel ?? srcKey}
            </span>
          </Link>
          <button
            type="button"
            onClick={() => setParam("srcKey", null)}
            aria-label="대상 필터 해제"
            className="rounded-full border border-line px-1.5 py-0.5 text-[11px] text-muted hover:bg-sel hover:text-walnut-ink"
          >
            ✕
          </button>
        </div>
      ) : null}

      <Card className="flex flex-col gap-2 px-3.5 py-3">
        <FilterRow name="도메인">
          <Chip active={!taskType} onClick={() => setParam("taskType", null)}>
            전체
            <Count n={totalFindings} />
          </Chip>
          {DOMAIN_CHIPS.map((d) => {
            const stat = domainStats.find((s) => s.domain === d);
            return (
              <Chip
                key={d}
                active={taskType === d}
                onClick={() => setParam("taskType", taskType === d ? null : d)}
                tone={{ bg: label(DOMAIN_TINT, d, "#efe8d8"), fg: label(DOMAIN_COLOR, d, "#4a3720") }}
              >
                {label(DOMAIN_LABEL, d, d)}
                <Count n={stat ? asNum(stat.findings) : null} />
              </Chip>
            );
          })}
        </FilterRow>

        <FilterRow name="심각도">
          <Chip active={!severity} onClick={() => setParam("severity", null)}>
            전체
          </Chip>
          {SEV_CHIPS.map((s) => {
            const tone = lookup(SEV, s);
            return (
              <Chip
                key={s}
                active={severity === s}
                onClick={() => setParam("severity", severity === s ? null : s)}
                tone={tone ? { bg: tone.bg, fg: tone.fg } : undefined}
              >
                {tone?.label ?? s}
                <Count n={sevCount(s)} />
              </Chip>
            );
          })}
        </FilterRow>

        <FilterRow name="분류">
          <Chip active={!category} onClick={() => setParam("category", null)}>
            전체
          </Chip>
          {catChips.map((k) => (
            <Chip
              key={k}
              active={category === k}
              onClick={() => setParam("category", category === k ? null : k)}
            >
              {catLabelOf(k)}
              <Count n={asNum(lookup(catCounts, k))} />
            </Chip>
          ))}
          {cats.isError ? <span className="text-[11px] text-muted">분류 집계 없음</span> : null}
          {cats.isLoading ? <span className="text-[11px] text-muted">…</span> : null}
        </FilterRow>

        <FilterRow name="주차">
          <Chip active={!week} onClick={() => setParam("week", null)}>
            전체
          </Chip>
          {weekChips.map((w) => (
            <Chip key={w} active={week === w} onClick={() => setParam("week", week === w ? null : w)}>
              <span className="font-mono tabular-nums">{w}</span>
            </Chip>
          ))}
          {weeks.isError ? <span className="text-[11px] text-muted">주차 목록 없음</span> : null}
          {!weeks.isError && !weeks.isLoading && weekList.length === 0 ? (
            <span className="text-[11px] text-muted">관측된 주차 없음</span>
          ) : null}
        </FilterRow>
      </Card>

      <Card>
        {list.isLoading ? (
          <Loading what="발견사항" />
        ) : list.isError ? (
          <div className="p-3">
            <LoadError what="발견사항" error={list.error} />
          </div>
        ) : items.length === 0 ? (
          total > 0 ? (
            <Empty
              why="이 페이지에는 결과가 없습니다"
              hint={`총 ${num(total)}건 · ${num(pages)}페이지 중 ${num(page)}페이지`}
            />
          ) : (
            <Empty
              why={active.length > 0 ? "조건에 맞는 발견이 없습니다" : "발견이 없습니다"}
              hint={
                active.length > 0
                  ? `조건: ${active.join(" · ")}`
                  : "게이트웨이 조회 범위 안에 수집된 발견이 없습니다"
              }
            />
          )
        ) : (
          <>
            {/* 20,648행 원장이라 머리가 따라와야 한다. */}
            <div className="sticky top-0 z-10 grid border-b border-line bg-[#faf6ec]" style={{ gridTemplateColumns: COLS }}>
              <Th className="pt-2.5">심각도</Th>
              <Th className="pt-2.5">도메인</Th>
              <Th className="pt-2.5">분류</Th>
              <Th className="pt-2.5">요약 · 자산</Th>
              <Th className="pt-2.5" align="right">
                관측
              </Th>
              <Th className="pt-2.5" align="right">
                최근
              </Th>
            </div>
            {items.map((f) => {
              const sev = asStr(f.severity);
              const tone = lookup(SEV, sev);
              const dom = asStr(f.taskType);
              const summary = asStr(f.summary);
              const asset = asStr(f.asset);
              const catName = asStr(f.category?.label) ?? asStr(f.category?.key) ?? "미분류";
              const all = asArr<{ key: string; label: string }>(f.categories);
              const more = all.length - 1;
              return (
                <Link
                  key={f.id}
                  to={`/findings/${f.id}`}
                  className="grid items-center border-b border-line/60 last:border-b-0 hover:bg-[#fdf9ef]"
                  style={{ gridTemplateColumns: COLS }}
                >
                  <div className="px-3 py-2">
                    <Pill tone={tone ? { bg: tone.bg, fg: tone.fg } : undefined}>
                      {tone?.label ?? sev ?? "—"}
                    </Pill>
                  </div>
                  <div
                    className="min-w-0 truncate px-3 py-2 text-[11px]"
                    style={{ color: label(DOMAIN_COLOR, dom, "#8a7f6b") }}
                    title={dom ?? undefined}
                  >
                    {dom ? label(DOMAIN_LABEL, dom, dom) : "—"}
                  </div>
                  <div
                    className="min-w-0 truncate px-3 py-2 text-[11.5px] text-walnut-ink"
                    title={all.map((c) => asStr(c.label) ?? asStr(c.key) ?? "").join(" · ") || undefined}
                  >
                    {catName}
                    {more > 0 ? (
                      <span className="ml-1 font-mono text-[10.5px] text-muted">+{num(more)}</span>
                    ) : null}
                  </div>
                  <div className="min-w-0 px-3 py-2">
                    <div className="truncate text-[12.5px]" title={summary ?? undefined}>
                      {summary ?? <span className="text-muted">요약 없음</span>}
                    </div>
                    <div
                      className="truncate font-mono text-[10.5px] text-muted"
                      title={asset ?? undefined}
                    >
                      {asset ?? "—"}
                    </div>
                  </div>
                  <div className="px-3 py-2 text-right font-mono text-[11.5px] tabular-nums">
                    {num(f.seenCount)}
                  </div>
                  <div className="px-3 py-2 text-right text-[11.5px] text-muted">{ago(f.lastSeen)}</div>
                </Link>
              );
            })}
            <div className="flex items-center gap-2 border-t border-line px-3 py-2">
              <span className="font-mono text-[11.5px] tabular-nums text-muted">
                {num(from)}–{num(to)} / {num(total)}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setParam("page", String(page - 1))}
                  className="rounded-md border border-line px-2 py-1 text-[11.5px] text-walnut-ink hover:bg-sel disabled:opacity-35 disabled:hover:bg-transparent"
                >
                  이전
                </button>
                <span className="font-mono text-[11.5px] tabular-nums text-muted">
                  {num(page)} / {num(pages)}
                </span>
                <button
                  type="button"
                  disabled={page >= pages}
                  onClick={() => setParam("page", String(page + 1))}
                  className="rounded-md border border-line px-2 py-1 text-[11.5px] text-walnut-ink hover:bg-sel disabled:opacity-35 disabled:hover:bg-transparent"
                >
                  다음
                </button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
