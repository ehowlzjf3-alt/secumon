"""smb_reply_verify fanout worker entrypoint.

Usage: `python -m service.agents.reply_verify_worker <evidence_dir>`.
The parent fanout adapter claims one reply_received mail_thread and writes
task_spec.json. This worker runs exactly that thread and writes worker_result.json.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any


from service.agents.worker_result import write_worker_result as _write_worker_result


def main(argv: "list[str] | None" = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        print("usage: reply_verify_worker <evidence_dir>", file=sys.stderr)
        return 2
    evidence_dir = Path(args[0]).resolve()
    spec_path = evidence_dir / "task_spec.json"
    if not spec_path.exists():
        _write_worker_result(evidence_dir, status="error_crash", summary="task_spec.json 없음", rc=1)
        return 1
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    target = spec.get("target") or {}
    thread_id = target.get("thread_id")
    charter = spec.get("charter_ref", "")
    if not thread_id:
        _write_worker_result(evidence_dir, status="error_crash", summary="target.thread_id 없음", rc=1)
        return 1

    from service.agents import runtime
    runtime._ensure_dotenv()

    from service import state_domain as state
    from service.agents import reply_verify_agent

    thread = state.mail_thread_get(int(thread_id))
    if thread is None:
        _write_worker_result(evidence_dir, status="error_crash", summary=f"thread {thread_id} 없음", rc=1)
        return 1
    try:
        result: dict[str, Any] = asyncio.run(
            reply_verify_agent._handle_thread(thread, charter_ref=charter, evidence_dir=evidence_dir),
        )
        ok = bool(result.get("saw_terminal") or result.get("escalated"))
        _write_worker_result(
            evidence_dir,
            status="ok" if ok else "error_crash",
            summary=(
                f"thread={thread_id}: final={result.get('final_status')} "
                f"sent={result.get('saw_terminal')} reason={result.get('reason')}"
            ),
            rc=0 if ok else 1,
            turns=int(result.get("turns") or 0),
            tokens_in=int(result.get("tokens_in") or 0),
            tokens_out=int(result.get("tokens_out") or 0),
        )
        return 0 if ok else 1
    except Exception as e:  # noqa: BLE001
        state.mail_thread_set_status(int(thread_id), "reply_received")
        _write_worker_result(evidence_dir, status="error_crash", summary=f"thread={thread_id}: {e!r}", rc=1)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
