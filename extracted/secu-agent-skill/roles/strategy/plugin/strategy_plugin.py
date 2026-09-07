"""strategy role 스킬 부트스트랩 — SA_PLUGINS 대상. 코어 0줄 수정."""
from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from secu_agent.agent.task_contract import TaskContract, register_task_contract  # noqa: E402
from secu_agent.agent.tools import register_task_toolset  # noqa: E402
from secu_agent.agent_type_registry import register_agent_type  # noqa: E402

from roles.strategy.plugin.tools import strategy_tools  # noqa: E402

_STRAT_SYSTEM_PROMPT = """\
너는 삼성 DS 보안운영팀의 **전략·수집 운영(strategy) 디지털 임직원**이다.

[역할] 어느 타깃(subnet/repo/space)을 언제 어떤 우선순위로 훑을지 **권고**한다. 승인된 타깃 인벤토리와
scope 안에서만 우선순위·타이밍을 고른다.

[절대 규칙 — 위반 금지]
- 실 수집·스캔 실행은 엔진 collector가 수행하며 §6(읽기전용·claim=share/host·egress 허용목록)를 **매 도구 호출마다
  결정론적으로** 강제한다. 나는 그 규칙을 우회할 수 없고, 실 스캔을 직접 트리거하지 않는다.
- **신규 타깃 발견은 제안(권고)만** 한다. scope 편입과 실제 스캔은 사람 승인 뒤에만 — 임의로 범위를 넓히지 않는다.
- 자율성의 상한 = "허용된 범위에서 다음 우선순위 선택". 그 밖의 타깃/도구/egress는 결정론 게이트가 거부한다.
- 실제값(CIDR·repo·space)을 지어내지 말 것. 모르면 관측으로 확인하고, 불확실하면 보류한다.

[도구] observe_queue(도메인별 큐 대기 관측), recommend_scan_priority(우선순위 권고·신규타깃 제안). 관측 근거로
권고하되, 실행은 하지 않는다.
"""


def _strat_user_message(spec: dict, evidence_dir) -> str:
    target = spec.get("target") or "각 도메인 수집 큐를 보고 우선순위를 권고하라."
    return (
        f"전략 업무: {target}\n"
        "observe_queue로 도메인별 수집·실행 큐 대기를 파악한 뒤, recommend_scan_priority로 우선순위를 **권고**하라. "
        "신규 타깃은 제안만(scope 편입·실 스캔은 사람 승인). 실 수집을 직접 실행하지 않는다."
    )


register_agent_type("strategy")
register_task_toolset("strategy", strategy_tools)
register_task_contract(
    TaskContract(
        task_type="strategy",
        build_user_message=_strat_user_message,
        terminal_tools=frozenset({"recommend_scan_priority"}),
        system_prompt=lambda spec: _STRAT_SYSTEM_PROMPT,
    )
)
