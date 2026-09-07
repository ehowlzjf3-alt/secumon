/**
 * 티켓 워크스페이스 — 사람이 손을 대는 자리.
 *
 * 나머지 화면은 전부 **읽기**다(게이트웨이는 라우트가 전부 GET 이다). 이 카드만 쓴다.
 * 세 가지를 한 자리에 둔다:
 *
 *   ① HITL      에이전트 흐름이 멈춘 지점 — 파생값이다. 새로 저장하지 않는다.
 *   ② 진행사항  담당자가 적는 상태 + append-only 코멘트 (control-plane)
 *   ③ 발송 본문 담당자에게 나갈/나간 메일 (게이트웨이 읽기)
 *
 * ## 왜 한 카드인가
 *
 * 셋이 같은 질문의 세 면이다 — "이거 지금 누가 뭘 해야 하나". 흩어 놓으면 운영자가
 * HITL 배지를 보고 다른 화면으로 가서 코멘트를 적고 또 다른 화면에서 본문을 확인한다.
 *
 * ## ⚠️ 저장 위치가 둘이다
 *
 *   ①③ 은 게이트웨이(threat_hunter DB, 읽기전용 롤)
 *   ②   는 control-plane(제품 DB, 쓰기)
 *
 * 그래서 ② 는 파이프라인이 모른다 — 운영자 메모지 에이전트 지시가 아니다.
 * 화면이 그렇게 말해야 한다. 여기 적은 것이 워커를 움직인다고 읽히면 안 된다.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import type {
  AuditRecord, SourceItem, TicketStatus, TriageRecord,
} from "@digisecu/contracts";
import {
  TICKET_STATUS_DRIVES_PIPELINE, TICKET_STATUS_LABEL, TICKET_STATUS_ORDER,
  auditActionMeta, ticketStatusOf, triageRefForTicket,
} from "@digisecu/contracts";
import { Card, Empty, LoadError, Loading, SectionTitle } from "./ui";
import { MailBodyPanel } from "./MailBodyPanel";
import { asArr, asNum, asStr, stamp } from "../lib/guards";
import { HITL_TONE, hitlView } from "../lib/soarMeta";
import { useAuditLog } from "../lib/queries";
import { useAddTriageNote, useSetTicketStatus, useTriageBatch } from "../lib/queries";

// ★ 목록 칩(`THREAD_STATUS`)과 **같은 색**을 쓴다. 같은 상태가 화면마다 다른 색이면
//   운영자가 둘을 다른 것으로 읽는다.
const TICKET_TONE: Record<TicketStatus, { fg: string; bg: string }> = {
  ready: { fg: "#a3520a", bg: "#fde3c6" },
  awaiting: { fg: "#7d5108", bg: "#fbf3d4" },
  replied: { fg: "#245b8f", bg: "#dfeaf6" },
  closed: { fg: "#496b52", bg: "#e6ece6" },
};

export function TicketWorkspace({
  item, srcKey, now,
}: { item: SourceItem; srcKey: string; now: number }) {
  const ref = triageRefForTicket(srcKey);
  const triage = useTriageBatch([ref]);
  const record = asArr<TriageRecord>(triage.data?.items).find((r) => r.findingRef === ref);
  const hitl = hitlView(item, now);
  const threadId = asNum(item.threadId);
  const domain = asStr(item.domain) ?? "";

  return (
    <Card className="px-4 py-3.5">
      <SectionTitle title="워크스페이스" meta="운영자 기록 · 파이프라인과 별개" />

      {/* ── ① HITL ── */}
      <div
        className="mt-1 rounded-md px-3 py-2"
        style={{ background: HITL_TONE[hitl.tone].bg, color: HITL_TONE[hitl.tone].fg }}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-[12.5px] font-medium">{hitl.label}</span>
          <span className="ml-auto font-mono text-[10.5px] opacity-70">
            {hitl.state === "none" ? "자동 진행 중" : "사람 차례"}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] opacity-90">{hitl.hint}</div>
      </div>

      {/* ── ② 진행사항 ── */}
      <div className="mt-3 border-t border-line pt-3">
        {triage.isLoading ? (
          <Loading what="진행사항" />
        ) : triage.isError ? (
          <LoadError what="진행사항" error={triage.error} />
        ) : (
          <TriagePanel
            refKey={ref}
            record={record}
            domain={domain}
            threadId={threadId}
            threadStatus={asStr(item.threadStatus) ?? null}
          />
        )}
      </div>

      {/* ── ③ 운영자 조치 이력 ── */}
      <OperatorTrail domain={domain} threadId={threadId} />

      {/* ── ④ 발송 본문 ── */}
      <div className="mt-3 border-t border-line pt-2.5">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-[11.5px] text-ink">메일 본문</span>
          {threadId !== null ? (
            <span className="font-mono text-[10.5px] text-muted">
              스레드 #{threadId}
              {(asNum(item.threads) ?? 0) > 1
                // ★ 한 대상에 스레드가 여럿이다(주차마다 새로 열린다). "이 티켓의 본문" 이
                //   아니라 가장 최근 것이라는 사실을 화면이 말한다.
                ? ` · 최근 1건 (전체 ${asNum(item.threads)}건)`
                : ""}
            </span>
          ) : null}
        </div>
        {threadId === null || !domain ? (
          <Empty
            why="아직 보고 스레드가 없습니다"
            hint="보고가 만들어져야 담당자에게 나갈 본문이 생깁니다."
          />
        ) : (
          <>
            <MailBodyPanel domain={domain} threadId={threadId} />
            {(asNum(item.threads) ?? 0) > 1 ? (
              // ⚠️ 나머지 스레드를 여기 나열하지 않는다 — src 축으로 스레드를 주는
              //    엔드포인트가 없어서, 화면에서 걸러 그리면 목록 limit 에 잘린 것을
              //    "전부" 로 보여주게 된다. 있는 곳으로 보낸다.
              <Link
                to={`/reports?domain=${encodeURIComponent(domain)}`}
                className="mt-2 inline-block text-[11.5px] text-walnut hover:underline"
              >
                이 도메인의 보고 스레드 전체 보기 →
              </Link>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * 진행사항 — **티켓 상태**(목록 필터와 같은 어휘) + append-only 코멘트.
 *
 * ## 왜 트리아지가 아니라 티켓 상태인가 (2026-09-01 사용자 결정)
 *
 * 예전엔 여기서 `finding_triage`(제품 DB 오버레이)를 썼다. 그건 **파이프라인이 모르는
 * 축**이라 눌러도 티켓은 안 움직였다 — 실측: 스레드 129 를 `resolved` 로 다섯 번 눌렀는데
 * smb 상태는 계속 `awaiting_reply` 였고 목록 필터에도 안 잡혔다.
 * 지금은 목록 필터와 **같은 어휘**를 쓰고, 누르면 도메인 스레드 상태가 실제로 바뀐다.
 *
 * ⚠️ 상태의 정본은 게이트웨이(`item.threadStatus`)다 — 여기 지역 상태로 들고 있지 않는다.
 *    누르면 sources 를 무효화해 다시 읽는다. 그래야 파이프라인이 그사이 옮긴 값과 안 싸운다.
 * ⚠️ 코멘트는 그대로 제품 DB(트리아지)다. 그건 운영자 메모지 파이프라인 지시가 아니다.
 */
function TriagePanel({
  refKey, record, domain, threadId, threadStatus,
}: {
  refKey: string; record?: TriageRecord;
  domain: string; threadId: number | null; threadStatus: string | null;
}) {
  const setStatus = useSetTicketStatus();
  const addNote = useAddTriageNote();
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // 현재 칸 — native status 를 필터 어휘로 접는다. 모르면 null 이고 어느 칸도 안 켠다
  // (draft·reverifying 처럼 사람이 고를 수 없는 상태가 그렇다 — 아무 칸으로 접지 않는다).
  const status = ticketStatusOf(threadStatus);
  const notes = asArr<TriageRecord["notes"][number]>(record?.notes);
  const canEdit = threadId !== null && !!domain;

  async function pick(next: TicketStatus) {
    if (next === status || !canEdit || threadId === null) return;
    const warn = TICKET_STATUS_DRIVES_PIPELINE[next];
    // ★ 되돌릴 수 없는 것만 되묻는다. 전부 되물으면 아무도 안 읽는다.
    if (warn && !window.confirm(`${TICKET_STATUS_LABEL[next]} 로 바꿉니다.\n\n${warn}\n\n계속할까요?`)) return;
    setErr(null);
    try {
      await setStatus.mutateAsync({ domain, threadId, status: next });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function submit() {
    const body = draft.trim();
    if (!body) return;
    setErr(null);
    try {
      await addNote.mutateAsync({ findingRef: refKey, body });
      setDraft("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[11.5px] text-ink">티켓 상태</span>
        {/* ★ native 값을 그대로 보여준다 — 접힌 칸과 실제 값이 다를 수 있고(draft·reverifying),
            그때 운영자가 "왜 아무 칸도 안 켜졌지" 를 스스로 풀 수 있어야 한다. */}
        <span className="ml-auto font-mono text-[10.5px] text-muted">
          {threadStatus ?? "스레드 없음"}
        </span>
      </div>

      <div className="flex flex-wrap gap-1">
        {TICKET_STATUS_ORDER.map((s) => {
          const on = s === status;
          const tone = TICKET_TONE[s];
          return (
            <button
              key={s}
              type="button"
              disabled={setStatus.isPending || !canEdit}
              onClick={() => void pick(s)}
              title={TICKET_STATUS_DRIVES_PIPELINE[s] ?? undefined}
              className="rounded border px-2 py-0.5 text-[11px] disabled:opacity-50"
              style={on
                ? { borderColor: tone.fg, background: tone.bg, color: tone.fg }
                : { borderColor: "#e4ddcd", color: "#8a7f6b" }}
            >
              {TICKET_STATUS_LABEL[s]}
              {TICKET_STATUS_DRIVES_PIPELINE[s] ? " ·" : ""}
            </button>
          );
        })}
      </div>
      {!canEdit ? (
        <p className="mt-1 text-[10.5px] text-muted">스레드가 없어 상태를 바꿀 수 없습니다.</p>
      ) : null}

      {err ? (
        <div className="mt-1.5 rounded border border-[#e0cfa8] bg-[#f6efe2] px-2 py-1 text-[11px] text-[#8a5c10]">
          {err}
        </div>
      ) : null}

      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-[11.5px] text-ink">담당자 진행사항</span>
        <span className="ml-auto text-[10.5px] text-muted">
          {record?.updatedAt ? `${asStr(record.updatedBy) ?? "?"} · ${record.updatedAt.slice(0, 16).replace("T", " ")}` : "기록 없음"}
        </span>
      </div>

      <div className="mt-1 flex gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          maxLength={2000}
          placeholder="진행사항을 적습니다 (지울 수 없습니다)"
          className="min-w-0 flex-1 rounded border border-line bg-card px-2 py-1 text-[11.5px] outline-none focus:border-walnut"
        />
        <button
          type="button"
          disabled={addNote.isPending || !draft.trim()}
          onClick={() => void submit()}
          className="shrink-0 rounded border border-line px-2 py-1 text-[11.5px] text-walnut-ink hover:bg-sel disabled:opacity-40"
        >
          기록
        </button>
      </div>

      {notes.length === 0 ? (
        <p className="mt-2 text-[11px] text-muted">아직 기록이 없습니다.</p>
      ) : (
        <ol className="mt-2 flex flex-col gap-1.5">
          {notes.map((n) => (
            <li key={n.id} className="rounded border border-line/60 bg-side px-2 py-1.5">
              <div className="flex items-baseline gap-2 text-[10.5px] text-muted">
                <span className="font-mono">{asStr(n.actor) ?? "?"}</span>
                <span className="ml-auto font-mono">{stampIso(n.at)}</span>
              </div>
              <div className="mt-0.5 whitespace-pre-wrap break-words text-[11.5px] text-ink">
                {asStr(n.body)}
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2 text-[10.5px] text-muted">
        {/* ★ 저장 위치가 다르다는 사실을 숨기지 않는다. 여기 적은 것은 워커를 움직이지 않는다. */}
        이 기록은 운영 콘솔에만 남습니다 — 에이전트는 읽지 않습니다.
      </p>
    </div>
  );
}


/**
 * 운영자 조치 이력 — 이 티켓에 **사람이** 한 일.
 *
 * ⚠️ 파이프라인 이력(보고·발송)과 **다른 축**이다. 그건 오른쪽 타임라인이 그린다.
 *    여기는 담당자 지정처럼 사람이 개입한 것만 — 섞으면 "자동으로 된 것" 과
 *    "사람이 바꾼 것" 이 같은 줄에 보인다.
 *
 * ★ 2026-09-01 사용자 요청("담당자 변경된거는 웤스페이스에 기록도 남아야지").
 *   그전까지 담당자를 바꿔도 남는 곳이 control-plane 감사로그뿐이었고, 콘솔은 그걸
 *   티켓 단위로 볼 방법이 없었다(감사 조회에 스레드 필터가 없었다).
 */
function OperatorTrail({ domain, threadId }: { domain: string; threadId: number | null }) {
  const q = useAuditLog(
    domain && threadId !== null ? { domain, threadId, limit: 20 } : {},
  );
  if (!domain || threadId === null) return null;

  // ⚠️ 응답 필드는 `events` 다(`items` 가 아니다) — 트리아지 배치와 이름이 다르다.
  const items = asArr<AuditRecord>(q.data?.events);
  return (
    <div className="mt-3 border-t border-line pt-2.5">
      <div className="mb-1 text-[11.5px] text-ink">운영자 조치</div>
      {q.isLoading ? (
        <div className="text-[11px] text-muted">불러오는 중…</div>
      ) : items.length === 0 ? (
        // ★ "없음" 을 분명히 말한다 — 빈 칸은 못 읽은 것과 구분되지 않는다.
        <div className="text-[11px] text-muted">사람이 개입한 기록이 없습니다.</div>
      ) : (
        <ul className="space-y-0.5">
          {items.map((e) => {
            const meta = auditActionMeta(asStr(e.action) ?? "");
            return (
              <li key={asStr(e.id) ?? Math.random()} className="text-[11px] leading-snug">
                <span className="font-mono text-[10.5px] text-muted">{stampIso(e.ts)}</span>{" "}
                <span className="text-ink">{meta.label}</span>
                {asStr(e.summary) ? (
                  <span className="text-muted"> · {asStr(e.summary)}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** control-plane 은 ISO 문자열을 준다(게이트웨이의 epoch 초와 다르다). */
function stampIso(iso: unknown): string {
  const s = asStr(iso);
  if (!s) return "—";
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : stamp(t / 1000);
}
