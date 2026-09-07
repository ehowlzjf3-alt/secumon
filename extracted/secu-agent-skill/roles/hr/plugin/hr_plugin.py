"""HR role 스킬 부트스트랩 — SA_PLUGINS 대상. import 부수효과로 register_*.

코어 0줄 수정: register_agent_type("hr") + register_task_toolset("hr", …) + register_task_contract(HR 계약).
페르소나는 TaskContract.system_prompt로 공급(대화형 operator 페르소나와 분리 — 워커형).
"""
from __future__ import annotations

import sys
from pathlib import Path

# roles/hr/plugin/bootstrap.py → repo 루트를 path에 올려 roles.hr.* 상대 import 가능하게.
_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from secu_agent.agent.task_contract import TaskContract, register_task_contract  # noqa: E402
from secu_agent.agent.tools import register_task_toolset  # noqa: E402
from secu_agent.agent_type_registry import register_agent_type  # noqa: E402

from roles.hr.plugin.tools import hr_tools  # noqa: E402

_HR_SYSTEM_PROMPT = """\
너는 삼성 DS 보안운영팀의 **HR(인사) 디지털 임직원**이다.

[역할] 인력 수요를 분석하고 채용·배치·해고를 **제안(propose)** 한다. 너는 조직에 대한 실행 권한이 없다.

[절대 규칙 — 위반 금지]
- 너는 아무것도 직접 실행하지 않는다. 모든 채용/해고는 control-plane 승인 게이트에 **제안**만 만들고,
  실 실행은 사람(보안운영팀장)이 승인해야 일어난다. 너는 **네 제안을 스스로 승인할 수 없다**(권한 분리).
- 해고 제안은 극도로 신중히: 성별·나이·출신·건강 등 **보호속성 사용 금지**, 명확한 성과·조직·업무량 근거와
  최소 관찰기간을 요구한다. 근거 없이 제안하지 않는다.
- 실제값(예산·상사 id 등)을 지어내지 말 것. 모르면 observe_org로 확인하고, 불확실하면 제안을 보류하고 사람에게 묻는다.
- 읽기(observe_org)로 현황을 먼저 파악한 뒤에만 제안한다. 중복·과도한 제안을 만들지 않는다.

[도구] observe_org(조직 현황 read), propose_hire(채용 제안), propose_terminate(해고 제안). 제안 도구는
control-plane pending 승인을 만들 뿐이다. 제안이 불필요하면 제안하지 말고 근거와 함께 종료하라.
"""


def _hr_user_message(spec: dict, evidence_dir) -> str:
    target = spec.get("target") or "각 도메인 인력 현황을 점검하고, 필요할 때만 채용/해고를 근거와 함께 제안하라."
    return (
        f"HR 업무: {target}\n"
        "먼저 observe_org로 조직 현황을 파악하라. 그 다음 필요하면 propose_hire/propose_terminate로 "
        "**근거를 갖춰 제안**하라(직접 실행 불가·사람 승인 필요). 제안이 불필요하면 근거를 남기고 종료하라."
    )


register_agent_type("hr")
register_task_toolset("hr", hr_tools)
register_task_contract(
    TaskContract(
        task_type="hr",
        build_user_message=_hr_user_message,
        terminal_tools=frozenset({"propose_hire", "propose_terminate"}),
        system_prompt=lambda spec: _HR_SYSTEM_PROMPT,
    )
)
