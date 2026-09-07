"""`secu-agent task` — 등록된 TaskPlan 을 결정론 다단 phase 로 구동 (v3.83).

rich 기반 이벤트 렌더 (신규 의존성 없음). plan/어댑터는 plugin(SA_PLUGINS)이
register_task_plan / register_fanout_adapter 로 등록한다 — 이 CLI 는 등록된
이름을 찾아 run_plan 으로 돌리고 phase/worker 이벤트를 스트림 렌더할 뿐,
도메인을 모른다.

Ctrl+C = cancel_event set → fan-out 취소 (WorkerPool SIGTERM→grace→SIGKILL),
완료는 전부 drain 후 PlanCompleted(cancelled=True).
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import signal

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from secu_agent.agent.events import (
    PhaseAborted,
    PhaseCompleted,
    PhaseSkipped,
    PhaseStarted,
    PlanCompleted,
    WorkerCompleted,
)
from secu_agent.agent.task_plan import (
    get_task_plan,
    list_task_plans,
    run_plan,
)


def add_subparser(sub: "argparse._SubParsersAction") -> None:
    hp = sub.add_parser(
        "task", help="등록된 TaskPlan 을 다단 phase 로 실행 (결정론 fan-out)")
    hp.add_argument("--plan", default=None, help="실행할 등록 plan 이름")
    hp.add_argument(
        "--list-plans", action="store_true",
        help="등록된 plan 과 phase 구성 출력 후 종료")
    hp.add_argument(
        "--goal-id", type=int, default=None,
        help="연결할 goal id (타깃=1turn goal_record_turn). 생략 시 회계 없음")


def _print_plan_list(console: Console) -> None:
    names = list_task_plans()
    if not names:
        console.print(
            "[yellow]등록된 task plan 없음[/yellow] — "
            "[dim]plugin(SA_PLUGINS)이 register_task_plan 으로 등록해야 한다[/dim]")
        return
    for name in names:
        plan = get_task_plan(name)
        if plan is None:
            continue
        t = Table(title=f"plan: {name}", title_style="bold", show_edge=False)
        t.add_column("phase"); t.add_column("adapter"); t.add_column("k", justify="right")
        t.add_column("budget", justify="right"); t.add_column("flags")
        for ph in plan.phases:
            flags = []
            if ph.canary:
                flags.append("canary")
            if ph.gate is not None:
                flags.append("gate")
            if not ph.required:
                flags.append("optional")
            t.add_row(
                ph.name, ph.adapter, str(ph.k),
                "—" if ph.max_targets is None else str(ph.max_targets),
                " ".join(flags) or "—",
            )
        console.print(t)


def _render(console: Console, ev: object) -> None:
    if isinstance(ev, PhaseStarted):
        tags = f"k={ev.k}"
        if ev.canary:
            tags += " canary"
        console.print(
            f"\n[bold cyan]▶ phase[/bold cyan] [bold]{ev.phase}[/bold] "
            f"[dim](adapter={ev.adapter} {tags})[/dim]")
    elif isinstance(ev, WorkerCompleted):
        mark = "[green]✓[/green]" if ev.ok else "[red]✗[/red]"
        console.print(
            f"  {mark} [dim]{ev.label}[/dim] [dim]({ev.status}, "
            f"{ev.duration_sec:.1f}s)[/dim]")
    elif isinstance(ev, PhaseCompleted):
        r = ev.report
        console.print(
            f"[cyan]■ phase 완료[/cyan] [bold]{ev.phase}[/bold] — "
            f"claimed={r.claimed} ok={r.succeeded} fail={r.failed} "
            f"findings={r.findings_count}")
    elif isinstance(ev, PhaseSkipped):
        console.print(
            f"[dim]⊘ phase skip[/dim] [bold]{ev.phase}[/bold] "
            f"[dim]({ev.reason})[/dim]")
    elif isinstance(ev, PhaseAborted):
        console.print(
            f"[red]✗ phase 중단[/red] [bold]{ev.phase}[/bold] — {ev.reason}")
    elif isinstance(ev, PlanCompleted):
        _render_final(console, ev)


def _render_final(console: Console, ev: PlanCompleted) -> None:
    res = ev.result
    t = Table(show_edge=False)
    t.add_column("phase"); t.add_column("claimed", justify="right")
    t.add_column("ok", justify="right"); t.add_column("fail", justify="right")
    t.add_column("findings", justify="right")
    for phase_name, r in res.reports:
        t.add_row(phase_name, str(r.claimed), str(r.succeeded),
                  str(r.failed), str(r.findings_count))
    t.add_row(
        "[bold]합계[/bold]", f"[bold]{res.total_claimed}[/bold]",
        f"[bold]{res.total_succeeded}[/bold]", f"[bold]{res.total_failed}[/bold]",
        f"[bold]{res.total_findings}[/bold]")
    if ev.cancelled:
        status, style = f"취소됨 ({ev.reason})", "yellow"
    elif ev.aborted:
        status, style = f"중단됨 ({ev.reason})", "red"
    else:
        status, style = f"완료 ({ev.reason})", "green"
    console.print(Panel(
        t, title=f"plan: {ev.plan}",
        subtitle=f"[{style}]{status}[/{style}]", border_style=style))


async def run_task(args: argparse.Namespace) -> int:
    console = Console()

    if args.list_plans:
        _print_plan_list(console)
        return 0

    if not args.plan:
        console.print("[red]--plan <name> 또는 --list-plans 필요[/red]")
        return 2

    plan = get_task_plan(args.plan)
    if plan is None:
        avail = ", ".join(list_task_plans()) or "(없음 — SA_PLUGINS 로 등록 필요)"
        console.print(
            f"[red]plan {args.plan!r} 미등록[/red] [dim]— 사용 가능: {avail}[/dim]")
        return 2

    console.print(Panel(
        f"plan [bold]{plan.name}[/bold] · {len(plan.phases)} phases · "
        f"goal_id={args.goal_id}", border_style="dim", title="secu-agent task"))

    loop = asyncio.get_running_loop()
    cancel_event = asyncio.Event()
    with contextlib.suppress(NotImplementedError):
        loop.add_signal_handler(signal.SIGINT, cancel_event.set)

    final: PlanCompleted | None = None
    try:
        async for ev in run_plan(
            plan, goal_id=args.goal_id, cancel_event=cancel_event,
        ):
            _render(console, ev)
            if isinstance(ev, PlanCompleted):
                final = ev
    finally:
        with contextlib.suppress(NotImplementedError, ValueError):
            loop.remove_signal_handler(signal.SIGINT)

    if final is None:
        return 1
    if final.aborted:
        return 1
    return 0
