"""GitHub E2E report agent — repo findings to remediation report."""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from domains.services.github.application.contracts import (
    COMPONENT_GITHUB_REPORT,
    GITHUB_REPORT_SESSION_ID,
    PHASE_GITHUB_REPORT,
)
from domains.services.github.application.scanner import (
    build_report_for_thread,
    deliver_report_for_thread,
    mark_report_ready,
    sync_report_threads,
)
from service import state_domain as state
from service.runtime_env import load_runtime_env

log = logging.getLogger("service.agents.github_report")


def _report_retry_after() -> float:
    return time.time() + state.service_recheck_retry_seconds()


def _ensure_evidence_dir(thread: dict[str, Any], evidence_dir: Path | None) -> Path:
    if evidence_dir is not None:
        Path(evidence_dir).mkdir(parents=True, exist_ok=True)
        return Path(evidence_dir)
    root = Path(
        os.environ.get("SA_GITHUB_EVIDENCE_DIR", "")
        or os.environ.get("SA_E2E_EVIDENCE_DIR", "")
        or (Path(tempfile.gettempdir()) / "github_e2e_evidence")
    )
    root.mkdir(parents=True, exist_ok=True)
    safe = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in str(thread.get("repo") or ""))[:48]
    out = root / f"{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:6]}-github-report-{safe}"
    out.mkdir(parents=True, exist_ok=False)
    return out


def _write_report_artifact(report: dict[str, Any], *, evidence_dir: Path | None = None) -> str | None:
    if evidence_dir is None:
        return None
    out_dir = evidence_dir / "github_reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    safe = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in str(report.get("repo") or ""))[:80]
    path = out_dir / f"{safe}_thread_{report.get('thread_id')}.html"
    path.write_text(str(report.get("html") or ""), encoding="utf-8")
    return str(path)


def _mark_empty_report_skipped(thread: dict[str, Any], report: dict[str, Any]) -> None:
    out_of_scope = int(report.get("out_of_scope_count") or 0)
    reason = f"report skipped: no in-scope findings (out_of_scope_count={out_of_scope})"
    state.github_report_thread_set_status(
        int(thread["id"]),
        "error",
        last_reason=reason,
    )
    report["skipped_empty_report"] = True
    report["delivery"] = {"mode": "skipped_empty_report"}
    report["delivery_skipped_reason"] = reason


async def handle_thread_async(
    thread: dict[str, Any],
    *,
    evidence_dir: Path | None = None,
    charter_ref: str = "",
) -> dict[str, Any]:
    """claim 된 스레드 하나를 처리한다 — 보고서 생성 + 배달 + 사후 기록.

    ⚠️ **여기가 유일한 구현이다.** `_handle_thread` 는 자기 이벤트 루프를 여는
    얇은 진입점이고, `ThreadAdapter.deliver_report` 는 이미 루프 안에 있는
    호출자(회신·재검증 경로)를 위해 이것을 직접 await 한다. 두 벌로 늘리지 마라 —
    이 계약이 없애려는 것이 바로 복붙 쌍둥이다(`_shared/thread_adapter` 머리말).
    """
    ev_dir = _ensure_evidence_dir(thread, evidence_dir)
    report = build_report_for_thread(thread)
    if int(report.get("finding_count") or 0) <= 0:
        _mark_empty_report_skipped(thread, report)
        return report
    artifact = _write_report_artifact(report, evidence_dir=ev_dir)
    if artifact:
        report["artifact"] = artifact
    mark_report_ready(thread, report)
    try:
        report["delivery"] = await deliver_report_for_thread(
            thread,
            report,
            evidence_dir=ev_dir,
            charter_ref=charter_ref,
        )
    except Exception as e:  # noqa: BLE001
        state.github_report_thread_set_status(
            int(thread["id"]),
            "report_ready",
            last_reason=f"delivery failed: {repr(e)[:460]}",
        )
        report["delivery_error"] = repr(e)[:500]
    return report


def _handle_thread(
    thread: dict[str, Any],
    *,
    evidence_dir: Path | None = None,
    charter_ref: str = "",
) -> dict[str, Any]:
    """동기 진입점 — `run_report_pass` 처럼 루프 **밖**에서 부르는 쪽이 쓴다."""
    return asyncio.run(
        handle_thread_async(thread, evidence_dir=evidence_dir, charter_ref=charter_ref)
    )


def run_report_pass(
    *,
    max_threads: int | None = None,
    evidence_dir: Path | None = None,
    charter_ref: str = "",
) -> dict[str, Any]:
    load_runtime_env(load_plugins=False)
    component = COMPONENT_GITHUB_REPORT
    state.heartbeat_upsert(component, phase=PHASE_GITHUB_REPORT, pid=os.getpid())
    run_id = state.pipeline_run_start(component)
    handled = reports = sent = dry_run = errors = skipped_empty = 0
    status = "ok"
    detail = ""
    try:
        sync = sync_report_threads()
        state.github_report_thread_reclaim_stale()
        while True:
            if max_threads is not None and handled >= max_threads:
                break
            thread = state.github_report_thread_claim_next(
                session_id=GITHUB_REPORT_SESSION_ID,
                status="reported",
            )
            if thread is None:
                break
            handled += 1
            state.heartbeat_upsert(component, phase=PHASE_GITHUB_REPORT, detail=str(thread.get("repo")), pid=os.getpid())
            try:
                report = _handle_thread(thread, evidence_dir=evidence_dir, charter_ref=charter_ref)
                if report.get("skipped_empty_report"):
                    skipped_empty += 1
                    log.warning(
                        "[github-report] repo=%s skipped empty report",
                        thread.get("repo"),
                    )
                    continue
                reports += 1
                delivery = report.get("delivery") or {}
                if delivery.get("mode") == "sent":
                    sent += 1
                elif delivery.get("mode") == "dry_run":
                    dry_run += 1
                if report.get("delivery_error"):
                    errors += 1
                log.info("[github-report] repo=%s findings=%s", thread.get("repo"), report.get("finding_count"))
            except Exception as e:  # noqa: BLE001
                errors += 1
                log.warning("[github-report] thread=%s failed: %r", thread.get("id"), e)
                state.github_report_thread_set_status(
                    int(thread["id"]),
                    "reported",
                    retry_after=_report_retry_after(),
                    last_reason=f"report pass failed: {repr(e)[:450]}",
                )
        detail = (
            f"sync={sync} handled={handled} reports={reports} sent={sent} "
            f"dry_run={dry_run} skipped_empty={skipped_empty} errors={errors}"
        )
        return {
            "sync": sync,
            "handled": handled,
            "reports": reports,
            "sent": sent,
            "dry_run": dry_run,
            "skipped_empty": skipped_empty,
            "errors": errors,
        }
    except Exception as e:  # noqa: BLE001
        status = "error"
        detail = repr(e)[:500]
        raise
    finally:
        state.heartbeat_upsert(component, phase="idle" if status == "ok" else "error", detail=detail, pid=os.getpid())
        state.pipeline_run_finish(run_id, status=status, detail=detail)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="GitHub E2E report agent")
    parser.add_argument("--max-threads", type=int, default=None)
    parser.add_argument(
        "--charter",
        default=os.environ.get("DEFAULT_CHARTER_REF", "SECOPS-2026-001"),
    )
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=os.environ.get("GITHUB_AGENT_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    res = run_report_pass(max_threads=args.max_threads, charter_ref=args.charter)
    log.info("[github-report] pass done %s", res)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
