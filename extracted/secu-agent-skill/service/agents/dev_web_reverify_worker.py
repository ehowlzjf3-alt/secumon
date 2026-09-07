"""dev_web_reply_verify fanout worker entrypoint."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path


from service.agents.worker_result import write_worker_result as _write_worker_result


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        print("usage: dev_web_reverify_worker <evidence_dir>", file=sys.stderr)
        return 2
    evidence_dir = Path(args[0]).resolve()
    spec_path = evidence_dir / "task_spec.json"
    if not spec_path.exists():
        _write_worker_result(evidence_dir, status="error_crash", summary="task_spec.json 없음", rc=1)
        return 1
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    thread_id = (spec.get("target") or {}).get("thread_id")
    if thread_id is None:
        _write_worker_result(evidence_dir, status="error_crash", summary="target.thread_id 없음", rc=1)
        return 1
    from service.agents import runtime
    runtime._ensure_dotenv()
    from service import state_domain as state
    from service.agents import dev_web_reverify_agent

    thread = state.dev_web_report_thread_get(int(thread_id))
    if not thread:
        _write_worker_result(evidence_dir, status="ok", summary=f"thread_id={thread_id}: 없음")
        return 0
    try:
        result = asyncio.run(dev_web_reverify_agent._reverify_one_thread(thread, evidence_dir=evidence_dir))
        if result.get("error"):
            _write_worker_result(evidence_dir, status="error_crash",
                                 summary=f"thread_id={thread_id}: {result.get('error')}", rc=1)
            return 1
        _write_worker_result(
            evidence_dir, status="ok",
            summary=f"thread_id={thread_id}: recorded={result.get('saw_terminal')}",
            findings=1 if result.get("saw_terminal") else 0,
            turns=int(result.get("turns") or 0),
            tokens_in=int(result.get("tokens_in") or 0),
            tokens_out=int(result.get("tokens_out") or 0),
        )
        return 0
    except Exception as e:  # noqa: BLE001
        _write_worker_result(evidence_dir, status="error_crash", summary=f"thread_id={thread_id}: {e!r}", rc=1)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
