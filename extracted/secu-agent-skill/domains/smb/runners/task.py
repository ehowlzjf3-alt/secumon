"""SMB task loop runner entrypoint."""
from __future__ import annotations

from service.agents.smb_task_loop import main


if __name__ == "__main__":
    raise SystemExit(main())
