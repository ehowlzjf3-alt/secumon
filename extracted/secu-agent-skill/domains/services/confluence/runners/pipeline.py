"""Confluence pipeline runner entrypoint."""
from __future__ import annotations

from service.agents.confluence_pipeline_runner import main


if __name__ == "__main__":
    raise SystemExit(main())
