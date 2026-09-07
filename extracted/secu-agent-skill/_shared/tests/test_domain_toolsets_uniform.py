"""4도메인이 **같은 자리**에서 도구셋을 공급하는지 — 규격 통일 고정.

## 배경 (2026-08-20)

도구셋이 도메인마다 다른 곳에 있었다. `plugin/toolsets.py` 는 smb 에만 있었고, 나머지
3도메인은 워커 진입점(`service/agents/*.py`)의 `_tool_classes()` 안에 목록을 들고
있었다. dev_web 은 거기서 도구 클래스를 **지역 클래스로 정의**하기까지 했다.

문제는 재사용이다. 도구셋이 워커 진입점에 있으면 같은 도메인의 다른 실행 경로
(sub-agent 위임, 재검증, 운영자)가 그 목록을 쓸 수 없다 — Phase 1 의 검토원
(`<d>_inspect`)이 정확히 그 재사용을 필요로 한다.

코어는 `register_task_toolset(task_type, provider)` 등록형 훅을 이미 제공한다(v3.85,
코어 하드코딩 switch 없음). provider 를 도메인이 소유하면 배선만 남는다.
"""
from __future__ import annotations

import importlib

import pytest

# (도메인, toolsets 모듈, provider 이름, 워커 모듈, provider 인자)
DOMAINS = [
    ("smb", "domains.smb.plugin.toolsets", "smb_task_tools",
     "service.agents.smb_task_agent", ()),
    ("dev_web", "domains.dev_web.plugin.toolsets", "dev_web_task_tools",
     "service.agents.dev_web_task_agent", ()),
    ("github", "domains.services.github.plugin.toolsets", "github_task_tools",
     "service.agents.github_task_worker", ()),
    ("confluence", "domains.services.confluence.plugin.toolsets", "confluence_task_tools",
     "service.agents.confluence_task_worker", (None,)),
]


@pytest.mark.parametrize("domain,mod,fn,worker,args", DOMAINS,
                         ids=[d[0] for d in DOMAINS])
def test_every_domain_owns_its_toolset_provider(
    domain: str, mod: str, fn: str, worker: str, args: tuple,
) -> None:
    provider = getattr(importlib.import_module(mod), fn)
    tools = list(provider(*args))
    assert tools, f"{mod}.{fn} 이 빈 도구셋을 준다"
    assert all(getattr(t, "name", None) for t in tools)


@pytest.mark.parametrize("domain,mod,fn,worker,args", DOMAINS,
                         ids=[d[0] for d in DOMAINS])
def test_worker_delegates_to_the_domain_provider(
    domain: str, mod: str, fn: str, worker: str, args: tuple,
) -> None:
    """★ 워커가 자기 목록을 다시 들면 재사용이 끊긴다."""
    provider = getattr(importlib.import_module(mod), fn)
    wmod = importlib.import_module(worker)
    assert {t.name for t in wmod._tool_classes(*args)} == {t.name for t in provider(*args)}


@pytest.mark.parametrize("domain,mod,fn,worker,args", DOMAINS,
                         ids=[d[0] for d in DOMAINS])
def test_worker_entrypoint_does_not_define_tool_classes(
    domain: str, mod: str, fn: str, worker: str, args: tuple,
) -> None:
    """dev_web 이 하던 '진입점 안 지역 클래스' 패턴이 되살아나는 것을 막는다."""
    import inspect

    src = inspect.getsource(importlib.import_module(worker))
    offenders = [ln.strip() for ln in src.splitlines()
                 if ln.lstrip().startswith("class ") and "Tool" in ln]
    assert not offenders, (
        f"{worker} 이 도구 클래스를 직접 정의한다: {offenders}. "
        f"{mod} 로 옮겨라 — 진입점에 있으면 다른 실행 경로가 재사용할 수 없다."
    )
