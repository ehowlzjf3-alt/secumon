"""Runtime prerequisite checks for local and Linux deployments.

The doctor intentionally avoids live network calls. It checks configuration,
local dependencies, browser installation, writable state paths, and PostgreSQL
state readiness so deployment failures are caught before starting the web UI.
"""
from __future__ import annotations

import importlib.util
import json
import os
import platform
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

from secu_agent import state

DoctorStatus = Literal["pass", "warn", "fail"]


@dataclass(frozen=True, slots=True)
class DoctorCheck:
    name: str
    status: DoctorStatus
    message: str
    details: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class DoctorReport:
    checks: Sequence[DoctorCheck]

    @property
    def fail_count(self) -> int:
        return sum(1 for check in self.checks if check.status == "fail")

    @property
    def warn_count(self) -> int:
        return sum(1 for check in self.checks if check.status == "warn")

    @property
    def ok(self) -> bool:
        return self.fail_count == 0


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _default_results_dir(env: Mapping[str, str] | None = None) -> Path:
    env = env or os.environ
    return Path(env.get("SA_RESULTS_DIR") or (_project_root() / "findings")).expanduser()


def _dedupe_paths(paths: list[Path]) -> list[Path]:
    seen: set[Path] = set()
    out: list[Path] = []
    for path in paths:
        resolved = path.expanduser()
        if resolved in seen:
            continue
        seen.add(resolved)
        out.append(resolved)
    return out


def find_playwright_chromium_paths(
    *,
    env: Mapping[str, str] | None = None,
    home: Path | None = None,
) -> list[Path]:
    """Return installed Playwright Chromium cache directories.

    Linux defaults to ``~/.cache/ms-playwright`` while macOS uses
    ``~/Library/Caches/ms-playwright``. ``PLAYWRIGHT_BROWSERS_PATH`` overrides
    those roots unless set to ``0`` for package-local browser storage.
    """
    env = env or os.environ
    home = (home or Path.home()).expanduser()
    configured = env.get("PLAYWRIGHT_BROWSERS_PATH")

    roots: list[Path]
    if configured and configured != "0":
        roots = [Path(configured).expanduser()]
    else:
        roots = [
            home / ".cache" / "ms-playwright",
            home / "Library" / "Caches" / "ms-playwright",
        ]

    matches: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        matches.extend(sorted(
            child for child in root.iterdir()
            if child.is_dir() and child.name.startswith("chromium-")
        ))
    return _dedupe_paths(matches)


def check_python_version() -> DoctorCheck:
    version = platform.python_version()
    details = {
        "version": version,
        "executable": sys.executable,
        "required": ">=3.12",
    }
    if sys.version_info < (3, 12):
        return DoctorCheck(
            name="python",
            status="fail",
            message=f"Python {version} is too old; project requires >=3.12",
            details=details,
        )
    return DoctorCheck(
        name="python",
        status="pass",
        message=f"Python {version} satisfies >=3.12",
        details=details,
    )


def check_platform() -> DoctorCheck:
    system = platform.system() or "unknown"
    details = {
        "system": system,
        "machine": platform.machine(),
        "release": platform.release(),
    }
    if system == "Linux":
        return DoctorCheck(
            name="platform",
            status="pass",
            message="Running on Linux",
            details=details,
        )
    return DoctorCheck(
        name="platform",
        status="warn",
        message=f"Running on {system}; production runtime target is Linux",
        details=details,
    )


def check_postgres_state() -> DoctorCheck:
    try:
        with state.connect() as conn:
            db_name = str(conn.execute("SELECT current_database()").fetchone()[0])
            server_version = str(conn.execute("SHOW server_version").fetchone()[0])
            schema_row = conn.execute(
                "SELECT value FROM state_meta WHERE key=?",
                ("schema_version",),
            ).fetchone()
            expected_tables = (
                "state_meta", "chat_session", "chat_message", "chat_goal",
                "chat_todo", "finding_lifecycle", "schedule",
            )
            # v3.88 코어 FULL-MOVE: 코어 프레임워크 테이블은 `core` 스키마 소유.
            existing_rows = conn.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema='core' AND table_name = ANY(?)",
                (list(expected_tables),),
            ).fetchall()
            # split-brain 감지: 이관 후 public 에 동명 코어 테이블이 잔존하면 안 된다.
            residue_rows = conn.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema='public' AND table_name = ANY(?)",
                (list(expected_tables),),
            ).fetchall()
    except Exception as exc:
        return DoctorCheck(
            name="postgres_state",
            status="fail",
            message=f"PostgreSQL state DB is not usable: {exc}",
            details={"path": str(state.db_label())},
        )

    schema_version = str(schema_row[0]) if schema_row else ""
    existing = sorted(str(row[0]) for row in existing_rows)
    missing_tables = sorted(set(expected_tables) - set(existing))
    public_residue = sorted(str(row[0]) for row in residue_rows)
    details = {
        "path": str(state.db_label()),
        "database": db_name,
        "server_version": server_version,
        "schema_version": schema_version,
        "expected_schema_version": state.SCHEMA_VERSION,
        "checked_tables": list(expected_tables),
        "missing_tables": missing_tables,
        "public_residue": public_residue,
    }
    if public_residue:
        return DoctorCheck(
            name="postgres_state",
            status="fail",
            message=(
                "core FULL-MOVE split-brain: 코어 테이블이 public 에 잔존 "
                f"({', '.join(public_residue)}) — core 로 이관 필요"
            ),
            details=details,
        )
    if schema_version != str(state.SCHEMA_VERSION):
        return DoctorCheck(
            name="postgres_state",
            status="fail",
            message=(
                "PostgreSQL schema version does not match the application "
                f"({schema_version or 'missing'} != {state.SCHEMA_VERSION})"
            ),
            details=details,
        )
    if missing_tables:
        return DoctorCheck(
            name="postgres_state",
            status="fail",
            message=f"PostgreSQL schema is missing tables: {', '.join(missing_tables)}",
            details=details,
        )
    return DoctorCheck(
        name="postgres_state",
        status="pass",
        message="PostgreSQL state DB is reachable and schema is current",
        details=details,
    )


def check_results_dir(
    *,
    env: Mapping[str, str] | None = None,
) -> DoctorCheck:
    path = _default_results_dir(env)
    marker = path / ".doctor-write-test"
    details = {"path": str(path)}
    try:
        path.mkdir(parents=True, exist_ok=True)
        marker.write_text("ok\n", encoding="utf-8")
        marker.unlink(missing_ok=True)
    except Exception as exc:
        return DoctorCheck(
            name="results_dir",
            status="fail",
            message=f"Evidence/results directory is not writable: {exc}",
            details=details,
        )
    return DoctorCheck(
        name="results_dir",
        status="pass",
        message="Evidence/results directory is writable",
        details=details,
    )


def check_websocket_dependency(
    *,
    find_spec: Callable[[str], object | None] = importlib.util.find_spec,
) -> DoctorCheck:
    available = [
        name for name in ("websockets", "wsproto")
        if find_spec(name) is not None
    ]
    if available:
        return DoctorCheck(
            name="websocket_dependency",
            status="pass",
            message=f"WebSocket backend available: {', '.join(available)}",
            details={"available": available},
        )
    return DoctorCheck(
        name="websocket_dependency",
        status="fail",
        message="No WebSocket backend found; install websockets or wsproto for uvicorn",
        details={"required_any_of": ["websockets", "wsproto"]},
    )


def check_playwright_chromium(
    *,
    env: Mapping[str, str] | None = None,
    home: Path | None = None,
    find_spec: Callable[[str], object | None] = importlib.util.find_spec,
) -> DoctorCheck:
    env = env or os.environ
    if find_spec("playwright") is None:
        return DoctorCheck(
            name="playwright_chromium",
            status="fail",
            message="Python package playwright is not installed",
            details={"install": "uv sync"},
        )

    if env.get("PLAYWRIGHT_BROWSERS_PATH") == "0":
        return DoctorCheck(
            name="playwright_chromium",
            status="warn",
            message="PLAYWRIGHT_BROWSERS_PATH=0 uses package-local browsers; Chromium cache not verified",
            details={"PLAYWRIGHT_BROWSERS_PATH": "0"},
        )

    paths = find_playwright_chromium_paths(env=env, home=home)
    if not paths:
        return DoctorCheck(
            name="playwright_chromium",
            status="fail",
            message="Playwright Chromium browser cache was not found",
            details={
                "install_linux": "uv run playwright install --with-deps chromium",
                "install_without_system_deps": "uv run playwright install chromium",
            },
        )
    return DoctorCheck(
        name="playwright_chromium",
        status="pass",
        message="Playwright Chromium browser cache is installed",
        details={"paths": [str(path) for path in paths]},
    )


def check_llm_profiles(
    *,
    env: Mapping[str, str] | None = None,
) -> DoctorCheck:
    from secu_agent.agent.llm.profile import load_profiles

    env = env or os.environ
    profile_path = Path(env.get(
        "SA_CHAT_PROFILES_PATH",
        str(_project_root() / "config" / "llm_profiles.yaml"),
    )).expanduser()
    requested_raw = env.get("SA_CHAT_PROFILE_CHAIN") or env.get("SA_CHAT_PROFILE") or "gemma"
    requested = [part.strip() for part in requested_raw.split(",") if part.strip()]
    details: dict[str, object] = {
        "path": str(profile_path),
        "requested": requested,
    }

    try:
        profiles = load_profiles(profile_path)
    except Exception as exc:
        return DoctorCheck(
            name="llm_profiles",
            status="fail",
            message=f"LLM profiles could not be loaded: {exc}",
            details=details,
        )

    missing = [name for name in requested if name not in profiles]
    details["available"] = sorted(profiles)
    if missing:
        details["missing"] = missing
        return DoctorCheck(
            name="llm_profiles",
            status="fail",
            message=f"Requested LLM profile(s) missing: {', '.join(missing)}",
            details=details,
        )

    empty_credentials: list[str] = []
    for name in requested:
        profile = profiles[name]
        if profile.auth.mode == "api_key" and not profile.auth.api_key:
            empty_credentials.append(f"{name}:auth.api_key")
        if profile.auth.mode == "headers":
            empty_headers = [key for key, value in profile.headers.items() if not value]
            empty_credentials.extend(f"{name}:headers.{key}" for key in empty_headers)

    if empty_credentials:
        details["empty_credentials"] = empty_credentials
        return DoctorCheck(
            name="llm_profiles",
            status="warn",
            message="LLM profile exists but has empty local credential fields",
            details=details,
        )
    return DoctorCheck(
        name="llm_profiles",
        status="pass",
        message=f"LLM profile selection is configured: {', '.join(requested)}",
        details=details,
    )


def check_chat_token(
    *,
    env: Mapping[str, str] | None = None,
) -> DoctorCheck:
    env = env or os.environ
    token = env.get("SA_CHAT_TOKEN")
    if not token or token == "devtoken":
        return DoctorCheck(
            name="chat_token",
            status="warn",
            message="SA_CHAT_TOKEN is not set or still uses the development default",
            details={"env": "SA_CHAT_TOKEN"},
        )
    return DoctorCheck(
        name="chat_token",
        status="pass",
        message="SA_CHAT_TOKEN is set",
        details={"env": "SA_CHAT_TOKEN"},
    )


def run_doctor() -> DoctorReport:
    checks = [
        check_python_version(),
        check_platform(),
        check_postgres_state(),
        check_results_dir(),
        check_websocket_dependency(),
        check_playwright_chromium(),
        check_llm_profiles(),
        check_chat_token(),
    ]
    return DoctorReport(checks=checks)


def render_json(report: DoctorReport) -> str:
    payload = {
        "ok": report.ok,
        "fail_count": report.fail_count,
        "warn_count": report.warn_count,
        "checks": [asdict(check) for check in report.checks],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False)


def render_text(report: DoctorReport) -> str:
    lines = [
        f"runtime doctor: {'ok' if report.ok else 'failed'} "
        f"({report.fail_count} fail, {report.warn_count} warn)",
    ]
    for check in report.checks:
        lines.append(f"[{check.status.upper()}] {check.name}: {check.message}")
        if check.status != "pass" and check.details:
            lines.append(f"  details: {json.dumps(check.details, ensure_ascii=False, sort_keys=True)}")
    return "\n".join(lines)
