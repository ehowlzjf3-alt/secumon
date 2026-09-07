"""코어에 도메인 이름이 박혀 있지 않은지 (de-domain, 2026-08-20).

## 무엇을 찾았나

"코어는 깨끗한 범용 에이전트여야 한다" 를 실제로 훑어보니, 도구 클래스는 이미 없었지만
다른 형태로 5종이 남아 있었다:

  ① engine `_NO_STASH_TOOLS` 에 도메인 도구 이름 9개 — 그중 **7개는 이미 없는 이름**
     (smb_enum_hosts / smb_list_shares / smb_walk_share / gh_list_repos /
      gh_list_paths_matching / jenkins_list_jobs / jenkins_list_builds).
     도메인 도구가 사라져도 코어는 알 길이 없어 죽은 채로 남았다 → 등록형으로.
  ② skill_tool 프롬프트가 `smb_tasking/api.md` 를 예로 든다 — **로드되지 않는 이름**을
     모델에게 가르치고 있었다.
  ③ 범용 `submit_task_result` 설명이 폐기된 `smb_agent_type` 을 예로 든다.
  ④ state.py 의 고아 섹션 배너 2개(`# smb_credential`, `# smb_target_subnet`)가
     전혀 다른 함수를 라벨링하고 있었다(de-domain 때 테이블만 옮겨감).
  ⑤ `_CORE_TASK_TYPE_ALIASES` 의 'smb' 시드 — plugin 으로 이관.

## 무엇을 남겼나

- `skill_smb` (state.py): DB **스키마 소유권 가드**다. 코어가 "이 테이블은 platform 이
  아니라 skill_smb 소유여야 한다" 를 강제하는 것이라 도메인 누출이 아니다.
- 과거 실패를 설명하는 주석(`_arg_coercion` 의 모델 실패모드 등): 그 코드가 왜 있는지의
  근거다. 지우면 근거가 사라진다.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[1] / "src" / "secu_agent"

# 도메인 이름이 **동작에 영향을 주는** 자리 = 문자열 리터럴/식별자.
_DOMAIN_TOKENS = ("smb_", "gh_list", "jenkins_", "confluence_", "dev_web")

# 정당한 예외 — 이유는 위 docstring 참조.
_ALLOWED = re.compile(r"skill_smb")


def _code_lines(path: Path):
    """주석/docstring 을 뺀 실행 라인만 — 과거를 설명하는 주석은 대상이 아니다."""
    import ast
    import io
    import tokenize

    src = path.read_text(encoding="utf-8")
    doc_lines: set[int] = set()
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef,
                             ast.AsyncFunctionDef)):
            d = ast.get_docstring(node, clean=False)
            if d is not None and node.body:
                first = node.body[0]
                for ln in range(first.lineno, (first.end_lineno or first.lineno) + 1):
                    doc_lines.add(ln)
    comment_lines = set()
    try:
        for tok in tokenize.generate_tokens(io.StringIO(src).readline):
            if tok.type == tokenize.COMMENT:
                comment_lines.add(tok.start[0])
    except (tokenize.TokenError, IndentationError):
        pass
    out = []
    for i, line in enumerate(src.splitlines(), start=1):
        if i in doc_lines or i in comment_lines:
            continue
        out.append((i, line))
    return out


_TARGETS = [
    _SRC / "agent" / "engine.py",
    _SRC / "agent" / "tools" / "skill_tool.py",
    _SRC / "agent" / "tools" / "submit_task_result.py",
    _SRC / "agent_type_registry.py",
]


@pytest.mark.parametrize("path", _TARGETS, ids=lambda p: p.name)
def test_no_domain_names_in_executable_lines(path: Path) -> None:
    hits = []
    for lineno, line in _code_lines(path):
        stripped = _ALLOWED.sub("", line)
        for tok in _DOMAIN_TOKENS:
            if tok in stripped:
                hits.append(f"{path.name}:{lineno}: {line.strip()[:100]}")
    assert not hits, (
        "코어 실행 코드에 도메인 이름이 있다 — 등록형 훅으로 빼라:\n" + "\n".join(hits)
    )


def test_no_stash_is_registerable_and_core_only_by_default() -> None:
    """도메인 도구는 plugin 이 등록한다 — 코어 기본값엔 없어야 한다."""
    from secu_agent.agent.engine import (
        no_stash_tools, register_no_stash_tool, unregister_no_stash_tool,
    )

    base = no_stash_tools()
    assert "skill" in base and "scan_text" in base, "코어 자기 도구가 빠졌다"
    assert not any(t.startswith(("smb_", "gh_", "jenkins_", "confluence_"))
                   for t in base), f"코어 기본값에 도메인 도구가 있다: {sorted(base)}"

    register_no_stash_tool("some_domain_list")
    try:
        assert "some_domain_list" in no_stash_tools()
    finally:
        unregister_no_stash_tool("some_domain_list")
    assert "some_domain_list" not in no_stash_tools()


def test_core_alias_seed_has_no_domain_name() -> None:
    """'smb'→'operator' 는 plugin 소유다(2026-08-20 이관)."""
    from secu_agent.agent_type_registry import _CORE_TASK_TYPE_ALIASES

    assert set(_CORE_TASK_TYPE_ALIASES) == {"agent"}, (
        f"코어 별칭 시드에 도메인 이름이 있다: {sorted(_CORE_TASK_TYPE_ALIASES)}"
    )
