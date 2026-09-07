"""v3.18 라이브 검증 — ai-sandbox 실제 microVM 호출 end-to-end.

사용:
  AI_SANDBOX_DIR=~/project/ai-sandbox .venv/bin/python scripts/verify_v3_18_live.py --stage 1
  AI_SANDBOX_DIR=~/project/ai-sandbox .venv/bin/python scripts/verify_v3_18_live.py --stage 2 [--timeout 300]

단계:
  1: config detection (subprocess 안 띄움) — AI_SANDBOX_DIR + scripts/restore_snapshot.sh 인지.
  2: 실제 VM 부팅 + analyze_package.sh 호출 (작은 가짜 패키지). VM 자원 사용.

단계 2 입력:
  - 임시 디렉토리 만들어서 hello.py 1개. analyze_package.sh 가 디렉토리 받으면
    호스트가 tar 묶어 VM 에 push. 가짜 파이썬 함수만 — 외부 통신 없음.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import tempfile
import time
from pathlib import Path

# 프로젝트 root 를 sys.path 에 넣어 직접 import 가능하게.
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "src"))

from secu_agent.sandbox import (
    AiSandboxRunner,
    SandboxConfig,
    SandboxDisabledError,
)


def _stage_config_check() -> int:
    print("=" * 60)
    print("[stage 1] SandboxConfig.from_env() 검사")
    print("=" * 60)
    raw = os.environ.get("AI_SANDBOX_DIR")
    print(f"AI_SANDBOX_DIR={raw!r}")

    cfg = SandboxConfig.from_env()
    print(f"sandbox_dir={cfg.sandbox_dir}")
    print(f"enabled={cfg.enabled}")
    if not cfg.enabled:
        print(f"disabled_reason: {cfg.disabled_reason}")
        return 2

    sandbox_dir = cfg.sandbox_dir
    assert sandbox_dir is not None
    print(f"\n주요 스크립트 존재 체크:")
    for s in ("restore_snapshot.sh", "analyze_package.sh", "launch_vm.sh", "stop_all.sh"):
        path = sandbox_dir / "scripts" / s
        mark = "OK" if path.is_file() else "MISSING"
        print(f"  {mark}: scripts/{s}")
    env_file = sandbox_dir / ".env"
    print(f"  {'OK' if env_file.is_file() else 'MISSING'}: .env")
    print("\n→ stage 1 PASS. stage 2 진행 가능.")
    return 0


def _make_fake_package(tmp_root: Path) -> Path:
    pkg = tmp_root / "fake_pkg"
    pkg.mkdir(parents=True, exist_ok=True)
    # 매번 다른 marker 박아 캐시 miss 강제 — pipeline 경로 검증.
    marker = int(time.time() * 1000)
    (pkg / "hello.py").write_text(
        f"# marker={marker}\ndef hello():\n    return 'hi from fake_pkg'\n",
        encoding="utf-8",
    )
    (pkg / "setup.py").write_text(
        "from setuptools import setup\nsetup(name='fake_pkg', version='0.0.1', py_modules=['hello'])\n",
        encoding="utf-8",
    )
    return pkg


async def _stage_real_run(timeout_sec: float, evidence_root: Path) -> int:
    print("=" * 60)
    print(f"[stage 2] AiSandboxRunner.run() — 실제 microVM (timeout={timeout_sec}s)")
    print("=" * 60)

    cfg = SandboxConfig.from_env()
    if not cfg.enabled:
        print(f"sandbox disabled: {cfg.disabled_reason}")
        return 2

    with tempfile.TemporaryDirectory(prefix="th_v318_") as tmp:
        tmp_root = Path(tmp)
        pkg_dir = _make_fake_package(tmp_root)
        evidence_dir = evidence_root / f"v3_18_live_{int(time.time())}"
        evidence_dir.mkdir(parents=True, exist_ok=True)
        print(f"input package: {pkg_dir}")
        print(f"evidence_dir: {evidence_dir}\n")

        runner = AiSandboxRunner(config=cfg)
        start = time.monotonic()
        try:
            result = await runner.run(
                file_path=pkg_dir,
                command="analyze_package",  # 현재 어댑터 가 무시 (분석은 자동)
                timeout_sec=timeout_sec,
                evidence_dir=evidence_dir,
            )
        except SandboxDisabledError as e:
            print(f"SandboxDisabledError: {e}")
            return 2
        except Exception as e:  # noqa: BLE001
            print(f"runner raised: {type(e).__name__}: {e}")
            return 3

        elapsed = time.monotonic() - start
        print(f"--- 완료 ({elapsed:.1f}s) ---")
        print(f"exit_code={result.exit_code}")
        print(f"duration_sec={result.duration_sec:.2f}")
        print(f"timed_out={result.timed_out}")
        print(f"cancelled={result.cancelled}")
        print(f"stdout_len={len(result.stdout)}")
        print(f"stderr_len={len(result.stderr)}")
        print(f"result_dir={result.result_dir}")
        if result.verdict:
            print(f"\n--- verdict (v3.18.1 통합) ---")
            print(f"risk_level={result.verdict.get('risk_level')}")
            print(f"confidence={result.verdict.get('confidence')}")
            paths = result.verdict.get('evidence_paths') or []
            print(f"evidence_paths ({len(paths)}):")
            for p in paths[:5]:
                print(f"  - {p}")
        else:
            print("verdict=None")
        print(f"\n--- stdout (앞 1200) ---")
        print(result.stdout[:1200])
        if result.stderr:
            print(f"\n--- stderr (앞 800) ---")
            print(result.stderr[:800])

        # ai-sandbox 결과는 sandbox_dir/results/<basename>_<ts>/ 로 떨어짐
        assert cfg.sandbox_dir is not None
        results_root = cfg.sandbox_dir / "results"
        if results_root.is_dir():
            recent = sorted(
                (p for p in results_root.iterdir() if p.is_dir()),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )[:1]
            if recent:
                print(f"\n--- ai-sandbox result dir (most recent) ---")
                print(recent[0])
                for f in sorted(recent[0].rglob("*"))[:30]:
                    print(f"  {f.relative_to(recent[0])}")

        return 0 if result.exit_code == 0 and not result.timed_out else 4


def main() -> int:
    parser = argparse.ArgumentParser(description="v3.18 ai-sandbox live verification")
    parser.add_argument("--stage", type=int, choices=[1, 2], default=1)
    parser.add_argument("--timeout", type=float, default=300.0,
                        help="stage 2 timeout (sec). 보수적으로 300+.")
    parser.add_argument("--evidence-root", type=Path,
                        default=Path.home() / ".cache" / "secu-agent" / "verify")
    args = parser.parse_args()

    if args.stage == 1:
        return _stage_config_check()
    return asyncio.run(_stage_real_run(args.timeout, args.evidence_root))


if __name__ == "__main__":
    sys.exit(main())
