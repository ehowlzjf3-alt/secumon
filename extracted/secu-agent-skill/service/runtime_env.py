"""Shared process bootstrap for domain services.

Domain entrypoints need the same environment hygiene whether they are web,
collector, or agent processes: load the skill repo `.env`, then the core engine
`.env`, and optionally load configured core plugins.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

log = logging.getLogger("service.runtime_env")


def load_runtime_env(*, load_plugins: bool = False) -> None:
    for env_path in _env_paths():
        if not env_path.exists():
            continue
        _load_env_file(env_path)
    if load_plugins:
        from secu_agent.plugins import load_plugins as _load_plugins

        _load_plugins()


def _env_paths() -> tuple[Path, Path]:
    repo_env = Path(__file__).resolve().parents[1] / ".env"
    engine = Path(os.environ.get("SA_ENGINE_DIR", str(Path.home() / "project" / "secu-agent")))
    return repo_env, engine / ".env"


def _load_env_file(path: Path) -> None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as e:
        log.warning("failed to read env file %s: %r", path, e)
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value
