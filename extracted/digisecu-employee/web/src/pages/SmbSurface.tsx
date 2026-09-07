/**
 * 노출 표면(SMB) — 한 호스트의 공유 → 디렉터리.
 *
 * 티켓 상세의 "이 대상에서 찾은 것" 은 **무엇이 걸렸나**를 답한다(파일 하나하나).
 * 이 카드는 **어디까지 열려 있나**를 답한다 — finding 이 없는 폴더도 게스트로 읽히면
 * 그 자체가 노출 표면이다. 같은 화면이 스킬쪽 SMB 운영 웹앱(:8767)에 이미 있고,
 * 이건 그것을 콘솔로 옮긴 것이다(디렉터리까지·파일 목록은 제외).
 *
 * ## 지켜야 하는 것
 *
 * 1. **경로는 원문 그대로.** 사용자 결정(2026-08-25). 경로가 공정 정보를 담을 수 있지만
 *    (`…/SEMES_IPDT#08-05-2014…jpg`), :8767 이 같은 사내 ACL 안에서 이미 원문을 보여준다.
 *    두 화면이 같은 대상에 다른 값을 보이는 쪽이 더 나쁘다.
 * 2. **못 읽은 것과 없는 것을 구분한다.** `access="denied"` 는 `smb_directory` GRANT 가
 *    없다는 뜻이지 "폴더가 없다" 가 아니다.
 * 3. **값이 없는 플래그는 그리지 않는다.** 실측(195,277행): listable 100% ·
 *    readable 2% · **writable 0%**. `writable` 을 "쓰기 불가" 로 그리면 거짓말이다 —
 *    워커가 아예 안 채운다.
 * 4. **자른 것은 말한다.** 공유당 200개까지만 받는다(호스트 하나에 4,143개짜리 공유가 있다).
 */
import { useState } from "react";
import type { SmbDirectory, SmbShare, SmbTree } from "@digisecu/contracts";
import { Card, Empty, LoadError, Loading, SectionTitle } from "../components/ui";
import { asArr, asNum, asStr, num } from "../lib/guards";
import { useSmbTree } from "../lib/queries";

/** 공유 접근 배지 — 값이 true 일 때만 그린다(null=모름, false=아님은 침묵). */
const ACCESS_BADGES: { key: keyof SmbShare; label: string; tone: { bg: string; fg: string } }[] = [
  { key: "nullLogin", label: "익명 로그인", tone: { bg: "#f0d9d1", fg: "#8f2f18" } },
  { key: "guestLogin", label: "게스트", tone: { bg: "#f2e1da", fg: "#9a3620" } },
  { key: "authLogin", label: "인증 계정", tone: { bg: "#e8ecdb", fg: "#4f5f3a" } },
  { key: "shareRead", label: "읽기", tone: { bg: "#efe8d8", fg: "#7d5108" } },
  { key: "shareWrite", label: "쓰기", tone: { bg: "#7f1d1d", fg: "#fee2e2" } },
];

export function SmbSurface({ srcKey, domain }: { srcKey: string | undefined; domain: string }) {
  const isSmb = domain === "smb";
  const q = useSmbTree(srcKey, isSmb);

  // smb 가 아니면 카드 자체를 안 그린다 — 다른 도메인엔 이 축이 없다.
  if (!isSmb) return null;

  if (q.isLoading) {
    return (
      <Card className="px-4 py-3.5">
        <SectionTitle title="노출 표면" />
        <Loading what="공유·디렉터리" />
      </Card>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Card className="px-4 py-3.5">
        <SectionTitle title="노출 표면" />
        <LoadError what="공유·디렉터리" error={q.error} />
      </Card>
    );
  }

  const tree: SmbTree = q.data;
  const shares = asArr<SmbShare>(tree.shares).filter((s) => s && typeof s === "object");
  const denied = asStr(tree.access) === "denied";

  return (
    <Card className="px-4 py-3.5">
      <SectionTitle
        title="노출 표면"
        meta={
          shares.length > 0
            ? `공유 ${num(shares.length)}${denied ? "" : ` · 폴더 ${num(tree.directoryTotal)}`}`
            : undefined
        }
      />

      {denied ? (
        <div className="mb-2.5 rounded-md border border-[#e0cfa8] bg-[#f6efe2] px-2.5 py-1.5 text-[11.5px] text-[#8a5c10]">
          폴더 목록을 <b>읽을 권한이 없습니다</b> — 폴더가 없다는 뜻이 아닙니다.
          <span className="ml-1 font-mono">gateway/sql/006</span> 을 적용하면 보입니다.
        </div>
      ) : null}

      {shares.length === 0 ? (
        <Empty
          why="이 호스트에 기록된 공유가 없습니다"
          hint="발견은 있는데 공유가 없다면 스윕 기록과 finding 의 호스트 표기가 어긋난 것입니다."
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {shares.map((s, i) => (
            <ShareRow key={`${s.share}-${i}`} share={s} denied={denied} />
          ))}
        </ul>
      )}

      {tree.sharesTruncated ? (
        <p className="mt-1.5 font-mono text-[10.5px] text-muted">
          공유 목록이 잘렸습니다 — 화면에 없는 공유가 있습니다.
        </p>
      ) : null}
    </Card>
  );
}

function ShareRow({ share, denied }: { share: SmbShare; denied: boolean }) {
  const [open, setOpen] = useState(false);
  const dirs = asArr<SmbDirectory>(share.directories).filter((d) => d && typeof d === "object");
  const dirTotal = asNum(share.directoryTotal) ?? 0;
  const fileCount = asNum(share.fileCount);
  const name = asStr(share.share) ?? "(이름 없음)";
  const truncated = dirTotal > dirs.length;

  return (
    <li className="rounded-lg border border-line bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={denied || dirs.length === 0}
        className="flex w-full items-center gap-2 px-3 py-2 text-left disabled:cursor-default"
      >
        <span className="w-3 shrink-0 font-mono text-[10px] text-muted">
          {denied || dirs.length === 0 ? "" : open ? "▾" : "▸"}
        </span>
        <span className="min-w-0 truncate font-mono text-[12px] text-ink" title={name}>
          {name}
        </span>
        <span className="flex shrink-0 flex-wrap items-center gap-1">
          {ACCESS_BADGES.map((b) =>
            share[b.key] === true ? (
              <span
                key={String(b.key)}
                className="rounded px-1.5 py-0.5 text-[10px]"
                style={{ background: b.tone.bg, color: b.tone.fg }}
              >
                {b.label}
              </span>
            ) : null,
          )}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10.5px] tabular-nums text-muted">
          {fileCount === null ? "파일 —" : `파일 ${num(fileCount)}`}
          {denied ? null : ` · 폴더 ${num(dirTotal)}`}
        </span>
      </button>

      {open && dirs.length > 0 ? (
        <div className="border-t border-line/60 px-3 py-2">
          <ul className="flex flex-col">
            {dirs.map((d, i) => (
              <DirRow key={i} dir={d} />
            ))}
          </ul>
          {truncated ? (
            <p className="mt-1.5 font-mono text-[10.5px] text-muted">
              {num(dirTotal)}개 중 {num(dirs.length)}개만 표시 — 나머지{" "}
              {num(dirTotal - dirs.length)}개는 화면에 없습니다.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** 폴더 한 줄. depth 만큼 들여쓴다 — 트리를 조립하지 않고도 계층이 읽힌다. */
function DirRow({ dir }: { dir: SmbDirectory }) {
  const depth = Math.min(asNum(dir.depth) ?? 0, 8);
  const path = asStr(dir.path);
  const error = asStr(dir.error);
  const listable = dir.listable;
  const readable = dir.readable;

  return (
    <li
      className="flex items-baseline gap-2 py-[3px] text-[11.5px]"
      style={{ paddingLeft: `${depth * 12}px` }}
    >
      <span className="min-w-0 break-all font-mono text-ink">
        {/* 루트는 경로가 빈 문자열이다(공유당 1건) — 빈칸으로 두면 사라진 것처럼 보인다. */}
        {path ?? <span className="text-muted">(공유 루트)</span>}
      </span>
      {listable === false ? (
        <span className="shrink-0 rounded bg-side px-1.5 py-0.5 text-[10px] text-muted">
          목록 불가
        </span>
      ) : null}
      {readable === true ? (
        <span
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
          style={{ background: "#f2e1da", color: "#9a3620" }}
        >
          읽기 확인
        </span>
      ) : null}
      {error ? (
        <span className="min-w-0 shrink truncate text-[10.5px] text-muted" title={error}>
          {error}
        </span>
      ) : null}
    </li>
  );
}
