/**
 * 단건 finding 상세 전용 고정 어휘 — 로그인 검증 배지·증거 캡·hit 분류 색.
 *
 * `soarMeta.ts` 와 같은 정책이다: **전부 클라이언트 하드코딩**. 서버가 문구를 위조할 수
 * 없어야 하고, 어휘 밖 값이 오면 그리지 않는다.
 *
 * ⚠️ 이 파일의 함수 둘(`loginTone`·`isLoginConfirmed`)은 장식이 아니라 **적대적 검증에서
 *    나온 방어**다. 2026-08-23 커밋 9d0c5aa 가 이 로직이 들어 있던
 *    `workspaces/sections/FindingsSectionView.tsx`(791줄)를 통째로 지우면서 같이 사라졌다.
 *    다시 지우기 전에 아래 주석을 읽을 것.
 */
import type { HitLoginValidation } from "@digisecu/contracts";

// ── 표시 캡 ──────────────────────────────────────────────────────────────────
// 증거는 한 finding 에 수천 건이 붙을 수 있다(hit 총 51,070건 / finding 20,667건).
// 자르되 **자른 사실을 말한다**(CapNote) — 조용한 절단은 "이게 전부"로 읽힌다.
export const CAP_HITS = 20;
export const CAP_PROBES = 12;
export const CAP_ACTIONS = 20;
export const CAP_NOTES = 20;

/** 이보다 긴 preview 는 접고 '전문 보기'. */
export const PREVIEW_CLAMP = 220;

// ── hit 분류 색 ──────────────────────────────────────────────────────────────
// `hit.category` 는 **자유 텍스트**다(게이트웨이가 어휘를 강제하지 않는다). 여기 없는 값은
// 중립색으로 떨어지고, 절대 검증 배지처럼 보이면 안 된다 — 아래 스푸핑 방어 참조.
export const CAT_TONE_HIT: Record<string, string> = {
  secret: "#f2e1da",
  secret_heuristic: "#f1e7d0",
  pii: "#e8ecdb",
  credential: "#f2e1da",
};

// ── 로그인 검증 ──────────────────────────────────────────────────────────────
// 노출된 크리덴셜로 **실제 로그인 1회**를 시도한 결과. `authenticated` 만 '악용 가능 확인'
// 으로 읽히게 하고 나머지는 과장하지 않는다. 어휘 밖 값은 게이트웨이가 이미 드롭하므로
// 여기 없는 키 = 배지 없음 — 무음 실패가 아니라 설계다.
export const LV_AUTHENTICATED = {
  label: "로그인 검증됨",
  bg: "#f2e1da",
  fg: "#9a3620",
  note: "노출된 계정으로 실제 로그인에 성공했습니다 — 악용 가능이 확인된 상태입니다.",
};

export const LOGIN_VALIDATION: Record<
  string,
  { label: string; bg: string; fg: string; note: string }
> = {
  authenticated: LV_AUTHENTICATED,
  auth_failed: {
    label: "로그인 실패",
    bg: "#eae3d2",
    fg: "#7a6f58",
    note: "로그인은 거부됐습니다. 다만 평문 노출 자체는 여전히 유효한 발견입니다.",
  },
  account_locked: {
    label: "계정 잠김",
    bg: "#f1e7d0",
    fg: "#8a5c10",
    note: "계정이 잠겨 있어 유효성을 판정하지 못했습니다.",
  },
  credential_expired: {
    label: "비밀번호 만료",
    bg: "#f1e7d0",
    fg: "#8a5c10",
    note: "계정은 존재하나 비밀번호가 만료 상태입니다(계정명은 유효).",
  },
  session_denied: {
    label: "세션 거부",
    bg: "#f1e7d0",
    fg: "#8a5c10",
    note: "인증 이후 단계에서 거부됐습니다.",
  },
};

/**
 * 고정 어휘 조회.
 *
 * ⚠️ `LOGIN_VALIDATION[k]` 로 바로 읽으면 안 된다 — `constructor`·`toString`·`__proto__`
 * 같은 **프로토타입 체인 키**가 "어휘 밖은 그리지 않는다" 불변식을 뚫고 유령 배지를
 * 만든다. `hasOwnProperty` 로만 조회한다.
 */
export function loginTone(result: unknown) {
  const k = typeof result === "string" ? result : "";
  return Object.prototype.hasOwnProperty.call(LOGIN_VALIDATION, k)
    ? LOGIN_VALIDATION[k]
    : undefined;
}

/**
 * '로그인 성공' 주장은 `result` 만으로 판정하지 않는다 — `provesValidity` 까지 true 여야 한다.
 *
 * 게이트웨이가 모순 데이터를 드롭하지만, 구버전 게이트웨이·중간 계층 오염에 대한 방어심층이다.
 * 이 배지 하나가 "노출됐다" 와 "이미 악용 가능하다" 를 가른다 — 틀리면 심각도 판단이 뒤집힌다.
 */
export function isLoginConfirmed(lv: HitLoginValidation | null | undefined): boolean {
  return !!lv && lv.result === "authenticated" && lv.provesValidity === true;
}

/**
 * `authenticated` 인데 `provesValidity` 가 아니면 **모순**이다.
 * 어느 쪽이 거짓인지 모르므로 아무것도 주장하지 않는다(배지 없음).
 */
export function isContradictory(lv: HitLoginValidation | null | undefined): boolean {
  return !!lv && lv.result === "authenticated" && lv.provesValidity !== true;
}

// ── 검증 상태(github) ────────────────────────────────────────────────────────
export const VERIFICATION_STATUS: Record<string, string> = {
  live_in_HEAD: "HEAD에 존재(live)",
  historical_only: "이력만(과거)",
};
