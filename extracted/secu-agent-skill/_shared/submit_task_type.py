"""도메인 전용 `submit_finding` 의 `task_type` 핀 — 4도메인 공용.

## 왜 핀이 필요한가

코어 judge 디스패치는 **raw 문자열 조회**다(`evidence_judgment.py`):

    _TASK_TYPE_JUDGES.get(finding.task_type)   →  없으면
    _CATEGORY_JUDGES.get(hit.category)         →  없으면 코어 generic 계약

그리고 `TaskFinding.task_type` 의 기본값은 `"generic"` 이다. 즉 워커가 필드를
빠뜨리면 **등록된 도메인 게이트가 아예 실행되지 않는다.** 에러가 아니라 침묵이다 —
finding 은 정상 제출되고, 다만 약한 계약으로 판정된 채 DB 에 남는다.

실측(2026-08-17, smb): 제출 67건 중 **16건(24%)** 이 `task_type` 을 빠뜨렸고,
그중 4건이 `task_type='generic'` 으로 살아남았다(critical 1건 포함, 전부 asset 이
`smb://…`). 두 가지가 동시에 깨진다 — 도메인 증거계약 미적용 + 리포트 라우팅 오류.

category 축 게이트도 같이 무력화된다. 예: `github_secret_evidence_judge` 는
`task_type != "github"` 이면 `None` 을 반환한다(`secret_gate` 규칙이 confluence
위키 본문을 전량 제외해 버리기 때문에 필수인 방어다). 그래서 github finding 이
`generic` 으로 오면 **시크릿 정오탐 게이트를 통째로 건너뛴다.**

## 왜 거부가 아니라 정규화인가

이 도구를 통과하는 finding 은 **정의상 전부 그 도메인**이다. 그런데 두 방식이
공존하고 있었고 실측이 갈렸다:

  · 거부(dev_web) — `task_type != "dev_web"` 이면 ToolError. 워커가 필드를
    빠뜨리면 제출이 죽는다. 2026-08-17 하루에 **6건이 이렇게 죽었다.**
  · 정규화(smb) — 비었거나 `generic` 이면 그 도메인으로 확정. 게이트도 살고
    제출도 산다.

정규화가 잃는 게 없다: 빠뜨린 값을 채우는 것뿐이고, **다른 도메인을 명시**한
경우는 워커의 혼동이므로 그대로 거부해 드러낸다.

⚠️ 정규화한 값을 **되써야** 한다. 디스패치가 raw 문자열이라 `"SMB"`/`" smb "` 를
통과만 시키고 그대로 두면 `_TASK_TYPE_JUDGES.get("SMB")` 가 None 이 되어 똑같이
우회된다(smb 테스트가 실제로 이걸 잡았다).
"""
from __future__ import annotations

from secu_agent.agent.schema.finding import TaskFinding
from secu_agent.agent.tools.base import ToolError

# 모델이 "안 채운 것"으로 볼 값들. 여기 해당하면 도메인으로 확정한다.
_UNSET = ("", "generic")


def ensure_task_type(
    finding: TaskFinding, expected: str, *, tool_name: str,
) -> TaskFinding | ToolError:
    """`finding.task_type` 을 `expected` 로 확정하거나, 다른 도메인이면 거부한다.

    반환이 `TaskFinding` 이면 **그 값을 써야 한다** — 원본이 아니라 정규화된 사본일
    수 있다.
    """
    raw = str(getattr(finding, "task_type", "") or "").strip().lower()
    if raw in _UNSET or raw == expected:
        if finding.task_type == expected:
            return finding
        return finding.model_copy(update={"task_type": expected})
    return ToolError(
        kind="validation",
        message=(
            f"{tool_name} 은 task_type='{expected}' 만 받는다 (받은 값: {raw!r}). "
            f"이 도구로 내는 finding 은 전부 {expected} 점검 결과다 — "
            f"task_type 을 '{expected}' 로 고쳐라."
        ),
    )
