"""PythonExecTool — operator agent 가 임의 Python 코드 실행.

v3.33 부터 sandbox 룰 (import 차단 / builtins 화이트리스트 / dunder 차단) 전면 해제.
근거: 사내 LLM + 기업 보안 인가 운영. 격리 비용 > 보안 이득. Claude Code 모델.
남는 가드:
  - timeout: 전용 daemon thread + asyncio.wait_for (event loop 를 블록하지 않음).
    signal.SIGALRM 은 제거 — 메인 스레드에서만 발화하므로 스레드 실행과 양립 불가.
  - stdout cap: `SA_PYTHON_EXEC_MAX_OUTPUT` (기본 30_000자)
  - stdout/stderr capture
  - state 는 자동 노출 (편의)
"""
from __future__ import annotations

import ast
import asyncio
import io
import os
import threading
import traceback
from contextlib import redirect_stderr, redirect_stdout
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.autonomy import (
    AUTONOMOUS_TOOLS_ENV, is_autonomous_tool_allowed,
)
from secu_agent.agent.tools.base import (
    PermissionDecision, Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)


def _build_globals(state_mod: Any) -> dict[str, Any]:
    # __builtins__ 그대로 — open/import/eval/exec 전부 자유.
    # state 는 chat 도구라 자동 노출 (자주 씀).
    return {"state": state_mod}


# ── stdout cap ──────────────────────────────────────────────
# sibling 도구(host_tools)와 동일하게 stdout 을 상한 처리 — 무한 print/대량 출력이
# context/메모리를 blowup 시키는 것을 막는다. host_tools._MAX_OUTPUT_CHARS(30_000)와
# 기본값을 맞추되, 운영자가 SA_PYTHON_EXEC_MAX_OUTPUT 로 튜닝 가능.
MAX_OUTPUT_ENV = "SA_PYTHON_EXEC_MAX_OUTPUT"
_DEFAULT_MAX_OUTPUT = 30_000


def _max_output_chars() -> int:
    raw = os.environ.get(MAX_OUTPUT_ENV)
    if raw:
        try:
            v = int(raw)
        except ValueError:
            return _DEFAULT_MAX_OUTPUT
        if v > 0:
            return v
    return _DEFAULT_MAX_OUTPUT


def _cap_stdout(text: str) -> str:
    limit = _max_output_chars()
    if len(text) <= limit:
        return text
    return (
        text[:limit]
        + f"\n\n... (truncated at {limit:,} chars. python_exec stdout capped — "
        "print 를 줄이거나 결과를 파일/DB 로 offload)"
    )


def _exec_capture(code: str, g: dict[str, Any]) -> tuple[str, str | None]:
    """exec 을 stdout/stderr 캡처와 함께 동기 실행. timeout 은 호출측(await 경계)에서.

    이 함수 자체는 timeout 을 강제하지 않는다 — 전용 daemon thread 안에서 돌고,
    execute() 가 asyncio.wait_for 로 상한을 건다. (signal.SIGALRM 은 메인 스레드
    전용이라 스레드 실행에서 못 쓴다.)
    """
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    try:
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            exec(code, g, g)  # noqa: S102 — intentional, see module docstring
        return stdout_buf.getvalue(), None
    except Exception:
        tb = traceback.format_exc(limit=4)
        return stdout_buf.getvalue(), tb


class PythonExecInput(BaseModel):
    code: str = Field(..., max_length=20_000)
    timeout_seconds: int = Field(5, ge=1, le=30)


class PythonExecTool(Tool[PythonExecInput]):
    name: ClassVar[str] = "python_exec"
    description: ClassVar[str] = (
        "Python 직접 실행 — count/chunk/filter/bulk-add 등 LLM tool_call args 로 "
        "enumerate 하기 비효율적인 처리.\n"
        "\n"
        "노출: 전체 Python (import 자유), `state` (DB helper) 자동 바인딩, `print` → stdout.\n"
        "timeout 기본 5s, max 30s.\n"
        "\n"
        "예시:\n"
        "  ```\n"
        "  import re\n"
        "  raw = '''large pasted text ...'''\n"
        "  items = [l.strip() for l in raw.splitlines() if l.strip()]\n"
        "  print(f'parsed {len(items)} items')\n"
        "  # 도메인별 DB helper/API 는 해당 skill resource 확인 후 호출\n"
        "  print('done')\n"
        "  ```\n"
        "사용자 input 그대로 raw 문자열에 넣고 처리하면 대량 항목을 직접 enumerate 안 해도 됨."
    )
    input_model: ClassVar[type[BaseModel]] = PythonExecInput
    is_read_only: ClassVar[bool] = False
    deferred: ClassVar[bool] = True  # v3.17: 큰 schema. tool_search 로 unlock.
    domain: ClassVar[str] = "core"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "count", "filter", "큰 paste 처리", "bulk",
    )
    prompt_section: ClassVar[str] = (
        "### python_exec(code, timeout_seconds=5)\n"
        "**Python 자유 실행** — enumeration / count / chunk / filter / bulk-add 같이 "
        "tool_call args 로 직접 쓰면 비효율적인 일 처리.\n\n"
        "노출:\n"
        "- 전체 stdlib + 3rd-party 자유 import (`import re`, `import json`, ...)\n"
        "- `state` 자동 바인딩 — todo/schedule/finding/session 상태 조회와 "
        "도메인별 helper 호출 가능. 도메인별 함수명/테이블은 해당 skill resource 를 "
        "확인한 뒤 사용.\n"
        "- DB ad-hoc 쿼리: `state.connect()` context. 공통 테이블은 "
        "`chat_session`, `chat_message`, `chat_todo`, `chat_goal`, "
        "`finding_lifecycle`, `schedule`. 도메인 테이블은 domain skill/schema 참고.\n"
        "- `print(...)` → 결과로 받음.\n\n"
        "**언제 쓰나**:\n"
        "1. 사용자가 큰 raw 텍스트 blob 을 줬을 때 — python 으로 "
        "split + 검증 + state 호출 loop. **enumeration 직접 X**.\n"
        "2. count / aggregate (e.g. \"severity 별 finding 몇 개?\")\n"
        "3. chunking / batch boundary 계산.\n"
        "4. 사용자한테 보고 전 데이터 가공.\n\n"
        "timeout 5~30s. 무한 루프는 timeout 으로 끊김 (event loop 는 블록되지 않음)."
    )

    async def check_permission(
        self, validated_input: PythonExecInput, context: ToolContext,
    ) -> PermissionDecision:
        # python_exec 는 import/open/os 자유의 임의 코드 실행 — 코어의 최강 도구다.
        del validated_input
        if context.metadata.get("schedule_origin"):
            # 무인(스케줄/자율) 실행에서는 기본 차단(fail-closed). 사람이 코드를
            # 못 보는 상태에서 임의 코드가 도는 것을 막는다. 신뢰 자동화는
            # 운영자가 SA_AUTONOMOUS_TOOLS=python_exec 로 명시 opt-in.
            if is_autonomous_tool_allowed(self.name):
                return PermissionDecision(behavior="allow")
            return PermissionDecision(
                behavior="deny",
                reason=(
                    "scheduled execution cannot run python_exec (임의 코드 실행) — "
                    f"set {AUTONOMOUS_TOOLS_ENV}=python_exec to allow for trusted automation"
                ),
            )
        return PermissionDecision(behavior="allow")

    async def execute(self, vi: PythonExecInput,
                      ctx: ToolContext) -> ToolResult:
        code = vi.code

        # parse — 실행 전 syntax 오류 빨리 잡아 명확한 에러로.
        try:
            ast.parse(code, mode="exec")
        except SyntaxError as e:
            return ToolError(kind="validation",
                             message=f"syntax error: {e}")

        from secu_agent import state as _state
        from secu_agent.agent.secret_redact import redact_secrets
        g = _build_globals(_state)

        # 1..30s 상한 (input model 이 이미 강제하지만 방어적으로 clamp).
        timeout_s = max(1, min(30, int(vi.timeout_seconds)))

        # blocking exec 을 전용 daemon thread 에서 돌리고, timeout 은 await 경계에서
        # asyncio 로 강제한다. 공유 default executor 를 쓰지 않는 이유: 멈춘 job 이
        # 공유 풀을 오염(poison)시키면 안 되기 때문 — 매 호출 독립 스레드.
        # 잔여 리스크(허용): 진짜 무한 루프면 이 daemon thread 는 프로세스 종료까지
        # 백그라운드에 남는다. 그래도 event loop 를 얼리는 것보다 엄격히 낫고,
        # daemon 이라 프로세스와 함께 죽으므로 bounded 하다.
        loop = asyncio.get_running_loop()
        done: asyncio.Future = loop.create_future()

        def _runner() -> None:
            res = _exec_capture(code, g)

            def _set() -> None:
                if not done.done():
                    done.set_result(res)

            loop.call_soon_threadsafe(_set)

        threading.Thread(
            target=_runner, daemon=True, name="python_exec",
        ).start()

        try:
            stdout, err = await asyncio.wait_for(done, timeout=timeout_s)
        except asyncio.TimeoutError:
            # event loop 는 즉시 해방됨. orphan daemon thread 는 프로세스와 함께 소멸.
            return ToolError(
                kind="timeout",
                message=f"timeout ({timeout_s}s) — 무한 루프 / 너무 오래",
            )

        out_parts: list[str] = []
        if stdout:
            # redact 를 cap 前에 — 30k 경계에 secret 이 걸치면 잘려서 마스킹 패턴을
            # 빠져나갈 수 있다. 먼저 마스킹한 뒤 절단한다 (PII/secret 마스킹 KEEP).
            out_parts.append("[stdout]\n" + _cap_stdout(redact_secrets(stdout.rstrip())))
        if err:
            out_parts.append("[error]\n" + err.rstrip())
        if not out_parts:
            out_parts.append("(no output)")
        return ToolSuccess(content=redact_secrets("\n\n".join(out_parts)))
