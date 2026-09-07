"""ChatSession — long-lived operator chat agent state.

- chat_session / chat_message DB 영속
- 페이지 새로고침: load() 가 DB 에서 messages 복원 → LLM context 유지
- turn(user_text) -> AsyncIterator[LoopEvent]: engine.run_query 호출, 매 이벤트 yield
  + DB 에 user / assistant / tool_event row 추가
- 단일 채널 multi-viewer 는 web layer 에서 broadcast — 여기는 그냥 state holder
"""
from __future__ import annotations

import asyncio
import os as _os
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from secu_agent import state
from secu_agent.agent.engine import QueryConfig, run_query
from secu_agent.agent.events import (
    LlmCallMeasured, LoopCompleted, LoopEvent,
    ToolCallCompleted, ToolCallStarted,
)
from secu_agent.agent.llm.base import LLMClient
from secu_agent.agent.llm.factory import make_role_client
from secu_agent.agent.llm.messages import (
    AssistantMessage, Message, TextBlock, ToolResultBlock, ToolUseBlock,
    UserMessage,
)
from secu_agent.agent.context_brief import build_context_brief
from secu_agent.agent.context_summarizer import (
    ContextSummarizer, has_prior_summary,
)
from secu_agent.agent.context_engine import ContextEngine, ContextEnginePolicy
from secu_agent.agent.execution_contract import format_active_todo_snapshot
from secu_agent.agent.finding_provenance import runtime_llm_metadata
from secu_agent.agent.read_context import clear_read_state
from secu_agent.agent.prompts import system_prompt
from secu_agent.agent.skills import (
    load_skills_all,
    skill_body_with_safety,
    unlock_default_tools_for_skills,
)
from secu_agent.agent.tools import build_registry_for_task
from secu_agent.agent.tools.base import ToolContext, ToolSuccess


_PLAN_ACK_WORDS = {
    "응", "ㅇㅇ", "어", "네", "넵", "예", "좋아", "좋습니다", "진행", "진행해",
    "진행해줘", "고고", "ㄱㄱ", "가자", "해", "해줘", "승인", "허용",
    "yes", "y", "ok", "okay", "go", "approved", "approve",
}
_PLAN_NEGATIVE_WORDS = {"아니", "아냐", "ㄴㄴ", "no", "n", "stop", "중단", "취소"}
_GOAL_RESUME_EXACT_WORDS = {
    "계속", "계속 진행", "계속 진행해", "계속 진행해줘", "계속해", "계속해줘",
    "재개", "재개해", "재개해줘", "이어 진행", "이어 진행해", "이어 진행해줘",
    "다시 진행", "다시 진행해", "진행 재개", "goal resume", "resume goal",
    "resume", "continue",
}
_CHARS_PER_TOKEN_ESTIMATE = 4
_DEFAULT_CONTEXT_WINDOW_TOKENS = 130_000
_DEFAULT_MAX_OUTPUT_TOKENS = 16_384


def _env_int(name: str, default: int) -> int:
    raw = (_os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _chat_budget_config() -> tuple[int, int, int]:
    """Return output token cap and context char thresholds.

    Defaulting to 130K tokens keeps external o4-mini tests under the same broad
    context constraint as the internal LLM gateway.
    """
    window_tokens = _env_int(
        "SA_CHAT_CONTEXT_WINDOW_TOKENS",
        _DEFAULT_CONTEXT_WINDOW_TOKENS,
    )
    output_tokens = _env_int(
        "SA_CHAT_MAX_OUTPUT_TOKENS",
        _DEFAULT_MAX_OUTPUT_TOKENS,
    )
    input_tokens = max(16_000, window_tokens - output_tokens)
    input_chars = input_tokens * _CHARS_PER_TOKEN_ESTIMATE
    # v3.71: 디폴트 180K (구 max(60K, 30%*input)=136K). 자율 batch 점검이
    # 루프 내 압축(RalphController)과 맞물려 input 토큰을 ~70K 이하로 묶기 위함.
    compact_chars = _env_int("SA_CHAT_COMPACT_THRESHOLD_CHARS", 180_000)
    sliding_chars = _env_int("SA_CHAT_SLIDING_WINDOW_CHARS", input_chars)
    return output_tokens, compact_chars, sliding_chars


def _is_plan_ack(text: str) -> bool:
    norm = " ".join(text.strip().lower().split())
    if not norm or norm in _PLAN_NEGATIVE_WORDS:
        return False
    if norm in _PLAN_ACK_WORDS:
        return True
    return any(word in norm for word in ("진행", "고고", "승인", "허용", "approve"))


def _is_goal_resume_request(text: str) -> bool:
    """User explicitly asks to resume a paused persistent goal."""
    norm = " ".join(text.strip().lower().split())
    if not norm or norm in _PLAN_NEGATIVE_WORDS:
        return False
    if norm in _GOAL_RESUME_EXACT_WORDS:
        return True
    resume_phrases = (
        "계속 진행", "계속해", "재개", "이어 진행", "다시 진행",
        "진행 재개", "resume", "continue",
    )
    return any(p in norm for p in resume_phrases)


def _plan_resume_note(plan: object) -> str:
    steps = []
    if isinstance(plan, dict):
        raw_steps = plan.get("steps")
        if isinstance(raw_steps, list):
            steps = [str(s) for s in raw_steps[:5]]
    step_text = "; ".join(steps) if steps else "저장된 plan steps"
    return (
        "[SYSTEM NOTE] 이전 enter_plan_mode 는 이미 승인되어 active 상태입니다. "
        "사용자의 방금 답변은 승인 ack 로 해석합니다. enter_plan_mode 를 다시 호출하지 말고 "
        f"승인된 plan 의 실제 도구를 지금 실행하세요. steps: {step_text}. "
        "작업이 끝나면 exit_plan_mode 를 호출하세요."
    )


def _candidate_skills_for_turn(text: str, selection=None) -> list[str]:
    """Return skills whose own frontmatter triggers match this user text."""

    import re as _re

    haystack = text.lower()
    out: list[str] = []
    # v3.81 T3: 코어 + SA_SKILLS_DIRS 외부 경로 전체에서 trigger 매칭
    # v3.82 U4: per-session selection 통과 — deselect 된 skill 무음 재주입 차단
    for skill in load_skills_all(selection=selection):
        triggers = skill.triggers or (skill.name, skill.domain)
        matched = False
        for raw in triggers:
            trigger = raw.strip()
            if not trigger:
                continue
            if trigger.startswith("re:"):
                try:
                    if _re.search(trigger[3:], text, flags=_re.IGNORECASE):
                        matched = True
                        break
                except _re.error:
                    continue
            elif trigger.lower() in haystack:
                matched = True
                break
        if matched:
            out.append(skill.name)
    return out


def _load_skill_body(name: str, selection=None) -> str | None:
    for skill in load_skills_all(selection=selection):
        if skill.name == name:
            # v3.81 T3: trigger 자동 주입엔 per-skill safety.md 동반 —
            # 매칭된 도메인의 안전 계약이 playbook 과 반드시 함께 들어간다.
            return skill_body_with_safety(skill)
    return None


def _auto_skill_context_for_turn(
    user_text: str,
    context: ToolContext,
    registry: Any,
) -> str | None:
    """Inject small domain playbooks deterministically when GPT-OSS skips skill view."""
    metadata = context.metadata
    selection = metadata.get("skills_selection") if metadata else None
    skill_names = _candidate_skills_for_turn(user_text, selection=selection)
    if not skill_names:
        return None
    loaded = metadata.setdefault("_auto_skill_context_loaded", set())
    if not isinstance(loaded, set):
        loaded = set()
        metadata["_auto_skill_context_loaded"] = loaded
    bodies: list[str] = []
    newly_loaded: list[str] = []
    for skill_name in skill_names:
        if skill_name in loaded:
            continue
        body = _load_skill_body(skill_name, selection=selection)
        if not body:
            continue
        loaded.add(skill_name)
        newly_loaded.append(skill_name)
        bodies.append(body)
    unlocked = unlock_default_tools_for_skills(
        newly_loaded,
        registry=registry,
        unlocked_tools=context.unlocked_tools,
    )
    if not bodies:
        return None
    loaded_note = (
        "\n\n[auto-loaded tools]\n" + ", ".join(unlocked)
        if unlocked else ""
    )
    return (
        "[SYSTEM NOTE] The user request matches a domain tasking workflow. "
        "The following skill context is mandatory for this turn. Follow it "
        "before reporting findings; do not treat raw heuristic output as "
        "final evidence.\n\n"
        + "\n\n---\n\n".join(bodies)
        + loaded_note
    )


def _restore_messages(rows: list[dict[str, Any]]) -> list[Message]:
    """DB row 들 → LLM Message list. tool_event 는 LLM context 에 안 넣음.

    role == 'system' 은 cancel note 같은 inline system 메시지 — UserMessage 로 wrap
    해서 LLM 에 inject (SystemMessage 는 보통 첫 message 1개만 허용).
    """
    from secu_agent.agent.llm.messages import SystemMessage as _SystemMessage
    msgs: list[Message] = []
    for r in rows:
        role = r["role"]
        content = r["content"]
        if role == "user":
            text = content.get("text", "")
            if text:
                msgs.append(UserMessage(content=[TextBlock(text=text)]))
        elif role == "assistant":
            text = content.get("text", "")
            if text:
                msgs.append(AssistantMessage(content=[TextBlock(text=text)]))
        elif role == "system":
            text = content.get("text", "")
            if text:
                # 중간 system note 는 UserMessage 로 wrap — chat 시퀀스 보존
                msgs.append(UserMessage(content=[TextBlock(text=f"[SYSTEM NOTE] {text}")]))
    return msgs


@dataclass
class ChatSession:
    session_id: int
    client: LLMClient
    registry: Any  # ToolRegistry
    context: ToolContext
    messages: list[Message]
    cfg: QueryConfig
    sys_prompt: str
    summarizer: ContextSummarizer | None = None  # v3.24-B: LLM-based 압축
    context_engine: ContextEngine | None = None

    @classmethod
    def load(
        cls, *,
        client: LLMClient,
        evidence_dir: Path,
        task_type: str = "operator",
        history_limit: int = 200,
        frontend_capabilities: set[str] | frozenset[str] | None = None,
        session_id: int | None = None,
        session_agent_type: str | None = None,
        skills_selection=None,
    ) -> "ChatSession":
        session_agent_type = session_agent_type or (
            # v3.82 U3b: operator 기본 agent_type 는 중립 'agent' (구 'smb' 잔재 제거 —
            # 기존 smb 세션 행은 smb→operator alias 로 계속 동작)
            "agent" if task_type == "operator" else task_type
        )
        if session_id is None:
            sid = state.chat_session_get_or_create(agent_type=session_agent_type)
        else:
            row = state.chat_session_get(session_id)
            if row is None:
                raise ValueError(f"chat_session {session_id} not found")
            if row.get("agent_type") != session_agent_type:
                raise ValueError(
                    f"chat_session {session_id} agent_type={row.get('agent_type')!r} "
                    f"does not match {session_agent_type!r}"
                )
            sid = session_id
        rows = state.chat_messages_for(sid, limit=history_limit)
        messages = _restore_messages(rows)

        registry = build_registry_for_task(
            task_type,
            frontend_capabilities=frontend_capabilities,
        )
        plan_state = state.chat_plan_mode_get(sid)
        metadata: dict[str, object] = {
            # operator 는 terminal 없음 — 사용자 다음 메시지까지 LLM end_turn 으로 종료
            "terminal_tools": set(),
            # TodoTool 등 session-scoped 도구가 사용 — chat_session.id
            "session_id": sid,
            # schedule_wakeup / scheduler routing 에서 현재 agent workspace 를 유지.
            "agent_type": session_agent_type,
            **runtime_llm_metadata(client),
        }
        if skills_selection is not None:
            # v3.82 U4: per-invocation skill 선택 — 세션 시작 시 고정(immutable),
            # 3개 로드 경로(시스템프롬프트/trigger 주입/skill 도구) 공통 통과.
            metadata["skills_selection"] = skills_selection
        if plan_state.get("active"):
            metadata["plan_mode_active"] = True
            metadata["plan_mode_status"] = plan_state.get("status") or "approved"
            if plan_state.get("plan") is not None:
                metadata["plan_mode_plan"] = plan_state["plan"]
        todo_items = state.todo_read(sid)
        if todo_items:
            metadata["todo_items"] = todo_items
            todo_note = format_active_todo_snapshot(todo_items)
            if todo_note is not None:
                messages.append(UserMessage(content=[TextBlock(text=todo_note)]))
        context = ToolContext(evidence_dir=evidence_dir, metadata=metadata)
        # v3.12-C: operator 는 registry 메타 + skills 자동 합성 prompt 사용.
        # can_ask_operator: 대화형(web/TUI/knox)만 interactive_approval 을 넘긴다 —
        # scheduler tick 등 무인 경로는 안 넘기므로 자동으로 False. 프롬프트가 "묻는다"
        # 대신 "기록하고 다음 항목" 으로 갈린다.
        sys_p = system_prompt(
            task_type, registry=registry, skills_selection=skills_selection,
            can_ask_operator="interactive_approval" in (frontend_capabilities or frozenset()),
        )

        # v3.56: 예전 gpt-oss-120b 의 high 가 chat 에 너무 느려서 operator 를 medium 으로
        # 강제하던 clamp 제거 — codex(xhigh) 기본으로 전환하면서 reasoning_effort 는 각
        # profile 기본값을 따른다 (codex=xhigh, oss fallback=high). None 이면 client 가
        # profile.reasoning_effort 사용. env SA_CHAT_REASONING_EFFORT 가 최우선 override.
        # v3.72: 하이브리드 reasoning base. env override 최우선 → 없으면 자율(agent) batch
        # 는 base medium(throughput; deep_mode/안전망이 필요시 xhigh 승급) → interactive
        # operator 는 None(profile xhigh 유지 — 사람이 기다리는 대화라 품질 우선).
        re_override = _os.environ.get("SA_CHAT_REASONING_EFFORT")
        if re_override:
            operator_re = re_override
        elif session_agent_type == "agent":
            operator_re = _os.environ.get("SA_AUTONOMOUS_REASONING_EFFORT", "medium")
        else:
            # v3.76.3: interactive chat 도 base **medium** (예전엔 None→profile xhigh 라
            # 모든 chat 턴이 느렸음). deep_mode 도구 / HIGH·critical finding 시 engine 이
            # deep_passes_remaining 으로 그 pass 만 xhigh 승급 → "base medium + deep xhigh".
            operator_re = "medium"
        max_output_tokens, compact_threshold, sliding_window_chars = _chat_budget_config()
        cfg = QueryConfig(
            max_turns=None,  # 운영자 chat — 무제한. ESC / 무활동 watchdog 으로 통제.
            max_tokens_per_call=max_output_tokens,
            compact_char_threshold=compact_threshold,
            compact_keep_last_n=4,
            sliding_window_max_chars=sliding_window_chars,
            reasoning_effort=operator_re,
            # Front-D: 자율 Ralph 루프(이 세션 위에서 돎)도 등급 적응 loop-guard 를 받도록
            # client(=profile 로 구성)에서 등급 파생. None=mid(무변).
            harness_tier=getattr(client, "harness_tier", None),
        )
        # v3.24-B: LLM-based context_summarizer 활성 대상.
        # v3.71: operator 뿐 아니라 autonomous agent 도 포함 — 자율 batch 점검이
        # 가장 길게 돌며 압축이 가장 필요. (route remap 으로 agent→operator 되긴 하나
        # side-effect 의존 끊고 명시화.) threshold = stub(compact) 먼저, 못 줄이면 LLM.
        summarizer: ContextSummarizer | None = None
        context_engine: ContextEngine | None = None
        if task_type in {"operator", "agent"}:
            summ_threshold = int(
                _os.environ.get("SA_SUMMARIZER_THRESHOLD_CHARS", "240000"),
            )
            # v3.81 T1c: 압축 역할 모델 분리 — SA_SUMMARIZER_PROFILE 설정 시
            # 그 모델로 압축 호출 오프로드, 아니면 세션 client.
            summarizer = ContextSummarizer(
                client=make_role_client("summarizer", default=client),
                threshold_chars=summ_threshold,
                protect_first_n=2,
                tail_char_budget=80_000,
            )
            context_engine = ContextEngine(
                policy=ContextEnginePolicy.from_env(
                    default_stub_threshold_chars=cfg.compact_char_threshold,
                    default_stub_keep_last_n=cfg.compact_keep_last_n,
                ),
                summarizer=summarizer,
            )

        return cls(
            session_id=sid, client=client, registry=registry,
            context=context, messages=messages, cfg=cfg, sys_prompt=sys_p,
            summarizer=summarizer, context_engine=context_engine,
        )

    async def maybe_compress(self, *, force: bool = False,
                              focus_topic: str | None = None) -> dict | None:
        """필요 시 (또는 force=True 시) context 압축. 결과 stats 반환.

        호출 시점: turn() 시작 직전. 압축 발생 시 self.messages 갱신 + 시스템 노트 박음.
        반환: stats dict (None 이면 미실행).
        """
        if self.context_engine is not None:
            new_msgs, stats = await self.context_engine.compress(
                self.messages, force=force, focus_topic=focus_topic,
            )
            if not stats.triggered:
                return None
            self.messages.clear()
            self.messages.extend(new_msgs)
            clear_read_state(self.context.metadata)

            summary_stats = stats.summary_stats
            note_text = (
                f"context 압축 발생: mode={stats.mode}, "
                f"stub={stats.stub_compacted}, "
                f"{stats.savings_pct:.0f}% 절약."
            )
            if summary_stats and summary_stats.triggered:
                note_text += (
                    f" summary={summary_stats.middle_count}개 중간 turn → summary, "
                    f"head={summary_stats.head_count}, tail={summary_stats.tail_count}."
                )
            if stats.summary_error:
                note_text += f" ⚠ summary 생성 실패: {stats.summary_error}"
            state.chat_message_add(
                self.session_id, role="system", content={"text": note_text},
            )
            return {
                "triggered": stats.triggered,
                "mode": stats.mode,
                "stub_compacted": stats.stub_compacted,
                "head_count": summary_stats.head_count if summary_stats else 0,
                "middle_count": summary_stats.middle_count if summary_stats else 0,
                "tail_count": summary_stats.tail_count if summary_stats else 0,
                "savings_pct": stats.savings_pct,
                "summary_error": stats.summary_error,
                "fallback_used": stats.fallback_used,
            }

        if not self.summarizer:
            return None
        if not force and not self.summarizer.should_compress(self.messages):
            return None
        new_msgs, stats = await self.summarizer.compress(
            self.messages, force=force, focus_topic=focus_topic,
        )
        if not stats.triggered:
            return None
        # 메시지 replace — 같은 list 객체에 in-place 반영
        self.messages.clear()
        self.messages.extend(new_msgs)
        clear_read_state(self.context.metadata)
        # DB 노트 영속 — replay 시 사용자가 봐도 무슨 일 있었는지 알게
        note_text = (
            f"context 압축 발생: {stats.head_count} head + summary + "
            f"{stats.tail_count} tail. "
            f"{stats.middle_count}개 중간 turn → summary. "
            f"{stats.savings_pct:.0f}% 절약."
        )
        if stats.summary_error:
            note_text += f" ⚠ summary 생성 실패: {stats.summary_error}"
        state.chat_message_add(
            self.session_id, role="system", content={"text": note_text},
        )
        return {
            "triggered": stats.triggered,
            "head_count": stats.head_count,
            "middle_count": stats.middle_count,
            "tail_count": stats.tail_count,
            "savings_pct": stats.savings_pct,
            "summary_error": stats.summary_error,
            "fallback_used": stats.fallback_used,
        }

    async def _run_engine_pass(self) -> AsyncIterator[LoopEvent]:
        """engine.run_query 한 번 호출 + tool_event DB 영속. 매 이벤트 yield.

        engine 은 self.messages 의 복사본으로 작업하므로 LoopCompleted.final_message
        를 받아 self.messages 에 직접 append — Ralph loop 의 다음 iteration 이 그
        AssistantMessage 위에서 continuation prompt 박을 수 있게.
        """
        async for ev in run_query(
            client=self.client,
            registry=self.registry,
            context=self.context,
            initial_messages=self.messages,
            system=self.sys_prompt,
            config=self.cfg,
            unlocked_tools=self.context.unlocked_tools,
        ):
            if isinstance(ev, LoopCompleted) and ev.final_message is not None:
                self.messages.append(ev.final_message)
            if isinstance(ev, ToolCallStarted):
                if (
                    self.context.metadata.get("plan_mode_active")
                    and self.context.metadata.get("plan_mode_status") == "approved"
                    and ev.name not in {"enter_plan_mode", "exit_plan_mode"}
                ):
                    state.chat_plan_mode_mark_executing(self.session_id)
                    self.context.metadata["plan_mode_status"] = "executing"
                await asyncio.to_thread(
                    state.chat_message_add,
                    self.session_id, role="tool_event",
                    content={
                        "event": "ToolCallStarted",
                        "id": ev.tool_use_id, "name": ev.name,
                        "input": ev.input,
                    },
                )
            elif isinstance(ev, ToolCallCompleted):
                content_text = (
                    ev.result.content if isinstance(ev.result, ToolSuccess)
                    else getattr(ev.result, "message", "")
                )
                await asyncio.to_thread(
                    state.chat_message_add,
                    self.session_id, role="tool_event",
                    content={
                        "event": "ToolCallCompleted",
                        "id": ev.tool_use_id, "name": ev.name,
                        "ok": isinstance(ev.result, ToolSuccess),
                        "result": content_text[:2000],
                    },
                )
            elif isinstance(ev, LlmCallMeasured):
                # v3.62 Q5: 토큰/세그먼트 계측 DB 기록 (engine 은 측정만, write 는 여기).
                # v3.65-fix: 이건 순수 백엔드 계측 이벤트 — WS/프론트로 내보내면
                # handleWsEvent 의 미지-이벤트 fallback 이 잡동사니 op 박스를 그려
                # reasoning/tool 스텝 렌더를 헝클어뜨린다. 기록만 하고 yield 안 함.
                try:
                    await asyncio.to_thread(
                        state.token_usage_record,
                        session_id=self.session_id, turn_seq=ev.turn,
                        system_chars=ev.system_chars, tools_chars=ev.tools_chars,
                        history_chars=ev.history_chars,
                        input_tokens=ev.input_tokens, output_tokens=ev.output_tokens,
                        cache_read_input_tokens=ev.cache_read_input_tokens,
                        cache_creation_input_tokens=ev.cache_creation_input_tokens,
                        profile=_os.environ.get("SA_CHAT_PROFILE"),
                        model=getattr(self.client, "name", None),
                    )
                except Exception:
                    pass  # 계측 실패가 점검을 막으면 안 됨
                continue  # WS 로 흘리지 않음 (display 이벤트 아님)
            yield ev

    def _persist_last_assistant(self) -> str:
        """마지막 AssistantMessage 의 text 부분 추출 + DB 영속. 반환: 그 text."""
        last = self.messages[-1] if self.messages else None
        if not isinstance(last, AssistantMessage):
            return ""
        text = "".join(
            b.text for b in last.content if isinstance(b, TextBlock)
        )
        if text:
            state.chat_message_add(
                self.session_id, role="assistant", content={"text": text},
            )
        return text

    async def turn(self, user_text: str) -> AsyncIterator[LoopEvent]:
        """사용자 1개 메시지 입력 → engine loop + (active goal 있으면) Ralph loop.

        DB 에:
        - user_text → role='user'
        - 매 ToolCallStarted/Completed → role='tool_event'
        - 매 iteration 의 최종 assistant text → role='assistant'
        - goal lifecycle (decompose / checklist update / done / paused) → role='system'

        v3.24-B: turn 시작 직전 maybe_compress() 호출 — auto-trigger.
        v3.35-D: active goal 있고 미완료면 evaluate → continuation prompt → 추가 engine pass.
        """
        await self.maybe_compress()

        # 1) user message 영속 + LLM context 추가.
        #    paused goal 은 자동 재개하지 않는다. 다만 "계속 진행/재개/resume" 같은
        #    명시적 재개 요청은 goal(action='resume') 과 같은 효과로 처리한다.
        input_origin = self.context.metadata.pop("input_origin", None)
        scheduled_origin = (
            isinstance(input_origin, dict)
            and input_origin.get("type") == "schedule"
        )
        llm_user_text = user_text
        if scheduled_origin:
            schedule_id = input_origin.get("schedule_id")
            fire_id = input_origin.get("fire_id")
            content = {
                "text": user_text,
                "origin": "schedule",
                "schedule_id": schedule_id,
                "fire_id": fire_id,
            }
            state.chat_message_add(
                self.session_id, role="system", content=content,
            )
            llm_user_text = (
                "[SCHEDULED TASK]\n"
                f"origin=schedule schedule_id={schedule_id} fire_id={fire_id}\n\n"
                f"{user_text}"
            )
        else:
            state.chat_message_add(
                self.session_id, role="user", content={"text": user_text},
            )

        resumed_goal = False
        if not scheduled_origin and _is_goal_resume_request(user_text):
            active_or_paused = state.goal_get_active(self.session_id)
            if active_or_paused and active_or_paused.get("status") == "paused":
                resumed_goal = state.goal_resume(self.session_id)
                if resumed_goal:
                    state.chat_message_add(
                        self.session_id,
                        role="system",
                        content={
                            "text": (
                                "goal resume: 사용자 명시 재개 요청 — "
                                "paused goal 을 active 로 전환"
                            )
                        },
                    )
        skill_context = _auto_skill_context_for_turn(
            user_text, self.context, self.registry,
        )
        if skill_context is not None:
            self.messages.append(UserMessage(content=[TextBlock(text=skill_context)]))
        # v3.42 F3: 직전 진행 상태 brief — agent 가 "처음부터" 가 아니라 회복 모드로 진입하게
        brief = build_context_brief(self.session_id, self.context.metadata)
        if brief is not None:
            self.messages.append(UserMessage(content=[TextBlock(text=brief)]))
        if resumed_goal:
            self.messages.append(UserMessage(content=[TextBlock(text=(
                "[SYSTEM NOTE] The user's message explicitly resumed the paused goal. "
                "Do not call the goal resume tool again; continue the active goal workflow now."
            ))]))
        self.messages.append(UserMessage(content=[TextBlock(text=llm_user_text)]))
        if self.context.metadata.get("plan_mode_active") and _is_plan_ack(user_text):
            self.messages.append(UserMessage(content=[
                TextBlock(text=_plan_resume_note(
                    self.context.metadata.get("plan_mode_plan"),
                )),
            ]))

        # v3.64(H2): Ralph 루프 + goal/batch 오케스트레이션은 RalphController 로 분리.
        #   여기(turn)는 setup(영속/skill/brief/plan-ack)만 — 세션관리 ⟂ 오케스트레이션.
        #   통제권은 그대로 코드(컨트랙트-driven). 흐름은 ralph_controller.py 참조.
        from secu_agent.agent.ralph_controller import RalphController

        async for ev in RalphController(self).run():
            yield ev
