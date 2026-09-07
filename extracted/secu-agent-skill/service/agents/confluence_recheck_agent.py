"""Confluence E2E remediation recheck agent."""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
from pathlib import Path
from typing import Any

from domains.services.confluence.application.contracts import (
    COMPONENT_CONFLUENCE_RECHECK,
    CONFLUENCE_RECHECK_SESSION_ID,
    PHASE_CONFLUENCE_RECHECK,
)
from domains.services.confluence.application.reporter import (
    deliver_recheck_result_for_thread,
    recheck_thread,
)
from service import state_domain as state
from service.agents import runtime
from service.agents.service_reply_guidance_agent import run_guidance_pass
from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.confluence_recheck")

_ATTEMPT_CAP = 4


def _attempt_cap_exceeded(thread: dict[str, Any]) -> bool:
    return int(thread.get("attempt_count") or 0) > _ATTEMPT_CAP


def _handle_thread(
    thread: dict[str, Any],
    *,
    evidence_dir: Path | None = None,
    charter_ref: str = "",
) -> dict[str, Any]:
    thread_id = int(thread["id"])
    if _attempt_cap_exceeded(thread):
        state.confluence_report_thread_set_status(
            thread_id,
            "escalated",
            last_reason="confluence recheck attempt cap exceeded",
        )
        log.warning("[confluence-recheck] thread=%s attempt cap exceeded -> escalated", thread_id)
        return {"thread_id": thread_id, "final_status": "escalated", "escalated": True}

    ev_dir = evidence_dir or runtime.make_evidence_dir(f"confluence-recheck-{thread.get('space_key')}")
    state.confluence_report_thread_set_status(
        thread_id,
        "rechecking",
        claimed_by=CONFLUENCE_RECHECK_SESSION_ID,
    )
    result = recheck_thread(
        thread,
        evidence_dir=ev_dir,
        finalize=False,
        charter_ref=charter_ref,
    )
    if result.get("final_status") == "recheck_requested":
        retry_after = state.confluence_report_thread_schedule_recheck_retry(
            int(thread["id"]),
            reason="confluence recheck produced unknown results; retryable",
        )
        result["retry_after"] = retry_after
        return result
    try:
        result["delivery"] = asyncio.run(
            deliver_recheck_result_for_thread(
                thread,
                result,
                evidence_dir=ev_dir,
                charter_ref=charter_ref,
            )
        )
        result["final_status"] = result["delivery"].get("final_status", result.get("final_status"))
    except Exception as e:  # noqa: BLE001
        retry_after = state.confluence_report_thread_schedule_recheck_retry(
            int(thread["id"]),
            reason=f"recheck result delivery failed: {repr(e)[:450]}",
        )
        result["delivery_error"] = repr(e)[:500]
        result["final_status"] = "recheck_requested"
        result["retry_after"] = retry_after
    return result


def run_recheck_pass(
    *,
    max_threads: int | None = None,
    evidence_dir: Path | None = None,
    charter_ref: str = "",
) -> dict[str, Any]:
    load_runtime_env(load_plugins=False)
    component = COMPONENT_CONFLUENCE_RECHECK
    state.heartbeat_upsert(component, phase=PHASE_CONFLUENCE_RECHECK, pid=os.getpid())
    run_id = state.pipeline_run_start(component)
    handled = remediated = still_open = partially_remediated = exception_review = escalated = retryable = sent = dry_run = errors = 0
    guidance = {"handled": 0, "sent": 0, "dry_run": 0, "errors": 0}
    status = "ok"
    detail = ""
    try:
        state.confluence_report_thread_reclaim_stale()
        guidance = run_guidance_pass(
            "confluence",
            session_id=CONFLUENCE_RECHECK_SESSION_ID,
            max_threads=max_threads,
            evidence_dir=evidence_dir,
            charter_ref=charter_ref,
        )
        remaining = None if max_threads is None else max(
            0,
            max_threads - int(guidance.get("handled") or 0),
        )
        while True:
            if remaining is not None and handled >= remaining:
                break
            thread = state.confluence_report_thread_claim_next(
                session_id=CONFLUENCE_RECHECK_SESSION_ID,
                status="recheck_requested",
            )
            if thread is None:
                break
            handled += 1
            state.heartbeat_upsert(
                component,
                phase=PHASE_CONFLUENCE_RECHECK,
                detail=str(thread.get("space_key")),
                pid=os.getpid(),
            )
            try:
                result = _handle_thread(thread, evidence_dir=evidence_dir, charter_ref=charter_ref)
                delivery = result.get("delivery") or {}
                if delivery.get("mode") == "sent":
                    sent += 1
                elif delivery.get("mode") == "dry_run":
                    dry_run += 1
                if result.get("final_status") == "remediated":
                    remediated += 1
                elif result.get("final_status") == "still_open":
                    still_open += 1
                elif result.get("final_status") == "partially_remediated":
                    partially_remediated += 1
                elif result.get("final_status") == "exception_review":
                    exception_review += 1
                elif result.get("final_status") == "escalated":
                    escalated += 1
                elif result.get("final_status") == "recheck_requested":
                    retryable += 1
            except Exception as e:  # noqa: BLE001
                errors += 1
                log.warning("[confluence-recheck] thread=%s failed: %r", thread.get("id"), e)
                state.confluence_report_thread_schedule_recheck_retry(
                    int(thread["id"]),
                    reason=f"recheck pass failed: {repr(e)[:450]}",
                )
                retryable += 1
        detail = (
            f"guidance={guidance.get('handled', 0)} handled={handled} "
            f"remediated={remediated} still_open={still_open} "
            f"partially_remediated={partially_remediated} "
            f"exception_review={exception_review} escalated={escalated} "
            f"retryable={retryable} sent={sent} dry_run={dry_run} errors={errors}"
        )
        return {
            "guidance": guidance,
            "handled": handled,
            "remediated": remediated,
            "still_open": still_open,
            "partially_remediated": partially_remediated,
            "exception_review": exception_review,
            "escalated": escalated,
            "retryable": retryable,
            "sent": sent,
            "dry_run": dry_run,
            "errors": errors,
        }
    except Exception as e:  # noqa: BLE001
        status = "error"
        detail = repr(e)[:500]
        raise
    finally:
        state.heartbeat_upsert(
            component,
            phase="idle" if status == "ok" else "error",
            detail=detail,
            pid=os.getpid(),
        )
        state.pipeline_run_finish(run_id, status=status, detail=detail)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Confluence E2E remediation recheck agent")
    parser.add_argument("--max-threads", type=int, default=None)
    parser.add_argument(
        "--charter",
        default=os.environ.get("DEFAULT_CHARTER_REF", "SECOPS-2026-001"),
    )
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=os.environ.get("CONFLUENCE_AGENT_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    res = run_recheck_pass(max_threads=args.max_threads, charter_ref=args.charter)
    log.info("[confluence-recheck] pass done %s", res)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
