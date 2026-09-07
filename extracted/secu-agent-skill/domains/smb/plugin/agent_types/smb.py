"""SMB anonymous/guest 에이전트.

impacket의 SMBConnection을 직접 쓴다. 인증 자격으로 brute force 절대 안 함 —
빈 username/password 또는 guest 만 시도한다.

흐름:
  1. enumerate_hosts(subnet) — 빠른 TCP 445 체크
  2. list_shares(host) — anonymous bind, IPC$ 제외 + READ-able share만 리턴
  3. walk_share(host, share) — 디렉토리 재귀 (depth/file count 제한)
  4. fetch_file(host, share, path) — 텍스트 파일만, 크기 제한

스캔은 agent_types/smb.run_task 가 묶어서 한 사이클 처리한다.
"""
from __future__ import annotations

import ipaddress
import logging
import os
import socket
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


_COMMUNICATION_ERROR_MARKERS = (
    "NT_STATUS_IO_TIMEOUT",
    "STATUS_IO_TIMEOUT",
    "CONNECTION TIMED OUT",
    "TIMED OUT",
    "NO ROUTE TO HOST",
    "HOST IS DOWN",
    "NETWORK IS UNREACHABLE",
    "CONNECTION REFUSED",
    "CONNECTION RESET",
    "CONNECTION ABORTED",
    "NETBIOS",
    "ERRNO 110",
    "ERRNO 111",
    "ERRNO 113",
)
_PERMISSION_ERROR_MARKERS = (
    "STATUS_ACCESS_DENIED",
    "STATUS_PRIVILEGE_NOT_HELD",
)
_AUTH_LOGIN_ERROR_MARKERS = (
    "STATUS_LOGON_FAILURE",
    "STATUS_WRONG_PASSWORD",
    "STATUS_NO_SUCH_USER",
)
_AUTH_ACCOUNT_UNAVAILABLE_MARKERS = (
    "STATUS_ACCOUNT_LOCKED_OUT",
    "STATUS_PASSWORD_EXPIRED",
    "STATUS_PASSWORD_MUST_CHANGE",
    "STATUS_ACCOUNT_DISABLED",
)
_NOT_FOUND_ERROR_MARKERS = (
    "STATUS_OBJECT_NAME_NOT_FOUND",
    "STATUS_OBJECT_PATH_NOT_FOUND",
    "STATUS_BAD_NETWORK_NAME",
    "STATUS_BAD_NETWORK_PATH",
)


def classify_smb_error(value: object) -> str:
    """Classify SMB failures for state-machine decisions.

    Communication failures are retryable. Permission/not-found failures prove the
    host answered and must not be treated as "PC off".
    """
    text = str(value or "").upper()
    if any(marker in text for marker in _COMMUNICATION_ERROR_MARKERS):
        return "communication_unavailable"
    if "STATUS_ACCOUNT_LOCKED_OUT" in text:
        return "account_locked_out"
    if any(marker in text for marker in _AUTH_ACCOUNT_UNAVAILABLE_MARKERS):
        return "auth_account_unavailable"
    if any(marker in text for marker in _AUTH_LOGIN_ERROR_MARKERS):
        return "auth_login_failed"
    if any(marker in text for marker in _PERMISSION_ERROR_MARKERS):
        return "permission_denied"
    if any(marker in text for marker in _NOT_FOUND_ERROR_MARKERS):
        return "not_found"
    return "other"


def is_communication_unavailable(value: object) -> bool:
    return classify_smb_error(value) == "communication_unavailable"

# 텍스트로 판단하는 확장자. 그 외는 스킵 (binary scan은 비용 큼).
_TEXT_EXTENSIONS = frozenset({
    "txt", "log", "md", "json", "yaml", "yml", "ini", "conf", "cfg", "toml",
    "env", "properties", "xml", "csv", "tsv", "sql", "sh", "bash", "zsh",
    "py", "rb", "js", "ts", "go", "java", "kt", "swift", "rs", "php", "c",
    "cpp", "h", "hpp", "html", "htm", "css", "ps1", "bat", "cmd",
    "pem", "key", "crt", "pub", "ovpn", "service",
    # 2026-08-29: 사내 공유에 실제로 있는데 목록에 없어 **한 번도 안 열린** 것들.
    # 실측(라이브 smb_file 전수): 1,622건 전부 `is_text_candidate=0` — 크기 때문이
    # 아니라 목록에 없어서였다. 코드 확장자는 조용하다(스캔된 파일 기준 hit/파일:
    # py 0.9 · bat 0.0 · sh 0.0 · c 1.6). 시끄러운 xlsx 76 · xml 8.0 · csv 5.5 는
    # 이미 들어와 있다.
    #   config 476  .NET app.config — 연결문자열 자리 (평균 3KB, xml 노이즈 안 옮음)
    #   frm    330  MDBS 4대의 VB6 폼 (bas 와 같은 앱)
    #   asp    294  12.23.67.40 inetpub\wwwroot — 살아있는 IIS 소스가 SMB 로 노출
    #   inc    189  ASP include / C 소스 조각
    #   cs      81  C# (Settings.Designer.cs 에 연결문자열)
    #   reg     75  레지스트리 백업 (UTF-16 — _decode_utf16 이 있어야 열린다)
    #   bas     60  MSSQL sa 평문이 있는 그 파일
    #   vbs     51  로그온/설치 스크립트
    "bas", "cls", "frm", "vb", "vbs", "cs", "asp", "aspx", "inc", "pl",
    "config", "reg", "udl", "dsn", "rdp",
})

# Vision/OCR로 읽을 수 있는 이미지 확장자. BMP/TIFF는 현재 image_inspect가
# header parser와 multimodal MIME 매핑을 지원하지 않아 제외한다.
_IMAGE_EXTENSIONS = frozenset({"jpg", "jpeg", "png", "gif", "webp"})
_PDF_EXTENSIONS = frozenset({"pdf"})

# 항상 의심 파일명 (확장자 없어도)
_HOT_FILENAMES = frozenset({
    ".env", ".envrc", ".netrc", ".pgpass", ".my.cnf",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
    "config", "credentials", "secrets",
    "kubeconfig", ".kube",
    "wp-config.php",
    "database.yml", "secrets.yml",
    "shadow", "passwd",
})


@dataclass(slots=True)
class SmbHostShares:
    host: str
    shares: list[str] = field(default_factory=list)  # READ-able only
    error: str | None = None


@dataclass(slots=True)
class SmbFile:
    host: str
    share: str
    path: str           # share-root 기준 path (e.g. "subdir/file.env")
    size: int
    is_text_candidate: bool
    is_image_candidate: bool = False


@dataclass(slots=True)
class SmbDirectoryError:
    path: str
    depth: int
    error: str


@dataclass(slots=True)
class SmbDirectory:
    path: str
    depth: int
    listable: bool
    error: str | None = None


@dataclass(slots=True)
class SmbWalkResult:
    files: list[SmbFile] = field(default_factory=list)
    directories: list[SmbDirectory] = field(default_factory=list)
    directory_errors: list[SmbDirectoryError] = field(default_factory=list)
    truncated: bool = False
    checkpoint: dict[str, Any] | None = None


# ---------- 호스트 enumerate ----------

def expand_subnet(spec: str) -> list[str]:
    """CIDR 또는 단일 IP. 너무 큰 prefix는 잘라낸다 (안전).
    /22보다 큰 prefix는 거부."""
    net = ipaddress.ip_network(spec, strict=False)
    if net.num_addresses > 1024:
        raise ValueError(f"subnet too large: {spec} ({net.num_addresses} addrs)")
    return [str(h) for h in net.hosts()] if net.num_addresses > 1 else [str(net.network_address)]


def tcp_alive(host: str, port: int = 445, timeout: float = 0.8) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def enumerate_hosts(subnet: str, *, concurrency: int = 64) -> list[str]:
    """주어진 subnet에서 445/tcp 떠있는 호스트만 추려 반환. ThreadPool로 병렬 connect.
    동시 connect 너무 많으면 사내 IDS 의심 → 64가 사내 정책 마진 안."""
    from concurrent.futures import ThreadPoolExecutor
    candidates = expand_subnet(subnet)
    alive: list[str] = []
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        results = pool.map(tcp_alive, candidates)
        for host, ok in zip(candidates, results, strict=True):
            if ok:
                alive.append(host)
    logger.info("smb.enumerate_hosts %s → %d/%d alive", subnet, len(alive), len(candidates))
    return alive


# ---------- impacket lazy import ----------

def _get_smb_class() -> Any:
    """impacket이 무거운 OpenSSL deprecation warning을 띄우므로 지연 import."""
    try:
        from impacket.smbconnection import SMBConnection  # type: ignore[import-untyped]
    except ImportError as e:
        raise RuntimeError(
            "impacket 미설치 — `pip install impacket` 또는 `uv sync`"
        ) from e
    return SMBConnection


# NetExec과 동일한 인증 모드 분류.
AuthMode = str  # 'null' | 'guest' | 'auth'


def _login_for_mode(conn: Any, mode: AuthMode) -> None:
    """모드별 SMB login 시도. 실패하면 raise."""
    if mode == "null":
        conn.login("", "")
    elif mode == "guest":
        # NetExec 트릭: 존재하지 않는 user + 빈 비번 → 서버가 guest 폴백.
        conn.login("thisuserisjustguestnotreal", "")
    elif mode == "auth":
        username = os.environ.get("SMB_USERNAME", "") or ""
        password = os.environ.get("SMB_PASSWORD", "") or ""
        if not username:
            raise RuntimeError("SMB_USERNAME 미설정 — auth 모드 사용 불가")
        conn.login(username, password)
    else:
        raise ValueError(f"unknown SMB auth mode: {mode}")


@contextmanager
def _smb_session_mode(host: str, mode: AuthMode) -> Iterator[Any]:
    """특정 인증 모드로 SMB session. 실패하면 raise."""
    SMBConnection = _get_smb_class()
    conn = SMBConnection(host, host, sess_port=445, timeout=15)
    try:
        _login_for_mode(conn, mode)
        yield conn
    finally:
        try:
            conn.logoff()
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass


# walk/fetch 용 세션 (auth → guest 폴백).
@contextmanager
def _smb_session(host: str) -> Iterator[Any]:
    """v3.79 ③-2: lockout-safe — discovery 와 동일 회로차단(_auth_mode_allowed) 공유.

    기존엔 env 계정 실패 시 무조건 guest 폴백만 하고 감지가 없어, 비번 변경·잠금
    상태에서 장기 스윕(세션 수백 개)이 LOGON_FAILURE 를 잠금 임계까지 반복했다.
    walk/fetch 는 고빈도라 LOCKED_OUT(사후)뿐 아니라 **첫 auth login 실패에서 즉시
    전역 차단**(예방) — 이후 세션은 곧장 guest. 해제는 reset_auth_lockout_flag()
    (새 scan 사이클) 또는 재기동.
    """
    SMBConnection = _get_smb_class()
    conn = SMBConnection(host, host, sess_port=445, timeout=15)
    try:
        logged_in = False
        allowed, _skip_reason = _auth_mode_allowed(host)
        if allowed:
            username = os.environ.get("SMB_USERNAME", "") or ""
            password = os.environ.get("SMB_PASSWORD", "") or ""
            try:
                conn.login(username, password)
                _note_auth_success(host)
                logged_in = True
            except Exception as e:
                _disable_auth_after_login_failure(host, "walk/fetch", e)
        if not logged_in:
            _login_for_mode(conn, "guest")
        yield conn
    finally:
        try:
            conn.logoff()
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass


# ---------- access mask ----------

# Windows access mask bits we care about
_GENERIC_READ          = 0x80000000
_GENERIC_WRITE         = 0x40000000
_GENERIC_ALL           = 0x10000000
_FILE_READ_DATA        = 0x00000001  # = FILE_LIST_DIRECTORY
_FILE_WRITE_DATA       = 0x00000002  # = FILE_ADD_FILE
_FILE_APPEND_DATA      = 0x00000004  # = FILE_ADD_SUBDIRECTORY
_FILE_READ_EA          = 0x00000008
_FILE_WRITE_EA         = 0x00000010

_READ_BITS  = _GENERIC_READ | _GENERIC_ALL | _FILE_READ_DATA
_WRITE_BITS = _GENERIC_WRITE | _GENERIC_ALL | _FILE_WRITE_DATA | _FILE_APPEND_DATA


def _maximal_access(conn: Any, share: str) -> int:
    """SMB2 tree connect 응답에서 MaximalAccess 비트 추출. 실패 시 0.

    impacket SMB2 tree connect는 응답 packet에 MaximalAccess 필드를 포함하지만
    SMBConnection이 직접 노출 안 함. 내부 구조에 의존 — 버전 변경 시 깨질 수 있어
    try/except로 감싸 best-effort. 실패하면 listPath 결과로만 READ 판정.
    """
    try:
        tid = conn.connectTree(share)
    except Exception:
        return 0
    ma = 0
    try:
        # impacket 0.12 기준 — SMB2/3 dialect일 때 internal SMB object 노출 경로:
        smb = getattr(conn, "_SMBConnection__SMB", None)
        if smb is not None:
            # connectTree에서 채워진 TreeConnectTable 또는 _Session
            sess = getattr(smb, "_Session", None) or {}
            tct = sess.get("TreeConnectTable") if isinstance(sess, dict) else None
            if tct and tid in tct:
                ma = int(tct[tid].get("MaximalAccess", 0))
    except Exception:
        ma = 0
    try:
        conn.disconnectTree(tid)
    except Exception:
        pass
    return ma


def _access_from_mask(mask: int) -> tuple[bool, bool]:
    """(read, write)."""
    return bool(mask & _READ_BITS), bool(mask & _WRITE_BITS)


# ---------- share list ----------

def list_shares(host: str) -> SmbHostShares:
    """Legacy single-attempt list (auth then guest fallback). 새 코드는 list_shares_modes 사용 권장."""
    out = SmbHostShares(host=host)
    try:
        with _smb_session(host) as conn:
            for raw in conn.listShares():
                name = raw["shi1_netname"][:-1] if isinstance(raw["shi1_netname"], str) else raw["shi1_netname"]
                if isinstance(name, bytes):
                    name = name.decode("utf-8", errors="replace").rstrip("\x00")
                if name.upper() in ("IPC$", "ADMIN$"):
                    continue
                try:
                    conn.listPath(name, "*")
                    out.shares.append(name)
                except Exception:
                    continue
    except Exception as e:
        out.error = repr(e)
    return out


@dataclass(slots=True)
class ShareAccess:
    """한 (host, share)의 인증 모드별 접근 권한."""
    share: str
    # 모드별 결과: 'null'|'guest'|'auth' → {read, write}
    modes: dict[str, dict[str, bool]] = field(default_factory=dict)

    @property
    def any_read(self) -> bool:
        return any(m.get("read") for m in self.modes.values())

    @property
    def any_write(self) -> bool:
        return any(m.get("write") for m in self.modes.values())


@dataclass(slots=True)
class SmbHostMultiMode:
    host: str
    # 모드별 login 결과 (성공이면 [] for shares loaded, error str if login fail)
    login_errors: dict[str, str] = field(default_factory=dict)
    # share 단위 access matrix
    shares: list[ShareAccess] = field(default_factory=list)


def _enum_share_access_in_session(conn: Any, mode: str, by_share: dict[str, ShareAccess]) -> None:
    """현재 session에서 listShares + 각 share의 maximal access 측정."""
    for raw in conn.listShares():
        name = raw["shi1_netname"][:-1] if isinstance(raw["shi1_netname"], str) else raw["shi1_netname"]
        if isinstance(name, bytes):
            name = name.decode("utf-8", errors="replace").rstrip("\x00")
        if name.upper() in ("IPC$", "ADMIN$"):
            continue
        # access mask 우선 시도 (SMB2)
        mask = _maximal_access(conn, name)
        read, write = _access_from_mask(mask)
        # mask 못 받았으면 listPath로 read 확인 (fallback)
        if mask == 0:
            try:
                conn.listPath(name, "*")
                read = True
            except Exception:
                read = False
            write = False  # 안전하게
        if name not in by_share:
            by_share[name] = ShareAccess(share=name)
        by_share[name].modes[mode] = {"read": read, "write": write}


class AccountLockedOut(RuntimeError):
    """auth 모드 자격증명 계정이 잠겼을 때. 추가 시도 즉시 중단해야 lockout이 연장 안 됨."""


# 모듈 전역 플래그 — 한 사이클 내에서 lockout 감지되면 이후 호스트엔 auth 모드 skip.
# 새 프로세스마다 reset. 더 영구적 안전장치는 SMB_AUTH_ENABLED=false (env).
_AUTH_DISABLED_REASON: str | None = None
_AUTH_HOST_DISABLED_REASONS: dict[str, str] = {}
_AUTH_LOGIN_FAILURE_HOSTS: set[str] = set()

# 이 프로세스에서 auth 로그인이 **한 번이라도 성공**했는가.
# 성공했다면 자격증명은 증명된 것이므로, 이후 개별 host 의 LOGON_FAILURE 는
# "자격증명 드리프트" 가 아니라 **그 host 의 성질**이다(워크그룹 PC·NAS·어플라이언스).
# 2026-08-17 실측: 22,470 host 스윕에서 절대 개수 2건으로 전역 회로를 끊는 바람에
# 스윕 시작 7초 만에 auth 가 꺼졌고, 남은 1,630여 subnet 이 guest 전용으로 돌았다
# (실공유 399개 중 74개만 관측 · auth 공유 300개는 6/13 이후 재확인 불가).
_AUTH_VERIFIED_THIS_PROCESS: bool = False


#: 센티넬이 판정할 근거(과거 auth 성공 이력)가 **아예 없는** 패스인가.
#: DB 초기화 직후 첫 스윕이 그렇다 — 그때 임계값 2 는 사실상 "실패 2대면 전체 포기" 다.
_AUTH_COLD_START: bool = False


def _auth_failure_global_threshold() -> int:
    """전역 회로 임계값. cold start 면 완화한다.

    ★ 절대 개수로 끊으면 스윕 규모와 무관해진다 — 22,470 host 스윕도 2건에 죽는다
      (2026-08-17 사고). cold start 는 그 위험이 가장 큰 순간이다: 센티넬이 무력하고
      실패는 시작 몇 초 안에 몰려 온다.
    """
    if _AUTH_COLD_START:
        return _auth_cold_start_threshold()
    raw = os.environ.get("SMB_AUTH_FAILURE_GLOBAL_THRESHOLD", "2")
    try:
        return max(1, int(raw))
    except ValueError:
        return 2


def _auth_cold_start_threshold() -> int:
    """근거 없는 패스의 임계값. 기본 50.

    도메인 계정을 안 받는 장비(워크그룹 PC·NAS·어플라이언스)는 사내망에 흔하다 —
    수십 대가 실패해도 그건 자격증명 문제가 아니다. 진짜 자격증명 문제라면 **성공이
    한 번도 안 나오므로** 이 숫자에 곧 도달한다. 반대로 자격증명이 멀쩡하면 성공이
    먼저 나와 `_AUTH_VERIFIED_THIS_PROCESS` 가 서고, 그 순간 이 완화는 무의미해진다
    (성공 이력이 있으면 개별 실패가 전역을 못 끊는다).
    """
    raw = os.environ.get("SMB_AUTH_COLD_START_THRESHOLD", "50")
    try:
        return max(1, int(raw))
    except ValueError:
        return 50


def _note_auth_success(host: str) -> None:
    global _AUTH_VERIFIED_THIS_PROCESS
    _AUTH_VERIFIED_THIS_PROCESS = True
    _AUTH_HOST_DISABLED_REASONS.pop(host, None)
    _AUTH_LOGIN_FAILURE_HOSTS.clear()


def _disable_auth_after_login_failure(host: str, context: str, error: Exception) -> None:
    """Classify SMB auth login failures without confusing them with ACL denial.

    STATUS_ACCESS_DENIED while listing/fetching a share is a permission result.
    STATUS_LOGON_FAILURE during login is an auth-login failure. A single host can
    reject otherwise valid domain credentials, so it only disables auth for that
    host. Multiple distinct host login failures indicate credential drift and
    trip the process-wide circuit breaker before retries can snowball.
    """
    global _AUTH_DISABLED_REASON
    msg = str(error)
    kind = classify_smb_error(msg)
    if kind == "account_locked_out":
        _AUTH_DISABLED_REASON = (
            f"ACCOUNT_LOCKED_OUT on {host} ({context}) — 이번 프로세스 "
            "동안 auth 모드 자동 중단. lockout 해제 후 다시 실행."
        )
        logger.warning(_AUTH_DISABLED_REASON)
        return
    if kind == "auth_account_unavailable":
        _AUTH_DISABLED_REASON = (
            f"AUTH_ACCOUNT_UNAVAILABLE on {host} ({context}) — 계정 상태 문제 의심. "
            "이번 프로세스 동안 auth 모드 자동 중단. 계정 상태 확인 후 재기동."
        )
        logger.warning(_AUTH_DISABLED_REASON)
        return
    if kind == "auth_login_failed":
        reason = (
            f"LOGON_FAILURE on {host} ({context}) — 이 host 에서 auth login 실패. "
            "권한 없음(STATUS_ACCESS_DENIED)과 구분하여 이 host 에서만 auth 모드 skip."
        )
        _AUTH_HOST_DISABLED_REASONS[host] = reason
        if _AUTH_VERIFIED_THIS_PROCESS:
            # 자격증명이 이 프로세스에서 이미 통했다 → 드리프트가 아니다.
            # 이 host 만 skip 하고 전역 회로는 건드리지 않는다. (account_locked_out /
            # auth_account_unavailable 은 위에서 이미 처리 — 그 둘은 계정 상태 신호라
            # 성공 이력과 무관하게 전역 중단이 맞다.)
            logger.warning("%s (자격증명은 이 패스에서 검증됨 — 전역 중단 안 함)", reason)
            return
        _AUTH_LOGIN_FAILURE_HOSTS.add(host)
        threshold = _auth_failure_global_threshold()
        if len(_AUTH_LOGIN_FAILURE_HOSTS) >= threshold:
            _AUTH_DISABLED_REASON = (
                f"LOGON_FAILURE on {len(_AUTH_LOGIN_FAILURE_HOSTS)} hosts "
                f"({context}) — 자격증명 불일치 가능성이 높아 이번 프로세스 동안 "
                "auth 모드 자동 중단. 비번/계정 상태 확인 후 재기동."
            )
            logger.warning(_AUTH_DISABLED_REASON)
        else:
            logger.warning(reason)
    else:
        reason = (
            f"AUTH_FAILURE on {host} ({context}) — auth login 실패. "
            "권한 없음과 구분하여 이 host 에서만 auth 모드 skip."
        )
        _AUTH_HOST_DISABLED_REASONS[host] = reason
        logger.warning(reason)


def reset_auth_lockout_flag() -> None:
    """새 scan 사이클 시작 시 호출 — 이전 사이클 lockout 기억 해제."""
    global _AUTH_DISABLED_REASON, _AUTH_VERIFIED_THIS_PROCESS, _AUTH_COLD_START
    _AUTH_DISABLED_REASON = None
    _AUTH_HOST_DISABLED_REASONS.clear()
    _AUTH_LOGIN_FAILURE_HOSTS.clear()
    _AUTH_VERIFIED_THIS_PROCESS = False
    _AUTH_COLD_START = False


def verify_auth_credential(
    known_good_hosts: Iterable[str], *, max_attempts: int = 2,
) -> tuple[bool, str]:
    """패스 시작 1회 — 자격증명이 지금도 유효한지 **알려진 정상 host** 로 확인한다.

    `reset_auth_lockout_flag()` **직후**에 호출한다(패스 오너만).

    왜 필요한가: 개별 host 의 LOGON_FAILURE 는 (a) 우리 비번이 틀렸거나 (b) 그 host 가
    도메인 계정을 안 받거나 둘 중 하나인데, **미지 host 로는 구분이 안 된다.** 과거에
    auth 가 통했던 host 로 물어보면 그 구분이 선다.

    안전: 잠금 카운터에 영향을 주는 시도는 최대 `max_attempts`(기본 2)회이고,
    성공하면 즉시 멈춘다. tcp_alive 사전 확인은 로그인이 아니라 카운터와 무관하다.
    실패 시 전역 auth 를 즉시 중단하므로 **기존 동작(실패 2회 후 중단)보다 시도가 적거나
    같다** — 이 함수는 lockout 위험을 늘리지 않는다.

    반환: (검증됨, 사유). 검증되면 이후 개별 host LOGON_FAILURE 가 전역 회로를 끊지 않는다.
    """
    if os.environ.get("SMB_AUTH_SENTINEL", "true").lower() == "false":
        return False, "SMB_AUTH_SENTINEL=false (env) — 센티넬 생략"
    allowed, why = _auth_mode_allowed()
    if not allowed:
        return False, f"auth 모드 비활성: {why}"

    tried = 0
    for host in known_good_hosts:
        if tried >= max(1, int(max_attempts)):
            break
        if not tcp_alive(host):
            continue  # 로그인 아님 — 잠금 카운터 무관
        tried += 1
        try:
            with _smb_session_mode(host, "auth"):
                _note_auth_success(host)
                msg = f"자격증명 검증 성공 (sentinel={host}, 시도 {tried}회)"
                logger.info("[smb] %s", msg)
                return True, msg
        except Exception as e:  # noqa: BLE001
            kind = classify_smb_error(str(e))
            if kind in ("auth_login_failed", "account_locked_out", "auth_account_unavailable"):
                msg = (
                    f"자격증명 검증 실패 (sentinel={host}, {kind}) — 이 패스의 auth 를 "
                    "중단한다. 과거 auth 가 통했던 host 이므로 host 성질이 아니라 "
                    "**자격증명 문제**다. SMB_PASSWORD/계정 상태를 확인하라."
                )
                # ⚠️ `_disable_auth_after_login_failure` 로 위임하면 안 된다 — 그건
                # LOGON_FAILURE 를 host 단위로 처리하고 임계값(2)에 도달해야 전역을
                # 끊는다. 센티넬은 **알려진 정상 host** 라 1회 실패가 곧 결론이므로
                # 여기서 직접 전역 회로를 끊는다(추가 시도 = 잠금 위험).
                global _AUTH_DISABLED_REASON
                _AUTH_DISABLED_REASON = msg
                _AUTH_HOST_DISABLED_REASONS[host] = msg
                logger.warning("[smb] %s", msg)
                return False, msg
            # 도달성/ACL 등 — 이 host 로는 판정 불가. 다음 후보로.
            logger.info("[smb] sentinel %s 판정불가(%s) — 다음 후보", host, kind)

    # ★★ 후보가 **하나도 없었을 때**가 이 함수의 사각지대다.
    #
    # `smb_auth_verified_hosts()` 는 `smb_share WHERE auth_login_ok=1` 에서 온다 —
    # 즉 **과거 스윕의 기억**이다. DB 를 비우고 처음부터 돌리면 그 기억이 없어
    # 센티넬이 아무 판정도 못 하고, 임계값 2 짜리 전역 회로가 그대로 적용된다.
    #
    # 2026-08-26 실측: 초기화 직후 풀 스윕에서 시작 0.5초 만에 실패 2건이 먼저 도착해
    # auth 가 전역 차단됐고, 15시간 동안 28,247 host 를 **guest 로만** 훑었다
    # (공유 70개 관측 — 그 뒤 40개 host 만 auth 로 다시 붙어보니 277개가 나왔다).
    # 6주 전 사고(74→234)를 막으려고 만든 장치가 **자기 기억에 의존해서** 같은 자리에서
    # 다시 뚫린 것이다.
    #
    # ⇒ 후보가 없으면 임계값을 완화한다. 근거가 없을 때 "자격증명이 깨졌다" 고 단정하는
    #   쪽이, 몇 대가 도메인 계정을 안 받는 것보다 훨씬 비싸다.
    #   ⚠️ 계정 잠김·계정 상태 이상은 이 완화와 무관하다 — 그 둘은 위에서 성공 이력과
    #      관계없이 즉시 전역 중단이고, 여기서 건드리지 않는다.
    if tried == 0:
        global _AUTH_COLD_START
        _AUTH_COLD_START = True
        msg = (
            "센티넬 후보 없음(DB 에 auth 성공 이력 0) — **cold start**. "
            f"전역 임계값을 {_auth_failure_global_threshold()} → "
            f"{_auth_cold_start_threshold()} 로 완화한다. "
            "몇 대가 도메인 계정을 안 받는다고 전체 스윕의 auth 를 끄지 않기 위해서다."
        )
        logger.warning("[smb] %s", msg)
        return False, msg
    return False, f"센티넬 판정 불가 (시도 {tried}회) — 기존 임계값 회로가 그대로 적용된다"


def _auth_mode_allowed(host: str | None = None) -> tuple[bool, str]:
    """auth 모드 시도해도 되는지. (allowed, skip_reason)."""
    global _AUTH_DISABLED_REASON
    if _AUTH_DISABLED_REASON:
        return False, _AUTH_DISABLED_REASON
    if host and host in _AUTH_HOST_DISABLED_REASONS:
        return False, _AUTH_HOST_DISABLED_REASONS[host]
    if os.environ.get("SMB_AUTH_ENABLED", "true").lower() == "false":
        return False, "SMB_AUTH_ENABLED=false (env)"
    if not os.environ.get("SMB_USERNAME"):
        return False, "SMB_USERNAME 미설정"
    return True, ""


def list_shares_modes(
    host: str, *, modes: tuple[str, ...] = ("null", "guest", "auth"),
) -> SmbHostMultiMode:
    """3 인증 모드를 순서대로 시도 + 각 share의 R/W 결과 종합. NetExec 워크플로 호환.

    auth 모드에서 STATUS_ACCOUNT_LOCKED_OUT 감지되면 모듈 전역 플래그를 set 하여
    이번 프로세스 동안 다른 호스트엔 auth 모드 시도 안 함 — 추가 lockout 방지.
    """
    global _AUTH_DISABLED_REASON
    out = SmbHostMultiMode(host=host)
    by_share: dict[str, ShareAccess] = {}
    for mode in modes:
        if mode == "auth":
            allowed, reason = _auth_mode_allowed(host)
            if not allowed:
                out.login_errors[mode] = f"skipped: {reason}"
                continue
        try:
            with _smb_session_mode(host, mode) as conn:
                if mode == "auth":
                    _note_auth_success(host)
                try:
                    _enum_share_access_in_session(conn, mode, by_share)
                except Exception as e:
                    out.login_errors[mode] = f"listShares: {type(e).__name__}: {str(e)[:80]}"
        except Exception as e:
            err = f"login: {type(e).__name__}: {str(e)[:120]}"
            out.login_errors[mode] = err
            if mode == "auth":
                _disable_auth_after_login_failure(host, "list_shares_modes", e)
                # 이 host의 잔여 모드는 계속 (null/guest는 다른 자격증명)
    for sa in by_share.values():
        for mode in modes:
            sa.modes.setdefault(mode, {"read": False, "write": False})
    out.shares = list(by_share.values())
    return out


def host_communication_unavailable(result: SmbHostMultiMode) -> bool:
    """True when the host did not answer SMB at all.

    A live host can legitimately return access-denied or no visible shares. Those
    are not retry-later communication failures.
    """
    if result.shares:
        return False
    errors = dict(result.login_errors or {})
    if not errors:
        return False
    meaningful = [
        err for err in errors.values()
        if err and not str(err).lower().startswith("skipped:")
    ]
    if not meaningful:
        return False
    return all(is_communication_unavailable(err) for err in meaningful)


# ---------- walk + fetch ----------

# v3.79 ③: zip+xml 기반 office/문서 포맷 — stdlib zipfile 로 텍스트 추출 가능.
# 사내 공유폴더의 최고 민감 캐리어(직원명단.xlsx, 계정정보.docx, hwpx)가
# 기존엔 text 후보가 아니라 영영 내용 스캔에서 빠졌다 (라이브 미스캔 6,934 확인).
# 레거시 OLE(doc/xls/ppt/hwp)는 외부 라이브러리 필요 — 후속 (백로그).
_DOC_EXTENSIONS = frozenset({"docx", "xlsx", "pptx", "hwpx"})
_PDF_TEXT_MAX_CHARS = 1_000_000
_PDF_RENDER_MAX_PAGES = 3
# zip-bomb 가드: 멤버당 원본크기 상한 / 총 추출 char 상한 / 멤버 수 상한
_DOC_MEMBER_MAX_BYTES = 20 * 1024 * 1024
_DOC_TEXT_MAX_CHARS = 1_000_000
_DOC_MAX_MEMBERS = 200


def _is_text_candidate(filename: str) -> bool:
    base = filename.lower()
    if base in _HOT_FILENAMES:
        return True
    if "." not in base:
        return False
    ext = base.rsplit(".", 1)[-1]
    return ext in _TEXT_EXTENSIONS or ext in _DOC_EXTENSIONS or ext in _PDF_EXTENSIONS


def is_image_candidate(filename: str) -> bool:
    base = filename.lower().replace("\\", "/").rsplit("/", 1)[-1]
    if "." not in base:
        return False
    return base.rsplit(".", 1)[-1] in _IMAGE_EXTENSIONS


def is_pdf_candidate(filename: str) -> bool:
    base = filename.lower().replace("\\", "/").rsplit("/", 1)[-1]
    if "." not in base:
        return False
    return base.rsplit(".", 1)[-1] in _PDF_EXTENSIONS


def _looks_like_pdf(raw: bytes) -> bool:
    return raw[:1024].lstrip().startswith(b"%PDF-")


def _decode_pdf_literal(value: bytes) -> str:
    out = bytearray()
    i = 0
    while i < len(value):
        ch = value[i]
        if ch != 0x5C:  # backslash
            out.append(ch)
            i += 1
            continue
        i += 1
        if i >= len(value):
            break
        esc = value[i]
        if esc in b"nrtbf":
            out.extend({
                ord("n"): b"\n",
                ord("r"): b"\r",
                ord("t"): b"\t",
                ord("b"): b"\b",
                ord("f"): b"\f",
            }[esc])
            i += 1
            continue
        if esc in b"()\\":
            out.append(esc)
            i += 1
            continue
        if 48 <= esc <= 55:
            octal = bytes([esc])
            i += 1
            for _ in range(2):
                if i < len(value) and 48 <= value[i] <= 55:
                    octal += bytes([value[i]])
                    i += 1
                else:
                    break
            out.append(int(octal, 8))
            continue
        out.append(esc)
        i += 1
    return out.decode("utf-8", errors="replace")


def _extract_basic_pdf_text(raw: bytes, *, max_chars: int = _PDF_TEXT_MAX_CHARS) -> str | None:
    """Dependency-free fallback for simple text PDFs.

    Real-world compressed/cmap PDFs need PyMuPDF/pypdf. This fallback catches
    uncompressed literal strings so tests and some simple exports still scan.
    """
    import re as _re

    if not _looks_like_pdf(raw):
        return None
    parts: list[str] = []
    total = 0
    # Literal strings used by Tj/TJ text operators.
    for match in _re.finditer(rb"\((?:\\.|[^\\()]){1,4000}\)", raw, flags=_re.S):
        if total >= max_chars:
            break
        text = _decode_pdf_literal(match.group(0)[1:-1])
        text = " ".join(text.split())
        if not text:
            continue
        room = max_chars - total
        parts.append(text[:room])
        total += min(len(text), room)
    # UTF-16BE hex strings with BOM, common in PDFs with Korean text.
    for match in _re.finditer(rb"<FEFF([0-9A-Fa-f\s]{4,8000})>", raw):
        if total >= max_chars:
            break
        try:
            data = bytes.fromhex(match.group(1).decode("ascii"))
            text = data.decode("utf-16-be", errors="replace")
        except Exception:
            continue
        text = " ".join(text.split())
        if not text:
            continue
        room = max_chars - total
        parts.append(text[:room])
        total += min(len(text), room)
    joined = "\n".join(parts).strip()
    return joined if joined else None


def _extract_pdf_text(path: str, raw: bytes) -> str | None:
    if not is_pdf_candidate(path) or not _looks_like_pdf(raw):
        return None

    # PyMuPDF handles compressed text, CMaps, and mixed PDFs well when present.
    try:
        import fitz  # type: ignore
        doc = fitz.open(stream=raw, filetype="pdf")
        parts: list[str] = []
        total = 0
        for page in doc:
            if total >= _PDF_TEXT_MAX_CHARS:
                break
            text = page.get_text("text") or ""
            text = text.strip()
            if not text:
                continue
            room = _PDF_TEXT_MAX_CHARS - total
            parts.append(text[:room])
            total += min(len(text), room)
        joined = "\n".join(parts).strip()
        if joined:
            return joined
    except Exception:
        pass

    try:
        import io as _io
        from pypdf import PdfReader  # type: ignore
        reader = PdfReader(_io.BytesIO(raw))
        parts = []
        total = 0
        for page in reader.pages:
            if total >= _PDF_TEXT_MAX_CHARS:
                break
            text = (page.extract_text() or "").strip()
            if not text:
                continue
            room = _PDF_TEXT_MAX_CHARS - total
            parts.append(text[:room])
            total += min(len(text), room)
        joined = "\n".join(parts).strip()
        if joined:
            return joined
    except Exception:
        pass

    return _extract_basic_pdf_text(raw)


def render_pdf_pages_as_images(
    raw: bytes, *, max_pages: int = _PDF_RENDER_MAX_PAGES,
) -> list[bytes]:
    """Render first PDF pages to PNG bytes for vision/OCR.

    Requires PyMuPDF at runtime. Missing dependency returns [] so callers can
    degrade gracefully and still record the PDF as needing inspection.
    """
    if not _looks_like_pdf(raw):
        return []
    try:
        import fitz  # type: ignore
        doc = fitz.open(stream=raw, filetype="pdf")
        out: list[bytes] = []
        for idx in range(min(max_pages, len(doc))):
            page = doc[idx]
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            out.append(pix.tobytes("png"))
        return out
    except Exception:
        return []


def _extract_document_text(path: str, raw: bytes) -> str | None:
    """zip+xml/PDF 문서에서 텍스트 추출. 실패/비대상이면 None.

    의존성 0 (stdlib zipfile) — xml 멤버를 읽어 태그 제거. 포맷별 본문 멤버를
    우선하되, 매칭 없으면 모든 .xml 멤버 폴백 (포맷 변형 대비).
    """
    import html as _html
    import io as _io
    import re as _re
    import zipfile as _zipfile

    base = path.lower()
    if "." not in base:
        return None
    ext = base.rsplit(".", 1)[-1]
    if ext in _PDF_EXTENSIONS:
        return _extract_pdf_text(path, raw)
    if ext not in _DOC_EXTENSIONS:
        return None
    if raw[:4] != b"PK\x03\x04":
        return None  # zip 아님 (절단/위장)

    # 포맷별 본문 멤버 prefix — sharedStrings(xlsx 텍스트 본체) 우선.
    preferred = {
        "docx": ("word/",),
        "xlsx": ("xl/sharedstrings", "xl/worksheets/", "xl/comments"),
        "pptx": ("ppt/slides/", "ppt/notesslides/"),
        "hwpx": ("contents/",),
    }[ext]

    try:
        zf = _zipfile.ZipFile(_io.BytesIO(raw))
        infos = [
            i for i in zf.infolist()
            if i.filename.lower().endswith(".xml")
            and i.file_size <= _DOC_MEMBER_MAX_BYTES  # zip-bomb 멤버 스킵
        ][:_DOC_MAX_MEMBERS]
        targets = [
            i for i in infos
            if any(i.filename.lower().startswith(p) for p in preferred)
        ] or infos  # 매칭 없으면 모든 xml 폴백
        parts: list[str] = []
        total = 0
        for info in targets:
            if total >= _DOC_TEXT_MAX_CHARS:
                break
            try:
                xml = zf.read(info).decode("utf-8", errors="replace")
            except Exception:
                continue
            text = _re.sub(r"<[^>]+>", " ", xml)
            text = _html.unescape(text)
            text = _re.sub(r"[ \t]{2,}", " ", text).strip()
            if not text:
                continue
            room = _DOC_TEXT_MAX_CHARS - total
            parts.append(text[:room])
            total += min(len(text), room)
        joined = "\n".join(parts).strip()
        return joined if joined else None
    except Exception:
        return None  # 깨진 zip — 호출측이 binary 휴리스틱으로 폴백


#: BOM 없는 UTF-16 판정에 쓸 앞부분 코드유닛 수. 너무 짧으면 우연에 속고,
#: 너무 길면 절단된 파일에서 판정 자체를 못 한다.
_UTF16_SNIFF_PAIRS = 256
#: 디코드 결과에 허용할 U+FFFD 비율. 넘으면 UTF-16 이 아니었던 것으로 본다.
_UTF16_MAX_REPLACEMENT_RATIO = 0.05


def _decode_utf16(raw: bytes) -> str | None:
    """UTF-16 텍스트면 디코드해서 돌려주고, 아니면 None.

    ⚠️ 이게 없으면 `_classify_fetched` 의 NUL 휴리스틱이 UTF-16 을 전부 binary 로
    찍는다. 그리고 binary 는 `file_record_scan_skipped` 로 **종결** 표식이라(재시도가
    아니다) 파일이 조용히 영구 제외된다 — 2026-08-29 실측 `skipped:binary` 2,814건
    중 `.ini` 282 · `.txt` 52 가 허용목록 안에 있으면서 이 이유로 닫혀 있었다.
    Windows 의 `.reg`/`.udl`/`.rdp` 와 한글 Windows 의 메모장 저장분이 여기 걸린다.

    판정은 **구조로만** 한다(내용 추측 금지):
      1. BOM 이 있으면 BOM 을 믿는다. 단 UTF-32LE BOM(`FF FE 00 00`)은 제외.
      2. BOM 이 없으면 한쪽 자리 바이트가 통째로 NUL 인지만 본다.
      3. 디코드 결과가 U+FFFD 범벅이면 UTF-16 이 아니었던 것으로 되돌린다.
    """
    if len(raw) < 4:
        return None
    if raw[:4] == b"\xff\xfe\x00\x00":
        return None  # UTF-32LE
    if raw[:2] == b"\xff\xfe":
        codec, body = "utf-16-le", raw[2:]
    elif raw[:2] == b"\xfe\xff":
        codec, body = "utf-16-be", raw[2:]
    else:
        head = raw[: 2 * _UTF16_SNIFF_PAIRS]
        if len(head) < 16:
            return None
        n = len(head) // 2
        even_nul = head[0 : 2 * n : 2].count(0)
        odd_nul = head[1 : 2 * n : 2].count(0)
        if odd_nul >= n * 0.9 and even_nul == 0:
            codec, body = "utf-16-le", raw
        elif even_nul >= n * 0.9 and odd_nul == 0:
            codec, body = "utf-16-be", raw
        else:
            return None
    # max_bytes 절단이 코드유닛 한가운데를 자를 수 있다.
    if len(body) % 2:
        body = body[:-1]
    if not body:
        return None
    text = body.decode(codec, errors="replace")
    if not text:
        return None
    if text.count("\ufffd") > len(text) * _UTF16_MAX_REPLACEMENT_RATIO:
        return None
    return text


#: 사내 문서 DRM 래퍼의 매직. 실측(2026-08-30): 피트니스 공유의 계약서·견적서와
#: `12.56.53.141\SE_PART` 의 3nm 공정 교안이 모두 이 헤더로 시작하고, **파일 전체를
#: 받아도** `%PDF-` 가 나오지 않는다(파일 어디에도 없다).
_DRM_MAGICS: tuple[bytes, ...] = (
    b"<## NASCA DRM FILE",
)


def is_drm_wrapped(raw: bytes) -> bool:
    """사내 DRM 래퍼인가. 앞 몇 바이트만 본다.

    ## ⚠️⚠️ DRM 이 걸렸다고 안심하면 안 된다 (사용자, 2026-08-30)

    사내에서는 **AD 접속만으로 NASCA 권한이 열려 대부분 읽을 수 있다.** 그러므로
    DRM 은 노출을 완화하는 통제가 아니다 — 위험도를 낮추는 근거로 쓰면 안 된다.

    이 판정의 용도는 딱 하나다: **왜 못 읽었는지**를 "그냥 바이너리" 와 구분해
    남기는 것. 못 읽었으니 판정은 파일 이름·경로·주변 파일로 한다.
    """
    head = bytes(raw or b"")[:64]
    return any(head.startswith(m) for m in _DRM_MAGICS)


def _classify_fetched(path: str, raw: bytes) -> FetchOutcome:
    """fetch 후처리(순수함수) — 문서추출 → 기존 text/binary 휴리스틱.

    SMB 세션 없이 테스트 가능하도록 fetch_file 에서 분리.
    """
    if not raw:
        return "empty", ""
    doc_text = _extract_document_text(path, raw)
    if doc_text is not None:
        return "text", doc_text
    # 문서 확장자인데 추출 실패(max_bytes 절단/깨진 zip) — zip 바이트를 mojibake
    # 'text' 로 흘리지 않게 binary 강등.
    _base = path.lower()
    if "." in _base and _base.rsplit(".", 1)[-1] in _DOC_EXTENSIONS:
        return "binary", f"document extract failed ({len(raw)} bytes)"
    if "." in _base and _base.rsplit(".", 1)[-1] in _PDF_EXTENSIONS:
        return "binary", (
            f"pdf text extraction unavailable or image-only ({len(raw)} bytes); "
            "use smb_inspect_pdf"
        )
    # ★ NUL 휴리스틱보다 **먼저** UTF-16 을 본다 — 순서가 바뀌면 UTF-16 이 전부
    #   binary 로 종결된다(위 `_decode_utf16` 주석의 실측).
    utf16 = _decode_utf16(raw)
    if utf16 is not None:
        return "text", utf16
    if raw[:8192].count(b"\x00") > 4:
        return "binary", f"binary content ({len(raw)} bytes)"
    return "text", raw.decode("utf-8", errors="replace")


def _walk_path_to_win(path: str) -> str:
    return str(path or "").strip("/").replace("/", "\\")


def _walk_path_to_posix(path: str) -> str:
    return str(path or "").replace("\\", "/").strip("/")


def _normalize_walk_checkpoint(
    checkpoint: dict[str, Any] | None,
) -> list[tuple[str, int, str | None]]:
    if not checkpoint:
        return [("", 0, None)]
    pending = checkpoint.get("pending") if isinstance(checkpoint, dict) else None
    if not isinstance(pending, list):
        return [("", 0, None)]
    queue: list[tuple[str, int, str | None]] = []
    for item in pending:
        if not isinstance(item, dict):
            continue
        try:
            depth = int(item.get("depth", 0))
        except (TypeError, ValueError):
            depth = 0
        path = _walk_path_to_win(str(item.get("path") or ""))
        after = item.get("after")
        queue.append((path, depth, _walk_path_to_posix(str(after)) if after else None))
    return queue or [("", 0, None)]


def _walk_checkpoint(
    current: tuple[str, int, str | None] | None,
    queue: list[tuple[str, int, str | None]],
) -> dict[str, Any] | None:
    pending: list[dict[str, Any]] = []
    items = ([current] if current is not None else []) + list(queue)
    for path, depth, after in items:
        row: dict[str, Any] = {"path": _walk_path_to_posix(path), "depth": int(depth)}
        if after:
            row["after"] = _walk_path_to_posix(after)
        pending.append(row)
    if not pending:
        return None
    return {"version": 1, "pending": pending}


def _short_walk_error(error: Exception) -> str:
    msg = str(error).replace("\n", " ").strip()
    if len(msg) > 160:
        msg = msg[:157] + "..."
    return f"{type(error).__name__}: {msg}" if msg else type(error).__name__


def walk_share_detailed(
    host: str,
    share: str,
    *,
    max_files: int | None = 1000,
    max_depth: int = 4,
    checkpoint: dict[str, Any] | None = None,
) -> SmbWalkResult:
    """share root부터 BFS 하며 파일, 디렉터리 에러, cap-resume checkpoint를 반환."""
    result = SmbWalkResult()
    with _smb_session(host) as conn:
        queue = _normalize_walk_checkpoint(checkpoint)
        emitted = 0
        while queue and (max_files is None or emitted < max_files):
            cur_dir, depth, after = queue.pop(0)
            if depth > max_depth:
                continue
            try:
                raw_entries = list(conn.listPath(share, cur_dir + "\\*" if cur_dir else "*"))
            except Exception as e:
                logger.debug("smb.walk listPath fail %s\\%s: %s", share, cur_dir, e)
                result.directories.append(SmbDirectory(
                    path=_walk_path_to_posix(cur_dir),
                    depth=depth,
                    listable=False,
                    error=_short_walk_error(e),
                ))
                result.directory_errors.append(SmbDirectoryError(
                    path=_walk_path_to_posix(cur_dir),
                    depth=depth,
                    error=_short_walk_error(e),
                ))
                continue
            result.directories.append(SmbDirectory(
                path=_walk_path_to_posix(cur_dir),
                depth=depth,
                listable=True,
            ))

            entries = [
                ent for ent in raw_entries
                if ent.get_longname() not in (".", "..")
            ]
            start_idx = 0
            if after:
                for i, ent in enumerate(entries):
                    name = ent.get_longname()
                    rel = f"{cur_dir}\\{name}" if cur_dir else name
                    if _walk_path_to_posix(rel) == after:
                        start_idx = i + 1
                        break

            for i in range(start_idx, len(entries)):
                ent = entries[i]
                name = ent.get_longname()
                rel = f"{cur_dir}\\{name}" if cur_dir else name
                rel_posix = _walk_path_to_posix(rel)
                if ent.is_directory():
                    if depth + 1 <= max_depth:
                        queue.append((rel, depth + 1, None))
                    continue

                size = ent.get_filesize()
                result.files.append(SmbFile(
                    host=host, share=share, path=rel_posix,
                    size=size,
                    is_text_candidate=_is_text_candidate(name),
                    is_image_candidate=is_image_candidate(name),
                ))
                emitted += 1
                if max_files is not None and emitted >= max_files:
                    if i < len(entries) - 1 or queue:
                        result.truncated = True
                        current = (
                            cur_dir, depth, rel_posix,
                        ) if i < len(entries) - 1 else None
                        result.checkpoint = _walk_checkpoint(current, queue)
                    return result
    return result


def walk_share(
    host: str, share: str, *, max_files: int | None = 1000, max_depth: int = 4,
) -> Iterable[SmbFile]:
    """share root부터 BFS. 디렉토리/파일 entry 만나면 yield. 자식 무한루프 대비 depth 제한.

    max_files=None → 무제한 (전수 walk). v3.72 (b): share 당 캡 절단 없이 전부 인덱싱.
    """
    with _smb_session(host) as conn:
        queue: list[tuple[str, int]] = [("", 0)]
        emitted = 0
        while queue and (max_files is None or emitted < max_files):
            cur_dir, depth = queue.pop(0)
            if depth > max_depth:
                continue
            try:
                entries = conn.listPath(share, cur_dir + "\\*" if cur_dir else "*")
            except Exception as e:
                logger.debug("smb.walk listPath fail %s\\%s: %s", share, cur_dir, e)
                continue
            for ent in entries:
                name = ent.get_longname()
                if name in (".", ".."):
                    continue
                rel = f"{cur_dir}\\{name}" if cur_dir else name
                if ent.is_directory():
                    queue.append((rel, depth + 1))
                else:
                    size = ent.get_filesize()
                    yield SmbFile(
                        host=host, share=share, path=rel.replace("\\", "/"),
                        size=size,
                        is_text_candidate=_is_text_candidate(name),
                        is_image_candidate=is_image_candidate(name),
                    )
                    emitted += 1
                    if max_files is not None and emitted >= max_files:
                        break


FetchOutcome = tuple[str, str]  # (status, body_or_msg)
# status: 'text' | 'empty' | 'binary' | 'denied' | 'not_found' | 'error'


@dataclass(slots=True)
class SmbFileBytes:
    status: str  # bytes | empty | too_large | denied | not_found | error
    data: bytes = b""
    message: str = ""
    size: int | None = None
    truncated: bool = False


def _remote_file_size(conn: Any, share: str, winpath: str) -> int | None:
    """Best-effort remote stat before binary fetch, to avoid pulling huge images."""
    try:
        entries = list(conn.listPath(share, winpath))
    except Exception:
        return None
    basename = winpath.rsplit("\\", 1)[-1]
    for ent in entries:
        name = ent.get_longname()
        if name in (".", "..") or ent.is_directory():
            continue
        if name == basename or len(entries) == 1:
            try:
                return int(ent.get_filesize())
            except Exception:
                return None
    return None


def _fetch_error_outcome(e: Exception) -> FetchOutcome:
    """impacket 예외 → (status, 사유). ★ 한 곳에만 둔다 — 세션판/배치판이 갈라지면
    한쪽만 고쳐져서 같은 오류가 도메인마다 다른 status 로 기록된다."""
    msg = str(e)
    if "STATUS_ACCESS_DENIED" in msg:
        return "denied", "STATUS_ACCESS_DENIED"
    if ("STATUS_OBJECT_NAME_NOT_FOUND" in msg
            or "STATUS_OBJECT_PATH_NOT_FOUND" in msg):
        return "not_found", f"{type(e).__name__}"
    if "STATUS_FILE_IS_A_DIRECTORY" in msg:
        return "error", "path is a directory"
    if "STATUS_SHARING_VIOLATION" in msg:
        return "denied", "STATUS_SHARING_VIOLATION"
    return "error", f"{type(e).__name__}: {msg[:120]}"


def fetch_file_on(
    conn: Any, share: str, path: str, *, max_bytes: int, size: int | None = None,
) -> FetchOutcome:
    """**이미 열린 세션**에서 파일 하나를 읽는다.

    `fetch_file` 과 결과가 같고 로그인만 안 한다. 배치 스캐너의 존재 이유다 —
    파일 300개를 `fetch_file` 로 읽으면 로그인이 300번이고, 그게 지배적 비용이다.

    `size` 를 주면(=walk 가 적어둔 크기) `max_bytes` 를 넘는 파일은 **앞부분만**
    범위 읽기로 가져온다. ⚠️ 이게 없으면 `getFile` 이 파일 **전체를 전송**한다 —
    콜백이 `max_bytes` 까지만 버퍼에 쓸 뿐, 바이트는 이미 다 넘어온 뒤다. 그래서
    스캔 큐는 지금까지 큰 파일을 **아예 제외**하는 방식으로 이 비용을 피했고,
    그 결과 512K 초과 text 후보 33,553건(6.4TB)이 한 번도 안 열렸다(2026-08-29 실측).
    """
    import io

    if size is not None and int(size) > max_bytes:
        # 앞부분만. RANGE_READ_CAP(8MB) 안이면 그대로, 넘으면 read_range_on 이 자른다.
        status, payload = read_range_on(
            conn, share, path, offset=0, length=max_bytes)
        if status == "bytes" and isinstance(payload, bytes):
            return _classify_fetched(path, payload)
        if status == "empty":
            return "empty", ""
        return status, str(payload)

    buf = io.BytesIO()
    winpath = path.replace("/", "\\")

    def _cb(data: bytes) -> None:
        if not data:
            return
        room = max_bytes - buf.tell()
        if room <= 0:
            return
        buf.write(data[:room])

    try:
        conn.getFile(share, winpath, _cb)
    except Exception as e:  # noqa: BLE001
        return _fetch_error_outcome(e)
    # v3.79 ③: 후처리 분리 — office/문서(zip+xml)는 텍스트 추출 후 'text' 로.
    return _classify_fetched(path, buf.getvalue())


def fetch_file(
    host: str, share: str, path: str, *, max_bytes: int,
) -> FetchOutcome:
    """SMB에서 파일 가져오기. retrieveFile (share name + callback, 내부에서 tree connect).
    status: text | empty | binary | denied | not_found | error."""
    try:
        with _smb_session(host) as conn:
            return fetch_file_on(conn, share, path, max_bytes=max_bytes)
    except Exception as e:
        return "error", f"session: {type(e).__name__}: {str(e)[:100]}"


def fetch_file_bytes(
    host: str, share: str, path: str, *, max_bytes: int,
) -> SmbFileBytes:
    """SMB 원격 파일을 bytes 로 읽는다. 이미지 vision 분석처럼 binary 원문이 필요할 때만 사용."""
    import io
    buf = io.BytesIO()
    winpath = path.replace("/", "\\")
    truncated = False

    def _cb(data: bytes) -> None:
        nonlocal truncated
        if not data:
            return
        room = max_bytes - buf.tell()
        if room <= 0:
            truncated = True
            return
        buf.write(data[:room])
        if len(data) > room:
            truncated = True

    try:
        with _smb_session(host) as conn:
            size = _remote_file_size(conn, share, winpath)
            if size is not None and size > max_bytes:
                return SmbFileBytes(
                    status="too_large",
                    message=f"{size} bytes > {max_bytes} cap",
                    size=size,
                )
            try:
                conn.getFile(share, winpath, _cb)
            except Exception as e:
                msg = str(e)
                if "STATUS_ACCESS_DENIED" in msg:
                    return SmbFileBytes(status="denied", message="STATUS_ACCESS_DENIED", size=size)
                if ("STATUS_OBJECT_NAME_NOT_FOUND" in msg
                        or "STATUS_OBJECT_PATH_NOT_FOUND" in msg):
                    return SmbFileBytes(status="not_found", message=f"{type(e).__name__}", size=size)
                if "STATUS_FILE_IS_A_DIRECTORY" in msg:
                    return SmbFileBytes(status="error", message="path is a directory", size=size)
                if "STATUS_SHARING_VIOLATION" in msg:
                    return SmbFileBytes(status="denied", message="STATUS_SHARING_VIOLATION", size=size)
                return SmbFileBytes(
                    status="error", message=f"{type(e).__name__}: {msg[:120]}", size=size,
                )
    except Exception as e:
        return SmbFileBytes(status="error", message=f"session: {type(e).__name__}: {str(e)[:100]}")

    raw = buf.getvalue()
    if not raw:
        return SmbFileBytes(status="empty", data=b"", size=0, truncated=truncated)
    return SmbFileBytes(
        status="bytes",
        data=raw,
        size=len(raw) if size is None else size,
        truncated=truncated,
    )


def fetch_file_text(
    host: str, share: str, path: str, *, max_bytes: int,
) -> str | None:
    """Legacy compat — text면 본문, 아니면 None."""
    status, body = fetch_file(host, share, path, max_bytes=max_bytes)
    return body if status == "text" else (body if status == "empty" else None)


# ══════════════════════════════════════════════════════════════════════════════
# 부분 읽기(ranged read) — 2026-08-27
#
# ## 왜 없었나
#
# `fetch_file`/`fetch_file_bytes` 는 둘 다 `conn.getFile(share, path, cb)` 를 쓴다.
# impacket 의 `getFile` 은 `offset` 인자를 받는데(**처음부터 받고 있었다**) 우리는 한 번도
# 안 넘겼다. `max_bytes` 는 버퍼 상한일 뿐 전송을 안 줄인다 — 콜백이 버리기만 한다.
# `fetch_file_bytes` 는 한술 더 떠 `size > max_bytes` 면 **아예 안 읽고** `too_large` 로 끝난다.
#
# 그 결과 실측 2026-08-27: tar 34,069개(761GB) · zip 967개(626GB) 가 **한 바이트도**
# 열린 적이 없다. 검토원이 SMSSIG$ 를 "SCCM 배포 패키지로 추정" 이라고만 쓴 이유다 —
# 추측을 안 한 게 아니라 **확인할 도구가 없었다.**
#
# ## 무엇을 쓰나
#
#     readFile(treeId, fileId, offset, bytesToRead, singleCall=False)
#
# 열린 핸들에서 [offset, offset+length) 만 실제로 전송한다(`singleCall=False` 여야
# maxReadSize 로 잘린 만큼을 이어 읽는다 — True 면 한 번만 읽고 짧게 돌아온다).
#
# ⚠️ 워커는 이 경로를 스스로 못 만든다. `exec_guard.GuardedNamespace` 가 모듈 반환을
#    막아 샌드박스에서 impacket 에 닿을 수 없다 — **여기 없으면 없는 것이다.**
# ══════════════════════════════════════════════════════════════════════════════

#: 한 번의 ranged read 상한. 인덱스 파싱용이지 본문 회수용이 아니다.
RANGE_READ_CAP = 8 * 1024 * 1024


@contextmanager
def open_session(host: str) -> Iterator[Any]:
    """세션 하나를 열어 여러 번 쓰게 공개한다.

    ★ 배치 스캐너의 존재 이유다. `fetch_file` 은 호출마다 로그인부터 다시 한다 —
      파일 300개면 세션 300개다. 세션 수립이 지배적 비용이라 이걸 재사용하지 않으면
      "코드가 훑는다" 가 성립하지 않는다.

    회로차단기(`_auth_mode_allowed`)·guest 폴백은 `_smb_session` 그대로다 — 여기서
    인증 정책을 다시 쓰지 않는다(두 벌이 되면 lockout 가드가 한쪽만 걸린다).
    """
    with _smb_session(host) as conn:
        yield conn


def read_range_on(
    conn: Any, share: str, path: str, *, offset: int, length: int,
) -> tuple[str, bytes | str]:
    """열린 세션에서 [offset, offset+length) 를 읽는다. → (status, bytes|사유).

    status: 'bytes' | 'empty' | 'denied' | 'not_found' | 'error'
    """
    winpath = path.replace("/", "\\")
    want = max(0, min(int(length), RANGE_READ_CAP))
    if want == 0:
        return "empty", b""
    tid = None
    fid = None
    try:
        tid = conn.connectTree(share)
        # ★ **읽기 권한만 요구한다.** impacket 의 openFile 기본값은
        #   `desiredAccess=3` = FILE_READ_DATA(1) | FILE_WRITE_DATA(2) 다. 우리는 그
        #   인자를 안 넘겨서 범위 읽기를 할 때마다 **쓰기 권한까지 함께** 요구하고
        #   있었고, 읽기전용 공유가 그걸 거부했다.
        #
        #   실측 2026-08-28, 라이브 프로브(읽기 전용, 두 대상 동일):
        #       openFile(tid, path)                          → STATUS_ACCESS_DENIED (0xc0000022)
        #       openFile(tid, path, desiredAccess=1)         → OK, 512 bytes
        #
        #   이 한 줄이 `smb_archive_index` 를 44/44 실패시키고 있었다(감사로그에는
        #   44건 전부 `outcome=success` 로 찍혔다 — 본문 ok=false 는 아무도 안 읽었다).
        #   그리고 워커 계약이 "목차를 인용한 뒤 archive_scan" 순서를 요구하므로,
        #   목차 실패 하나가 tar 34,069건 + 이미지 170,284건으로 가는 경로 전체를
        #   막고 있었다(`smb_archive_scan` 0회 · `smb_inspect_image` 0회).
        #
        #   ⚠️ 우리는 이 파이프라인에서 **아무것도 쓰지 않는다**(읽기전용 불변식).
        #      쓰기 권한을 요구할 이유가 애초에 없었다.
        fid = conn.openFile(tid, winpath, desiredAccess=_FILE_READ_DATA)
        data = conn.readFile(tid, fid, int(offset), want, singleCall=False)
        return ("bytes", data) if data else ("empty", b"")
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "STATUS_ACCESS_DENIED" in msg:
            return "denied", "STATUS_ACCESS_DENIED"
        if ("STATUS_OBJECT_NAME_NOT_FOUND" in msg
                or "STATUS_OBJECT_PATH_NOT_FOUND" in msg):
            return "not_found", type(e).__name__
        if "STATUS_SHARING_VIOLATION" in msg:
            return "denied", "STATUS_SHARING_VIOLATION"
        if "STATUS_END_OF_FILE" in msg:
            return "empty", b""
        return "error", f"{type(e).__name__}: {msg[:120]}"
    finally:
        for close, arg in ((getattr(conn, "closeFile", None), (tid, fid)),
                           (getattr(conn, "disconnectTree", None), (tid,))):
            if close is None or any(a is None for a in arg):
                continue
            try:
                close(*arg)
            except Exception:  # noqa: BLE001
                pass


def fetch_file_range(
    host: str, share: str, path: str, *, offset: int = 0, length: int = 65536,
) -> SmbFileBytes:
    """세션을 열어 한 구간만 읽는다. 단발 호출용 — 배치는 `open_session` + `read_range_on`."""
    try:
        with _smb_session(host) as conn:
            status, payload = read_range_on(
                conn, share, path, offset=offset, length=length)
    except Exception as e:  # noqa: BLE001
        return SmbFileBytes(status="error",
                            message=f"session: {type(e).__name__}: {str(e)[:100]}")
    if status == "bytes" and isinstance(payload, bytes):
        return SmbFileBytes(status="bytes", data=payload, size=len(payload))
    if status == "empty":
        return SmbFileBytes(status="empty", data=b"", size=0)
    return SmbFileBytes(status=status, message=str(payload))
