"""LoopEvent 스트림 → Knox 채팅 메시지 변환.

Knox 는 메신저라 토큰/reasoning 스트리밍을 그대로 흘리면 과다 전송이 된다. 그래서:
  - assistant 텍스트(TextChunk)는 누적했다가 turn 끝에 **한 메시지**로 전송(finalize)
  - submit_finding 은 즉시 🚨 finding 카드
  - 오류(LoopError)는 즉시 ⚠ 표시
  - reasoning/token 등 나머지는 억제 (verbose 면 주요 tool 시작만 🔧 표시)

웹의 _event_to_payload(WS 용 풀 페이로드)와 대비되는, 메신저 친화 축약 렌더러.
"""
from __future__ import annotations

from typing import Any

from secu_agent.agent.events import (
    LoopError,
    ReasoningChunk,
    TextChunk,
    ToolCallStarted,
)


def _finding_card(finding: dict[str, Any]) -> str:
    severity = str(finding.get("severity") or "?")
    summary = str(finding.get("summary") or "").strip()
    target = str(finding.get("target") or "").strip()
    hits = finding.get("hits")
    n_hits = len(hits) if isinstance(hits, list) else 0
    head = f"🚨 Finding [{severity}]"
    if target:
        head += f" {target}"
    lines = [head]
    if summary:
        lines.append(summary)
    lines.append(f"hits: {n_hits}건")
    return "\n".join(lines)


class KnoxTurnRenderer:
    """turn 1회 동안의 이벤트를 받아 보낼 메시지를 만든다. turn 마다 새 인스턴스."""

    def __init__(self, *, verbose: bool = False) -> None:
        self._verbose = verbose
        self._text_parts: list[str] = []

    def on_event(self, ev: Any) -> list[str]:
        """이 이벤트로 **즉시** 보낼 메시지들(0개 이상). assistant 텍스트는 누적만."""
        if isinstance(ev, TextChunk):
            self._text_parts.append(ev.text)
            return []
        if isinstance(ev, ReasoningChunk):
            return []  # 사고 trace 는 메신저로 안 보냄
        if isinstance(ev, ToolCallStarted):
            if ev.name == "submit_finding":
                finding = (ev.input or {}).get("finding")
                if isinstance(finding, dict):
                    return [_finding_card(finding)]
                return []
            if self._verbose:
                return [f"🔧 {ev.name} 실행…"]
            return []
        if isinstance(ev, LoopError):
            return [f"⚠ 오류: {ev.message}"]
        return []

    def finalize(self) -> list[str]:
        """turn 종료 시 누적된 assistant 텍스트를 한 메시지로(있으면)."""
        text = "".join(self._text_parts).strip()
        self._text_parts.clear()
        return [text] if text else []
