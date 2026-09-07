"""절차 추출이 이 프로세스를 오염시키지 않는가 — 사고 재발 가드 (2026-08-27).

## 무엇이 있었나

세 테스트 파일이 각자 `build_user_message()` 를 in-process 로 불렀고, 셋 다 주석에
"★ `register_all()` 은 부르지 않는다 — 필요한 건 어댑터 하나뿐" 이라고 적어놨다.
**틀린 말이었다.** 계약이 대신 부른다:

    build_user_message → lead_contract._ensure_env → runtime._ensure_dotenv
      → load_runtime_env(load_plugins=True) → plugin/bootstrap.py:449 register_all()

대가는 그 파일들 밖에서 났다:

    service/tests/agents/test_dev_web_fanout.py   전수 스위트에서만 실패
                                                  (dev_web 브라우저 검증 게이트가 켜진 채)
    plugin/tests/test_*_evidence_judge.py  16건   "이미 등록됨" 으로 ERROR

단독 실행은 전부 통과해서, 원인이 어디인지 세 번 잘못 짚었다.

## 이 파일이 하는 일

주석으로는 못 막는다는 것이 교훈이라 **테스트로** 못박는다. 절차를 뽑은 뒤
전역 레지스트리가 그대로여야 한다.
"""
from __future__ import annotations

from _shared.tests import _lead_procedure


def _snapshot() -> tuple[frozenset, frozenset]:
    import secu_agent.agent.evidence_judgment as ej
    return (frozenset(ej._CATEGORY_JUDGES),
            frozenset(ej._BROWSER_VERIFIED_TASK_TYPES))


def test_extracting_the_procedure_leaves_the_registries_untouched():
    before = _snapshot()
    text = _lead_procedure.procedure()
    assert text, "절차가 비어 있으면 이 테스트는 아무것도 안 잰 것이다"
    judges, browser = _snapshot()
    assert judges == before[0], (
        f"category 판정기가 등록됐다 (+{sorted(judges - before[0])}) — 격리가 풀렸다")
    assert browser == before[1], (
        f"browser 검증 게이트가 켜졌다 (+{sorted(browser - before[1])}) — 격리가 풀렸다")


def test_session_variant_is_also_isolated():
    """`sessions=` 인자는 서브프로세스 환경만 바꿔야 한다."""
    before = _snapshot()
    assert _lead_procedure.procedure(sessions=True)
    assert _lead_procedure.procedure(sessions=False)
    assert _snapshot() == before


def test_no_test_file_builds_the_user_message_in_process():
    """★ 네 번째 파일이 같은 실수를 반복하면 여기서 걸린다.

    `_lead_procedure` 는 서브프로세스 코드 **문자열** 안에서만 부른다(= 실제 호출 아님).
    그 외 테스트 파일에서 `build_user_message` 를 직접 부르면 전역이 오염된다.
    """
    import ast
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[2]
    offenders: list[str] = []
    for path in sorted(root.rglob("test_*.py")):
        if "node_modules" in path.parts or ".venv" in path.parts:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError):
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            fn = node.func
            name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")
            if name == "build_user_message":
                offenders.append(f"{path.relative_to(root)}:{node.lineno}")
    assert not offenders, (
        "테스트가 build_user_message 를 in-process 로 부른다 — "
        f"_lead_procedure.procedure() 를 쓰라: {offenders}")
