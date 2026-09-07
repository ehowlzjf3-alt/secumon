/**
 * 메일 서식 — 정적 카탈로그 열람 전용 화면.
 *
 * API 호출이 없다. 문구는 전부 스킬 저장소의 파이썬 f-string 안에 있고(=편집 대상 파일이
 * 존재하지 않는다), `lib/mailTemplates.ts` 가 그 조사 결과를 손으로 적어둔 것이다.
 * 그래서 여기서는 "무엇이 어떤 서식을 쓰는가" 만 보여주고 쓰기 경로는 만들지 않는다.
 *
 * ⚠️ 카탈로그는 코드와 자동 동기화되지 않는다(mailTemplates.ts 머리 주석 참조).
 *    화면에 "편집 불가" 를 배지로 못 박는 이유다.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { Card, Empty } from "../components/ui";
import { Icon } from "../shell/icons";
import { asStr, label, num } from "../lib/guards";
import { DOMAIN_COLOR, DOMAIN_LABEL, DOMAIN_TINT } from "../lib/soarMeta";
import { MAIL_TEMPLATES, templatesByDomain } from "../lib/mailTemplates";
import type { MailTemplate } from "../lib/mailTemplates";

/** 정적 데이터라 렌더마다 다시 묶을 이유가 없다. */
const TREE = templatesByDomain();

/** 도메인 색·틴트·라벨 — 서버가 아닌 고정 어휘지만 조회는 guards 로 통일한다. */
function domainSkin(domain: string) {
  return {
    name: label(DOMAIN_LABEL, domain, domain),
    color: label(DOMAIN_COLOR, domain, "#8a7f6b"),
    tint: label(DOMAIN_TINT, domain, "#f4ece2"),
  };
}

/** 좌측 트리 우측 배지 — 보관 통수 / 미보관 / 서식 없음. */
function TreeBadge({ t }: { t: MailTemplate }) {
  const base = "shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-mono tabular-nums";
  if (t.state === "unimplemented") {
    return (
      <span
        className="shrink-0 rounded border border-dashed px-1.5 py-0.5 text-[10.5px]"
        style={{ borderColor: "#e0bfb2", color: "#8f2f18" }}
      >
        서식 없음
      </span>
    );
  }
  if (t.archive) {
    return (
      <span className={base} style={{ background: "#e4ece4", color: "#2f6b45" }}>
        {num(t.archive.count)}통
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px]" style={{ background: "#f0ece2", color: "#a89c86" }}>
      미보관
    </span>
  );
}

/** 속성 5칸 중 한 칸. */
function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] text-muted">{name}</div>
      <div className="text-[12.5px] leading-snug text-ink">{children}</div>
    </div>
  );
}

/** 본문 구성 알약 — 들어감 / 제안 / 없음 세 가지 톤. */
function SectionChip({
  section, tint, color,
}: { section: { label: string; on: boolean; proposed?: boolean }; tint: string; color: string }) {
  const text = asStr(section.label);
  if (text === null) return null;
  if (section.on) {
    return (
      <span
        className="rounded-full px-2.5 py-1 text-[11.5px]"
        style={{ background: tint, color, border: "1px solid transparent" }}
      >
        {text}
      </span>
    );
  }
  if (section.proposed) {
    return (
      <span
        className="rounded-full px-2.5 py-1 text-[11.5px]"
        style={{ background: "#f6efe2", color: "#8a5c10", border: "1px dashed #d9b877" }}
      >
        {text}
        <span className="ml-1 text-[10px]">제안</span>
      </span>
    );
  }
  return (
    <span
      className="rounded-full px-2.5 py-1 text-[11.5px]"
      style={{ background: "#f4f1e9", color: "#a89c86", border: "1px solid transparent" }}
    >
      {text}
    </span>
  );
}

/** 우측 상세. */
function Detail({ t }: { t: MailTemplate }) {
  const skin = domainSkin(t.domain);
  const live = t.state === "live";
  const tail = asStr(t.subjectTail);
  const note = asStr(t.note);

  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 머리 — 도메인 · 종류, 편집 불가 잠금, 미구현 표시 */}
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-3">
          <span className="h-[8px] w-[8px] shrink-0 rounded-full" style={{ background: skin.color }} />
          <h2 className="font-serif text-[15.5px] text-ink">
            {skin.name} · {asStr(t.kind) ?? "—"}
          </h2>
          {live ? null : (
            <span className="rounded-md px-2 py-1 text-[11.5px]" style={{ background: "#f6e7e2", color: "#8f2f18" }}>
              미구현
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-line bg-[#f0ece2] px-2.5 py-1 text-[11.5px] text-muted">
            <Icon name="lock" className="h-3.5 w-3.5" />
            코드에 내장 · 편집 불가
          </span>
        </div>

        {/* 제목 — subjectPrefix 는 회신을 스레드에 붙이는 유일한 키라 자물쇠로 표시한다. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <span className="w-[52px] shrink-0 text-[11px] text-muted">제목</span>
          {live ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[#d8c9a8] px-2.5 py-1 font-mono text-[12px] text-walnut-ink">
              <Icon name="lock" className="h-3 w-3 shrink-0" />
              {asStr(t.subjectPrefix) ?? "—"}
            </span>
          ) : (
            <span className="font-mono text-[12px] text-muted">{asStr(t.subjectPrefix) ?? "—"}</span>
          )}
          {tail ? <span className="text-[12.5px] text-ink">{tail}</span> : null}
        </div>

        {live ? (
          <>
            {/* 속성 5칸 */}
            <div className="grid grid-cols-5 gap-x-3 gap-y-2 border-b border-line px-4 py-3">
              <Field name="받는 사람">{asStr(t.recipient) ?? "—"}</Field>
              <Field name="담당자 발송">
                {t.deliversToOwner ? "감" : <span style={{ color: "#8f2f18" }}>DSSOC 로만</span>}
              </Field>
              <Field name="표">
                {t.table ? (
                  <span className="text-[12px]">{t.table}</span>
                ) : (
                  <span className="text-muted">없음</span>
                )}
              </Field>
              <Field name="서명">
                {t.signature ? "있음" : <span className="text-muted">없음</span>}
              </Field>
              <Field name="보낸 본문 보관">
                {t.archive ? (
                  <>
                    <span className="font-mono tabular-nums">{num(t.archive.count)}</span>통
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted" title={t.archive.where}>
                      {t.archive.where}
                    </div>
                  </>
                ) : (
                  <span style={{ color: "#8f2f18" }}>안 함</span>
                )}
              </Field>
            </div>

            {/* 본문 구성 */}
            <div className="px-4 py-3">
              <div className="mb-2 text-[11px] text-muted">구성</div>
              {t.sections.length === 0 ? (
                <span className="text-[12.5px] text-muted">없음</span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {t.sections.map((s, i) => (
                    <SectionChip key={`${s.label}-${i}`} section={s} tint={skin.tint} color={skin.color} />
                  ))}
                </div>
              )}
            </div>

            {/* 조사 메모 — 카탈로그가 들고 있는 데이터 그대로 */}
            {/* 본문 얼개 — sections 를 실제 메일 순서대로 세운 뼈대다.
                본문 원문은 못 보여준다(SMB 만 저장되고, 그마저 게이트웨이 GRANT 밖이다).
                그래서 "무엇이 어떤 순서로 들어가는가" 만 구조로 보여준다 — 지어낸 샘플이 아니다. */}
            <div className="border-t border-line/60 px-4 py-3">
              <div className="mb-2 text-[11px] text-muted">본문 얼개</div>
              <div className="mx-auto max-w-[520px] overflow-hidden rounded-lg border border-line bg-white">
                {t.sections
                  .filter((sec) => sec.on || sec.proposed)
                  .map((sec) => {
                    const isHead = sec.label === "머리글";
                    const isTable = sec.label.includes("표");
                    const isSign = sec.label === "서명";
                    return (
                      <div
                        key={sec.label}
                        className="border-b border-[#eef0f3] px-3 py-2 last:border-b-0"
                        style={
                          isHead
                            ? { background: skin.color, color: "#fff" }
                            : sec.proposed
                              ? { background: "#fdf6e9", borderStyle: "dashed", borderColor: "#e0cfa8" }
                              : undefined
                        }
                      >
                        <div className={`text-[11px] ${isHead ? "text-white" : sec.proposed ? "text-[#8a5c10]" : "text-[#64748b]"}`}>
                          {sec.label}
                          {sec.proposed ? " · 제안" : ""}
                        </div>
                        {/* 회색 줄로 분량감만 — 글자를 지어내지 않는다. */}
                        {isTable ? (
                          <div className="mt-1.5 space-y-[3px]">
                            {[0, 1, 2].map((i) => (
                              <div key={i} className="flex gap-[3px]">
                                {[0, 1, 2, 3].map((j) => (
                                  <span
                                    key={j}
                                    className="h-[6px] flex-1 rounded-[1px]"
                                    style={{ background: i === 0 ? "#cbd5e1" : "#eef2f6" }}
                                  />
                                ))}
                              </div>
                            ))}
                          </div>
                        ) : isHead || isSign ? null : (
                          <div className="mt-1.5 space-y-[3px]">
                            <span className="block h-[5px] w-full rounded-[1px] bg-[#eef2f6]" />
                            <span className="block h-[5px] w-3/5 rounded-[1px] bg-[#eef2f6]" />
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>

            {note ? (
              <div className="border-t border-line/60 px-4 py-2.5 text-[12px] leading-snug text-muted">{note}</div>
            ) : null}
          </>
        ) : (
          <Empty why="이 서식은 아직 없습니다" hint={note ?? undefined} />
        )}
      </div>
    </Card>
  );
}

export function MailTemplates() {
  const [selectedId, setSelectedId] = useState("smb-report");
  const current = MAIL_TEMPLATES.find((t) => t.id === selectedId);

  return (
    <div className="grid h-full grid-cols-[288px_1fr] gap-3 p-4">
      {/* 좌 — 도메인별 트리 */}
      <Card className="flex min-h-0 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          {TREE.map(({ domain, items }) => {
            const skin = domainSkin(domain);
            return (
              <div key={domain} className="mb-1">
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <span className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: skin.color }} />
                  <span className="font-serif text-[12.5px] text-walnut-ink">{skin.name}</span>
                </div>
                {items.length === 0 ? (
                  <div className="px-3 pb-1.5 pl-[22px] text-[11.5px] text-muted">서식 없음</div>
                ) : (
                  items.map((t) => {
                    const sel = t.id === selectedId;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setSelectedId(t.id)}
                        aria-pressed={sel}
                        className={[
                          "flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left transition-colors",
                          sel ? "bg-[#f4ece2]" : "border-transparent hover:bg-[#fdf9ef]",
                        ].join(" ")}
                        style={sel ? { borderLeftColor: skin.color } : undefined}
                      >
                        <span className={`min-w-0 flex-1 truncate text-[12.5px] ${sel ? "text-walnut-ink" : "text-ink"}`}>
                          {asStr(t.kind) ?? t.id}
                        </span>
                        <TreeBadge t={t} />
                      </button>
                    );
                  })
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* 우 — 선택된 서식 */}
      {current ? (
        <Detail t={current} />
      ) : (
        <Card className="flex min-h-0 items-center justify-center overflow-hidden">
          <Empty why="선택된 서식이 없습니다" hint="왼쪽 목록에서 서식을 고르세요" />
        </Card>
      )}
    </div>
  );
}
