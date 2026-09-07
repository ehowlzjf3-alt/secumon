"""GitHub 스캔 패스 — repo 큐를 **에이전트 워커**에 하나씩 맡긴다.

## 2026-08-27: 결정론 경로를 지웠다

여기 있던 `_handle_target()` 은 `scanner.scan_repo_target()` 을 직접 불러
`core_state.finding_upsert()` 로 finding 을 썼다. **LLM 이 한 번도 안 돌았다.**
그 경로가 오늘까지 github finding 27,414건을 만들었고, 판정을 안 거쳤으므로
`high_entropy_string` 6,850건 같은 것이 그대로 등록됐다.

요구가 바뀌었다: **모든 finding 은 등록 전에 LLM 판정을 타야 한다**(사용자 결정).
그래서 이 패스는 이제 스캔을 **직접 하지 않는다** — 워커(`github_scan_worker`)를
띄우고, 워커 안의 에이전트가 스캔·판단·제출·종료를 한다.

## ⚠️ 패스는 반드시 끝나야 한다

예전 `while True` 는 큐가 빌 때까지 돌았다. repo 22,207개 큐에서 그건 **끝나지 않는
루프**였고, 실제로 08-25 18:54 에 뜬 패스가 1.5일 뒤에도 `running` 이었다.
`control_flag` 는 패스를 **시작할 때만** 검사하므로, 그 사이 플래그를 0으로 내려도
아무 일도 일어나지 않았다 — "꺼져 있는데 왜 도나" 의 정체다.

이제 한 패스는 `GITHUB_SCAN_BATCH_SIZE` 만큼만 처리하고 끝낸다. 다음 배치는 다음 틱이
가져간다 — 그래야 플래그·간격이 실제로 듣는다.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from domains.services.github.application.contracts import (
    GITHUB_SCAN_PLAN,
    COMPONENT_GITHUB_SCAN,
    GITHUB_SCAN_SESSION_ID,
    GITHUB_SCAN_SKILL,
    PHASE_GITHUB_SCAN,
)
from service import state_domain as state
from service.agents import runtime
from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.github_scan")


def _int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _worker_env(repo_root: Path) -> dict[str, str]:
    """워커 서브프로세스 env — `lead_agent._worker_env` 와 같은 규격.

    ⚠️ 규격을 여기서 새로 만들지 않는다. PYTHONPATH 에 엔진 src 가 빠지면 워커가
      `secu_agent` 를 못 찾고, 그 실패는 "스캔 결과 0건" 처럼 보인다.
    """
    engine = Path(os.environ.get("SA_ENGINE_DIR", str(Path.home() / "project" / "secu-agent")))
    env = dict(os.environ)
    parts = [str(engine / "src"), str(repo_root)]
    if os.environ.get("PYTHONPATH"):
        parts.append(os.environ["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(parts)
    env["SA_ENGINE_DIR"] = str(engine)
    env.setdefault("SA_PLUGINS", str(repo_root / "plugin" / "bootstrap.py"))
    return env


def _spawn_worker(target: dict[str, Any], *, charter_ref: str) -> dict[str, Any]:
    """repo 하나를 워커 프로세스에 맡긴다. 판정은 **워커 안의 에이전트**가 한다.

    ★ 여기서 큐를 닫지 않는다. 종료 도구(`github_repo_set_status`)는 워커 계약의
      필수 항목이고, 못 부르면 그건 실패로 남아야 한다 — 러너가 대신 닫아 주면
      "에이전트가 판단했다" 는 기록이 거짓이 된다.
    """
    repo = str(target.get("repo") or "")
    ev_dir = runtime.make_evidence_dir(f"github-scan-{repo}")
    (ev_dir / "task_spec.json").write_text(json.dumps({
        "task_id": f"github-scan-{target.get('id')}-{repo}",
        "task_type": GITHUB_SCAN_PLAN,
        "skill": GITHUB_SCAN_SKILL,
        "skill_resource": "worker.md",
        "charter_ref": charter_ref,
        "target": target,
    }, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    repo_root = Path(__file__).resolve().parents[2]
    argv = [sys.executable, "-m", "service.agents.github_scan_worker", str(ev_dir)]
    timeout = _int_env("GITHUB_SCAN_WORKER_TIMEOUT_SEC", 1800)
    try:
        with (ev_dir / "stderr.log").open("wb") as err:
            proc = subprocess.run(  # noqa: S603
                argv, cwd=str(repo_root), env=_worker_env(repo_root),
                stdout=subprocess.DEVNULL, stderr=err, timeout=timeout, check=False)
        rc = proc.returncode
    except subprocess.TimeoutExpired:
        rc = None
        log.warning("[github-scan] repo=%s 가 %ss 를 넘겨 강제 종료됐다", repo, timeout)

    # ★ 판정은 worker_result.json 으로만 한다. rc 는 워커가 죽어도 0 일 수 있다.
    try:
        wr = json.loads((ev_dir / "worker_result.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        wr = None
    if wr is None:
        return {"target_id": int(target["id"]), "status": "error", "finding_count": 0,
                "reason": f"worker_result.json 없음 (rc={rc})", "evidence_dir": str(ev_dir)}
    return {
        "target_id": int(target["id"]),
        "status": "ok" if str(wr.get("status") or "") == "ok" else "error",
        "finding_count": int(wr.get("findings") or wr.get("findings_count") or 0),
        "reason": str(wr.get("summary") or "")[:500],
        "evidence_dir": str(ev_dir),
    }


def _release_if_still_claimed(target: dict[str, Any], reason: str) -> None:
    """워커가 종료 도구를 못 불렀을 때 **claim 만** 푼다.

    ⚠️ 여기서 상태를 판단하지 않는다 — 워커가 못 본 것을 러너가 `tasked` 로 닫으면
      "봤다" 는 거짓 기록이 된다. `error` 로만 되돌린다.
    """
    try:
        state.github_repo_target_set_status(
            int(target["id"]), "error", finding_count=0, last_reason=str(reason)[:500])
    except Exception:  # noqa: BLE001
        log.exception("[github-scan] claim 해제 실패 target=%s", target.get("id"))


def run_scan_pass(
    *,
    max_repos: int | None = None,
    batch_size: int | None = None,
    charter_ref: str = "",
) -> dict[str, Any]:
    load_runtime_env(load_plugins=False)
    component = COMPONENT_GITHUB_SCAN
    state.heartbeat_upsert(component, phase=PHASE_GITHUB_SCAN, pid=os.getpid())
    run_id = state.pipeline_run_start(component)
    claimed = scanned = findings = errors = 0
    detail = ""
    status = "ok"
    limit = batch_size or _int_env("GITHUB_SCAN_BATCH_SIZE", 3)
    try:
        state.github_repo_reclaim_stale_claims()
        # ⚠️ **한 배치만**. 예전 `while True` 는 큐가 빌 때까지 돌아 패스가 끝나지 않았고,
        #    그래서 control_flag 가 아무 효력이 없었다(위 모듈 주석 참조).
        take = limit if max_repos is None else max(1, min(limit, max_repos))
        targets = state.github_repo_target_claim_next(
            session_id=GITHUB_SCAN_SESSION_ID, limit=take)
        for target in targets:
            claimed += 1
            repo = target.get("repo")
            state.heartbeat_upsert(component, phase=PHASE_GITHUB_SCAN,
                                   detail=str(repo), pid=os.getpid())
            try:
                result = _spawn_worker(target, charter_ref=charter_ref)
                scanned += 1
                findings += int(result.get("finding_count") or 0)
                if result.get("status") == "error":
                    errors += 1
                    # 워커가 종료 도구를 못 불렀으면 claim 이 묶인 채 남는다 — 그것만 푼다.
                    _release_if_still_claimed(target, result.get("reason") or "")
            except Exception as e:  # noqa: BLE001
                errors += 1
                log.warning("[github-scan] repo=%s failed: %r", repo, e)
                _release_if_still_claimed(target, repr(e)[:500])
        detail = f"claimed={claimed} scanned={scanned} findings={findings} errors={errors}"
        return {"claimed": claimed, "scanned": scanned, "findings": findings, "errors": errors}
    except Exception as e:  # noqa: BLE001
        status = "error"
        detail = repr(e)[:500]
        raise
    finally:
        state.heartbeat_upsert(component, phase="idle" if status == "ok" else "error", detail=detail, pid=os.getpid())
        state.pipeline_run_finish(run_id, status=status, detail=detail)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="GitHub E2E repo scan agent")
    parser.add_argument("--max-repos", type=int, default=None)
    parser.add_argument("--batch-size", type=int, default=None)
    parser.add_argument(
        "--charter",
        default=os.environ.get("DEFAULT_CHARTER_REF", "SECOPS-2026-001"),
    )
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=os.environ.get("GITHUB_AGENT_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    res = run_scan_pass(
        max_repos=args.max_repos,
        batch_size=args.batch_size,
        charter_ref=args.charter,
    )
    log.info("[github-scan] pass done %s", res)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
