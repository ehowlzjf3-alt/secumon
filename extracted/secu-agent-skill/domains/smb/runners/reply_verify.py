"""SMB reply/reverify loop runner entrypoint."""
from __future__ import annotations

from service.agents.reply_verify_loop import main


if __name__ == "__main__":
    raise SystemExit(main())
