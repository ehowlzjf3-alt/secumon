"""리드 상시 러너 — 5개 리드를 각자의 control_flag 로 게이트하며 폴링한다.

`github_pipeline_runner` / `confluence_pipeline_runner` 와 같은 모양이다. 별도 러너로
둔 이유는 둘이다:

1. **기존 파이프라인을 안 건드린다.** 리드는 평면 워커와 같은 큐를 소비하는 *대안*이지
   추가 단계가 아니다. 기존 러너의 steps 에 끼워 넣으면 같은 틱에 둘 다 돈다.
2. **도메인 무관이다.** 리드 계약·도구·마스킹이 이미 4도메인 공통이라(어댑터만 다르다)
   러너도 하나면 된다. 도메인마다 하나씩 만들면 그게 5벌이 되고, 그중 하나가 뒤처진다.

⚠️ 플래그는 **전부 기본 off** 다. 리드를 켜려면 겹치는 평면 워커를 먼저 꺼야 한다 —
   `lead_agent._LEADS` 가 그 짝을 들고 있고, 겹치면 패스가 돌지 않고 이유를 남긴다.
"""
from __future__ import annotations

import argparse
import logging
import os
import signal
import time
from typing import Any

from service.agents.lead_agent import _LEADS, run_lead_pass
from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.lead_pipeline_runner")

DEFAULT_POLL_SECONDS = 60.0
# 리드 한 번은 비싸다(실측: smb 2타깃 8턴 162k tok, 약 3분). 기본 간격을 짧게 두면
# 앞선 리드가 아직 닫지 않은 타깃을 다음 리드가 다시 본다.
DEFAULT_INTERVAL_SECONDS = 900.0

_stop = False


def _float_env(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _latest_run_age(component: str) -> float | None:
    from service import state_domain as state

    rows = state.pipeline_runs_recent(component, limit=1)
    if not rows:
        return None
    row = rows[0]
    ts = row.get("finished_at") or row.get("started_at")
    if not ts:
        return None
    return max(0.0, time.time() - float(ts))


def ensure_flags_default_off() -> list[str]:
    """리드 플래그를 **없으면 off 로** 심는다. 반환 = 이번에 새로 심은 컴포넌트.

    ★ 이게 없으면 리드 5개가 첫 폴링에 라이브 큐에서 켜진다.
      `state.control_flag_get()` 은 없는 행을 **`enabled=1` 로 자동 생성**한다
      (`state_domain.py:6196` — "없으면 기본값(enabled=1…)으로 생성 후 반환").
      기존 컴포넌트에는 그게 맞는 기본값이지만, 리드는 **평면 워커와 같은 큐를 두고
      경쟁하는 대안 경로**라 켜지는 순간 이중 소비가 시작된다.

    그래서 조회 **전에** 직접 INSERT 한다. `ON CONFLICT DO NOTHING` 이라 이미 사람이
    켜 둔 값은 건드리지 않는다 — 심는 것과 끄는 것은 다르다.
    """
    from service import state_domain as state

    seeded: list[str] = []
    now = time.time()
    with state.connect() as c:
        for component, _rival in _LEADS.values():
            row = c.execute(
                "SELECT component FROM control_flag WHERE component=?", (component,),
            ).fetchone()
            if row is not None:
                continue
            c.execute(
                "INSERT INTO control_flag(component, enabled, run_now, interval_seconds, "
                "updated_at) VALUES (?, 0, 0, ?, ?) ON CONFLICT(component) DO NOTHING",
                (component, DEFAULT_INTERVAL_SECONDS, now),
            )
            seeded.append(component)
    if seeded:
        log.info("[lead-runner] 리드 플래그를 off 로 심었다: %s — "
                 "켜려면 겹치는 평면 워커를 먼저 꺼라", seeded)
    return seeded


def _should_run(component: str) -> bool:
    from service import state_domain as state

    flag = state.control_flag_get(component)
    if not flag or not flag.get("enabled"):
        return False
    if state.control_flag_consume_run_now(component):
        return True
    interval = float(flag.get("interval_seconds") or DEFAULT_INTERVAL_SECONDS)
    age = _latest_run_age(component)
    return age is None or age >= interval


#: 한 차례에 리드를 몇 번까지 다시 부를까. ⚠️ 상한이 없으면 큐가 깊은 도메인이
#: 차례를 독점하고 나머지가 굶는다(smb 큐 1,706건 실측).
MAX_PASSES_ENV = "SA_LEAD_PASSES_PER_TURN"
_MAX_PASSES_DEFAULT = 8
#: 한 차례의 벽시계 상한(초). 패스가 길어져도 여기서 끊는다.
TURN_WALL_ENV = "SA_LEAD_TURN_WALL_SEC"
_TURN_WALL_DEFAULT = 600.0
#: 큐 깊이를 셀 때의 상한. 정확한 총량이 아니라 **줄었는지**만 보면 되므로 넉넉히 작게.
_DEPTH_PROBE_LIMIT = 200


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, "") or default))
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    try:
        return max(1.0, float(os.environ.get(name, "") or default))
    except ValueError:
        return default


def _claimable_depth(domain: str) -> int:
    """이 도메인 큐에 아직 볼 게 몇 건인가. 못 세면 -1.

    ⚠️ 0 과 -1 을 뭉치지 마라 — "큐가 비었다" 와 "못 셌다" 는 다르다.
       뭉치면 조회 실패가 "다 했다" 로 읽혀 루프가 조용히 멈춘다.
    """
    from _shared.lead_adapter import get_lead_adapter

    adapter = get_lead_adapter(domain)
    if adapter is None:
        return -1
    wanted = tuple(getattr(adapter, "claimable_statuses", ()) or ())
    if not wanted:
        return -1
    total = 0
    for status in wanted:
        try:
            total += len(adapter.list_targets(status=status, limit=_DEPTH_PROBE_LIMIT))
        except Exception as e:  # noqa: BLE001
            log.warning("[lead-runner] %s 큐 깊이 조회 실패(status=%s): %r", domain, status, e)
            return -1
        if total >= _DEPTH_PROBE_LIMIT:
            break
    return total


def _run_until_drained(
    domain: str, component: str, *, charter_ref: str = "",
) -> dict[str, Any]:
    """차례가 온 리드를 **큐가 빌 때까지 여러 번** 부른다.

    ## 왜 (2026-08-31 실측)

    리드는 한 번 돌 때 40턴 예산 중 **7턴만 쓰고 1건만 닫고 끝냈다**(5회 연속,
    전부 `end_turn`). 그런데 차례는 15분에 한 번뿐이라 가동률이 **5%** 였다 —
    64초 일하고 22.9분 대기. 큐 1,706건에 하루 처리 82건, 소진에 3주.

    계약 프롬프트는 **이미** "닫았으면 다음 타깃으로 간다. 큐가 비거나 턴이 다할
    때까지 반복하라"고 지시하고 2026-08-27 의 같은 사고까지 인용한다. 그래도
    안 지켜진다. **부탁으로 지켜지는 불변식은 언젠가 깨지고, 깨져도 조용하다** —
    이 저장소가 오늘만 세 번 확인한 형태다(재검증 게이트·티켓 스탬프·여기).

    ⇒ 프롬프트를 고치는 대신 **러너가 다시 부른다.** 강제다.

    ## 멈추는 조건 — 넷 다 필요하다

        · 큐가 비었다(`status="idle"`)          더 할 게 없다
        · 패스가 실패했다                        같은 실패를 반복하지 않는다
        · 큐가 안 줄었다                          헛돌지 않는다(닫은 게 없다)
        · 상한(패스 수 / 벽시계)                  한 도메인이 차례를 독점하지 않는다

    ## 중간에 끊겨도 안전한 이유

    리드는 타깃을 **claim 하지 않는다**(`list_targets`: "claim 하지 않는다 — 목록을
    봐도 큐 상태는 안 바뀐다"). 그래서 패스가 중간에 끝나도 그 타깃은 원래 상태로
    큐에 남고 다음에 다시 잡힌다. 이미 `set_target_status` 로 닫은 것은 그대로다.
    검토원 세션은 패스마다 계약 훅(`close_all`)이 닫는다.
    """
    max_passes = _int_env(MAX_PASSES_ENV, _MAX_PASSES_DEFAULT)
    deadline = time.monotonic() + _float_env(TURN_WALL_ENV, _TURN_WALL_DEFAULT)
    depth = _claimable_depth(domain)
    passes: list[dict[str, Any]] = []
    last: dict[str, Any] = {}

    for i in range(max_passes):
        last = run_lead_pass(domain, charter_ref=charter_ref)
        passes.append({"status": last.get("status"), "turns": last.get("turns"),
                       "elapsed_sec": last.get("elapsed_sec")})
        status = str(last.get("status") or "")
        if status == "idle":
            break
        if status != "ok":
            log.warning("[lead-runner] %s 패스 %d 가 %s 로 끝나 반복을 멈춘다",
                        component, i + 1, status or "?")
            break
        if time.monotonic() >= deadline:
            log.info("[lead-runner] %s 차례 벽시계 상한 — %d패스에서 멈춘다", component, i + 1)
            break
        after = _claimable_depth(domain)
        # -1 은 "못 셌다" 다. 그때는 진척 판정을 포기하고 한 번 더 돌지 않는다 —
        # 조회가 깨진 채로 반복하면 무한히 돌 수 있다.
        if after < 0 or depth < 0 or after >= depth:
            log.info("[lead-runner] %s 큐가 줄지 않았다(%s→%s) — %d패스에서 멈춘다",
                     component, depth, after, i + 1)
            break
        depth = after

    out = dict(last)
    out["passes"] = passes
    out["pass_count"] = len(passes)
    return out


def run_once(*, charter_ref: str = "", only: str | None = None) -> dict[str, Any]:
    """켜져 있고 주기가 된 리드를 한 번씩 돌린다."""
    load_runtime_env(load_plugins=True)
    ensure_flags_default_off()      # ★ _should_run 보다 **먼저**. 이유는 함수 주석.
    out: dict[str, Any] = {}
    for domain, (component, _rival) in _LEADS.items():
        if only and domain != only:
            continue
        try:
            if not _should_run(component):
                continue
            log.info("[lead-runner] running %s", component)
            out[component] = _run_until_drained(domain, component, charter_ref=charter_ref)
        except Exception as e:  # noqa: BLE001
            from service import state_domain as state

            log.exception("[lead-runner] %s failed", component)
            state.heartbeat_upsert(component, phase="error",
                                   detail=repr(e)[:500], pid=os.getpid())
            out[component] = {"error": repr(e)[:500]}
    return out


def _install_signal_handlers() -> None:
    def _sig(_signum, _frame) -> None:
        global _stop
        _stop = True

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _sig)
        except (ValueError, OSError):
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="리드 상시 러너 (4도메인 5큐)")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--poll-sec", type=float, default=None)
    parser.add_argument("--max-loops", type=int, default=None)
    parser.add_argument("--only", choices=sorted(_LEADS), default=None,
                        help="한 도메인만 돌린다(디버깅)")
    parser.add_argument("--charter-ref", default="")
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=os.environ.get("SA_LEAD_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s")

    if args.once:
        run_once(charter_ref=args.charter_ref, only=args.only)
        return 0

    _install_signal_handlers()
    poll = args.poll_sec or _float_env("SA_LEAD_POLL_SEC", DEFAULT_POLL_SECONDS)
    loops = 0
    while not _stop:
        run_once(charter_ref=args.charter_ref, only=args.only)
        loops += 1
        if args.max_loops is not None and loops >= args.max_loops:
            break
        # 상시 루프의 sleep 은 신호를 잡을 수 있게 잘게 나눈다.
        waited = 0.0
        while waited < poll and not _stop:
            time.sleep(min(1.0, poll - waited))
            waited += 1.0
    log.info("[lead-runner] 종료 (loops=%d)", loops)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
