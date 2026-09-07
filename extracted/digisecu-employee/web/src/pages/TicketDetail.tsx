/**
 * 티켓 상세 — 대상(src) 한 곳.
 *
 * finding 은 파일/URL 하나하나지만 사람이 조치하는 단위는 그것이 속한 곳(호스트·저장소·
 * 웹도메인·스페이스)이다. 이 화면은 그 한 곳에 대해 "무엇이 있고 / 언제 나갔고 / 어디까지
 * 왔는지" 세 가지만 답한다.
 *
 * ⚠️ 키는 `srcKey`(불투명 해시)다. 표시 라벨 `src` 는 마스킹된 값이라 서로 다른 두 대상이
 *    같은 라벨로 보일 수 있다 — 되묻기·링크는 전부 srcKey 로만 한다.
 * ⚠️ 집계 숫자는 전부 서버가 준 값(findings/openFindings/critical/high/threads/total)을 쓴다.
 *    목록 길이로 숫자를 만들지 않는다. 유일한 예외는 "몇 건을 지금 그리고 있는가"(items.length /
 *    total) 표기인데, 이건 집계가 아니라 화면이 절단됐다는 사실을 밝히는 값이다.
 */
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { OwnerAssignResult, SourceItem } from "@digisecu/contracts";
import { assignOwner } from "../lib/api";
import { useGatewayFindings, useSource } from "../lib/queries";
import { Card, DomainTag, Empty, LoadError, Loading, Pill, SectionTitle, Th } from "../components/ui";
import { SmbSurface } from "./SmbSurface";
import { TicketWorkspace } from "../components/TicketWorkspace";
import { ago, asNum, asStr, daysBetween, label, lookup, num, stamp } from "../lib/guards";
import {
  ASSIGNEE_STATUS,
  DOMAIN_COLOR,
  DOMAIN_LABEL,
  DOMAIN_TINT,
  SEV,
  SRC_KIND_LABEL,
  THREAD_STATUS,
  DELIVERY_TONE,
  deliveryView,
  hitlView,
} from "../lib/soarMeta";

/** 발견 표 열 폭. GatewayFinding(목록)에는 verification 이 없다 — 검증 열은 두지 않는다
 *  (verification 은 단건 상세 GatewayFindingDetail 에만 있다). */
const FINDING_COLS = "62px 92px minmax(0,1fr) 76px";

/** 처리 단계 색 — 완료/진행 중/대기. */
const STEP_COLOR = { done: "#2fa365", active: "#5f7a9a", wait: "#9a9a94" } as const;
type StepState = keyof typeof STEP_COLOR;
const STEP_STATE_LABEL: Record<StepState, string> = { done: "완료", active: "진행 중", wait: "대기" };

/** 회신이 한 번이라도 돌아온 상태들(종결 계열 포함 — 종결이면 회신도 지난 것이다). */
const REPLIED_STATES = [
  "reply_received", "re_requested", "recheck_requested", "rechecking",
  "partially_remediated", "remediated", "closed", "resolved", "false_positive",
];
/** 재검증이 돌고 있는 상태들. */
const RECHECKING_STATES = ["recheck_requested", "rechecking", "partially_remediated"];
/** 재검증까지 끝난 상태들. false_positive 는 여기 넣지 않는다 — 오탐은 조치가 아니다. */
const SETTLED_STATES = ["remediated", "closed", "resolved"];

export function TicketDetail() {
  const { srcKey } = useParams<{ srcKey: string }>();
  // 목록에서 실어 보낸 필터·검색. 뒤로 갈 때 그대로 복원한다 — 없으면 목록이
  // 초기화되어, 필터를 걸고 하나씩 확인하던 흐름이 매번 끊긴다.
  const [detailParams, setDetailParams] = useSearchParams();

  // ── 탭 ──────────────────────────────────────────────────────────────────
  // 워크스페이스를 우열(360px)에 두면 메일 본문이 그 폭으로 눌린다. 본문은 담당자에게
  // 실제로 나갈 글이라 전폭으로 읽어야 한다 — 접기/펴기는 폭 문제를 미루기만 한다.
  // ⚠️ 탭 상태를 useState 로 두면 새로고침·뒤로가기에서 사라지고 링크로 공유도 안 된다.
  //    `back` 파라미터를 이미 URL 로 나르고 있으므로 같은 자리에 둔다.
  const tab = detailParams.get("tab") === "workspace" ? "workspace" : "overview";
  const setTab = (next: "overview" | "workspace") => {
    const p = new URLSearchParams(detailParams);
    if (next === "overview") p.delete("tab");
    else p.set("tab", next);
    setDetailParams(p, { replace: true });
  };

  const backTo = (() => {
    const raw = detailParams.get("back") ?? "";
    return raw ? `/tickets?${raw}` : "/tickets";
  })();
  const source = useSource(srcKey);
  const findings = useGatewayFindings({ srcKey, limit: 30 }, { enabled: !!srcKey });
  const now = Date.now() / 1000;

  if (source.isLoading) {
    return (
      <div className="px-5 py-4">
        <Loading what="티켓" />
      </div>
    );
  }
  if (source.isError) {
    return (
      <div className="px-5 py-4">
        <LoadError what="티켓" error={source.error} />
      </div>
    );
  }

  const item = source.item;
  if (!item) {
    return (
      <div className="px-5 py-10">
        <Empty
          why="이 대상을 찾지 못했습니다"
          hint="주소의 대상 키가 더 이상 게이트웨이 집계에 없습니다."
        />
        <div className="mt-3 text-center">
          <Link
            to={backTo}
            className="inline-block rounded-lg border border-line bg-card px-3 py-1.5 text-[12.5px] text-walnut hover:bg-[#fdf9ef]"
          >
            티켓 목록으로
          </Link>
        </div>
      </div>
    );
  }

  // 표시 라벨. src=null 은 파싱 실패(=미상) — 빈칸으로 두면 "이름이 없는 대상"처럼 보인다.
  const srcLabel = asStr(item.src) ?? "미상";
  const domain = asStr(item.domain) ?? "";
  const firstSeenDays = daysBetween(item.firstSeen, now);
  const attempts = asNum(item.attemptCount);
  // 워크스페이스 탭에 점을 찍을지 — 사람이 할 일이 있으면 탭을 안 열어도 보이게 한다.
  const hitlNeedsPerson = hitlView(item, now).state !== "none";

  return (
    <div className="flex flex-col gap-3.5 px-5 py-4">
      {/* ── 머리 ── */}
      <header className="border-b border-line pb-3">
        <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <Link to={backTo} className="hover:text-walnut">티켓</Link>
          <span aria-hidden>›</span>
          <span>{label(SRC_KIND_LABEL, item.srcKind, "대상")}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
          <h1 className="min-w-0 break-all font-mono text-[15px] text-ink">{srcLabel}</h1>
          <DomainTag
            domain={domain}
            label={label(DOMAIN_LABEL, domain, domain || "미상")}
            color={label(DOMAIN_COLOR, domain, "#8a7f6b")}
            tint={label(DOMAIN_TINT, domain, "#efe8d8")}
          />
          <ThreadPill item={item} />
          <div className="ml-auto">
            <AssigneeChip item={item} ownerLookup={source.ownerLookup} />
          </div>
        </div>
      </header>

      {/* ── 탭 ── */}
      <nav className="-mt-1 flex items-center gap-1 border-b border-line" role="tablist">
        {([
          ["overview", "개요"],
          ["workspace", "워크스페이스"],
        ] as const).map(([key, name]) => {
          const on = tab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setTab(key)}
              className={[
                "-mb-px border-b-2 px-3 py-1.5 text-[12.5px]",
                on
                  ? "border-walnut text-walnut-ink"
                  : "border-transparent text-muted hover:text-walnut-ink",
              ].join(" ")}
            >
              {name}
              {key === "workspace" && hitlNeedsPerson ? (
                <span
                  className="ml-1.5 inline-block h-[6px] w-[6px] rounded-full align-middle"
                  style={{ background: "#b07d1a" }}
                  title="사람 차례입니다"
                />
              ) : null}
            </button>
          );
        })}
      </nav>

      {tab === "workspace" ? (
        /* 전폭 — 메일 본문이 눌리지 않게. 오른쪽 열의 이력·단계는 개요 탭에 있다. */
        <div className="min-w-0">
          {srcKey ? (
            <TicketWorkspace item={item} srcKey={srcKey} now={now} />
          ) : (
            <Empty why="대상 키가 없습니다" hint="워크스페이스는 대상 단위로 기록됩니다." />
          )}
        </div>
      ) : (
      <>
      {/* ── KPI 4칸 ── */}
      <div className="grid grid-cols-4 gap-3.5">
        <Kpi
          name="발견"
          value={num(item.findings)}
          sub={`미조치 ${num(item.openFindings)}`}
        />
        <Kpi
          name="심각"
          value={num(item.critical)}
          color="#7f1d1d"
          sub={`높음 ${num(item.high)}`}
        />
        <Kpi
          name="최초 발견"
          value={firstSeenDays === null ? "—" : num(firstSeenDays)}
          unit={firstSeenDays === null ? undefined : "일 전"}
          sub={asNum(item.firstSeen) === null ? "기록 없음" : stamp(item.firstSeen)}
        />
        <Kpi
          name="스레드"
          value={num(item.threads)}
          sub={attempts === null ? "재시도 기록 없음" : `재시도 ${num(attempts)}회`}
        />
      </div>

      {/* ── 본문 2열 ── */}
      <div className="grid grid-cols-[1fr_360px] items-start gap-3.5">
        {/* 좌: 이 대상에서 찾은 것 · 노출 표면 */}
        <div className="flex min-w-0 flex-col gap-3.5">
        <Card className="px-4 py-3.5">
          <SectionTitle title="이 대상에서 찾은 것" meta={`최근 ${num(item.findings)}건 중`} />
          {findings.isLoading ? (
            <Loading what="발견" />
          ) : findings.isError ? (
            <LoadError what="발견 목록" error={findings.error} />
          ) : !findings.data || findings.data.items.length === 0 ? (
            <Empty
              why="이 대상에서 그릴 발견이 없습니다"
              hint={
                (asNum(item.findings) ?? 0) > 0
                  ? `집계에는 ${num(item.findings)}건이 있는데 목록이 비어 있습니다. 게이트웨이 조회 조건을 확인하세요.`
                  : "이 대상에는 아직 기록된 발견이 없습니다."
              }
            />
          ) : (
            <>
              <div className="grid border-b border-line" style={{ gridTemplateColumns: FINDING_COLS }}>
                <Th>심각도</Th>
                <Th>분류</Th>
                <Th>요약</Th>
                <Th align="right">최근</Th>
              </div>
              <ul>
                {findings.data.items.map((f) => {
                  const sev = lookup(SEV, f.severity);
                  const summary = asStr(f.summary) ?? "요약 없음";
                  const asset = asStr(f.asset);
                  return (
                    <li key={f.id} className="border-b border-line/60">
                      {/* 행 전체가 링크다 — 예전엔 클릭이 안 돼서 증거·pivot·권장조치가
                          화면에서 도달 불가였다(게이트웨이는 6주간 정상 응답 중이었다). */}
                      <Link
                        to={`/findings/${f.id}${srcKey ? `?from=${encodeURIComponent(srcKey)}` : ""}`}
                        className="grid items-center hover:bg-[#fdf9ef]"
                        style={{ gridTemplateColumns: FINDING_COLS }}
                      >
                      <div className="px-3 py-2">
                        <Pill tone={sev}>{sev ? sev.label : (asStr(f.severity) ?? "—")}</Pill>
                      </div>
                      <div className="truncate px-3 py-2 text-[11.5px] text-muted">
                        {asStr(f.category?.label) ?? "미분류"}
                      </div>
                      <div className="min-w-0 px-3 py-2">
                        <div className="text-[13px] leading-snug text-ink">{summary}</div>
                        {asset ? (
                          <div className="truncate font-mono text-[10.5px] text-muted" title={asset}>
                            {asset}
                          </div>
                        ) : null}
                      </div>
                      <div className="px-3 py-2 text-right font-mono text-[11px] tabular-nums text-muted">
                        {ago(f.lastSeen, now)}
                      </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              <div className="flex items-center gap-2 px-3 pt-2">
                <span className="font-mono text-[11px] tabular-nums text-muted">
                  {findings.data.items.length} / {num(findings.data.total)}
                </span>
                {(asNum(findings.data.total) ?? 0) > findings.data.items.length && srcKey ? (
                  <Link
                    to={`/findings?srcKey=${encodeURIComponent(srcKey)}`}
                    className="ml-auto text-[11.5px] text-walnut hover:underline"
                  >
                    전체 보기
                  </Link>
                ) : null}
              </div>
            </>
          )}
        </Card>

        {/* 발견 목록이 "무엇이 걸렸나" 라면 이건 "어디까지 열려 있나" 다.
            ⚠️ 좁은 우열(360px)에 두면 공유 이름이 잘려 아예 안 보인다(처음에 그렇게 했다가
               옮겼다). 경로·공유명은 긴 원문이라 넓은 쪽이 맞다.
            smb 외 도메인에는 이 축이 없어 컴포넌트가 스스로 null 을 돌려준다. */}
        <SmbSurface srcKey={srcKey} domain={asStr(item.domain) ?? ""} />
        </div>

        {/* 우: 보고·발송 이력 · 처리 단계.
            ⚠️ 워크스페이스는 여기 없다 — 360px 에서 메일 본문이 읽히지 않아 상단 탭으로
               옮겼다(2026-08-29). 되돌릴 거면 본문 폭부터 해결할 것. */}
        <div className="flex flex-col gap-3.5">
          <SendTimeline item={item} now={now} />
          <StageCard item={item} />
        </div>
      </div>
      </>
      )}
    </div>
  );
}

// ── 조각들 ───────────────────────────────────────────────────────────────────

/** KPI 한 칸. 큰 숫자는 font-serif tabular-nums. */
function Kpi({
  name, value, unit, sub, color,
}: { name: string; value: string; unit?: string; sub?: string; color?: string }) {
  return (
    <Card className="px-3.5 py-3">
      <div className="text-[11px] text-muted">{name}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span
          className="font-serif text-[27px] leading-none tabular-nums"
          style={{ color: color ?? "#2c2620" }}
        >
          {value}
        </span>
        {unit ? <span className="text-[11.5px] text-muted">{unit}</span> : null}
      </div>
      {sub ? <div className="mt-1.5 font-mono text-[11px] tabular-nums text-muted">{sub}</div> : null}
    </Card>
  );
}

/** 통보 상태 알약. 어휘 밖 값은 원문을 회색으로 그린다(숨기면 상태가 사라진다). */
function ThreadPill({ item }: { item: SourceItem }) {
  const st = asStr(item.threadStatus);
  const threads = asNum(item.threads) ?? 0;
  if (st === null) return <Pill>{threads > 0 ? "상태 미상" : "보고 없음"}</Pill>;
  const meta = lookup(THREAD_STATUS, st);
  return <Pill tone={meta}>{meta ? meta.label : st}</Pill>;
}

/**
 * 담당자 칩.
 * ★ "없음" 과 "못 읽음" 을 구분한다 — ownerLookup="denied" 나 assignee.status="lookup_denied" 는
 *   담당자가 없는 게 아니라 asset_owner 를 읽을 권한이 없는 것이다.
 */
function AssigneeChip({ item, ownerLookup }: { item: SourceItem; ownerLookup: string }) {
  // ★ 담당자를 **바꿀 수 있어야 한다**(2026-09-01). 답장이 다른 사람에게서 오면
  //   담당자가 바뀐 것인데(스레드 37: 심재훈에게 보냈는데 김동희가 답함), 상태 어휘만
  //   있고 바꾸는 길이 없었다 — 사람이 보고도 할 수 있는 게 없었다.
  const [editing, setEditing] = useState(false);
  const status = asStr(item.assignee?.status);
  const denied = ownerLookup === "denied" || status === "lookup_denied";
  // 이름이 없어도 메일이 있으면 그 사람은 존재한다 — knox 대장에 없을 뿐이다(퇴직·이동).
  // "미상" 으로 떨어뜨리면 "담당자 없음" 과 섞여 조치가 멈춘다.
  const email = denied ? null : asStr(item.assignee?.email);
  const name = denied ? null : (asStr(item.assignee?.name) ?? (email ? email.split("@")[0] : null));

  if (!name) {
    const meta = label(ASSIGNEE_STATUS, denied ? "lookup_denied" : (status ?? "unresolved"), {
      label: "미상",
      tone: "muted",
    });
    return (
      <div className="flex items-baseline gap-1.5">
        <span className="text-[11px] text-muted">담당자</span>
        <span
          className="text-[12.5px]"
          style={meta.tone === "warn" ? { color: "#8f2f18" } : { color: "#8a7f6b" }}
        >
          {meta.label || "미상"}
        </span>
      </div>
    );
  }

  const dept = asStr(item.assignee?.dept);
  const title = asStr(item.assignee?.title);
  const sourceLabel = asStr(item.assignee?.sourceLabel);
  // ★ confirmed=false 는 추정이다(조직 저장소의 주 기여자). GHES 에 담당자 개념이 없어
  //   대신 쓰는 값이라, 확정과 같은 모양으로 그리면 추정이 확정으로 위장한다.
  const estimated = item.assignee?.confirmed === false;
  const head = [name, title].filter(Boolean).join(" ");
  return (
    <div className="flex items-center gap-2">
      <span className="grid h-[26px] w-[26px] place-items-center rounded border border-line bg-side font-serif text-[12.5px] text-walnut-ink">
        {name.slice(0, 1)}
      </span>
      <div className="leading-tight">
        <div className="text-[12.5px] text-ink" title={email ?? undefined}>
          {dept ? `${head} · ${dept}` : head}
        </div>
        {sourceLabel ? (
          <div
            className="text-[10.5px]"
            style={estimated ? { color: "#7d5108" } : { color: "#8a7f6b" }}
          >
            {sourceLabel}
          </div>
        ) : null}
        {editing ? (
          <OwnerEditor item={item} onClose={() => setEditing(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="mt-0.5 text-[10.5px] text-muted underline hover:text-walnut-ink"
          >
            담당자 변경
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 담당자 지정 — Knox ID(또는 사내 메일)로 바꾼다.
 *
 * ⚠️ **이름으로 검색하지 않는다.** Knox MCP 의 임직원 도구는 정확 조회만 되고 검색 API 가
 *    없다(2026-09-01 실측: 서버 도구 5개 중 임직원 관련은 조회 하나). 이름 검색을 흉내내면
 *    우리가 이미 아는 723명 안에서만 되는데, 화면은 전사를 찾는 것처럼 보인다.
 * ⚠️ 이름·부서는 **서버가** Knox 에서 조회해 돌려준다. 화면이 보낸 값을 서버가 믿게 하면
 *    담당자 정본이 화면이 된다.
 * ⚠️ 되돌릴 수 있지만 그 사이 나간 메일은 되돌릴 수 없다 — 바뀐 결과를 그대로 보여준다.
 */
function OwnerEditor({ item, onClose }: { item: SourceItem; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<OwnerAssignResult | null>(null);
  const domain = asStr(item.domain) ?? "";
  const threadId = asNum(item.threadId);

  if (done) {
    const owner = done.owner;
    return (
      <div className="mt-1 rounded-md border border-[#2f6b45] bg-[#e4ece4] px-2 py-1.5 text-[11px] text-[#2f6b45]">
        담당자를 <b>{owner.name || owner.email}</b>
        {owner.dept ? ` · ${owner.dept}` : ""} 로 바꿨습니다.
        {done.previous ? <div className="text-[10.5px]">이전: {done.previous}</div> : null}
      </div>
    );
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Knox ID 또는 사내 메일"
        className="w-[190px] rounded border border-line bg-card px-1.5 py-0.5 text-[11.5px]"
      />
      <button
        type="button"
        disabled={busy || !value.trim() || threadId === null}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setDone(await assignOwner(domain, threadId as number, value.trim()));
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
        className="rounded border border-line px-1.5 py-0.5 text-[11px] hover:bg-sel disabled:opacity-50"
      >
        {busy ? "지정 중…" : "지정"}
      </button>
      <button type="button" onClick={onClose} className="text-[11px] text-muted underline">
        취소
      </button>
      {threadId === null ? (
        <span className="text-[10.5px] text-muted">스레드가 없어 지정할 수 없습니다</span>
      ) : null}
      {error ? <div className="w-full text-[10.5px] text-[#8f2f18]">{error}</div> : null}
    </div>
  );
}

/**
 * 보고·발송 이력 — 점+세로선 타임라인 + 3칸 요약.
 *
 * ⚠️⚠️ `firstReportedAt` 은 **통보 시각이 아니다.** 이름이 그렇게 생겼을 뿐이고, 엔진은
 *      스레드를 INSERT 할 때 `now` 를 그대로 넣는다(4도메인 전부). 실측 2026-08-24:
 *
 *          github_report_thread  991건
 *            first_reported_at 있음        991 (100%)
 *            first_reported_at == created_at  991 (100%)   ← 전부 생성 시각
 *            실제 발송(notified_at)           1 (0.1%)
 *
 *      즉 이 값이 있다는 것은 "보고 스레드가 만들어졌다" 지 "담당자에게 나갔다" 가 아니다.
 *      예전엔 이 행을 "최초 통보" 라고 불러서, 1,639개 티켓이 통보된 것처럼 보였다.
 *      실제로 나간 것은 1건이다.
 *
 *      ★ 발송 여부는 **오직** `deliveryView(deliveryEvidence, notifiedAt, threadStatus)` 로만
 *        판정한다. 아래 두 번째 행이 그것이고, 첫 행은 발송과 무관하다.
 */
function SendTimeline({ item, now }: { item: SourceItem; now: number }) {
  const firstReported = asNum(item.firstReportedAt);
  const attempts = asNum(item.attemptCount);
  const elapsed = daysBetween(firstReported, now);
  const delivery = deliveryView(item.deliveryEvidence, item.notifiedAt, item.threadStatus);
  const deliveryTarget = asStr(item.deliveryTarget);

  if (firstReported === null) {
    return (
      <Card className="px-4 py-3.5">
        <SectionTitle title="보고·발송 이력" />
        <Empty
          why="보고 스레드가 없습니다"
          hint="이 대상의 발견은 있지만 아직 보고 대상으로 잡히지 않았습니다 — 따라서 발송도 없습니다"
        />
      </Card>
    );
  }

  const rows: { key: string; name: string; at: number | null; sub: string }[] = [
    {
      // ★ "통보" 가 아니라 "보고 생성" 이다(위 주석 참조). 엔진이 스레드를 만든 시각이고,
      //   메일이 나간 시각은 바로 아래 행이다. 라벨을 다시 "통보" 로 바꾸지 말 것.
      key: "first",
      name: "보고 생성",
      at: firstReported,
      sub: elapsed === null ? "—" : `${num(elapsed)}일 경과 · 발송 여부는 아래`,
    },
    {
      // ★ 발송은 status 가 아니라 사실이다. 근거가 없는 도메인(smb·dev_web)은 시각 자체가
      //   없으므로 "미발송" 이 아니라 "알 수 없음" 으로 그린다.
      key: "notified",
      name: delivery.tone === "sent" ? "발송" : delivery.label,
      at: delivery.tone === "sent" ? asNum(item.notifiedAt) : null,
      sub: delivery.hint
        ?? (attempts === null ? "재시도 기록 없음" : `재시도 ${num(attempts)}회`),
    },
    {
      key: "activity",
      name: "최근 활동",
      at: asNum(item.lastActivityAt),
      sub: ago(item.lastActivityAt, now),
    },
  ];

  const summary: { key: string; name: string; value: string }[] = [
    { key: "threads", name: "스레드", value: num(item.threads) },
    { key: "attempts", name: "재시도", value: attempts === null ? "—" : num(attempts) },
    { key: "elapsed", name: "경과일", value: elapsed === null ? "—" : num(elapsed) },
  ];

  return (
    <Card className="px-4 py-3.5">
      <SectionTitle title="보고·발송 이력" meta={deliveryTarget ? `발송 대상 ${deliveryTarget}` : undefined} />
      <ol className="relative">
        {/* 점을 잇는 세로선. 첫 점 아래에서 마지막 점 위까지만 그린다. */}
        <span className="absolute left-[3px] top-[7px] bottom-[9px] w-px bg-line" aria-hidden />
        {rows.map((r) => (
          <li key={r.key} className="relative pb-3 pl-4 last:pb-0">
            <span
              className="absolute left-0 top-[4px] h-[7px] w-[7px] rounded-full"
              style={{ background: r.at === null ? "#d8cfbb" : "#7a5c3e" }}
              aria-hidden
            />
            <div className="flex items-baseline gap-2">
              <span className="text-[12.5px] text-ink">{r.name}</span>
              <span className="ml-auto font-mono text-[11px] tabular-nums text-muted">
                {r.at === null ? "—" : stamp(r.at)}
              </span>
            </div>
            <div className="mt-0.5 text-[11px] text-muted">{r.at === null ? "기록 없음" : r.sub}</div>
          </li>
        ))}
      </ol>
      <div className="mt-3 grid grid-cols-3 border-t border-line pt-2.5 text-center">
        {summary.map((s, i) => (
          <div key={s.key} className={i > 0 ? "border-l border-line" : undefined}>
            <div className="text-[11px] text-muted">{s.name}</div>
            <div className="font-serif text-[17px] leading-tight tabular-nums text-walnut-ink">
              {s.value}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * 처리 단계 — 발견 → 보고 생성 → 회신 → 재검증.
 *
 * ⚠️ 두 번째 단계는 예전에 **"통보"** 였고 스레드가 하나라도 있으면 `완료` 로 그렸다.
 *    스레드가 있다는 것은 보고가 만들어졌다는 뜻이지 담당자에게 나갔다는 뜻이 아니다 —
 *    실측 2026-08-24: 스레드 1,639건 중 실제 발송(`notified_at`) **1건**.
 *    발송 여부는 옆 카드가 `deliveryEvidence`/`notifiedAt` 근거로만 판정한다.
 */
function StageCard({ item }: { item: SourceItem }) {
  const st = asStr(item.threadStatus) ?? "";
  const threads = asNum(item.threads) ?? 0;
  const statusMeta = lookup(THREAD_STATUS, st);

  const replied = REPLIED_STATES.includes(st);
  const rechecking = RECHECKING_STATES.includes(st);
  const settled = SETTLED_STATES.includes(st);

  const steps: { key: string; name: string; state: StepState; note: string }[] = [
    { key: "found", name: "발견", state: "done", note: `${num(item.findings)}건` },
    {
      // 이름도 상태도 "보고가 만들어졌는가" 까지만 말한다. 발송은 옆 카드가 답한다.
      key: "reported",
      name: "보고 생성",
      state: threads > 0 ? "done" : "wait",
      note: threads > 0 ? `스레드 ${num(threads)}` : "보고 없음",
    },
    {
      key: "reply",
      name: "회신",
      state: replied ? "done" : threads > 0 ? "active" : "wait",
      // 상태 라벨은 고정 어휘에서만. 어휘 밖이면 원문을 그대로(숨기면 상태가 사라진다).
      note: statusMeta ? statusMeta.label : (st || "—"),
    },
    {
      key: "verify",
      name: "재검증",
      state: settled ? "done" : rechecking ? "active" : "wait",
      note: settled ? "종결" : rechecking ? "재확인 중" : "—",
    },
  ];

  return (
    <Card className="px-4 py-3.5">
      <SectionTitle title="처리 단계" />
      <ol className="relative">
        <span className="absolute left-[3px] top-[9px] bottom-[9px] w-px bg-line" aria-hidden />
        {steps.map((s) => (
          <li key={s.key} className="relative flex items-baseline gap-2 py-[5px] pl-4">
            <span
              className="absolute left-0 top-[10px] h-[7px] w-[7px] rounded-full"
              style={{ background: STEP_COLOR[s.state] }}
              aria-hidden
            />
            <span className="text-[12.5px] text-ink">{s.name}</span>
            <span className="ml-auto truncate text-[11px] text-muted">{s.note}</span>
            <span
              className="w-[44px] shrink-0 text-right text-[11px]"
              style={{ color: STEP_COLOR[s.state] }}
            >
              {STEP_STATE_LABEL[s.state]}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
