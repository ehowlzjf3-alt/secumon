from __future__ import annotations

from contextlib import contextmanager
import json


def test_report_ok_is_false_when_any_check_fails():
    from secu_agent.runtime_doctor import DoctorCheck, DoctorReport

    report = DoctorReport(checks=[
        DoctorCheck(name="python", status="pass", message="ok"),
        DoctorCheck(name="playwright", status="fail", message="missing chromium"),
    ])

    assert report.ok is False
    assert report.fail_count == 1
    assert report.warn_count == 0


def test_report_ok_allows_warnings():
    from secu_agent.runtime_doctor import DoctorCheck, DoctorReport

    report = DoctorReport(checks=[
        DoctorCheck(name="token", status="warn", message="dev token"),
    ])

    assert report.ok is True
    assert report.fail_count == 0
    assert report.warn_count == 1


def test_find_playwright_chromium_paths_uses_env_browser_path(tmp_path):
    from secu_agent.runtime_doctor import find_playwright_chromium_paths

    browser_root = tmp_path / "pw-browsers"
    chromium = browser_root / "chromium-1217"
    chromium.mkdir(parents=True)

    paths = find_playwright_chromium_paths(
        env={"PLAYWRIGHT_BROWSERS_PATH": str(browser_root)},
        home=tmp_path / "home",
    )

    assert paths == [chromium]


def test_find_playwright_chromium_paths_checks_linux_and_macos_cache(tmp_path):
    from secu_agent.runtime_doctor import find_playwright_chromium_paths

    linux_cache = tmp_path / ".cache" / "ms-playwright" / "chromium-1000"
    mac_cache = tmp_path / "Library" / "Caches" / "ms-playwright" / "chromium-2000"
    linux_cache.mkdir(parents=True)
    mac_cache.mkdir(parents=True)

    paths = find_playwright_chromium_paths(env={}, home=tmp_path)

    assert paths == [linux_cache, mac_cache]


def test_check_websocket_dependency_passes_when_backend_available():
    from secu_agent.runtime_doctor import check_websocket_dependency

    check = check_websocket_dependency(
        find_spec=lambda name: object() if name == "websockets" else None,
    )

    assert check.status == "pass"
    assert "websockets" in check.message


def test_check_websocket_dependency_fails_without_backend():
    from secu_agent.runtime_doctor import check_websocket_dependency

    check = check_websocket_dependency(find_spec=lambda _name: None)

    assert check.status == "fail"
    assert "websockets" in check.message


def test_check_postgres_state_passes_on_test_db(tmp_db):
    from secu_agent.runtime_doctor import check_postgres_state

    check = check_postgres_state()

    assert check.status == "pass"
    assert check.name == "postgres_state"
    assert check.details["schema_version"] == str(check.details["expected_schema_version"])
    assert check.details["missing_tables"] == []


def test_check_postgres_state_fails_closed_on_connect_error(monkeypatch):
    from secu_agent import runtime_doctor

    @contextmanager
    def broken_connect():
        raise RuntimeError("db down")
        yield  # pragma: no cover

    monkeypatch.setattr(runtime_doctor.state, "connect", broken_connect)

    check = runtime_doctor.check_postgres_state()

    assert check.status == "fail"
    assert check.name == "postgres_state"
    assert "PostgreSQL state DB is not usable" in check.message


def test_render_json_has_stable_shape():
    from secu_agent.runtime_doctor import DoctorCheck, DoctorReport, render_json

    payload = json.loads(render_json(DoctorReport(checks=[
        DoctorCheck(name="python", status="pass", message="3.13"),
    ])))

    assert payload == {
        "ok": True,
        "fail_count": 0,
        "warn_count": 0,
        "checks": [
            {"name": "python", "status": "pass", "message": "3.13", "details": {}},
        ],
    }
