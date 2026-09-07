"""F5-B: 소유 프로세스 레지스트리 + 고아 reaper 다중검증.

안전-크리티컬: 검증(pid+starttime ∧ boot_id ∧ owner 사망 ∧ token ∧ profile) 전부
충족해야만 회수. 하나라도 어긋나면(owner 생존·token 불일치·PID재사용) 절대 안 죽인다.
"""
from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import time

import pytest

from secu_agent.agent import process_registry as pr
from secu_agent.agent.process_registry import (
    OWNER_TOKEN_ENV,
    ProcessRegistry,
    boot_id,
    new_owner_token,
    proc_starttime,
    reap_orphaned_processes,
)

linux_only = pytest.mark.skipif(
    not sys.platform.startswith("linux"), reason="/proc 신원 검증은 Linux 전용",
)


def _spawn_with_token(token: str):
    env = {**os.environ, OWNER_TOKEN_ENV: token}
    return subprocess.Popen(
        [sys.executable, "-c", "import time;time.sleep(60)"], env=env,
    )


def _dead_owner() -> dict:
    """확실히 죽은 owner 서명 (starttime 불일치로 사망 판정)."""
    d = subprocess.Popen([sys.executable, "-c", "pass"])
    d.wait()
    return {"pid": d.pid, "starttime": 999_999_999}


def _write_reg(path, pid, token, *, owner, starttime=None, extra=None):
    rec = {
        "kind": "browser",
        "starttime": starttime if starttime is not None else proc_starttime(pid),
        "pgid": None, "sid": None, "boot_id": boot_id(),
        "owner": owner, "token": token, "profile_dir": None,
    }
    if extra:
        rec.update(extra)
    path.write_text(json.dumps({str(pid): rec}))


def _wait_dead(pid, timeout=5.0) -> bool:
    deadline = time.monotonic() + timeout
    while proc_starttime(pid) is not None and time.monotonic() < deadline:
        time.sleep(0.05)
    return proc_starttime(pid) is None


@linux_only
def test_reap_kills_verified_orphan(tmp_path):
    token = new_owner_token()
    p = _spawn_with_token(token)
    try:
        path = tmp_path / "procs.json"
        _write_reg(path, p.pid, token, owner=_dead_owner())
        signalled = reap_orphaned_processes(path, grace_sec=3.0)
        assert p.pid in signalled
        assert _wait_dead(p.pid), "검증된 고아가 회수되지 않음"
        assert not path.exists()  # registry 정리됨
    finally:
        with contextlib.suppress(ProcessLookupError):
            p.kill()
            p.wait()


@linux_only
def test_reap_skips_when_owner_alive(tmp_path):
    # owner(우리)가 살아있으면 정상 사용 중 → 절대 안 죽인다.
    token = new_owner_token()
    p = _spawn_with_token(token)
    try:
        path = tmp_path / "procs.json"
        _write_reg(path, p.pid, token,
                   owner={"pid": os.getpid(), "starttime": proc_starttime(os.getpid())})
        signalled = reap_orphaned_processes(path, grace_sec=1.0)
        assert signalled == []
        assert proc_starttime(p.pid) is not None  # 살아있음
    finally:
        with contextlib.suppress(ProcessLookupError):
            p.kill()
            p.wait()


@linux_only
def test_reap_skips_on_token_mismatch(tmp_path):
    # /proc/<pid>/environ 의 token 이 기록과 다르면 우리가 띄운 게 아니다 → 안 죽인다.
    p = _spawn_with_token("real-token-in-env")
    try:
        path = tmp_path / "procs.json"
        _write_reg(path, p.pid, "WRONG-token", owner=_dead_owner())
        signalled = reap_orphaned_processes(path, grace_sec=1.0)
        assert signalled == []
        assert proc_starttime(p.pid) is not None
    finally:
        with contextlib.suppress(ProcessLookupError):
            p.kill()
            p.wait()


@linux_only
def test_reap_skips_on_starttime_mismatch(tmp_path):
    # 기록 starttime 이 현재와 다르면 PID 재사용 가능성 → 안 죽인다.
    token = new_owner_token()
    p = _spawn_with_token(token)
    try:
        path = tmp_path / "procs.json"
        _write_reg(path, p.pid, token, owner=_dead_owner(),
                   starttime=(proc_starttime(p.pid) or 0) + 12345)
        signalled = reap_orphaned_processes(path, grace_sec=1.0)
        assert signalled == []
        assert proc_starttime(p.pid) is not None
    finally:
        with contextlib.suppress(ProcessLookupError):
            p.kill()
            p.wait()


@linux_only
def test_reap_skips_on_boot_id_mismatch(tmp_path, monkeypatch):
    # 재부팅 후 stale 기록 — boot_id 불일치 → 안 죽인다.
    token = new_owner_token()
    p = _spawn_with_token(token)
    try:
        path = tmp_path / "procs.json"
        _write_reg(path, p.pid, token, owner=_dead_owner(),
                   extra={"boot_id": "stale-boot-id-from-previous-boot"})
        signalled = reap_orphaned_processes(path, grace_sec=1.0)
        assert signalled == []
        assert proc_starttime(p.pid) is not None
    finally:
        with contextlib.suppress(ProcessLookupError):
            p.kill()
            p.wait()


def test_reap_missing_registry_is_noop(tmp_path):
    assert reap_orphaned_processes(tmp_path / "nope.json") == []


def test_registry_register_unregister_roundtrip(tmp_path):
    path = tmp_path / "procs.json"
    reg = ProcessRegistry(path)
    reg.register(os.getpid(), token="tok", kind="browser")
    data = json.loads(path.read_text())
    assert str(os.getpid()) in data
    assert data[str(os.getpid())]["token"] == "tok"
    reg.unregister(os.getpid())
    assert not path.exists()  # 비면 파일 삭제


def test_entry_reapable_requires_all_checks(monkeypatch):
    # target 500 존재/starttime 111, owner 999 는 부재(gone).
    monkeypatch.setattr(pr, "_proc_exists_status",
                        lambda pid: "exists" if pid == 500 else "gone")
    monkeypatch.setattr(pr, "proc_starttime", lambda pid: 111 if pid == 500 else None)
    monkeypatch.setattr(pr, "proc_environ_var", lambda pid, var: "tok")
    rec = {
        "starttime": 111, "boot_id": "b1", "token": "tok",
        "owner": {"pid": 999, "starttime": 222}, "profile_dir": None,
    }
    # 전부 통과(target 일치·boot 일치·owner gone·token 일치) → True.
    assert pr._entry_is_reapable_orphan(500, rec, token_var="X", cur_boot="b1") is True
    # token 불일치 → False
    monkeypatch.setattr(pr, "proc_environ_var", lambda pid, var: "other")
    assert pr._entry_is_reapable_orphan(500, rec, token_var="X", cur_boot="b1") is False


def test_entry_not_reapable_when_owner_unknown(monkeypatch):
    # codex Blocker1: owner 존재하나 starttime 불명(zombie/권한/parse), 또는 existence
    # probe 실패 = unknown → 무신호(살아있는 owner 오살 금지).
    monkeypatch.setattr(pr, "proc_starttime", lambda pid: 111 if pid == 500 else None)
    monkeypatch.setattr(pr, "proc_environ_var", lambda pid, var: "tok")
    rec = {"starttime": 111, "boot_id": "b1", "token": "tok",
           "owner": {"pid": 999, "starttime": 222}, "profile_dir": None}
    # 존재하나 starttime 불명 → unknown
    monkeypatch.setattr(pr, "_proc_exists_status",
                        lambda pid: "exists" if pid in (500, 999) else "gone")
    assert pr._owner_status(rec["owner"]) == "unknown"
    assert pr._entry_is_reapable_orphan(500, rec, token_var="X", cur_boot="b1") is False
    # existence probe 자체 실패(unknown) → unknown → 무신호
    monkeypatch.setattr(pr, "_proc_exists_status",
                        lambda pid: "exists" if pid == 500 else "unknown")
    assert pr._owner_status(rec["owner"]) == "unknown"
    assert pr._entry_is_reapable_orphan(500, rec, token_var="X", cur_boot="b1") is False


def test_owner_status_rejects_corrupt_signatures():
    # True/0/음수 PID, 비정수 starttime = 손상 서명 → unknown (gone 으로 오분류 금지).
    assert pr._owner_status({"pid": True, "starttime": 5}) == "unknown"
    assert pr._owner_status({"pid": 0, "starttime": 5}) == "unknown"
    assert pr._owner_status({"pid": -1, "starttime": 5}) == "unknown"
    assert pr._owner_status({"pid": 123, "starttime": True}) == "unknown"
    assert pr._owner_status({"pid": 123, "starttime": "x"}) == "unknown"
    assert pr._owner_status("not-a-dict") == "unknown"
    assert pr._owner_status(None) == "unknown"


def test_entry_not_reapable_when_boot_or_owner_missing(monkeypatch):
    # codex Blocker1: boot_id 누락/빈값·owner None/손상 = 검증불가 → 무신호(fail-open 금지).
    monkeypatch.setattr(pr, "_proc_exists_status",
                        lambda pid: "exists" if pid == 500 else "gone")
    monkeypatch.setattr(pr, "proc_starttime", lambda pid: 111 if pid == 500 else None)
    monkeypatch.setattr(pr, "proc_environ_var", lambda pid, var: "tok")
    base = {"starttime": 111, "token": "tok",
            "owner": {"pid": 999, "starttime": 222}, "profile_dir": None}
    ok = {**base, "boot_id": "b1"}
    # 대조군: 전부 갖추면 True
    assert pr._entry_is_reapable_orphan(500, ok, token_var="X", cur_boot="b1") is True
    # boot_id 누락 → False
    assert pr._entry_is_reapable_orphan(500, {**base}, token_var="X", cur_boot="b1") is False
    # 빈 boot 문자열끼리도 통과 금지 → False
    assert pr._entry_is_reapable_orphan(
        500, {**base, "boot_id": ""}, token_var="X", cur_boot="") is False
    # cur_boot None → False
    assert pr._entry_is_reapable_orphan(500, ok, token_var="X", cur_boot=None) is False
    # owner None → unknown → False
    assert pr._entry_is_reapable_orphan(
        500, {**ok, "owner": None}, token_var="X", cur_boot="b1") is False
    # owner 손상(non-dict) → unknown → False, 예외 없음
    assert pr._entry_is_reapable_orphan(
        500, {**ok, "owner": "corrupt"}, token_var="X", cur_boot="b1") is False


def test_register_rejects_reserved_extra_override(tmp_path):
    # codex: extra 가 owner/token/starttime 같은 안전 필드를 덮어쓰면 안 된다.
    reg = ProcessRegistry(tmp_path / "p.json")
    ok = reg.register(os.getpid(), token="tok", kind="browser",
                      extra={"token": "HIJACK", "owner": {"pid": 1}, "note": "keep"})
    assert ok is True
    data = json.loads((tmp_path / "p.json").read_text())
    rec = data[str(os.getpid())]
    assert rec["token"] == "tok"           # 덮어쓰기 거부됨
    assert rec["owner"]["pid"] == os.getpid()
    assert rec["note"] == "keep"           # 비예약 필드는 허용


def test_any_owner_alive_survives_corrupt_records():
    # 손상된 non-dict owner 가 스캔을 중단시키지 않는다(codex: .get() 예외 방지).
    entries = {"1": {"owner": "corrupt"}, "2": "not-a-dict",
               "3": {"owner": {"pid": os.getpid(), "starttime": proc_starttime(os.getpid())}}}
    assert pr._any_owner_alive(entries) is True  # 3 의 owner(우리) 살아있음
