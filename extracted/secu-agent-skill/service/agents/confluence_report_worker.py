"""Worker entrypoint for one Confluence report fanout target."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from service.agents.confluence_report_agent import _handle_thread
from service.agents.worker_result import write_worker_result


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        raise SystemExit("usage: python -m service.agents.confluence_report_worker <evidence_dir>")
    evidence_dir = Path(args[0])
    spec = json.loads((evidence_dir / "task_spec.json").read_text(encoding="utf-8"))
    thread = spec.get("target") or {}
    charter = str(spec.get("charter_ref") or "")
    try:
        result = _handle_thread(thread, evidence_dir=evidence_dir, charter_ref=charter)
    except Exception as e:  # noqa: BLE001
        write_worker_result(
            evidence_dir,
            status="error_crash",
            summary=f"confluence report worker failed: {e!r}",
            rc=1,
        )
        return 1
    (evidence_dir / "report_result.json").write_text(
        json.dumps({k: v for k, v in result.items() if k != "html"}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    delivery = result.get("delivery") if isinstance(result.get("delivery"), dict) else {}
    write_worker_result(
        evidence_dir,
        status="ok",
        summary=(
            f"thread={thread.get('id')}: report mode={delivery.get('mode') or 'unknown'} "
            f"findings={result.get('finding_count') or 0}"
        ),
        findings=int(result.get("finding_count") or 0),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
