"""도메인-무관 크리덴셜 유효성 검증 코어 (recon→active 경계를 넘는 유일 능력).

발견된 크리덴셜이 **실제로 살아있는지** 딱 1회 검증. "노출+도달"을 "노출+유효 확인"으로
격상. 어느 도메인(smb/github/dev_web/confluence)이 발견했든 동일 안전봉투.

────────────────────────────────────────────────────────────────────────
안전봉투 (모든 도메인·모든 validator 공통 — 이 코어에만 존재):
  1. resolve-once + IP 핀: host→IP 를 **한 번만** 해석하고, scope-check·원장·로그인 모두
     그 정규 IP 를 쓴다(DNS rebinding TOCTOU 차단). codex#1.
  2. 중앙 영속 단발원장 `credential_probe_attempt` — ON CONFLICT 원자 예약.
     UNIQUE=(engine, 정규IP, port, principal) — **charter 무관**(별칭/다른 charter 로도
     같은 실계정 재시도 불가). 예약은 wire 액션 **전** 커밋(autocommit). codex#6.
  3. scope: `SA_CRED_PROBE_SCOPE`(host/CIDR[:port] allowlist) 빈값=전면거부. charter_ref
     없으면 fail-closed. codex#2.
  4. 회로차단기(engine class별): db_login 은 **clean authenticated 를 제외한 모든
     post-LOGIN7 결과**에 halt(auth_failed/locked/expired/session_denied/error/timeout).
     사이클당 상한 `SA_CRED_PROBE_MAX_PER_CYCLE`(기본 5). 리셋은 없음(프로세스 재시작만).
  5. 평문 격리: raw 비번/토큰은 이 모듈 지역변수로만. 결과는 닫힌 enum + 정수 에러코드
     파생 상수뿐. `str(exc)`/DSN/본문 절대 금지. pytds/psycopg 로거 억제(서버 에러문구가
     내부 로그로 새는 것 차단). codex#7.
  6. MSSQL LOGIN7 암호화: `enc_login_only=True`(비번 패킷 암호화 — 기본 False 면 난독화만
     이라 passive sniff 로 복원됨). CA(`SA_DB_LOGIN_CAFILE`) 주면 full cert 검증. codex#3.
     라우팅 ENVCHANGE 는 몽키패치로 거부(2차 LOGIN7 을 routed 서버로 재전송 차단). codex#5.
  7. Postgres: sslmode=require(기본) 또는 verify-full(CA 있을 때), hostaddr 로 IP 핀. codex#4.

validator: db_login(mssql/postgres) — LOGIN 1회·쿼리/배치 0·즉시 close.
          http_token(bearer/PAT) — whoami GET 1회·락아웃 없음.
KEEP: 엔진 무수정. reset_probe_cycle() 는 운영자 명시 호출 전용(러너 자동리셋 없음).
"""
from __future__ import annotations

import hashlib
import ipaddress
import logging
import os
import socket
import time
from dataclasses import dataclass, field
from typing import Any, Literal

# 드라이버 내부 로거 억제 — 서버-제어 에러문구(비번/DSN 포함 가능)가 backoff 래퍼 등에서
# 루트 로거로 새는 것을 차단(codex#7). probe 프로세스 전역이지만 pytds/psycopg 는 이 코어만 씀.
for _ln in ("pytds", "pytds.tds", "pytds.tds_socket", "pytds.tds_base", "psycopg"):
    _lg = logging.getLogger(_ln)
    _lg.setLevel(logging.CRITICAL)
    _lg.propagate = False
    if not _lg.handlers:
        _lg.addHandler(logging.NullHandler())

# ── env 이름 ─────────────────────────────────────────────────────────────
ENV_MASTER = "SA_CRED_PROBE"
ENV_SCOPE = "SA_CRED_PROBE_SCOPE"
ENV_MAX_PER_CYCLE = "SA_CRED_PROBE_MAX_PER_CYCLE"
ENV_DB_CAFILE = "SA_DB_LOGIN_CAFILE"

_DEFAULT_MAX_PER_CYCLE = 5
_HTTP_ENGINES = frozenset({"http_token"})

Result = Literal[
    "authenticated", "session_denied", "credential_expired", "account_locked",
    "auth_failed", "unreachable", "not_performed", "skipped_scope",
    "skipped_repeat", "skipped_halt", "skipped_cap", "error",
]

_HALT: dict[str, str] = {}
_PROCESS_ATTEMPTS = 0
_ROUTING_PATCHED = False


class _RoutingBlocked(Exception):
    """서버가 로그인 중 ROUTING ENVCHANGE 를 보냄 — 2차 LOGIN7 재전송 거부."""


def reset_probe_cycle() -> None:
    """운영자 명시 호출 전용(감사된 kill-switch 해제). 러너/에이전트/도구 자동호출 금지.

    회로차단기 + 사이클 카운터만 리셋한다. **중앙 영속 원장은 리셋하지 않는다**
    (단발 보장은 원장이 영구 담보; halt 는 프로세스 내 2차 브레이크일 뿐). codex#6.
    """
    global _PROCESS_ATTEMPTS
    _HALT.clear()
    _PROCESS_ATTEMPTS = 0


def _engine_class(engine: str) -> str:
    return "http" if engine in _HTTP_ENGINES else "db"


def _int_env(name: str, default: int) -> int:
    try:
        v = int((os.environ.get(name) or "").strip())
        return v if v > 0 else default
    except ValueError:
        return default


# ── 크리덴셜 재료 / 결과 (평문 격리) ────────────────────────────────────
@dataclass
class CredentialMaterial:
    engine: str
    host: str
    port: int
    kind: str
    secret: str = field(repr=False)
    user: str | None = None
    database: str | None = None
    base_url: str | None = None

    def __repr__(self) -> str:
        return (f"CredentialMaterial(engine={self.engine!r}, host={self.host!r}, "
                f"port={self.port!r}, kind={self.kind!r}, user={self.user!r})")

    def display_user(self) -> str:
        if self.engine == "http_token":
            return "token:" + hashlib.sha256(self.secret.encode()).hexdigest()[:8]
        return self.user or "(unknown)"

    def ledger_principal(self) -> str:
        """단발원장 principal(charter 무관 — 같은 실계정 재시도 방지). 토큰은 지문만."""
        if self.engine == "http_token":
            return "tok:" + hashlib.sha256(self.secret.encode()).hexdigest()[:16]
        return "usr:" + (self.user or "?")


@dataclass
class ProbeResult:
    result: Result
    engine: str
    host: str
    port: int
    user: str
    kind: str
    detail: str
    single_attempt: bool = True
    elapsed_ms: int = 0

    def proves_validity(self) -> bool:
        return self.result in ("authenticated", "session_denied", "credential_expired")

    def to_public_dict(self) -> dict[str, Any]:
        # 공격자-제어 문자열(host/user/kind/detail)은 길이 캡(stash 과대기록 방지). codex 잔여지적.
        def _cap(s: str, n: int = 120) -> str:
            s = str(s)
            return s if len(s) <= n else s[:n] + "…"
        return {
            "kind": "credential_login_probe",
            "result": self.result,
            "engine": _cap(self.engine, 20),
            "host": _cap(self.host, 60),
            "port": self.port,
            "user": _cap(self.user, 80),
            "credential_kind": _cap(self.kind, 60),
            "detail": _cap(self.detail, 60),
            "single_attempt": self.single_attempt,
            "elapsed_ms": self.elapsed_ms,
            "proves_validity": self.proves_validity(),
        }


def _res(result: Result, m: CredentialMaterial, detail: str, t0: float | None = None) -> ProbeResult:
    return ProbeResult(
        result=result, engine=m.engine, host=m.host, port=m.port,
        user=m.display_user(), kind=m.kind, detail=detail,
        elapsed_ms=int((time.time() - t0) * 1000) if t0 else 0,
    )


# ── scope allowlist ─────────────────────────────────────────────────────
def _parse_scope(raw: str) -> list[tuple[Any, int | None]]:
    out: list[tuple[Any, int | None]] = []
    for tok in (raw or "").split(","):
        tok = tok.strip()
        if not tok:
            continue
        port: int | None = None
        if tok.count(":") == 1 and "/" not in tok:
            h, _, p = tok.partition(":")
            if p.isdigit():
                tok, port = h, int(p)
        try:
            out.append((ipaddress.ip_network(tok, strict=False), port))
        except ValueError:
            out.append((tok.lower(), port))
    return out


def _scope_allows(host: str, ip: str | None, port: int, scope_hosts: set[str] | None) -> bool:
    entries = _parse_scope(os.environ.get(ENV_SCOPE, ""))
    if not entries:
        return False
    ok = False
    for net, p in entries:
        if p is not None and p != port:
            continue
        if isinstance(net, str):
            if net in (host.lower(), (ip or "").lower()):
                ok = True
                break
        else:
            for cand in (ip, host):
                try:
                    if cand and ipaddress.ip_address(cand) in net:
                        ok = True
                        break
                except ValueError:
                    continue
            if ok:
                break
    if not ok:
        return False
    if scope_hosts is not None:  # charter scope 와 교집합(제공 시)
        return host in scope_hosts or (ip is not None and ip in scope_hosts)
    return True


# ── 중앙 영속 단발원장 (canonical IP 키, charter 무관) ──────────────────
_LEDGER_DDL = """
CREATE TABLE IF NOT EXISTS credential_probe_attempt (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    engine TEXT NOT NULL,
    host TEXT NOT NULL,
    port BIGINT NOT NULL,
    principal TEXT NOT NULL,
    host_raw TEXT,
    charter_ref TEXT,
    domain TEXT,
    reserved_at DOUBLE PRECISION NOT NULL,
    result TEXT,
    completed_at DOUBLE PRECISION,
    UNIQUE (engine, host, port, principal)
)
"""
_LEDGER_READY = False


def _ensure_ledger() -> None:
    global _LEDGER_READY
    if _LEDGER_READY:
        return
    from service import state_domain as state
    with state.connect() as c:
        c.execute(_LEDGER_DDL)
    _LEDGER_READY = True


def _reserve_attempt(m: CredentialMaterial, ip: str, principal: str,
                     charter_ref: str, domain: str | None) -> bool:
    """원자 예약. True=최초(진행 가능), False=이미 시도됨. 키=(engine, 정규IP, port, principal)."""
    _ensure_ledger()
    from service import state_domain as state
    with state.connect() as c:
        row = c.execute(
            "INSERT INTO credential_probe_attempt"
            "(engine, host, port, principal, host_raw, charter_ref, domain, reserved_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (engine, host, port, principal) DO NOTHING RETURNING id",
            (m.engine, ip, int(m.port), principal, m.host, charter_ref, domain, time.time()),
        ).fetchone()
    return row is not None


def _complete_attempt(m: CredentialMaterial, ip: str, principal: str, result: str) -> None:
    from service import state_domain as state
    try:
        with state.connect() as c:
            c.execute(
                "UPDATE credential_probe_attempt SET result=?, completed_at=? "
                "WHERE engine=? AND host=? AND port=? AND principal=?",
                (result, time.time(), m.engine, ip, int(m.port), principal),
            )
    except Exception:  # noqa: BLE001
        pass


# ── 저수준 네트워크 헬퍼 ────────────────────────────────────────────────
def _resolve_pin(host: str) -> str | None:
    try:
        ipaddress.ip_address(host)
        return host
    except ValueError:
        pass
    try:
        return socket.gethostbyname(host)
    except OSError:
        return None


def _tcp_alive(ip: str, port: int, timeout: float = 3.0) -> bool:
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


# ── 라우팅 차단 몽키패치 (2차 LOGIN7 재전송 방지) ───────────────────────
def _ensure_no_routing() -> None:
    global _ROUTING_PATCHED
    if _ROUTING_PATCHED:
        return
    try:
        import pytds.tds_socket as tsmod
        _orig = tsmod._TdsSocket.login

        def _no_route_login(self):  # type: ignore[no-untyped-def]
            route = _orig(self)
            if route is not None:
                # 1차 LOGIN7 은 핀 IP(scope 내)로 이미 갔고, route 는 "다른 서버로 가라" 지시.
                # 따르면 routed(=scope 밖 가능) 서버로 비번 재전송이 되므로 거부.
                raise _RoutingBlocked()
            return route

        tsmod._TdsSocket.login = _no_route_login  # type: ignore[assignment]
        _ROUTING_PATCHED = True
    except Exception:  # noqa: BLE001 — 패치 실패해도 로그인은 진행. peer-check 가 backstop.
        pass


# ── validator: db_login ─────────────────────────────────────────────────
def _validate_db_login(m: CredentialMaterial, ip: str) -> tuple[Result, str, bool]:
    """(result, detail, trip). ip=핀 IP(재해석 안 함). LOGIN 1회·배치 0·즉시 close.

    exec_guard 면제(approved_probe): 동시에 돌던 smb_python exec 가드가 이 승인된
    단발 로그인을 차단하면 원장 claim 이 소진되고 회로차단기가 오염된다.
    """
    from service.probes.exec_guard import approved_probe
    with approved_probe():
        if not _tcp_alive(ip, m.port):
            return ("unreachable", "tcp", False)  # LOGIN7 이전 → halt 안 함
        if m.engine == "mssql":
            return _mssql_login(ip, m.host, m.port, m.user or "", m.secret)
        if m.engine == "postgres":
            return _pg_login(ip, m.host, m.port, m.user or "", m.secret)
    return ("error", "unknown_db_engine", True)


def _mssql_login(ip: str, hostname: str, port: int, user: str,
                 password: str) -> tuple[Result, str, bool]:
    import pytds
    _ensure_no_routing()
    cafile = (os.environ.get(ENV_DB_CAFILE) or "").strip() or None
    conn = None
    try:
        conn = pytds.connect(
            dsn=ip, port=port, user=user, password=password,
            database=None,                      # USE <db> 배치 방지
            login_timeout=5, timeout=5, autocommit=True,
            disable_connect_retry=True, pooling=False, use_mars=False,
            enc_login_only=True,                # 비번 패킷 암호화(passive sniff 차단)
            cafile=cafile,                      # 있으면 full cert 검증
            validate_host=bool(cafile),
        )
    except _RoutingBlocked:
        return ("error", "mssql_routing_blocked", True)
    except pytds.LoginError as e:
        return _classify_mssql(int(getattr(e, "number", 0) or getattr(e, "msg_no", 0) or 0))
    except pytds.TimeoutError:
        return ("unreachable", "login_timeout", True)   # 연결 후 → 보수적 halt
    except pytds.OperationalError as e:
        num = int(getattr(e, "number", 0) or getattr(e, "msg_no", 0) or 0)
        if num:
            return _classify_mssql(num)
        return ("error", "mssql_operational", True)
    except Exception:  # noqa: BLE001 — 미지 상태 → 보수적 halt. str(exc) 금지
        return ("error", "mssql_driver", True)
    else:
        detail = "login_accepted"
        try:
            peer = _mssql_peer_ip(conn)
            if peer and peer != ip:
                return ("error", "peer_mismatch", True)
            if peer is None:
                detail = "login_accepted_peer_unverified"
        except Exception:  # noqa: BLE001
            detail = "login_accepted_peer_unverified"
        return ("authenticated", detail, False)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass


def _classify_mssql(num: int) -> tuple[Result, str, bool]:
    """MSSQL 로그인 에러번호 → (result, detail, trip). 정수만(평문 격리).

    trip 매트릭스: clean authenticated 외 모든 post-LOGIN7 결과 halt(codex#6).
    """
    if num == 18486:
        return ("account_locked", "mssql_18486", True)
    if num in (18487, 18488):
        return ("credential_expired", f"mssql_{num}", True)  # 비번 맞음(만료) — 유효 증명이나 halt
    if num == 17892:
        return ("session_denied", "mssql_17892", True)       # 인증 수락 — 유효 증명이나 halt
    if num == 18456:
        return ("auth_failed", "mssql_18456", True)
    if num:
        return ("auth_failed", f"mssql_{num}", True)
    return ("auth_failed", "mssql_login_error", True)


def _mssql_peer_ip(conn: Any) -> str | None:
    for attr in ("_conn", "conn"):
        c = getattr(conn, attr, None)
        sock = getattr(c, "_sock", None) or getattr(c, "sock", None)
        if sock is not None and hasattr(sock, "getpeername"):
            try:
                return sock.getpeername()[0]
            except Exception:  # noqa: BLE001
                return None
    return None


def _pg_login(ip: str, hostname: str, port: int, user: str,
              password: str) -> tuple[Result, str, bool]:
    import psycopg
    cafile = (os.environ.get(ENV_DB_CAFILE) or "").strip() or None
    sslmode = "verify-full" if cafile else "require"   # 최소 require(평문 폴백 차단)
    kw: dict[str, Any] = dict(
        host=hostname, hostaddr=ip, port=port, user=user, password=password,
        dbname="postgres", connect_timeout=5, sslmode=sslmode,
        target_session_attrs="any", application_name="cred_probe",
    )
    if cafile:
        kw["sslrootcert"] = cafile
    conn = None
    try:
        conn = psycopg.connect(**kw)
    except psycopg.OperationalError as e:
        state = (getattr(e, "sqlstate", None) or "").strip()
        if state == "3D000":                       # invalid_catalog_name → 인증 통과
            return ("authenticated", "pg_3D000_dbmismatch", False)
        if state in ("28P01", "28000"):
            return ("auth_failed", f"pg_{state}", True)
        if state == "53300":
            return ("error", "pg_53300", True)
        if not state:                              # 연결 실패(도달 불가) → pre-auth
            return ("unreachable", "pg_connect", False)
        return ("auth_failed", f"pg_{state}", True)
    except Exception:  # noqa: BLE001
        return ("error", "pg_driver", True)
    else:
        return ("authenticated", "login_accepted", False)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass


# ── validator: http_token ───────────────────────────────────────────────
def _validate_http_token(m: CredentialMaterial) -> tuple[Result, str, bool]:
    """bearer/PAT whoami 1회. 락아웃 없음(trip 항상 False). 토큰 절대 미반환."""
    import httpx
    base = (m.base_url or "").rstrip("/")
    if not base:
        return ("error", "no_base_url", False)
    token = m.secret
    if "github" in (m.kind or "").lower() or token.startswith(("github_pat_", "ghp_", "gho_", "ghs_")):
        path, headers = "/rate_limit", {
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github+json", "User-Agent": "cred-probe",
        }
    else:
        path, headers = "/", {"Authorization": f"Bearer {token}", "User-Agent": "cred-probe"}
    try:
        with httpx.Client(trust_env=False, timeout=6.0, follow_redirects=False,
                          verify=False) as cx:
            r = cx.get(base + path, headers=headers)
    except Exception:  # noqa: BLE001 — 원문/URL 노출 금지
        return ("unreachable", "http_connect", False)
    code = r.status_code
    if code == 200:
        return ("authenticated", "http_200", False)
    return ("auth_failed", f"http_{code}", False)


# ── 공개 엔트리 ─────────────────────────────────────────────────────────
def probe_credential(
    material: CredentialMaterial,
    *,
    charter_ref: str,
    domain: str | None = None,
    scope_hosts: set[str] | None = None,
) -> ProbeResult:
    """단일 크리덴셜을 안전봉투 안에서 1회 검증. 절대 raise 안 함 — 항상 ProbeResult."""
    global _PROCESS_ATTEMPTS
    t0 = time.time()
    ecls = _engine_class(material.engine)

    # 1) 마스터 스위치
    if (os.environ.get(ENV_MASTER) or "").strip() not in ("1", "true", "yes", "on"):
        return _res("not_performed", material, "master_off", t0)
    # 2) charter_ref 필수 (fail-closed)
    if not (charter_ref or "").strip():
        return _res("not_performed", material, "no_charter", t0)
    # 3) 회로차단기
    if _HALT.get(ecls):
        return _res("skipped_halt", material, _HALT[ecls], t0)
    # 4) 사이클 상한
    if _PROCESS_ATTEMPTS >= _int_env(ENV_MAX_PER_CYCLE, _DEFAULT_MAX_PER_CYCLE):
        return _res("skipped_cap", material, "per_cycle_cap", t0)
    # 5) resolve-once (IP 핀) — 이후 scope/원장/로그인 모두 이 IP 사용 (codex#1)
    ip = _resolve_pin(material.host)
    if ip is None:
        return _res("unreachable", material, "dns", t0)
    # 6) scope (env allowlist ∩ charter scope) — 빈 allowlist=전면거부
    if not _scope_allows(material.host, ip, material.port, scope_hosts):
        return _res("skipped_scope", material, "out_of_scope", t0)
    # 7) 중앙 원자 예약 — wire 액션 전 커밋(autocommit)
    principal = material.ledger_principal()
    try:
        first = _reserve_attempt(material, ip, principal, charter_ref, domain)
    except Exception:  # noqa: BLE001 — 원장 실패 시 안전측(진행 금지)
        return _res("error", material, "ledger_unavailable", t0)
    if not first:
        return _res("skipped_repeat", material, "already_attempted", t0)
    _PROCESS_ATTEMPTS += 1

    # 8) 디스패치 (예외는 절대 밖으로 — 상수 detail 만)
    try:
        if ecls == "db":
            result, detail, trip = _validate_db_login(material, ip)
        else:
            result, detail, trip = _validate_http_token(material)
    except Exception:  # noqa: BLE001
        result, detail, trip = ("error", "internal", True)

    if trip and ecls == "db":
        _HALT[ecls] = f"db_login halt after {detail}"
    _complete_attempt(material, ip, principal, result)
    return _res(result, material, detail, t0)
