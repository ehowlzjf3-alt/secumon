/**
 * 게이트웨이 응답 방어 가드 — 전 화면 공용.
 *
 * `api.ts` 의 `requireShape` 는 얕다(배열인지만 본다). 그 아래 필드는 검증되지 않은 채로
 * 화면까지 온다. 예상 밖 타입이 오면 React 가 객체를 children 으로 받아 **라우트 전체가
 * 크래시**한다 — 그래서 기대 타입일 때만 렌더한다.
 *
 * 원래 `workspaces/sections/FindingsSectionView.tsx` 안에 있었고 **로그인 검증 배지 경로에만**
 * 국소 적용돼 있었다. 전면 재설계에서 여기로 빼고 전 필드로 확대한다.
 */

/** 문자열이고 비어 있지 않을 때만 반환. 그 외 null. */
export function asStr(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** 유한한 수일 때만 반환. NaN/Infinity/문자열 숫자는 거부. */
export function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 배열일 때만 반환. */
export function asArr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * 고정 어휘 조회 — `constructor`/`toString`/`__proto__` 같은 프로토타입 체인 키가
 * "어휘 밖은 그리지 않는다" 불변식을 뚫고 유령 값을 만드는 것을 막는다.
 *
 * ★ `table[key]` 를 그냥 쓰면 서버가 보낸 `"constructor"` 가 함수를 반환한다.
 */
export function lookup<T>(table: Record<string, T>, key: unknown): T | undefined {
  const k = asStr(key);
  if (k === null) return undefined;
  return Object.prototype.hasOwnProperty.call(table, k) ? table[k] : undefined;
}

/** 어휘 밖이면 fallback. 라벨처럼 "뭐라도 그려야 하는" 자리에 쓴다. */
export function label<T>(table: Record<string, T>, key: unknown, fallback: T): T {
  return lookup(table, key) ?? fallback;
}

// ── 표시 포맷 ────────────────────────────────────────────────────────────────

/** 천 단위 구분. null/비수치는 대시. */
export function num(v: unknown): string {
  const n = asNum(v);
  return n === null ? "—" : n.toLocaleString("ko-KR");
}

/** epoch 초 → "3시간 전". 미래·null 은 대시. */
export function ago(epochSec: unknown, nowSec?: number): string {
  const t = asNum(epochSec);
  if (t === null || t <= 0) return "—";
  const now = nowSec ?? Date.now() / 1000;
  const d = now - t;
  if (d < 0) return "방금";
  if (d < 60) return "방금";
  if (d < 3600) return `${Math.floor(d / 60)}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  const days = Math.floor(d / 86400);
  if (days < 30) return `${days}일 전`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}개월 전` : `${Math.floor(days / 365)}년 전`;
}

/** epoch 초 → "2026-08-23 14:20". null 은 대시. */
export function stamp(epochSec: unknown): string {
  const t = asNum(epochSec);
  if (t === null || t <= 0) return "—";
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** epoch 초 → "08-23". 타임라인처럼 짧게 쓸 때. */
export function shortDate(epochSec: unknown): string {
  const t = asNum(epochSec);
  if (t === null || t <= 0) return "—";
  const d = new Date(t * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 두 epoch 사이 경과 일수. 어느 쪽이든 null 이면 null. */
export function daysBetween(a: unknown, b: unknown): number | null {
  const x = asNum(a);
  const y = asNum(b);
  if (x === null || y === null) return null;
  return Math.max(0, Math.floor(Math.abs(y - x) / 86400));
}

/** 비율 표시. 분모 0 이면 대시(0% 로 위장하지 않는다 — 모수가 없는 것과 0 은 다르다). */
export function pct(numer: unknown, denom: unknown, digits = 1): string {
  const n = asNum(numer);
  const d = asNum(denom);
  if (n === null || d === null || d <= 0) return "—";
  return `${((n / d) * 100).toFixed(digits)}%`;
}
