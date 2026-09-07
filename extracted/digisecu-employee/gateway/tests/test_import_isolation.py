"""connect() 격리 회귀 — 게이트웨이 import가 skill/engine을 끌어오거나 bootstrap 심볼을 호출하지 않음(무DB).

codex 리스크(read-model import가 DDL/write 우회)를 CI로 봉인한다.
"""
import ast
import pathlib
import sys

GW_SRC = pathlib.Path(__file__).resolve().parents[1] / "src" / "digisecu_gateway"

# 게이트웨이가 절대 호출하면 안 되는 skill/engine bootstrap·쓰기 심볼(첫 호출에 DDL/UPDATE 트리거).
FORBIDDEN_CALLS = {
    "_ensure_domain_schema",
    "_connect_postgres",
    "_core_connect",
    "finding_upsert",
    "_ensure_schema_version",
}


def test_import_no_engine_skill_leak():
    """게이트웨이 import → secu_agent/service/도메인 스킬 모듈 미로드(connect() 격리)."""
    import digisecu_gateway.app  # noqa: F401  (side-effect: 전체 import 그래프)

    leaked = [
        m
        for m in sys.modules
        if m.split(".")[0] in ("secu_agent", "service")
        or (m == "domains" or m.startswith("domains."))
    ]
    assert leaked == [], f"engine/skill 모듈 누수(격리 위반): {leaked}"


def test_no_forbidden_bootstrap_calls():
    """게이트웨이 소스에서 skill/engine bootstrap 심볼 **호출**(AST Call)이 0건 — 주석/문자열 언급은 무시."""
    offenders: list[str] = []
    for path in GW_SRC.rglob("*.py"):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            fn = node.func
            name = (
                fn.attr if isinstance(fn, ast.Attribute) else fn.id if isinstance(fn, ast.Name) else None
            )
            if name in FORBIDDEN_CALLS:
                offenders.append(f"{path.name}:{node.lineno} {name}()")
    assert offenders == [], f"금지 bootstrap 호출: {offenders}"


def test_no_skill_engine_imports():
    """게이트웨이 런타임 소스는 secu_agent/service/domains(스킬)를 import하지 않는다."""
    bad: list[str] = []
    for path in GW_SRC.rglob("*.py"):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            mods: list[str] = []
            if isinstance(node, ast.Import):
                mods = [a.name for a in node.names]  # 항상 절대
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                mods = [node.module]  # level>0 = 게이트웨이 내부 상대 import(예: .domains) → 제외
            for m in mods:
                top = m.split(".")[0]
                if top in ("secu_agent", "service") or top == "domains":
                    bad.append(f"{path.name}:{node.lineno} import {m}")
    assert bad == [], f"스킬/엔진 import(격리 위반): {bad}"
