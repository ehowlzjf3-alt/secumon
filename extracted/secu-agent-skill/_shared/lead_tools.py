"""리드 도구셋 — 도메인 무관 5개, 이름 고정 (Phase 2a).

## 경계는 도구 등록이다

`exec_guard` 레드팀 결론과 같다 — **프롬프트 가드는 경계가 아니다.** 리드가 본문을 못
보는 이유는 "보지 말라고 시켜서"가 아니라 본문을 반환하는 도구가 **레지스트리에 없어서**다.

여기 없는 것(의도적):
- 임의 실행(`smb_task_python`) — 반환값을 구조적으로 통제할 수 없다.
- 본문 반환(`read_file_quick` / `confluence_fetch_page` / `web_fetch`) — 정의상 차단 대상.
- 코어 `agent` — 있으면 리드가 마스킹을 우회해 검토원을 직접 부를 수 있다.
  (`delegate_inspect` 가 `AgentTool` 을 **상속**해서 대신한다 — 아래 참조.)

## 마스킹은 base 클래스가 강제한다

`LeadTool.execute` 하나만 정의하고 서브클래스는 `_run` 을 구현한다. 코어 검문소
(`Tool.__init_subclass__`)는 **자기 클래스에 `execute` 를 정의한 서브클래스만** 새로
래핑하므로, `_run` 만 가진 서브클래스는 `LeadTool.execute` 를 그대로 상속한다 —
즉 **마스킹을 건너뛰는 리드 도구를 실수로 만들 수 없다.**
(`test_lead_tools_mask.py` 가 "리드 도구 중 execute 를 자기가 정의한 것 0" 을 고정한다.)

## delegate_inspect 가 AgentTool 을 상속하는 이유

코어 v3.89 검문소는 `OtherTool().execute()` 직접 호출을 차단한다(permit 결박).
합법 경로는 둘뿐이다:
  1. `ctx.invoke_tool("agent", ...)` → 그러려면 `agent` 가 리드 레지스트리에 있어야
     하고, 그러면 리드 LLM 이 직접 불러 마스킹을 우회한다. **탈락.**
  2. 같은 self 의 `super().execute()` — 검문소가 명시적으로 허용하는 협조상속 체인.
따라서 상속이 유일하게 옳은 배관이다. 위임 로직은 코어 그대로 쓰고(재구현 없음),
결과만 봉투로 재조립한다.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field

from secu_agent.agent.tools.agent_tool import AgentInput, AgentTool
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)

from _shared.inspector_channel import (
    answer_from_evidence, resolve_new_sub_dir, sub_dirs,
)
from _shared.lead_adapter import LeadAdapter, get_lead_adapter, lead_adapter_names
from _shared.lead_masking import mask_text_for_lead, mask_tool_content

log = logging.getLogger("shared.lead_tools")

LEAD_DOMAIN_KEY = "lead_domain"

_PIVOT_LOG = "lead_pivots.jsonl"

# 권고를 뒤집을 때 요구하는 최소 근거 길이. "ok" / "확인" 같은 통과용 한 글자를 막는다.
_MIN_OVERRIDE_REASON = 10


def _append_pivot(ctx: ToolContext, entry: dict) -> str | None:
    """피벗/뒤집기 저널에 한 줄. 실패하면 사유 문자열, 성공이면 None.

    `record_pivot` 과 `set_target_status`(권고 뒤집기)가 **같은 저널**에 쓴다 —
    "무엇을 보고 왜 그렇게 판단했는가" 는 둘 다 같은 종류의 기록이다.
    """
    if ctx.audit_log is not None:
        try:
            ctx.audit_log.append("lead_pivot", dict(entry))
        except Exception:  # noqa: BLE001
            log.exception("lead_pivot audit 기록 실패 — 파일 기록은 계속한다")
    try:
        with (ctx.evidence_dir / _PIVOT_LOG).open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
    except OSError as e:
        return f"pivot 기록 실패: {e!r}"
    return None


def _pivots_so_far(ctx: ToolContext) -> list[dict]:
    """이번 런의 저널. 반환에 실어 주면 리드가 "블랙홀에 던졌나" 를 안 묻는다."""
    out: list[dict] = []
    try:
        raw = (ctx.evidence_dir / _PIVOT_LOG).read_text(encoding="utf-8")
    except OSError:
        return out
    for line in raw.splitlines():
        try:
            got = json.loads(line)
        except ValueError:
            continue
        if isinstance(got, dict):
            out.append(got)
    return out


def _adapter_for(ctx: ToolContext) -> LeadAdapter | ToolError:
    domain = str((ctx.metadata or {}).get(LEAD_DOMAIN_KEY) or "").strip()
    if not domain:
        return ToolError(
            kind="execution",
            message=(
                f"리드 컨텍스트에 {LEAD_DOMAIN_KEY} 가 없다 — 리드 계약이 metadata 를 "
                f"안 실었다(배선 버그). 등록된 도메인: {list(lead_adapter_names())}"
            ),
        )
    adapter = get_lead_adapter(domain)
    if adapter is None:
        return ToolError(
            kind="not_found",
            message=(
                f"리드 어댑터 미등록: {domain!r} — bootstrap 의 register_lead_adapter "
                f"누락. 등록된 도메인: {list(lead_adapter_names())}"
            ),
        )
    return adapter


class LeadTool[TInput: BaseModel](Tool[TInput]):
    """리드 도구 base — 반환 문자열이 **반드시** 마스킹을 통과한다.

    서브클래스는 `execute` 를 정의하지 말고 `_run` 을 구현한다. `execute` 를 정의하면
    코어가 그 서브클래스를 따로 래핑해 여기 마스킹을 건너뛴다.
    """

    domain: ClassVar[str] = "lead"
    is_read_only: ClassVar[bool] = False

    async def _run(self, vi: TInput, ctx: ToolContext) -> ToolResult:
        raise NotImplementedError

    async def execute(self, validated_input: TInput, ctx: ToolContext) -> ToolResult:
        result = await self._run(validated_input, ctx)
        if isinstance(result, ToolSuccess):
            # images 는 리드에 절대 넘기지 않는다 — 스크린샷은 본문이다.
            return ToolSuccess(content=mask_tool_content(result.content))
        if isinstance(result, ToolError):
            return ToolError(kind=result.kind, message=mask_text_for_lead(result.message))
        return result


# ── 1. list_targets ───────────────────────────────────────────────────

class ListTargetsInput(BaseModel):
    status: str | None = Field(
        None, max_length=32,
        description="상태 필터 (없으면 전체). 허용값은 도구 설명의 statuses 참조.",
    )
    limit: int = Field(20, ge=1, le=200)


class ListTargetsTool(LeadTool[ListTargetsInput]):
    name: ClassVar[str] = "list_targets"
    input_model: ClassVar[type[BaseModel]] = ListTargetsInput
    is_read_only: ClassVar[bool] = True
    search_hint: ClassVar[str] = "lead queue targets list pending backlog"
    description: ClassVar[str] = (
        "이 리드가 소유한 큐의 타깃 목록 — 좌표와 메타만(본문 없음). "
        "JSON {domain, queue, total, items[]} 반환. "
        "claim 하지 않는다 — 목록을 봐도 큐 상태는 안 바뀐다."
    )

    async def _run(self, vi: ListTargetsInput, ctx: ToolContext) -> ToolResult:
        adapter = _adapter_for(ctx)
        if isinstance(adapter, ToolError):
            return adapter
        try:
            rows = adapter.list_targets(status=vi.status, limit=vi.limit)
        except Exception as e:  # noqa: BLE001
            return ToolError(kind="execution", message=f"list_targets 실패: {e!r}")
        if rows:
            # 큐에 row 가 보이면 "닫을 게 없다" 는 더 이상 사실이 아니다.
            _revoke_terminal_waiver(ctx)
        payload: dict[str, Any] = {
            "domain": adapter.domain,
            "queue": adapter.queue_label,
            "statuses": list(adapter.statuses),
            # ★ "아직 볼 게 남은" 상태를 **항상** 알려준다. 이게 없으면 리드가
            #   `pending` 을 찍어보고 0건이면 큐가 빈 줄 안다.
            "claimable_statuses": list(adapter.claimable_statuses),
            "total": len(rows),
            "items": rows,
        }
        if vi.status and not rows:
            # ★ 실기동 2회 같은 자리에서 데였다.
            #   2026-08-26 confluence.lead: turn1 `status='pending'` → 0건 (turn2 에 회복)
            #   2026-08-27 dev_web.lead   : turn1 `status='pending'` → 0건 → **3턴 무행동 후
            #                               contract_violation 으로 사망**. 그날 dev_web 큐는
            #                               skipped 1769 / tasked 831 / in_progress 4 였고
            #                               `pending` 만 0 이었다. 큐는 비지 않았다.
            #   같은 함정이 `lead_adapter.py:63` 에 러너 버전으로 이미 적혀 있다 —
            #   그때는 러너를 고쳤고 이번엔 **LLM 리드**가 같은 짓을 했다.
            #
            # 빈 목록에 이유를 붙여 보낸다. 조용한 0건은 "큐가 깨끗하다" 로 읽힌다.
            probe = {}
            try:
                sample = adapter.list_targets(status=None, limit=max(vi.limit, 50))
                for r in sample:
                    st = str((r or {}).get("status") or "?")
                    probe[st] = probe.get(st, 0) + 1
            except Exception:  # noqa: BLE001 — 힌트 실패가 목록 조회를 죽이지 않는다
                probe = {}
            payload["note"] = (
                f"status={vi.status!r} 에는 0건이다. **큐가 비었다는 뜻이 아니다** — "
                f"이 큐에서 아직 볼 게 남은 상태는 {list(adapter.claimable_statuses)} 다. "
                "필터 없이 다시 부르거나 그 상태로 물어라."
            )
            if probe:
                payload["status_counts_sample"] = probe
        elif not vi.status and not rows:
            # ★ 필터 없이 0건 — 여기가 진짜 빈 큐다. 예전엔 아무 말도 안 했고,
            #   리드는 닫을 게 없는 채로 종료 계약을 만족시키라는 요구를 받아
            #   리마인더 2회 뒤 contract_violation 으로 죽었다(실측 2026-08-27: 19건).
            payload["note"] = (
                f"{adapter.queue_label} 에 row 가 하나도 없다 — 닫을 대상이 원리적으로 "
                "없다. `report_no_targets(observed=...)` 로 끝내라(그 도구가 큐를 다시 "
                "확인한다). '없다' 고 글로 쓰는 것으로는 이 런이 끝나지 않는다."
            )
        return ToolSuccess(content=json.dumps(payload, ensure_ascii=False, default=str))


# ── 2. target_detail ──────────────────────────────────────────────────

class TargetDetailInput(BaseModel):
    target_id: int = Field(..., description="list_targets 가 준 id")


# ══════════════════════════════════════════════════════════════════════
# 열람 장부 — "본 적 없는 타깃을 닫지 마라" 를 **강제한다** (2026-08-26)
# ══════════════════════════════════════════════════════════════════════
#
# 계약(`_shared/skills/lead/lead.md`)은 처음부터 이렇게 적고 있었다:
#
#     "열어보지도 않은 타깃을 tasked 로 닫지 마라. 안 볼 거면 skipped + 이유다."
#
# 그런데 강제가 없었다. `set_target_status` 의 뒤집기 검사는 **검토원 권고가 있을 때만**
# 작동하고, 아예 안 본 타깃엔 권고가 없으니 그냥 닫혔다.
#
# ★ 실기동에서 터졌다 (2026-08-26 19:35, confluence.lead 컷오버 첫 사이클):
#
#     turn 1  list_targets(status='pending')     → 0건
#     turn 2  list_targets(limit=50)
#     turn 4  set_target_status(1, skipped) … set_target_status(25, skipped)
#
#   target_detail·target_hit_summary·verify·open_inspection **한 번도 안 부르고**
#   25개 스페이스를 통째로 닫았다. 상태는 이미 skipped 라 안 바뀌었지만
#   `cycle_scanned_at` 이 갱신돼 **이번 주 정상 재스캔이 막혔다**(되돌렸다).
#
# 그래서 "무엇을 실제로 봤나" 를 런 단위로 기록하고, 안 본 것을 닫으려 하면 이유를 묻는다.
# `list_targets` 는 **열람이 아니다** — 큐 개요이지 타깃을 본 게 아니다.

# evidence_dir → 이번 런에서 실제로 들여다본 target_id 들
_EXAMINED: dict[str, set[int]] = {}


#: evidence_dir → 이번 런에서 실제로 **닫힌** target_id. set_target_status 성공에서만 찬다.
#: "일 다 해놓고 종료를 글로만" 을 막는 장부 — 열어본 것과 닫은 것의 차이를 본다.
_CLOSED: dict[str, set[int]] = {}


def _revoke_terminal_waiver(ctx: Any) -> None:
    """종료 계약 면제를 회수한다.

    면제는 "이 시점 이후 아무 일도 안 했다" 는 주장이다. 무언가를 들여다보거나
    큐에서 row 를 본 순간 그 주장은 거짓이 되므로 회수한다 — 이게 없으면
    **"면제 먼저 받고 일은 나중에"** 로 계약이 그대로 뚫린다.
    """
    try:
        from secu_agent.agent.terminal_contract import TERMINAL_WAIVED_KEY

        md = getattr(ctx, "metadata", None)
        if isinstance(md, dict):
            md.pop(TERMINAL_WAIVED_KEY, None)
    except Exception:  # noqa: BLE001 — 회수 실패가 도구를 죽이지 않는다
        pass


def _mark_examined(ctx: Any, target_id: Any) -> None:
    try:
        key = str(getattr(ctx, "evidence_dir", "") or "")
        _EXAMINED.setdefault(key, set()).add(int(target_id))
    except (TypeError, ValueError):
        pass
    _revoke_terminal_waiver(ctx)


def _mark_closed(ctx: Any, target_id: Any) -> None:
    try:
        key = str(getattr(ctx, "evidence_dir", "") or "")
        _CLOSED.setdefault(key, set()).add(int(target_id))
    except (TypeError, ValueError):
        pass


def _was_examined(ctx: Any, target_id: Any) -> bool:
    try:
        key = str(getattr(ctx, "evidence_dir", "") or "")
        return int(target_id) in _EXAMINED.get(key, set())
    except (TypeError, ValueError):
        return False


def examined_reset_for_test() -> None:
    _EXAMINED.clear()
    _CLOSED.clear()


class TargetDetailTool(LeadTool[TargetDetailInput]):
    name: ClassVar[str] = "target_detail"
    input_model: ClassVar[type[BaseModel]] = TargetDetailInput
    is_read_only: ClassVar[bool] = True
    search_hint: ClassVar[str] = "lead target detail files pages metadata"
    description: ClassVar[str] = (
        "타깃 1개 상세 — 경로/파일·페이지 **목록**, 크기, 상태, 기존 finding 요약. "
        "본문은 반환하지 않는다(설계). 본문 확인이 필요하면 delegate_inspect 로 위임하라."
    )

    async def _run(self, vi: TargetDetailInput, ctx: ToolContext) -> ToolResult:
        _mark_examined(ctx, vi.target_id)
        adapter = _adapter_for(ctx)
        if isinstance(adapter, ToolError):
            return adapter
        try:
            detail = adapter.target_detail(vi.target_id)
        except Exception as e:  # noqa: BLE001
            return ToolError(kind="execution", message=f"target_detail 실패: {e!r}")
        if not detail:
            return ToolError(
                kind="not_found",
                message=f"{adapter.queue_label} 타깃 없음: {vi.target_id}",
            )
        return ToolSuccess(content=json.dumps(
            {"domain": adapter.domain, **detail}, ensure_ascii=False, default=str))


# ── 2b. target_hit_summary — 리드의 눈 (v3.98) ────────────────────────
#
# 리드가 목록만 보고 판단하던 것을 고친다. 재료는 DB 에 이미 있었다 — 통로가 없었을 뿐이다.
# 경계 규칙과 캡은 전부 `_shared/hit_view.py` 에 있다(여기서 다시 쓰지 않는다).
#
# ★ 봉투는 **이 도구가** 조립한다. 어댑터가 `build_hit_summary` 를 부르게 하면
#   어댑터 하나가 캡을 건너뛸 수 있다 — 경계는 도메인마다가 아니라 한 곳이어야 한다.

class TargetHitSummaryInput(BaseModel):
    target_id: int = Field(..., description="list_targets 가 준 id")
    category: str | None = Field(
        None, max_length=64, description="카테고리로 좁히기(secret/pii/credential/…)")
    kind: str | None = Field(None, max_length=64, description="탐지 종류로 좁히기")
    verdict: str | None = Field(
        None, max_length=32,
        description="판정으로 좁히기(pending/false_positive/confirmed/…)")
    limit: int = Field(20, ge=1, le=20, description="shapes 최대 행수")


class TargetHitSummaryTool(LeadTool[TargetHitSummaryInput]):
    name: ClassVar[str] = "target_hit_summary"
    input_model: ClassVar[type[BaseModel]] = TargetHitSummaryInput
    is_read_only: ClassVar[bool] = True
    is_concurrency_safe: ClassVar[bool | None] = True
    search_hint: ClassVar[str] = "lead target hits scan detections rollup shapes evidence"
    description: ClassVar[str] = (
        "이 타깃에서 **이미 탐지된 것**의 요약 — 위임하기 전에 먼저 봐라.\n"
        "rollup: 카테고리/종류별 건수. shapes: 값별 집계(같은 값이 몇 번 나왔는가).\n"
        "★ shapes 의 count 가 큰데 값 종류가 몇 개뿐이면 상수/오탐일 가능성이 높다 — "
        "위임하지 말고 좌표를 들고 ask_inspector 로 한 줄만 확인해라.\n"
        "본문(파일 줄)은 반환하지 않는다. 값은 마스킹된 것만, 아니면 모양으로 나온다."
    )

    async def _run(self, vi: TargetHitSummaryInput, ctx: ToolContext) -> ToolResult:
        _mark_examined(ctx, vi.target_id)
        from _shared.hit_view import build_hit_summary

        adapter = _adapter_for(ctx)
        if isinstance(adapter, ToolError):
            return adapter
        try:
            got = adapter.scan_summary(
                vi.target_id, category=vi.category, kind=vi.kind,
                verdict=vi.verdict, limit=vi.limit,
            )
        except Exception as e:  # noqa: BLE001
            return ToolError(kind="execution", message=f"scan_summary 실패: {e!r}")
        if not isinstance(got, dict):
            return ToolError(
                kind="execution",
                message=f"{adapter.domain} scan_summary 가 dict 를 안 줬다: {type(got)!r}")
        # 닫힌 봉투 — 어댑터가 무엇을 더 넣든 여기 없는 필드는 리드에게 가지 않는다.
        payload = build_hit_summary(
            domain=adapter.domain, target_id=vi.target_id,
            source=str(got.get("source") or "none"),
            total=got.get("total") or 0,
            # ⚠️ `or []` 로 뭉개면 안 된다 — raw hit 축이 없는 도메인(dev_web·github·
            #    confluence)은 rollup 이 없고, 거기서 빈 리스트를 주면 판정 대기가
            #    "0건" 으로 파생돼 리드가 "판정 끝났다" 로 읽는다. None 을 그대로 넘긴다.
            rollup=got.get("rollup") if got.get("rollup") is not None else None,
            shapes=got.get("shapes") or [],
            note=str(got.get("note") or ""),
            limit=vi.limit,
        )
        return ToolSuccess(content=json.dumps(payload, ensure_ascii=False, default=str))


# ── 2c. verify — 닫힌 동사 (v3.99 §B) ────────────────────────────────
#
# 사용자 질문의 안전한 형태: 임의 tool+args 는 본문 읽기 능력을 그대로 주므로 안 된다.
# 좌표만 받고 닫힌 enum 만 돌려주는 **동작 동사**로 간다. 동사가 늘어도 도구는 하나다 —
# `EXPECTED_LEAD_TOOLS` 가 계속 늘어나면 "리드 도구셋이 작다" 는 근거가 약해진다.

class VerifyInput(BaseModel):
    action: Literal["reachable"] = Field(
        ..., description="할 동작. 닫힌 집합이다(_shared/lead_verbs.ACTIONS).")
    target_id: int = Field(..., description="list_targets 가 준 id")
    ref: str | None = Field(
        None, max_length=300, description="좌표(경로/URL). 동사에 따라 선택.")
    line_no: int | None = Field(None, ge=0, description="좌표(라인). 동사에 따라 선택.")


class VerifyTool(LeadTool[VerifyInput]):
    name: ClassVar[str] = "verify"
    input_model: ClassVar[type[BaseModel]] = VerifyInput
    # 관측만 하지만 **바깥으로 나간다**(TCP connect). read-only 로 표시하면 그 사실이
    # 감사에서 지워진다.
    is_read_only: ClassVar[bool] = False
    # 서로 다른 타깃은 완전히 독립이다 — 같은 턴에 여러 개를 확인해도 된다.
    is_concurrency_safe: ClassVar[bool | None] = True
    search_hint: ClassVar[str] = "lead verify reachable alive tcp probe check target"
    description: ClassVar[str] = (
        "타깃에 **동작 하나**를 시키고 닫힌 결과를 받는다. 본문·값은 안 온다.\n"
        "- reachable: 지금 살아 있나 → alive/dead/skipped. "
        "★ **세션을 열기 전에** 확인해라 — 죽은 호스트에 8턴을 태운 적이 있다.\n"
        "여러 타깃을 같은 턴에 확인하면 동시에 돈다."
    )

    async def _run(self, vi: VerifyInput, ctx: ToolContext) -> ToolResult:
        _mark_examined(ctx, vi.target_id)
        import asyncio

        from _shared.lead_verbs import build_verify_result

        adapter = _adapter_for(ctx)
        if isinstance(adapter, ToolError):
            return adapter
        try:
            # ⚠️ 어댑터는 블로킹 소켓을 만진다. 이벤트 루프에서 직접 부르면
            #    `is_concurrency_safe=True` 가 거짓말이 된다(다른 세션까지 멈춘다).
            raw = await asyncio.to_thread(
                adapter.run_verb, vi.action,
                target_id=vi.target_id, ref=vi.ref, line_no=vi.line_no)
        except Exception as e:  # noqa: BLE001
            # 예외 문자열에 좌표/값이 실릴 수 있다 — 타입만 남긴다.
            raw = {"performed": False, "result": "error",
                   "detail": f"{type(e).__name__}"}
        return ToolSuccess(content=json.dumps(
            build_verify_result(action=vi.action, target_id=vi.target_id,
                                ref=vi.ref, raw=raw),
            ensure_ascii=False, default=str))


# ── 3. delegate_inspect ───────────────────────────────────────────────

class DelegateInspectInput(BaseModel):
    target_id: int = Field(..., description="검토원에게 맡길 타깃 id")
    scope: str | None = Field(
        None, max_length=300,
        description="범위 힌트(경로 접두어·키워드 등). 파일 1개가 아니라 **범위** 단위로 맡겨라.",
    )
    question: str | None = Field(
        None, max_length=300,
        description="검토원이 답해야 할 질문 1개. 없으면 도메인 기본 계약대로 점검한다.",
    )
    use_cred: int | None = Field(
        None, description="쓸 크리덴셜 핸들 id (값이 아니라 id). 검토원 안에서만 재료화된다.",
    )


class DelegateInspectTool(AgentTool):
    """검토원 위임 — 코어 `AgentTool` 을 상속해 위임 배관을 그대로 쓰고, **반환만** 봉투로 재조립.

    ★ 여기가 검토원→리드 유일 통로다. 세 가지를 한다:
      1. 봉투(닫힌 필드)로 재조립 — `agent_result.json` raw payload 덤프는 **버린다**.
      2. 산문(summary)은 하드 캡 후 마스킹.
      3. subagent_type 은 어댑터가 정한다 — 리드가 아무 검토원이나 못 부른다.
    """

    name: ClassVar[str] = "delegate_inspect"
    domain: ClassVar[str] = "lead"
    input_model: ClassVar[type[BaseModel]] = DelegateInspectInput
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = False
    search_hint: ClassVar[str] = "lead delegate inspector worker subagent inspect"
    description: ClassVar[str] = (
        "**예외 경로** — 한 번에 끝나는 게 확실할 때만. 기본은 open_inspection/"
        "ask_inspector 세션이다.\n"
        "타깃 1개를 검토원에게 통째로 맡기고 요약 보고를 받는다. 검토원이 예산 안에 못 "
        "끝내면 **결과를 통째로 잃는다**(세션은 '여기까지 봤음' 으로 이어갈 수 있다).\n"
        "검토원만 본문·크리덴셜 값을 본다 — 리드에게 돌아오는 것은 마스킹된 봉투다."
    )

    async def execute(self, vi: DelegateInspectInput, ctx: ToolContext) -> ToolResult:
        _mark_examined(ctx, vi.target_id)
        adapter = _adapter_for(ctx)
        if isinstance(adapter, ToolError):
            return adapter
        try:
            agent_input = adapter.delegate_input(vi.target_id, vi.scope)
        except Exception as e:  # noqa: BLE001
            return ToolError(kind="execution", message=f"delegate_input 실패: {e!r}")
        if vi.question:
            agent_input["question"] = vi.question
        if vi.use_cred is not None:
            # 값이 아니라 핸들. 검토원 프로세스 안에서만 재료화된다(Phase 2c).
            agent_input["cred_id"] = int(vi.use_cred)

        # ── transport: 스폰 1회 + 파일로 결과 회수 ──────────────────
        # 파일 읽기는 **이 transport 의 내부 사정**이지 인터페이스가 아니다. 세션이
        # 생기면 같은 `InspectorAnswer` 를 반환값으로 받는다(`_shared/inspector_channel`).
        before = sub_dirs(ctx.evidence_dir)
        raw = await super().execute(
            AgentInput(
                action="run",
                subagent_type=adapter.inspect_agent,
                input=agent_input,
            ),
            ctx,
        )
        sub_dir, spawn_error = resolve_new_sub_dir(
            ctx.evidence_dir, before, sub_dirs(ctx.evidence_dir))

        answer = answer_from_evidence(
            agent=adapter.inspect_agent, domain=adapter.domain,
            target_id=vi.target_id, sub_dir=sub_dir,
            fallback_text=(raw.content if isinstance(raw, ToolSuccess) else raw.message),
            spawn_error=spawn_error if isinstance(raw, ToolError) else None,
            call_failed=isinstance(raw, ToolError),
        )
        content = mask_tool_content(answer.to_json())
        if isinstance(raw, ToolError) and answer.status != "ok":
            return ToolError(kind=raw.kind, message=content)
        return ToolSuccess(content=content)


# ── 3b. 대화형 세션 (Phase 4c) ────────────────────────────────────────
#
# `delegate_inspect` 는 "작업 하나" 를 통째로 맡긴다 — 검토원이 10턴을 혼자 돌며 다 끝내고
# 리드는 결과만 받는다. 그래서 리드가 판단할 게 남지 않았다(실측: record_pivot 8런 0건).
#
# 세션은 위임 단위를 **질문**으로 바꾼다. 그리고 세션끼리는 독립이라 **병렬로 돈다** —
# 지금까지 위임이 직렬이었던 건 자원 때문이 아니라 파일 기반 transport 가 동시 스폰을
# 구분하지 못했기 때문이다(`sub evidence dir 판별 불가 — 동시 위임?`). 그 제약은 없다.

def _sessions_enabled() -> bool:
    """롤백 스위치. 0 이면 세션 도구를 아예 등록하지 않는다 — 도구셋이 Phase 3 와 같아진다."""
    raw = (os.environ.get("SA_LEAD_SESSIONS") or "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


class OpenInspectionInput(BaseModel):
    target_id: int = Field(..., description="검토원을 붙일 타깃 id")
    scope: str | None = Field(None, max_length=300, description="첫 범위 힌트(선택)")
    use_cred: int | None = Field(None, description="쓸 크리덴셜 핸들 id (값 아님)")


class OpenInspectionTool(LeadTool[OpenInspectionInput]):
    name: ClassVar[str] = "open_inspection"
    input_model: ClassVar[type[BaseModel]] = OpenInspectionInput
    # ⚠️ concurrency-safe 가 **아니다**. 레지스트리를 바꾸고, 엔진의 배치 경계를 만들어
    #    같은 턴의 ask 들과 섞이지 않게 한다.
    is_concurrency_safe: ClassVar[bool | None] = False
    search_hint: ClassVar[str] = "lead open inspector session start conversation"
    description: ClassVar[str] = (
        "타깃에 검토원 **세션**을 연다 — 한 번 맡기고 끝이 아니라, 계속 물어볼 수 있다. "
        "반환: {session_id, …}. 여러 타깃에 동시에 열어도 된다(상한 있음). "
        "다 본 세션은 close_inspection 으로 닫아라 — 안 닫으면 상한을 먹는다."
    )

    async def _run(self, vi: OpenInspectionInput, ctx: ToolContext) -> ToolResult:
        _mark_examined(ctx, vi.target_id)
        adapter = _adapter_for(ctx)
        if isinstance(adapter, ToolError):
            return adapter
        from _shared.session_registry import (
            SessionLimitReached, live_count, live_sessions, max_sessions, open_session,
        )
        try:
            target = adapter.delegate_input(vi.target_id, vi.scope)
        except Exception as e:  # noqa: BLE001
            return ToolError(kind="execution", message=f"delegate_input 실패: {e!r}")
        if vi.use_cred is not None:
            target["cred_id"] = int(vi.use_cred)
        spec = {
            "task_id": f"{adapter.inspect_agent}-t{vi.target_id}",
            "task_type": _inspect_task_type(ctx, adapter),
            "charter_ref": str((ctx.metadata or {}).get("charter_ref") or ""),
            "target": target,
        }
        try:
            ch = await open_session(
                evidence_dir=ctx.evidence_dir, agent=adapter.inspect_agent,
                domain=adapter.domain, target_id=vi.target_id, spec=spec)
        except SessionLimitReached as e:
            # ★ 상한 도달은 **정상 제어흐름**이지 오류가 아니다. ToolError 로 돌려주면
            #   엔진의 repeat-error 가드가 같은 실패 2회에 런을 죽인다 — 2026-08-21
            #   실기동에서 리드가 5·6번째 세션을 열려다 그렇게 halt 했다.
            #   할 수 있는 일(닫고 다시 열기)이 있는 상황은 성공으로 알려주고 상태를 준다.
            return ToolSuccess(content=json.dumps({
                "opened": False,
                "reason": str(e),
                "next": "close_inspection 으로 다 본 세션을 닫은 뒤 다시 열어라",
                "live": live_count(ctx.evidence_dir), "limit": max_sessions(),
                "open_sessions": live_sessions(ctx.evidence_dir),
            }, ensure_ascii=False))
        except Exception as e:  # noqa: BLE001
            return ToolError(kind="execution", message=f"세션 기동 실패: {e!r}")
        return ToolSuccess(content=json.dumps({
            "opened": True,
            "session_id": ch.session_id, "agent": ch.agent,
            "domain": ch.domain, "target_id": ch.target_id,
            "live": live_count(ctx.evidence_dir), "limit": max_sessions(),
            "open_sessions": live_sessions(ctx.evidence_dir),
        }, ensure_ascii=False))


class AskInspectorInput(BaseModel):
    session_id: str = Field(..., max_length=64, description="open_inspection 이 준 id")
    question: str = Field(
        ..., max_length=1000,
        description="답이 네 다음 수를 바꾸는 질문 하나. 캡에 걸려 잘렸으면 '계속해'.",
    )


class AskInspectorTool(LeadTool[AskInspectorInput]):
    name: ClassVar[str] = "ask_inspector"
    input_model: ClassVar[type[BaseModel]] = AskInspectorInput
    # ★ 여기가 병렬의 전부다. 서로 다른 세션은 완전히 독립이라 같은 턴에 여러 개를 물으면
    #   엔진이 배치로 묶어 동시에 돌린다(`_partition_calls` + gather).
    #   같은 세션에 동시 호출이 와도 안전한 근거는 `SessionChannel._lock` 이다 —
    #   파이프는 단일 스트림이라 락이 없으면 질문/답 짝이 어긋난다.
    #   ⚠️ 락을 지우면 이 플래그가 거짓말이 된다. 둘은 같이 움직인다.
    is_concurrency_safe: ClassVar[bool | None] = True
    search_hint: ClassVar[str] = "lead ask inspector question session dialogue"
    description: ClassVar[str] = (
        "열린 세션에 **질문 하나**를 던지고 답을 받는다. 검토원은 앞선 대화를 기억한다.\n"
        "여러 세션에 같은 턴에 물으면 **동시에** 돈다 — 타깃 여러 개를 병렬로 볼 때 그렇게 하라.\n"
        "답의 reason 이 max_turns 면 잘린 것이다 — '계속해' 로 이어가라(세션은 살아 있다)."
    )

    async def _run(self, vi: AskInspectorInput, ctx: ToolContext) -> ToolResult:
        from _shared.session_registry import get_session, live_sessions

        ch = get_session(vi.session_id)
        if ch is None:
            return ToolError(
                kind="not_found",
                message=(f"세션 없음: {vi.session_id}. 열린 세션: "
                         f"{live_sessions(ctx.evidence_dir)}"))
        # ★ 검토원이 일하는 동안 **부모가 살아 있다고 알린다**. 없으면 300s 를 넘는
        #   답은 하나도 못 받는다 — ask 타임아웃 1800s 가 부모 idle 워치독 300s 보다
        #   6배 커서, confluence 리드가 turn 8 에서 3연속 aborted 로 죽었다(2026-08-26).
        #   보고는 자식 evidence 가 **실제로 변할 때만** 나간다(하트비트가 아니다).
        from _shared.inspector_channel import keep_parent_alive

        async with keep_parent_alive(ch.evidence_dir, ctx,
                                     label=f"ask_inspector({vi.session_id})"):
            answer = await ch.ask(vi.question)
        return ToolSuccess(content=answer.to_json())


class CloseInspectionInput(BaseModel):
    session_id: str = Field(..., max_length=64)


class CloseInspectionTool(LeadTool[CloseInspectionInput]):
    name: ClassVar[str] = "close_inspection"
    input_model: ClassVar[type[BaseModel]] = CloseInspectionInput
    is_concurrency_safe: ClassVar[bool | None] = False
    search_hint: ClassVar[str] = "lead close inspector session end"
    description: ClassVar[str] = (
        "세션을 닫고 **최종 보고**를 받는다(검토원의 worker_result). "
        "다 본 타깃은 닫아라 — 안 닫으면 검토원 프로세스가 계속 살아 상한을 먹는다."
    )

    async def _run(self, vi: CloseInspectionInput, ctx: ToolContext) -> ToolResult:
        from _shared.session_registry import close_session, live_count, live_sessions

        final = await close_session(vi.session_id)
        if final is None:
            return ToolError(
                kind="not_found",
                message=(f"세션 없음(또는 이미 닫힘): {vi.session_id}. 열린 세션: "
                         f"{live_sessions(ctx.evidence_dir)}"))
        payload = final.as_dict()
        payload["closed"] = vi.session_id
        payload["live"] = live_count(ctx.evidence_dir)

        return ToolSuccess(content=json.dumps(payload, ensure_ascii=False, default=str))


def _inspect_task_type(ctx: ToolContext, adapter: LeadAdapter) -> str:
    """검토원 task_type — `agents/<name>.md` 의 task_type 과 같아야 한다.

    one-shot 경로는 코어 `AgentTool` 이 agent 정의에서 읽어 왔다. 세션은 spec 을 직접
    쓰므로 여기서 정한다. 정의에서 읽어 **한 소스만** 쓴다(복사하면 드리프트한다).
    """
    from secu_agent.agent.agents import get_agent

    agents_dir = (ctx.metadata or {}).get("agents_dir")
    a = get_agent(adapter.inspect_agent, agents_dir=agents_dir)
    if a is None or not a.task_type:
        raise RuntimeError(
            f"검토원 정의를 못 찾았다: {adapter.inspect_agent} (agents_dir={agents_dir})")
    return a.task_type


# ── 4. set_target_status ──────────────────────────────────────────────

#: 저장하는 근거 길이. 입력 상한(4000)보다 **작다** — 넘치면 자르고, 거부하지 않는다.
_REASON_STORE_LIMIT = 300


class SetTargetStatusInput(BaseModel):
    target_id: int
    status: str = Field(..., max_length=32, description="도메인 statuses 중 하나")
    finding_count: int | None = Field(None, ge=0)
    # ★ 상한을 넉넉히 두고 **안에서 자른다**(2026-09-02).
    #   300 으로 조여 뒀더니 근거를 길게 쓴 리드의 종결이 `err:validation` 으로
    #   통째로 거부됐다 — 그러면 `closed:false` 안내조차 못 받는다(그건 성공 응답이다).
    #   검토원 3명을 돌리고 이유까지 쓴 런이 0건으로 끝났다. 길게 썼다고 일을 버리지 않는다.
    reason: str | None = Field(
        None, max_length=4000,
        description=("왜 이 상태인가. 검토원 권고와 다른 상태로 닫으려면 **필수**다. "
                     "길면 앞부분만 저장된다(거부하지 않는다)."),
    )


class SetTargetStatusTool(LeadTool[SetTargetStatusInput]):
    name: ClassVar[str] = "set_target_status"
    input_model: ClassVar[type[BaseModel]] = SetTargetStatusInput
    search_hint: ClassVar[str] = "lead close queue target status tasked skipped"
    description: ClassVar[str] = (
        "타깃 큐를 닫는다 — **큐 소유자는 리드다**. 종료 도구. "
        "허용 상태는 list_targets 반환의 statuses 를 보라(닫힌 집합, 다른 값은 거부).\n"
        "검토원 권고와 **다른** 상태로 닫으려면 reason 을 달아라 — 뒤집는 것은 네 권한이지만 "
        "근거 없이 뒤집으면 왜 그랬는지가 어디에도 안 남는다."
    )

    async def _run(self, vi: SetTargetStatusInput, ctx: ToolContext) -> ToolResult:
        adapter = _adapter_for(ctx)
        if isinstance(adapter, ToolError):
            return adapter
        if vi.status not in adapter.statuses:
            # 인자를 남긴다. ⚠️ 여기까지 왔다는 것은 **입력 검증은 통과**했다는 뜻이다 —
            #   모델이 보낸 인자 자체가 형식에 안 맞으면 엔진 `invoker._validate` 가
            #   먼저 거부하고 이 함수는 불리지 않는다(그쪽에도 로깅을 넣었다).
            log.warning(
                "[set_target_status] 어휘 밖 status — domain=%s status=%r 허용=%s 인자=%s",
                adapter.domain, vi.status, list(adapter.statuses),
                vi.model_dump(exclude_none=True),
            )
            return ToolError(
                kind="validation",
                message=(
                    f"{adapter.queue_label} 는 status={vi.status!r} 를 받지 않는다. "
                    f"허용: {list(adapter.statuses)}"
                ),
            )

        # ── 안 본 타깃 닫기 검사 (2026-08-26 실기동) ──────────────────
        #
        # 계약이 처음부터 "열어보지도 않은 타깃을 닫지 마라. 안 볼 거면 skipped +
        # 이유다" 라고 적고 있었는데 **강제가 없었다.** confluence 리드가 컷오버 첫
        # 사이클에서 list_targets 두 번만 부르고 25개 스페이스를 통째로 닫았다.
        #
        # 이유를 달면 통과시킨다 — 안 보고 넘기는 것 자체는 리드의 권한이다.
        # 막는 것은 **근거 없이** 넘기는 것이다.
        # 저장 상한은 여기서 맞춘다 — 입력에서 거부하지 않는다(위 주석).
        reason_text = (vi.reason or "").strip()[:_REASON_STORE_LIMIT]
        if not _was_examined(ctx, vi.target_id) and len(reason_text) < _MIN_OVERRIDE_REASON:
            return ToolSuccess(content=json.dumps({
                "closed": False,
                "target_id": vi.target_id,
                "requested_status": vi.status,
                "why": ("이 타깃을 이번 런에서 한 번도 들여다보지 않았다 — "
                        "target_detail·target_hit_summary·verify·open_inspection 어느 것도 "
                        "부르지 않았다. 안 본 것을 닫으면 '봤는데 깨끗함' 과 구분되지 않는다."),
                "next": (f"먼저 target_hit_summary(target_id={vi.target_id}) 로 무엇이 잡혔는지 보라. "
                         f"그래도 안 볼 거면 "
                         f"set_target_status(target_id={vi.target_id}, status={vi.status!r}, "
                         f"reason='왜 안 보고 넘기는가') — 최소 {_MIN_OVERRIDE_REASON}자"),
            }, ensure_ascii=False, default=str))

        # ── 권고 뒤집기 검사 (v3.98) ──────────────────────────────────
        #
        # ★ 거부를 ToolError 로 돌려주지 않는다. 엔진 repeat-error 가드가 **같은 실패
        #   2회에 런을 죽인다** — 2026-08-21 세션 상한 halt 와 똑같은 함정이다.
        #   할 수 있는 일(reason 달기)이 있는 상황은 성공으로 알려주고 다음 수를 준다.
        from _shared.queue_ownership import collect_recommendations

        try:
            rec = collect_recommendations(ctx.evidence_dir).get(int(vi.target_id))
        except Exception:  # noqa: BLE001 — 권고를 못 읽어도 닫기를 막지 않는다
            log.exception("권고 수집 실패 — 뒤집기 검사를 건너뛴다")
            rec = None
        recommended = str((rec or {}).get("recommended_status") or "")
        overriding = bool(recommended) and recommended != vi.status
        reason = reason_text
        if overriding and len(reason) < _MIN_OVERRIDE_REASON:
            return ToolSuccess(content=json.dumps({
                "closed": False,
                "target_id": vi.target_id,
                "requested_status": vi.status,
                "recommended_status": recommended,
                "why": (f"검토원 권고는 {recommended!r} 인데 {vi.status!r} 로 닫으려 한다. "
                        f"뒤집는 것은 네 권한이지만 근거가 있어야 한다."),
                "inspector_reason": str((rec or {}).get("reason") or "")[:300],
                "next": (f"set_target_status(target_id={vi.target_id}, "
                         f"status={vi.status!r}, reason='왜 권고와 다르게 보는가') "
                         f"— 최소 {_MIN_OVERRIDE_REASON}자"),
            }, ensure_ascii=False, default=str))

        try:
            out = adapter.set_status(
                vi.target_id, vi.status,
                finding_count=vi.finding_count, reason=vi.reason,
            )
        except Exception as e:  # noqa: BLE001
            return ToolError(kind="execution", message=f"set_target_status 실패: {e!r}")

        _mark_closed(ctx, vi.target_id)
        payload = {"domain": adapter.domain, "target_id": vi.target_id,
                   "closed": True, "status": vi.status, **(out or {})}
        if overriding:
            # 뒤집기는 판단이다 — 저널에 남는다(리드 transcript 는 영속되지 않는다).
            _append_pivot(ctx, {
                "ts": time.time(), "kind": "override", "domain": adapter.domain,
                "from_ref": f"검토원 권고 {recommended}",
                "to_target": f"{adapter.queue_label} target {vi.target_id} → {vi.status}",
                "rationale": reason,
            })
            payload["override_recorded"] = recommended
        return ToolSuccess(content=json.dumps(
            payload, ensure_ascii=False, default=str))


# ── 5. record_pivot ───────────────────────────────────────────────────

class RecordPivotInput(BaseModel):
    from_ref: str = Field(..., max_length=300, description="근거가 된 곳(타깃/finding/경로)")
    to_target: str = Field(..., max_length=300, description="그래서 다음에 볼 곳")
    rationale: str = Field(..., max_length=600, description="왜 그렇게 판단했는가")
    to_target_id: int | None = Field(
        None,
        description=("다음에 볼 곳이 **이 큐의 타깃**이면 그 id. 주면 그 타깃이 실제로 "
                     "다시 큐에 오른다(pending) — 다음 런이 본다. 저널만 남기려면 비워라."),
    )


class ReportNoTargetsInput(BaseModel):
    observed: str = Field(
        ..., max_length=300,
        description=("네가 목록에서 무엇을 보고 그렇게 판단했는지 — **기록용**이다. "
                     "이 문장은 판정에 쓰이지 않는다(도구가 큐를 직접 다시 조회한다)."),
    )


class ReportNoTargetsTool(LeadTool[ReportNoTargetsInput]):
    """닫을 타깃이 없을 때의 **유일한** 합법 종료.

    ## 왜 (2026-08-27 실측)

    리드 20건이 `terminal tool contract violation` 으로 죽었고 **19건이 도구를
    `list_targets` 하나만** 불렀다(confluence 15 · dev_web 3 · smb 1). `list_targets`
    는 자기 설명에 "claim 하지 않는다" 고 적힌 읽기 전용 도구다. 큐가 비면 리드는
    claim 한 적 없는 대상에 `set_target_status` 를 찍을 수 없으므로, 종료 계약이
    **이행 불가능한 요구**가 된다.

    ★ `terminal_tools` 에 **넣지 않는다.** 넣으면 도구 실행기가 execute 진입만으로
      TERMINAL_INVOKED 를 세워, 부르기만 하면 게이트가 풀리는 일반 우회로가 된다.
      대신 이 도구가 **스스로 큐를 다시 조회해서** 사실을 확인한 뒤에만 면제를 세운다.

    ★ 술어는 `adapter.list_targets(status=None, limit=1)` 이다 — claim 술어가 아니다.
      claim 술어는 "스캔 워커가 다음에 무엇을 긁을까" 이고 리드가 닫을 수 있는 집합과
      다르다. 게다가 `*_claim_next` 는 순수 술어가 아니라 내부에서 `*_cycle_ensure_current()`
      **대량 UPDATE** 를 먼저 친다 — 읽기 전용 probe 로 미러링할 수 없다.
      `set_target_status` 는 claim 술어를 아예 안 보므로,
      **"목록이 비었다" ⟺ "닫을 수 있는 row 가 원리적으로 없다"** 가 정확한 필요충분 술어다.
    """

    name: ClassVar[str] = "report_no_targets"
    input_model: ClassVar[type[BaseModel]] = ReportNoTargetsInput
    # ⚠️ **배치 경계다.** 이 도구는 종료 계약 상태(면제)를 쓰고, 그 정합성이
    #    `_EXAMINED`/`_CLOSED` 의 **시점**에 달려 있다. 열람 도구와 같은 배치에서
    #    병렬로 돌면 "면제를 세운다" 와 "열람이 면제를 회수한다" 의 순서가
    #    비결정적이 되어, 회수가 먼저 일어난 뒤 면제가 덮어쓰는 창이 생긴다.
    #    그 창이 곧 우회로다. record_pivot·set_target_status 와 같은 자리.
    is_concurrency_safe: ClassVar[bool] = False
    search_hint: ClassVar[str] = "lead empty queue nothing to close finish no work"
    description: ClassVar[str] = (
        "닫을 타깃이 하나도 없을 때 이 런을 끝낸다. 호출하면 도구가 큐를 **다시 "
        "조회해서** 정말 비었는지 확인한다 — 하나라도 있으면 끝나지 않는다.\n"
        "'없다' 고 글로 쓰는 것으로는 이 런이 끝나지 않는다."
    )

    async def _run(self, vi: ReportNoTargetsInput, ctx: ToolContext) -> ToolResult:
        adapter = _adapter_for(ctx)
        if isinstance(adapter, ToolError):
            return adapter
        key = str(getattr(ctx, "evidence_dir", "") or "")
        closed = _CLOSED.get(key, set())
        if closed:
            return ToolSuccess(content=json.dumps({
                "accepted": False, "waived": False,
                "why": f"이번 런에서 이미 {sorted(closed)} 를 닫았다 — 면제가 필요 없다.",
                "next": "닫을 게 더 없으면 그냥 끝내라(종료 신호는 이미 있다).",
            }, ensure_ascii=False))
        unclosed = sorted(_EXAMINED.get(key, set()) - closed)
        if unclosed:
            # ★ 계약이 잡으려던 실패모드("일 다 해놓고 종료를 글로만")를 막는 지점.
            return ToolSuccess(content=json.dumps({
                "accepted": False, "waived": False,
                "why": f"열어본 타깃 {unclosed} 가 아직 안 닫혔다.",
                "next": f"set_target_status 로 {unclosed} 를 먼저 닫아라.",
            }, ensure_ascii=False))
        try:
            rows = adapter.list_targets(status=None, limit=1)
        except Exception as e:  # noqa: BLE001
            # ★ 못 세는 것과 0건은 다르다 — 모르면 면제하지 않는다(fail-closed).
            #   ⚠️ ToolError 로 돌리지 않는다: 같은 실패 2회면 repeat-error 가드가
            #      런을 죽인다. 사유를 성공 본문으로 돌려 리드가 다시 시도하게 둔다.
            return ToolSuccess(content=json.dumps({
                "accepted": False, "waived": False,
                "why": f"큐를 조회하지 못했다 — 비었는지 모른다: {e!r}"[:300],
                "next": "list_targets 로 다시 확인해 보라. 모르는 채로는 끝낼 수 없다.",
            }, ensure_ascii=False))
        if rows:
            return ToolSuccess(content=json.dumps({
                "accepted": False, "waived": False,
                "why": f"{adapter.queue_label} 에 아직 타깃이 있다(예: id={rows[0].get('id')}).",
                "sample": rows[0],
                "next": "target_hit_summary → 판단 → set_target_status 로 닫아라.",
            }, ensure_ascii=False, default=str))

        from secu_agent.agent.terminal_contract import waive_terminal_tool

        evidence = {"domain": adapter.domain, "queue": adapter.queue_label,
                    "rows": 0, "predicate": "list_targets(status=None, limit=1)",
                    "examined": 0, "closed": 0}
        waive_terminal_tool(ctx.metadata, source=self.name, evidence=evidence)
        _append_pivot(ctx, {
            "ts": time.time(), "kind": "no_targets", "domain": adapter.domain,
            "from_ref": "list_targets(status=None, limit=1) = []",
            "to_target": "(없음) — 이 런은 아무것도 닫지 않는다",
            "rationale": vi.observed[:300],   # ← 기록만. 판정엔 안 쓴다.
        })
        return ToolSuccess(content=json.dumps({
            "accepted": True, "waived": True, "evidence": evidence,
            "next": "이제 끝내라. 종료 계약은 면제됐고 그 사실이 기록됐다.",
        }, ensure_ascii=False, default=str))


class RecordPivotTool(LeadTool[RecordPivotInput]):
    name: ClassVar[str] = "record_pivot"
    input_model: ClassVar[type[BaseModel]] = RecordPivotInput
    search_hint: ClassVar[str] = "lead pivot rationale audit record decision requeue"
    description: ClassVar[str] = (
        "'무엇을 보고 다음에 어디로 갔는가' 를 남긴다. 리드 transcript 는 영속되지 "
        "않으므로 네 판단 근거는 이걸로만 남는다.\n"
        "★ `to_target_id` 를 주면 저널로 끝나지 않는다 — 그 타깃이 **다시 큐에 올라** "
        "다음 런이 본다. 지금 못 보는 것을 다음으로 넘길 때 그렇게 하라."
    )

    async def _run(self, vi: RecordPivotInput, ctx: ToolContext) -> ToolResult:
        adapter = _adapter_for(ctx)
        if isinstance(adapter, ToolError):
            return adapter
        entry = {
            "ts": time.time(),
            "kind": "pivot",
            "domain": adapter.domain,
            "from_ref": vi.from_ref,
            "to_target": vi.to_target,
            "rationale": vi.rationale,
        }
        payload: dict = {"recorded": True, "path": _PIVOT_LOG, "domain": adapter.domain}

        # ── 큐 반영 (v3.98) ───────────────────────────────────────────
        #
        # 지금까지 이 도구는 **소비자 0인 쓰기 전용 저널**이었다(실측: 8런 0건 호출).
        # 모델은 다음 수를 안 바꾸는 도구를 건너뛴다 — 합리적이다.
        # 새 권한은 아니다. 리드는 set_target_status(id,'pending') 으로 같은 일을
        # 이미 할 수 있다. 바뀌는 것은 **그 행위에 근거가 붙어 남는다**는 점이다.
        if vi.to_target_id is not None:
            entry["to_target_id"] = int(vi.to_target_id)
            if "pending" not in adapter.statuses:
                payload["requeued"] = None
                payload["note"] = (
                    f"{adapter.queue_label} 에는 'pending' 상태가 없어 재큐하지 못했다 "
                    f"(허용: {list(adapter.statuses)}). 저널에는 남았다.")
            else:
                try:
                    adapter.set_status(
                        int(vi.to_target_id), "pending",
                        finding_count=None, reason=vi.rationale[:300])
                except Exception as e:  # noqa: BLE001
                    # ★ 재큐 실패로 기록까지 잃지 않는다. 저널은 계속 쓴다.
                    entry["requeue_error"] = repr(e)[:200]
                    payload["requeued"] = None
                    payload["note"] = f"재큐 실패(기록은 남았다): {e!r}"
                else:
                    entry["requeued"] = "pending"
                    payload["requeued"] = int(vi.to_target_id)
                    payload["status"] = "pending"

        err = _append_pivot(ctx, entry)
        if err:
            return ToolError(kind="io_error", message=err)
        payload["pivots_so_far"] = _pivots_so_far(ctx)
        return ToolSuccess(content=json.dumps(
            payload, ensure_ascii=False, default=str))


def lead_tools() -> list[type]:
    """리드 도구셋 provider — `register_task_toolset` 에 그대로 넘긴다.

    이름은 도메인 무관 고정. 여기에 도구를 더할 때는 "리드가 이걸로 본문을 볼 수
    있는가"를 먼저 답하라 — `test_lead_boundary.EXPECTED_LEAD_TOOLS` 가 조용한 증식을 막는다.
    """
    classes = [
        ListTargetsTool,
        TargetDetailTool,
        TargetHitSummaryTool,     # v3.98 — 리드의 눈
        VerifyTool,               # v3.99 — 닫힌 동사
        DelegateInspectTool,      # 단발 — 롤백 경로로 **남긴다**
        SetTargetStatusTool,
        RecordPivotTool,
        ReportNoTargetsTool,      # 빈 큐의 유일한 합법 출구 (2026-08-28)
    ]
    if _sessions_enabled():
        classes += [OpenInspectionTool, AskInspectorTool, CloseInspectionTool]
    return classes
