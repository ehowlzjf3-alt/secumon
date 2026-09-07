"""원문 → CredentialMaterial 재료 파싱 (도메인 무관, in-memory only).

도메인 tool 이 원문을 재-fetch 한 뒤 이 파서로 host/user/secret/engine 을 뽑는다.
raw secret 은 반환 dataclass 에만 잠깐 담겨 validator 로 전달되고, 그 dataclass 는
로그/DB/LLM 어디에도 나가지 않는다(호출측 책임). 파서 자체는 네트워크 접근 없음.

지원(Phase 1):
  - MSSQL/generic ADO 커넥션스트링: `User ID=..;Password=..;Data Source=host[,port];Initial Catalog=..`
  - DB URL: `postgres://u:pw@host:5432/db`, `mysql://..`, `mssql://..`, `sqlserver://..`
  - JDBC sqlserver: `jdbc:sqlserver://host:1433;user=..;password=..`
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

_DEFAULT_PORT = {"mssql": 1433, "postgres": 5432, "mysql": 3306}


@dataclass
class ParsedCred:
    engine: str                      # mssql | postgres | mysql
    host: str
    port: int
    user: str
    secret: str = field(repr=False)  # raw 비번 — repr 제외
    database: str | None = None
    kind: str = "db_connection_string"
    line_no: int | None = None   # 원문에서 이 커넥션스트링이 실제로 있던 라인(1-based)

    def __repr__(self) -> str:
        return (f"ParsedCred(engine={self.engine!r}, host={self.host!r}, "
                f"port={self.port!r}, user={self.user!r}, kind={self.kind!r}, "
                f"line_no={self.line_no!r})")


def _to_port(p: str, default_port: int) -> int:
    # str.isdigit() 은 유니코드 숫자(예: '²')도 True 지만 int() 는 ValueError.
    # ASCII 숫자만 허용 + 방어적 변환(파서가 도구 전체를 중단시키지 않게).
    p = p.strip()
    if not (p.isascii() and p.isdigit()):
        return default_port
    try:
        port = int(p)
    except ValueError:
        return default_port
    return port if 1 <= port <= 65535 else default_port


def _split_host_port(ds: str, default_port: int) -> tuple[str, int]:
    ds = ds.strip().strip('"').strip("'")
    # 값 뒤에 붙은 코드(VB6 라인연속 `12.98.64.105"  .CommandTimeout=..`)·따옴표·공백에서 절단.
    # host 는 공백/따옴표를 포함하지 않으므로 첫 등장에서 자른다(host,port 표기는 콤마라 안전).
    ds = re.split(r'["\'\s]', ds, 1)[0]
    if ds.lower().startswith("tcp:"):
        ds = ds[4:]
    # host\instance (named instance) — 포트는 SQL Browser 필요, v1 은 default 포트
    if "\\" in ds:
        ds = ds.split("\\", 1)[0]
    # host,port (ADO 표기)
    if "," in ds:
        h, _, p = ds.partition(",")
        return h.strip(), _to_port(p, default_port)
    # host:port
    if ds.count(":") == 1:
        h, _, p = ds.partition(":")
        if p.strip().isascii() and p.strip().isdigit():
            return h.strip(), _to_port(p, default_port)
    return ds, default_port


def _engine_from_provider(kv: dict[str, str]) -> str:
    provider = (kv.get("provider") or "").lower()
    # Oracle(MSDAORA/OraOLEDB) 은 Phase1 미지원 — mssql 로 오분류하면 엉뚱한 프로토콜
    # 로그인을 시도하므로 명시적으로 'oracle' 로 분류(도구가 mssql/postgres 만 검증→스킵).
    if "msdaora" in provider or "oraoledb" in provider or "oracle" in provider:
        return "oracle"
    if "sqloledb" in provider or "sqlncli" in provider or "msoledbsql" in provider:
        return "mssql"
    if "npgsql" in provider or "postgres" in provider:
        return "postgres"
    if "mysql" in provider:
        return "mysql"
    # Data Source + Initial Catalog 조합은 MSSQL ADO 관용
    if "initial catalog" in kv or "data source" in kv:
        return "mssql"
    return "mssql"


def parse_ado_conn(text: str) -> ParsedCred | None:
    """`k=v;k=v` ADO/OLEDB 커넥션스트링 1개 파싱. 없으면 None."""
    kv: dict[str, str] = {}
    for part in re.split(r";", text):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        kv[k.strip().lower()] = v.strip().strip('"').strip("'")
    user = kv.get("user id") or kv.get("uid") or kv.get("user") or kv.get("username")
    pw = kv.get("password") or kv.get("pwd")
    ds = (kv.get("data source") or kv.get("server") or kv.get("address")
          or kv.get("addr") or kv.get("network address"))
    if not (user and pw and ds):
        return None
    # Integrated Security(도메인 인증)는 v1 제외 — 비번 없음이면 위에서 이미 걸러짐
    engine = _engine_from_provider(kv)
    host, port = _split_host_port(ds, _DEFAULT_PORT.get(engine, 1433))
    db = kv.get("initial catalog") or kv.get("database")
    return ParsedCred(engine, host, port, user, pw, db,
                      kind=f"{engine}_connection_string")


_URL_RE = re.compile(
    r"(?P<scheme>jdbc:sqlserver|sqlserver|mssql|postgres(?:ql)?|mysql)://"
    r"(?P<user>[^:@/\s;]+):(?P<pw>[^@/\s;]+)@"
    r"(?P<host>[^:/\s;]+)(?::(?P<port>\d+))?(?:/(?P<db>[^?\s;]+))?",
    re.IGNORECASE,
)

# jdbc:sqlserver://host:1433;user=..;password=..  (URL 에 자격증명 미포함형)
_JDBC_MSSQL_RE = re.compile(
    r"jdbc:sqlserver://(?P<host>[^:/\s;]+)(?::(?P<port>\d+))?(?P<rest>;[^\s]*)",
    re.IGNORECASE,
)


def _scheme_engine(scheme: str) -> str:
    s = scheme.lower()
    if s.startswith(("postgres", "postgresql")):
        return "postgres"
    if s.startswith("mysql"):
        return "mysql"
    return "mssql"


def parse_db_url(text: str) -> ParsedCred | None:
    m = _URL_RE.search(text)
    if m:
        engine = _scheme_engine(m.group("scheme"))
        host = m.group("host")
        port = _DEFAULT_PORT.get(engine, 1433)
        if m.group("port"):
            try:
                p = int(m.group("port"))
                port = p if 1 <= p <= 65535 else _DEFAULT_PORT.get(engine, 1433)
            except ValueError:
                pass
        return ParsedCred(engine, host, port, m.group("user"), m.group("pw"),
                          m.group("db"), kind="database_url_with_password")
    # JDBC sqlserver (creds in ;user=;password=)
    j = _JDBC_MSSQL_RE.search(text)
    if j:
        rest = j.group("rest")
        kv = {}
        for part in rest.split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                kv[k.strip().lower()] = v.strip()
        user = kv.get("user") or kv.get("username") or kv.get("uid")
        pw = kv.get("password") or kv.get("pwd")
        if user and pw:
            port = int(j.group("port")) if j.group("port") else 1433
            return ParsedCred("mssql", j.group("host"), port, user, pw,
                              kv.get("databasename") or kv.get("database"),
                              kind="jdbc_sqlserver_url")
    return None


def parse_credentials(text: str, *, around_line: int | None = None,
                      window: int = 2) -> list[ParsedCred]:
    """본문에서 검증 가능한 DB 크리덴셜을 추출.

    around_line(1-based) 주면 그 라인 ± window 를 우선 파싱, 실패 시 전체 스캔.
    반환 순서 = 발견 순. 각 항목의 secret 은 raw(호출측이 즉시 validator 로 넘기고 폐기).
    """
    results: list[ParsedCred] = []
    lines = text.splitlines()

    def _try(chunk: str, line_no: int | None = None) -> None:
        for fn in (parse_ado_conn, parse_db_url):
            pc = fn(chunk)
            if pc and not any(
                r.engine == pc.engine and r.host == pc.host and r.user == pc.user
                for r in results
            ):
                # 실제 원문 라인 기록 — 검증결과를 정확한 hit 에 귀속시키기 위해 필수
                # (hint 라인과 실제 라인이 다를 수 있다).
                pc.line_no = line_no
                results.append(pc)

    # 1) 지정 라인 근처 우선
    if around_line is not None and 1 <= around_line <= len(lines):
        lo = max(0, around_line - 1 - window)
        hi = min(len(lines), around_line + window)
        for i, ln in enumerate(lines[lo:hi], start=lo + 1):
            _try(ln, i)
        # 근처 여러 줄이 합쳐진 커넥션스트링 대비 join 도 시도(라인 특정 불가 → None)
        _try(" ".join(lines[lo:hi]), None)
        if results:
            return results

    # 2) 전체 라인 스캔
    for i, ln in enumerate(lines, start=1):
        _try(ln, i)
    return results
