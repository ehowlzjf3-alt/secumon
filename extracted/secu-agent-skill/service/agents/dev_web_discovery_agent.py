"""dev_web #0 discovery runner."""
from __future__ import annotations

import argparse
import logging
import os
import time
from typing import Any

from domains.dev_web.application.contracts import COMPONENT_DISCOVERY, PHASE_DISCOVERY
from domains.dev_web.application.discovery import DevWebDiscoveryConfig, run_discovery
from domains.dev_web.application.ports import DevWebDiscoveryStorePort, SplunkSearchPort
from domains.dev_web.infrastructure.runtime import (
    default_splunk_search_client,
    default_state_gateway,
)
from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.dev_web_discovery")


def _float_env(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def run_discovery_pass(
    *,
    config: DevWebDiscoveryConfig | None = None,
    store: DevWebDiscoveryStorePort | None = None,
    searcher: SplunkSearchPort | None = None,
) -> dict[str, Any]:
    load_runtime_env(load_plugins=False)
    store = store or default_state_gateway()
    searcher = searcher or default_splunk_search_client()
    config = config or DevWebDiscoveryConfig(
        siem_filter=os.environ.get("DEV_WEB_DISCOVERY_SIEM_FILTER", "cdep"),
        include_regex=os.environ.get(
            "DEV_WEB_DISCOVERY_INCLUDE_REGEX",
            r"(?i)(dev|stage|stg|test|qa|sandbox|cdep)",
        ),
        earliest=os.environ.get("DEV_WEB_DISCOVERY_EARLIEST", "-7d@d"),
        latest=os.environ.get("DEV_WEB_DISCOVERY_LATEST", "now"),
        max_domains=int(os.environ.get("DEV_WEB_DISCOVERY_MAX_DOMAINS", "1000")),
    )

    store.heartbeat_upsert(COMPONENT_DISCOVERY, phase=PHASE_DISCOVERY, pid=os.getpid())
    run_id = store.pipeline_run_start(COMPONENT_DISCOVERY)
    status = "ok"
    detail = ""
    try:
        result = run_discovery(config=config, searcher=searcher, store=store)
        detail = (
            f"rows={result['splunk_rows']} matched={result['matched']} "
            f"upserted={result['upserted']} new={result['new']} total={result['total']}"
        )
        return result
    except Exception as e:  # noqa: BLE001
        status = "error"
        detail = repr(e)[:500]
        raise
    finally:
        store.heartbeat_upsert(
            COMPONENT_DISCOVERY,
            phase="idle" if status == "ok" else "error",
            detail=detail,
            pid=os.getpid(),
        )
        store.pipeline_run_finish(run_id, status=status, detail=detail)


def run_discovery_loop(
    *,
    config: DevWebDiscoveryConfig,
    store: DevWebDiscoveryStorePort | None = None,
    searcher: SplunkSearchPort | None = None,
    poll_seconds: float | None = None,
) -> None:
    store = store or default_state_gateway()
    poll = poll_seconds or _float_env("DEV_WEB_DISCOVERY_POLL_SECONDS", 21600)
    while True:
        flag = store.control_flag_get(COMPONENT_DISCOVERY)
        run_now = store.control_flag_consume_run_now(COMPONENT_DISCOVERY)
        enabled = bool(int(flag.get("enabled", 1)))
        interval = float(flag.get("interval_seconds") or poll)
        if enabled or run_now:
            try:
                result = run_discovery_pass(config=config, store=store, searcher=searcher)
                log.info("[dev_web_discovery] pass done %s", result)
            except Exception as e:  # noqa: BLE001
                log.warning("[dev_web_discovery] pass failed: %r", e)
        else:
            store.heartbeat_upsert(
                COMPONENT_DISCOVERY,
                phase="disabled",
                detail="control flag disabled",
                pid=os.getpid(),
            )
        time.sleep(max(1.0, interval))


def _config_from_args(args: argparse.Namespace) -> DevWebDiscoveryConfig:
    return DevWebDiscoveryConfig(
        siem_filter=args.siem_filter,
        include_regex=args.include_regex,
        day_bucket=args.day_bucket,
        earliest=args.earliest,
        latest=args.latest,
        max_domains=args.max_domains,
    )


#: discovery 기본 주기. github 이 같은 단계에 쓰는 값(86400)을 그대로 쓴다 —
#: 사이트 목록은 하루 한 번이면 충분하고, 소스(Splunk)에 하루치가 쌓인다.
_DEFAULT_INTERVAL_SECONDS = 86400.0


def _latest_run_age() -> float | None:
    """마지막 discovery 패스로부터 지난 시간. 기록이 없으면 None."""
    from service import state_domain as state

    try:
        rows = state.pipeline_runs_recent(COMPONENT_DISCOVERY, limit=1)
    except Exception:  # noqa: BLE001 — 못 읽으면 "돌 때가 됐다" 로 본다
        return None
    if not rows:
        return None
    ts = rows[0].get("finished_at") or rows[0].get("started_at")
    return max(0.0, time.time() - float(ts)) if ts else None


def due_now() -> tuple[bool, str]:
    """지금 discovery 를 돌 때인가. `(돌까, 사유)`.

    ★ 왜 여기 있나 (2026-08-28 실측). dev_web 은 github·confluence 와 달리
      `*_pipeline_runner.py` 가 없다. 스케줄은 `scripts/dev_web_loop.sh` 가 60초마다
      도는 셸 루프이고 거기엔 task·report 자리만 있었다 — **discovery 를 부르는 곳이
      한 번도 없었다**(`git log -S"runners.discovery" -- scripts/` = 0건).
      `dev_web_target` 의 마지막 `discovered_at` 은 2026-08-24 이고, 그동안 소스에는
      하루 1,400만 건이 계속 쌓였다. `pending 0` 은 고갈이 아니라 **미공급**이었다.

      셸 루프에는 단계별 간격 개념이 없으므로 형제 도메인의 `_should_run` 과 같은
      게이트를 여기 둔다 — 루프는 매 틱 불러도 되고 이 함수가 스스로 조절한다.
    """
    from service import state_domain as state

    try:
        flag = state.control_flag_get(COMPONENT_DISCOVERY)
    except Exception:  # noqa: BLE001 — 플래그를 못 읽으면 돌지 않는다(fail-closed)
        return False, "control_flag 를 못 읽었다"
    try:
        if state.control_flag_consume_run_now(COMPONENT_DISCOVERY):
            return True, "run_now"
    except Exception:  # noqa: BLE001
        pass
    if not bool(int(flag.get("enabled", 1))):
        return False, "control_flag disabled"
    interval = float(flag.get("interval_seconds") or _DEFAULT_INTERVAL_SECONDS)
    age = _latest_run_age()
    if age is None or age >= interval:
        return True, f"due (age={'없음' if age is None else round(age)}, interval={round(interval)}s)"
    return False, f"next due in {round(interval - age)}s"


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=os.environ.get("DEV_WEB_AGENT_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    parser = argparse.ArgumentParser(description="dev_web #0 discovery runner")
    parser.add_argument("--loop", action="store_true", help="poll control_flag and run continuously")
    parser.add_argument("--siem-filter", default=os.environ.get("DEV_WEB_DISCOVERY_SIEM_FILTER", "cdep"))
    parser.add_argument(
        "--include-regex",
        default=os.environ.get("DEV_WEB_DISCOVERY_INCLUDE_REGEX", r"(?i)(dev|stage|stg|test|qa|sandbox|cdep)"),
    )
    parser.add_argument("--day-bucket", default=None)
    parser.add_argument("--earliest", default=os.environ.get("DEV_WEB_DISCOVERY_EARLIEST", "-7d@d"))
    parser.add_argument("--latest", default=os.environ.get("DEV_WEB_DISCOVERY_LATEST", "now"))
    parser.add_argument("--max-domains", type=int, default=int(os.environ.get("DEV_WEB_DISCOVERY_MAX_DOMAINS", "1000")))
    parser.add_argument("--poll-seconds", type=float, default=None)
    parser.add_argument(
        "--if-due", action="store_true",
        help="control_flag 의 enabled/interval_seconds 를 보고 **돌 때만** 돈다(셸 루프용)")
    args = parser.parse_args(argv)
    if args.if_due:
        # ⚠️ **env 를 먼저 보장한다.** due_now 는 control_flag 를 읽는데 DSN 은
        #    run_discovery_pass 안의 load_runtime_env 가 넣는다 — 그보다 앞에서
        #    물으면 DB 를 못 열고 fail-closed 로 매번 건너뛴다.
        #    실기동 2026-08-28 07:44 에 정확히 그렇게 찍혔다:
        #        "[dev_web_discovery] 건너뜀 — control_flag 를 못 읽었다"
        #    (fail-closed 가 조용한 오작동 대신 사실을 드러냈다.)
        load_runtime_env(load_plugins=False)
        ok, why = due_now()
        if not ok:
            log.info("[dev_web_discovery] 건너뜀 — %s", why)
            return 0
        log.info("[dev_web_discovery] 실행 — %s", why)
    config = _config_from_args(args)
    if args.loop:
        run_discovery_loop(config=config, poll_seconds=args.poll_seconds)
        return 0
    result = run_discovery_pass(config=config)
    log.info("[dev_web_discovery] pass done %s", result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
