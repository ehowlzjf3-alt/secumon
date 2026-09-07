"""`worker_result.json` 쓰기 경로가 **하나**임을 고정한다.

## 왜 이 테스트가 있나 (2026-08-20 실측)

`_write_worker_result` 정의가 8개 워커에 8벌 있었고, 공용 모듈(`service.agents.
worker_result`)을 쓰는 파일은 1개뿐이었다. 그리고 8벌이 서로 같지 않았다 — 5벌은
`json.dumps` + `write_text` 로 코어 스키마를 우회했다.

우회의 대가가 편의가 아니라 **손실**이었다:

  · 원자성 상실 — 코어는 tmp+os.replace 인데 손수 기록은 truncated 파일을 남길 수 있다.
  · clamp 상실 — 음수 카운트/초과 evidence_paths 가 그대로 나간다.
  · 검증 상실 — 스키마 위반이 쓰기 시점이 아니라 **부모의 fail-closed reader** 에서
    드러난다. 그 시점엔 "결과가 나쁘다"가 아니라 **타깃이 소실**된다(claim 해제).

우회한 이유로 짐작되던 것(침묵 장부 `candidates_seen`/`accounted`)은 근거가 없었다 —
코어 `build_worker_result` 가 처음부터 두 필드를 지원한다.

이 테스트는 그 8벌이 다시 자라는 것을 막는다.
"""
from __future__ import annotations

import ast
import pathlib

import pytest

AGENTS_DIR = pathlib.Path(__file__).resolve().parents[2] / "agents"


def _worker_modules() -> list[pathlib.Path]:
    return sorted(p for p in AGENTS_DIR.glob("*_worker.py"))


def test_there_are_worker_modules_to_check() -> None:
    """glob 이 0개를 잡으면 아래 검사가 전부 헛통과한다."""
    assert len(_worker_modules()) >= 6


@pytest.mark.parametrize("path", _worker_modules(), ids=lambda p: p.name)
def test_worker_does_not_define_its_own_result_writer(path: pathlib.Path) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    local = [n.name for n in ast.walk(tree)
             if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
             and "write_worker_result" in n.name]
    assert not local, (
        f"{path.name} 이 자체 결과 writer 를 정의한다: {local}. "
        "`from service.agents.worker_result import write_worker_result` 을 쓸 것 — "
        "손수 기록은 원자성·clamp·스키마 검증을 잃고, 그 대가는 타깃 소실이다."
    )


def _docstring_nodes(tree: ast.AST) -> set[int]:
    """docstring 상수 노드의 id — 문서에서 파일명을 **언급**하는 건 정상이다."""
    out: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef,
                                 ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body = getattr(node, "body", None)
        if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
            out.add(id(body[0].value))
    return out


@pytest.mark.parametrize("path", _worker_modules(), ids=lambda p: p.name)
def test_worker_does_not_hand_roll_the_result_file(path: pathlib.Path) -> None:
    """`worker_result.json` 파일명을 **코드에서** 직접 다루는 워커가 없어야 한다.

    docstring 언급은 허용한다 — 계약을 설명하는 문장까지 막으면 문서가 사라진다.
    막으려는 건 `(evidence_dir / "worker_result.json").write_text(...)` 쪽이다.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docs = _docstring_nodes(tree)
    offenders = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.Constant) and n.value == "worker_result.json"
        and id(n) not in docs
    ]
    assert not offenders, (
        f"{path.name}:{offenders[0].lineno} 이 결과 파일명을 코드에서 직접 다룬다 — "
        "공용 writer 를 통해야 한다(원자성·clamp·스키마 검증)."
    )


def test_shared_writer_passes_the_silence_ledger_through() -> None:
    """★ 손수 기록의 유일한 명분이었던 필드가 공용 경로로 실제로 나가는지.

    seen>0 & accounted==0 은 clean 이 아니라 무해명 침묵이다(v3.90). 통합하면서
    이 두 필드가 조용히 빠지면 침묵 게이트가 **항상 0** 을 보고 통과시킨다.
    """
    import json
    import tempfile

    from service.agents.worker_result import write_worker_result

    with tempfile.TemporaryDirectory() as d:
        ev = pathlib.Path(d)
        write_worker_result(ev, status="ok", summary="probe", rc=0,
                            candidates_seen=7, candidates_accounted=3)
        payload = json.loads((ev / "worker_result.json").read_text(encoding="utf-8"))

    assert payload["candidates_seen"] == 7
    assert payload["candidates_accounted"] == 3


def test_shared_writer_clamps_instead_of_losing_the_report() -> None:
    """데이터 유래 필드는 clamp — 죽음 보고가 ValidationError 로 사라지면 안 된다."""
    import json
    import tempfile

    from service.agents.worker_result import write_worker_result

    with tempfile.TemporaryDirectory() as d:
        ev = pathlib.Path(d)
        write_worker_result(ev, status="error_crash", summary="x" * 900, rc=1,
                            findings=-5)
        payload = json.loads((ev / "worker_result.json").read_text(encoding="utf-8"))

    assert len(payload["summary"]) <= 500
    assert payload["findings_count"] == 0
