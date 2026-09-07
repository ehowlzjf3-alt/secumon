"""실기동에서만 드러난 검토원 갭 2건 (2026-08-20).

배선 테스트 41건이 전부 통과한 **뒤에** 실기동이 잡은 것들이다. 둘 다 정적으로는
안 보이고 둘 다 조용하다.

## ① 스킬 `.env` 가 코어 CLI 경로에서 로드되지 않았다

기존 러너 경로는 `run_agent()` 안의 `_ensure_dotenv()` 가 처리했는데 검토원은
`run_agent` 을 타지 않는다. 그래서 SMB_USERNAME 같은 스킬 전용 크리덴셜이 없는 채로
돌았다 — 1차 실기동에서 STATUS_LOGON_FAILURE 로 나타났다.

고약한 건 **엔진 `.env` 는 들어왔다**는 것이다. DB 도 붙고 플러그인도 로드되니 워커가
잘 도는 것처럼 보였다. 워커는 1,863개 디렉터리를 훑고 후보까지 추린 뒤 파일을 못 열었다.

## ② smb 는 큐 닫기가 워커 밖에 있다

다른 3도메인은 워커가 `<d>_target_set_status` 를 종료 도구로 불러 자기 큐를 닫는다.
smb 는 러너(은퇴한 `smb_task_agent._task_one_host`)가 `run_agent()` 반환 후에 닫았다.
검토원 단독으로는 공유를 닫을 수 없었고, `smb_submit_finding` 이 유일한 종료 도구라
**깨끗한 공유는 종료 도구를 부를 방법 자체가 없어** 항상 rc=3 이었다.
코어 계약의 `on_submit`/`on_no_submit` 이 그 자리라 러너 로직을 옮겼다.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]


def _run_isolated(body: str) -> dict:
    """**빈 env** 격리 프로세스 — 이 세션의 env 가 결과를 만들어주면 검증이 무의미하다."""
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": os.environ.get("HOME", "/tmp"),
        "PYTHONPATH": str(_REPO),
        "SA_ENGINE_DIR": os.environ.get(
            "SA_ENGINE_DIR", str(Path.home() / "project" / "secu-agent")),
    }
    proc = subprocess.run([sys.executable, "-c", body], cwd=str(_REPO), env=env,
                          capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, f"{proc.stdout}\n{proc.stderr}"
    marker = "###JSON###"
    assert marker in proc.stdout, f"{proc.stdout}\n{proc.stderr}"
    return json.loads(proc.stdout.split(marker, 1)[1])


def test_contract_hooks_load_the_skill_env() -> None:
    """★ 계약 훅을 하나만 불러도 스킬 전용 크리덴셜이 서야 한다."""
    got = _run_isolated(
        "import json, os, sys\n"
        "before = bool(os.environ.get('SMB_USERNAME'))\n"
        "import plugin.bootstrap\n"
        "from secu_agent.agent.task_contract import get_task_contract\n"
        "c = get_task_contract('smb_file_inspect')\n"
        "c.metadata({'target': {'host': 'x'}})\n"
        "print('###JSON###' + json.dumps({\n"
        "    'before': before,\n"
        "    'after_smb_user': bool(os.environ.get('SMB_USERNAME')),\n"
        "    'after_pg': bool(os.environ.get('SECU_AGENT_PG_DSN')),\n"
        "}))\n"
    )
    assert got["before"] is False, "격리가 안 됐다 — 세션 env 가 새고 있다"
    assert got["after_smb_user"], (
        "스킬 .env 가 로드되지 않았다 — 코어 CLI 경로에는 _ensure_dotenv 를 부르는 "
        "사람이 없다(러너 경로만 부른다)"
    )
    assert got["after_pg"], "엔진 .env 도 함께 로드돼야 한다"


@pytest.mark.parametrize("task_type", [
    "smb_file_inspect", "dev_web_inspect", "github_inspect",
    "confluence_inspect", "confluence_search_inspect",
])
def test_every_inspector_can_terminate_cleanly(task_type: str) -> None:
    """★ 깨끗한 타깃도 정상 종료할 수 있어야 한다.

    종료 경로는 둘 중 하나여야 한다:
      (a) findings 와 무관한 종료 도구가 도구셋에 있다(`*_set_status`), 또는
      (b) 계약이 `on_no_submit` 으로 후처리·판정을 한다.
    둘 다 없으면 아무것도 못 찾은 워커가 **영원히 rc=3** 이다 — smb 가 그랬다.
    """
    got = _run_isolated(
        "import json, plugin.bootstrap\n"
        "from secu_agent.agent.task_contract import get_task_contract\n"
        "from secu_agent.agent.tools import build_registry_for_task\n"
        f"tt = {task_type!r}\n"
        "c = get_task_contract(tt)\n"
        "tools = sorted(t.name for t in build_registry_for_task(tt).all())\n"
        "print('###JSON###' + json.dumps({\n"
        "    'terminal': sorted(c.terminal_tools),\n"
        "    'tools': tools,\n"
        "    'has_on_no_submit': c.on_no_submit is not None,\n"
        "}))\n"
    )
    findings_independent = [t for t in got["terminal"] if "set_status" in t]
    assert findings_independent or got["has_on_no_submit"], (
        f"{task_type}: findings 무관 종료 도구도 없고 on_no_submit 후처리도 없다 — "
        f"아무것도 못 찾은 워커가 정상 종료할 방법이 없다. terminal={got['terminal']}"
    )


def test_smb_contract_owns_its_queue_closing() -> None:
    """smb 만 큐 닫기가 워커 밖에 있었다 — 계약이 그걸 들고 있어야 한다."""
    got = _run_isolated(
        "import json, plugin.bootstrap\n"
        "from secu_agent.agent.task_contract import get_task_contract\n"
        "c = get_task_contract('smb_file_inspect')\n"
        "print('###JSON###' + json.dumps({\n"
        "    'on_submit': c.on_submit is not None,\n"
        "    'on_no_submit': c.on_no_submit is not None,\n"
        "}))\n"
    )
    assert got["on_submit"] and got["on_no_submit"], (
        "smb 검토원이 공유를 닫지 못한다 — 러너 없이 돌면 walked 인 채로 남는다"
    )
