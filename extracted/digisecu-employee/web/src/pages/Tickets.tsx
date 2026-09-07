/**
 * 티켓 목록 — 단위는 finding 이 아니라 **대상(src)** 이다.
 *
 * finding 은 파일/URL 하나하나지만 사람이 조치하는 단위는 그것이 속한 곳(호스트·저장소·
 * 웹도메인·스페이스)이다. 도메인 밀도가 1,980:1(GitHub 19,808 : Confluence 10)이라
 * finding 건수로 줄세우면 화면이 GitHub 하나로 무너진다.
 *
 * 규칙:
 *  - 집계는 전부 서버가 준 값(list.total · stats.domains[].sources)이다. items 를 세지 않는다.
 *  - 필터 상태는 URL 이 소유한다(useSearchParams). 개요에서 `/tickets?threadState=none` 으로
 *    넘어오면 그 필터가 걸린 채 열려야 하고, 새로고침·뒤로가기에도 살아 있어야 한다.
 *  - 링크는 `srcKey`(불투명 해시)로만 건다. 원문 src 는 마스킹 라벨이라 URL 에 쓰면 새거나
 *    라벨 충돌로 남의 티켓이 열린다.
 *  - 담당자 칸은 "없음" 과 "못 읽음" 을 구분한다(ownerLookup="denied" → 권한 없음).
 */
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { SourceItem } from "@digisecu/contracts";
import { useGatewayStats, useSources } from "../lib/queries";
import { ago, asArr, asNum, asStr, label, lookup, num, shortDate, stamp } from "../lib/guards";
import {
  ASSIGNEE_FILTER,
  ASSIGNEE_STATUS,
  ORDER_OPTIONS,
  SEVERITY_FILTER,
  DOMAIN_COLOR,
  DOMAIN_LABEL,
  DOMAIN_TINT,
  DOMAINS,
  SEV,
  SRC_KIND_LABEL,
  THREAD_STATE_FILTER,
  THREAD_STATUS,
  DELIVERY_TONE,
  deliveryView,
} from "../lib/soarMeta";
import { Card, Chip, DomainTag, Empty, Loading, LoadError, Pill, Th } from "../components/ui";

/** 도메인 / 대상 / 담당자 / 발견 / 분류 / 심각 / 통보 / 발송 / 발생 */
// 2026-08-29: **분류** 열 추가. 발견 수 옆에 둔다 — 같은 "무엇이 걸렸나" 축이다.
// 대상 열이 남는 폭을 혼자 다 먹고 있었다 → 분류에도 유동 폭을 줘서 나눈다.
// 마지막 열은 "최근 관측"(상대시간)에서 **발생**(날짜+시간)으로 바꿨다 — 폭이 더 필요하다.
const COLS = "82px minmax(0,1.6fr) 132px 58px minmax(104px,0.9fr) 56px 112px 96px 126px";
const LIMIT = 50;

/** URL `order` 어휘 — 셀렉트는 두지 않는다(정렬은 딥링크로만 바뀐다). */
const ORDERS = ["firstSeen", "findings", "critical", "lastSeen", "stale"] as const;

const DENIED_FG = "#8f2f18";
/** 스레드가 0건인 대상 — THREAD_STATUS 어휘엔 없는 상태다(아직 아무 스레드도 안 생겼다). */
const UNNOTIFIED_TONE = { bg: "#f6e7e2", fg: DENIED_FG };
/** critical 은 4단계를 접지 않는다(high 로 접던 사고 이력). 어휘가 비면 색만 대체한다. */
const CRIT_TONE = label(SEV, "critical", { label: "심각", bg: "#7f1d1d", fg: "#fee2e2" });

type ThreadState = (typeof THREAD_STATE_FILTER)[number]["key"];
type FilterKey = "domain" | "threadState" | "q" | "category" | "severity" | "assignee" | "order";

/** 검색어 상한 — 게이트웨이 `_Q_MAX`(120) 와 맞춘다. 넘겨봐야 서버가 자른다. */
const Q_MAX = 120;

// ── 셀 ──────────────────────────────────────────────────────────────────────

function SrcCell({ it }: { it: SourceItem }) {
  // src=null 은 파싱 실패다. 빈칸으로 두면 행이 유령이 된다.
  const src = asStr(it.src) ?? "(미상)";
  const kind = label(SRC_KIND_LABEL, it.srcKind, "대상");
  // ★ 티켓 번호는 **메일 제목에 실제로 나가는 번호**다(`[티켓 SMB00024]`).
  //   담당자가 그 번호로 문의하면 운영자가 위 검색창에 그대로 붙여넣어 찾는다.
  //   ⚠️ 한 대상에 스레드가 여럿이면 **가장 최근 것**이다 — 그래서 스레드 수를 옆에 둔다.
  const ticket = asStr(it.ticketNo);
  return (
    <div className="min-w-0 px-3">
      <div className="truncate font-mono text-[12.5px] text-ink">{src}</div>
      <div className="truncate text-[11px] text-muted">
        {ticket ? (
          <span className="font-mono text-walnut" title="메일 제목에 나가는 티켓 번호">
            {ticket}
          </span>
        ) : null}
        {ticket ? " · " : ""}
        {kind} · 스레드 {num(it.threads)}
      </div>
    </div>
  );
}

function AssigneeCell({ it, ownerDenied }: { it: SourceItem; ownerDenied: boolean }) {
  const status = it.assignee?.status;
  const meta = lookup(ASSIGNEE_STATUS, status);

  // ★ 목록 전체가 denied(asset_owner GRANT 부재)거나 이 건만 lookup_denied 인 경우.
  //   전원 미배정으로 보이던 것이 선존 버그였다 — 못 읽은 것은 못 읽었다고 쓴다.
  if (ownerDenied || status === "lookup_denied") {
    return (
      <div className="min-w-0 px-3">
        <div className="truncate text-[12.5px]" style={{ color: DENIED_FG }}>
          권한 없음
        </div>
      </div>
    );
  }

  // 이메일뿐인 담당자(github=커밋 작성자)는 **로컬파트만** 보여준다. 154px 열에 전체 주소를
  // 넣으면 `sm9063.lee@samsu…` 로 잘려서 오히려 못 읽는다. 전체 주소는 title 로 남긴다.
  const email = asStr(it.assignee?.email);
  const name = asStr(it.assignee?.name) ?? (email ? email.split("@")[0] : null);
  const statusLabel = asStr(meta?.label);
  const head = name ?? statusLabel ?? "—";
  const headTitle = email ?? name ?? undefined;
  const sourceLabel = asStr(it.assignee?.sourceLabel);
  // 부서가 있으면 그걸 먼저 보여준다 — 근거 라벨보다 "누구인지" 가 먼저다.
  // 근거는 확정/추정이 갈릴 때만 의미가 있으므로 추정일 때 부서 뒤에 덧붙인다.
  const dept = asStr(it.assignee?.dept);
  // ★ confirmed=false 는 추정(조직 저장소의 주 기여자)이다. 확정과 같은 모양으로 그리면
  //   추정이 확정으로 위장한다 — 서버가 이미 라벨로도 갈라 주지만 화면에서도 표시한다.
  const estimated = it.assignee?.confirmed === false;
  const sub =
    dept ?? sourceLabel ?? (statusLabel !== head ? statusLabel : null);

  // tone="warn" 은 어휘상 lookup_denied 하나뿐이지만(위에서 이미 갈라진다) 어휘가 늘어도
  // 경고색을 잃지 않게 여기서도 본다.
  const tone = meta?.tone === "warn" ? DENIED_FG : undefined;

  return (
    <div className="min-w-0 px-3">
      <div
        className={`truncate text-[12.5px] ${name ? "text-ink" : "text-muted"}`}
        style={tone ? { color: tone } : undefined}
        title={headTitle}
      >
        {head}
      </div>
      {sub ? (
        <div className="truncate text-[11px] text-muted" title={sourceLabel ?? undefined}>
          {estimated ? <span className="text-[10px]">추정 · </span> : null}
          {sub}
        </div>
      ) : null}
    </div>
  );
}

/** 발견사항 분류 — 대표 하나를 칩으로, 나머지는 개수로.
 *
 * ⚠️ 한 대상이 여러 분류에 걸친다(개요의 "노출 유형" 도 중복 계수라고 밝힌다). 대표만
 *    그리고 침묵하면 "이 대상은 크리덴셜만" 으로 읽힌다 — `+N` 과 툴팁으로 전부 밝힌다.
 * ⚠️ 색은 **키에 묶지 않는다.** 서버가 새 분류를 내면 색 테이블이 조용히 undefined 를
 *    돌려주고 칩이 무색이 된다. 고정 순서 팔레트를 인덱스로 쓴다(개요와 같은 방식).
 */
const CAT_TONE = [
  { bg: "#f6e7e2", fg: "#8f2f18" },
  { bg: "#e9eee0", fg: "#4f5f3a" },
  { bg: "#f5ecd6", fg: "#7d5108" },
  { bg: "#e6ecf0", fg: "#3f5566" },
  { bg: "#efe8d8", fg: "#7a5c3e" },
  { bg: "#eee6ee", fg: "#6b5563" },
] as const;

/** 필터 한 줄 — 이름 + 칩들. 이름 폭을 고정해 줄들이 세로로 정렬된다. */
function FilterRow({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 w-[42px] shrink-0 text-[11px] text-muted">{name}</span>
      {children}
    </div>
  );
}


function CategoryCell({ it }: { it: SourceItem }) {
  const all = asArr<{ key?: unknown; label?: unknown }>(it.categories);
  const rep = it.category;
  const repLabel = asStr(rep?.label) ?? asStr(rep?.key);
  if (!repLabel) {
    return (
      <div className="px-3 text-[11.5px] text-muted" title="이 대상 발견에 분류 근거(hits)가 없습니다">
        미분류
      </div>
    );
  }
  const idx = Math.max(0, all.findIndex((c) => asStr(c.key) === asStr(rep?.key)));
  const tone = CAT_TONE[idx % CAT_TONE.length] ?? CAT_TONE[0];
  const rest = all.length - 1;
  const full = all.map((c) => asStr(c.label) ?? asStr(c.key) ?? "").filter(Boolean).join(" · ");
  return (
    <div className="flex min-w-0 items-center gap-1 px-3" title={full || repLabel}>
      <span
        className="truncate rounded px-1.5 py-[2px] text-[11px]"
        style={{ background: tone.bg, color: tone.fg }}
      >
        {repLabel}
      </span>
      {rest > 0 ? (
        <span className="shrink-0 font-mono text-[10.5px] text-muted">+{rest}</span>
      ) : null}
    </div>
  );
}


function ThreadCell({ it }: { it: SourceItem }) {
  const threads = asNum(it.threads) ?? 0;
  if (threads === 0) {
    return (
      <div className="px-3">
        <Pill tone={UNNOTIFIED_TONE}>보고 없음</Pill>
      </div>
    );
  }
  // 어휘 밖 status 는 숨기지 않고 원문을 회색으로 그린다(숨기면 상태가 사라진다).
  const meta = lookup(THREAD_STATUS, it.threadStatus);
  const text = asStr(meta?.label) ?? asStr(it.threadStatus) ?? "—";
  return (
    <div className="px-3">
      <Pill tone={meta}>{text}</Pill>
    </div>
  );
}

function Row({ it, ownerDenied, backSearch }: {
  it: SourceItem;
  ownerDenied: boolean;
  /** 목록의 현재 필터·검색(쿼리 문자열). 상세에서 돌아올 때 복원하려고 실어 보낸다. */
  backSearch: string;
}) {
  const domainKey = asStr(it.domain) ?? "";
  const critical = asNum(it.critical) ?? 0;
  const attempts = asNum(it.attemptCount) ?? 0;
  // ★ 예전엔 `it.notifiedAt ?? it.firstReportedAt` 였다 — 발송 시각이 없으면 **스레드 생성
  //   시각**으로 대체해 발송 날짜처럼 그렸다. 없는 사실을 지어내는 것이라 끊는다.
  //   발송 여부는 근거(deliveryEvidence)와 함께 판정한다.
  const delivery = deliveryView(it.deliveryEvidence, it.notifiedAt, it.threadStatus);

  return (
    <Link
      // 목록의 필터·검색을 상세에 실어 보낸다 — 돌아올 때 그대로 복원하기 위해서다.
      // (필터는 URL 이 소유하므로 `params` 문자열만 넘기면 된다)
      to={{
        pathname: `/tickets/${encodeURIComponent(it.srcKey)}`,
        search: backSearch ? `?back=${encodeURIComponent(backSearch)}` : "",
      }}
      style={{ gridTemplateColumns: COLS }}
      className="grid items-center border-b border-line/60 py-1.5 hover:bg-[#fdf9ef]"
    >
      <div className="px-3">
        <DomainTag
          domain={domainKey}
          label={label(DOMAIN_LABEL, domainKey, domainKey || "알 수 없음")}
          color={label(DOMAIN_COLOR, domainKey, "#8a7f6b")}
          tint={label(DOMAIN_TINT, domainKey, "#efe8d8")}
        />
      </div>

      <SrcCell it={it} />
      <AssigneeCell it={it} ownerDenied={ownerDenied} />

      <div className="px-3 text-right font-mono text-[12.5px] tabular-nums text-ink">
        {num(it.findings)}
      </div>

      <CategoryCell it={it} />

      <div className="px-3 text-right">
        {critical > 0 ? (
          <Pill tone={{ bg: CRIT_TONE.bg, fg: CRIT_TONE.fg }}>
            <span className="font-mono tabular-nums">{num(critical)}</span>
          </Pill>
        ) : (
          <span className="font-mono text-[12.5px] text-muted">—</span>
        )}
      </div>

      <ThreadCell it={it} />

      <div
        className="overflow-hidden whitespace-nowrap px-3 font-mono text-[11px] tabular-nums"
        title={delivery.hint}
      >
        <span style={{ color: DELIVERY_TONE[delivery.tone].fg }}>
          {delivery.tone === "sent" ? shortDate(it.notifiedAt) : delivery.label}
        </span>
        {attempts > 0 ? <span className="text-muted"> · 재시도 {attempts}회</span> : null}
      </div>

      <div className="px-3 text-right font-mono text-[11.5px] tabular-nums text-muted">
        {/* ★ 발생(first_seen) 이다. "최근 관측"(last_seen)은 뒤 run 이 같은 것을 다시
             보기만 해도 갱신돼서, 오래 방치된 티켓이 새것처럼 보인다.
             툴팁에 최근 관측을 남겨 둘 다 확인할 수 있게 한다. */}
        <span title={`최근 관측 ${stamp(it.lastSeen)}`}>{stamp(it.firstSeen)}</span>
      </div>
    </Link>
  );
}

// ── 화면 ────────────────────────────────────────────────────────────────────

export function Tickets() {
  const [params, setParams] = useSearchParams();

  // URL 값은 전부 어휘 대조를 통과한 것만 쓴다. 모르는 값은 필터 없음으로 떨어뜨린다
  // (그대로 게이트웨이에 넘기면 400 이거나, 조용히 무시돼 "필터가 걸린 줄 아는" 화면이 된다).
  const domain = DOMAINS.find((d) => d === params.get("domain")) ?? null;
  const threadState: ThreadState | null =
    THREAD_STATE_FILTER.find((f) => f.key === params.get("threadState"))?.key ?? null;
  const order = ORDERS.find((o) => o === params.get("order"));
  // 어휘 대조를 통과한 값만 쓴다. 모르는 값을 그대로 넘기면 서버가 400 이고(조용한 무시보다
  // 낫다), 화면은 "필터가 걸린 줄 아는" 상태가 된다.
  const severity = SEVERITY_FILTER.find((f) => f.key === params.get("severity"))?.key ?? null;
  const assignee = ASSIGNEE_FILTER.find((f) => f.key === params.get("assignee"))?.key ?? null;
  // 검색어는 어휘 대조 대상이 아니다(자유 입력) — 길이만 자른다. 서버가 LIKE 메타문자를
  // 이스케이프하므로 `_`·`%` 는 리터럴로 찾힌다.
  const search = (params.get("q") ?? "").slice(0, Q_MAX);
  // 분류는 서버(개요 집계)가 낸 어휘로 대조한다 — 화면에 어휘를 또 박으면 서버가 분류를
  // 늘렸을 때 여기만 옛 목록으로 남는다. ⚠️ 그 목록(stats)은 아래에서 오므로, 여기서는
  // 형식만 보고(빈 문자열 배제) 대조는 목록이 온 뒤에 한다.
  const categoryParam = (params.get("category") ?? "").slice(0, 40) || null;
  const rawPage = Number(params.get("page") ?? "1");
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const offset = (page - 1) * LIMIT;

  const q = useSources({
    domain: domain ?? undefined,
    threadState: threadState ?? undefined,
    q: search || undefined,
    category: categoryParam ?? undefined,
    severity: severity ?? undefined,
    assignee: assignee ?? undefined,
    // 기본은 발생 최신 순. URL 에 order 가 없어도 서버 기본(findings)으로 떨어지지 않게
    // **여기서** 정한다 — 화면의 칩 활성 표시와 실제 정렬이 갈리면 안 된다.
    order: order ?? "firstSeen",
    limit: LIMIT,
    offset,
  });
  // 칩 숫자는 개요 집계에서 가져온다 — 목록을 세면 페이지 안의 50건만 세게 된다.
  const [showMore, setShowMore] = useState(false);
  const statsQ = useGatewayStats();
  const stats = statsQ.data;

  const catOptions = asArr<{ key?: unknown; label?: unknown; count?: unknown }>(stats?.categories)
    .map((c) => ({ key: asStr(c.key) ?? "", label: asStr(c.label) ?? "", count: asNum(c.count) ?? 0 }))
    .filter((c) => c.key !== "");
  // 집계가 아직 안 왔으면 어휘를 못 고르므로 파라미터를 그대로 인정한다(서버가 422 로 거부).
  const category = catOptions.length === 0
    ? categoryParam
    : (catOptions.find((c) => c.key === categoryParam)?.key ?? null);

  const srcCount = new Map<string, number>();
  for (const d of asArr<{ domain?: unknown; sources?: unknown }>(stats?.domains)) {
    const k = asStr(d.domain);
    const n = asNum(d.sources);
    if (k !== null && n !== null) srcCount.set(k, n);
  }

  const total = asNum(q.data?.total) ?? 0;
  const ownerDenied = q.data?.ownerLookup === "denied";
  // srcKey 가 없으면 상세로 갈 수 없다 — 클릭해도 죽는 행을 그리느니 뺀다.
  const rows = asArr<SourceItem>(q.data?.items).filter((it) => !!it && !!asStr(it.srcKey));

  /** 필터 변경 — 페이지는 1로 되돌린다(3페이지에서 필터를 바꾸면 빈 화면이 나온다). */
  function setFilter(key: FilterKey, value: string | null) {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    next.delete("page");
    setParams(next);
  }

  function goPage(p: number) {
    const next = new URLSearchParams(params);
    if (p <= 1) next.delete("page");
    else next.set("page", String(p));
    setParams(next);
  }

  const active: { key: FilterKey; label: string }[] = [];
  if (domain) active.push({ key: "domain", label: label(DOMAIN_LABEL, domain, domain) });
  if (threadState) {
    const f = THREAD_STATE_FILTER.find((x) => x.key === threadState);
    if (f) active.push({ key: "threadState", label: f.label });
  }
  if (search) active.push({ key: "q", label: `"${search}" 포함` });
  if (category) {
    const c = catOptions.find((x) => x.key === category);
    if (c) active.push({ key: "category", label: c.label || c.key });
  }
  if (severity) {
    const f = SEVERITY_FILTER.find((x) => x.key === severity);
    if (f) active.push({ key: "severity", label: f.label });
  }
  if (assignee) {
    const f = ASSIGNEE_FILTER.find((x) => x.key === assignee);
    if (f) active.push({ key: "assignee", label: f.label });
  }

  // 접힌 칸에 걸린 필터 수. 0 이 아니면 접혀 있어도 강제로 펼친다 — 안 보이는 필터가
  // 결과를 깎고 있으면 "왜 이것뿐이지" 가 된다.
  const detailCount = [category, severity, assignee, threadState].filter(Boolean).length;
  const detailOpen = showMore || detailCount > 0;

  const domainStats = domain ? stats?.domains.find((d) => d.domain === domain) : undefined;
  const hasRange = total > 0 && offset < total;

  return (
    <div className="px-5 py-4">
      {active.length > 0 ? (
        <div className="mb-2.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
          <Link to="/" className="text-walnut hover:underline">
            개요
          </Link>
          <span aria-hidden>›</span>
          {active.map((f) => (
            <span
              key={f.key}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-sel px-2 py-0.5 text-walnut-ink"
            >
              {f.label}
              <button
                type="button"
                onClick={() => setFilter(f.key, null)}
                aria-label={`${f.label} 필터 해제`}
                className="text-muted hover:text-[#8f2f18]"
              >
                ✕
              </button>
            </span>
          ))}
          <span className="ml-1 font-mono tabular-nums">
            {num(total)} / {num(stats?.totals.sources)}
          </span>
        </div>
      ) : null}

      {/* ── 필터 ──────────────────────────────────────────────────────────
          줄마다 한 축씩 쌓으면 7줄이 되고 표가 화면 밖으로 밀린다. 자주 쓰는 둘
          (찾기·도메인)만 항상 두고 나머지는 접는다.
          ⚠️ 접힌 채로 필터가 걸려 있으면 "왜 결과가 이것뿐이지" 가 된다 — 걸린 게
             하나라도 있으면 **자동으로 펼친다**(위쪽 요약 칩도 그걸 다시 말해준다). */}
      <div className="mb-3 rounded-lg border border-line bg-card px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <SourceSearch value={search} onSubmit={(v) => setFilter("q", v || null)} />

          <span className="h-4 w-px bg-line" aria-hidden />

          <div className="flex flex-wrap items-center gap-1.5">
            <Chip active={!domain} onClick={() => setFilter("domain", null)}>전체</Chip>
            {DOMAINS.map((d) => (
              <Chip
                key={d}
                active={domain === d}
                onClick={() => setFilter("domain", domain === d ? null : d)}
              >
                {label(DOMAIN_LABEL, d, d)}
                <span className="ml-1.5 font-mono text-[11px] tabular-nums opacity-70">
                  {num(srcCount.get(d))}
                </span>
              </Chip>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            aria-expanded={detailOpen}
            className="ml-auto shrink-0 rounded border border-line px-2 py-[3px] text-[11.5px] text-muted hover:text-walnut-ink"
          >
            상세 필터
            {detailCount > 0 ? (
              <span className="ml-1 font-mono tabular-nums text-walnut">{detailCount}</span>
            ) : null}
            <span className="ml-1" aria-hidden>{detailOpen ? "\u25b4" : "\u25be"}</span>
          </button>
        </div>

        {detailOpen ? (
          <div className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1.5 border-t border-line/60 pt-2">
            <FilterRow name="분류">
              <Chip active={!category} onClick={() => setFilter("category", null)}>전체</Chip>
              {catOptions.map((c) => (
                <Chip
                  key={c.key}
                  active={category === c.key}
                  onClick={() => setFilter("category", category === c.key ? null : c.key)}
                >
                  {c.label || c.key}
                  <span className="ml-1.5 font-mono text-[11px] tabular-nums opacity-70">
                    {num(c.count)}
                  </span>
                </Chip>
              ))}
            </FilterRow>

            <FilterRow name="심각도">
              <Chip active={!severity} onClick={() => setFilter("severity", null)}>전체</Chip>
              {SEVERITY_FILTER.map((f) => (
                <Chip
                  key={f.key}
                  active={severity === f.key}
                  onClick={() => setFilter("severity", severity === f.key ? null : f.key)}
                >
                  {f.label}
                </Chip>
              ))}
            </FilterRow>

            {/* ★ "담당자 없음" 은 보낼 곳을 모른다는 뜻이라 조치가 멈추는 자리다 —
                개요에서 바로 넘어올 수 있게 URL 필터로 둔다. */}
            <FilterRow name="담당자">
              <Chip active={!assignee} onClick={() => setFilter("assignee", null)}>전체</Chip>
              {ASSIGNEE_FILTER.map((f) => (
                <Chip
                  key={f.key}
                  active={assignee === f.key}
                  onClick={() => setFilter("assignee", assignee === f.key ? null : f.key)}
                >
                  {f.label}
                </Chip>
              ))}
            </FilterRow>

            {/* 보고 상태 칩엔 숫자를 안 붙인다 — "보고 없음" 은 대상 수, "회신 대기" 는
                스레드 수라 단위가 섞인다. */}
            <FilterRow name="통보">
              <Chip active={!threadState} onClick={() => setFilter("threadState", null)}>전체</Chip>
              {THREAD_STATE_FILTER.map((f) => (
                <Chip
                  key={f.key}
                  active={threadState === f.key}
                  onClick={() => setFilter("threadState", threadState === f.key ? null : f.key)}
                >
                  {f.label}
                </Chip>
              ))}
            </FilterRow>

            {/* 정렬 — 게이트웨이엔 4종이 있었는데 화면에 컨트롤이 없어 URL 로만 먹었다. */}
            <FilterRow name="정렬">
              {ORDER_OPTIONS.map((o) => (
                <Chip
                  key={o.key}
                  active={(order ?? "firstSeen") === o.key}
                  onClick={() => setFilter("order", o.key === "firstSeen" ? null : o.key)}
                >
                  {o.label}
                </Chip>
              ))}
            </FilterRow>
          </div>
        ) : null}
      </div>

      {q.isLoading ? (
        <Card className="overflow-hidden">
          <Loading what="티켓 목록" />
        </Card>
      ) : q.isError ? (
        <LoadError what="티켓 목록" error={q.error} />
      ) : (
        <Card className="overflow-hidden">
          <div
            // 목록이 길다(971행). 머리가 따라와야 어느 열인지 잃지 않는다.
            className="sticky top-0 z-10 grid border-b border-line bg-[#faf6ec] pt-2"
            style={{ gridTemplateColumns: COLS }}
          >
            <Th>도메인</Th>
            <Th>대상</Th>
            <Th>담당자</Th>
            <Th align="right">발견</Th>
            <Th>분류</Th>
            <Th align="right">심각</Th>
            <Th>통보 상태</Th>
            <Th>발송</Th>
            <Th align="right">발생</Th>
          </div>

          {rows.length === 0 ? (
            <Empty
              why={
                total > 0
                  ? "이 페이지에는 대상이 없습니다"
                  : active.length > 0
                    ? "조건에 맞는 대상이 없습니다"
                    : "대상이 없습니다"
              }
              hint={
                total > 0 ? (
                  <span className="font-mono tabular-nums">
                    전체 {num(total)} · {LIMIT}건씩 · {page}페이지
                  </span>
                ) : domainStats ? (
                  <span className="font-mono tabular-nums">
                    {label(DOMAIN_LABEL, domainStats.domain, domainStats.domain)} · 대상{" "}
                    {num(domainStats.sources)} · 스레드 {num(domainStats.threads)} · 보고 없는 대상{" "}
                    {num(domainStats.sourcesWithoutThread)}
                  </span>
                ) : (
                  <span className="font-mono tabular-nums">
                    전체 대상 {num(stats?.totals.sources)}
                  </span>
                )
              }
            />
          ) : (
            <div>
              {rows.map((it) => (
                <Row key={it.srcKey} it={it} ownerDenied={ownerDenied} backSearch={params.toString()} />
              ))}
            </div>
          )}

          <div className="flex items-center gap-3 border-t border-line bg-[#f9f5eb] px-3 py-2">
            <span className="font-mono text-[11.5px] tabular-nums text-muted">
              {hasRange ? `${offset + 1}–${Math.min(offset + LIMIT, total)}` : "—"} / {num(total)}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => goPage(page - 1)}
              disabled={page <= 1}
              className="rounded-md border border-line px-2.5 py-1 text-[12px] text-walnut-ink transition-colors hover:bg-card disabled:opacity-40 disabled:hover:bg-transparent"
            >
              이전
            </button>
            <button
              type="button"
              onClick={() => goPage(page + 1)}
              disabled={offset + LIMIT >= total}
              className="rounded-md border border-line px-2.5 py-1 text-[12px] text-walnut-ink transition-colors hover:bg-card disabled:opacity-40 disabled:hover:bg-transparent"
            >
              다음
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * 대상 찾기 입력.
 *
 * ⚠️ 타이핑마다 요청하지 않는다(디바운스도 없다). 985건 목록에서 글자마다 서버
 *    group-by 를 돌리면 `pool_max=4` 를 굶긴다 — `/gw/stats` 가 이미 949ms 다.
 *    **제출할 때만** URL 을 바꾸고, URL 이 바뀌면 그때 한 번 조회한다.
 * ⚠️ 필터 상태의 소유자는 URL 이다. 여기 로컬 state 는 **입력 중인 초안**일 뿐이라,
 *    밖에서 URL 이 바뀌면(칩 해제·뒤로가기) 초안을 버리고 따라간다.
 */
function SourceSearch({ value, onSubmit }: { value: string; onSubmit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(draft.trim().slice(0, Q_MAX));
      }}
    >
      <input
        type="search"
        name="q"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={Q_MAX}
        placeholder="호스트 · 저장소 · 도메인 · 스페이스"
        aria-label="대상 찾기"
        className="h-[26px] w-[240px] rounded-md border border-line bg-card px-2 font-mono text-[11.5px] text-ink placeholder:text-muted focus:border-walnut focus:outline-none"
      />
      <button
        type="submit"
        className="h-[26px] rounded-md border border-line px-2 text-[11.5px] text-walnut-ink hover:bg-sel"
      >
        찾기
      </button>
      {value ? (
        <button
          type="button"
          onClick={() => onSubmit("")}
          className="h-[26px] px-1.5 text-[11.5px] text-muted hover:text-ink"
        >
          지우기
        </button>
      ) : null}
    </form>
  );
}
