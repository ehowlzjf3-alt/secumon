"""smb hit 판정 도구 — DB 의 기존 hit 에 판정을 **되돌려 쓴다**.

## 왜 다시 생겼나

`e04250f`(2026-08-20, "도달 불가 도구 47개 제거")가 `triage_tools.py` 283줄을 지웠다.
그 안에 `set_hit_verdict` 가 있었고, 지운 뒤 재배선이 없었다. 결과(실측 2026-08-28):

  · `smb_file_hit` **16,204건 전량 `agent_verdict='pending'`**
  · hit 이 달린 share 28개는 **전부 `triaged_completed`** — 판정 없이 닫혔다
  · `private_key_block` 17건 중 finding 이 된 건 **1건**. 나머지 16건은 pending 인 채 종료

`file_hit_set_verdict` 는 계속 살아 있었다. 끊긴 것은 **워커가 그걸 부를 통로**였다.

## 왜 `read_hit_context` 는 안 되살리나

지운 모듈엔 `read_hit_context` 도 있었는데 그건 `smb.fetch_file(...)` 로 **파일을 직접
읽는** 도구다. 워커는 이미 `smb_fetch_scan`·`smb_task_python` 으로 본문을 읽을 수 있어
새 능력도 아니고, 파일을 여는 표면을 하나 더 늘릴 이유가 없다(사용자 결정 2026-08-28).
여기 둘은 **DB 만** 만진다 — 목록 읽기와 판정 쓰기.

## 스코프

`set_hit_verdict` 는 **지금 점검 중인 share 의 hit 만** 건드릴 수 있다. 스코프는
검토원 spec 이 준 share_ids 에서 온다 — LLM 이 고른 값이 아니다.
"""
from __future__ import annotations

import asyncio
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess

from service import state_domain as state

# 판정 대상 카테고리 기본값 — **위험도로 정한다. 건수로 정하지 않는다.**
#
# ⚠️ 첫 판은 "pii/공정은 건수가 커서" 라는 이유로 둘 다 뺐다. 그 결과 기본 범위가
#    전체 hit 의 **5.2%**(2,105/40,451)였고, **반도체 공정 자료 4,251건이 통째로**
#    빠져 있었다. 여긴 반도체 회사이고 공정 자료가 핵심 위험이다 —
#    건수를 범위 기준으로 쓰는 건 `.claude/skills/measure-first` 가 명시적으로 금한다.
#
# pii 34,092건은 여전히 기본에서 뺀다. 이유가 다르다 — **건수가 아니라 분포**다:
# 파일 1,536개 중 **상위 3개가 50%**(robot framework output.xml 2개에 15,105건).
# 기계가 뱉은 테스트 산출물이라 hit 단위 판정이 의미가 없다. pii 는 파일 축으로
# 따로 다뤄야 하고, 그건 이 도구의 일이 아니다. 필요하면 categories 로 명시해 넓힌다.
DEFAULT_TRIAGE_CATEGORIES: tuple[str, ...] = (
    "secret", "business_confidential", "semiconductor_process",
)


def _scope_share_ids(context: ToolContext) -> list[int]:
    """이 세션이 만질 수 있는 share — spec 이 준 값만. LLM 입력이 아니다."""
    raw = (context.metadata or {}).get("smb_share_ids") or []
    out: list[int] = []
    for x in raw:
        try:
            out.append(int(x))
        except (TypeError, ValueError):
            continue
    return out


class ListPendingHitsInput(BaseModel):
    categories: list[str] | None = Field(
        None, description=f"기본 {list(DEFAULT_TRIAGE_CATEGORIES)}. 넓히려면 명시."
    )
    limit: int = Field(200, ge=1, le=1000)


class SmbListPendingHitsTool(Tool[ListPendingHitsInput]):
    name: ClassVar[str] = "smb_list_pending_hits"
    domain: ClassVar[str] = "smb"
    description: ClassVar[str] = (
        "수집기 정규식이 미리 걸어 둔 후보 목록(hit_id 포함).\n"
        "★ **이건 시작점이지 네 일의 전부가 아니다.** 정규식이 잡은 것만 판정하고 끝내면 "
        "정규식이 못 잡는 위험을 통째로 놓친다 — 공유를 직접 훑어 이 목록에 없는 것도 찾아라. "
        "이 목록을 다 비웠다는 것은 '깨끗하다' 는 뜻이 **아니다**.\n"
        "각 건은 **원문을 확인한 뒤에만** smb_set_hit_verdict 로 판정하라. 확인 없이 "
        "일괄 기각하지 마라 — 기록은 감사 대상이다. 실제 노출이면 판정만 하지 말고 "
        "smb_submit_finding 으로도 제출해야 한다.\n"
        "기본 범위는 secret / business_confidential / semiconductor_process 다. "
        "pii 는 소수 파일에 몰려 있어(상위 3파일이 50%) hit 단위 판정이 안 맞으므로 "
        "기본에서 빠져 있다 — 필요하면 categories 로 명시해 넓혀라."
    )
    input_model: ClassVar[type[BaseModel]] = ListPendingHitsInput
    search_hint: ClassVar[str] = "pending hits triage list candidates secret"
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input: ListPendingHitsInput, context: ToolContext) -> ToolResult:
        share_ids = _scope_share_ids(context)
        if not share_ids:
            return ToolError(kind="execution", message="smb_share_ids 가 spec 에 없다")
        cats = tuple(validated_input.categories) if validated_input.categories else DEFAULT_TRIAGE_CATEGORIES
        rows: list[dict[str, Any]] = []
        for sid in share_ids:
            rows += await asyncio.to_thread(
                state.share_hits_pending, sid, categories=cats, limit=validated_input.limit,
            )
        if not rows:
            return ToolSuccess(content="판정 대기 hit 없음 (categories=" + ",".join(cats) + ")")

        # ⚠️ **잘림을 숨기지 마라.** `share_hits_pending` 의 ORDER BY 는
        #    `h.category, h.kind, f.path, h.line_no` 로 **알파벳순**이라, 캡에 걸리면
        #    `semiconductor_process` 가 (b < p < s < se 이므로) **제일 먼저 잘린다**.
        #    조용히 자르면 워커는 "이게 전부" 로 읽고 공정 자료를 통째로 못 본다.
        #
        #    정렬을 위험도순으로 바꾸는 건 여기서 안 한다 — 이 레포의 정렬 정본은
        #    `_shared/hit_view.CATEGORY_PRIORITY` 하나이고 `state_domain` 안에 목록을
        #    복사하는 건 명문으로 금지돼 있다(`share_hit_shapes` 도크스트링).
        #    게다가 그 정본은 공정을 pii **아래**에 두고 테스트가 그걸 고정한다 —
        #    어휘 자체가 결정 사항이라 조용히 뒤집으면 안 된다. 그래서 **알린다**.
        remaining: dict[str, int] = {}
        for cat in cats:
            total = 0
            for sid in share_ids:
                total += await asyncio.to_thread(
                    state.share_hits_pending_count, sid, categories=(cat,))
            if total:
                remaining[cat] = total
        shown = min(len(rows), validated_input.limit)
        head = f"판정 대기 {sum(remaining.values())}건 — categories={','.join(cats)}"
        if shown < sum(remaining.values()):
            head += (f"\n⚠️ 아래는 {shown}건만이다. 카테고리별 전체: {remaining} — "
                     f"categories 로 좁히거나 limit 을 올려 나머지도 봐라.")
        lines = [head]
        for r in rows[: validated_input.limit]:
            lines.append(
                f"  hit_id={r['id']} [{r['category']}/{r['kind']}] "
                f"{r['path']}:{r.get('line_no') or '-'}  {r.get('masked') or ''}"
            )
        return ToolSuccess(content="\n".join(lines))


class SetHitVerdictInput(BaseModel):
    hit_id: int
    verdict: Literal["confirmed", "false_positive"]
    confidence: float | None = Field(None, ge=0.0, le=1.0)
    note: str | None = Field(None, max_length=300, description="짧은 사유. 민감값 넣지 마라.")


class SmbSetHitVerdictTool(Tool[SetHitVerdictInput]):
    name: ClassVar[str] = "smb_set_hit_verdict"
    domain: ClassVar[str] = "smb"
    description: ClassVar[str] = (
        "hit 한 건에 판정 기록 (confirmed | false_positive). note 는 **확인한 관찰**을 "
        "적어라 — 원문을 보지 않은 일괄 기각은 정책 위반이고 감사 대상이다.\n"
        "confirmed 는 '실제 노출' 이라는 뜻이다. 그 경우 smb_submit_finding 으로도 "
        "제출해야 한다 — 여기 기록만으로는 보고가 나가지 않는다."
    )
    input_model: ClassVar[type[BaseModel]] = SetHitVerdictInput
    search_hint: ClassVar[str] = "verdict confirmed false positive hit triage"
    is_read_only: ClassVar[bool] = False

    async def execute(self, validated_input: SetHitVerdictInput, context: ToolContext) -> ToolResult:
        share_ids = _scope_share_ids(context)
        if not share_ids:
            return ToolError(kind="execution", message="smb_share_ids 가 spec 에 없다")
        # ⚠️ 스코프 검사는 **DB 로** 한다 — hit_id 는 LLM 입력이라 남의 공유를 가리킬 수 있다.
        owned = await asyncio.to_thread(_hit_in_shares, validated_input.hit_id, share_ids)
        if not owned:
            return ToolError(
                kind="forbidden",
                message=f"hit_id {validated_input.hit_id} 는 이번 점검 범위 밖이다",
            )
        try:
            await asyncio.to_thread(
                state.file_hit_set_verdict,
                validated_input.hit_id,
                verdict=validated_input.verdict,
                confidence=validated_input.confidence,
                note=validated_input.note,
            )
        except Exception as e:  # noqa: BLE001
            return ToolError(kind="execution", message=repr(e))
        return ToolSuccess(content=f"hit#{validated_input.hit_id} → {validated_input.verdict}")


def _hit_in_shares(hit_id: int, share_ids: list[int]) -> bool:
    with state.connect() as c:
        r = c.execute(
            "SELECT 1 FROM smb_file_hit h JOIN smb_file f ON f.id=h.file_id "
            "WHERE h.id=? AND f.share_id IN (" + ",".join("?" for _ in share_ids) + ")",
            [int(hit_id), *[int(s) for s in share_ids]],
        ).fetchone()
    return r is not None
