"""4도메인 `submit_finding` 의 task_type 핀 — 규격이 하나임을 고정.

## 무엇을 막는가

코어 judge 디스패치는 `finding.task_type` 의 **raw 문자열 조회**이고 그 필드의
기본값은 `"generic"` 이다. 워커가 필드를 빠뜨리면 등록된 도메인 게이트가 **아예
실행되지 않는다** — 에러가 아니라 침묵이고, finding 은 약한 코어 계약으로 판정된 채
정상 제출된다.

실측(2026-08-17, smb): 제출 67건 중 16건(24%)이 빠뜨렸고 4건이 `generic` 으로
살아남았다(critical 1건 포함). github 은 더 나빴다 — 코어 generic `submit_finding` 을
그대로 쓰고 있어서 `github_secret_evidence_judge` 의 `task_type != "github" → None`
가드에 걸려 **시크릿 정오탐 게이트를 통째로 건너뛰었다.**

## 규격 (4도메인 동일)

  · 비었거나 `generic` → 그 도메인으로 **확정**(거부하지 않는다).
    거부 방식은 제출을 죽인다 — dev_web 구판이 2026-08-17 하루에 6건을 죽였다.
  · 다른 도메인을 **명시** → 거부(워커의 혼동을 드러낸다).
  · 정규화한 값을 **되쓴다** — 디스패치가 raw 문자열이라 `"SMB"` 를 통과만 시키면
    `_TASK_TYPE_JUDGES.get("SMB")` 가 None 이 되어 똑같이 우회된다.
"""
from __future__ import annotations

import pytest

from secu_agent.agent.schema.finding import FindingHit, TaskFinding
from secu_agent.agent.tools.base import ToolError

from _shared.submit_task_type import ensure_task_type

DOMAINS = ["smb", "dev_web", "github", "confluence"]


def _finding(task_type: str | None = None) -> TaskFinding:
    kw = {
        "severity": "high",
        "summary": "probe",
        "hits": [FindingHit(category="secret", kind="api_key", location="a/b.py#L1")],
    }
    if task_type is not None:
        kw["task_type"] = task_type
    return TaskFinding(**kw)


# ── 규격 ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("domain", DOMAINS)
def test_unset_task_type_is_pinned_not_rejected(domain: str) -> None:
    """★ 거부하면 제출이 죽는다 — 확정한다."""
    out = ensure_task_type(_finding(), domain, tool_name="t")
    assert not isinstance(out, ToolError)
    assert out.task_type == domain


@pytest.mark.parametrize("domain", DOMAINS)
def test_generic_is_pinned(domain: str) -> None:
    out = ensure_task_type(_finding("generic"), domain, tool_name="t")
    assert not isinstance(out, ToolError)
    assert out.task_type == domain


@pytest.mark.parametrize("domain", DOMAINS)
@pytest.mark.parametrize("raw", ["{d}", "{d}  ", "  {d}"])
def test_case_and_space_variants_are_rewritten(domain: str, raw: str) -> None:
    """★ 통과만 시키고 원본을 두면 디스패치가 여전히 못 찾는다."""
    out = ensure_task_type(_finding(raw.format(d=domain.upper())), domain, tool_name="t")
    assert not isinstance(out, ToolError)
    assert out.task_type == domain, "정규화한 값을 되쓰지 않았다"


@pytest.mark.parametrize("domain", DOMAINS)
def test_explicit_other_domain_is_rejected(domain: str) -> None:
    other = next(d for d in DOMAINS if d != domain)
    out = ensure_task_type(_finding(other), domain, tool_name="t")
    assert isinstance(out, ToolError)
    assert domain in out.message and other in out.message


def test_already_correct_returns_the_same_object() -> None:
    """불필요한 복사를 만들지 않는다(증거/식별자 보존)."""
    f = _finding("smb")
    assert ensure_task_type(f, "smb", tool_name="t") is f


# ── 4도메인이 실제로 이 규격을 쓰는가 ───────────────────────────────────


@pytest.mark.parametrize("module_path,tool_name,expected", [
    ("domains.smb.plugin.tools.smb_submit_finding_tool", "smb_submit_finding", "smb"),
    ("domains.dev_web.plugin.tools.dev_web_submit_finding_tool",
     "dev_web_submit_finding", "dev_web"),
    ("domains.services.github.plugin.tools.github_submit_finding_tool",
     "github_submit_finding", "github"),
    ("domains.services.confluence.plugin.tools.confluence_submit_finding_tool",
     "confluence_submit_finding", "confluence"),
])
def test_every_domain_has_its_own_pinned_submit_tool(
    module_path: str, tool_name: str, expected: str,
) -> None:
    import importlib
    import inspect

    mod = importlib.import_module(module_path)
    src = inspect.getsource(mod)
    assert "ensure_task_type" in src, (
        f"{module_path} 이 공용 핀을 쓰지 않는다 — 규격이 갈리면 게이트가 조용히 샌다"
    )
    assert f'"{expected}"' in src
    tools = [o for _, o in inspect.getmembers(mod, inspect.isclass)
             if getattr(o, "name", None) == tool_name]
    assert tools, f"{tool_name} 도구 클래스가 없다"


@pytest.mark.parametrize("worker,expected", [
    ("service.agents.smb_task_agent", "smb_submit_finding"),
    ("service.agents.dev_web_task_agent", "dev_web_submit_finding"),
    ("service.agents.github_task_worker", "github_submit_finding"),
    ("service.agents.confluence_task_worker", "confluence_submit_finding"),
])
def test_worker_toolsets_expose_the_pinned_tool_not_core_generic(
    worker: str, expected: str,
) -> None:
    """★ 코어 generic `submit_finding` 이 다시 나타나면 게이트가 우회된다."""
    import importlib

    mod = importlib.import_module(worker)
    fn = mod._tool_classes
    try:
        names = {t.name for t in fn()}
    except TypeError:
        names = {t.name for t in fn(None)}
    assert expected in names
    assert "submit_finding" not in names, (
        f"{worker} 가 코어 generic submit_finding 을 노출한다 — 도메인 게이트가 우회된다"
    )
