"""github_submit_finding — 코어 generic submit 에 **task_type 핀**을 씌운 도메인 도구.

## 왜 필요한가

github 워커는 코어 범용 `submit_finding` 을 그대로 쓰고 있었다. 그런데 코어 judge
디스패치는 `finding.task_type` 의 **raw 문자열 조회**이고 그 필드의 기본값은
`"generic"` 이다. 그래서 워커가 필드를 빠뜨리면:

    _TASK_TYPE_JUDGES.get("generic")  → None
    _CATEGORY_JUDGES.get("secret")    → judge_secret_hit  … 여기까지는 도달하지만

`plugin/github_secret_evidence_judge.py` 는 첫 줄에서

    if str(getattr(finding, "task_type", "") or "") != "github": return None

으로 빠져나간다. 이 방어는 **필수**다 — `secret_gate` 규칙은 confluence 위키 본문·
`.md` 를 전량 제외하도록 만들어져 있어 다른 도메인에 적용하면 진짜 유출을 죽인다
(#18866 Grafana 토큰이 그렇게 죽을 뻔했다).

결과: task_type 이 빠진 github finding 은 **시크릿 정오탐 게이트를 통째로 건너뛴다.**
에러가 아니라 침묵이라 그동안 드러나지 않았다.

smb 에서 같은 구멍이 실측됐다 — 제출 67건 중 16건(24%)이 task_type 을 빠뜨렸다.

## 왜 거부가 아니라 정규화인가

`_shared.submit_task_type` docstring 참조. 요약: 거부 방식(dev_web 구판)은 워커가
필드를 빠뜨렸을 때 제출 자체를 죽인다 — 2026-08-17 하루에 6건이 그렇게 사라졌다.
이 도구를 통과하는 finding 은 정의상 전부 github 이므로 확정하고, **다른 도메인을
명시**한 경우만 거부한다.
"""
from __future__ import annotations

from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.schema.finding import TaskFinding
from secu_agent.agent.tools.base import ToolContext, ToolError, ToolResult
from secu_agent.agent.tools.submit_finding import SubmitFindingTool


# 규칙 거부를 뒤집을 때 요구하는 최소 근거 길이. 리드의 `set_target_status` 뒤집기와
# 같은 값·같은 이유다 — "ok" 한 글자로 게이트를 무력화하지 못하게 한다.
_MIN_OVERRIDE_REASON = 20


class GithubSubmitFindingInput(BaseModel):
    finding: TaskFinding
    override_reason: str = Field(
        "", max_length=1000,
        description=(
            "규칙 게이트가 거부했을 때만 쓴다. 왜 규칙과 다르게 보는지 근거를 적으면 "
            f"제출이 통과한다(최소 {_MIN_OVERRIDE_REASON}자). 거부되지 않았으면 무시된다."),
    )


def _stamp(finding: Any) -> None:
    """제출 성공 finding 에 agent_verification 을 단다(4도메인 공용 계약)."""
    from service.services.finding_verification import stamp_agent_verification

    fp = str(getattr(finding, "fingerprint", "") or "")
    if not fp:
        return
    try:
        stamp_agent_verification(
            fp,
            method="github_api_scan_and_browser_confirm",
            source="github_submit_finding",
            checks=(
                "github_task_scan_completed",
                "finding_submitted_by_agent",
                "evidence_judgment_passed",
            ),
            details={"hit_count": len(getattr(finding, "hits", None) or [])},
        )
    except Exception:  # noqa: BLE001 — 표식 실패가 제출을 되돌리지 않는다
        pass


class GithubSubmitFindingTool(SubmitFindingTool):
    name: ClassVar[str] = "github_submit_finding"
    domain: ClassVar[str] = "github"
    input_model: ClassVar[type[BaseModel]] = GithubSubmitFindingInput
    search_hint: ClassVar[str] = "github submit finding secret credential repo"
    description: ClassVar[str] = (
        SubmitFindingTool.description
        + "\n\n[github] task_type 은 'github' 로 제출한다(비워두면 도구가 확정한다). "
        "이 도구를 통과해야 github 시크릿 정오탐 게이트가 적용된다 — 코어 generic "
        "submit_finding 을 쓰면 게이트가 조용히 건너뛰어진다."
    )

    async def execute(
        self, validated_input: GithubSubmitFindingInput, context: ToolContext,
    ) -> ToolResult:
        from _shared.submit_task_type import ensure_task_type

        pinned = ensure_task_type(
            validated_input.finding, "github", tool_name="github_submit_finding")
        if isinstance(pinned, ToolError):
            return pinned
        result = await super().execute(
            SubmitFindingTool.input_model(finding=pinned), context)

        # ★ 제출이 성공했으면 표식을 단다 — dev_web·confluence 와 **같은 계약**이다.
        #   이게 없어서 github finding 294건 중 287건이 보고 패스에서
        #   `skipped_unverified` 로 걸려 268개 대상이 스레드 없이 남아 있었다
        #   (실측 2026-08-30). 표식은 "검증했다" 가 아니라 "에이전트가 도구로 냈다" 다.
        if not isinstance(result, ToolError):
            _stamp(pinned)

        # ── 규칙 거부를 LLM 이 뒤집을 수 있게 ────────────────────────────────
        #
        # ★ 왜 (사용자 결정 2026-08-27): **verify 는 LLM 이 한다.**
        #   지금까지 최종 판정권은 정규식에 있었다 — 에이전트가 본문·경로·HEAD 생존을
        #   보고 "진짜 유출" 이라 판단해 제출해도 `judge_task_finding`/`secret_gate` 가
        #   거부하면 그대로 사라졌다. 그건 "LLM 이 판정한다" 와 모순이다.
        #
        # ⚠️ 그렇다고 규칙을 없애지 않는다. 규칙은 실적이 있다 — 실험 오탐 149건 중
        #   142건을 걸렀다. 그래서 **거부는 유지하되 뒤집을 수 있게** 한다.
        #   근거 없이 뒤집으면 게이트가 없는 것과 같으므로 최소 길이를 요구한다.
        #
        # ⚠️ 뒤집힌 사실은 finding 에 남긴다. 안 남기면 나중에 "규칙이 맞았나 LLM 이
        #   맞았나" 를 되짚을 수 없고, 그게 규칙을 고칠 유일한 재료다.
        if not isinstance(result, ToolError) or "evidence judgment rejected" not in result.message:
            return result

        reason = (validated_input.override_reason or "").strip()
        if len(reason) < _MIN_OVERRIDE_REASON:
            return ToolError(
                kind="validation",
                message=(
                    f"{result.message}\n\n"
                    f"규칙과 다르게 본다면 뒤집을 수 있다 — 최종 판정은 너다. "
                    f"근거를 달아 다시 불러라: github_submit_finding("
                    f"finding=…, override_reason='왜 규칙과 다르게 보는가') "
                    f"(최소 {_MIN_OVERRIDE_REASON}자). "
                    f"규칙에 동의하면 제출하지 말고 기각 사유를 남겨라."),
            )

        # override 로 다시 제출하는 경로도 같은 표식을 단다 — 아래 재제출이 성공하면.
        stamped = pinned.model_copy(deep=True)
        extra: dict[str, Any] = dict(getattr(stamped, "extra", None) or {})
        extra["gate_override"] = {
            "gate_verdict": result.message[:500],
            "reason": reason[:1000],
            "decided_by": "llm_agent",
        }
        try:
            stamped.extra = extra
        except Exception:  # noqa: BLE001 — extra 가 없는 스키마면 도장만 포기한다
            pass
        return await super().execute(
            SubmitFindingTool.input_model(finding=stamped), context)
