"""도메인-프리 소유 프로세스 레지스트리 + 고아 reaper (F5-B).

부모(우리)가 띄운 외부 프로세스(예: Playwright chromium)의 신원을 파일에 기록하고,
다음 기동 시 **owner 가 죽어 남은 고아만** 다중 검증 후 안전하게 회수한다. PID
재사용·사용자 프로세스(예: 사용자 개인 Chrome) 오살을 막기 위해, 신호하기 전에
아래를 **전부** 만족해야 한다(codex 합심 리뷰의 4중+ 검증):

  · registry 에 기록돼 있음
  · pid 의 현재 starttime 이 기록과 일치 (signal 직전 PID 재사용 차단)
  · boot_id 일치 (재부팅 후 stale 기록 차단)
  · owner(우리를 띄운 프로세스) 가 이미 종료됨 (살아있으면 정상 사용 중 — 안 건드림)
  · /proc/<pid>/environ 의 owner token 이 기록과 일치 (우리가 띄운 것임을 확증)
  · profile_dir 를 기록했으면 cmdline 의 `--user-data-dir` 도 일치

generic process-name scan / `pkill` 은 절대 하지 않는다. 확인 불가/모호하면 **누수를
택하고 kill 하지 않는다**(오살보다 누수가 낫다). 이 모듈은 leaf — stdlib 만 import 해
순환 의존을 만들지 않는다.
"""
from __future__ import annotations

import contextlib
import json
import logging
import os
import secrets
import signal
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("secu_agent.process_registry")

OWNER_TOKEN_ENV = "SA_PROC_OWNER_TOKEN"


# ── /proc 신원 프로브 (테스트에서 monkeypatch 가능한 모듈 함수) ──────────

def proc_starttime(pid: int) -> int | None:
    """/proc/<pid>/stat 의 starttime(field 22) — PID 재사용 구분자.

    부재/zombie/파싱불가/비리눅스 → None. reaper 는 None 을 절대 kill 하지
    않는다(오살보다 누수).
    """
    try:
        stat = Path(f"/proc/{pid}/stat").read_text(
            encoding="ascii", errors="replace",
        )
    except OSError:
        return None
    try:
        rest = stat.rsplit(")", 1)[1].split()
        if rest[0] == "Z":  # zombie = 이미 죽음
            return None
        return int(rest[19])  # field 22
    except (IndexError, ValueError):
        return None


def proc_pgid_sid(pid: int) -> tuple[int | None, int | None]:
    try:
        return os.getpgid(pid), os.getsid(pid)
    except OSError:
        return None, None


def boot_id() -> str | None:
    """부팅 세대 식별자 — 재부팅 후 stale registry 의 pid/starttime 오검증 차단."""
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text(
            encoding="ascii",
        ).strip()
    except OSError:
        return None


def proc_environ_var(pid: int, var: str) -> str | None:
    """/proc/<pid>/environ 에서 var 값을 읽는다 (owner token 확증용).

    권한 없음/부재/미포함 → None.
    """
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return None
    prefix = (var + "=").encode()
    for entry in raw.split(b"\0"):
        if entry.startswith(prefix):
            return entry[len(prefix):].decode("utf-8", "replace")
    return None


def proc_cmdline(pid: int) -> list[str]:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return []
    return [a.decode("utf-8", "replace") for a in raw.split(b"\0") if a]


def _pid_alive(pid: int, starttime: int) -> bool:
    """pid 가 기록된 starttime 그대로 살아있나 (PID 재사용이면 False)."""
    return proc_starttime(pid) == starttime


def new_owner_token() -> str:
    return secrets.token_hex(16)


def owner_signature() -> dict[str, Any]:
    """이 프로세스를 owner 로 기록하기 위한 서명."""
    pid = os.getpid()
    return {"pid": pid, "starttime": proc_starttime(pid)}


def _cmdline_has_user_data_dir(pid: int, profile_dir: str) -> bool:
    target = os.path.realpath(profile_dir)
    for arg in proc_cmdline(pid):
        if arg.startswith("--user-data-dir="):
            with contextlib.suppress(OSError):
                if os.path.realpath(arg.split("=", 1)[1]) == target:
                    return True
    return False


def _valid_pid(x: Any) -> bool:
    """유효 PID: 진짜 int(bool 제외) ∧ 양수. 손상 서명(True/0/음수) 거부."""
    return isinstance(x, int) and not isinstance(x, bool) and x > 0


def _valid_starttime(x: Any) -> bool:
    """유효 starttime: 진짜 int(bool 제외) ∧ 음수 아님."""
    return isinstance(x, int) and not isinstance(x, bool) and x >= 0


def _proc_exists_status(pid: int) -> str:
    """/proc/<pid> 존재를 **tri-state** 로 (codex: 부재와 probe 실패 구분).
    'exists' | 'gone'(ENOENT=확실 부재) | 'unknown'(권한·I/O 등 확인 불가).
    테스트에서 patch 가능."""
    try:
        os.stat(f"/proc/{pid}")
        return "exists"
    except FileNotFoundError:
        return "gone"
    except OSError:
        return "unknown"


def _owner_status(owner: Any) -> str:
    """owner 프로세스 상태 — 'alive' | 'gone' | 'unknown' (codex Blocker1).

    회수는 owner 가 **확실히 죽었을 때('gone')만** 허용한다. 'unknown'(=확인 불가)은
    절대 회수 금지 — 살아있는 owner 의 browser 를 probe 일시 실패로 오살하지 않는다.
      · gone    = /proc 완전 부재(ENOENT), 또는 정상 읽은 starttime 불일치(PID 재사용)
      · unknown = 서명 손상/비유효, existence probe 실패, 존재하나 starttime 불명
      · alive   = pid 존재 ∧ starttime 일치
    """
    if not isinstance(owner, dict):
        return "unknown"
    op, ost = owner.get("pid"), owner.get("starttime")
    if not _valid_pid(op) or not _valid_starttime(ost):
        return "unknown"
    st = _proc_exists_status(op)
    if st == "gone":
        return "gone"  # ENOENT = 확실 부재
    if st == "unknown":
        return "unknown"  # probe 실패 → 보수적(살아있을 수 있음)
    cur = proc_starttime(op)
    if cur is None:
        return "unknown"  # 존재하나 starttime 불명(zombie/권한/parse) → 보수적
    return "alive" if cur == ost else "gone"


# register 기록 시 extra 가 덮어쓰면 안 되는 안전 필드 (codex 리뷰).
_RESERVED_REC_KEYS = frozenset({
    "kind", "starttime", "pgid", "sid", "boot_id", "owner", "token", "profile_dir",
})


# ── 레지스트리 파일 (원자적 쓰기; 단일 프로세스-트리 전용 경로 가정) ──────

class ProcessRegistry:
    """소유 외부 프로세스 신원 기록. registry_path 는 owner 프로세스-트리 전용."""

    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._entries: dict[str, dict[str, Any]] = {}
        # 기존 파일 로드 — register/unregister 가 인스턴스 churn 에도 정확하게
        # 동작하도록(예: 브라우저 stop 시 새 인스턴스가 unregister). 손상/부재는 무시.
        loaded = _load_entries(self._path)
        if isinstance(loaded, dict):
            self._entries = {k: v for k, v in loaded.items() if isinstance(v, dict)}

    def register(
        self, pid: int, *, token: str, kind: str,
        profile_dir: str | None = None, extra: dict[str, Any] | None = None,
    ) -> bool:
        """등록하고 디스크 기록 성공 여부를 반환(성공을 flush 성공에 묶음)."""
        pgid, sid = proc_pgid_sid(pid)
        rec: dict[str, Any] = {
            "kind": kind,
            "starttime": proc_starttime(pid),
            "pgid": pgid,
            "sid": sid,
            "boot_id": boot_id(),
            "owner": owner_signature(),
            "token": token,
            "profile_dir": (
                os.path.realpath(profile_dir) if profile_dir else None
            ),
        }
        if extra:
            # 안전 필드(owner/starttime/boot/token 등)는 extra 로 덮어쓸 수 없다.
            rec.update({k: v for k, v in extra.items()
                        if k not in _RESERVED_REC_KEYS})
        self._entries[str(pid)] = rec
        return self._flush()

    def unregister(self, pid: int) -> bool:
        if self._entries.pop(str(pid), None) is not None:
            return self._flush()
        return True

    def _flush(self) -> bool:
        """디스크 반영. 성공 여부 반환(등록 성공을 파일 기록 성공에 묶기 위함).
        registry 는 소유 토큰을 담으므로 dir 0700 / file 0600 로 제한."""
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with contextlib.suppress(OSError):
                os.chmod(self._path.parent, 0o700)
            if not self._entries:
                self._path.unlink(missing_ok=True)
                return True
            tmp = self._path.parent / (self._path.name + ".tmp")
            payload = json.dumps(self._entries, ensure_ascii=False)
            # os.open 으로 **생성부터 0600 보장** — umask/chmod 실패와 무관하게 토큰이
            # world-readable 로 새지 않게 한다(codex 리뷰: chmod 실패 경로).
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, payload.encode("utf-8"))
            finally:
                os.close(fd)
            os.replace(tmp, self._path)
            return True
        except OSError as e:
            # 기록 실패가 헌트를 막으면 안 됨 — reaper 는 부모 crash 백스톱일 뿐.
            log.warning("process registry 기록 실패 (%s): %r", self._path, e)
            return False


def _entry_is_reapable_orphan(
    pid: int, rec: Any, *, token_var: str, cur_boot: str | None,
) -> bool:
    """이 기록이 '안전하게 회수 가능한 고아'인가 — **전부 충족해야만** True.
    하나라도 검증 불가/모호하면 False(무신호 — 오살보다 누수). 신호 직전마다 재호출해
    PID 재사용 TOCTOU 도 닫는다(codex Blocker2)."""
    if not isinstance(rec, dict):
        return False
    # ① target pid + starttime 일치 (PID 재사용 차단). starttime 은 유효 int 만.
    recorded_start = rec.get("starttime")
    if not _valid_starttime(recorded_start) or not _pid_alive(pid, recorded_start):
        return False
    # ② boot_id **필수·비어있지 않음·일치** (누락/빈값 = 검증불가 = 무신호)
    rec_boot = rec.get("boot_id")
    if not isinstance(rec_boot, str) or not rec_boot:
        return False
    if not isinstance(cur_boot, str) or not cur_boot or rec_boot != cur_boot:
        return False
    # ③ owner 가 **확실히 죽었을 때(gone)만** — alive/unknown = 무신호(codex Blocker1)
    if _owner_status(rec.get("owner")) != "gone":
        return False
    # ④ owner token 이 /proc/<pid>/environ 과 일치 (우리가 띄운 것 확증 — 신호 직전
    #    재검증으로 PID 재사용 프로세스는 우리 토큰이 없어 걸러진다)
    token = rec.get("token")
    if not isinstance(token, str) or not token:
        return False
    if proc_environ_var(pid, token_var) != token:
        return False
    # ⑤ profile_dir 기록 시 cmdline --user-data-dir 도 일치
    profile_dir = rec.get("profile_dir")
    if profile_dir and not _cmdline_has_user_data_dir(pid, str(profile_dir)):
        return False
    return True


def _load_entries(path: Path) -> dict[str, Any] | None:
    """registry 파일 로드. 부재 → None. 파싱불가/비dict → {}."""
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as e:
        log.warning("process registry 읽기 실패 (%s): %r", path, e)
        return None
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except ValueError:
        return {}


def _collect_reapable(
    entries: dict[str, Any], *, token_var: str, cur_boot: str | None,
    require_kind: str | None = None,
) -> dict[int, dict[str, Any]]:
    """검증을 통과한 회수 가능 고아만 {pid: rec} 로 추린다(신호 직전 재검증용 rec 보존)."""
    reapable: dict[int, dict[str, Any]] = {}
    for pid_s, rec in entries.items():
        if not isinstance(rec, dict):
            continue
        if require_kind is not None and rec.get("kind") != require_kind:
            continue
        try:
            pid = int(pid_s)
        except (TypeError, ValueError):
            continue
        if _entry_is_reapable_orphan(
            pid, rec, token_var=token_var, cur_boot=cur_boot,
        ):
            reapable[pid] = rec
    return reapable


def _any_owner_alive(entries: dict[str, Any]) -> bool:
    """이 파일의 registration 을 만든 owner 프로세스가 하나라도 확실히 살아있나.

    살아있으면(alive) = 정상 가동 중인 프로세스의 파일 → dir reaper 가 삭제하면 안 된다.
    'unknown'(확인 불가)도 보수적으로 살아있는 것처럼 취급해 오삭제를 막는다.
    손상된 non-dict owner 도 `_owner_status` 가 'unknown' 으로 안전 처리(스캔 중단 방지).
    """
    if not isinstance(entries, dict):
        return False
    for rec in entries.values():
        if not isinstance(rec, dict):
            continue
        if _owner_status(rec.get("owner")) in ("alive", "unknown"):
            return True
    return False


def _signal_and_wait(
    reapable: dict[int, dict[str, Any]], grace_sec: float, *,
    token_var: str, cur_boot: str | None,
) -> list[int]:
    """검증된 고아에 배치 TERM→공통 grace→KILL. **신호(TERM·KILL) 직전마다 전체
    게이트(starttime+token+owner-gone)를 재검증**한다(codex Blocker2): 수집~신호 사이
    원 프로세스가 죽고 PID 가 재사용되면 새 프로세스엔 우리 토큰이 없어 재검증에서
    걸러져 신호가 안 간다. 파일당이 아니라 배치 grace 라 startup 지연이 누적되지 않는다."""
    def _still(pid: int, rec: dict[str, Any]) -> bool:
        return _entry_is_reapable_orphan(
            pid, rec, token_var=token_var, cur_boot=cur_boot,
        )

    signalled: list[tuple[int, dict[str, Any]]] = []
    for pid, rec in reapable.items():
        if not _still(pid, rec):  # 신호 직전 재검증
            continue
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            continue
        signalled.append((pid, rec))
    if signalled:
        log.warning("고아 프로세스 %d개 SIGTERM: %s",
                    len(signalled), [p for p, _ in signalled])

    deadline = time.monotonic() + grace_sec
    pending = list(signalled)
    while pending and time.monotonic() < deadline:
        pending = [(p, r) for (p, r) in pending
                   if proc_starttime(p) == r.get("starttime")]
        if pending:
            time.sleep(0.05)
    for pid, rec in pending:
        if not _still(pid, rec):  # SIGKILL 직전 전체 재검증(token 포함)
            continue
        log.warning("고아 프로세스 grace 초과 — SIGKILL: pid=%s", pid)
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.kill(pid, signal.SIGKILL)
    return [p for p, _ in signalled]


def reap_orphaned_processes(
    registry_path: Path, *, token_var: str = OWNER_TOKEN_ENV,
    grace_sec: float = 5.0,
) -> list[int]:
    """단일 registry 파일 — 기동 시 1회, 소유 고아를 다중검증 후 TERM→grace→KILL.
    검증 실패/모호 = 건드리지 않음(누수 택). 파일은 처리 후 삭제. 반환: SIGTERM
    보낸 pid 목록. **단일 프로세스-트리 전용** 경로일 때만 사용(다중 프로세스가
    공유하면 `reap_orphaned_in_dir` 을 쓸 것 — 살아있는 파일 오삭제 방지)."""
    entries = _load_entries(registry_path)
    if entries is None:
        return []
    cur_boot = boot_id()
    signalled = _signal_and_wait(
        _collect_reapable(entries, token_var=token_var, cur_boot=cur_boot),
        grace_sec, token_var=token_var, cur_boot=cur_boot,
    )
    with contextlib.suppress(OSError):
        registry_path.unlink(missing_ok=True)
    return signalled


def reap_orphaned_in_dir(
    dir_path: Path, *, token_var: str = OWNER_TOKEN_ENV, grace_sec: float = 5.0,
    glob: str = "*.json", require_kind: str | None = None,
) -> list[int]:
    """디렉토리 안의 **프로세스별** registry 파일들을 스캔해 고아를 회수한다
    (여러 프로세스가 각자 자기 파일을 쓰는 경우 — 브라우저처럼).

    codex 리뷰 반영: ① 모든 파일에서 회수대상을 **배치 수집** 후 **한 번의**
    TERM→공통 grace→KILL (파일당 grace 누적 = startup 340s 문제 제거) ② `require_kind`
    로 예상 종류만 ③ 파일 삭제는 owner 가 죽었을 때만 하되, **삭제 직전 파일을 다시 읽어**
    그 사이 새 살아있는 owner 가 os.replace 로 갈아끼웠으면 보존(ABA 방어).
    반환: SIGTERM 보낸 pid 목록.
    """
    dir_path = Path(dir_path)
    if not dir_path.is_dir():
        return []
    cur_boot = boot_id()
    files = sorted(dir_path.glob(glob))
    all_reapable: dict[int, dict[str, Any]] = {}
    snapshots: dict[Path, dict[str, Any]] = {}
    for f in files:
        entries = _load_entries(f)
        if entries is None:
            continue
        snapshots[f] = entries
        all_reapable.update(_collect_reapable(
            entries, token_var=token_var, cur_boot=cur_boot,
            require_kind=require_kind,
        ))
    signalled = _signal_and_wait(
        all_reapable, grace_sec, token_var=token_var, cur_boot=cur_boot,
    )
    for f, entries in snapshots.items():
        if _any_owner_alive(entries):
            continue  # snapshot 기준 살아있는 프로세스의 파일 — 보존
        fresh = _load_entries(f)  # 삭제 직전 재확인 — ABA(replace) 방어
        if fresh is not None and _any_owner_alive(fresh):
            continue
        with contextlib.suppress(OSError):
            f.unlink(missing_ok=True)
    return signalled
