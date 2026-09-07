/**
 * SOAR 콘솔 고정 어휘 — 라벨·색·설명.
 *
 * 전부 **클라이언트 하드코딩**이다. 서버 문자열을 그대로 그리지 않는 이유는
 * `FindingsSectionView` 의 고정 문구 정책과 같다 — 서버가 문구를 위조할 수 없어야 한다.
 * 어휘 밖 값이 오면 그리지 않거나 "알 수 없음" 으로 떨어뜨린다(guards.lookup).
 */

// ── 도메인 ───────────────────────────────────────────────────────────────────
// 제목으로 쓸 때는 대문자 표기(GitHub/SMB/Dev Web/Confluence). 경로·식별자 원문은 소문자 그대로.
export const DOMAINS = ["smb", "dev_web", "github", "confluence"] as const;
export type Domain = (typeof DOMAINS)[number];

export const DOMAIN_LABEL: Record<string, string> = {
  smb: "SMB",
  dev_web: "Dev Web",
  github: "GitHub",
  confluence: "Confluence",
};

export const DOMAIN_COLOR: Record<string, string> = {
  smb: "#7a5c3e",
  dev_web: "#5e6e4a",
  github: "#6b5563",
  confluence: "#4f6472",
};

export const DOMAIN_TINT: Record<string, string> = {
  smb: "#f4ece2",
  dev_web: "#eef1e8",
  github: "#f1edf0",
  confluence: "#ecf0f2",
};

/** src 가 무엇인지 — 열 제목/빈 상태 문구에 쓴다. */
export const SRC_KIND_LABEL: Record<string, string> = {
  host: "호스트",
  repo: "저장소",
  domain: "웹 도메인",
  space: "스페이스",
};

// ── 심각도 ───────────────────────────────────────────────────────────────────
// ⚠️ critical 을 high 로 접던 사고 이력이 있다(gateway-adapt.toSeverity 주석). 4단계를 유지한다.
export const SEV_ORDER = ["critical", "high", "medium", "low", "informational"] as const;

export const SEV: Record<string, { label: string; bg: string; fg: string }> = {
  critical: { label: "심각", bg: "#7f1d1d", fg: "#fee2e2" },
  high: { label: "높음", bg: "#f0d9d1", fg: "#8f2f18" },
  medium: { label: "중간", bg: "#f1e7d0", fg: "#7d5108" },
  low: { label: "낮음", bg: "#e8ecdb", fg: "#4f5f3a" },
  informational: { label: "정보", bg: "#efe8d8", fg: "#8a7f6b" },
  info: { label: "정보", bg: "#efe8d8", fg: "#8a7f6b" },
};

// ── 통보(리포트 스레드) 상태 ─────────────────────────────────────────────────
// 게이트웨이는 엔진 status 를 **그대로** 낸다(손실압축 금지 — 구 STATUS_MAP 이 false_positive 와
// remediated 를 같은 칸으로 접던 문제). 여기서 표시 라벨만 붙이고, 어휘 밖은 원문을 그린다.
export const THREAD_STATUS: Record<string, { label: string; bg: string; fg: string }> = {
  // ★ 색은 **단계**를 말한다(사용자 요청 2026-09-01 "상태값은 색구분이 가능하면 좋겠어").
  //   예전엔 6개 상태가 같은 모래색이라 목록에서 구분이 안 됐다.
  //
  //     회갈  아직 우리 차례가 아니다        초안 · 예외 검토 · 오탐
  //     올리브 보고를 만들었다               보고 생성 · 일부 조치
  //     주황  ★ 사람이 눌러야 한다           발송 대기   ← 여기서 수동 발송한다
  //     모래  상대를 기다린다                회신 대기
  //     파랑  새 입력이 왔다                 회신 옴
  //     청록  다시 확인하는 중               재요청 · 재확인 요청 · 재확인 중
  //     초록  끝났다                        조치 완료 · 종결
  //     빨강  올렸다                        상신

  // ★ "준비"(draft)와 "보고 준비됨"(report_ready)이 같은 말로 읽히던 것도 여기서 갈랐다.
  //   초안      스레드는 있고 아직 보고 큐 밖이다
  //   발송 대기  본문까지 다 만들었고 게이트가 발송만 잡고 있다
  draft: { label: "초안", bg: "#eeeae2", fg: "#8a7f6b" },
  // ★ "발송됨" 이 아니다. 이 status 는 **보고서가 만들어졌다**는 뜻이고 발송과 무관하다 —
  //   라이브 467건 전부 notified_at 이 비어 있는데 화면은 "발송됨" 으로 그리고 있었다.
  //   실제 발송 여부는 DELIVERY 가 notifiedAt + deliveryEvidence 로 따로 그린다.
  reported: { label: "보고 생성", bg: "#e9eee0", fg: "#4f5f3a" },
  report_ready: { label: "발송 대기", bg: "#fde3c6", fg: "#a3520a" },
  awaiting_reply: { label: "회신 대기", bg: "#fbf3d4", fg: "#7d5108" },
  awaiting_owner: { label: "회신 대기", bg: "#fbf3d4", fg: "#7d5108" },
  reply_received: { label: "회신 옴", bg: "#dfeaf6", fg: "#245b8f" },
  re_requested: { label: "재요청", bg: "#e2eef0", fg: "#2a5f66" },
  recheck_requested: { label: "재확인 요청", bg: "#e2eef0", fg: "#2a5f66" },
  rechecking: { label: "재확인 중", bg: "#d6e8ec", fg: "#22545c" },
  remediated: { label: "조치 완료", bg: "#dfefe3", fg: "#2f6b45" },
  partially_remediated: { label: "일부 조치", bg: "#eef0d8", fg: "#5f6420" },
  escalated: { label: "상신", bg: "#f6e0da", fg: "#8f2f18" },
  exception_review: { label: "예외 검토", bg: "#ece8e0", fg: "#7a7264" },
  closed: { label: "종결", bg: "#e6ece6", fg: "#496b52" },
  resolved: { label: "종결", bg: "#e6ece6", fg: "#496b52" },
  false_positive: { label: "오탐", bg: "#e9e8e5", fg: "#74736e" },
};

/**
 * 발송 표시 — **status 가 아니라 사실로** 그린다.
 *
 * 근거가 도메인마다 다르다는 게 핵심이다. github·confluence 는 `notified_at` 컬럼이 있어
 * 발송 시각이 남지만, smb·dev_web 은 컬럼 자체가 없다(`mail_message` 는 게이트웨이 권한 밖).
 * 그래서 `notifiedAt=null` 의 뜻이 갈린다 —
 *   evidence="timestamp"   → 컬럼이 있는데 비었다 = **안 나갔다**(사실)
 *   evidence="status_only" → 컬럼이 없다        = **알 수 없다**
 * 이 구분 없이 그리면 smb 231건이 "전부 미발송" 으로 단정된다.
 */
export type DeliveryView = { label: string; tone: "sent" | "unsent" | "unknown"; hint?: string };

/**
 * 발송이 **이미 일어났어야** 성립하는 status. 회신을 기다린다는 건 나갔다는 뜻이다.
 * 근거 컬럼이 없는 도메인에서 "발송 기록 없음" 만 쓰면 `회신 대기` 옆에서 모순처럼 읽힌다 —
 * 상태가 발송을 함의하면 그렇다고 말하되, **근거가 status 라는 것**을 함께 밝힌다.
 */
const POST_SEND_STATUSES = new Set([
  "awaiting_reply", "awaiting_owner", "reply_received", "re_requested",
  "recheck_requested", "rechecking", "still_open", "partially_remediated",
  "remediated", "escalated", "exception_review", "closed", "resolved",
]);

export function deliveryView(
  evidence: unknown,
  notifiedAt: unknown,
  status?: unknown,
): DeliveryView {
  const at = typeof notifiedAt === "number" && Number.isFinite(notifiedAt) ? notifiedAt : null;
  if (evidence !== "timestamp") {
    const st = typeof status === "string" ? status : "";
    if (POST_SEND_STATUSES.has(st)) {
      return {
        label: "상태상 발송",
        tone: "unknown",
        hint: "발송 시각 기록이 없는 도메인입니다 — 상태(회신 대기 등)로 미루어 나간 것으로 봅니다.",
      };
    }
    return {
      label: "발송 기록 없음",
      tone: "unknown",
      hint: "이 도메인은 발송 시각을 남기지 않습니다 — 나갔는지 알 수 없습니다.",
    };
  }
  if (at === null) {
    return { label: "미발송", tone: "unsent", hint: "발송 시각 컬럼이 비어 있습니다." };
  }
  return { label: "발송", tone: "sent" };
}

export const DELIVERY_TONE: Record<DeliveryView["tone"], { fg: string; bg: string }> = {
  sent: { fg: "#2f6b45", bg: "#e4ece4" },
  unsent: { fg: "#8a7f6b", bg: "#efe8d8" },
  unknown: { fg: "#9a9a94", bg: "transparent" },
};

/** 보고 스레드 상태 필터 — 게이트웨이 `threadState` 어휘와 1:1.
 *
 * ⚠️ 예전엔 `none`="미통보" · `reported`="통보함" 이었다. 둘 다 **스레드 유무**를 말하는
 *    값인데 발송을 말하는 것처럼 읽혔다. 실측 2026-08-24: 스레드 1,639건 중 실제 발송
 *    (`notified_at`) 1건. 발송 여부는 `deliveryEvidence`/`notifiedAt` 만 답한다. */
export const THREAD_STATE_FILTER = [
  { key: "none", label: "보고 없음" },
  { key: "reported", label: "보고 생성" },
  // ★ 운영자가 실제로 클릭하는 칸 — 여기서 수동 발송한다(2026-09-01 사용자 요청).
  //   칩이 없으면 목록에서 눈으로 찾아야 했다.
  { key: "ready", label: "발송 대기" },
  { key: "awaiting", label: "회신 대기" },
  { key: "replied", label: "회신 옴" },
  { key: "closed", label: "종결" },
] as const;

// ── 담당자 ───────────────────────────────────────────────────────────────────
// ★ "없음" 과 "못 읽음" 을 구분한다. asset_owner GRANT(sql/004)가 없으면 조용히 전원 미배정으로
//   보이던 것이 선존 버그였다 — 게이트웨이가 lookup_denied 로 알려주면 그대로 드러낸다.
export const ASSIGNEE_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "muted" }> = {
  resolved: { label: "", tone: "ok" },
  unresolved: { label: "미매칭", tone: "muted" },
  dssoc_only: { label: "담당자 없음", tone: "muted" },
  lookup_denied: { label: "권한 없음", tone: "warn" },
};

// ── 조치 완료의 근거 ─────────────────────────────────────────────────────────
// ★ 도메인마다 다르다. 같은 열에 다른 뜻의 숫자를 넣고 침묵하면 거짓말이 된다.
export const REMEDIATION_BASIS: Record<string, { short: string; full: string }> = {
  verification_gone: {
    short: "재스캔 소실",
    full: "다시 스캔했을 때 대상에서 사라진 발견 수. 조치됐거나 파일이 지워진 것.",
  },
  reverify_now_closed: {
    short: "재검증 확인",
    full: "회신을 받고 다시 점검해 실제로 닫힌 것이 확인된 발견 수.",
  },
  none: {
    short: "측정 불가",
    full: "이 도메인은 조치를 확인할 근거 테이블을 읽을 수 없다(권한 또는 데이터 부재).",
  },
};

// ── 검증(HEAD 잔존 여부) ─────────────────────────────────────────────────────
export const VERIFICATION: Record<string, { label: string; bg: string; fg: string }> = {
  live_in_HEAD: { label: "현재", bg: "#f0d9d1", fg: "#8f2f18" },
  historical_only: { label: "이력", bg: "#efe8d8", fg: "#8a7f6b" },
  gone: { label: "사라짐", bg: "#e4ece4", fg: "#2f6b45" },
};

/**
 * 워커 실행 결말(executionState) — quality_states.EXECUTION_STATES 미러.
 *
 * ok 말고는 전부 "끝까지 못 갔다" 는 뜻이고 이유가 다르다. 원문이 영어라 그대로 그리면
 * 화면에서 읽히지 않는다 — 여기서 한국어 라벨을 붙인다(어휘 밖은 원문 그대로 회색).
 */
export const EXEC_STATE: Record<string, { label: string; dot: string; fg: string; hint?: string }> = {
  ok: { label: "정상 종료", dot: "#2fa365", fg: "#2f6b45" },
  contractViolation: { label: "계약 위반", dot: "#8f2f18", fg: "#8f2f18" },
  budget: { label: "예산 초과", dot: "#b07d1a", fg: "#7d5108" },
  // ★ "취소됨" 이 아니다 — 누가 일부러 중단한 것처럼 읽힌다.
  //   엔진은 유휴 감시견이 끊은 것도 같은 `reason="aborted"` 로 남긴다
  //   (harness/runner.py:330 — "no observable activity for Ns after turn_started").
  //   실측: 부하 시간대에 첫 토큰이 25~54초 걸렸고 dev_web 의 idle 한도가 120초라
  //   **살아 있는 요청을 우리가 먼저 끊었다.** 요청이 안 온 게 아니다.
  //   게이트웨이는 status/reason 만 읽어 둘을 구분할 수 없으므로 라벨이 단정하면 안 된다.
  cancelled: { label: "중단됨", dot: "#9a9a94", fg: "#8a7f6b",
    hint: "부모가 중단했거나, 응답을 기다리다 유휴 한도에 걸려 끊긴 것입니다 — 둘은 구분되지 않습니다." },
  crash: { label: "비정상 종료", dot: "#8f2f18", fg: "#8f2f18" },
  invalid: { label: "결과 무효", dot: "#c2683a", fg: "#8f2f18" },
  missing: { label: "행방불명", dot: "#c2683a", fg: "#8f2f18" },
  unknown: { label: "알 수 없음", dot: "#9a9a94", fg: "#8a7f6b" },
};

/** 큐 스테이지 라벨 — QueueDepth 필드명과 1:1. */
export const STAGE_LABEL: Record<string, string> = {
  strategy: "수집",
  task: "점검",
  report: "보고",  // 큐 스테이지 이름. 이 단계를 지나면 보고가 만들어진다(발송과 별개).
  verify: "재검증",
};

// ── 티켓 목록 필터·정렬 ──────────────────────────────────────────────────────
// ★ 실측 분포(985 대상)로 **갈리는 것만** 넣었다:
//     critical>0 36(4%) · 담당자 없음 190(19%) · high 이상 674(68%)
//   `notifiedAt` 은 985 중 **0건**이라 칩을 만들지 않았다 — 신호가 없는 필터는
//   화면만 복잡하게 하고 아무것도 안 좁힌다.

/** 심각도 — "그 등급이 **있는** 대상". 대상 하나에 여러 심각도가 섞이므로 "만" 이 아니다. */
export const SEVERITY_FILTER = [
  { key: "critical", label: "심각 있음" },
  { key: "high", label: "높음 이상" },
] as const;

/** 담당자 해석 결과. ★ "없음" 은 **보낼 곳을 모른다**는 뜻 — 조치가 멈추는 자리다. */
export const ASSIGNEE_FILTER = [
  { key: "none", label: "담당자 없음" },
  { key: "resolved", label: "담당자 있음" },
] as const;

/** 정렬. 게이트웨이 `_ORDERS` 와 1:1 — 예전엔 서버에만 있고 화면에 컨트롤이 없었다. */
export const ORDER_OPTIONS = [
  // ★ 기본. "최근 관측"(last_seen)은 뒤 run 이 같은 것을 다시 보기만 해도 올라와
  //   순서가 흔들린다 — 티켓의 나이는 **처음 발견된 때**다.
  { key: "firstSeen", label: "발생 최신 순" },
  { key: "findings", label: "발견 많은 순" },
  { key: "critical", label: "심각도 순" },
  { key: "lastSeen", label: "최근 관측 순" },
  { key: "stale", label: "오래된 순" },
] as const;

/**
 * HITL — 사람이 손을 대야 하는 지점.
 *
 * 이 시스템은 자동으로 찾아서 자동으로 통보한다. 그 흐름이 **멈추는 자리**가 두 곳이다:
 *
 *   ① 보내려 했는데 못 나갔다        → 사람이 봐야 한다 (`blocked`)
 *   ② 나갔는데 담당자가 답이 없다     → 기다린다, 오래 기다렸으면 재촉한다 (`waiting`)
 *
 * ★ **파생값이다. 새로 저장하지 않는다.** 근거는 전부 이미 있는 사실이다
 *   (`deliveryEvidence`·`notifiedAt`·`threadStatus`·`attemptCount`·`lastActivityAt`).
 *   상태를 따로 적어 두면 파이프라인이 움직였는데 화면만 옛 상태로 남는다.
 *
 * ⚠️ `deliveryView` 바로 옆에 둔다. 두 판정이 다른 파일에 있으면 한쪽만 고쳐져서
 *    "발송" 이라고 그리면서 동시에 "발송 못 함" 이라고 그리는 화면이 된다.
 * ⚠️ 발송 근거가 없는 도메인(smb·dev_web)에서 `blocked` 를 말하지 않는다 —
 *    안 나간 것과 모르는 것은 다르다.
 */
export type HitlState = "blocked" | "waiting" | "ready" | "none";
export type HitlView = {
  state: HitlState;
  label: string;
  tone: "blocked" | "waiting" | "ready" | "idle";
  hint: string;
  /** 대기 일수. `waiting` 일 때만 채운다. */
  days?: number;
};

/** 회신을 기다리는 중인 status — **나간 뒤** 상태들. */
const AWAITING_REPLY_STATUSES = new Set([
  "awaiting_reply", "awaiting_owner", "still_open",
]);

/**
 * 보고는 만들어졌지만 아직 안 나간 status.
 *
 * ⚠️ 이건 **고장이 아니다.** 지금 파이프라인은 의도적으로 발송 직전에서 멈춰 있다
 *    (사용자 결정: "메일발송전까지 식별작업 가자"). 실측 2026-08-27 기준 거의 모든
 *    스레드가 여기 있다 — 이걸 "개입 필요" 빨간색으로 그리면 화면 전체가 경보가 된다.
 *    할 일을 가리키되 사고처럼 그리지 않는다.
 */
const READY_TO_SEND_STATUSES = new Set(["reported", "report_ready"]);
/** 아직 본문도 안 굳은 것. 사람이 할 일이 없다. */
const DRAFT_STATUSES = new Set(["draft", "queued", "pending"]);

/** 이 일수를 넘게 답이 없으면 "오래 기다림" 으로 색을 올린다. */
export const HITL_STALE_DAYS = 7;

export function hitlView(
  item: {
    threads?: unknown;
    threadStatus?: unknown;
    notifiedAt?: unknown;
    deliveryEvidence?: unknown;
    attemptCount?: unknown;
    lastActivityAt?: unknown;
    firstReportedAt?: unknown;
  },
  now: number,
): HitlView {
  const threads = typeof item.threads === "number" ? item.threads : 0;
  if (threads <= 0) {
    return {
      state: "none", label: "해당 없음", tone: "idle",
      hint: "보고 스레드가 없습니다 — 아직 통보 대상이 아닙니다.",
    };
  }
  const status = typeof item.threadStatus === "string" ? item.threadStatus : "";
  const delivery = deliveryView(item.deliveryEvidence, item.notifiedAt, status);
  const attempts = typeof item.attemptCount === "number" ? item.attemptCount : 0;

  // ① 시도했는데 못 나갔다. **근거가 있는 도메인에서만** 단정한다.
  if (delivery.tone === "unsent" && attempts > 0) {
    return {
      state: "blocked", label: "개입 필요", tone: "blocked",
      hint: `발송을 ${attempts}회 시도했지만 발송 시각이 비어 있습니다 — 나가지 못했습니다.`,
    };
  }

  // ② 아직 작성 중 — 사람이 할 일이 없다.
  if (DRAFT_STATUSES.has(status)) {
    return {
      state: "none", label: "보고 작성 중", tone: "idle",
      hint: "에이전트가 보고를 만드는 중입니다 — 아직 사람 차례가 아닙니다.",
    };
  }

  // ③ 보고는 준비됐는데 아직 안 나갔다. **고장이 아니다** — 지금은 여기서 멈추는 게 정상이다.
  if (delivery.tone !== "sent" && READY_TO_SEND_STATUSES.has(status)) {
    return {
      state: "ready", label: "발송 대기", tone: "ready",
      hint: "보고가 준비됐고 아직 발송하지 않았습니다 — 아래에서 본문을 확인하고 보낼 수 있습니다.",
    };
  }

  // ④ 나갔는데(또는 상태상 나갔는데) 답이 없다.
  if (delivery.tone !== "unsent" && AWAITING_REPLY_STATUSES.has(status)) {
    const since = pickSince(item.notifiedAt, item.lastActivityAt, item.firstReportedAt);
    const days = since === null ? null : Math.floor((now - since) / 86_400);
    const stale = days !== null && days >= HITL_STALE_DAYS;
    return {
      state: "waiting",
      label: stale ? `회신 없음 ${days}일` : "회신 대기",
      tone: "waiting",
      hint: stale
        ? `${days}일째 담당자 회신이 없습니다 — 재통보나 상신을 검토하세요.`
        : "담당자 회신을 기다리는 중입니다.",
      ...(days === null ? {} : { days }),
    };
  }

  return {
    state: "none", label: "해당 없음", tone: "idle",
    hint: "지금 사람이 개입해야 할 지점이 없습니다.",
  };
}

/** 대기 시작 시각 — 발송 > 최근 활동 > 보고 생성 순으로 **있는 것**을 쓴다. */
function pickSince(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
  }
  return null;
}

export const HITL_TONE: Record<HitlView["tone"], { fg: string; bg: string }> = {
  blocked: { fg: "#8f2f18", bg: "#f6e7e2" },
  waiting: { fg: "#7a5c3e", bg: "#f3ead9" },
  // 할 일이지 사고가 아니다 — 빨강을 쓰지 않는다.
  ready: { fg: "#5f7a9a", bg: "#e6edf4" },
  idle: { fg: "#9a9a94", bg: "transparent" },
};
