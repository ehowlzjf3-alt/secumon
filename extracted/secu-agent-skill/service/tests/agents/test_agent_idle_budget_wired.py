"""모든 워커가 자기 예산을 **고른다** — 물려받지 않는다.

## 왜 이 테스트가 있나

`runtime.run_agent(max_idle_sec=None)` 은 값을 안 넘기고, 엔진 `AgentBudget` 이
기본 **120s** 를 쓴다. 대부분의 워커는 300s 를 명시했는데 `report_mail_agent` 만
빠져 있었고, 아무도 그걸 몰랐다 — 기본값은 조용하기 때문이다.

2026-08-26 실기동에서 대가를 치렀다. SMB 메일 워커 500런 중:

    완주 287 · idle 사망 213  →  **43% 사망**
    완주한 런의 1턴 응답: 중앙 4s · p90 49s · **최대 119s**

★ 최대가 상한(120s) 바로 아래라는 사실이 핵심이다. 분포가 **상한에서 잘린** 것이지
  여유가 있는 게 아니다 — 넘긴 런은 죽어서 표본에 남지 않는다. 생존자만 보면
  "119s 면 충분하다" 는 정반대 결론이 나온다.

## wall-clock 도 같은 이야기다 (같은 날 두 번째로 드러남)

idle 을 300 으로 올리자 이번엔 `wall_clock` 이 300 에서 걸렸다. 엔진 기본 wall-clock 이
**LLM 요청 타임아웃과 같은 300s** 이기 때문이다:

    AgentBudget.max_wall_clock_sec = 300     (engine)
    LLMProfile.timeout             = 300     (config/llm_profiles.yaml, codex·qwen 은 600)

같은 숫자면 **예산이 백스톱 역할을 못 한다.** 요청 하나가 멎으면 httpx 가 자기 타임아웃에
끊기 전에 워커가 먼저 죽어서, 무엇이 멎었는지 기록이 안 남는다. 실측(초안까지 간 메일 런
124건)으로는 건강한 런이 **4턴·중앙 56s·최대 120s** 라 300s 가 모자란 적은 없었다 —
모자란 건 시간이 아니라 **여유**였다.

그래서 값이 얼마인지를 검사하지 않는다. **명시했는지**를 검사한다. 값은 운영이
바꾸는 것이고(각 워커 env), 기본값을 모르는 채 물려받는 것이 결함이다.

## AST 로 보는 이유

grep 은 자기 주석과 docstring 을 잡는다(2026-08-25 단일문 테스트에서 겪음).
호출 노드의 키워드만 본다.
"""
from __future__ import annotations

import ast
import pathlib

import pytest

_ROOT = pathlib.Path(__file__).resolve().parents[3]

#: run_agent 을 **정의**하는 곳. 호출부가 아니다.
_DEFINITION = "service/agents/runtime.py"


def _call_sites() -> list[tuple[str, int, ast.Call]]:
    out: list[tuple[str, int, ast.Call]] = []
    roots = [_ROOT / "service" / "agents", _ROOT / "domains"]
    for root in roots:
        for path in sorted(root.rglob("*.py")):
            rel = path.relative_to(_ROOT).as_posix()
            if rel == _DEFINITION or "/tests/" in rel:
                continue
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except SyntaxError:  # pragma: no cover - 파싱 못 하면 이 테스트의 문제가 아니다
                continue
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                fn = node.func
                name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")
                if name == "run_agent":
                    out.append((rel, node.lineno, node))
    return out


def test_run_agent_call_sites_exist() -> None:
    """호출부가 0 이면 위 검사가 조용히 통과한다 — 그 자체가 회귀다."""
    assert len(_call_sites()) >= 5, "run_agent 호출부를 못 찾았다. 탐색 경로가 바뀌었나?"


@pytest.mark.parametrize(
    ("kwarg", "engine_default", "cost"),
    [
        ("max_idle_sec", "120s", "2026-08-26: 이 누락 하나로 SMB 메일 워커가 43% 죽었다"),
        ("max_wall_clock_sec", "300s", "요청 타임아웃과 같은 값이라 예산이 백스톱이 못 된다"),
    ],
)
def test_every_run_agent_call_sets_budget(kwarg: str, engine_default: str, cost: str) -> None:
    missing = [
        f"{rel}:{lineno}"
        for rel, lineno, node in _call_sites()
        if not any(kw.arg == kwarg for kw in node.keywords)
    ]
    assert not missing, (
        f"run_agent 호출부가 {kwarg} 를 명시하지 않았다 — 엔진 기본 {engine_default} 를 조용히 물려받는다.\n"
        "  " + "\n  ".join(missing) + f"\n  ({cost})"
    )


@pytest.mark.parametrize(
    "module_path",
    ["service/agents/report_mail_agent.py", "service/agents/reply_verify_agent.py"],
)
def test_budgets_are_env_overridable(module_path: str) -> None:
    """상한은 **운영이 바꿀 수 있어야** 한다 — 하드코딩이면 게이트웨이가 느려질 때 손이 없다."""
    sites = [(r, l, n) for r, l, n in _call_sites() if r == module_path]
    assert sites, f"{module_path} 에서 run_agent 호출을 못 찾았다"
    for rel, lineno, node in sites:
        for arg in ("max_idle_sec", "max_wall_clock_sec"):
            kw = next(k for k in node.keywords if k.arg == arg)
            src = ast.dump(kw.value)
            assert "environ" in src or "_int_env" in src, (
                f"{rel}:{lineno} 의 {arg} 이 env 로 못 바뀐다: {ast.unparse(kw.value)}"
            )


#: `config/llm_profiles.yaml` 의 최대 요청 타임아웃(codex·qwen = 600s).
#: 이 값이 바뀌면 아래 검사도 같이 봐야 한다 — 그래서 상수로 박아 눈에 띄게 둔다.
_MAX_PROFILE_TIMEOUT_SEC = 600


def test_smb_mail_budget_outlives_a_stalled_request() -> None:
    """SMB 메일 워커의 wall-clock 은 **요청 타임아웃보다 커야** 한다.

    작으면 요청이 자기 타임아웃에 끊기기 전에 워커가 먼저 죽는다 — 무엇이 멎었는지
    기록이 안 남고, 화면엔 그냥 "워커 실패" 로만 보인다(2026-08-26 실측).
    """
    sites = [
        (r, l, n) for r, l, n in _call_sites()
        if r == "service/agents/report_mail_agent.py"
    ]
    assert sites
    _, _, node = sites[0]
    for arg, floor in (
        ("max_wall_clock_sec", _MAX_PROFILE_TIMEOUT_SEC),
        # idle 은 기본 프로파일(gemma=300)만 넘으면 된다 — 요청 대기와 정지를 가르는 선.
        ("max_idle_sec", 300),
    ):
        kw = next(k for k in node.keywords if k.arg == arg)
        default = next(
            (a for a in getattr(kw.value, "args", []) if isinstance(a, ast.Constant)),
            None,
        )
        # `int(os.environ.get("X", "900"))` → 안쪽 Call 의 두 번째 인자가 기본값
        if default is None:
            inner = [a for a in getattr(kw.value, "args", []) if isinstance(a, ast.Call)]
            assert inner, f"{arg} 의 기본값을 읽지 못했다: {ast.unparse(kw.value)}"
            default = inner[0].args[-1]
        value = int(str(default.value))
        assert value > floor, (
            f"{arg}={value} 은 {floor}s 이하다 — 멎은 요청 하나가 워커를 통째로 죽인다"
        )
