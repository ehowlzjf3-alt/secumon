"""리드 유저 메시지(절차)를 **서브프로세스에서** 뽑는다.

## 왜 서브프로세스인가 — 실측 2026-08-27

`build_user_message()` 는 계약을 통해 `plugin.bootstrap.register_all()` 을 부른다:

    build_user_message → lead_contract._ensure_env → runtime._ensure_dotenv
      → load_runtime_env(load_plugins=True) → plugin/bootstrap.py:449 register_all()
        → register_category_evidence_judge("pii" / "secret")
        → register_browser_verified_task_type("web","dev_web","devops","github","confluence")

세 테스트 파일이 각자 "★ `register_all()` 은 부르지 않는다 — 필요한 건 어댑터
하나뿐" 이라고 주석에 적어놓고 **셋 다 부르고 있었다.** 직접 안 부를 뿐 계약이 대신
불렀다. 주석은 믿음이지 사실이 아니다.

대가는 그 파일들 **밖에서** 났다. `dev_web` 브라우저 검증 게이트가 켜진 채로 남아
`service/tests/agents/test_dev_web_fanout.py` 가 전수 스위트에서만 깨졌다 —
단독 실행은 통과해서 원인이 어디인지 안 보였다. `plugin/tests` 의 판정기 등록
테스트 16건도 "이미 등록됨" 으로 같이 죽었다.

## 규칙

- **여기 한 곳에서만** 뽑는다. 파일마다 복사하면 한 곳이 다시 in-process 로 돌아간다.
- `lru_cache` — 같은 인자면 서브프로세스는 한 번만 돈다(전수 스위트에서 3분 → 3초 차이).
- 이 파일은 `test_` 접두가 없어 pytest 가 수집하지 않는다.
"""
from __future__ import annotations

import functools
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

_MARKER = "###PROC###"

_DUMP = r'''
import os, sys
sys.path.insert(0, %(repo)r)
_sessions = %(sessions)r
if _sessions is not None:
    os.environ["SA_LEAD_SESSIONS"] = _sessions
from pathlib import Path
from _shared.lead_adapter import register_lead_adapter
from _shared.lead_contract import build_lead_contract
from domains.smb.plugin.lead_adapter import smb_lead_adapter

register_lead_adapter(smb_lead_adapter())
c = build_lead_contract(domain="smb", agents_dir=Path(%(repo)r) / "domains" / "smb" / "agents")
sys.stdout.write(%(marker)r + c.build_user_message(%(spec)s, None))
'''

#: 기본 스펙 — 절차 문구만 보는 테스트용(타깃 내용은 무관).
DEFAULT_SPEC: dict = {"charter_ref": "T", "target": {}}


@functools.lru_cache(maxsize=8)
def _run(spec_repr: str, sessions: str | None) -> str:
    env = dict(os.environ)
    prev = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = os.pathsep.join([str(REPO), prev]) if prev else str(REPO)
    code = _DUMP % {"repo": str(REPO), "spec": spec_repr,
                    "sessions": sessions, "marker": _MARKER}
    proc = subprocess.run([sys.executable, "-c", code], cwd=str(REPO), env=env,
                          capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, f"절차 추출 실패\n{proc.stdout}\n{proc.stderr}"
    assert _MARKER in proc.stdout, f"절차 출력 없음\n{proc.stdout}\n{proc.stderr}"
    return proc.stdout.split(_MARKER, 1)[1]


def procedure(spec: dict | None = None, *, sessions: bool | None = None) -> str:
    """리드 유저 메시지. `sessions=None` 이면 `SA_LEAD_SESSIONS` 를 건드리지 않는다.

    ⚠️ skip 하지 않는다. 어댑터가 없다고 건너뛰면 "절차와 계약 본문이 같이 움직이는가"
       라는 검증이 조용히 안 돈다 — 초록불인데 아무것도 안 잰 상태가 된다.
    """
    payload = DEFAULT_SPEC if spec is None else spec
    flag = None if sessions is None else ("1" if sessions else "0")
    # dict 는 hashable 이 아니라 repr 로 캐시 키를 만든다. 그 값이 서브프로세스
    # 코드에 **리터럴 그대로** 박히므로 템플릿은 %(spec)s 다 — %r 을 걸면
    # 리터럴이 문자열로 한 겹 더 싸여 `'str' object has no attribute 'get'` 이 난다.
    return _run(repr(payload), flag)
