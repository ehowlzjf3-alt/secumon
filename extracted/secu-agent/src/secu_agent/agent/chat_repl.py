"""`secu-agent chat` — rich 기반 터미널 대화형 REPL (v3.82 U4).

웹(8765 WS)·Knox 브릿지와 같은 ChatSession 경로의 세 번째 frontend.
신규 의존성 없음 (rich 는 기존 의존성). 제공:

- 세션 목록/이어가기/새로 시작 (`--list-sessions` / `--session N` / `/new`)
- 스트리밍 렌더: 본문/reasoning(dim)/도구 이벤트/goal 체크리스트/턴 요약
- keystroke 승인 — `frontend_capabilities={'interactive_approval'}` 게이트
  도구(plan mode 등) 유지. 미구현 시 해당 도구가 조용히 사라진다.
- `/compact [topic]` (웹 WS 핸들러와 동일 시맨틱), `/quit`
- `-s` per-invocation skill 선택 — skills.SkillsSelection 이 3개 로드 경로
  (시스템프롬프트 인덱스/trigger 자동주입/skill 도구)를 공통 통과, 세션
  시작 시 고정. 턴 중 Ctrl+C = 턴 취소 (프롬프트에서 Ctrl+C/Ctrl+D = 종료).
"""
from __future__ import annotations

import argparse
import asyncio
import os
import time
from typing import Any

from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel

from secu_agent import state
from secu_agent.agent.events import (
    GoalChecklistUpdated,
    GoalContinuation,
    GoalDecomposed,
    GoalDone,
    GoalPaused,
    LoopCompleted,
    LoopError,
    ReasoningChunk,
    TextChunk,
    ToolCallCompleted,
    ToolCallStarted,
)
from secu_agent.agent.skills import parse_skills_selection, resolve_skills_dirs

_PROMPT = "you> "


class TerminalApprovalResolver:
    """keystroke 승인 — 웹 _WebSocketApprovalResolver / KnoxApprovalResolver 대응.

    mode: ask(기본) = y/N 키 입력, auto = 전부 허용, deny = 전부 거부.
    감사 기록은 다른 frontend 와 동일 (approval_audit_*).
    """

    def __init__(self, *, console: Console, session_id: int, agent_type: str,
                 mode: str = "ask") -> None:
        self._console = console
        self._session_id = session_id
        self._agent_type = agent_type
        self._mode = (mode or "ask").strip().lower()

    async def resolve(self, request: Any) -> Any:
        await asyncio.to_thread(
            state.approval_audit_record_request,
            approval_id=request.invocation_id,
            session_id=self._session_id,
            agent_type=self._agent_type,
            actor="terminal",
            tool_name=request.tool_name,
            tool_input=request.tool_input,
            reason=request.reason,
        )
        if self._mode == "auto":
            return await self._finalize(request, "allow", "auto approval mode")
        if self._mode == "deny":
            return await self._finalize(request, "deny", "deny approval mode")

        self._console.print(Panel(
            f"[bold]tool[/bold]: {request.tool_name}\n"
            f"[bold]input[/bold]: {request.tool_input}\n"
            f"[bold]이유[/bold]: {request.reason}",
            title="⚠ 승인 필요", border_style="yellow",
        ))
        answer = await asyncio.to_thread(input, "허용? [y/N] ")
        if answer.strip().lower() in ("y", "yes"):
            return await self._finalize(request, "allow", "approved via terminal")
        return await self._finalize(request, "deny", "denied via terminal")

    async def _finalize(self, request: Any, behavior: str, reason: str) -> Any:
        from secu_agent.agent.tools.approval import ApprovalDecision

        await asyncio.to_thread(
            state.approval_audit_resolve,
            request.invocation_id,
            decision=behavior,
            decision_reason=reason,
            actor="terminal",
        )
        return ApprovalDecision(behavior=behavior, reason=reason)  # type: ignore[arg-type]


class _TurnRenderer:
    """LoopEvent 스트림 → 터미널. 본문은 스트리밍 raw, 턴 끝에 마크다운 재렌더."""

    def __init__(self, console: Console) -> None:
        self.console = console
        self._text_parts: list[str] = []
        self._streamed = False

    def render(self, ev: Any) -> None:
        c = self.console
        if isinstance(ev, TextChunk):
            self._text_parts.append(ev.text)
            c.print(ev.text, end="", highlight=False, soft_wrap=True)
            self._streamed = True
        elif isinstance(ev, ReasoningChunk):
            c.print(f"[dim]{ev.text}[/dim]", end="", highlight=False, soft_wrap=True)
        elif isinstance(ev, ToolCallStarted):
            c.print(f"\n[cyan]→ {ev.name}[/cyan] [dim]{_short(ev.input)}[/dim]")
        elif isinstance(ev, ToolCallCompleted):
            ok = getattr(ev.result, "content", None) is not None and \
                ev.result.__class__.__name__ != "ToolError"
            mark = "[green]✓[/green]" if ok else "[red]✗[/red]"
            c.print(f"[cyan]← {ev.name}[/cyan] {mark} [dim]{_short(getattr(ev.result, 'content', getattr(ev.result, 'message', '')))}[/dim]")
        elif isinstance(ev, GoalDecomposed):
            c.print(Panel(
                f"{_short(ev.goal_text, 300)}\n항목 {ev.item_count}개",
                title="goal 분해", border_style="blue",
            ))
        elif isinstance(ev, GoalChecklistUpdated):
            c.print(
                f"[blue]☑ 체크리스트[/blue] {ev.completed}/{ev.total} 완료 · "
                f"pending {ev.pending} · flips {ev.flipped} [dim]{_short(ev.reason)}[/dim]"
            )
        elif isinstance(ev, GoalPaused):
            c.print(f"[yellow]⏸ goal 일시정지[/yellow] [dim]{_short(ev.reason)}[/dim]")
        elif isinstance(ev, GoalDone):
            c.print(f"[green]✔ goal 완료[/green] [dim]{_short(ev.reason)}[/dim]")
        elif isinstance(ev, GoalContinuation):
            c.print("[blue]↻ goal 자동 계속[/blue]")
        elif isinstance(ev, LoopError):
            c.print(f"\n[red]오류: {ev.message}[/red]")
        elif isinstance(ev, LoopCompleted):
            self.finish(ev)

    def finish(self, ev: LoopCompleted) -> None:
        c = self.console
        c.print()  # 스트리밍 줄 마감
        full = "".join(self._text_parts).strip()
        if full and ("```" in full or "|" in full or "##" in full):
            # 코드블록/표/헤딩이 있으면 마크다운으로 한 번 더 정돈 렌더
            c.print(Panel(Markdown(full), border_style="dim", title="assistant"))
        usage = ev.usage
        meta = [f"turns={ev.total_turns}", f"reason={ev.reason}"]
        if usage is not None:
            meta.append(f"tok in/out={getattr(usage, 'input_tokens', '?')}/"
                        f"{getattr(usage, 'output_tokens', '?')}")
        c.print(f"[dim]── {' · '.join(meta)} ──[/dim]")


def _short(v: Any, n: int = 160) -> str:
    s = str(v).replace("\n", " ")
    return s if len(s) <= n else s[: n - 1] + "…"


def _print_sessions(console: Console, agent_type: str | None) -> None:
    from rich.table import Table

    rows = state.chat_session_list(agent_type=agent_type, include_archived=False, limit=30)
    t = Table(title="chat sessions (활성, 최근 30)")
    for col in ("id", "agent_type", "label", "갱신"):
        t.add_column(col)
    for r in rows:
        ts = r.get("updated_at") or r.get("started_at")
        when = time.strftime("%m-%d %H:%M", time.localtime(ts)) if ts else "-"
        t.add_row(str(r["id"]), str(r.get("agent_type") or "-"),
                  str(r.get("label") or "-"), when)
    console.print(t)


async def _run_turn(console: Console, sess: Any, text: str) -> None:
    renderer = _TurnRenderer(console)

    async def _consume() -> None:
        async for ev in sess.turn(text):
            renderer.render(ev)

    task = asyncio.ensure_future(_consume())
    try:
        await task
    except asyncio.CancelledError:
        console.print("\n[yellow]턴 취소됨[/yellow]")
    except KeyboardInterrupt:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        console.print("\n[yellow]턴 취소됨 (Ctrl+C)[/yellow]")


async def run_chat(args: argparse.Namespace) -> int:
    from secu_agent.agent.chat_session import ChatSession
    from secu_agent.agent.session_runtime import (
        evidence_dir as _evidence_dir,
        make_llm_client,
        runtime_task_type,
    )

    console = Console()
    agent_type = args.agent_type

    if args.list_sessions:
        _print_sessions(console, agent_type)
        return 0

    if args.profile_name:
        # make_llm_client 는 SA_CHAT_PROFILE 을 읽는다 — 무효 이름은 factory 가
        # fail-closed (silent downgrade 금지, v3.81 T1c 와 동일 원칙).
        os.environ["SA_CHAT_PROFILE"] = args.profile_name

    try:
        selection = parse_skills_selection(args.skills)
    except ValueError as e:
        console.print(f"[red]{e}[/red]")
        return 2

    ev_dir = args.evidence_dir or _evidence_dir()
    client = make_llm_client()
    try:
        try:
            sess = ChatSession.load(
                client=client,
                evidence_dir=ev_dir,
                task_type=runtime_task_type(agent_type),
                frontend_capabilities={"interactive_approval"},
                session_id=args.session,
                session_agent_type=agent_type,
                skills_selection=selection,
            )
        except ValueError as e:
            console.print(f"[red]{e}[/red]")
            return 2
        sess.context.approval_resolver = TerminalApprovalResolver(
            console=console, session_id=sess.session_id, agent_type=agent_type,
            mode=args.approval_mode,
        )

        # 시작 배너 — env 만으로는 보이지 않던 해석 결과를 명시 (U4 UX)
        meta = sess.context.metadata or {}
        skills_note = "전체"
        if selection is not None:
            parts = []
            if selection.names:
                parts.append("names=" + ",".join(selection.names))
            if selection.extra_dirs:
                parts.append("+dirs=" + ",".join(str(d) for d in selection.extra_dirs))
            skills_note = " ".join(parts)
        console.print(Panel(
            f"session [bold]#{sess.session_id}[/bold] · agent_type={agent_type} · "
            f"profile={meta.get('llm_profile') or client.name}\n"
            f"evidence={ev_dir}\n"
            f"skills dirs={[str(d) for d in resolve_skills_dirs()]}\n"
            f"skills 선택={skills_note} · 승인={args.approval_mode}\n"
            f"명령: /new /compact [topic] /sessions /quit · 턴 중 Ctrl+C=취소",
            title="secu-agent chat", border_style="green",
        ))

        while True:
            try:
                text = (await asyncio.to_thread(input, _PROMPT)).strip()
            except (EOFError, KeyboardInterrupt):
                console.print("\n[dim]종료[/dim]")
                return 0
            if not text:
                continue
            if text in ("/quit", "/exit", "/q"):
                return 0
            if text == "/sessions":
                _print_sessions(console, agent_type)
                continue
            if text == "/new":
                sid = state.chat_session_new(agent_type=agent_type)
                sess = ChatSession.load(
                    client=client, evidence_dir=ev_dir,
                    task_type=runtime_task_type(agent_type),
                    frontend_capabilities={"interactive_approval"},
                    session_id=sid, session_agent_type=agent_type,
                    skills_selection=selection,
                )
                sess.context.approval_resolver = TerminalApprovalResolver(
                    console=console, session_id=sid, agent_type=agent_type,
                    mode=args.approval_mode,
                )
                console.print(f"[green]새 세션 #{sid}[/green]")
                continue
            if text.startswith("/compact"):
                focus = text[len("/compact"):].strip() or None
                stats = await sess.maybe_compress(force=True, focus_topic=focus)
                if stats is None:
                    console.print("[dim]압축 대상 없음 (summarizer 미활성 또는 메시지 너무 적음).[/dim]")
                else:
                    note = (f"/compact 실행: {stats['middle_count']}개 turn → summary, "
                            f"{stats['savings_pct']:.0f}% 절약.")
                    if stats.get("summary_error"):
                        note += f" ⚠ {stats['summary_error']}"
                    console.print(f"[green]{note}[/green]")
                continue
            await _run_turn(console, sess, text)
    finally:
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001
            pass


def add_subparser(sub: Any) -> None:
    ch = sub.add_parser("chat", help="터미널 대화형 점검 채팅 (rich REPL)")
    ch.add_argument("--session", type=int, default=None,
                    help="이어갈 chat_session id (생략=agent_type 의 활성 세션 재사용/생성)")
    ch.add_argument("--list-sessions", action="store_true",
                    help="활성 세션 목록만 출력하고 종료")
    ch.add_argument("--agent_type", default="agent",
                    help="세션 agent_type (기본 agent — plugin 등록 agent_type 사용 가능)")
    ch.add_argument("--approval-mode", default=os.environ.get("SA_CHAT_APPROVAL_MODE", "ask"),
                    choices=("ask", "auto", "deny"),
                    help="destructive 도구 승인 (기본 ask=키 입력)")
    ch.add_argument("-s", "--skills", action="append", default=None, metavar="NAME|DIR",
                    help="skill 선택 — 이름(콤마구분) 또는 추가 디렉토리. "
                         "이름은 미존재 시 즉시 에러, 디렉토리는 코어 뒤에 additive")
    ch.add_argument("--profile-name", default=None,
                    help="LLM 프로파일 (생략=SA_CHAT_PROFILE/기본). 무효=시작 거부")
    ch.add_argument("--evidence-dir", default=None, type=__import__("pathlib").Path,
                    help="evidence 디렉토리 (생략=SA_CHAT_EVIDENCE/기본)")
