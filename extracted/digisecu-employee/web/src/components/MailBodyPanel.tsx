/**
 * 발송 요청 본문 패널 — 보고 스레드 화면과 티켓 상세가 **같은 것**을 그린다.
 *
 * 원래 `pages/SendHistory.tsx` 안에 있었다. 티켓 상세에서도 같은 본문을 봐야 하는데
 * (사용자 요구 2026-08-27: "메일 발송이력도 같이 남아야할거 아냐") 두 벌로 만들면
 * 한쪽만 고쳐진다 — "발송 요청 본문" 이라는 라벨의 정직성이 그런 식으로 무너진다.
 *
 * 티켓 상세가 이걸 못 불렀던 이유는 화면이 아니라 계약이었다: `SourceItem` 에
 * `threadId` 가 없어서 되물을 키가 없었다(2026-08-27 에 추가). 본문 라우트
 * `/gw/reports/{key}/{id}/body` 는 그 전에도 정상 응답 중이었다.
 */
import { useState } from "react";
import type { MailSendResult } from "@digisecu/contracts";
import { Empty, LoadError, Loading } from "./ui";
import { asArr, asStr, label, stamp } from "../lib/guards";
import { requestAndSendMail } from "../lib/api";
import { useMailBody } from "../lib/queries";

/**
 * 발송 요청 본문 — ★ **"발송본" 이 아니다.**
 *
 * 저장값은 워커가 `deliver()` 에 넘긴 payload 라 egress 마스킹 **이전**이고, 실제로 나간
 * 본문은 DB 어디에도 없다(2026-08-24 확인). 게이트웨이가 읽기 시점에 `redact()` 를 다시
 * 걸어 주므로 여기 보이는 값은 실제 나간 메일보다 **더** 가려져 있다.
 * 라벨을 "발송본" 으로 쓰면 1,639 대 1 사건과 같은 종류의 거짓말이 된다.
 *
 * ⚠️ HTML 은 **sandbox iframe** 에만 넣는다. 본문에는 스캔 대상에서 온 문자열(파일 경로·
 *    페이지 제목)이 들어가므로 콘솔 DOM 에 직접 주입하면 저장형 XSS 통로다.
 *    구조 검사상 지금은 깨끗하지만(github 36건 script/이벤트핸들러/javascript: 전부 0),
 *    그건 지금 얘기지 다음 스캔 결과가 그럴 거라는 뜻이 아니다.
 *    `sandbox=""` = 스크립트·폼·팝업·same-origin 전부 차단.
 */
/**
 * 본문 상태 배지.
 *
 * ⚠️ `unknown` 은 "안 나갔다" 가 아니라 **못 판정한다** 는 뜻이다. github·confluence·
 *    dev_web 본문은 리포트 생성 시점 산출물이라 발송 여부와 무관하고, 그 셋은 항상
 *    unknown 이다(정상). 여기서 "미발송" 이라고 쓰면 79건을 없는 사고로 만든다.
 */
type StateBadge = { label: string; bg: string; fg: string; hint: string };

/** 어휘 밖 값이 오면 여기로 떨어진다 — 화면이 비지 않게. */
const BADGE_FALLBACK: StateBadge = {
  label: "발송 요청 본문 · 마스킹 적용", bg: "#efe8d8", fg: "#8a7f6b",
  hint: "이 본문으로 발송 여부를 판정할 수 없습니다 — 리포트 생성 시점 산출물입니다. "
    + "발송 여부는 티켓의 발송 이력이 근거와 함께 답합니다.",
};

const STATE_BADGE: Record<string, StateBadge> = {
  unknown: BADGE_FALLBACK,
  sent: {
    label: "발송된 본문 · 마스킹 적용", bg: "#e4ece4", fg: "#2f6b45",
    hint: "실제로 나간 메일입니다. 저장값은 마스킹 이전이라 화면 값이 더 가려져 있습니다.",
  },
  draft: {
    label: "발송 전 초안 · 마스킹 적용", bg: "#f6efe2", fg: "#8a5c10",
    hint: "본문은 만들어졌지만 나가지 않았습니다. 옆 사유가 게이트가 막은 이유입니다.",
  },
};

export function MailBodyPanel({ domain, threadId }: { domain: string; threadId: number }) {
  const q = useMailBody(domain, threadId);

  if (q.isLoading) {
    return (
      <div className="border-t border-line/60 px-3 py-3">
        <Loading what="본문" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="border-t border-line/60 px-3 py-3">
        <LoadError what="본문" error={q.error} />
      </div>
    );
  }

  const b = q.data;
  const body = asStr(b.body);

  if (asStr(b.access) === "denied") {
    return (
      <div className="border-t border-line/60 px-3 py-3">
        <Empty
          why="본문을 읽을 권한이 없습니다"
          hint="본문이 없다는 뜻이 아닙니다 — gateway/sql/007 을 적용하면 보입니다."
        />
      </div>
    );
  }
  if (!body) {
    return (
      <div className="border-t border-line/60 px-3 py-3">
        <Empty
          why="이 스레드에는 저장된 본문이 없습니다"
          hint={
            asStr(b.domain) === "smb"
              // 2026-08-27 이전 smb 스레드는 실제로 나간 것만 본문을 남겼다.
              ? "이 스레드는 본문을 남기기 전에 만들어졌습니다 — 다음 조치요청 패스에서 초안이 기록됩니다."
              : "보고가 만들어졌지만 본문이 기록되지 않았습니다."
          }
        />
      </div>
    );
  }

  const badge = label(STATE_BADGE, b.state, BADGE_FALLBACK);
  const detail = asStr(b.stateDetail);

  return (
    <div className="border-t border-line/60 bg-side px-3 py-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11.5px]">
        {/* ★ 초안을 "발송됨" 으로 그리지 않는다. 라벨이 사실을 말한다. */}
        <span
          className="rounded px-1.5 py-0.5 text-[10.5px]"
          style={{ background: badge.bg, color: badge.fg }}
          title={badge.hint}
        >
          {badge.label}
          {detail ? ` · ${detail}` : ""}
        </span>
        <span className="text-muted">실제 나간 메일과 다를 수 있습니다(더 가려져 있습니다)</span>
        {b.mailTo ? <span className="font-mono text-walnut-ink">→ {b.mailTo}</span> : null}
        {b.mailCc ? <span className="font-mono text-muted">cc {b.mailCc}</span> : null}
        {b.sentAt ? <span className="ml-auto font-mono text-muted">{stamp(b.sentAt)}</span> : null}
      </div>

      {b.isHtml ? (
        <iframe
          title={`발송 요청 본문 ${threadId}`}
          sandbox=""
          srcDoc={body}
          className="h-[420px] w-full rounded-md border border-line bg-card"
        />
      ) : (
        <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-card px-3 py-2 font-mono text-[11px] leading-relaxed">
          {body}
        </pre>
      )}

      {b.truncated ? (
        <p className="mt-1.5 font-mono text-[10.5px] text-muted">
          본문이 길어 잘렸습니다 — 화면에 없는 부분이 있습니다.
        </p>
      ) : null}

      <SendButton domain={domain} threadId={threadId} />
    </div>
  );
}

/**
 * 발송 버튼 — ★ **되돌릴 수 없다.** 메일은 회수 경로가 없다.
 *
 * ## 이 버튼이 하는 일
 *
 *   요청(승인 대기 생성) → 승인(실행) → 파이썬 CLI → `deliver()`
 *
 * 게이트(허용목록·redact 스캔·자율발송 opt-in)는 전부 `deliver()` 안에 있다.
 * **여기서 게이트를 다시 구현하지 않는다** — 화면이 판정하면 서버와 갈린다.
 *
 * ## 화면이 지켜야 하는 것
 *
 * 1. **되돌릴 수 없다는 것을 말한다.** 한 번 확인을 받는다.
 * 2. **차단은 실패가 아니다.** `mode="dry_run"` 이면 사유를 그대로 보여준다 —
 *    운영자가 "고장" 과 "정책상 안 나감" 을 가를 수 있어야 한다.
 * 3. **보낸 것처럼 그리지 않는다.** 오늘 고친 1,639 대 1 과 같은 거짓말을 여기서 만들지 않는다.
 */
function SendButton({ domain, threadId }: { domain: string; threadId: number }) {
  const [state, setState] = useState<"idle" | "confirm" | "sending">("idle");
  const [result, setResult] = useState<MailSendResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setState("sending");
    setError(null);
    try {
      setResult(await requestAndSendMail(domain, threadId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setState("idle");
    }
  }

  if (result) {
    const sent = result.mode === "sent";
    return (
      <div
        className="mt-2.5 rounded-md border px-2.5 py-2 text-[11.5px]"
        style={
          sent
            ? { borderColor: "#2f6b45", background: "#e4ece4", color: "#2f6b45" }
            : { borderColor: "#e0cfa8", background: "#f6efe2", color: "#8a5c10" }
        }
      >
        <div className="font-medium">
          {sent ? "발송됨" : "발송되지 않았습니다 — 게이트가 막았습니다"}
        </div>
        {/* ★ 차단 사유를 숨기면 안 눌린 건지 막힌 건지 모른다. */}
        {asArr<string>(result.reasons).map((r, i) => (
          <div key={i} className="mt-0.5 font-mono text-[10.5px]">· {r}</div>
        ))}
        {asArr<string>(result.recipients).length > 0 ? (
          <div className="mt-1 font-mono text-[10.5px]">
            수신 대상: {asArr<string>(result.recipients).join(", ")}
          </div>
        ) : null}
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-2.5 rounded-md border border-[#8f2f18] bg-[#f0d9d1] px-2.5 py-2 text-[11.5px] text-[#8f2f18]">
        발송을 시작하지 못했습니다 — {error}
        <button
          type="button"
          onClick={() => setError(null)}
          className="ml-2 underline"
        >
          닫기
        </button>
      </div>
    );
  }

  if (state === "confirm") {
    return (
      <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-md border border-[#e0cfa8] bg-[#f6efe2] px-2.5 py-2 text-[11.5px] text-[#8a5c10]">
        <span>
          <b>담당자에게 실제로 메일이 나갑니다.</b> 보낸 메일은 되돌릴 수 없습니다.
        </span>
        <button
          type="button"
          onClick={go}
          className="rounded border border-[#8f2f18] px-2 py-0.5 text-[#8f2f18] hover:bg-[#f0d9d1]"
        >
          발송
        </button>
        <button type="button" onClick={() => setState("idle")} className="text-muted underline">
          취소
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={state === "sending"}
      onClick={() => setState("confirm")}
      className="mt-2.5 rounded-md border border-line px-2.5 py-1 text-[11.5px] text-walnut-ink hover:bg-sel disabled:opacity-50"
    >
      {state === "sending" ? "발송 중…" : "발송 요청"}
    </button>
  );
}
