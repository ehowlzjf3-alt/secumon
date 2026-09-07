import { Link, useRouteError } from "react-router-dom";

/**
 * 라우트 레벨 에러 바운더리.
 *
 * ★ 재설계 전에는 이 저장소에 에러 바운더리가 **하나도 없었다**(grep 0건). 그래서 화면 코드가
 *   "게이트웨이가 예상 밖 타입을 보내면 라우트가 통째로 크래시한다" 는 걸 국소 가드로 막고
 *   있었다(FindingsSectionView 의 asStr/asNum). 가드는 그대로 두되(lib/guards.ts), 바운더리가
 *   있으면 한 화면이 죽어도 사이드바와 나머지 화면은 살아 있다.
 */
export function RouteError() {
  const err = useRouteError();
  const msg =
    err instanceof Error ? err.message
    : typeof err === "string" ? err
    : "알 수 없는 오류";

  return (
    <div className="px-6 py-10">
      <div className="mx-auto max-w-xl rounded-xl border border-[#e0bfb2] bg-[#fbf0ec] px-5 py-6">
        <div className="text-[14px] text-[#8f2f18]">이 화면을 그리지 못했습니다</div>
        <div className="mt-2 break-words font-mono text-[11.5px] text-muted">{msg}</div>
        <div className="mt-3 text-[12px] text-muted">
          다른 화면은 그대로 동작합니다. 게이트웨이 응답 형태가 바뀌었을 수 있습니다.
        </div>
        <Link
          to="/"
          className="mt-4 inline-block rounded-lg bg-walnut px-3 py-1.5 text-[12.5px] text-paper hover:opacity-90"
        >
          개요로
        </Link>
      </div>
    </div>
  );
}
