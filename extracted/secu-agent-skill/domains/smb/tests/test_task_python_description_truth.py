"""도구 설명이 사실이어야 한다 — 거짓 약속은 턴을 태운다 (2026-08-22).

## 무엇이 있었나

smb 검토원 세션 3개(a_smb, `.harness/audit.log.jsonl`)를 분해했다. `smb_task_python`
호출 7~8회 중 **절반 가까이가 에러/타임아웃**이었고, 원인이 둘로 갈렸다.

    ① API 추측 (세션마다 2회씩, 재현성 있음)
       ModuleNotFoundError: No module named 'pandas'
       sqlite3.OperationalError: no such table: smb_file_hit
    ② 호스트 지연
       error:timeout / [Errno Connection error (10.x:445)] timed out

①이 프롬프트 결함이다. 설명이 "stdlib/**3rd-party import 자유**" 라고 약속했는데
pandas·numpy·requests 는 **설치돼 있지 않다**(엔진 venv 실측). 그리고 `state` 가
"DB 큐/메타 조회" 라고만 적혀 있어 모델이 로컬 DB 파일이 있다고 추론했다 —
`sqlite3.connect("db")` 는 조용히 빈 파일을 만들고 다음 줄에서 `no such table` 이 난다.

모델은 실패한 뒤 스스로 교정했다(`# Use the provided state and smb objects instead of
pandas/sqlite3`). 즉 **알아낼 수는 있는데, 알아내는 데 매번 2턴을 쓴다.**

②는 프롬프트로 못 고친다. 다만 같은 경로 재시도는 막을 수 있어 그 지시를 넣었다.
"""
from __future__ import annotations

import importlib
import re

from domains.smb.plugin.tools.smb_task_tools import SmbTaskPythonTool


def test_description_does_not_promise_uninstalled_third_party():
    d = SmbTaskPythonTool.description
    assert "3rd-party import 자유" not in d, (
        "설치돼 있지 않은 것을 약속하면 모델이 매번 한 턴을 버린다")
    assert "pandas·numpy·requests 는 설치돼 있지 않다" in d


def test_the_modules_the_description_calls_missing_are_really_missing():
    """★ 이 경고 자체가 낡을 수 있다 — 누가 pandas 를 깔면 경고가 거짓이 된다.

    설명이 "없다" 고 말한 모듈이 실제로 import 되면 실패한다. 그때는 경고를 지워야지
    테스트를 지우면 안 된다.
    """
    d = SmbTaskPythonTool.description
    m = re.search(r"\*\*([^*]+?) 는 설치돼 있지 않다\*\*", d)
    assert m, "경고 문구 형태가 바뀌었다 — 테스트가 검사할 대상을 잃었다"
    for name in re.split(r"[·,]", m.group(1)):
        name = name.strip()
        if not name:
            continue
        try:
            importlib.import_module(name)
        except ImportError:
            continue
        raise AssertionError(
            f"{name} 이 실제로는 import 된다 — 설명의 경고가 거짓이 됐다. 경고를 고쳐라")


def test_description_says_there_is_no_local_db_file():
    """`sqlite3.connect('db')` 는 실패하지 않고 **빈 파일을 만든다** — 그래서 더 나쁘다.

    다음 줄의 `no such table` 로만 드러나서, 모델은 테이블 이름을 틀렸다고 오해한다.
    """
    d = SmbTaskPythonTool.description
    assert "로컬 DB 파일은 없다" in d
    assert "state.*" in d, "그럼 DB 를 어떻게 보라는 건지 말해야 한다"


def test_description_tells_what_to_do_on_timeout():
    """대안 없는 금지는 안 먹는다(github 에서 배운 것) — 재시도 금지 + 대체 행동."""
    d = SmbTaskPythonTool.description
    assert "같은 경로를 그대로 재시도하지 마라" in d
    i = d.index("같은 경로를 그대로 재시도하지 마라")
    tail = d[i:i + 400]
    assert "범위를 좁히" in tail and "메타데이터" in tail, "대체 행동이 같은 규칙 안에 없다"
