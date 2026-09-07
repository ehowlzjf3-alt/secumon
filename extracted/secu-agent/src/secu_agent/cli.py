"""secu-agent 진입점 (코어).

코어 서브커맨드: chat / tokens / doctor / eval / web / mcp / knox-bridge / skill.
(구 status 는 SMB 전용 잔재 — v3.82 U3c 에서 제거, 도메인 현황은 도메인 서비스가 제공.)
도메인(점검) 서브커맨드는 secu-agent-skill 로 추출됨 — 재부착 plugin 이 공급.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from secu_agent import state


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _load_env_once() -> None:
    """프로젝트 루트의 .env를 process env로 흡수. agent.cli와 동일 파서 사용."""
    from secu_agent.agent.cli import _load_dotenv
    _load_dotenv(_project_root() / ".env")


def _cmd_tokens(args: argparse.Namespace) -> int:
    """v3.62 Q5: 세션 토큰/세그먼트 계측 요약."""
    s = state.token_usage_summary(args.session_id)
    if args.json:
        print(json.dumps(s, ensure_ascii=False, indent=2))
        return 0
    sid = args.session_id
    if s["calls"] == 0:
        print(f"세션 {sid}: 계측 데이터 없음 (token_usage 행 0개)")
        return 0
    pct = s["segment_pct"]
    print(f"=== 세션 {sid} 토큰 계측 ===")
    print(f"  LLM 호출:    {s['calls']}회")
    print(f"  input 토큰:  {s['input_tokens']:,}")
    print(f"  output 토큰: {s['output_tokens']:,}")
    print(f"  세그먼트 비중 (char proxy):")
    print(f"    system : {pct['system']:5.1f}%  ({s['system_chars']:,} chars)")
    print(f"    tools  : {pct['tools']:5.1f}%  ({s['tools_chars']:,} chars)")
    print(f"    history: {pct['history']:5.1f}%  ({s['history_chars']:,} chars)")
    if args.turns:
        print("  --- 호출별 ---")
        print(f"  {'turn':>4} {'in_tok':>8} {'out_tok':>8} "
              f"{'sys':>8} {'tools':>8} {'hist':>9}")
        for t in s["turns"]:
            print(f"  {t['turn_seq']:>4} {t['input_tokens']:>8,} "
                  f"{t['output_tokens']:>8,} {t['system_chars']:>8,} "
                  f"{t['tools_chars']:>8,} {t['history_chars']:>9,}")
    return 0


# ============================================================
# Ad-hoc task (DB 무시)
# ============================================================

def main(argv: list[str] | None = None) -> int:
    _load_env_once()
    try:
        from secu_agent.plugins import load_plugins
        load_plugins()
    except Exception as e:  # noqa: BLE001 — fail-loud: plugin 깨진 채 진행 금지
        print(f"[secu-agent] plugin 로드 실패 (SA_PLUGINS): {e}", file=sys.stderr)
        return 2
    p = argparse.ArgumentParser(prog="secu-agent")
    sub = p.add_subparsers(dest="cmd", required=True)

    # chat (v3.82 U4): 터미널 대화형 REPL
    from secu_agent.agent.chat_repl import add_subparser as _add_chat
    _add_chat(sub)

    # task (v3.83): 등록된 TaskPlan 을 다단 phase fan-out 으로 구동
    from secu_agent.agent.task_cli import add_subparser as _add_task
    _add_task(sub)

    # token usage (v3.62 Q5)
    tk = sub.add_parser("tokens", help="세션 LLM 토큰/세그먼트 계측 요약")
    tk.add_argument("session_id", type=int, help="chat_session id")
    tk.add_argument("--json", action="store_true", help="machine-readable JSON 출력")
    tk.add_argument("--turns", action="store_true", help="호출별 상세 행 출력")

    # runtime doctor
    dr = sub.add_parser("doctor", help="런타임 사전 점검 (Linux/bootstrap)")
    dr.add_argument("--json", action="store_true", help="machine-readable JSON 출력")

    # eval harness — 시나리오 회귀
    from secu_agent.agent.eval.cli import add_subparser as _add_eval
    _add_eval(sub)

    # web (frontend)
    wb = sub.add_parser("web", help="FastAPI + HTML 뷰어 (uvicorn)")
    wb.add_argument("--host", default=os.environ.get("SA_WEB_HOST", "127.0.0.1"))
    wb.add_argument("--port", type=int,
                    default=int(os.environ.get("SA_WEB_PORT", "8765")))
    wb.add_argument("--reload", action="store_true", help="dev: uvicorn reload")

    # mcp (v3.41-A1): secu-agent MCP server — 우리 read-only 도구 노출
    mc = sub.add_parser("mcp", help="MCP server / client (Model Context Protocol)")
    mc_sub = mc.add_subparsers(dest="mcp_action", required=True)
    mc_serve = mc_sub.add_parser("serve", help="MCP server 띄우기")
    mc_serve.add_argument(
        "--transport", choices=("stdio", "http"), default="stdio",
        help="stdio (claude desktop / inspector) 또는 http (Streamable HTTP)",
    )
    mc_serve.add_argument("--host", default="127.0.0.1",
                          help="http transport 만 사용")
    mc_serve.add_argument("--port", type=int, default=8770,
                          help="http transport 만 사용")

    # knox-bridge (v3.73): Knox 메신저 ↔ ChatSession 양방향 브릿지
    kb = sub.add_parser(
        "knox-bridge", help="Knox 메신저 브릿지 (chatroom ↔ ChatSession)")
    kb.add_argument(
        "--rooms", default=None,
        help="방 설정 yaml (기본 config/knox_rooms.yaml / SA_KNOX_ROOMS_PATH)")
    kb.add_argument(
        "--daemon", default=None,
        help="Knox 데몬 base url (기본 KM_DAEMON / http://127.0.0.1:8771)")
    kb.add_argument(
        "--verbose", action="store_true", help="tool 시작도 방에 표시")

    # skill scaffold / lint (v3.81 T3)
    sk = sub.add_parser("skill", help="skill 보일러플레이트 생성 + lint")
    sk_sub = sk.add_subparsers(dest="skill_action", required=True)
    sk_new = sk_sub.add_parser("new", help="directory skill scaffold 생성")
    sk_new.add_argument("name", help="skill 이름 (^[a-z0-9][a-z0-9_]+$)")
    sk_new.add_argument("--dir", required=True,
                        help="생성할 skills 디렉토리 (외부 skill repo 경로)")
    sk_new.add_argument("--domain", default="core")
    sk_new.add_argument("--description", default="")
    sk_new.add_argument("--when-to-use", default="")
    sk_new.add_argument("--triggers", default="",
                        help="comma 구분 trigger 키워드 (re:<regex> 가능)")
    sk_lint = sk_sub.add_parser(
        "lint", help="skills 정적 검사 — loader silent skip 전수 가시화")
    sk_lint.add_argument(
        "--dirs", default=None,
        help="검사할 디렉토리 (comma). 생략 = 코어 + SA_SKILLS_DIRS")

    args = p.parse_args(argv)
    if args.cmd == "chat":
        from secu_agent.agent.chat_repl import run_chat
        return asyncio.run(run_chat(args))
    if args.cmd == "task":
        _load_env_once()
        from secu_agent.agent.task_cli import run_task
        return asyncio.run(run_task(args))
    if args.cmd == "tokens":
        return _cmd_tokens(args)
    if args.cmd == "doctor":
        _load_env_once()
        return _cmd_doctor(args)
    if args.cmd == "web":
        return _cmd_web(args)
    if args.cmd == "eval":
        from secu_agent.agent.eval.cli import run_from_args as _eval_run
        return _eval_run(args)
    if args.cmd == "mcp":
        _load_env_once()
        return _cmd_mcp(args)
    if args.cmd == "knox-bridge":
        _load_env_once()
        return asyncio.run(_cmd_knox_bridge(args))
    if args.cmd == "skill":
        return _cmd_skill(args)
    return 1


def _cmd_skill(args: argparse.Namespace) -> int:
    """v3.81 T3: skill scaffold / lint."""
    from pathlib import Path

    if args.skill_action == "new":
        from secu_agent.agent.skills.scaffold import scaffold_skill
        triggers = tuple(
            t.strip() for t in (args.triggers or "").split(",") if t.strip()
        )
        try:
            target = scaffold_skill(
                args.dir, name=args.name, domain=args.domain,
                description=args.description, when_to_use=args.when_to_use,
                triggers=triggers,
            )
        except ValueError as e:
            print(f"[skill] 생성 실패: {e}", file=sys.stderr)
            return 1
        print(f"[skill] 생성됨: {target}")
        print("  - SKILL.md 본문 + api/schema/snippets/safety.md stub 채우기")
        print("  - 로드 확인: SA_SKILLS_DIRS 에 dir 추가 후 "
              "`secu-agent skill lint`")
        print("  - skill 선택 시 기본 unlock 도구는 plugin 부트스트랩에서 "
              "register_skill_unlock_tools(name, tools) 로 등록")
        return 0

    # lint
    from secu_agent.agent.skills.scaffold import lint_skills
    dirs = None
    if args.dirs:
        dirs = [Path(p.strip()) for p in args.dirs.split(",") if p.strip()]
    issues = lint_skills(dirs)
    errors = [i for i in issues if i.severity == "error"]
    for issue in issues:
        print(str(issue))
    print(f"[skill] lint: error {len(errors)} / warn {len(issues) - len(errors)}")
    return 1 if errors else 0


async def _cmd_knox_bridge(args: argparse.Namespace) -> int:
    """Knox 데몬(8771)에 붙어 chatroom 메시지로 점검 세션을 구동. Ctrl-C 로 종료."""
    from secu_agent.knox.bridge import KnoxBridge
    from secu_agent.knox.client import KnoxDaemonClient
    from secu_agent.knox.config import load_config

    config = load_config(args.rooms)
    if config.is_empty():
        print("[knox] 허용 설정이 비어 있음 — config/knox_rooms.yaml (또는 "
              "SA_KNOX_ROOMS_PATH) 에 allowed_singleids 또는 rooms 를 설정하라",
              file=sys.stderr)
        return 1

    client = KnoxDaemonClient(base_url=args.daemon)
    try:
        h = await client.health()
        print(f"[knox] daemon ok: {client.base_url} "
              f"(uptime {h.get('uptime_s', '?')}s)", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print(f"[knox] daemon 연결 실패 {client.base_url}: {e}", file=sys.stderr)
        await client.aclose()
        return 1

    # MCP 도구(wiki/ticket/splunk/...)를 이 프로세스에도 connect+register — web 과 동일.
    # 브릿지 agent 가 web 챗과 같은 도구셋을 쓰게 한다(별개 프로세스라 따로 bootstrap 필요).
    try:
        from secu_agent.mcp.state import bootstrap_from_yaml
        n = await bootstrap_from_yaml()
        print(f"[knox] mcp tools registered: {n}", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print(f"[knox] mcp bootstrap failed: {e}", file=sys.stderr)

    own = os.environ.get("KNOX_OWN_SINGLEID")
    timeout = float(os.environ.get("SA_KNOX_APPROVAL_TIMEOUT", "300"))
    verbose = args.verbose or os.environ.get("SA_KNOX_VERBOSE") in ("1", "true", "True")
    bridge = KnoxBridge(
        client=client, config=config, own_singleid=own,
        approval_timeout=timeout, verbose=verbose,
    )
    scope = (f"global={sorted(config.allowed_singleids)}"
             if config.allowed_singleids else f"rooms={sorted(config.rooms)}")
    print(f"[knox] bridge up — {scope} own={own} db={state.db_label()}",
          file=sys.stderr)
    try:
        await bridge.run()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await bridge.aclose()
        await client.aclose()
        try:
            from secu_agent.mcp.state import shutdown_mcp
            await shutdown_mcp()
        except Exception:  # noqa: BLE001
            pass
    return 0


def _cmd_mcp(args: argparse.Namespace) -> int:
    """v3.41-A1: secu-agent MCP server."""
    from secu_agent.mcp.server import build_mcp_server

    server = build_mcp_server()
    if args.mcp_action == "serve":
        if args.transport == "stdio":
            print("[mcp] stdio transport — handshake on stdin/stdout",
                  file=sys.stderr)
            asyncio.run(server.run_stdio_async())
            return 0
        # http
        print(f"[mcp] streamable http http://{args.host}:{args.port}/mcp  "
              f"(db: {state.db_label()})", file=sys.stderr)
        server.settings.host = args.host
        server.settings.port = args.port
        asyncio.run(server.run_streamable_http_async())
        return 0
    return 1


def _cmd_doctor(args: argparse.Namespace) -> int:
    from secu_agent import runtime_doctor

    report = runtime_doctor.run_doctor()
    if args.json:
        print(runtime_doctor.render_json(report))
    else:
        print(runtime_doctor.render_text(report))
    return 0 if report.ok else 1


def _cmd_web(args: argparse.Namespace) -> int:
    """uvicorn으로 web/app.py 띄움. SECU_AGENT_DB 환경변수 그대로 사용."""
    import uvicorn
    print(f"[web] http://{args.host}:{args.port}  (db: {state.db_label()})",
          file=sys.stderr)
    uvicorn.run(
        "secu_agent.web.app:create_app",
        host=args.host, port=args.port,
        factory=True, reload=args.reload,
        log_level="info",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
