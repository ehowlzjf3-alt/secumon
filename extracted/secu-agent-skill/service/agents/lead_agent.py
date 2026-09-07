"""리드 패스 — 등록만 돼 있던 리드 층에 **심장**을 단다.

## 왜 이 파일이 필요했나

리드 층은 2026-08-21 에 완성됐다: 계약·도구 10개·마스킹 경계·어댑터 5개가 전부
`plugin/bootstrap.py:_register_lead_layer()` 에서 등록된다. 그런데 **그걸 기동하는
코드가 어디에도 없었다** (`service/agents/` 에 `*_lead*.py` 0개, 4도메인
`application/fanout.py` 에 리드 등록 0개). 손발은 다 있고 심장이 없었다.

## 왜 팬아웃 어댑터가 아닌가

팬아웃은 `claim N targets → 타깃 1개짜리 워커 N개 스폰` 모델이다. 리드는 그 반대다 —
**큐 전체를 보고 어디를 볼지 스스로 정하는 것**이 리드의 일이고(`list_targets` 는
claim 하지 않는다), 러너가 미리 골라 주면 그 판단이 사라진다. 그래서 러너는 리드
**프로세스 하나**를 띄우고 물러난다.

## 리드는 `run_agent` 로 못 띄운다

`runtime.run_agent()` 는 자기 하네스를 직접 짓는다. 리드 계약의 훅들 —
`build_client`(egress 캡처 래퍼)·`on_submit`/`on_no_submit`(세션 정리)·예산·
`agents_dir` 고정 — 은 **코어 워커 CLI 경로에서만** 발동한다. 그래서 검토원과 같은
방식으로, `task_spec.json` 을 쓰고 `python -m secu_agent.agent <dir>` 를 띄운다.

    러너 ──spawn──> 리드 (python -m secu_agent.agent, task_type=<domain>_lead)
                      └──spawn──> 검토원 세션 ×N (--serve)

## 성공 판정

`worker_result.json` **하나뿐이다.** 서브프로세스 rc 는 리드가 죽어도 0 이 될 수 있고,
반대로 큐를 안 닫고 끝나면 계약이 rc=3 을 준다(`_on_no_submit`). 둘 다 rc 만 봐서는
"판단이 남았나" 를 모른다.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.lead_agent")

# ── 도메인 → (리드 control_flag, 은퇴한 평면 태스크 컴포넌트) ──────────────
#
# ★ **태스크 큐의 시작점은 리드다.** 두 번째 값은 "경쟁자" 가 아니라 **은퇴한 것**이다.
#
#   예전:  러너 → claim N개 → 워커 N개 (타깃 1개씩)   ← 러너가 무엇을 볼지 정했다
#   지금:  러너 → 리드 1개 → 필요할 때 검토원 호출      ← 리드가 정한다
#
#   검토원과 평면 워커는 **같은 워커**다 — 같은 스킬(`skills/<d>_task/worker.md`), 같은
#   도구셋. 달랐던 건 누가 띄우느냐뿐이었고, 그래서 진입점이 둘일 이유가 없다.
#   러너가 미리 claim 해서 워커를 뿌리면 리드가 보기로 한 타깃을 가로챈다.
#
# ⚠️ 한때 "평면이 켜져 있으면 리드가 물러난다" 로 짰다가 뒤집었다(2026-08-26).
#    그건 시작점을 워커에 두는 것이라 방향이 반대였다. 우선순위는 한 방향뿐이다.
_LEADS: dict[str, tuple[str, str]] = {
    "smb":               ("smb.lead",               "task"),
    "dev_web":           ("dev_web.lead",           "dev_web_task"),
    "github":            ("github.lead",            "github.sso_task"),
    "confluence":        ("confluence.lead",        "confluence.space_task"),
    "confluence_search": ("confluence_search.lead", "confluence.search_task"),
}

# 은퇴한 평면 컴포넌트 → 그 큐를 가져간 리드 도메인.
_RETIRED_FLAT: dict[str, str] = {flat: d for d, (_c, flat) in _LEADS.items()}


def retired_flat_pass(component: str) -> dict[str, Any] | None:
    """평면 태스크 패스 진입점에서 부른다. 은퇴한 큐면 결과 dict, 아니면 None.

    ★ 러너가 아니라 **패스 함수 안**에 둔다. dev_web 은 셸 루프가 부르고
      (`scripts/dev_web_loop.sh`), 수동 CLI 로 부르는 경로도 있다 — 러너에만 걸면 샌다.

    ⚠️ 조용히 멈추지 않는다. heartbeat 를 갱신해 **살아 있으면서 큐를 넘겼다**는 것이
      콘솔에 보이게 한다. 아무것도 안 남기면 러너가 죽은 것처럼 보인다.

    ⚠️ **phase 는 `disabled` 다 — `retired` 가 아니다.** 콘솔의 phase 판정은
      allowlist 가 아니라 **denylist** 다: `activity_of_phase` 는 idle/disabled 집합에
      없는 non-empty 문자열을 전부 `active` 로 읽는다(digisecu-employee
      `gateway/src/digisecu_gateway/runtime_components.py:67-77`, "idle/disabled만
      명시, 그 외 non-empty phase = active"). 4개 도메인 투영도 같은 구조다.
      그래서 `retired` 를 쓰면 **은퇴한 레인이 콘솔에서 돌고 있는 것처럼 보인다** —
      이 함수가 막으려던 것과 정확히 반대다. 실측 2026-08-28: `dev_web_task` 가
      `phase=retired` 로 33시간째 얼어 있는 유령 카드였다.
      은퇴라는 사실은 **detail** 이 나른다. 콘솔 어휘를 늘리는 대신 있는 것을 쓴다.

    ⚠️ **control_flag 를 읽지 않는다.** `control_flag_get` 은 행이 없으면
      `enabled=1` 로 **만들어서** 돌려준다(`state_domain.py`) — 은퇴 가드가 그걸
      부르면 지운 레인을 되살리는 부작용이 생긴다. 은퇴 판정의 근거는
      `_RETIRED_FLAT` 하나면 충분하다.
    """
    domain = _RETIRED_FLAT.get(component)
    if domain is None:
        return None
    lead_component = _LEADS[domain][0]
    detail = (f"평면 태스크 레인은 은퇴했다 — 이 큐의 시작점은 {lead_component!r} 다. "
              f"켜기: control_flag {lead_component} enabled=1")
    # ⚠️ INFO 다. 폴링 주기가 60초라 WARNING 이면 컴포넌트당 하루 1,440줄이 쌓이고,
    #    그 소음이 진짜 경고를 덮는다. 은퇴는 정상 상태이지 경고가 아니다.
    log.info("[%s] %s", component, detail)
    try:
        from service import state_domain as state

        state.heartbeat_upsert(component, phase="disabled", detail=detail[:300],
                               pid=os.getpid())
    except Exception:  # noqa: BLE001 — 기록 실패가 은퇴 판정을 뒤집지 않는다
        log.exception("[%s] 은퇴 heartbeat 기록 실패", component)
    return {"component": component, "status": "retired",
            "lead_component": lead_component, "detail": detail}


# 사용자 결정(2026-08): "리드당 워커는 2개씩으로."
_DEFAULT_MAX_SESSIONS = 2

# 계약 기본 wall-clock 은 1800s. 서브프로세스 타임아웃은 그보다 **커야** 한다 —
# 같으면 예산이 자기 일(정상 종료 + 세션 정리)을 하기 전에 러너가 먼저 죽인다.
_SUBPROCESS_GRACE_SEC = 300


def lead_components() -> tuple[str, ...]:
    return tuple(c for c, _ in _LEADS.values())


def lead_domains() -> tuple[str, ...]:
    return tuple(_LEADS)


def _int_env(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _flag_on(component: str) -> bool:
    from service import state_domain as state

    flag = state.control_flag_get(component)
    return bool(flag and flag.get("enabled"))


def _pending_count(adapter: Any, *, limit: int) -> int:
    """리드를 띄울 값어치가 있는가. 상태 목록은 **어댑터가 준다**.

    ★ 여기서 상태를 통일하면 안 된다. 처음엔 `status="pending"` 하나로 물었는데,
      smb 의 판정대기는 `walked`/`listing_reviewed` 라 리드가 영원히 idle 이었다
      (2026-08-26 컷오버 첫 사이클에서 잡혔다). 큐에 일이 있는데 "깨끗함" 으로 읽혔다.

    ⚠️ 이건 근사치다 — 실제 claim 은 주기(`cycle_key`·`last_task_at`)까지 본다.
      무엇이 지금 due 인지는 리드가 `list_targets` 로 보고 판단하고, 여기서는
      **테이블이 비었나** 만 거른다. 비용 통제는 probe 가 아니라 간격이다.
    """
    wanted = tuple(getattr(adapter, "claimable_statuses", ()) or ())
    if not wanted:
        log.warning("[lead] %s 어댑터에 claimable_statuses 가 없다 — 큐 판정 생략",
                    getattr(adapter, "domain", "?"))
        return -1
    total = 0
    for status in wanted:
        try:
            total += len(adapter.list_targets(status=status, limit=limit))
        except Exception as e:  # noqa: BLE001
            # 못 세는 것과 0건은 다르다 — 0 으로 뭉개면 "큐가 비었다" 로 조용히 읽힌다.
            log.warning("[lead] %s 큐 조회 실패(status=%s): %r", adapter.domain, status, e)
            return -1
        if total >= limit:
            break
    return total


def _build_spec(domain: str, *, charter_ref: str, goal: str) -> dict[str, Any]:
    return {
        "task_id": f"{domain}-lead-{int(time.time())}",
        "task_type": f"{domain}_lead",
        "charter_ref": charter_ref,
        # ★ `target_ids` 를 주지 않는다. 어디를 볼지 고르는 것이 리드의 일이다 —
        #   러너가 골라 주면 리드가 전달자가 된다(Phase 2 에서 겪은 실패 양상).
        "target": {"goal": goal},
    }


def _worker_env(repo: Path) -> dict[str, str]:
    """리드 서브프로세스 env — 도메인 워커와 같은 규격(`infrastructure/runtime.py`)."""
    engine = Path(os.environ.get("SA_ENGINE_DIR", str(Path.home() / "project" / "secu-agent")))
    env = dict(os.environ)
    py_parts = [str(engine / "src"), str(repo)]
    if os.environ.get("PYTHONPATH"):
        py_parts.append(os.environ["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(py_parts)
    env["SA_ENGINE_DIR"] = str(engine)
    env.setdefault("SA_PLUGINS", str(repo / "plugin" / "bootstrap.py"))
    # 검토원 동시 세션 수. 리드가 이 값을 넘겨 열려 하면 도구가 오류가 아니라
    # `{"opened": false, …}` 로 답한다(엔진 repeat-error 가드에 안 걸리게).
    env.setdefault("SA_LEAD_MAX_SESSIONS", str(_DEFAULT_MAX_SESSIONS))
    return env


def _read_worker_result(evidence_dir: Path) -> dict[str, Any] | None:
    try:
        got = json.loads((evidence_dir / "worker_result.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return got if isinstance(got, dict) else None


def run_lead_pass(
    domain: str,
    *,
    charter_ref: str = "",
    goal: str = "",
    max_pending_probe: int = 1,
    timeout_sec: int | None = None,
) -> dict[str, Any]:
    """한 도메인의 리드를 **한 번** 돌린다. 팬아웃 없음 — 프로세스 하나."""
    if domain not in _LEADS:
        raise ValueError(f"등록되지 않은 리드 도메인: {domain!r} (있는 것: {list(_LEADS)})")
    component, retired_flat = _LEADS[domain]

    load_runtime_env(load_plugins=True)      # 어댑터 등록이 이 프로세스에도 필요하다
    from service import state_domain as state

    from _shared.lead_adapter import get_lead_adapter

    state.heartbeat_upsert(component, phase="lead", pid=os.getpid())
    run_id = state.pipeline_run_start(component)
    status = "ok"
    detail = ""
    out: dict[str, Any] = {"domain": domain, "component": component}
    try:
        # ★ 리드는 **물러나지 않는다.** 태스크 큐의 시작점이 리드이기 때문이다.
        #   은퇴한 평면 플래그가 아직 켜져 있어도 그건 운영 잔재이지 경쟁이 아니다 —
        #   평면 패스 쪽이 `retired_flat_pass()` 로 스스로 멈춘다. 다만 사람이 그 상태를
        #   모르고 있을 수 있으니 말은 한다.
        if _flag_on(retired_flat):
            log.warning("[lead] %s: 은퇴한 평면 플래그 %r 가 아직 켜져 있다 — "
                        "동작엔 영향 없지만(평면 패스가 스스로 멈춘다) 꺼두는 게 맞다",
                        domain, retired_flat)
            out["stale_flat_flag"] = retired_flat

        adapter = get_lead_adapter(domain)
        if adapter is None:
            raise RuntimeError(f"리드 어댑터 미등록: {domain!r} — plugin bootstrap 확인")

        pending = _pending_count(adapter, limit=max_pending_probe)
        if pending == 0:
            status = "ok"
            detail = "pending 타깃 0건 — 리드를 띄우지 않는다"
            out.update(status="idle", pending=0)
            return out

        # ── 리드 프로세스 하나 ────────────────────────────────────────
        from service.agents import runtime

        repo = Path(__file__).resolve().parents[2]
        ev_dir = runtime.make_evidence_dir(f"{domain}-lead")
        (ev_dir / "task_spec.json").write_text(
            json.dumps(_build_spec(domain, charter_ref=charter_ref, goal=goal),
                       ensure_ascii=False, indent=2),
            encoding="utf-8")

        engine = Path(os.environ.get("SA_ENGINE_DIR", str(Path.home() / "project" / "secu-agent")))
        argv = [sys.executable, "-m", "secu_agent.agent", str(ev_dir),
                "--profile", str(engine / "config" / "llm_profiles.yaml")]
        # ★ 기본값을 여기서 **다시 적지 않는다**. 예전엔 1800 을 하드코딩해 뒀는데,
        #   계약(`lead_contract.build_lead_contract`)의 기본이 바뀌어도 여기가 안 따라와서
        #   "계약은 무제한인데 러너가 2100s 에 죽이는" 상태가 된다 — 진실이 둘이 된다.
        from _shared.lead_contract import lead_wall_sec_default

        wall = _int_env("SA_LEAD_MAX_WALL_SEC", lead_wall_sec_default())
        limit = timeout_sec or _int_env("SA_LEAD_SUBPROCESS_TIMEOUT_SEC",
                                        wall + _SUBPROCESS_GRACE_SEC)
        log.info("[lead] %s 기동 — evidence=%s timeout=%ss", domain, ev_dir, limit)
        state.heartbeat_upsert(component, phase="lead", detail=str(ev_dir), pid=os.getpid())

        started = time.monotonic()
        try:
            with (ev_dir / "stderr.log").open("wb") as err:
                proc = subprocess.run(  # noqa: S603
                    argv, cwd=str(repo), env=_worker_env(repo),
                    stdout=subprocess.DEVNULL, stderr=err, timeout=limit, check=False)
            rc = proc.returncode
        except subprocess.TimeoutExpired:
            rc = None
            log.warning("[lead] %s 가 %ss 를 넘겨 강제 종료됐다", domain, limit)

        elapsed = round(time.monotonic() - started, 1)
        # ★ 판정은 worker_result.json 으로만 한다. rc 는 리드가 죽어도 0 일 수 있고,
        #   큐를 안 닫고 끝나면 계약이 rc=3 을 준다 — rc 만 보면 둘을 구분 못 한다.
        wr = _read_worker_result(ev_dir)
        out.update(evidence_dir=str(ev_dir), rc=rc, elapsed_sec=elapsed, pending=pending)
        if wr is None:
            status = "error"
            detail = f"worker_result.json 없음 (rc={rc}) — 리드가 결과를 못 쓰고 끝났다"
            out.update(status="error_crash")
        else:
            out.update(status=wr.get("status"), turns=wr.get("turns_used"),
                       summary=str(wr.get("summary") or "")[:300],
                       completion_reason=wr.get("completion_reason"))
            if str(wr.get("status") or "") != "ok":
                status = "error"
                detail = str(wr.get("summary") or "")[:500]
        return out
    except Exception as e:  # noqa: BLE001
        status = "error"
        detail = repr(e)[:500]
        state.heartbeat_upsert(component, phase="error", detail=detail, pid=os.getpid())
        raise
    finally:
        state.pipeline_run_finish(run_id, status=status, detail=detail)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="리드 한 도메인을 한 번 돌린다")
    parser.add_argument("domain", choices=sorted(_LEADS))
    parser.add_argument("--charter-ref", default="")
    parser.add_argument("--goal", default="")
    parser.add_argument("--timeout-sec", type=int, default=None)
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=os.environ.get("SA_LEAD_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    result = run_lead_pass(args.domain, charter_ref=args.charter_ref,
                           goal=args.goal, timeout_sec=args.timeout_sec)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if str(result.get("status") or "") in {"ok", "idle", "skipped"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
