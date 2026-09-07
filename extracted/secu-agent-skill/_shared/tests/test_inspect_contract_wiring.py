"""검토원 배선 계약 — 4도메인 동일 규격 (Phase 1).

여기서 막는 것은 전부 **조용한 실패**다. 배선이 하나 빠져도 워커는 그냥 돌고 결과만 달라진다:

  - 도구셋 누락        → generic fallback(코어 범용 submit_finding) → task_type judge 우회
  - agent md 이름 불일치 → 그 검토원은 '없는' 셈
  - worker.md 경로 오타  → 계약 없는 프롬프트로 도구만 쥔 워커
  - build_client 누락   → vision/gateway 래퍼 없이 돌다 첫 이미지에 400

## ★ 왜 서브프로세스 스냅샷인가

`plugin.bootstrap` 은 **import 만으로 프로세스 전역을 바꾼다**(judge 등록,
`register_browser_verified_task_type("dev_web")` 등). 이 파일을 평범한 import 로
짰다가 `test_dev_web_fanout.py::…marks_agent_verified` 를 깨뜨렸다 — dev_web 이
browser-verified 로 전역 등록돼 submit 동작이 바뀐 것이다.

같은 실수를 이 저장소에서 **두 번째** 한 것이다(첫 번째는 `test_bootstrap_idempotent.py`).
그래서 여기서는 격리 프로세스가 레지스트리를 JSON 으로 덤프하고, 테스트는 그 스냅샷만
본다. 이 프로세스의 전역은 건드리지 않는다.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]

# (task_type, agents_dir, agent 파일명)
INSPECTORS = [
    ("smb_file_inspect", "domains/smb", "smb_file_inspect"),
    ("dev_web_inspect", "domains/dev_web", "dev_web_inspect"),
    ("github_inspect", "domains/services/github", "github_inspect"),
    ("confluence_inspect", "domains/services/confluence", "confluence_inspect"),
    ("confluence_search_inspect", "domains/services/confluence", "confluence_search_inspect"),
]

_DUMP = r'''
import json, sys
sys.path.insert(0, %(repo)r)
import plugin.bootstrap  # noqa: F401  (등록 부수효과 — 이 프로세스 안에서만)
from secu_agent.agent.agents import get_agent
from secu_agent.agent.task_contract import get_task_contract, registered_task_contracts
from secu_agent.agent.tools import build_registry_for_task, registered_task_toolsets

out = {"contracts": sorted(registered_task_contracts()),
       "toolsets": sorted(registered_task_toolsets()), "by_type": {}}
for tt, adir, aname in %(inspectors)r:
    c = get_task_contract(tt)
    entry = {"contract": c is not None}
    if c is not None:
        entry["terminal_tools"] = sorted(c.terminal_tools)
        entry["has_build_client"] = c.build_client is not None
        try:
            entry["system_prompt_len"] = len((c.system_prompt({}) or "").strip())
        except Exception as e:
            entry["system_prompt_error"] = repr(e)
    entry["tools"] = sorted(t.name for t in build_registry_for_task(tt).all())
    a = get_agent(aname, agents_dir=%(repo)r + "/" + adir + "/agents")
    entry["agent"] = None if a is None else {
        "task_type": a.task_type, "input_keys": list(a.input_keys), "profile": a.profile}
    out["by_type"][tt] = entry
print("###JSON###" + json.dumps(out, ensure_ascii=False))
'''


@pytest.fixture(scope="module")
def snap() -> dict:
    """격리 프로세스에서 레지스트리 상태를 떠 온다 — 이 프로세스 전역은 안 건드린다."""
    env = dict(os.environ)
    prev = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = os.pathsep.join([str(_REPO), prev]) if prev else str(_REPO)
    code = _DUMP % {"repo": str(_REPO), "inspectors": INSPECTORS}
    proc = subprocess.run([sys.executable, "-c", code], cwd=str(_REPO), env=env,
                          capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, f"스냅샷 실패\n{proc.stdout}\n{proc.stderr}"
    marker = "###JSON###"
    assert marker in proc.stdout, f"스냅샷 출력 없음\n{proc.stdout}\n{proc.stderr}"
    return json.loads(proc.stdout.split(marker, 1)[1])


@pytest.mark.parametrize("task_type,_d,_n", INSPECTORS)
def test_contract_is_registered(snap, task_type, _d, _n):
    assert snap["by_type"][task_type]["contract"], (
        f"{task_type} 계약 미등록 — 코어 워커가 unsupported 로 fail-closed 된다")


@pytest.mark.parametrize("task_type,_d,_n", INSPECTORS)
def test_toolset_is_registered_not_generic_fallback(snap, task_type, _d, _n):
    """★ 이게 빠지면 정오탐 게이트가 조용히 꺼진다(Phase 0c 에서 봉합한 그 구멍)."""
    assert task_type in snap["toolsets"], (
        f"{task_type} 도구셋 미등록 — generic fallback 으로 떨어져 "
        f"코어 범용 submit_finding 을 쥔다")


@pytest.mark.parametrize("task_type,_d,_n", INSPECTORS)
def test_core_generic_submit_is_not_exposed(snap, task_type, _d, _n):
    """코어 범용 submit_finding 은 task_type judge 디스패치를 안 탄다."""
    tools = snap["by_type"][task_type]["tools"]
    assert tools, f"{task_type} 도구셋이 비어 있다"
    assert "submit_finding" not in tools, (
        f"{task_type} 에 코어 범용 submit_finding 이 노출됐다 — judge 우회 경로")


@pytest.mark.parametrize("task_type,_d,_n", INSPECTORS)
def test_terminal_tools_are_callable(snap, task_type, _d, _n):
    """부를 수 없는 종료 도구를 계약이 들고 있으면 워커가 영원히 못 끝낸다."""
    e = snap["by_type"][task_type]
    missing = set(e["terminal_tools"]) - set(e["tools"])
    assert not missing, f"{task_type} 종료 도구가 도구셋에 없다: {sorted(missing)}"


@pytest.mark.parametrize("task_type,_d,agent_name", INSPECTORS)
def test_agent_definition_loads(snap, task_type, _d, agent_name):
    """★ frontmatter name ≠ 파일명이면 조용히 skip 된다 — 그 검토원은 없는 셈이 된다."""
    a = snap["by_type"][task_type]["agent"]
    assert a is not None, f"{agent_name}.md 가 로드되지 않았다 (name/파일명 불일치?)"
    assert a["task_type"] == task_type
    assert a["input_keys"], "input_keys 가 없으면 잘못된 호출을 못 잡는다"


@pytest.mark.parametrize("task_type,_d,agent_name", INSPECTORS)
def test_agent_definition_pins_no_profile(snap, task_type, _d, agent_name):
    """⚠️ `profile:` 은 --profile-name 으로 argv 에 실려 SA_CHAT_PROFILE 을 이긴다 = 핀."""
    a = snap["by_type"][task_type]["agent"]
    assert not a["profile"], (
        f"{agent_name}.md 가 모델을 핀한다 — 단일소스는 엔진 .env 의 SA_CHAT_PROFILE")


@pytest.mark.parametrize("task_type,_d,_n", INSPECTORS)
def test_system_prompt_is_non_empty(snap, task_type, _d, _n):
    """worker.md 경로가 틀리면 계약 없는 워커가 도구만 쥐고 돈다."""
    e = snap["by_type"][task_type]
    assert "system_prompt_error" not in e, e.get("system_prompt_error")
    assert e["system_prompt_len"] > 0, f"{task_type} system prompt 가 비었다"


@pytest.mark.parametrize("task_type,_d,_n", INSPECTORS)
def test_contract_supplies_a_client_builder(snap, task_type, _d, _n):
    """★ 없으면 코어가 날것 client 를 만들어 vision/gateway 래퍼가 통째로 빠진다."""
    assert snap["by_type"][task_type]["has_build_client"]


def test_vision_dependent_inspectors_declare_a_seeing_fallback():
    """smb/dev_web 은 이미지가 근거다 — 선언된 대체가 실제로 vision 가능해야 한다.

    소스를 읽는 이유: 값을 계약 객체에서 꺼내려면 bootstrap 을 import 해야 하는데
    이 프로세스에서는 그걸 하지 않는다(모듈 docstring 참조).
    """
    import re

    from service.agents.vision_compat import supports_vision

    for rel in ("domains/smb/plugin/inspect_contract.py",
                "domains/dev_web/plugin/inspect_contract.py"):
        src = (_REPO / rel).read_text(encoding="utf-8")
        m = re.search(r'vision_fallback\s*=\s*"([^"]+)"', src)
        assert m, f"{rel} 에 vision 대체 선언이 없다"
        assert supports_vision(m.group(1)), (
            f"{rel} 의 vision 대체 {m.group(1)!r} 가 이미지를 못 받는다 "
            f"(docs/probes/vision_probe.py 로 재보라)")
