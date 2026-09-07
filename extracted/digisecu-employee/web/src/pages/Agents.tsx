/**
 * 에이전트 — 도메인 워커(공유 컴포넌트)의 심박과 최근 수행 품질.
 *
 * ★ 이 화면의 존재 이유는 "멎었는지" 를 숨기지 않는 것이다. 그래서 "가동 중" 배지 대신
 *   **멎은 시간**을 가장 크게 그린다(2026-08-23 실측: 31개 컴포넌트 전부 stale, 최근 신호 44시간 전).
 *
 * 집계 규칙
 * - 컴포넌트 수·무응답 수는 서버 집계(`componentCounts`)만 쓴다. 목록 길이로 숫자를 만들지 않는다.
 * - "꺼둔 것" 만 예외적으로 `components` 를 훑는다 — `activity==="disabled"` 는 서버 집계에 없다
 *   (`componentCounts` 는 liveness 축만 센다). 그래서 목록이 잘려 오면 과소집계일 수 있다.
 * - presence 는 개인(employee) 축이 아니라 **공유 도메인 워커** 축이다(contracts 주석 참조).
 */
import type { ComponentRuntime, DomainRuntime, QualityDomainReport } from "@digisecu/contracts";
import { Card, Empty, LoadError, Loading, SectionTitle, StackBar } from "../components/ui";
import { ago, asArr, asNum, asStr, label, lookup, num } from "../lib/guards";
import { useQualityCandidates, useRuntimePresence } from "../lib/queries";
import { DOMAINS, DOMAIN_COLOR, DOMAIN_LABEL, DOMAIN_TINT, EXEC_STATE } from "../lib/soarMeta";
import { Icon } from "../shell/icons";

/** heartbeat 나이(liveness) → 점 색. 어휘 밖 값은 회색으로 떨어뜨린다(색을 지어내지 않는다). */
const LIVENESS_DOT: Record<string, string> = {
  live: "#2fa365",
  delayed: "#b07d1a",
  stale: "#c2683a",
  unknown: "#9a9a94",
  disabled: "#9a9a94",
};

const STALE_INK = "#c2683a";
const WARN_INK = "#8f2f18";
const MUTED_INK = "#8a7f6b";
const OFF_INK = "#a89c86";

/** 카드 한 장에 세로로 담기는 컴포넌트 줄 수. 나머지는 "외 n개" 로 접는다. */
const MAX_ROWS = 9;

const DOMAIN_RANK: readonly string[] = DOMAINS;

/** 고정 도메인 순서. 어휘 밖 도메인은 뒤로 보내되 **버리지 않는다**. */
function rankOf(domain: unknown): number {
  const k = asStr(domain);
  const i = k === null ? -1 : DOMAIN_RANK.indexOf(k);
  return i < 0 ? DOMAIN_RANK.length : i;
}

/** 도메인이 멎었는가 — liveness 가 stale 이거나, 컴포넌트가 전부 무응답이거나. */
function isStalled(d: DomainRuntime): boolean {
  if (asStr(d.liveness) === "stale") return true;
  const total = asNum(d.componentCounts?.total) ?? 0;
  const stale = asNum(d.componentCounts?.stale) ?? 0;
  return total > 0 && stale >= total;
}

/** lastBeatAt 내림차순(없는 것은 뒤). 원본 배열을 건드리지 않는다. */
function byBeatDesc(list: ComponentRuntime[]): ComponentRuntime[] {
  return [...list].sort((a, b) => (asNum(b.lastBeatAt) ?? -1) - (asNum(a.lastBeatAt) ?? -1));
}

type LedgerPart = { key: string; label: string; color: string; n: number };

/**
 * 침묵 축(ledgerState) 분해 — **서로 겹치지 않는** 칸으로만 막대를 쌓는다.
 *
 * ⚠️ `reported` 는 침묵 축이 아니라 텔레메트리 커버리지(worker_result 이벤트 존재)라서
 *    `silent` 와 겹치고, `failedSilent` 는 `silent` 의 부분집합이다. 셋을 그대로 쌓으면
 *    합이 `attempts` 를 넘어 막대가 조용히 왜곡된다 — 그래서 겹침을 뺀 칸으로 쌓고
 *    `reported` 는 막대 아래에 커버리지 숫자로 따로 적는다.
 * ⚠️ `zeroSignal`(후보 신호 0)·`unknownLedger`(측정 안 됨)를 정상으로 접지 않는다.
 *    모르는 것과 없는 것과 해명된 것은 전부 다른 상태다.
 */
function ledgerParts(r: QualityDomainReport): LedgerPart[] {
  const silent = asNum(r.silent) ?? 0;
  const failed = asNum(r.failedSilent) ?? 0;
  return [
    { key: "accounted", label: "정산", color: "#2fa365", n: asNum(r.accounted) ?? 0 },
    { key: "silent", label: "침묵", color: "#b07d1a", n: Math.max(0, silent - failed) },
    { key: "failed", label: "중단", color: STALE_INK, n: failed },
    { key: "zero", label: "신호 없음", color: "#cfc4ad", n: asNum(r.zeroSignal) ?? 0 },
    { key: "unknown", label: "미상", color: "#9a9a94", n: asNum(r.unknownLedger) ?? 0 },
  ];
}

/** 도메인 카드 바닥 — 최근 수행 품질. 품질 조회는 presence 와 별개 쿼리라 상태를 따로 그린다. */
function QualityFoot({
  report, windowDays, loading, failed,
}: {
  report: QualityDomainReport | undefined;
  windowDays: number | null;
  loading: boolean;
  failed: boolean;
}) {
  const title = windowDays === null ? "수행 품질" : `최근 ${num(windowDays)}일 수행 품질`;
  const parts = report ? ledgerParts(report) : [];
  const sum = parts.reduce((s, p) => s + p.n, 0);
  const attempts = asNum(report?.attempts) ?? 0;
  // 분모는 attempts 지만, 서버 칸 합이 더 크면 합을 쓴다(막대가 100% 를 넘어 찌그러지지 않게).
  const denom = Math.max(attempts, sum);
  const measured = report?.status === "present" && denom > 0;
  const shown = parts.filter((p) => p.n > 0);
  const degraded = asNum(report?.degradedOk) ?? 0;
  const reported = asNum(report?.reported);

  return (
    <div className="border-t border-line px-3 py-2.5">
      <div className="mb-1.5 flex items-baseline gap-1.5">
        <span className="text-[11px] text-muted">{title}</span>
        {measured ? (
          <span className="ml-auto font-mono text-[10.5px] tabular-nums text-muted">시도 {num(attempts)}</span>
        ) : null}
      </div>

      {loading ? <div className="text-[11px] text-muted">품질 불러오는 중</div> : null}
      {!loading && failed ? <div className="text-[11px]" style={{ color: WARN_INK }}>품질 조회 실패</div> : null}

      {/* ★ noData 는 "깨끗함" 이 아니라 "아무것도 모름" 이다. 초록 막대로 위장하지 않는다. */}
      {!loading && !failed && !measured ? (
        <div className="text-[11px]" style={{ color: MUTED_INK }}>측정하고 있지 않음</div>
      ) : null}

      {!loading && !failed && measured ? (
        <>
          <StackBar
            parts={shown.map((p) => ({
              w: `${((p.n / denom) * 100).toFixed(2)}%`,
              color: p.color,
              title: `${p.label} ${num(p.n)}`,
            }))}
          />
          <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5">
            {shown.map((p) => (
              <span key={p.key} className="inline-flex items-center gap-1 text-[10.5px] text-muted">
                <span className="h-[6px] w-[6px] rounded-full" style={{ background: p.color }} />
                {p.label}
                <span className="font-mono tabular-nums">{num(p.n)}</span>
              </span>
            ))}
          </div>
          {reported === null ? null : (
            <div className="mt-1 font-mono text-[10.5px] tabular-nums text-muted">
              보고 {num(reported)} / {num(attempts)}
            </div>
          )}
          {degraded > 0 ? (
            <div className="mt-1 text-[11px]" style={{ color: WARN_INK }}>
              ok 로 보고된 침묵 {num(degraded)}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** 도메인 1개 카드 — 머리(멎은 시간) · 몸통(컴포넌트) · 바닥(품질). */
function DomainCard({
  runtime, report, windowDays, qLoading, qFailed, nowSec,
}: {
  runtime: DomainRuntime;
  report: QualityDomainReport | undefined;
  windowDays: number | null;
  qLoading: boolean;
  qFailed: boolean;
  nowSec: number | undefined;
}) {
  const raw = asStr(runtime.domain);
  const name = label(DOMAIN_LABEL, raw, raw ?? "알 수 없음");
  const color = label(DOMAIN_COLOR, raw, "#7a6a55");
  const tint = label(DOMAIN_TINT, raw, "#f1ece2");

  const total = asNum(runtime.componentCounts?.total);
  const comps = byBeatDesc(asArr<ComponentRuntime>(runtime.components));
  const rows = comps.slice(0, MAX_ROWS);
  // 접힌 줄 수는 서버 total 기준으로 센다(목록 길이로 숫자를 만들지 않는다).
  const hidden = Math.max(0, (total ?? rows.length) - rows.length);

  const beat = asNum(runtime.lastBeatAt);
  const freshest = asStr(comps.find((c) => asNum(c.lastBeatAt) !== null)?.component);

  return (
    <Card className="flex flex-col overflow-hidden">
      <header className="px-3 py-2.5" style={{ background: tint }}>
        <div className="flex items-center gap-1.5">
          <span className="h-[7px] w-[7px] rounded-full" style={{ background: color }} />
          <span className="font-serif text-[13.5px]" style={{ color }}>{name}</span>
          <span className="ml-auto font-mono text-[11px] tabular-nums text-muted">{num(total)}개</span>
        </div>
        <div
          className="mt-1.5 font-serif leading-none tabular-nums"
          style={{ fontSize: 27, color: beat === null ? "#9a9a94" : STALE_INK }}
        >
          {beat === null ? "신호 없음" : ago(beat, nowSec)}
        </div>
        {freshest === null ? null : (
          <div className="mt-1 truncate text-[11px] text-muted" title={freshest}>
            마지막 신호 · <span className="font-mono">{freshest}</span>
          </div>
        )}
      </header>

      <div className="flex-1 px-3 py-1.5">
        {rows.length === 0 ? (
          <Empty why={(total ?? 0) > 0 ? "컴포넌트 목록을 받지 못했습니다" : "등록된 컴포넌트 없음"} />
        ) : (
          rows.map((c, i) => {
            const cname = asStr(c.component);
            const off = asStr(c.activity) === "disabled";
            const dot = off ? "#9a9a94" : label(LIVENESS_DOT, c.liveness, "#9a9a94");
            return (
              <div
                key={`${cname ?? "?"}-${i}`}
                className="flex items-center gap-1.5 border-b border-line/60 py-[5px] last:border-b-0"
              >
                <span className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: dot }} />
                <span
                  className="truncate font-mono text-[11px]"
                  style={off ? { color: OFF_INK } : undefined}
                  title={cname ?? undefined}
                >
                  {cname ?? "이름 없음"}
                </span>
                <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-muted">
                  {off ? "꺼둠" : ago(c.lastBeatAt, nowSec)}
                </span>
              </div>
            );
          })
        )}
        {hidden > 0 ? <div className="pt-1.5 text-[11px] text-muted">외 {num(hidden)}개</div> : null}
      </div>

      <QualityFoot report={report} windowDays={windowDays} loading={qLoading} failed={qFailed} />
    </Card>
  );
}

export function Agents() {
  const presence = useRuntimePresence();
  const quality = useQualityCandidates(30);

  const domains = [...asArr<DomainRuntime>(presence.data?.domains)].sort(
    (a, b) => rankOf(a.domain) - rankOf(b.domain),
  );
  // 시각 기준은 서버 asOf — 브라우저 시계와 어긋나도 "몇 시간 전" 이 흔들리지 않게.
  const nowSec = asNum(presence.data?.asOf) ?? undefined;

  let totalComp = 0;
  let staleComp = 0;
  let offComp = 0;
  let latestBeat: number | null = null;
  let stalledDomains = 0;
  for (const d of domains) {
    totalComp += asNum(d.componentCounts?.total) ?? 0;
    staleComp += asNum(d.componentCounts?.stale) ?? 0;
    const beat = asNum(d.lastBeatAt);
    if (beat !== null && (latestBeat === null || beat > latestBeat)) latestBeat = beat;
    if (isStalled(d)) stalledDomains += 1;
    for (const c of asArr<ComponentRuntime>(d.components)) {
      if (asStr(c.activity) === "disabled") offComp += 1;
    }
  }
  // 배너 조건: 도메인이 전부 멎었거나, 컴포넌트 절반 이상이 무응답.
  const allStalled = domains.length > 0 && stalledDomains === domains.length;
  const halfStale = totalComp > 0 && staleComp * 2 >= totalComp;
  const alarm = allStalled || halfStale;

  const qualityDomains = asArr<QualityDomainReport>(quality.data?.domains);
  const reportOf = new Map<string, QualityDomainReport>();
  for (const r of qualityDomains) {
    const k = asStr(r.domain);
    if (k !== null) reportOf.set(k, r);
  }
  const windowDays = asNum(quality.data?.windowDays);
  const truncated = quality.data?.truncated === true;
  const unclassified = asNum(quality.data?.unclassifiedRows) ?? 0;

  // 실행 축(byExecutionState) 4도메인 합산. Map 으로 모은다 — 서버 키를 객체 인덱스로 쓰면
  // "__proto__" 같은 키가 프로토타입을 건드린다.
  const execTotals = new Map<string, number>();
  for (const r of qualityDomains) {
    const rec = r.byExecutionState;
    if (!rec || typeof rec !== "object") continue;
    for (const [k, v] of Object.entries(rec)) {
      const n = asNum(v);
      if (n === null) continue;
      execTotals.set(k, (execTotals.get(k) ?? 0) + n);
    }
  }
  // EXEC_STATE 어휘 순서를 앞에(ok → 실패 이유들), 어휘 밖 키를 뒤에.
  // ★ 어휘에 있지만 서버가 보내지 않은 키를 0 으로 채우지 않는다 — 실패가 crash/contractViolation
  //   으로 오는데 "오류 0" 을 그리면 없는 안심을 만든다.
  const knownKeys = Object.keys(EXEC_STATE).filter((k) => execTotals.has(k));
  const extraKeys = [...execTotals.keys()]
    .filter((k) => !Object.prototype.hasOwnProperty.call(EXEC_STATE, k))
    .sort();
  const execKeys = [...knownKeys, ...extraKeys];

  if (presence.isLoading) {
    return (
      <div className="px-5 py-4">
        <Loading what="에이전트 상태" />
      </div>
    );
  }
  if (presence.isError) {
    return (
      <div className="px-5 py-4">
        <LoadError what="에이전트 상태" error={presence.error} />
      </div>
    );
  }
  if (domains.length === 0) {
    return (
      <div className="px-5 py-4">
        <Empty why="런타임에 등록된 도메인 워커가 없습니다" />
      </div>
    );
  }

  return (
    <div className="px-5 py-4">
      {alarm ? (
        <div className="mb-3 flex items-start gap-3 rounded-xl border border-[#e0bfb2] bg-[#fbf0ec] px-4 py-3.5">
          <Icon name="alert" className="mt-[2px] h-[18px] w-[18px] shrink-0 text-[#8f2f18]" />
          <div className="min-w-0">
            <div className="text-[13.5px]" style={{ color: WARN_INK }}>
              {stalledDomains > 0
                ? `${num(stalledDomains)}개 도메인이 멎어 있습니다`
                : "컴포넌트 절반 이상이 무응답입니다"}
            </div>
            <div className="mt-1 text-[11.5px] text-muted">
              <span className="font-mono tabular-nums">
                {num(staleComp)}/{num(totalComp)}
              </span>{" "}
              컴포넌트 무응답 · 가장 최근 신호 {ago(latestBeat, nowSec)}
            </div>
          </div>
          <div className="ml-auto shrink-0 text-right">
            <div className="text-[11px] text-muted">꺼둔 것</div>
            <div className="font-serif text-[19px] leading-none tabular-nums" style={{ color: MUTED_INK }}>
              {num(offComp)}
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-4 gap-3">
        {domains.map((d, i) => {
          const key = asStr(d.domain);
          return (
            <DomainCard
              key={key ?? `domain-${i}`}
              runtime={d}
              report={key === null ? undefined : reportOf.get(key)}
              windowDays={windowDays}
              qLoading={quality.isLoading}
              qFailed={quality.isError}
              nowSec={nowSec}
            />
          );
        })}
      </div>

      <div className="mt-4">
        <SectionTitle
          title="실행 이력"
          action={
            <div className="flex items-baseline gap-2 text-[11px]">
              {windowDays === null ? null : <span className="text-muted">최근 {num(windowDays)}일</span>}
              {truncated ? <span style={{ color: WARN_INK }}>일부 잘림</span> : null}
              {unclassified > 0 ? (
                <span style={{ color: WARN_INK }}>미분류 {num(unclassified)}행</span>
              ) : null}
            </div>
          }
        />
        <Card className="px-3 py-3">
          {quality.isLoading ? <Loading what="수행 품질" /> : null}
          {!quality.isLoading && quality.isError ? (
            <LoadError what="수행 품질" error={quality.error} />
          ) : null}
          {!quality.isLoading && !quality.isError && execKeys.length === 0 ? (
            <Empty why="집계된 실행 기록이 없습니다" />
          ) : null}
          {!quality.isLoading && !quality.isError && execKeys.length > 0 ? (
            <div className="grid grid-cols-5 gap-2">
              {execKeys.map((k) => {
                const meta = lookup(EXEC_STATE, k);
                const ink = meta?.fg ?? MUTED_INK;
                return (
                  <div key={k} className="rounded-lg border border-line/70 px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="h-[6px] w-[6px] shrink-0 rounded-full"
                        style={{ background: meta?.dot ?? "#9a9a94" }}
                      />
                      <span
                        className={meta ? "truncate text-[11px]" : "truncate font-mono text-[11px]"}
                        style={{ color: ink }}
                        title={meta?.hint ?? k}
                      >
                        {meta ? meta.label : k}
                      </span>
                    </div>
                    <div className="mt-1 font-serif text-[22px] leading-none tabular-nums" style={{ color: ink }}>
                      {num(execTotals.get(k))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
