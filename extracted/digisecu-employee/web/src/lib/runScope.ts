/**
 * "이번 run 만 보기" 경계.
 *
 * 게이트웨이 `/gw/findings` 는 `since`(epoch 초) 필터를 지원하는데 웹이 한 번도
 * 보내지 않고 있었다. 그래서 UI 에 누적 finding 이 전부(2026-08-17 기준 20,440건)
 * 떴다 — 이번 run 의 결과가 과거 기록에 묻힌다.
 *
 * 값은 `VITE_RUN_SINCE` 로 준다. 형식 둘 다 받는다:
 *   VITE_RUN_SINCE="2026-08-17T00:00:00+09:00"   // ISO
 *   VITE_RUN_SINCE="1786993200"                  // epoch 초
 *
 * ⚠️ 게이트웨이의 `since` 는 **`last_seen >=`** 다(`first_seen` 아님). 즉 "이번 run 에
 * 새로 발견된 것"이 아니라 **"이번 run 이 다시 관측한 것"** 이다. 6월에 처음 찾은
 * 노출이라도 이번 run 이 그 공유를 다시 읽었으면 포함된다 — 그게 "지금 살아 있는
 * 노출"이라 운영 화면에는 이쪽이 맞다.
 *
 * ⚠️ 미설정/파싱 실패면 **필터 없이 전부** 보여준다(fail-open). 설정 실수로 화면이
 * 텅 비어 "노출 0건" 으로 읽히는 편이 더 위험하다.
 */

const RAW = import.meta.env.VITE_RUN_SINCE as string | undefined;

let warned = false;

/** `/gw/findings?since=` 에 실을 epoch 초. 미설정이면 undefined(=전체). */
export function runSinceEpoch(): number | undefined {
  const raw = (RAW ?? "").trim();
  if (!raw) return undefined;

  // epoch 초(정수)로 준 경우
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  } else {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms / 1000;
  }

  if (!warned) {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[runScope] VITE_RUN_SINCE 를 해석하지 못했다: ${JSON.stringify(raw)}. ` +
        "필터 없이 전체를 표시한다(fail-open).",
    );
  }
  return undefined;
}

/** 화면에 "언제 이후를 보고 있는지" 표시할 때 쓴다. 미설정이면 null. */
export function runSinceLabel(): string | null {
  const s = runSinceEpoch();
  if (s === undefined) return null;
  return new Date(s * 1000).toLocaleString();
}
