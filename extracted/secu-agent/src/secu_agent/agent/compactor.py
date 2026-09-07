"""context_compactor — master 본문 폭증 대비.

전략 (lossy but safe):
- 휘발 가능 도구 (read_file_quick / list_share_files / read_file_metadata /
  session_search / memory_recall) 의 오래된 ToolResultBlock 만 short stub 으로 치환.
- 영속화 도구 (set_file_finding / memory_save / submit_share_review /
  report_inspection / delegate_file_review) 의 결과는 유지 — 결정 정보.
- 마지막 keep_last_n 개의 도구 호출 결과는 유지 — agent 의 직전 reasoning 에 필요.
- 첫 user prompt + 모든 AssistantMessage 텍스트/tool_use 는 건드리지 않음.

영속화된 정보 (file_finding, share_review, memory_rule) 는 DB 에서 session_search /
memory_recall 로 다시 조회 가능. 본문은 다시 read_file_quick 호출 가능.
"""
from __future__ import annotations

from secu_agent.agent.llm.messages import (
    AssistantMessage, Message, ToolResultBlock, ToolUseBlock, UserMessage,
)


# 휘발 가능 — stub 화 OK (영속화는 DB / evidence_dir 에서 재조회)
COMPACTABLE_TOOLS: set[str] = {
    "read_file_quick",
    "list_share_files",
    "read_file_metadata",
    "session_search",
    "memory_recall",
    "read_hit_context",
    "read_listing_page",
    # v3.47: web task 결과도 evidence_dir 의 JSON 으로 영속화. 누적 시 stub 화 안전.
    "web_task_scan",
    "web_resource_probe",
    "web_fetch",
    "web_crawl",
    "host_read",
    "host_search",
    "host_code_outline",
}


def _total_chars(messages: list[Message]) -> int:
    n = 0
    for m in messages:
        for b in m.content:
            if isinstance(b, ToolResultBlock):
                n += len(b.content)
            elif hasattr(b, "text"):
                n += len(b.text)
    return n


def _tool_use_name_by_id(messages: list[Message]) -> dict[str, str]:
    """tool_use_id → tool name 매핑. AssistantMessage 의 ToolUseBlock 들에서."""
    out: dict[str, str] = {}
    for m in messages:
        if isinstance(m, AssistantMessage):
            for b in m.content:
                if isinstance(b, ToolUseBlock):
                    out[b.id] = b.name
    return out


def _stub(name: str, original_len: int) -> str:
    return (
        f"[compacted: {name} result ({original_len} chars) — "
        f"previous raw output was removed from active context; use relevant state/search/read "
        f"tools or re-call this tool if exact details are needed]"
    )


def compact_messages(
    messages: list[Message], *,
    char_threshold: int = 30_000,
    keep_last_n: int = 2,
) -> tuple[list[Message], int]:
    """compactable 도구 결과를 stub 화. 반환: (new_messages, n_compacted).

    char_threshold: 누적 char 가 이 값 이하면 no-op.
    keep_last_n: 가장 최근의 compactable tool_result N개는 유지.
    """
    if _total_chars(messages) <= char_threshold:
        return messages, 0

    name_by_id = _tool_use_name_by_id(messages)

    # compactable 후보 인덱스 수집 (UserMessage 안의 ToolResultBlock 단위)
    candidates: list[tuple[int, int]] = []  # (msg_idx, block_idx)
    for mi, m in enumerate(messages):
        if not isinstance(m, UserMessage):
            continue
        for bi, b in enumerate(m.content):
            if not isinstance(b, ToolResultBlock):
                continue
            name = name_by_id.get(b.tool_use_id)
            if name and name in COMPACTABLE_TOOLS:
                candidates.append((mi, bi))

    if len(candidates) <= keep_last_n:
        return messages, 0

    # 가장 오래된 것부터 stub 화 (마지막 keep_last_n 은 보존)
    to_compact = candidates[: len(candidates) - keep_last_n]

    new_messages: list[Message] = list(messages)
    compacted = 0
    for mi, bi in to_compact:
        m = new_messages[mi]
        assert isinstance(m, UserMessage)
        old_block = m.content[bi]
        assert isinstance(old_block, ToolResultBlock)
        name = name_by_id.get(old_block.tool_use_id, "?")
        new_block = ToolResultBlock(
            tool_use_id=old_block.tool_use_id,
            content=_stub(name, len(old_block.content)),
            is_error=old_block.is_error,
        )
        new_content = list(m.content)
        new_content[bi] = new_block
        new_messages[mi] = UserMessage(
            content=new_content, id=m.id, created_at=m.created_at,
        )
        compacted += 1

    return new_messages, compacted


# ============================================================
# v3.47: sliding window — context overflow 응급 처치.
#
# compact_messages 가 휘발 도구 결과만 stub 화하는데, 영속 도구 (smb_python /
# submit_finding 등) 결과가 누적되거나, 한 turn 안 40+ 도구 호출이면 그래도 폭주.
# sliding window 는 head (첫 user 의도 + 초기 turn) + tail (최근 K turn) 만 남기고
# 중간을 1줄 system note 로 압축. lossy 지만 max_input_tokens 초과 막음.
# ============================================================


SLIDING_WINDOW_DEFAULT_HEAD = 4   # 처음 N message — user 의도 + 첫 답
SLIDING_WINDOW_DEFAULT_TAIL = 12  # 최근 N message — 진행 컨텍스트
SLIDING_WINDOW_DEFAULT_THRESHOLD = 200_000  # 모델 max input 의 ~50% 가정


def sliding_window(
    messages: list[Message],
    *,
    max_chars: int = SLIDING_WINDOW_DEFAULT_THRESHOLD,
    head_n: int = SLIDING_WINDOW_DEFAULT_HEAD,
    tail_n: int = SLIDING_WINDOW_DEFAULT_TAIL,
) -> tuple[list[Message], int]:
    """누적 char 가 max_chars 초과 시 head + tail 만 남기고 중간 drop.

    중간에 짧은 placeholder TextBlock 으로 사실 알림 (agent 가 잘렸음을 인지).
    반환: (new_messages, n_dropped).

    head_n + tail_n + 1 (note) 보다 적은 메시지면 no-op.
    """
    from secu_agent.agent.llm.messages import TextBlock  # local import — circular 회피
    if _total_chars(messages) <= max_chars:
        return messages, 0
    if len(messages) <= head_n + tail_n + 1:
        return messages, 0

    head = messages[:head_n]
    tail = messages[-tail_n:]
    dropped_count = len(messages) - len(head) - len(tail)
    dropped_chars = sum(
        len(b.content) if isinstance(b, ToolResultBlock)
        else (len(b.text) if hasattr(b, "text") else 0)
        for m in messages[head_n:-tail_n]
        for b in m.content
    )
    note_text = (
        f"[context sliding window: {dropped_count}개 메시지 ({dropped_chars}자) "
        f"드롭됨 — head {head_n} + tail {tail_n} 만 유지. 잘린 내용은 evidence_dir/DB 에서 재조회 가능.]"
    )
    note_msg = UserMessage(content=[TextBlock(text=note_text)])
    new_messages = list(head) + [note_msg] + list(tail)
    # P1 Slice1: head/tail 경계가 tool_use/tool_result 페어를 가르면 orphan → 게이트웨이
    # 400. summarizer 와 동일한 페어 정리를 적용한다. (local import — circular 회피)
    from secu_agent.agent.context_summarizer import sanitize_tool_pairs
    new_messages = sanitize_tool_pairs(new_messages)
    return new_messages, dropped_count
