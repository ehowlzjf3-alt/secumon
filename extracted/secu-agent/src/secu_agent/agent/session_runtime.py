"""세션 구동 공용 헬퍼 — web(WS) 프론트엔드와 knox 메신저 브릿지가 공유.

ChatSession.load(...) 를 구동하는 프론트엔드들이 동일한 LLM client/task 타입 매핑/
evidence 디렉터리 규칙을 쓰도록 한곳에 모은다. 기존 web/routes/chat.py 의
_make_llm_client / _runtime_task_type / _evidence_dir 를 그대로 옮긴 것이며 동작은 불변.
chat.py 는 이 함수들을 private alias 로 재노출해 테스트 monkeypatch 호환을 유지한다.
"""
from __future__ import annotations

import os
from pathlib import Path

from secu_agent.agent.llm.base import LLMClient


def make_llm_client() -> LLMClient:
    """internal_gateway 로 OpenAICompatClient. make_llm_client_from_env 가 .env 로드까지 처리."""
    from secu_agent.agent.llm.factory import make_llm_client_from_env
    return make_llm_client_from_env()


def runtime_task_type(agent_type: str) -> str:
    """프론트엔드 agent_type 라벨 → ChatSession task_type.

    v3.85: 라우팅 별칭은 등록형(agent_type_registry.resolve_task_type). 코어는
    'agent'→'operator' 만 시드; 도메인 별칭(도메인 agent_type → operator 등)은
    plugin 이 register_task_type_alias 로 등록한다(코어에 도메인 이름 미노출).
    """
    from secu_agent.agent_type_registry import resolve_task_type
    return resolve_task_type(agent_type)


def evidence_dir() -> Path:
    p = Path(os.environ.get(
        "SA_CHAT_EVIDENCE",
        str(Path.home() / ".cache" / "secu-agent" / "chat"),
    ))
    # F3: evidence_dir 는 **raw 원문 격리 스토어**(딥다이브 재열람용) — 마스킹 대상이
    # 아니라 접근 제한 대상. world-readable 로 두면 평문 원문이 노출되므로 0700.
    p.mkdir(parents=True, exist_ok=True, mode=0o700)
    import contextlib
    with contextlib.suppress(OSError):
        os.chmod(p, 0o700)  # 기존 디렉토리도 강제(umask/기존 권한 무관)
    return p
