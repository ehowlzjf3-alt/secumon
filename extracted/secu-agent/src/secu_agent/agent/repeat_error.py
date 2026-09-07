"""v3.42 F2: 같은 도구 + 같은 에러 fingerprint 2회 연속 → 강제 보고 + halt.

라이브 케이스 (session 7, 2026-05-18 10:11~10:14):
agent 가 `smb_python` 으로 `'Hit' object has no attribute 'preview'` 두 번 연속 받음.
중간에 assistant text 응답 0개. 사용자는 화면이 그냥 멈춘 것처럼 인식.

이 모듈은 tool result 에서 에러 signature 를 뽑고, 직전 turn 의 signature 와
같으면 counter 를 올린다. counter ≥ HALT_THRESHOLD (=2) 면 engine 이 강제로
assistant text 응답을 보내고 LoopCompleted(reason='repeat_error_halt') 로 종료한다.

ToolError 뿐 아니라 ToolSuccess 안에 `[error]` 라인이 있는 케이스 (sandbox-style)
도 잡는다. smb_python 등의 `[error]\nTraceback...\n<ExcType>: <msg>` 패턴이 해당.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from secu_agent.agent.tools.base import ToolError, ToolSuccess

HALT_THRESHOLD = 2

# v3.48: 같은 (tool_name, input_fingerprint) 가 같은 turn 안 반복 호출되면 halt.
# 무한 stash loop (read_evidence → grep → read → grep ...) 같은 패턴 잡음.
REPEAT_CALL_HALT_THRESHOLD = 5

# `<ExcType>: <msg>` 마지막 줄 패턴 (traceback 마지막 줄).
# v3.51-H2: module prefix (`sqlite3.IntegrityError`, `_internal.SomeError`) 도 흡수 —
# session 10 case 에서 sqlite3 namespace 때문에 fingerprint 못 잡고 silent 5회
# retry 됐던 버그 fix. 첫 글자 소문자도 prefix 로 허용.
_EXC_LINE = re.compile(
    r"^(?:[a-zA-Z_][\w.]*\.)?(?P<exc>[A-Z][A-Za-z_]+(?:Error|Exception|Warning)): (?P<msg>.+)$",
    re.MULTILINE,
)


def extract_error_signature(tool_name: str, result: Any) -> str | None:
    """ToolError 또는 ToolSuccess 안의 traceback 마지막 라인을 fingerprint 화.

    Returns:
        str signature 또는 None (정상 통과 / 에러 패턴 못 찾음).
    """
    if isinstance(result, ToolError):
        msg = (result.message or "")[:120].strip()
        return f"{tool_name}|err:{result.kind}|{msg}"

    if isinstance(result, ToolSuccess):
        content = (result.content or "")
        if "[error]" not in content and "Traceback" not in content:
            return None
        matches = list(_EXC_LINE.finditer(content))
        if not matches:
            # error 마커는 있는데 standard exception 라인 없음 — content 마지막 80자
            tail = content.strip().splitlines()[-1][:80] if content.strip() else "?"
            return f"{tool_name}|exc:?|{tail}"
        last = matches[-1]
        return f"{tool_name}|exc:{last.group('exc')}|{last.group('msg')[:80]}"

    return None


@dataclass
class RepeatErrorState:
    """metadata 에 들어가는 직전 signature + count."""
    last_signature: str | None = None
    count: int = 0

    @classmethod
    def from_metadata(cls, metadata: dict[str, Any]) -> "RepeatErrorState":
        return cls(
            last_signature=metadata.get("_repeat_error_sig"),
            count=int(metadata.get("_repeat_error_count", 0)),
        )

    def write_to(self, metadata: dict[str, Any]) -> None:
        metadata["_repeat_error_sig"] = self.last_signature
        metadata["_repeat_error_count"] = self.count

    def update(self, signature: str | None) -> bool:
        """signature 받아 counter 갱신. True 면 halt 임계 도달."""
        if signature is None:
            # 정상 통과 = reset
            self.last_signature = None
            self.count = 0
            return False
        if signature == self.last_signature:
            self.count += 1
        else:
            self.last_signature = signature
            self.count = 1
        return self.count >= HALT_THRESHOLD


# v3.53: input-fingerprint 누적 halt 는 **evidence-read 도구에만** 적용.
# 그 외 모든 도구(todo / browser_* / web_* / scan_text / submit_finding / goal …)는
# 설계상 같은 인자로 여러 번 부르는 게 정상이라 누적 카운트로 막으면 false-positive
# (브라우저 snapshot 반복, todo 갱신 반복, pending 재조회 등). 다 면제한다.
# 남기는 이유: read_evidence_file/grep 의 stash recursion 무한루프(v3.48)만 차단.
# 실패 반복(같은 에러 2회)은 별도 error-signature halt 가 계속 잡으니 안전.
_REPEAT_HALT_INCLUDE = frozenset({
    "read_evidence_file", "grep_evidence", "read_file",
})


def call_fingerprint(tool_name: str, tool_input: dict) -> str | None:
    """v3.48: 같은 tool 호출 인식용 fingerprint. include 목록 외엔 None (카운트 안 함).

    `read_evidence_file` / `grep_evidence` 류는 path + pattern 만 비교 — offset/limit
    변경된 시도는 정상 (덜 위험).
    """
    if tool_name not in _REPEAT_HALT_INCLUDE:
        return None
    import hashlib, json as _json
    key_input = {k: v for k, v in tool_input.items() if k in ("path", "pattern")}
    h = hashlib.sha256(
        _json.dumps(key_input, sort_keys=True, default=str).encode()
    ).hexdigest()[:12]
    return f"{tool_name}|{h}"


def build_repeat_call_halt_message(tool_name: str, count: int) -> str:
    return (
        f"⚠ `{tool_name}` 도구를 같은 인자로 {count}회 호출했어. "
        f"무한 loop / stash recursion / 같은 정보 반복 fetch 가능성. 멈춤.\n\n"
        f"진단해야 할 것:\n"
        f"- 도구 결과가 의미있게 변하지 않는데 왜 또 호출?\n"
        f"- offset / limit / pattern 조정해서 다른 부분 보기\n"
        f"- 또는 이미 충분한 정보 — 사용자에게 결과 보고하기"
    )


def build_halt_message(signature: str) -> str:
    """halt 시 assistant 가 사용자에게 보낼 진단 메시지."""
    parts = signature.split("|", 2)
    if len(parts) == 3:
        tool, _kind, msg = parts
        return (
            f"⚠ `{tool}` 도구가 같은 에러로 연속 {HALT_THRESHOLD}회 실패해서 멈췄어. "
            f"에러: {msg}\n\n"
            f"진단해야 할 것:\n"
            f"- 코드 / 입력 / API 시그니처 어디가 문제인지\n"
            f"- 같은 도구 다시 호출 전에 사용자한테 확인받기"
        )
    return f"⚠ 같은 에러 {HALT_THRESHOLD}회 연속 — 진단 필요: {signature}"
