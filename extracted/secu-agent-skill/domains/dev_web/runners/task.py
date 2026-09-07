"""dev_web task runner entrypoint."""
from __future__ import annotations

from service.agents.dev_web_task_agent import main


if __name__ == "__main__":
    raise SystemExit(main())
