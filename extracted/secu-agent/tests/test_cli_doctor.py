from __future__ import annotations

import json


def test_cli_doctor_json_returns_zero_when_report_has_no_failures(monkeypatch, capsys):
    from secu_agent import cli, runtime_doctor

    report = runtime_doctor.DoctorReport(checks=[
        runtime_doctor.DoctorCheck(name="python", status="pass", message="ok"),
    ])
    monkeypatch.setattr(runtime_doctor, "run_doctor", lambda: report)

    rc = cli.main(["doctor", "--json"])
    out = capsys.readouterr().out

    assert rc == 0
    assert json.loads(out)["ok"] is True


def test_cli_doctor_json_returns_one_when_report_has_failures(monkeypatch, capsys):
    from secu_agent import cli, runtime_doctor

    report = runtime_doctor.DoctorReport(checks=[
        runtime_doctor.DoctorCheck(name="db", status="fail", message="locked"),
    ])
    monkeypatch.setattr(runtime_doctor, "run_doctor", lambda: report)

    rc = cli.main(["doctor", "--json"])
    out = capsys.readouterr().out

    assert rc == 1
    assert json.loads(out)["fail_count"] == 1


def test_cli_web_loads_env_before_argparse_defaults(monkeypatch):
    """v3.76: 단일 postgres — env(PG DSN)가 argparse 기본값 적용 전에 로드됨."""
    from secu_agent import cli

    monkeypatch.delenv("SA_WEB_PORT", raising=False)
    calls = []
    captured = {}

    def fake_load_env_once():
        calls.append("load")
        monkeypatch.setenv("SA_WEB_PORT", "9876")
        monkeypatch.setenv(
            "SECU_AGENT_PG_DSN",
            "postgresql://agent_type:secret@db.example:5432/from_env_db",
        )

    def fake_cmd_web(args):
        captured["port"] = args.port
        captured["db"] = str(cli.state.db_label())
        return 0

    monkeypatch.setattr(cli, "_load_env_once", fake_load_env_once)
    monkeypatch.setattr(cli, "_cmd_web", fake_cmd_web)

    rc = cli.main(["web"])

    assert rc == 0
    assert calls == ["load"]
    assert captured == {
        "port": 9876,
        # db_label() 은 비번 마스킹 후 host:port/db 만 노출
        "db": "postgres://db.example:5432/from_env_db",
    }
