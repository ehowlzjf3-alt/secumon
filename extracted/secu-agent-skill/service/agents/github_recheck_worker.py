"""Worker entrypoint for one GitHub remediation recheck fanout target."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from service.agents.github_recheck_agent import _handle_thread
from service.agents.worker_result import write_worker_result


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        raise SystemExit("usage: python -m service.agents.github_recheck_worker <evidence_dir>")
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
            summary=f"github recheck worker failed: {e!r}",
            rc=1,
        )
        return 1
    (evidence_dir / "recheck_result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    write_worker_result(
        evidence_dir,
        status="ok",
        summary=(
            f"thread={thread.get('id')}: final={result.get('final_status') or 'unknown'} "
            f"mode={(result.get('delivery') or {}).get('mode') if isinstance(result.get('delivery'), dict) else None}"
        ),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
