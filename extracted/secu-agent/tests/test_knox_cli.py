"""knox-bridge CLI 서브커맨드 — 파싱 + 방 없으면 1 반환(네트워크 미접촉)."""
from __future__ import annotations

from secu_agent import cli


def test_knox_bridge_no_rooms_returns_1(tmp_path, monkeypatch, capsys):
    # 빈/없는 설정 → 데몬 접속 전에 1 반환
    monkeypatch.setenv("SA_KNOX_ROOMS_PATH", str(tmp_path / "nope.yaml"))
    rc = cli.main(["knox-bridge"])
    assert rc == 1
    err = capsys.readouterr().err
    assert "허용 설정이 비어 있음" in err


def test_knox_bridge_parses_flags(tmp_path, monkeypatch):
    # --rooms 가 빈 파일이면 마찬가지로 1 (파싱 자체는 성공)
    p = tmp_path / "empty.yaml"
    p.write_text("rooms: {}\n", encoding="utf-8")
    rc = cli.main(["knox-bridge", "--rooms", str(p), "--daemon",
                   "http://127.0.0.1:9999", "--verbose"])
    assert rc == 1
