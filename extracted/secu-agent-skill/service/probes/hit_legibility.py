r"""Connection-string secret hit 에 DB host 를 legible 하게 덧붙인다 (엔진 무수정 우회).

## 문제
엔진 detector `generic_password_assignment` 의 값 캡처 `([^'\"\r\n,}\]]{8,200})` 은
세미콜론(`;`)을 안 거른다. ADO 커넥션스트링(`Password=xxxx;Data Source=host;...`)이
한 줄이면 비번 캡처가 host/catalog 까지 삼켜 `mask_secret` 이 그 blob 을 가린다 →
리포트에서 DB 위치(Data Source)가 안 보인다. regex 는 엔진(무수정)이라 못 고친다.

## 설계 (codex 레드팀 3라운드 반영)
재구성(host/user/db 원문 재직렬화)은 파서 greedy 캡처가 인접 secret/PII/injection 을
삼켜 새 누수 표면이 된다. 그래서 원문 값을 **방출하지 않고**, 엔진의 (이미 안전한)
masked line_preview 는 그대로 두고 거기에 **엄격 검증한 DB host[:port] 만** 접미로 덧붙인다.

안전 게이트(전부 통과해야 덧붙임):
  - 라인이 credentialed DB 커넥션스트링 문맥(host 키 + password 키 동시 존재, 또는 db:// URL).
  - host 가 **canonical IPv4/IPv6 리터럴**(scope-id 금지) 또는 **ASCII 점포함 FQDN**.
    → `%`·`@`·공백·유니코드·제어문자·단일라벨·URL조각·문장은 전부 거부.
  - port 는 1..65535 정수일 때만 표기.
  - 라인에서 얻은 host 가 **유일(distinct 1개)**, db:// URL 은 라인에 **1개 이하**.
  - 접미 문자열이 엔진 scan_text 재검사 통과.
조건 미달/예외 → 원본 hit 그대로(status quo). masked 컬럼·원본 preview 는 불변.

**잔여 한계(문법으로 환원 불가)**: Data Source 필드에 담긴 문법상 유효한 FQDN 이
공격자-주입 문자열(prompt-injection FQDN)이나 우연한 secret 일 가능성은 문법 검사만으론
못 막는다. 소유 자산(자기 SMB 공유의 레거시 DB-link)을 스캔하는 위협모델에서 수용하는
전제. 무-잔여를 원하면 host 부분 마스킹 또는 신뢰 자산 인벤토리 대조가 필요.
"""
from __future__ import annotations

import ipaddress
import re
from typing import Any

_CONNSTRING_KINDS = frozenset({
    "generic_password_assignment",
    "generic_config_secret_assignment",
    "database_url_with_password",
})
_HOST_KEYS = ("data source", "server", "address", "addr", "network address", "host")
_PW_KEYS = ("password", "pwd")
# 점 포함 FQDN (각 라벨 1-63자, 전체 ≤253). 단일라벨/공백/특수문자 host 는 거부.
_FQDN_RE = re.compile(
    r"^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)+"
    r"[A-Za-z0-9]([A-Za-z0-9\-]{0,61}[A-Za-z0-9])?$"
)
_DBURL_SCHEME_RE = re.compile(
    r"(?i)\b(?:postgres(?:ql)?|mysql|mongodb|redis|amqp|mssql|sqlserver|jdbc:[a-z0-9]+)://"
)
# connstring 시작 키 — `cn.Open "` / `var = "` 같은 래퍼 접두를 잘라내 첫 키 mangling 방지.
_CONN_KEY_RE = re.compile(
    r"(?i)(?:provider|data\s*source|server|user\s*id|uid|password|pwd|"
    r"initial\s*catalog|database|network\s*address|address|addr|host)\s*="
)
_ENGINE_LABEL = {"mssql": "mssql", "postgres": "postgres", "mysql": "mysql"}


def _safe_int(v: Any, default: int = 0) -> int:
    try:
        s = str(v).strip()
        if s.isascii() and s.lstrip("-").isdigit():
            return int(s)
    except Exception:  # noqa: BLE001
        pass
    return default


def _valid_port(p: Any) -> int | None:
    n = _safe_int(p, -1)
    return n if 1 <= n <= 65535 else None


def _coerce(h: Any) -> dict[str, Any]:
    if isinstance(h, dict):
        return dict(h)
    d: dict[str, Any] = {
        "category": getattr(h, "category", None),
        "kind": getattr(h, "kind", None),
        "masked": getattr(h, "masked", ""),
        "line_no": getattr(h, "line_no", 0),
        "line_preview": getattr(h, "line_preview", getattr(h, "preview", "")),
    }
    span = getattr(h, "span", None)
    if span is not None:
        d["span"] = span
    val = getattr(h, "validation", None)
    if val is not None:
        d["validation"] = val
    return d


def _raw_line(lines: list[str], d: dict[str, Any]) -> str | None:
    ln = _safe_int(d.get("line_no"), 0)
    if 1 <= ln <= len(lines):
        return lines[ln - 1]
    return None


def _valid_host(h: str | None) -> str | None:
    """canonical IPv4/IPv6(scope 금지) 또는 ASCII 점포함 FQDN 만 통과. 반환은 canonical."""
    if not h:
        return None
    h = h.strip().strip("[]")
    if not h or len(h) > 253 or not h.isascii() or not h.isprintable():
        return None
    if "%" in h:                      # IPv6 scope-id → 임의 원문 채널, 전면 거부
        return None
    try:
        ip = ipaddress.ip_address(h)  # IPv4/IPv6 리터럴 → canonical 문자열로
        return str(ip)
    except ValueError:
        pass
    if "." in h and _FQDN_RE.match(h):
        return h
    return None


def _ado_pairs(s: str) -> list[tuple[str, str]]:
    """quote/brace-aware ADO key=value 파싱. `=` 뒤 공백 skip 후 quote/brace 판정.

    NOTE: 따옴표로 감싼 '값' 을 다시 파싱하지 않는다(따옴표 안 `Host=..` 를 host 로
    승격시키던 누수 차단 — codex r3#1). `obj.Method "..."` 처럼 최상위에 노출된
    connstring 은 첫 `=` 이후 `;key=value` 들이 최상위 pair 로 잡혀 정상 추출된다.
    """
    pairs: list[tuple[str, str]] = []
    i, n = 0, len(s)
    while i < n:
        j = s.find("=", i)
        if j == -1:
            break
        key = s[i:j].strip().lower()
        i = j + 1
        while i < n and s[i] in " \t":
            i += 1
        if i < n and s[i] == "{":
            i += 1
            buf: list[str] = []
            while i < n:
                if s[i] == "}":
                    if i + 1 < n and s[i + 1] == "}":
                        buf.append("}")
                        i += 2
                        continue
                    i += 1
                    break
                buf.append(s[i])
                i += 1
            val = "".join(buf)
            k = s.find(";", i)
            i = k + 1 if k != -1 else n
        elif i < n and s[i] in "\"'":
            q = s[i]
            i += 1
            buf = []
            while i < n:
                if s[i] == q:
                    if i + 1 < n and s[i + 1] == q:
                        buf.append(q)
                        i += 2
                        continue
                    i += 1
                    break
                buf.append(s[i])
                i += 1
            val = "".join(buf)
            k = s.find(";", i)
            i = k + 1 if k != -1 else n
        else:
            k = s.find(";", i)
            if k == -1:
                val = s[i:]
                i = n
            else:
                val = s[i:k]
                i = k + 1
        pairs.append((key, val.strip().strip('"').strip("'")))
    return pairs


def _split_host_port_safe(host: str, default_port: int) -> tuple[str, int]:
    from service.probes.credential_parse import _split_host_port
    try:
        return _split_host_port(host, default_port)
    except Exception:  # noqa: BLE001
        return host.strip(), default_port


def _host_candidates(line: str) -> list[tuple[str, str, int | None]]:
    """라인에서 (engine, canonical_host, port|None) 후보. DB 문맥 + host 검증분만."""
    from service.probes.credential_parse import parse_db_url, _DEFAULT_PORT

    cands: list[tuple[str, str, int | None]] = []

    # 1) ADO — credentialed connstring(host 키 + password 키 동시)일 때만.
    #    래퍼 접두(`cn.Open "`, `var = "`)를 첫 connstring 키 위치로 잘라 mangling 방지.
    #    quote-aware `_ado_pairs` 는 유지 → 따옴표 안 `Host=` 승격은 여전히 차단.
    km = _CONN_KEY_RE.search(line)
    payload = line[km.start():] if km else line
    pd = {k: v for k, v in _ado_pairs(payload)}
    has_pw = any(pd.get(k) for k in _PW_KEYS)
    raw_host = next((pd[k] for k in _HOST_KEYS if pd.get(k)), None)
    if has_pw and raw_host:
        provider = (pd.get("provider") or "").lower()
        engine = "mssql"
        if "npgsql" in provider or "postgres" in provider:
            engine = "postgres"
        elif "mysql" in provider:
            engine = "mysql"
        h, port = _split_host_port_safe(raw_host, _DEFAULT_PORT.get(engine, 1433))
        vh = _valid_host(h)
        if vh:
            cands.append((engine, vh, _valid_port(port)))

    # 2) db:// URL — 라인에 정확히 1개일 때만(복수 URL 모호 → skip).
    if len(_DBURL_SCHEME_RE.findall(line)) == 1:
        pc = parse_db_url(line)
        if pc:
            vh = _valid_host(pc.host)
            if vh:
                cands.append((pc.engine, vh, _valid_port(pc.port)))
    return cands


def _trips_detector(fragment: str) -> bool:
    if not fragment:
        return False
    try:
        from secu_agent.detectors import scan_text
        return bool(scan_text(fragment).hits)
    except Exception:  # noqa: BLE001
        return True


def _augment_one(lines: list[str], d: dict[str, Any]) -> dict[str, Any]:
    line = _raw_line(lines, d)
    if not line:
        return d
    cands = _host_candidates(line)
    if not cands:
        return d
    if len({c[1] for c in cands}) != 1:   # 유일한 host 일 때만
        return d
    engine, host, port = cands[0]
    label = _ENGINE_LABEL.get(engine, "db")
    disp = f"[{host}]" if ":" in host else host   # IPv6 는 [addr]
    if port:
        disp = f"{disp}:{port}"
    suffix = f"  ⟶ [db-endpoint {label} host={disp}]"
    if _trips_detector(suffix):
        return d
    out = dict(d)
    out["line_preview"] = str(out.get("line_preview") or "") + suffix
    return out


def relegible_hits(text: str, items: "list[Any]") -> list[dict[str, Any]]:
    """connstring secret hit 의 line_preview 에 검증된 DB host 를 덧붙인다.

    masked 컬럼·다른 hit·원본 preview 본문은 불변. `validation` 등 부가 키 보존.
    hit별 예외는 fallback(도구 중단 금지). 줄 분할은 엔진과 동일하게 `\n` 만.
    """
    text = str(text or "")
    lines = text.split("\n")
    result: list[dict[str, Any]] = []
    for h in items:
        try:
            d = _coerce(h)
            if str(d.get("category") or "") == "secret" and d.get("kind") in _CONNSTRING_KINDS:
                result.append(_augment_one(lines, d))
            else:
                result.append(d)
        except Exception:  # noqa: BLE001 — 어떤 예외도 도구 전체를 중단시키지 않는다.
            try:
                result.append(_coerce(h))
            except Exception:  # noqa: BLE001
                pass
    return result


def enrich_and_relegible(text: str, hits: "list[Any]", **kw: Any) -> list[dict[str, Any]]:
    """엔진 `enrich_hits_with_safe_probes`(HTTP reachability) 뒤에 host augment 합성."""
    from secu_agent.agent.safe_probe import enrich_hits_with_safe_probes
    return relegible_hits(text, enrich_hits_with_safe_probes(text, hits, **kw))
