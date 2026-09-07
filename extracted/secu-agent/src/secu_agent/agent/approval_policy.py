"""Approval policies for interactive tool execution.

The policy layer is independent from FastAPI. The web layer decides how to
surface the final decision, while this module decides whether a requested tool
approval should be allowed, denied, or delegated to an LLM judge.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, cast

from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.messages import TextBlock, UserMessage
from secu_agent.agent.llm.types import LLMRequest, StreamMessageStop, StreamTextDelta
from secu_agent.agent.tools.approval import ApprovalDecision, ApprovalRequest


ApprovalMode = Literal["auto", "manual", "deny", "smart"]
SmartApprovalSource = Literal["deterministic", "llm", "fallback"]


@dataclass(frozen=True, slots=True)
class SmartApprovalOutcome:
    decision: ApprovalDecision
    source: SmartApprovalSource


def normalize_approval_mode(raw: str | None) -> ApprovalMode:
    """Normalize user/env approval mode.

    Missing config defaults to auto because the web chat is an operator-owned
    harness. Invalid non-empty values fall back to manual so typos do not
    silently create a more permissive mode.
    """
    if raw is None or not raw.strip():
        return "auto"
    value = raw.strip().lower().replace("-", "_")
    aliases = {
        "ask": "manual",
        "interactive": "manual",
        "off": "auto",
        "yolo": "auto",
        "allow": "auto",
        "block": "deny",
        "never": "deny",
    }
    value = aliases.get(value, value)
    if value in {"auto", "manual", "deny", "smart"}:
        return cast(ApprovalMode, value)
    return "manual"


_HIGH_RISK_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\brm\s+-\S*[rf]\S*\s+/(?:[\"'\s]|$)", re.I),
    re.compile(r"\brm\s+-\S*[rf]\S*\s+~(?:[\"'\s/]|$)", re.I),
    re.compile(r"\bsudo\b", re.I),
    re.compile(r"\b(?:mkfs|fdisk|parted|shutdown|reboot|halt)\b", re.I),
    re.compile(r"\bdd\s+if=.*\bof=/dev/", re.I),
    re.compile(r"\bchmod\s+-R\s+777\s+/", re.I),
    re.compile(r"\bchown\s+-R\s+[^&|;]+/(?:\s|$)", re.I),
    re.compile(r"\b(?:curl|wget)\b[^\n|;&]*\|\s*(?:sh|bash)\b", re.I),
    re.compile(r":\s*\(\)\s*\{\s*:\s*\|\s*:", re.I),
    re.compile(r"\bdrop\s+table\b", re.I),
    re.compile(r"\bdelete\s+from\b", re.I),
    re.compile(r"\btruncate\s+table\b", re.I),
    re.compile(r"\bkubectl\s+delete\s+(?:ns|namespace)\b", re.I),
    re.compile(r"\baws\b[^\n;&|]*\bdelete\b", re.I),
)

_CRITICAL_PATH_PREFIXES = (
    "/etc/",
    "/private/etc/",
    "/boot/",
    "/sys/",
    "/proc/",
    "/dev/",
    "/bin/",
    "/sbin/",
    "/usr/bin/",
    "/usr/sbin/",
    "/usr/lib/",
    "/usr/lib64/",
)

_SENSITIVE_HOME_PARTS = (
    "/.ssh/",
    "/.aws/",
    "/.gnupg/",
    "/.docker/",
    "/.kube/",
    "/.config/gh/",
    "/.config/gcloud/",
    "/.azure/",
)

# 인자와 무관하게 read-only 인 실행파일 — 쓰기/실행 능력 없음.
# awk/sed 는 **의도적으로 제외**: awk `system()`/`print >file`, sed `-i`/`e`/`w`
# 로 실행·쓰기가 가능해 인자 없이는 read-only 임을 증명할 수 없다 → LLM judge 로.
_READONLY_EXES: frozenset[str] = frozenset({
    "cat", "file", "grep", "head", "ls", "pwd", "rg",
    "strings", "tail", "uniq", "wc",
})

# 인자에 따라 쓰기/실행 가능 — 아래 가드를 통과할 때만 read-only 로 본다.
_FIND_UNSAFE_ARGS: frozenset[str] = frozenset({
    "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls",
})  # -fprint* 는 startswith 로 별도 처리

# 셸 명령 구성/치환/리다이렉트/제어 연산자 — 하나라도 있으면 결정론 판정 포기.
# 첫 토큰만 보던 기존 판정이 `find -exec rm`/`cat a; rm`/`sed -i` 를 read-only 로
# 오판해 smart 모드가 파괴적 명령을 judge 없이 자동승인하던 것을 막는다(audit #4).
_SHELL_CONTROL_RE = re.compile(r";|\|\||&&|&|\||<|>|`|\$\(|\n")
# sort -o/--output 은 파일 쓰기 (bundled 단축 클러스터의 'o' 포함).
_SORT_WRITE_RE = re.compile(r"^-(?:-output|[a-zA-Z]*o)")

# 운영자 opt-in: 신뢰하는 read-only 실행파일을 결정론 auto-allow 에 추가
# (자동화가 judge 없이 쓰는 도메인 read-only 도구용). control-char 가드는 계속 적용.
_SMART_READONLY_EXTRA_ENV = "SA_SMART_READONLY_EXES"


def deterministic_smart_approval(
    request: ApprovalRequest,
) -> SmartApprovalOutcome | None:
    """Return a deterministic smart decision, or None when LLM judgment is needed."""
    payload = _request_payload_text(request)
    for pattern in _HIGH_RISK_PATTERNS:
        if pattern.search(payload):
            return SmartApprovalOutcome(
                ApprovalDecision(
                    behavior="deny",
                    reason=f"smart deterministic deny: high-risk pattern {pattern.pattern}",
                ),
                source="deterministic",
            )

    path = _primary_path(request.tool_input)
    if path and _is_critical_path(path):
        return SmartApprovalOutcome(
            ApprovalDecision(
                behavior="deny",
                reason=f"smart deterministic deny: critical path {path}",
            ),
            source="deterministic",
        )

    if request.tool_name == "enter_plan_mode":
        return SmartApprovalOutcome(
            ApprovalDecision(
                behavior="allow",
                reason="smart deterministic allow: plan approval gate",
            ),
            source="deterministic",
        )

    if request.tool_name == "browser_session":
        action = str(request.tool_input.get("action") or "")
        if action in {"start", "status", "stop"}:
            return SmartApprovalOutcome(
                ApprovalDecision(
                    behavior="allow",
                    reason=f"smart deterministic allow: browser_session {action}",
                ),
                source="deterministic",
            )

    if request.tool_name == "bash_evidence":
        command = str(request.tool_input.get("command") or "")
        if _looks_like_read_only_shell(command):
            return SmartApprovalOutcome(
                ApprovalDecision(
                    behavior="allow",
                    reason="smart deterministic allow: read-only evidence command",
                ),
                source="deterministic",
            )

    if request.tool_name == "terminal":
        command = str(request.tool_input.get("command") or "")
        if _looks_like_read_only_shell(command):
            return SmartApprovalOutcome(
                ApprovalDecision(
                    behavior="allow",
                    reason="smart deterministic allow: read-only terminal command",
                ),
                source="deterministic",
            )

    return None


class SmartApprovalPolicy:
    """LLM-backed smart approval with deterministic hard guards.

    The deterministic layer denies obviously dangerous requests before any LLM
    call. Ambiguous requests are sent to an LLM judge. If the judge is
    unavailable or returns malformed output, the policy denies the request.
    """

    def __init__(
        self,
        *,
        client_factory: Callable[[], LLMClient] | None = None,
        timeout_seconds: float = 20.0,
    ) -> None:
        self._client_factory = client_factory
        self._timeout_seconds = timeout_seconds

    async def resolve(self, request: ApprovalRequest) -> SmartApprovalOutcome:
        deterministic = deterministic_smart_approval(request)
        if deterministic is not None:
            return deterministic

        if self._client_factory is None:
            return SmartApprovalOutcome(
                ApprovalDecision(
                    behavior="deny",
                    reason="smart approval fallback deny: no LLM judge configured",
                ),
                source="fallback",
            )

        client: LLMClient | None = None
        try:
            client = self._client_factory()
            decision = await asyncio.wait_for(
                self._judge_with_llm(client, request),
                timeout=self._timeout_seconds,
            )
            return SmartApprovalOutcome(decision, source="llm")
        except Exception as e:
            return SmartApprovalOutcome(
                ApprovalDecision(
                    behavior="deny",
                    reason=f"smart approval fallback deny: {type(e).__name__}: {e}",
                ),
                source="fallback",
            )
        finally:
            if client is not None:
                close = getattr(client, "aclose", None)
                if callable(close):
                    try:
                        await close()
                    except Exception:
                        pass

    async def _judge_with_llm(
        self,
        client: LLMClient,
        request: ApprovalRequest,
    ) -> ApprovalDecision:
        prompt = json.dumps({
            "tool_name": request.tool_name,
            "tool_input": request.tool_input,
            "approval_reason": request.reason,
            "required_output": {
                "decision": "allow or deny",
                "reason": "short explanation",
            },
        }, ensure_ascii=False, sort_keys=True)
        llm_request = LLMRequest(
            system=_SMART_APPROVAL_SYSTEM_PROMPT,
            messages=[UserMessage(content=[TextBlock(text=prompt)])],
            max_tokens=256,
            temperature=0.0,
        )
        chunks: list[str] = []
        async for ev in client.stream(llm_request):
            if isinstance(ev, StreamTextDelta):
                chunks.append(ev.text)
            elif isinstance(ev, StreamMessageStop):
                break
        return parse_smart_approval_text("".join(chunks))


def parse_smart_approval_text(text: str) -> ApprovalDecision:
    data = _extract_json_object(text)
    decision = str(
        data.get("decision")
        or data.get("behavior")
        or data.get("approval")
        or "",
    ).strip().lower()
    reason = str(data.get("reason") or data.get("rationale") or "").strip()
    if decision not in {"allow", "deny"}:
        raise ValueError("smart approval judge did not return allow or deny")
    if not reason:
        reason = "smart approval LLM decision"
    return ApprovalDecision(behavior=cast(Literal["allow", "deny"], decision), reason=reason)


def _extract_json_object(text: str) -> dict[str, Any]:
    raw = text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.I)
        raw = re.sub(r"\s*```$", "", raw)
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end < start:
        raise ValueError("smart approval judge returned no JSON object")
    obj = json.loads(raw[start:end + 1])
    if not isinstance(obj, dict):
        raise ValueError("smart approval judge returned non-object JSON")
    return obj


def _request_payload_text(request: ApprovalRequest) -> str:
    try:
        body = json.dumps(request.tool_input, ensure_ascii=False, sort_keys=True, default=str)
    except TypeError:
        body = str(request.tool_input)
    return f"{request.tool_name}\n{request.reason}\n{body}"


def _primary_path(tool_input: dict[str, object]) -> str | None:
    for key in ("path", "file_path", "target_path", "source_path", "dest_path", "dest_dir", "cwd"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _is_critical_path(path: str) -> bool:
    normalized = path.strip()
    if normalized.startswith("~"):
        normalized = normalized.replace("~", "/home/operator", 1)
    for part in _SENSITIVE_HOME_PARTS:
        if part in normalized:
            return True
    if not normalized.endswith("/"):
        normalized_with_slash = normalized + "/"
    else:
        normalized_with_slash = normalized
    return any(
        normalized == prefix.rstrip("/") or normalized_with_slash.startswith(prefix)
        for prefix in _CRITICAL_PATH_PREFIXES
    )


def _smart_readonly_extra_exes() -> frozenset[str]:
    raw = os.environ.get(_SMART_READONLY_EXTRA_ENV, "")
    return frozenset(t.strip() for t in raw.split(",") if t.strip())


def _find_arg_is_unsafe(arg: str) -> bool:
    return arg in _FIND_UNSAFE_ARGS or arg.startswith("-fprint")


def _looks_like_read_only_shell(command: str) -> bool:
    """command 가 **인자까지 포함해** read-only 임이 결정론적으로 확실한가.

    unsound 하게 True 를 주면 smart 모드가 파괴적 명령을 LLM judge 없이 자동
    승인한다(audit #4: `find -exec rm`/`find -delete`/`sed -i`/`cat a; rm`).
    애매하면 False → LLM judge 로 위임(거부가 아니라 정상 판정 경로).
    """
    command = command.strip()
    if not command:
        return False
    # 셸 구성/치환/리다이렉트/제어 연산자가 있으면 결정론 판정 불가.
    if _SHELL_CONTROL_RE.search(command):
        return False
    try:
        parts = shlex.split(command)
    except ValueError:
        return False
    if not parts:
        return False
    exe = parts[0].rsplit("/", 1)[-1]
    args = parts[1:]
    if exe in _READONLY_EXES or exe in _smart_readonly_extra_exes():
        return True
    if exe == "find":
        return not any(_find_arg_is_unsafe(a) for a in args)
    if exe == "sort":
        return not any(_SORT_WRITE_RE.match(a) for a in args)
    return False


_SMART_APPROVAL_SYSTEM_PROMPT = """You are a strict tool approval judge.

Return JSON only: {"decision":"allow"|"deny","reason":"..."}.
Allow only when the requested tool use is bounded, reversible or read-only in
practice, and consistent with the user's current security-testing task. Deny
requests that can damage the host, modify credentials, delete data, bypass
scope, access unrelated private data, or execute untrusted code outside an
approved sandbox.
"""
