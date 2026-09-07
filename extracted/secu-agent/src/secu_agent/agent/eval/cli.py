"""eval 명령 진입점 — `secu-agent eval` subcommand 가 호출.

CLI 흐름:
  secu-agent eval                          # 패키지 내 모든 시나리오 실행
  secu-agent eval --scenario NAME          # 이름 1개만
  secu-agent eval --dir path/to/scenarios  # 외부 디렉토리

종료 코드: 모두 통과 0, 1개라도 실패 1.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import tempfile
from pathlib import Path

from secu_agent.agent.eval.runner import run_scenario
from secu_agent.agent.eval.scenario import (
    Scenario,
    load_scenario,
    load_scenarios_dir,
)
from secu_agent.agent.eval.scoring import score_scenario


def default_scenarios_dir() -> Path:
    return Path(__file__).parent / "scenarios"


async def _run_one(s: Scenario, *, evidence_dir: Path) -> tuple[Scenario, bool, str]:
    try:
        result = await run_scenario(s, evidence_dir=evidence_dir)
    except Exception as e:  # noqa: BLE001
        return s, False, f"[FAIL] {s.name}\n  - runner exception: {type(e).__name__}: {e}"
    report = score_scenario(result, s.expectations)
    return s, report.passed, report.format_summary()


async def _run_all(scenarios: list[Scenario]) -> int:
    with tempfile.TemporaryDirectory(prefix="th_eval_") as td:
        evidence_dir = Path(td)
        ran = await asyncio.gather(*(
            _run_one(s, evidence_dir=evidence_dir / s.name) for s in scenarios
        ))
    passed = sum(1 for _, ok, _ in ran if ok)
    failed = len(ran) - passed
    for _, _, line in ran:
        print(line)
    print(f"\n총 {len(ran)}건: {passed} pass, {failed} fail")
    return 0 if failed == 0 else 1


def add_subparser(sub: argparse._SubParsersAction) -> None:
    ev = sub.add_parser("eval", help="eval harness — 시나리오 회귀 실행")
    ev.add_argument("--scenario", help="시나리오 이름 1개만 실행 (예: smoke_greeting)")
    ev.add_argument("--dir", help="시나리오 디렉토리 (기본: 패키지 내 scenarios/)")
    ev.add_argument("--file", help="단일 시나리오 YAML 경로 (디렉토리 무시)")


def run_from_args(args: argparse.Namespace) -> int:
    scenarios: list[Scenario]
    if args.file:
        scenarios = [load_scenario(Path(args.file))]
    else:
        d = Path(args.dir) if args.dir else default_scenarios_dir()
        if not d.is_dir():
            print(f"[eval] no such directory: {d}", file=sys.stderr)
            return 1
        scenarios = load_scenarios_dir(d)
        if args.scenario:
            scenarios = [s for s in scenarios if s.name == args.scenario]
            if not scenarios:
                print(f"[eval] scenario not found: {args.scenario}", file=sys.stderr)
                return 1
    if not scenarios:
        print(f"[eval] no scenarios", file=sys.stderr)
        return 1
    return asyncio.run(_run_all(scenarios))
