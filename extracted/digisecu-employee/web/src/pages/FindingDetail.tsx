/**
 * 발견 상세 — finding 한 건.
 *
 * 티켓(src)은 "어디를 조치할 것인가" 이고, 이 화면은 "무엇을 근거로 그렇게 말하는가" 다.
 * 게이트웨이 `GET /gw/findings/{id}` 만 쓴다(목록 응답에는 증거가 원리적으로 없다 —
 * `maskedHits` 는 상시 null 로 폐기됐다).
 *
 * ## 왜 이 화면이 한동안 없었나
 * 2026-08-23 커밋 9d0c5aa 가 인사 은유를 걷어내면서
 * `workspaces/sections/FindingsSectionView.tsx`(791줄)를 지웠는데, 그 안에 이 6개 섹션이
 * 들어 있었다. 훅(`useGatewayFinding`)과 fetcher 는 안 지워져서 **소비자 0인 고아**로
 * 남았다 — 백엔드는 6주간 정상으로 응답하고 있었고 그리는 코드만 없었다.
 *
 * ## 이 화면이 반드시 지켜야 하는 것
 * 1. **없는 것은 없음으로.** 리치필드는 도메인·시기마다 채움률이 다르다(실측: hits 99.98% ·
 *    권장조치 99.97% · 검증 95.2%(github 전용) · 위험서사 3.3% · pivot 3.2% · 증거해설 1.6%).
 *    빈 섹션이 **정상 상태로** 보여야 하고, 고장과 구분돼야 한다.
 * 2. **자른 것은 말한다.** 증거는 수천 건이 붙을 수 있다. CapNote 없이 자르면 화면이
 *    "이게 전부" 라고 거짓말한다.
 * 3. **서버 문자열로 배지를 만들지 않는다.** `hit.category` 는 자유 텍스트다 —
 *    거기 "로그인 검증됨" 을 써넣어 검증 배지를 흉내낼 수 있다(`findingMeta` 참조).
 */
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type {
  DetailHit,
  EvidenceNote,
  GatewayFindingDetail,
  HitLoginValidation,
  PivotProbe,
} from "@digisecu/contracts";
import { useGatewayFinding } from "../lib/queries";
import {
  Card,
  CapNote,
  DomainTag,
  Empty,
  LoadError,
  Loading,
  Meta,
  Pill,
  SectionTitle,
} from "../components/ui";
import { asArr, asNum, asStr, label, lookup, num, stamp } from "../lib/guards";
import {
  ASSIGNEE_STATUS,
  DOMAIN_COLOR,
  DOMAIN_LABEL,
  DOMAIN_TINT,
  SEV,
} from "../lib/soarMeta";
import {
  CAP_ACTIONS,
  CAP_HITS,
  CAP_NOTES,
  CAP_PROBES,
  CAT_TONE_HIT,
  LV_AUTHENTICATED,
  PREVIEW_CLAMP,
  VERIFICATION_STATUS,
  isContradictory,
  isLoginConfirmed,
  loginTone,
} from "../lib/findingMeta";

export function FindingDetail() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  // 어디서 왔는지. 티켓에서 왔으면 그 티켓으로 돌아간다(없으면 발견 목록으로).
  const from = params.get("from");

  // 라우트 파라미터는 사용자가 손댈 수 있다 — 숫자가 아니면 조회 자체를 하지 않는다.
  const numericId = id != null && /^\d+$/.test(id) ? Number(id) : null;
  const q = useGatewayFinding(numericId);

  const back = from
    ? { to: `/tickets/${encodeURIComponent(from)}`, label: "티켓으로" }
    : { to: "/findings", label: "발견 목록" };

  if (numericId == null) {
    return (
      <div className="px-5 py-4">
        <Empty why="발견 번호가 올바르지 않습니다" hint={`주소의 id 가 숫자가 아닙니다: ${id ?? "(없음)"}`} />
      </div>
    );
  }
  if (q.isLoading) {
    return (
      <div className="px-5 py-4">
        <Loading what="발견 상세" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="px-5 py-4">
        <LoadError what={`발견 #${numericId}`} error={q.error} />
        <Link to={back.to} className="mt-3 inline-block text-[12px] text-walnut hover:underline">
          ← {back.label}
        </Link>
      </div>
    );
  }

  const f: GatewayFindingDetail = q.data;
  const sev = lookup(SEV, f.severity);
  const domain = asStr(f.taskType) ?? "";

  // ⚠️ 게이트웨이 응답에 런타임 스키마 검증이 없다(api.ts requireShape 는 얕다).
  //    배열이 아닌 값이 오면 React 가 객체를 children 으로 받아 라우트가 통째로 크래시한다.
  const hits = asArr<DetailHit>(f.hits).filter((h) => h && typeof h === "object");
  // 워커가 "1. …" 처럼 번호를 붙여 저장한 것이 많다. <ol> 과 겹치면 "1. 1." 이 된다.
  // `\d+.` 뒤에 공백이 있을 때만 벗긴다 — "3389 포트를 닫으십시오" 같은 본문은 건드리지 않는다.
  const actions = asArr<string>(f.recommendedActions)
    .filter((a) => typeof a === "string" && a)
    .map((a) => a.replace(/^\s*\d+\s*[.)]\s+/, "").trim())
    .filter(Boolean);
  const notes = asArr<EvidenceNote>(f.evidenceNotes).filter((n) => n && typeof n === "object");
  const probes = asArr<PivotProbe>(f.pivot?.probes).filter((p) => p && typeof p === "object");

  const rn = f.riskNarrative;
  const riskRows = [
    ["어떤 데이터인가", asStr(rn?.whatIsData)],
    ["어떻게 발견했나", asStr(rn?.howDiscovered)],
    ["악용 경로", asStr(rn?.exploitationPath)],
    ["검증 방법", asStr(rn?.verificationMethod)],
  ].filter((r): r is [string, string] => r[1] != null);

  const verif = f.verification;
  const meta = f.metadata;
  const metaRows = [
    ["저장소", asStr(meta?.repo), true],
    ["경로", asStr(meta?.path), true],
    ["수집 소스", asStr(meta?.source), false],
    ["커밋", asStr(meta?.commit), true],
    ["스캔 방식", asStr(meta?.scanMethod), false],
    ["검증 상태", asStr(verif?.status) ? label(VERIFICATION_STATUS, verif?.status, asStr(verif?.status)!) : null, false],
    ["검증 방식", asStr(verif?.method), false],
    ["검증 소스", asStr(verif?.source), false],
  ].filter((r): r is [string, string, boolean] => r[1] != null);

  const loginVerifiedHits = hits.filter((h) => isLoginConfirmed(h.loginValidation)).length;
  const pivotNote = asStr(f.pivotInterpretation);
  const confidence = asNum(f.confidence);
  const scanned = asNum(f.assetCountScanned);
  const target = asStr(f.target);

  return (
    <div className="flex flex-col gap-3.5 px-5 py-4">
      {/* ── 머리 ── */}
      <div>
        <Link to={back.to} className="text-[11.5px] text-walnut hover:underline">
          ← {back.label}
        </Link>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Pill tone={sev}>{sev ? sev.label : (asStr(f.severity) ?? "—")}</Pill>
          {domain ? (
            <DomainTag
              domain={domain}
              label={label(DOMAIN_LABEL, domain, domain)}
              color={label(DOMAIN_COLOR, domain, "#8a7f6b")}
              tint={label(DOMAIN_TINT, domain, "#efe8d8")}
            />
          ) : null}
          {asArr<{ key: string; label: string }>(f.categories).map((c) => (
            <span key={c.key} className="rounded bg-side px-1.5 py-0.5 text-[10.5px] text-muted">
              {asStr(c.label) ?? c.key}
            </span>
          ))}
          {/* 상세를 펼치지 않아도 보이는 최상위 사실 — 노출이 아니라 '악용 가능이 확인됨'. */}
          {f.loginValidated === true ? (
            <span
              className="rounded border px-1.5 py-0.5 text-[10.5px] font-medium"
              style={{
                background: LV_AUTHENTICATED.bg,
                color: LV_AUTHENTICATED.fg,
                borderColor: LV_AUTHENTICATED.fg,
              }}
              title="노출된 계정으로 실제 로그인에 성공한 증거가 있습니다 — 아래 증거 hits 의 프로브 결과를 확인하세요."
            >
              악용 가능 확인
            </span>
          ) : null}
          <span className="ml-auto font-mono text-[11px] text-muted">#{f.id}</span>
        </div>
        <h1 className="mt-1.5 break-words font-serif text-[19px] leading-snug">
          {asStr(f.summary) ?? "요약 없음"}
        </h1>
      </div>

      <div className="grid grid-cols-[1fr_340px] items-start gap-3.5">
        {/* ── 좌: 증거 ── */}
        <div className="flex flex-col gap-3.5">
          {/* 위험 내용 */}
          <Card className="px-4 py-3.5">
            <SectionTitle title="위험 내용" />
            {riskRows.length === 0 ? (
              <Empty
                why="이 발견에는 위험 서술이 없습니다"
                hint="위험 서술은 워커가 쓴 4부 해설입니다. 전체 발견의 3.3% 에만 있고, 없는 것이 정상입니다 — 아래 증거 hits 가 1차 근거입니다."
              />
            ) : (
              <dl className="flex flex-col gap-2">
                {riskRows.map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-[10.5px] text-muted">{k}</dt>
                    <dd className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink">
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>

          {/* 증거 hits */}
          <Card className="px-4 py-3.5">
            <SectionTitle
              title="증거"
              meta={
                hits.length > 0
                  ? `${hits.length}건${loginVerifiedHits > 0 ? ` · 로그인 검증 ${loginVerifiedHits}건` : ""}`
                  : undefined
              }
            />
            {hits.length === 0 ? (
              <Empty
                why="투영된 증거 hit 이 없습니다"
                hint={
                  f.hasEvidence
                    ? "원본 증거 파일은 있습니다(경로는 마스킹 경계 밖이라 노출하지 않습니다). 화면에 그릴 수 있는 hit 투영만 비어 있습니다."
                    : "이 발견에는 저장된 증거 참조가 없습니다."
                }
              />
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {hits.slice(0, CAP_HITS).map((h, i) => (
                    <HitCard key={i} hit={h} />
                  ))}
                </ul>
                <CapNote shown={Math.min(hits.length, CAP_HITS)} total={hits.length} />
              </>
            )}
          </Card>

          {/* 측면이동 */}
          {f.pivot || pivotNote ? (
            <Card className="px-4 py-3.5">
              <SectionTitle
                title="측면이동(pivot)"
                meta={
                  asNum(f.pivot?.exposedCount) != null
                    ? `노출 ${num(f.pivot?.exposedCount)}건`
                    : undefined
                }
              />
              {pivotNote ? (
                <p className="mb-2 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink">
                  {pivotNote}
                </p>
              ) : null}
              {probes.length > 0 ? (
                <>
                  {/* ⚠️ URL 은 링크로 만들지 않는다 — 화면에서 클릭 한 번으로 내부 표면에
                      요청이 나가면 조사 행위가 된다. 보여주기만 한다. */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[11.5px]">
                      <thead>
                        <tr className="border-b border-line text-muted">
                          <th className="px-3 pb-1.5 font-normal">URL(비링크)</th>
                          <th className="px-3 pb-1.5 font-normal">상태</th>
                          <th className="px-3 pb-1.5 font-normal">판정</th>
                          <th className="px-3 pb-1.5 font-normal">content-type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {probes.slice(0, CAP_PROBES).map((p, i, arr) => (
                          <ProbeRow key={i} probe={p} last={i === arr.length - 1} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <CapNote shown={Math.min(probes.length, CAP_PROBES)} total={probes.length} />
                </>
              ) : (
                <Empty why="도달 프로브 기록이 없습니다" />
              )}
            </Card>
          ) : null}

          {/* 증거 해설 */}
          {notes.length > 0 ? (
            <Card className="px-4 py-3.5">
              <SectionTitle title="증거 해설" meta={`${notes.length}건`} />
              <ul className="flex flex-col gap-2">
                {notes.slice(0, CAP_NOTES).map((n, i) => (
                  <NoteCard key={i} note={n} />
                ))}
              </ul>
              <CapNote shown={Math.min(notes.length, CAP_NOTES)} total={notes.length} />
            </Card>
          ) : null}
        </div>

        {/* ── 우: 사실 ── */}
        <div className="flex flex-col gap-3.5">
          <Card className="px-4 py-3.5">
            <SectionTitle title="대상" />
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              <div className="col-span-2">
                <Meta label="자산" value={asStr(f.asset) ?? "—"} mono />
              </div>
              {target ? (
                <div className="col-span-2">
                  <Meta label="스캔 대상" value={target} mono />
                </div>
              ) : null}
              <Meta label="자산 종류" value={asStr(f.assetKind) ?? "—"} />
              <Meta label="엔진 상태" value={asStr(f.status) ?? "—"} />
              <Meta label="처음 관측" value={stamp(f.firstSeen)} />
              <Meta label="최근 관측" value={stamp(f.lastSeen)} />
              <Meta label="관측 횟수" value={num(f.seenCount)} />
              {confidence != null ? <Meta label="신뢰도" value={confidence.toFixed(2)} /> : null}
              {scanned != null ? <Meta label="스캔한 자산 수" value={num(scanned)} /> : null}
            </div>
          </Card>

          <Card className="px-4 py-3.5">
            <SectionTitle title="담당자" />
            <AssigneeBlock finding={f} />
          </Card>

          {/* 권장 조치 */}
          <Card className="px-4 py-3.5">
            <SectionTitle title="권장 조치" meta={actions.length > 0 ? `${actions.length}건` : undefined} />
            {actions.length === 0 ? (
              <Empty why="기록된 권장 조치가 없습니다" />
            ) : (
              <>
                <ol className="flex list-decimal flex-col gap-1.5 pl-4">
                  {actions.slice(0, CAP_ACTIONS).map((a, i) => (
                    <li key={i} className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink">
                      {a}
                    </li>
                  ))}
                </ol>
                <CapNote shown={Math.min(actions.length, CAP_ACTIONS)} total={actions.length} />
              </>
            )}
          </Card>

          {/* 도메인 메타 · 검증 */}
          {metaRows.length > 0 ? (
            <Card className="px-4 py-3.5">
              <SectionTitle title="메타 · 검증" />
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                {metaRows.map(([k, v, mono]) => (
                  <div key={k} className={mono ? "col-span-2" : ""}>
                    <Meta label={k} value={v} mono={mono} />
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── 조각들 ───────────────────────────────────────────────────────────────────

/** 담당자 — 티켓 상세의 `AssigneeChip` 과 같은 정책. ★`confirmed=false` 는 **추정**이라
 *  확정과 같은 모양으로 그리면 안 된다(조직 저장소는 GHES 에 담당자 개념이 없어 1위
 *  기여자로 대신한다). */
function AssigneeBlock({ finding }: { finding: GatewayFindingDetail }) {
  const a = finding.assignee;
  const status = asStr(a?.status);
  const email = asStr(a?.email);
  // 이름이 없어도 메일이 있으면 그 사람은 존재한다 — knox 대장에 없을 뿐이다(퇴직·이동).
  const name = asStr(a?.name) ?? (email ? email.split("@")[0] : null);

  if (!name) {
    const m = label(ASSIGNEE_STATUS, status ?? "unresolved", { label: "미상", tone: "muted" as const });
    return (
      <div className="text-[12.5px]" style={m.tone === "warn" ? { color: "#8f2f18" } : { color: "#8a7f6b" }}>
        {m.label || "미상"}
      </div>
    );
  }

  const dept = asStr(a?.dept);
  const title = asStr(a?.title);
  const sourceLabel = asStr(a?.sourceLabel);
  const estimated = a?.confirmed === false;
  const head = [name, title].filter(Boolean).join(" ");

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="grid h-[26px] w-[26px] place-items-center rounded border border-line bg-side font-serif text-[12.5px] text-walnut-ink">
          {name.slice(0, 1)}
        </span>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[12.5px] text-ink">{dept ? `${head} · ${dept}` : head}</div>
          {email ? <div className="truncate font-mono text-[10.5px] text-muted">{email}</div> : null}
        </div>
      </div>
      {sourceLabel ? (
        <div className="text-[10.5px]" style={estimated ? { color: "#7d5108" } : { color: "#8a7f6b" }}>
          {sourceLabel}
          {estimated ? " · 추정" : ""}
        </div>
      ) : null}
      {a?.ambiguous === true ? (
        <div className="text-[10.5px] text-muted">담당자 후보가 여럿입니다 — 한 명만 표시합니다.</div>
      ) : null}
    </div>
  );
}

/** 증거 hit 카드 — 길면 접고 '전문 보기'(마스킹된 미리보기). */
function HitCard({ hit }: { hit: DetailHit }) {
  const [open, setOpen] = useState(false);
  const preview = asStr(hit.preview) ?? "";
  const long = preview.length > PREVIEW_CLAMP;
  const shown = open || !long ? preview : preview.slice(0, PREVIEW_CLAMP) + "…";
  const lv = hit.loginValidation ?? null;
  // 모순이면 아무것도 주장하지 않는다 — 어느 쪽이 거짓인지 모른다.
  const tone = lv && !isContradictory(lv) ? loginTone(lv.result) : undefined;
  const category = asStr(hit.category);
  const kind = asStr(hit.kind);
  const location = asStr(hit.location);
  const lineNo = asNum(hit.lineNo);

  return (
    <li className="rounded-lg border border-line bg-card px-3 py-2">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[10.5px] text-muted">
        {category ? (
          <span
            className="rounded px-1.5 py-0.5 text-ink"
            style={{ background: CAT_TONE_HIT[category] ?? "#eae3d2" }}
          >
            {category}
          </span>
        ) : null}
        {kind ? <span className="font-mono">{kind}</span> : null}
        {lineNo != null ? <span className="font-mono">L{lineNo}</span> : null}
        {location ? <span className="min-w-0 break-all font-mono">· {location}</span> : null}
        {/* ★ 테두리 + '프로브' 접두로 category(자유 텍스트) pill 과 시각적으로 구별한다 —
            category 에 "로그인 검증됨" 을 써넣어 검증 배지를 흉내내는 표시 스푸핑 방어. */}
        {tone ? (
          <span
            className="rounded border px-1.5 py-0.5 font-medium"
            style={{ background: tone.bg, color: tone.fg, borderColor: tone.fg }}
            title="크리덴셜 로그인 프로브 결과(서버가 검증한 값)"
          >
            <span className="opacity-70">프로브</span> {tone.label}
          </span>
        ) : null}
      </div>
      {preview ? (
        <div
          className={`whitespace-pre-wrap break-all font-mono text-[11.5px] leading-relaxed ${open ? "max-h-72 overflow-y-auto" : ""}`}
        >
          {shown}
        </div>
      ) : null}
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-1 text-[11px] text-walnut hover:underline"
        >
          {open ? "접기" : `전문 보기 (${preview.length}자)`}
        </button>
      ) : null}
      {lv && tone ? <LoginValidationNote v={lv} tone={tone} /> : null}
    </li>
  );
}

/** 로그인 검증 상세 — 크리덴셜 '값' 이 아니라 **시도 결과라는 사실**만 보여준다.
 *  안전 정책 문구는 서버 문자열이 아니라 여기 고정 문구다(서버가 문구를 위조할 수 없게). */
function LoginValidationNote({
  v,
  tone,
}: {
  v: HitLoginValidation;
  tone: { fg: string; note: string };
}) {
  const engine = asStr(v.engine);
  const endpoint = asStr(v.endpoint);
  const principal = asStr(v.principalMasked);
  const ms = asNum(v.elapsedMs);
  return (
    <div className="mt-1.5 rounded border-l-2 bg-side px-2 py-1.5" style={{ borderColor: tone.fg }}>
      <p className="text-[11.5px] text-ink">{tone.note}</p>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10.5px] text-muted">
        {engine ? <span>engine {engine}</span> : null}
        {endpoint ? <span>endpoint {endpoint}</span> : null}
        {principal ? <span>계정 {principal}</span> : null}
        {ms != null ? <span>{ms}ms</span> : null}
      </div>
      <p className="mt-1 font-mono text-[10px] text-muted">
        {v.singleAttempt === true
          ? "단발 시도 · 쿼리/배치 없음 · 즉시 종료"
          : "시도 방식 미상"}{" "}
        · 중앙 원장 기록 · 계정명은 마스킹됨
      </p>
    </div>
  );
}

function ProbeRow({ probe, last }: { probe: PivotProbe; last: boolean }) {
  const url = asStr(probe.url) ?? "—";
  const status = asStr(probe.status) ?? "—";
  const ct = asStr(probe.contentType);
  return (
    <tr className={last ? "" : "border-b border-line/60"}>
      <td className="max-w-[280px] break-all px-3 py-2 font-mono">{url}</td>
      <td className="px-3 py-2 font-mono">{status}</td>
      <td className="px-3 py-2">
        <span
          className="rounded px-1.5 py-0.5 text-[10.5px]"
          style={
            probe.exposed
              ? { background: "#f2e1da", color: "#9a3620" }
              : { background: "#e8ecdb", color: "#5b6b45" }
          }
        >
          {probe.exposed ? "노출" : "정상"}
        </span>
      </td>
      <td className="break-all px-3 py-2 font-mono text-muted">{ct ?? "—"}</td>
    </tr>
  );
}

function NoteCard({ note }: { note: EvidenceNote }) {
  const location = asStr(note.location);
  const what = asStr(note.whatThisIs);
  const context = asStr(note.contextNote);
  // 필드'명'이지 값이 아니다 — 그래도 게이트웨이가 방어 재마스킹을 한 번 더 건다.
  const fields = asArr<string>(note.sensitiveFields).filter((s) => typeof s === "string" && s);
  return (
    <li className="rounded-lg border border-line bg-card px-3 py-2 text-[12px]">
      {location ? <div className="mb-1 break-all font-mono text-[10.5px] text-muted">{location}</div> : null}
      {what ? <div className="break-words leading-relaxed">{what}</div> : null}
      {fields.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {fields.map((s, i) => (
            <span key={i} className="rounded bg-side px-1.5 py-0.5 font-mono text-[10px] text-muted">
              {s}
            </span>
          ))}
        </div>
      ) : null}
      {context ? (
        <div className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-muted">{context}</div>
      ) : null}
    </li>
  );
}
