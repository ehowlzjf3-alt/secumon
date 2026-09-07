"""paste_stub — long user message → paste_cache 저장 + 짧은 stub 으로 replace.

WS handler 가 사용자 메시지 받을 때 사용. LLM 한테는 stub 만 보내서 input 작게 유지.
agent 가 필요할 때 python_exec 으로 state.paste_get(paste_id) 호출해서 본문 fetch.

stub 형식:
    [User pasted N chars / M lines. paste_id="ab12cd".
    format hint: cidr_list (95%)

    Preview (first 200 chars):
      ...

    Tail (last 200 chars):
      ...

    Access full content via python_exec:
      text = state.paste_get("ab12cd")]
"""
from __future__ import annotations

from secu_agent import state
from secu_agent.agent.paste_format import detect_format


_PREVIEW_CHARS = 220
_TAIL_CHARS = 200
_DEFAULT_THRESHOLD = 4000


def _trim(text: str, n: int) -> str:
    s = text[:n]
    # 마지막 줄 잘렸으면 그 부분 버려서 가독성 ↑
    if "\n" in s and not text[n - 1:].startswith("\n"):
        last_nl = s.rfind("\n")
        if last_nl > n // 2:
            s = s[:last_nl]
    return s.rstrip()


def _tail(text: str, n: int) -> str:
    if len(text) <= n:
        return ""
    s = text[-n:]
    if "\n" in s:
        first_nl = s.find("\n")
        if first_nl != -1 and first_nl < n // 2:
            s = s[first_nl + 1:]
    return s.lstrip()


def build_stub(text: str, paste_id: str) -> str:
    line_count = text.count("\n") + (0 if text.endswith("\n") else 1)
    char_count = len(text)
    hint = detect_format(text)
    head = _trim(text, _PREVIEW_CHARS)
    tail = _tail(text, _TAIL_CHARS)

    parts = [
        f'[User pasted {char_count} chars / {line_count} lines. '
        f'paste_id="{paste_id}".',
    ]
    if hint:
        parts.append(f"format hint: {hint}")
    parts.append("")
    parts.append(f"Preview (first {_PREVIEW_CHARS} chars):")
    for line in head.splitlines():
        parts.append(f"  {line}")
    if tail:
        parts.append("")
        parts.append(f"Tail (last {_TAIL_CHARS} chars):")
        for line in tail.splitlines():
            parts.append(f"  {line}")
    parts.append("")
    parts.append("Access full content via python_exec:")
    parts.append(f'  text = state.paste_get("{paste_id}")')
    parts.append("]")
    return "\n".join(parts)


def maybe_stub(
    text: str, *, threshold: int = _DEFAULT_THRESHOLD,
) -> tuple[str, str | None]:
    """text 가 threshold 보다 길면 paste_cache 에 저장 + stub 반환.
    짧으면 원본 그대로, paste_id=None.
    """
    if not text or len(text) <= threshold:
        return text, None
    pid = state.paste_add(text)
    return build_stub(text, pid), pid
