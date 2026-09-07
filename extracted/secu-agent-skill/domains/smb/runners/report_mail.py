"""SMB report/mail loop runner entrypoint."""
from __future__ import annotations

from service.agents.report_mail_loop import main


if __name__ == "__main__":
    raise SystemExit(main())
