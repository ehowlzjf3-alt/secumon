"""자율(무인) 실행에서 도구 capability 를 여는 운영자 opt-in 게이트 + 상한.

`SA_AUTONOMOUS_TOOLS`(comma-separated)는 **자율 실행의 필요조건이자 상한**이다 — 여기 없으면 무인에서
막힌다. 단 **충분조건은 아니다**: destructive 툴은 이 목록에 있어도 승인 게이트(check_permission→ask)를
통과해야 하고, 무인 워커엔 resolver 가 없으면 여전히 fail-closed. v3.89 부터 CapabilityGrant 모델
(capability.py)이 이 상한 안에서 per-run scoped resolver 로 ask 를 해소한다.

형식: bare 도구명(`browser_action`)=그 도구 전체 action, 또는 `tool:action`(`browser_action:navigate`)=
그 action 만. `SA_AUTONOMOUS_RISK_ACTIONS`(comma `tool:action`)=login 같은 위험-단위 별도 opt-in.
미설정 = 전면 불가(하드 deny). delivery 의 `SA_DELIVERY_AUTOSEND_SINKS` 와 같은 allowlist 패턴.

예:  SA_AUTONOMOUS_TOOLS="browser_session, browser_action:navigate"
     SA_AUTONOMOUS_RISK_ACTIONS="browser_action:login"
"""
from __future__ import annotations

import os

AUTONOMOUS_TOOLS_ENV = "SA_AUTONOMOUS_TOOLS"
AUTONOMOUS_RISK_ACTIONS_ENV = "SA_AUTONOMOUS_RISK_ACTIONS"


def _split_env(name: str) -> list[str]:
    return [t.strip() for t in os.environ.get(name, "").split(",") if t.strip()]


def autonomous_allowed_capabilities() -> frozenset[tuple[str, str]]:
    """운영자 상한을 (tool, action) 집합으로. bare `tool` → `(tool, "")`(그 도구 전체 action).
    `tool:action` → `(tool, action)`. 미설정 = 빈 집합(하드 deny).
    ★ strict: `tool:`(빈 action)·`:action`(빈 tool)·`a:b:c`(다중 콜론)는 **malformed → skip**
    (오타가 whole-tool wildcard 로 권한확대되던 것 봉쇄 — codex)."""
    caps: set[tuple[str, str]] = set()
    for entry in _split_env(AUTONOMOUS_TOOLS_ENV):
        parts = entry.split(":")
        if len(parts) == 1:
            tool = parts[0].strip()
            if tool:
                caps.add((tool, ""))              # bare tool = 전체 action
        elif len(parts) == 2:
            tool, action = parts[0].strip(), parts[1].strip()
            if tool and action:                    # 둘 다 non-empty 여야 유효
                caps.add((tool, action))
        # 그 외(빈 action/빈 tool/다중 콜론) = malformed → 무시(wildcard 확대 방지)
    return frozenset(caps)


def autonomous_allowed_risk_actions() -> frozenset[str]:
    """운영자가 opt-in 한 위험-단위 `tool:action` 집합(예: browser_action:login). 미설정 = 빈 집합."""
    return frozenset(e for e in _split_env(AUTONOMOUS_RISK_ACTIONS_ENV) if ":" in e)


def autonomous_allowed_tools() -> frozenset[str]:
    """레거시 deny-정련용 — 상한에 **bare 도구명**(action 미지정, `(tool, "")`)으로 오른 것만.
    ★ `tool:action` 항목은 제외한다(codex): 그건 CapabilityGrant 전용 action-cap 이지 whole-tool opt-in 이
    아니다. 안 그러면 `SA_AUTONOMOUS_TOOLS=python_exec:x` 가 레거시 경로에서 python_exec 전체로 승격되는
    회귀(구 파서에선 `python_exec:x != python_exec` 라 deny 였음)."""
    return frozenset(t for t, a in autonomous_allowed_capabilities() if a == "")


def is_autonomous_tool_allowed(tool_name: str) -> bool:
    """`tool_name` 이 무인(schedule_origin) 실행 상한에 **bare 로** 있는가(필요조건·deny 정련용). action
    세분은 CapabilityGrant.permits 가. bare tool 만 매칭 → 구 파서 back-compat(회귀 없음)."""
    return tool_name in autonomous_allowed_tools()
