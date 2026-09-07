"""`register_all()` 이 멱등인지 — 이미 등록된 이름이 있어도 죽지 않아야 한다.

## 배경 (2026-08-20 실측)

코어 테스트 5건이 이렇게 죽고 있었다:

    PluginLoadError: plugin import 실패 (…/plugin/bootstrap.py):
        ValueError("agent_type 'smb' 이미 등록됨")

원인은 이중 로드가 아니라 **등록 주체가 둘**인 것이었다:

    1) secu-agent/tests/web/conftest.py::_plugin_agent_types_registered
       → 도메인 agent_type 을 수동 등록(플러그인 미부착 형상 시뮬레이션)
    2) 같은 테스트의 client fixture → create_app() → load_plugins() → register_all()

그 픽스처도 `except ValueError: continue` 로 방어하지만 **순서가 반대**라 소용이 없다.
픽스처가 먼저 등록하고 플러그인이 나중에 터진다. 엔진 `load_plugins` 의 멱등성
(`_LOADED`)도 이 경우는 못 막는다 — 파일은 처음 로드되는 게 맞기 때문이다.

## 왜 코어를 안 고쳤나

코어의 중복 거부는 "오타·미부착 plugin 을 보이게 하는 UX 게이트"로 의도된 것이다
(`agent_type_registry` docstring). 그 엄격함은 유지하고, **"같은 사실을 두 번 선언한
것은 충돌이 아니다"** 라는 판단을 plugin 쪽에서 흡수한다.

Phase 1 에서 `register_task_contract` 를 새로 등록할 예정이라 같은 함정을 미리 막는다.

## ★ 왜 전부 서브프로세스인가 (2026-08-20, 이 파일이 스위트를 깨뜨린 뒤)

`plugin.bootstrap` 은 **import 만으로 프로세스 전역 레지스트리를 바꾼다**
(judge 등록, `register_browser_verified_task_type("dev_web")` 등). 스위트는 그래서
이 모듈을 in-process 로 import 하지 않는다 — `test_github_secret_evidence_judge.py`
가 bootstrap 을 **텍스트로 읽어** 검사하는 것이 그 규약의 흔적이다.

이 파일을 평범한 import 로 짰더니 알파벳 순서상 먼저 돌면서:
  - `plugin/tests/test_pii_evidence_judge.py` (4) — 픽스처가 'pii' 를 등록하려다 중복 ValueError
  - `plugin/tests/test_smb_evidence_judge.py` (5) — 같은 이유로 'smb'
  - `service/tests/agents/test_dev_web_fanout.py::…marks_agent_verified` — dev_web 이
    browser-verified 로 전역 등록돼 submit 동작이 바뀜
총 9 errors + 1 failed 를 만들었다. **멱등성을 테스트하려고 전역을 오염시키면 안 된다.**
그래서 각 케이스를 격리 프로세스에서 돌린다.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

_SKILL_ROOT = Path(__file__).resolve().parents[2]


def _run(body: str) -> subprocess.CompletedProcess[str]:
    """격리 프로세스에서 body 를 실행 — bootstrap 전역 부작용을 이 프로세스에 남기지 않는다."""
    env = dict(os.environ)
    prev = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = os.pathsep.join([str(_SKILL_ROOT), prev]) if prev else str(_SKILL_ROOT)
    return subprocess.run(
        [sys.executable, "-c", body],
        cwd=str(_SKILL_ROOT), env=env, capture_output=True, text=True, timeout=180,
    )


def _ok(proc: subprocess.CompletedProcess[str], marker: str = "OK") -> None:
    assert proc.returncode == 0, f"rc={proc.returncode}\n--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
    assert marker in proc.stdout, f"marker 없음\n--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"


def test_register_all_is_idempotent() -> None:
    """★ import 시 1회 + 명시 호출 2회 = 총 3회를 견뎌야 한다."""
    _ok(_run(
        "import plugin.bootstrap as b\n"
        "b.register_all()\n"
        "b.register_all()\n"
        "print('OK')\n"
    ))


def test_register_all_survives_preregistered_agent_types() -> None:
    """코어 테스트 픽스처가 먼저 등록해 둔 상황을 그대로 재현 — 등록 순서가 반대다."""
    _ok(_run(
        "from secu_agent.agent_type_registry import register_agent_type\n"
        "for n in ('smb', 'github', 'dev_web', 'confluence'):\n"
        "    register_agent_type(n)\n"
        "import plugin.bootstrap  # 여기서 죽으면 안 된다\n"
        "print('OK')\n"
    ))


def test_preregistered_toolset_and_judge_do_not_break_bootstrap() -> None:
    """agent_type 말고 다른 레지스트리도 같은 함정 — toolset/judge 를 먼저 점유해 둔다."""
    _ok(_run(
        "from secu_agent.agent.evidence_judgment import register_category_evidence_judge\n"
        "from secu_agent.agent.tools import register_task_toolset\n"
        "register_category_evidence_judge('pii', lambda f, h: None)\n"
        "register_task_toolset('smb_lead', lambda ctx: [])\n"
        "import plugin.bootstrap\n"
        "print('OK')\n"
    ))


# ── 흡수 범위 ────────────────────────────────────────────────────────────
# `_register_idempotent` 자체는 순수 함수라 in-process 로 볼 수 있으면 좋겠지만,
# import 하려면 bootstrap 모듈이 실행된다 → 여기도 격리한다.


def test_soft_duplicate_is_absorbed_in_both_languages() -> None:
    """코어 메시지가 한국어/영어로 갈려 있다 — 둘 다 흡수해야 한다."""
    _ok(_run(
        "from plugin.bootstrap import _register_idempotent as ri\n"
        "def ko(*a, **k): raise ValueError(\"agent_type 'smb' 이미 등록됨\")\n"
        "def en(*a, **k): raise ValueError(\"task_type toolset already registered: 'smb_lead'\")\n"
        "assert ri(ko) is False\n"
        "assert ri(en) is False\n"
        "print('OK')\n"
    ))


def test_first_registration_reports_true_and_passes_args() -> None:
    _ok(_run(
        "from plugin.bootstrap import _register_idempotent as ri\n"
        "calls = []\n"
        "assert ri(calls.append, 'x') is True\n"
        "assert calls == ['x']\n"
        "print('OK')\n"
    ))


def test_hard_conflict_is_not_swallowed() -> None:
    """★ 같은 이름에 **다른 내용** 이면 진짜 충돌 — 삼키면 DB 계약이 두 갈래가 된다."""
    _ok(_run(
        "from plugin.bootstrap import _register_idempotent as ri\n"
        "def ddl(*a, **k): raise ValueError(\"schema namespace already registered with different DDL: 'smb'\")\n"
        "try:\n"
        "    ri(ddl)\n"
        "except ValueError as e:\n"
        "    assert 'different DDL' in str(e)\n"
        "    print('OK')\n"
        "else:\n"
        "    raise SystemExit('hard conflict 를 삼켰다')\n"
    ))


def test_unrelated_errors_still_propagate() -> None:
    """진짜 배선 오류를 삼키면 안 된다 — ValueError 도, 다른 예외도."""
    _ok(_run(
        "from plugin.bootstrap import _register_idempotent as ri\n"
        "def bad_value(*a, **k): raise ValueError('agent_type 이름 비어 있음')\n"
        "def bad_type(*a, **k): raise RuntimeError('배선 실패')\n"
        "for fn, exc in ((bad_value, ValueError), (bad_type, RuntimeError)):\n"
        "    try:\n"
        "        ri(fn)\n"
        "    except exc:\n"
        "        pass\n"
        "    else:\n"
        "        raise SystemExit(f'{exc.__name__} 를 삼켰다')\n"
        "print('OK')\n"
    ))


def test_this_file_does_not_import_bootstrap_in_process() -> None:
    """★ 회귀 가드 — 이 파일이 다시 전역을 오염시키지 않도록.

    2026-08-20 에 실제로 9 errors + 1 failed 를 만든 실수다.

    문자열 검사로 짜면 **가드 자신의 소스가 매칭돼** 항상 실패한다(실제로 그랬다).
    실행되는 import 문만 보려면 AST 를 봐야 한다 — 서브프로세스에 넘기는 코드는
    `ast.Constant` 라 여기 걸리지 않는다.
    """
    import ast

    tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
    offenders: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            offenders += [a.name for a in node.names if a.name.startswith("plugin.")]
        elif isinstance(node, ast.ImportFrom):
            if (node.module or "").startswith("plugin."):
                offenders.append(node.module)
    assert not offenders, (
        f"이 파일이 in-process 로 plugin 모듈을 import 한다: {offenders} — "
        "bootstrap 은 import 만으로 전역 레지스트리를 바꾼다. _run() 으로 격리할 것"
    )
