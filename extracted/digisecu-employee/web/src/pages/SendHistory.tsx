/**
 * 보고 스레드 — 도메인별 리포트 스레드 목록.
 *
 * ⚠️ 예전 이름은 "발송 이력" 이었다. 그 이름이 거짓말이었다 — 이 화면의 행 수는
 *    **스레드 수**지 발송 수가 아니다. 실측 2026-08-24: 스레드 1,639건 중 실제로 나간 것은
 *    `notified_at` 기준 **1건**이다. 사이드바 숫자(countKey="threads")도 같은 값이라,
 *    "발송 이력 1,639" 가 매 화면에 떠 있었다.
 *    발송 여부는 티켓 목록·상세가 `deliveryEvidence`/`notifiedAt` 근거와 함께 그린다.
 *
 * 이 화면의 행은 finding 이 아니라 **스레드**다(대상 1건에 대한 보고 한 줄기).
 * 도메인마다 리포트 테이블이 달라서 열 구성이 갈린다 — 그래서 도메인은 단일 선택이고
 * "전체" 가 없다. 4도메인을 한 표에 섞으면 recurrenceCount 처럼 smb 에만 있는 열이
 * 나머지 3종에서 조용히 null 로 채워져 "재발이 없다" 는 거짓 신호가 된다.
 *
 * 숫자 규칙:
 *  - 도메인 칩에는 숫자를 그리지 않는다. 이 엔드포인트는 total 을 주지 않고, 목록 길이는
 *    limit(300)에 잘린 값이라 세면 거짓말이 된다.
 *  - 표 머리의 건수는 report-cycles 의 statusCounts(서버 집계) 합이다. 주차 필터 기준이
 *    목록과 같은 컬럼(last_cycle_key)이라 두 숫자가 같은 집합을 가리킨다.
 */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ReportThreadItem } from "@digisecu/contracts";
import { Card, Chip, Empty, LoadError, Loading, Pill, SectionTitle, Th } from "../components/ui";
import { DOMAIN_COLOR, DOMAIN_LABEL, DOMAIN_TINT, DOMAINS, THREAD_STATUS } from "../lib/soarMeta";
import type { Domain } from "../lib/soarMeta";
import { ago, asArr, asNum, asStr, label, lookup, num, stamp } from "../lib/guards";
import { useReportCycles, useWorkspaceReports } from "../lib/queries";
// 본문 패널은 티켓 상세와 **공유**한다 — 두 벌이면 한쪽만 고쳐진다.
import { MailBodyPanel } from "../components/MailBodyPanel";

// 대상 / 제목 / 스레드 상태 / 보고 주차 / 시도 / 최근
// ⚠️ cycle_keys 는 **스레드가 걸친 주차**다. 그 주에 메일이 나갔다는 뜻이 아니다 —
//    실제 발송은 notified_at 이고, 그건 티켓 목록·상세가 근거와 함께 그린다.
const GRID = "148px minmax(0,1fr) 120px 92px 92px 108px";

/** api.fetchWorkspaceReports 의 기본 limit 과 같은 값. 잘린 목록을 전부인 척하지 않으려고 명시한다. */
// 한 화면에 통짜로 그린다(가상 스크롤 없음). 300 이면 15,000px 가 넘어 쓸 수 없다 —
// 100 이면 ~5,000px 로 스크롤이 감당된다. 잘린 건 meta 에 "최근 N건" 으로 밝힌다.
const LIST_LIMIT = 100;

/** 주차 선택기에 노출할 개수(최신순으로 서버가 준다). */
const WEEK_CHIPS = 8;

/** URL 의 domain 파라미터를 고정 어휘로만 받는다. 어휘 밖이면 기본값. */
function pickDomain(v: unknown): Domain {
  const s = asStr(v);
  return DOMAINS.find((d) => d === s) ?? "smb";
}

/** 발송이 걸친 주차들 — 3개까지는 다 쓰고, 넘으면 앞 2개 + "외 N". */
function cycleText(v: unknown): string {
  const keys = asArr<unknown>(v)
    .map((k) => asStr(k))
    .filter((k): k is string => k !== null);
  if (keys.length === 0) return "—";
  if (keys.length <= 3) return keys.join(" · ");
  return `${keys.slice(0, 2).join(" · ")} 외 ${keys.length - 2}`;
}

/** 전체 주차 원문 — 잘린 칸에 title 로 붙여 둔다(식별자라 원문 그대로). */
function cycleFull(v: unknown): string | undefined {
  const keys = asArr<unknown>(v)
    .map((k) => asStr(k))
    .filter((k): k is string => k !== null);
  return keys.length > 3 ? keys.join(" · ") : undefined;
}

export function SendHistory() {
  const [params, setParams] = useSearchParams();
  // 펼친 스레드 하나만 본문을 부른다 — 목록이 100행이라 전부 부르면 게이트웨이가 죽는다.
  const [openId, setOpenId] = useState<number | null>(null);
  const domain = pickDomain(params.get("domain"));
  const cycleKey = asStr(params.get("cycleKey"));

  const apply = (nextDomain: Domain, nextCycle: string | null) => {
    const next = new URLSearchParams();
    next.set("domain", nextDomain);
    if (nextCycle) next.set("cycleKey", nextCycle);
    setParams(next, { replace: true });
  };

  // 훅은 4개를 **항상** 호출한다. 조건부 호출은 훅 순서를 깨므로 enabled 로만 껐다 켠다.
  const smbQ = useWorkspaceReports("smb", domain === "smb" ? cycleKey : null, { enabled: domain === "smb", limit: LIST_LIMIT });
  const devWebQ = useWorkspaceReports("dev_web", domain === "dev_web" ? cycleKey : null, { enabled: domain === "dev_web", limit: LIST_LIMIT });
  const githubQ = useWorkspaceReports("github", domain === "github" ? cycleKey : null, { enabled: domain === "github", limit: LIST_LIMIT });
  const confluenceQ = useWorkspaceReports("confluence", domain === "confluence" ? cycleKey : null, { enabled: domain === "confluence", limit: LIST_LIMIT });

  // 키가 리터럴 유니온이라 인덱스 시그니처가 아니다 — 프로토타입 체인이 뚫릴 자리가 없다.
  const byDomain: Record<Domain, ReturnType<typeof useWorkspaceReports>> = {
    smb: smbQ,
    dev_web: devWebQ,
    github: githubQ,
    confluence: confluenceQ,
  };
  const reportsQ = byDomain[domain];

  // 주차 선택기 — 선택된 도메인 하나만. 주차 집합은 도메인마다 다르다.
  const cyclesQ = useReportCycles(domain, cycleKey);
  const cycles = asArr<unknown>(cyclesQ.data?.cycles)
    .map((c) => asStr(c))
    .filter((c): c is string => c !== null);
  const weeks = cycles.slice(0, WEEK_CHIPS);
  // URL 로 직접 들어온 주차가 최근 8개 밖이면 칩을 하나 더 붙인다(선택 상태가 안 보이면 안 된다).
  const weekChips = cycleKey && !weeks.includes(cycleKey) ? [cycleKey, ...weeks] : weeks;

  // 표 머리 건수 — 목록 길이가 아니라 서버 statusCounts 의 합.
  const statusCounts = cyclesQ.data?.statusCounts;
  const threadTotal = statusCounts
    ? Object.values(statusCounts).reduce((acc: number, n) => acc + (asNum(n) ?? 0), 0)
    : null;

  const items = asArr<ReportThreadItem>(reportsQ.data);
  const domainLabel = label(DOMAIN_LABEL, domain, domain);

  const meta =
    threadTotal === null
      ? undefined
      : threadTotal > LIST_LIMIT
        ? `스레드 ${num(threadTotal)}건 · 최근 ${num(LIST_LIMIT)}건`
        : `스레드 ${num(threadTotal)}건`;

  return (
    <div className="flex flex-col gap-3">
      {/* 1. 도메인 — 단일 선택. 전체가 없는 이유는 파일 머리 주석. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {DOMAINS.map((d) => (
          <Chip
            key={d}
            active={domain === d}
            onClick={() => apply(d, null)}
            tone={{ bg: label(DOMAIN_TINT, d, "#efe8d8"), fg: label(DOMAIN_COLOR, d, "#8a7f6b") }}
          >
            {label(DOMAIN_LABEL, d, d)}
          </Chip>
        ))}
      </div>

      {/* 2. 주차 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip active={cycleKey === null} onClick={() => apply(domain, null)}>
          전체
        </Chip>
        {cyclesQ.isLoading ? (
          <span className="text-[11.5px] text-muted">주차 불러오는 중</span>
        ) : cyclesQ.isError ? (
          <span className="text-[11.5px] text-[#8f2f18]">주차 목록 조회 실패</span>
        ) : weekChips.length === 0 ? (
          <span className="text-[11.5px] text-muted">기록된 주차 없음</span>
        ) : (
          weekChips.map((c) => (
            <Chip key={c} active={cycleKey === c} onClick={() => apply(domain, cycleKey === c ? null : c)}>
              <span className="font-mono tabular-nums">{c}</span>
            </Chip>
          ))
        )}
      </div>

      {/* 3. 표 */}
      {reportsQ.isError ? (
        <LoadError what={`${domainLabel} 보고 스레드`} error={reportsQ.error} />
      ) : (
        <Card className="px-3 pb-1 pt-3">
          <div className="px-1">
            <SectionTitle title="보고 스레드" meta={meta} />
          </div>

          <div className="sticky top-0 z-10 grid border-b border-line bg-[#faf6ec] pt-0.5" style={{ gridTemplateColumns: GRID }}>
            <Th>대상</Th>
            <Th>제목</Th>
            <Th>스레드 상태</Th>
            <Th>보고 주차</Th>
            <Th align="right">시도</Th>
            <Th>최근</Th>
          </div>

          {reportsQ.isLoading ? (
            <Loading what={`${domainLabel} 보고 스레드`} />
          ) : items.length === 0 ? (
            domain === "confluence" ? (
              <Empty
                why="이 도메인에는 리포트 스레드가 없습니다"
                hint="발견의 스페이스와 큐의 스페이스 집합이 서로소라 연결이 만들어지지 않습니다"
              />
            ) : cycleKey ? (
              <Empty
                why={`${cycleKey} 주차에 만들어진 보고 스레드가 없습니다`}
                hint="다른 주차 또는 전체를 선택하세요"
              />
            ) : (
              <Empty
                why={`${domainLabel} 도메인에 보고 스레드가 없습니다`}
                hint="보고 단계까지 올라온 대상이 아직 없습니다"
              />
            )
          ) : (
            <div>
              {items.map((it, i) => {
                const rid = asNum(it.id);
                const src = asStr(it.label);
                const subject = asStr(it.subjectTag);
                const summary = asStr(it.findingSummary);
                const status = asStr(it.status);
                const tone = lookup(THREAD_STATUS, it.status);
                const attempts = asNum(it.attemptCount);
                // recurrenceCount 는 smb(mail_thread) 전용 컬럼이다. 나머지 3종은 항상 null 이라
                // 그리면 "재발 없음" 으로 오독된다. 0 도 그리지 않는다 — 전 행이 "재발 0" 이면 신호가 죽는다.
                const recur = domain === "smb" ? asNum(it.recurrenceCount) : null;
                return (
                  <div key={rid ?? `row-${i}`} className="border-b border-line/60">
                  <button
                    type="button"
                    onClick={() => rid !== null && setOpenId(openId === rid ? null : rid)}
                    aria-expanded={openId === rid}
                    disabled={rid === null}
                    className="grid w-full items-center text-left hover:bg-[#fdf9ef] disabled:cursor-default"
                    style={{ gridTemplateColumns: GRID }}
                  >
                    <div className="truncate px-3 py-2 font-mono text-[12.5px]" title={src ?? undefined}>
                      {src ?? <span className="font-sans text-muted">미상</span>}
                    </div>

                    <div className="min-w-0 px-3 py-2">
                      <div className="truncate text-[12.5px]" title={subject ?? undefined}>
                        {subject ?? <span className="text-muted">—</span>}
                      </div>
                      {summary ? (
                        <div className="truncate text-[10.5px] text-muted" title={summary}>
                          {summary}
                        </div>
                      ) : null}
                    </div>

                    <div className="px-3 py-2">
                      {status === null ? (
                        <span className="text-[12.5px] text-muted">—</span>
                      ) : (
                        <Pill tone={tone}>{tone ? tone.label : status}</Pill>
                      )}
                    </div>

                    <div
                      className="truncate px-3 py-2 font-mono text-[11.5px] tabular-nums text-walnut-ink"
                      title={cycleFull(it.cycleKeys)}
                    >
                      {cycleText(it.cycleKeys)}
                    </div>

                    <div className="px-3 py-2 text-right">
                      <div className="font-mono text-[12.5px] tabular-nums">
                        {attempts === null ? "—" : num(attempts)}
                      </div>
                      {recur !== null && recur > 0 ? (
                        <div className="font-mono text-[10.5px] tabular-nums text-muted">재발 {num(recur)}</div>
                      ) : null}
                    </div>

                    <div className="px-3 py-2 text-[12px] text-muted" title={stamp(it.updatedAt)}>
                      {ago(it.updatedAt)}
                    </div>
                  </button>
                  {openId !== null && openId === rid ? (
                    <MailBodyPanel domain={domain} threadId={rid} />
                  ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
