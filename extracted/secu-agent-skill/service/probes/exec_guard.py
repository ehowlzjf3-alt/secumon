"""smb_python / smb_task_python 우회 억제 가드 — best-effort(보안 경계 아님).

## 배경
`smb_task_python`·`smb_python` 은 워커(gpt-oss)가 임의 Python 을 실행하는 도구다.
3rd-party import 가 자유라 `import pytds; pytds.connect(host, user, pw)` 한 줄로
크리덴셜 로그인 프로브(`credential_login_probe.py`)의 안전봉투 — 중앙 단발원장·
scope allowlist·회로차단기·평문격리·enc_login_only — 를 통째로 우회할 수 있다.

## ⚠️ 보안 주장의 한계 (codex 레드팀 결론, 정직하게 명시)
**동일 인터프리터 안의 가드는 임의 Python 에 대한 강제 경계가 될 수 없다.**
Python 공식 문서도 `sys.addaudithook` 은 샌드박스가 아니라고 명시한다. 확정적 잔여:
  - 네이티브 드라이버(libpq/ODBC/FreeTDS)는 `socket.connect` 감사 이벤트를 아예 안 낸다.
  - `hook.__closure__[0].cell_contents` 변조·새 subinterpreter·fork·native `connect(2)`.
  - 이미 열린 FD 재사용(`os.dup`/`socket.fromfd`/pool 커넥션 탈취), SOCKS/relay, 비표준 포트.
따라서 이 모듈의 목적은 **"워커가 편의상 옆문으로 새는 것"을 확실히 실패시키고
승인된 도구로 유도**하는 것이다(오작동 방지 + 탐지). 진짜 강제 경계가 필요하면
exec 를 별도 단명 프로세스/네트워크 네임스페이스로 격리해야 한다(별도 과제).

## 3중 방어(우회 난이도를 단계적으로 올림)
- **정적(AST)**: DB 드라이버 import(alias·`from` 포함), 동적 import(`__import__`/
  `importlib`), `sys.modules`/`.modules`, 내부 모듈(`service`/`secu_agent`/`domains`)
  import(가드 자체 접근 차단), 동시성 모듈(thread/asyncio/multiprocessing — `with` 수명
  밖 지연 로그인 차단), `exec`/`eval`/`compile`/`vars`, `.__globals__`/`.__dict__`,
  `.raw`(state 커넥션의 실제 psycopg 커넥션 노출) 거부.
- **런타임(audit hook)**: exec 구간에서만 DB 포트 `socket.connect` 차단,
  프로세스 실행·fork·`sys.addaudithook`(훅 오염) 차단. 게이트 상태는 **클로저 셀**에
  두어 모듈 전역 재바인딩(`eg._GUARD_DEPTH = 0`)으로는 못 끈다. 해제는 enter 가
  발급한 토큰을 가진 쪽만 가능.
- **namespace 프록시**: `__getattribute__` 로 전 속성 심사(모듈 반환 거부) —
  `state.psycopg`/`getattr(state,"psy"+"copg")`/`state._mod` 전부 차단.

## 오탐 방지
state DB(Postgres)는 이 도구의 정당한 기능이므로 `SECU_AGENT_PG_DSN` 엔드포인트는
allowlist 통과. 승인된 로그인 프로브는 `approved_probe()` 로 자기 스레드에서 가드를
면제받는다(동시 실행 중인 exec 가 프로브의 단발 시도를 오염시키지 않게).
가드 밖에서는 훅이 즉시 return.
"""
from __future__ import annotations

import ast
import os
import sys
import threading
from typing import Any
from urllib.parse import urlparse

# ── 차단 대상 모듈 (import root 이름) ──────────────────────────────────────
_DB_DRIVERS: frozenset[str] = frozenset({
    # MSSQL
    "pytds", "pymssql", "pyodbc", "aioodbc", "adodbapi",
    # PostgreSQL
    "psycopg", "psycopg2", "asyncpg", "pg8000",
    # MySQL/MariaDB
    "MySQLdb", "pymysql", "mysql", "mysqlclient", "aiomysql", "mariadb",
    # Oracle
    "cx_Oracle", "oracledb",
    # NoSQL / 기타 데이터스토어
    "pymongo", "motor", "redis", "aioredis", "cassandra", "clickhouse_driver",
    "clickhouse_connect", "ibm_db", "ibm_db_dbi", "firebirdsql", "fdb",
    "sqlanydb", "neo4j", "elasticsearch", "opensearchpy", "memcache", "pylibmc",
    # ORM/추상화
    "sqlalchemy", "databases", "peewee", "pyhive", "impala", "trino", "presto",
    # 네이티브 호출 경로
    "ctypes", "cffi", "_ctypes",
})
# 가드 자체·엔진 내부 도달 차단(`import service.probes.exec_guard as eg` 로 게이트 변조)
_INTERNAL_ROOTS: frozenset[str] = frozenset({
    "service", "secu_agent", "domains", "_xxsubinterpreters", "_interpreters",
})
# `with` 수명 밖 지연 실행(스레드/태스크/프로세스)로 가드를 빠져나가는 경로
_CONCURRENCY_ROOTS: frozenset[str] = frozenset({
    "threading", "_thread", "thread", "asyncio", "multiprocessing",
    "concurrent", "subprocess", "sched", "signal",
})
# 동적 import 경로
_IMPORT_ROOTS: frozenset[str] = frozenset({"importlib"})

_BLOCKED_MODULES: frozenset[str] = (
    _DB_DRIVERS | _INTERNAL_ROOTS | _CONCURRENCY_ROOTS | _IMPORT_ROOTS
)

_BLOCKED_ATTR_NAMES = frozenset({
    "modules",          # sys.modules (alias 무관)
    "import_module", "reload",
    "raw",              # state 커넥션의 실제 psycopg connection 노출
    "addaudithook",
    "fork", "forkpty", "posix_spawn", "system", "popen", "execv", "execve",
    "_mod",             # GuardedNamespace 내부
})
_BLOCKED_DUNDERS = frozenset({
    "__globals__", "__dict__", "__builtins__", "__loader__", "__spec__",
    "__getattribute__", "__subclasshook__", "__init_subclass__", "__mro__",
    "__base__", "__bases__", "__subclasses__", "__closure__", "__code__",
    "__self__", "__func__", "__wrapped__",
})
_BLOCKED_CALL_NAMES = frozenset({
    # 정적 심사 자체를 우회하는 호출만. `getattr`/`setattr` 은 워커가 흔히 쓰는 정상
    # 패턴이라 정적 차단하지 않는다(오탐) — 동적 드라이버 접근은 GuardedNamespace 가
    # 런타임에 막는다.
    "__import__", "vars", "globals", "eval", "exec", "compile",
})

# ── 런타임 차단 DB 포트 ────────────────────────────────────────────────────
_DB_PORTS_DEFAULT: frozenset[int] = frozenset({
    1433, 1434,          # MSSQL (+ browser)
    3306, 3307,          # MySQL/MariaDB
    5432, 5433,          # PostgreSQL
    1521, 1526, 2483, 2484,  # Oracle
    27017, 27018, 27019,  # MongoDB
    6379, 6380,          # Redis
    9042, 9160,          # Cassandra
    8123, 9000,          # ClickHouse
    50000,               # DB2
    3050,                # Firebird
    7687,                # Neo4j bolt
    11211,               # memcached
})
_PROC_EVENTS: frozenset[str] = frozenset({
    "subprocess.Popen", "os.exec", "os.posix_spawn", "os.spawn", "os.system",
    "os.fork", "os.forkpty", "_posixsubprocess.fork_exec", "os.startfile",
    "sys.addaudithook",   # 스니펫이 자기 훅을 심어 프로세스를 영구 오염시키는 것 차단
    "sys.settrace", "sys.setprofile", "ctypes.dlopen", "ctypes.dlsym",
    "ctypes.call_function",
})

_GUARD_LOCK = threading.Lock()
_HOOK_INSTALLED = False
_ALLOW_ENDPOINTS: set[tuple[str, int]] | None = None
_TLS = threading.local()          # 승인된 프로브의 스레드-로컬 면제


class ExecGuardBlocked(BaseException):
    """가드가 차단한 동작 — 스니펫 실행을 중단시킨다(평문 미포함 메시지).

    **BaseException 파생**: 스니펫의 `except Exception: pass` 가 차단을 삼키고
    재시도 루프를 도는 것을 막는다(codex 지적).
    """


# ── 정적(AST) 가드 ─────────────────────────────────────────────────────────
def _root(name: str) -> str:
    return (name or "").split(".", 1)[0]


def _why(root: str) -> str:
    if root in _DB_DRIVERS:
        return "DB 드라이버"
    if root in _INTERNAL_ROOTS:
        return "내부 모듈(가드/엔진)"
    if root in _CONCURRENCY_ROOTS:
        return "동시성/프로세스 모듈(가드 수명 밖 실행)"
    return "동적 import"


def static_violations(code: str) -> list[str]:
    """스니펫의 금지 import/모듈 탈취/우회 호출을 열거. 빈 리스트면 통과.

    파싱 실패는 호출측이 SyntaxError 로 별도 처리(기존 동작)하므로 빈 리스트.
    """
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError:
        return []
    out: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:                       # alias 무관(as 포함)
                r = _root(a.name)
                if r in _BLOCKED_MODULES:
                    out.append(f"import {r} — {_why(r)}")
        elif isinstance(node, ast.ImportFrom):
            r = _root(node.module or "")
            if r in _BLOCKED_MODULES:
                out.append(f"from {r} import ... — {_why(r)}")
        elif isinstance(node, ast.Call):
            fn = node.func
            if isinstance(fn, ast.Name) and fn.id in _BLOCKED_CALL_NAMES:
                out.append(f"{fn.id}() — 정적 심사 우회 경로")
        elif isinstance(node, ast.Attribute):
            if node.attr in _DB_DRIVERS:
                out.append(f".{node.attr} — namespace 경유 드라이버 접근")
            elif node.attr in _BLOCKED_ATTR_NAMES:
                out.append(f".{node.attr} — 모듈/커넥션 탈취 경로")
            elif node.attr in _BLOCKED_DUNDERS:
                out.append(f".{node.attr} — 내부 객체 탈취")
    seen: set[str] = set()
    uniq: list[str] = []
    for v in out:
        if v not in seen:
            seen.add(v)
            uniq.append(v)
    return uniq


# ── 런타임 가드 상태(변조 저항: 클로저 셀) ─────────────────────────────────
def _make_gate() -> tuple[Any, Any, Any]:
    """(is_active, enter, leave) — 상태를 클로저에 가둔다.

    모듈 전역이 아니므로 `eg._GUARD_DEPTH = 0` 같은 재바인딩으로 못 끈다.
    leave 는 enter 가 발급한 토큰을 요구해 임의 호출로 해제되지 않는다.
    """
    depth = [0]
    tokens: list[object] = []
    lock = threading.Lock()

    def is_active() -> bool:
        return depth[0] > 0

    def enter() -> object:
        token = object()
        with lock:
            depth[0] += 1
            tokens.append(token)
        return token

    def leave(token: object) -> None:
        with lock:
            if token in tokens:
                tokens.remove(token)
                depth[0] = max(0, depth[0] - 1)

    return is_active, enter, leave


_gate_active, _gate_enter, _gate_leave = _make_gate()


def _db_ports() -> frozenset[int]:
    extra = os.environ.get("SA_EXEC_GUARD_EXTRA_PORTS", "")
    ports = set(_DB_PORTS_DEFAULT)
    for tok in extra.replace(",", " ").split():
        try:
            p = int(tok)
        except ValueError:
            continue
        if 1 <= p <= 65535:
            ports.add(p)
    return frozenset(ports)


def _allow_endpoints() -> set[tuple[str, int]]:
    """state DB(Postgres) 엔드포인트 — 이 도구의 정당한 기능이라 통과."""
    global _ALLOW_ENDPOINTS
    if _ALLOW_ENDPOINTS is not None:
        return _ALLOW_ENDPOINTS
    allow: set[tuple[str, int]] = set()
    dsn = os.environ.get("SECU_AGENT_PG_DSN", "").strip()
    if dsn:
        try:
            u = urlparse(dsn)
            if u.hostname:
                host = u.hostname.lower().rstrip(".")
                port = int(u.port or 5432)
                allow.add((host, port))
                # hostname ↔ resolved IP 불일치(create_connection 은 IP 로 connect)
                try:
                    import socket as _s
                    for info in _s.getaddrinfo(host, port, proto=_s.IPPROTO_TCP):
                        addr = info[4][0]
                        if addr:
                            allow.add((str(addr).lower(), port))
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass
    for extra in os.environ.get("SA_EXEC_GUARD_ALLOW_ENDPOINTS", "").replace(",", " ").split():
        host, _, port = extra.rpartition(":")
        if host and port.isdigit():
            allow.add((host.strip().lower(), int(port)))
    _ALLOW_ENDPOINTS = allow
    return allow


def _addr_host_port(address: Any) -> tuple[str | None, int | None]:
    """감사 인자에서 (host, port). tuple 서브클래스의 `__getitem__` 오버라이드로
    실제 주소와 다른 값을 보여주는 혼동 공격을 피하려 tuple 원본 슬롯을 직접 읽는다."""
    if isinstance(address, tuple):
        try:
            host = tuple.__getitem__(address, 0)
            port = tuple.__getitem__(address, 1)
        except Exception:  # noqa: BLE001
            return (None, None)
    elif isinstance(address, list) and len(address) >= 2:
        host, port = address[0], address[1]
    else:
        # AF_UNIX(str/bytes) 등 tuple 이 아닌 주소 — DB 포트 판별 불가 → 차단 대상
        return (None, -1)
    try:
        return (str(host).lower() if host is not None else None, int(port))
    except (TypeError, ValueError):
        return (str(host).lower() if host is not None else None, None)


def _audit(event: str, args: tuple[Any, ...]) -> None:
    if not _gate_active():
        return
    if getattr(_TLS, "approved", False):      # 승인된 프로브 스레드는 면제
        return
    if event == "socket.connect":
        address = args[1] if len(args) > 1 else None
        host, port = _addr_host_port(address)
        if port == -1:
            raise ExecGuardBlocked(
                "비-TCP(예: unix socket) 연결 차단 — 로컬 DB 소켓 우회 방지."
            )
        if port is None or port not in _db_ports():
            return
        if host is not None and (host, port) in _allow_endpoints():
            return
        raise ExecGuardBlocked(
            f"DB 포트({port}) 직접 연결 차단 — 크리덴셜 검증은 승인된 도구"
            "(`*_credential_login_probe`)로만 수행한다(단발원장·scope·회로차단기)."
        )
    if event in _PROC_EVENTS:
        raise ExecGuardBlocked(
            f"{event} 차단 — exec 도구는 read-only 분석 전용(우회·오염 방지)."
        )


def install_hook() -> None:
    """감사 훅 1회 설치(프로세스 전역, 제거 불가). 게이트는 클로저 셀."""
    global _HOOK_INSTALLED
    with _GUARD_LOCK:
        if _HOOK_INSTALLED:
            return
        try:
            sys.addaudithook(_audit)
        except Exception:  # noqa: BLE001 — 설치 실패해도 정적 가드는 유효
            return
        _HOOK_INSTALLED = True


class guarded_exec:
    """with 블록 동안 런타임 가드 활성화 (중첩 안전, 토큰 기반 해제)."""

    __slots__ = ("_token",)

    def __enter__(self) -> "guarded_exec":
        install_hook()
        object.__setattr__(self, "_token", _gate_enter())
        return self

    def __exit__(self, *exc: Any) -> None:
        tok = getattr(self, "_token", None)
        if tok is not None:
            _gate_leave(tok)


class approved_probe:
    """승인된 크리덴셜 프로브용 스레드-로컬 면제.

    동시 실행 중인 exec 가드가 프로브의 단발 로그인을 오염시키지 않게 한다
    (원장 claim 후 차단되면 단발 기회가 소진되고 회로차단기가 오염될 수 있음).
    """

    __slots__ = ("_prev",)

    def __enter__(self) -> "approved_probe":
        object.__setattr__(self, "_prev", getattr(_TLS, "approved", False))
        _TLS.approved = True
        return self

    def __exit__(self, *exc: Any) -> None:
        _TLS.approved = getattr(self, "_prev", False)


class GuardedNamespace:
    """exec namespace 바인딩 모듈 프록시 — 모듈/내부 속성 도달 차단.

    `__getattribute__` 로 **모든** 속성 접근을 심사한다(`__slots__` 만 쓰면
    `state._mod` 로 실모듈이 새어나감 — codex 지적).
    """

    __slots__ = ("__wrapped_mod", "__wrapped_label")

    def __init__(self, mod: Any, label: str) -> None:
        object.__setattr__(self, "_GuardedNamespace__wrapped_mod", mod)
        object.__setattr__(self, "_GuardedNamespace__wrapped_label", label)

    def __getattribute__(self, item: str) -> Any:
        get = object.__getattribute__
        label = get(self, "_GuardedNamespace__wrapped_label")
        if item in ("_mod", "_label", "_GuardedNamespace__wrapped_mod",
                    "_GuardedNamespace__wrapped_label"):
            raise ExecGuardBlocked(f"{label}.{item} 접근 차단(프록시 내부).")
        if item in _BLOCKED_DUNDERS or item in _BLOCKED_MODULES or item in _BLOCKED_ATTR_NAMES:
            raise ExecGuardBlocked(
                f"{label}.{item} 접근 차단 — 크리덴셜 검증은 승인된 "
                "`*_credential_login_probe` 도구로만."
            )
        value = getattr(get(self, "_GuardedNamespace__wrapped_mod"), item)
        import types as _types
        if isinstance(value, _types.ModuleType):
            raise ExecGuardBlocked(
                f"{label}.{item} 은 모듈 — namespace 경유 모듈 접근 차단."
            )
        return value

    def __setattr__(self, item: str, value: Any) -> None:
        raise ExecGuardBlocked("바인딩 namespace 속성 변경 금지(가드 무결성).")

    def __dir__(self) -> list[str]:
        mod = object.__getattribute__(self, "_GuardedNamespace__wrapped_mod")
        return [n for n in dir(mod)
                if n not in _BLOCKED_MODULES and n not in _BLOCKED_ATTR_NAMES]


def guard_error_message(violations: list[str]) -> str:
    joined = ", ".join(violations[:6])
    return (
        f"실행 거부 — 금지된 접근: {joined}. 크리덴셜 유효성 검증은 반드시 승인된 도구 "
        "`smb_credential_login_probe`(도메인별 `*_credential_login_probe`)로 수행하라. "
        "그 도구가 안전봉투(중앙 단발원장·scope allowlist·회로차단기·평문격리·"
        "로그인패킷 암호화)를 강제한다. 직접 로그인은 계정 잠금·감사 누락 위험으로 차단된다."
    )
