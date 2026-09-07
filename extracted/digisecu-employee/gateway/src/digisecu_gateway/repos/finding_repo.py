"""finding 축 — 코어 finding_lifecycle 마스킹 projection.

finding_lifecycle 은 core secu_agent.state 소유이나 게이트웨이가 state_domain의 유일 외부 read
어댑터로서 같은 물리 DB(threat_hunter)에서 read-only SELECT(codex #4 정합). 쿼리 형태는 엔진
finding_list(state.py:1749) 계승(status/task_type/since 필터, ORDER BY last_seen DESC,id DESC).

마스킹(적대적 검증 반영): summary는 submit 경로만 seal·update 경로 unsealed, asset은 seal 전무 →
_to_finding에서 read 경계 방어 재마스킹(masking.redact). extra_json/evidence_ref 경로는 미노출.
task_type 필터는 domain→task_types(github=jenkins 포함)로, 1:1 가정의 finding 은닉을 방지한다.
"""
from __future__ import annotations

import ipaddress
import itertools
import json
import math
import re
from typing import Any, Callable
from urllib.parse import urlsplit

from .. import taxonomy
from ..domains import is_dssoc
from ..db import ReadOnlyPool
from ..masking import redact, redact_secrets_only, strip_unsafe
from ..models import (
    DetailHit,
    EvidenceNote,
    FindingCategory,
    FindingList,
    FindingMetadata,
    GatewayFinding,
    GatewayFindingDetail,
    HitLoginValidation,
    Assignee,
    PivotProbe,
    PivotSummary,
    RiskNarrative,
    Verification,
)

# 마스킹 안전 컬럼만. extra_json(pivot slot seal 우회 가능)·evidence_ref 경로는 select 안 함.
_COLS = (
    "id, task_type, asset, asset_kind, severity, summary, status, owner, "
    "ticket_ref, first_seen, last_seen, seen_count, (evidence_ref IS NOT NULL) AS has_evidence"
)
# 단건 상세 전용: 위 + extra_json(화이트리스트 리치필드 투영·경계 재마스킹). 리스트엔 안 씀.
_DETAIL_COLS = _COLS + ", extra_json"
# 엔진 SSOT domain_reports._OPEN_STATUSES.
_OPEN_STATUSES = ("open", "triaged")

# ── 상세 투영 캡(codex 적대검증: 모든 문자열·컬렉션에 상한). 마스킹→절단 순서 필수. ──
_HIT_MAX = 20
# hit preview 는 '전문 펼치기'용으로 상향(마스킹된 미리보기, 여전히 바운드). UI 는 접어두고
# 클릭 시 확장하며 '최대 N자'로 정직 라벨(codex: 240→긴 값은 '전문'이 아니라 긴 미리보기).
_PREVIEW_MAX = 2000
_LOCATION_MAX = 200
_KIND_MAX = 80
_CATEGORY_MAX = 40
_TEXT_MAX = 2000        # narrative parts·pivotInterpretation
_ACTION_MAX = 400
_ACTIONS_MAX = 20
_NOTE_MAX = 20
_NOTE_TEXT_MAX = 800
_FIELD_NAME_MAX = 120
_FIELDS_MAX = 30
_PROBE_MAX = 12
_EVIDENCE_MASKED_MAX = 240
_URL_MAX = 200
_STATUS_MAX = 12
_CONTENT_TYPE_MAX = 80
_META_VAL_MAX = 200
_TARGET_MAX = 200
_VERIF_MAX = 80
# 원소스 순회 상한(DoS 방어) — 캡 전에 무한대 리스트를 다 걷지 않도록 스캔 자체를 제한.
_SCAN_MAX = 500
# 정규 git SHA 길이(short 7~12 / SHA-1 40 / SHA-256 64)만 verbatim 보존 — 엔트로피 마스킹 파괴 방지.
# 적대검증 반영: 임의 32자 hex(흔한 시크릿 길이)는 보존하지 않고 redact(커밋 위장 시크릿 누출 차단).
_COMMIT_RE = re.compile(r"\A(?:[0-9a-fA-F]{7,12}|[0-9a-fA-F]{40}|[0-9a-fA-F]{64})\Z")
_HTTP_STATUS_RE = re.compile(r"\A(?:[1-5][0-9]{2}|000)\Z")
# 화이트리스트 metadata 키(src=snake_case in extra) → 출력 카멜 필드.
_META_KEYS = {"repo": "repo", "path": "path", "source": "source", "commit": "commit",
              "scan_method": "scanMethod"}

# ── 로그인 검증(hit.validation.login_probe) 투영 상수 ──────────────────────────────
# '로그인 사실'을 담은 결과만 표면화한다. skipped_*/not_performed/error/unreachable 은 크리덴셜
# 유효성에 대해 아무 말도 하지 않으므로 어휘 밖 → 통째 드롭(스킬 _INFORMATIVE 와 같은 어휘).
# 고정 어휘로 두는 이유: 이 값이 UI 배지 문구를 결정하므로, DB 문자열이 그대로 올라오면 "검증됨"
# 같은 문구를 위조할 수 있다(read 경계 스푸핑).
_LOGIN_RESULTS = frozenset({
    "authenticated", "auth_failed", "account_locked", "credential_expired", "session_denied",
})
_LOGIN_ENGINES = frozenset({"mssql", "postgres"})
_PRINCIPAL_MAX = 64
# 계정 마스킹 문자셋(첫/끝 글자에만 허용). 가운데는 전부 `*` 여야 한다.
_PRINCIPAL_CHAR_RE = re.compile(r"\A[A-Za-z0-9._@\\-]{2}\Z")
# 점 포함 FQDN(라벨 1~63자, 하이픈 시작/끝 금지). IP 리터럴은 ipaddress 로 별도 검증.
_FQDN_RE = re.compile(
    r"\A(?=.{1,253}\Z)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(?:\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+\Z"
)
_ELAPSED_MS_MAX = 3_600_000  # 1시간 — 그 이상은 의미 없는 값(드롭)
_PROOF_DEPTH_MAX = 4         # legacy multi 중첩 탐색 깊이 상한(재귀 DoS)
_PROOF_PROBES_MAX = 32

# ── 카테고리(리스트/payload): extra_json 통째 전송 대신 category 만 서버측 jsonb 추출(codex).
# IS JSON 가드로 malformed 행이 쿼리를 깨지 않게. lax path 라 hits 없으면 [] 반환.
_LIST_CAT_SQL = (
    ", CASE WHEN extra_json IS JSON THEN "
    "jsonb_path_query_array(extra_json::jsonb, '$.hits[*].category') ELSE '[]'::jsonb END AS hit_cats"
    ", CASE WHEN extra_json IS JSON THEN "
    "(extra_json::jsonb -> 'hit_categories') ELSE NULL END AS hit_categories_raw"
)
_LIST_COLS = _COLS + _LIST_CAT_SQL
_UNCLASSIFIED = FindingCategory(key="unclassified", label="미분류")

# ── 담당자(detail 전용) — source raw 미노출, 고정 라벨만. dev_web=담당자 개념 없음.
_OWNER_SOURCE_LABELS = {
    "smb": "Splunk 매칭", "github": "커밋 작성자", "confluence": "페이지 소유자",
    # github_repo_owner.source 미러. **확정과 추정을 라벨로도 갈라 둔다** — 조직 저장소는
    # GHES 에 담당자 개념이 없어 1위 기여자로 대신하는 것이라 같은 말로 부르면 안 된다.
    # 콘솔에서 사람이 지정한 담당자 — Splunk 매칭과 구분해 보여준다.
    "console:manual": "수동 지정",
    "repo_login": "저장소 소유자",
    # 2026-09-01 추가. 커밋 작성자의 **사내 메일**이 Knox 에서 확인된 것 — 주소를 우리가
    # 조립한 게 아니라 git 이 기록한 값이라 추정이 아니다. 라벨을 안 넣으면 새 출처가
    # 조용히 "알 수 없음" 으로 빠진다(이 저장소가 반복해서 당한 형태).
    "commit_author": "커밋 작성자(사내 메일 확인)",
    "top_contributor": "주 기여자(추정)",
}
#: 근거가 추정인 것. Assignee.confirmed=False 로 나간다.
_UNCONFIRMED_SOURCES = frozenset({"top_contributor"})
# github:org/repo/... → org/repo. domains.SRC_EXPR["github"] 와 같은 규칙(SQL 판의 Python 미러).
_GITHUB_REPO_RE = re.compile(r"\Agithub:([^/]+/[^/]+)")
# 단일 사내 메일박스만(리스트·표시명·과길이 거부). RFC 전체가 아니라 보수적.
_OWNER_EMAIL_RE = re.compile(r"\A[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}\Z")
# smb://<IPv4>/… 에서 리터럴 IP 만 파싱(DNS·퍼지 금지, codex).
_SMB_IP_RE = re.compile(r"\Asmb://(\d{1,3}(?:\.\d{1,3}){3})(?:[:/]|\Z)")
# dssoc/soc/noreply 계열은 담당자 아님(발송대상) — 담당자로 오표기 금지(적대검증 반영).
# 정의는 `domains.is_dssoc` 하나다(env 를 읽는다). 여기 사본은 안 읽었다.
_is_dssoc_email = is_dssoc


def _owner_line(v: Any, cap: int) -> str | None:
    """담당자 **이름·부서 전용** 정화 — 한 줄로 접고 절단한다. `redact()` 는 **일부러 안 탄다.**

    ★ 사용자 결정(2026-08-23): "담당자 이름/소속은 마스킹하는 거 아니다."
    담당자를 화면에 띄우는 목적 자체가 "누구에게 가야 하는가" 를 사람이 읽는 것이라,
    이름이 봉인되면 그 열은 존재 이유가 없어진다(발송 대상 메일이 `_owner_email` 에서
    이미 같은 이유로 redact 를 우회하는 것과 같은 논리).

    ⚠️ 그전까지는 redact 를 탔고 **우연히** 안 걸렸을 뿐이다 — 실측 시점의 값 430개가
    전부 통과한 건 한글 이름·부서명이 마스킹 패턴(16자+ hex·20~39자 토큰런·이메일)에
    안 맞아서다. 영문 성명이나 긴 부서 문자열은 언제든 걸릴 수 있었다. 그래서 "안 걸린다" 에
    기대지 않고 **규칙으로 뺀다.**

    ⚠️ 다만 두 가지는 유지한다.
    · 제어문자·제로폭·BIDI override 제거 — 마스킹이 아니라 **표시 안전** 문제다(UI 상 텍스트를
      시각적으로 뒤집는 스푸핑).
    · `redact_secrets_only()` — 이름 칸에 AWS 키 같은 게 들어오면 게이트웨이가 시크릿 반출
      통로가 된다. 사람 이름·조직명과 겹치지 않는 **고신뢰 시크릿 패턴만** 봉인한다.
      (`redact()` 전체를 태우면 `_TOKEN_RUN`·`_EMAIL` 이 평범한 영문 조직명을 먹는다.)
    """
    if not isinstance(v, str):
        return None
    s = re.sub(r"\s+", " ", redact_secrets_only(v) or "").strip()[:cap]
    return s.strip() or None


def _cat_kwargs(cats_list: list[str]) -> dict[str, Any]:
    rep, allc = taxonomy.classify([c for c in cats_list if isinstance(c, str)])
    return {
        "category": FindingCategory(**rep) if rep else _UNCLASSIFIED,
        "categories": [FindingCategory(**c) for c in allc],
    }


def _cats_from_row(r: dict) -> dict[str, Any]:
    hc = r.get("hit_cats")
    hcr = r.get("hit_categories_raw")
    cats = [c for c in hc if isinstance(c, str)] if isinstance(hc, list) else []
    if not cats and isinstance(hcr, list):
        cats = [c for c in hcr if isinstance(c, str)]
    return _cat_kwargs(cats)


def _owner_emails(v: Any, *, cap: int = 8) -> list[str]:
    """콤마/세미콜론으로 이어붙은 담당자 목록 → 검증된 사내 메일박스 리스트.

    ★ `owner_recipient` 는 **한 명이 아닐 수 있다.** 스킬의 리포트 스레드 upsert 가
      여러 finding 을 한 스레드로 모을 때 담당자를 합집합(정렬 후 ", " 결합)으로 쌓는다
      (`state_domain._merge_service_recipients`). 그 값을 단건 검증기 `_owner_email` 에
      그대로 넣으면 문법검증에서 **통째로 거부**되어 화면에 "담당자 없음" 으로 뜬다.

    ⚠️ 실측 2026-08-28: confluence 스레드 17건 중 6건이 다중주소였고, finding 이 있는
       12개 space 중 5개가 이 이유로 미매칭이었다(상관 100%). 문서에 작성자가 있는데
       담당자가 비어 보이던 증상이 이것이다.

    ⚠️ `_owner_email` 자체는 **느슨하게 만들지 않는다.** 그쪽은 발송 대상을 고르는
       자리라 "단일 유효 메일박스만" 이 안전 규칙이다. 여기는 **표시 전용**이라 목록을
       받아 각각을 같은 엄격함으로 검증한다 — 규칙을 푸는 게 아니라 나눠서 적용한다.
    """
    if not isinstance(v, str):
        return []
    out: list[str] = []
    for part in re.split(r"[,;]", v):
        email = _owner_email(part)
        if email and email not in out:
            out.append(email)
        if len(out) >= cap:
            break
    return out


def _owner_email(v: Any) -> str | None:
    """단일 유효 사내 메일박스만 통과(secret redact 우회 — 마스킹하면 발송대상 식별 불가).
    제어/제로폭 제거 후 엄격 문법검증. 리스트·표시명·CRLF·과길이는 거부."""
    if not isinstance(v, str):
        return None
    s = (strip_unsafe(v) or "").strip()
    if not s or len(s) > 254:
        return None
    return s if _OWNER_EMAIL_RE.match(s) else None


# ── 필드 스칼라 검증·마스킹 헬퍼(모두 마스킹→절단 순서) ──
def _red(v: Any, cap: int) -> str | None:
    """str 이면 redact 후 절단(마스킹→절단), 아니면 None. 빈 문자열도 None."""
    if not isinstance(v, str):
        return None
    out = (redact(v) or "")[:cap]
    return out or None


def _red_or_empty(v: Any, cap: int) -> str:
    return _red(v, cap) or ""


def _pos_int(v: Any) -> int | None:
    # bool 은 int 하위이므로 명시 배제. 양수만.
    if isinstance(v, bool) or not isinstance(v, int):
        return None
    return v if v > 0 else None


def _nonneg_int(v: Any) -> int | None:
    if isinstance(v, bool) or not isinstance(v, int):
        return None
    return v if v >= 0 else None


def _confidence(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    if not math.isfinite(f) or f < 0.0 or f > 1.0:
        return None
    return f


def _commit(v: Any) -> str | None:
    # 유효 hex 커밋만 보존(엔트로피 마스킹이 파괴하므로). 그 외 형태는 방어적으로 redact.
    if isinstance(v, str) and _COMMIT_RE.match(v):
        return v
    return _red(v, 64)


def _http_status(v: Any) -> str:
    s = v if isinstance(v, str) else (str(v) if isinstance(v, int) and not isinstance(v, bool) else "")
    return s if _HTTP_STATUS_RE.match(s or "") else "000"


def _sanitize_url(v: Any) -> str | None:
    """scheme(http/https)+host+path 만. userinfo/query/fragment 제거 후 redact→절단.
    비클릭·비허용 scheme·파싱 실패는 None.

    주의(적대검증): urlsplit 은 lazy 라 `.port`/`.hostname` 접근 시점에 잘못된 포트(범위밖·비정수)
    로 ValueError 를 던진다 → 반드시 try 안에서 접근(밖이면 라우트가 500 → enumeration/DoS)."""
    if not isinstance(v, str):
        return None
    try:
        u = urlsplit(v.strip())
        if u.scheme not in ("http", "https") or not u.hostname:
            return None
        host = u.hostname
        port = u.port  # 잘못된 포트는 여기서 ValueError
        if port is not None:
            host = f"{host}:{port}"
        rebuilt = f"{u.scheme}://{host}{u.path or ''}"
    except (ValueError, UnicodeError):
        return None
    return _red(rebuilt, _URL_MAX)


def _safe(fn: Callable[[dict], Any], extra: dict) -> Any:
    """투영 함수를 감싸 예외 시 None(해당 필드만 소실, 500 금지). fail-closed."""
    try:
        return fn(extra)
    except Exception:  # noqa: BLE001 — 어떤 malformed extra 도 500 로 이어지면 안 됨
        return None


def _str_list(v: Any, *, item_cap: int, n: int) -> list[str]:
    if not isinstance(v, list):
        return []
    out: list[str] = []
    for item in v[:_SCAN_MAX]:  # 원소스 순회 상한(DoS)
        r = _red(item, item_cap)
        if r is not None:
            out.append(r)
        if len(out) >= n:
            break
    return out


def _load_extra(extra_json: object) -> dict[str, Any]:
    if not extra_json:
        return {}
    try:
        extra = extra_json if isinstance(extra_json, dict) else json.loads(str(extra_json))
    except (ValueError, TypeError):
        return {}
    return extra if isinstance(extra, dict) else {}


# ── 로그인 검증 투영 헬퍼 ────────────────────────────────────────────────────────
def _valid_host(v: Any) -> str | None:
    """IP 리터럴(정규 표기로 재조립) 또는 점 포함 FQDN 만 통과.

    원문 문자열을 그대로 흘리지 않는 것이 핵심 — IPv6 scope-id(`%eth0`)는 임의 원문을 실어나르는
    채널이라 전면 거부하고, 비ASCII/제어문자/과길이도 거부한다."""
    if not isinstance(v, str):
        return None
    h = v.strip().strip("[]")
    if not h or len(h) > 253 or not h.isascii() or not h.isprintable():
        return None
    if "%" in h:
        return None
    try:
        return str(ipaddress.ip_address(h))
    except ValueError:
        pass
    # 최상위 라벨이 전부 숫자면 정규 FQDN 이 아니다(RFC 1123). ip_address 가 이미 실패했으므로
    # 이건 **깨진/위장 IP 표기**다 — 예: 012.1.1.1(선행 0 = 일부 리졸버에서 8진수 해석),
    # 999.1.1.1. 그대로 찍으면 운영자가 다른 호스트로 오독한다(표시 스푸핑).
    labels = h.split(".")
    if labels[-1].isdigit():
        return None
    if not _FQDN_RE.match(h):
        return None
    # endpoint 는 이 모듈에서 유일하게 redact() 를 안 타는 free-text 가 될 수 있다. FQDN 문법을
    # 만족하면서 시크릿을 실어나르는 값(AKIA…​.corp.example.com, 63자 hex 라벨)이 그대로 나가지
    # 않도록, redact 가 무언가 봉인하는 값이면 **표시하지 않는다**(마스킹된 호스트는 무의미하므로).
    return h if redact(h) == h else None


def _endpoint(host: Any, port: Any) -> str | None:
    """검증된 host/port 로 `host:port` 를 **재조립**(원문 통과 아님). IPv6 는 [addr]:port."""
    h = _valid_host(host)
    if h is None:
        return None
    bracketed = f"[{h}]" if ":" in h else h
    p = _pos_int(port)
    if p is None or p > 65535:
        return bracketed
    return f"{bracketed}:{p}"


def _principal_masked(v: Any) -> str | None:
    """생산자 마스커(`u[0] + '*'*(n-2) + u[-1]`, n<=2 면 전부 `*`)의 **정확한 형상**만 통과.

    적대검증 지적: '별표가 하나라도 있으면 통과' 규칙은 `realadmin*`·`DOMAIN\\administrator*`
    같은 사실상 평문 계정을 그대로 화면에 올린다. 가운데가 전부 `*` 인 형상만 허용해 노출을
    첫/끝 2글자로 묶는다. 형상이 어긋나면(=마스킹되지 않은 값일 수 있으므로) 버린다."""
    # redact() 의 _EMAIL 정규식은 입력 길이에 대해 2차라, 3만자 입력 하나로 게이트웨이 프로세스가
    # 수 초간 멈춘다(GIL). 마스킹된 계정은 정의상 짧으므로 **redact 전에** 비상식적 길이를 컷한다
    # (마스킹→절단 순서 원칙은 유지 — 여기서 자르는 게 아니라 '계정이 아님'으로 판정해 버린다).
    if isinstance(v, str) and len(v) > 4 * _PRINCIPAL_MAX:
        return None
    s = _red(v, _PRINCIPAL_MAX)
    if s is None:
        return None
    if len(s) <= 2:
        return s if set(s) == {"*"} else None
    body = s[1:-1]
    if set(body) != {"*"} or not _PRINCIPAL_CHAR_RE.match(s[0] + s[-1]):
        return None
    return s


def _login_proof(validation: Any, *, _depth: int = 0) -> dict[str, Any] | None:
    """validation 에서 로그인 프로브 증거를 꺼낸다(중첩 login_probe / 평면 / legacy multi).

    스킬 `state_domain._login_proof_of` 와 동일 규칙 — 한쪽만 알면 shape drift 시 배지가 조용히
    사라진다. top-level 은 judge 계약상 `credential_reachability` 로 남아있으므로 여기서 파헤친다."""
    if _depth > _PROOF_DEPTH_MAX or not isinstance(validation, dict):
        return None
    lp = validation.get("login_probe")
    if isinstance(lp, dict):
        return lp
    if validation.get("kind") == "credential_login_probe":
        # 프로브 도구가 에이전트에 돌려주는 **최상위 래퍼**({kind, domain, probed, results:[...]})를
        # LLM 이 그대로 인용하는 경우가 있다. 래퍼 자신에는 result 가 없어 어휘 검증에서 통째
        # 드롭되고 배지가 사라진다 — results[] 안으로 한 단계 들어간다(성공 우선).
        results = validation.get("results")
        if "result" not in validation and isinstance(results, list):
            first: dict[str, Any] | None = None
            for r in results[:_PROOF_PROBES_MAX]:
                if not isinstance(r, dict):
                    continue
                if r.get("result") == "authenticated":
                    return r
                if first is None:
                    first = r
            return first
        return validation
    if validation.get("kind") == "multi":  # legacy 데이터 호환
        probes = validation.get("probes")
        if isinstance(probes, list):
            first: dict[str, Any] | None = None
            for p in probes[:_PROOF_PROBES_MAX]:
                found = _login_proof(p, _depth=_depth + 1)
                if found is None:
                    continue
                # 첫 dict 를 그냥 반환하면 앞선 error/skip 항목 때문에 뒤의 진짜 성공이 묻힌다.
                if found.get("result") == "authenticated":
                    return found
                if first is None:
                    first = found
            return first
    return None


def _project_login_validation(h: dict) -> HitLoginValidation | None:
    """hit.validation → 로그인 검증 요약(화이트리스트). 고정 어휘 밖이면 통째 드롭(fail-closed).

    **투영 금지 키**: auth_attempts(평문 username 보유)·credential_fields·targets·bound_masked
    (detector masked 원문 사본). 여기서 키를 하나씩 꺼내는 이유가 그것이다 — dict 통째 통과 금지."""
    p = _login_proof(h.get("validation"))
    if p is None:
        return None
    result = p.get("result")
    if not isinstance(result, str) or result not in _LOGIN_RESULTS:
        return None
    proves = p.get("proves_validity") is True
    # 모순 드롭(fail-closed): authenticated 인데 proves_validity 가 아니면 둘 중 하나가 거짓이다.
    # 어느 쪽인지 모르는 채로 "로그인 성공"을 렌더하면 사람이 잘못된 사실을 믿는다.
    if result == "authenticated" and not proves:
        return None
    # engine 이 있는데 어휘 밖이면(mysql/oracle 등) 우리가 아는 프로브 경로가 아니다 → 통째 드롭.
    # engine 만 None 으로 비우면 성공 증거는 남아 헤더 배지까지 켜진다(적대검증 실증).
    engine = p.get("engine")
    if engine is not None and not (isinstance(engine, str) and engine in _LOGIN_ENGINES):
        return None
    elapsed = _nonneg_int(p.get("elapsed_ms"))
    return HitLoginValidation(
        result=result,
        provesValidity=proves,
        engine=engine,
        # 같은 프로브가 두 이름을 쓴다: SMB 영속만 endpoint_host/port 로 리네임하고,
        # 도구가 그대로 돌려주는 to_public_dict() 는 host/port 다. 둘 다 받는다.
        # (반면 `user` 는 **평문 계정**이라 절대 받지 않는다 — principal_masked 만.)
        endpoint=_endpoint(
            p.get("endpoint_host") if p.get("endpoint_host") is not None else p.get("host"),
            p.get("endpoint_port") if p.get("endpoint_port") is not None else p.get("port"),
        ),
        principalMasked=_principal_masked(p.get("principal_masked")),
        singleAttempt=p.get("single_attempt") is True,
        elapsedMs=elapsed if elapsed is not None and elapsed <= _ELAPSED_MS_MAX else None,
    )


# ── 리치 필드 투영(전부 화이트리스트·malformed→skip, 절대 500 금지) ──
def _project_hits(extra: dict) -> list[DetailHit] | None:
    raw = extra.get("hits")
    if not isinstance(raw, list):
        return None
    items = [h for h in raw[:_SCAN_MAX] if isinstance(h, dict)]  # 원소스 순회 상한(DoS)
    # 무거운 preview 마스킹 **전에** 검증 증거만 먼저 뽑아 순서를 정한다. 원본 순서대로 _HIT_MAX
    # 에서 잘라버리면 21번째에 있는 authenticated 증거가 통째로 사라진다(적대검증 실증).
    # hit 단위 격리: 한 hit 의 malformed validation 이 hits 전체를 None 으로 날리면(=_safe 는
    # _project_hits 함수 단위라) 기존 증거 표시가 통째로 사라진다(무증상 회귀).
    logins: list[HitLoginValidation | None] = []
    for h in items:
        try:
            logins.append(_project_login_validation(h))
        except Exception:  # noqa: BLE001
            logins.append(None)

    def _rank(i: int) -> int:
        lv = logins[i]
        if lv is None:
            return 2
        return 0 if (lv.result == "authenticated" and lv.provesValidity) else 1

    # 동순위는 원본 순서 유지 — 검증 증거가 하나도 없으면 기존 표시 순서와 동일하다.
    order = sorted(range(len(items)), key=lambda i: (_rank(i), i))
    out: list[DetailHit] = []
    for i in order:
        h = items[i]
        # preview: 제네릭=preview / github·service=line_preview / 폴백=masked. 마스킹→절단.
        preview_src = h.get("preview") or h.get("line_preview") or h.get("masked") or ""
        preview = _red_or_empty(preview_src, _PREVIEW_MAX)
        category = _red_or_empty(h.get("category"), _CATEGORY_MAX)
        kind = _red_or_empty(h.get("kind"), _KIND_MAX)
        login = logins[i]
        if not (category or kind or preview or login):
            continue  # 유효 내용 없는 hit 은 skip
        out.append(DetailHit(
            category=category,
            kind=kind,
            lineNo=_pos_int(h.get("line_no")),
            location=_red(h.get("location"), _LOCATION_MAX),
            preview=preview,
            loginValidation=login,
        ))
        if len(out) >= _HIT_MAX:
            break
    return out or None


def _project_risk(extra: dict) -> RiskNarrative | None:
    rn = extra.get("risk_narrative")
    if not isinstance(rn, dict):
        return None
    what = _red(rn.get("what_is_data"), _TEXT_MAX)
    how = _red(rn.get("how_discovered"), _TEXT_MAX)
    expl = _red(rn.get("exploitation_path"), _TEXT_MAX)
    verif = _red(rn.get("verification_method"), _TEXT_MAX)
    if not any((what, how, expl, verif)):
        return None
    return RiskNarrative(
        whatIsData=what, howDiscovered=how, exploitationPath=expl, verificationMethod=verif,
    )


def _project_evidence_notes(extra: dict) -> list[EvidenceNote] | None:
    notes = extra.get("evidence_notes")
    if not isinstance(notes, dict):
        return None
    out: list[EvidenceNote] = []
    for loc, note in itertools.islice(notes.items(), _SCAN_MAX):  # 원소스 순회 상한(DoS)
        if not isinstance(note, dict):
            continue
        out.append(EvidenceNote(
            location=_red_or_empty(loc, _LOCATION_MAX),  # dict 키도 redact(codex)
            whatThisIs=_red(note.get("what_this_is"), _NOTE_TEXT_MAX),
            sensitiveFields=_str_list(note.get("sensitive_fields"), item_cap=_FIELD_NAME_MAX, n=_FIELDS_MAX),
            contextNote=_red(note.get("context_note"), _NOTE_TEXT_MAX),
        ))
        if len(out) >= _NOTE_MAX:
            break
    return out or None


def _project_pivot(extra: dict) -> PivotSummary | None:
    pv = extra.get("pivot")
    if not isinstance(pv, dict):
        return None
    raw_probes = pv.get("probes")
    if not isinstance(raw_probes, list):
        return None  # error-shaped({version,error}) 등 → None
    probes: list[PivotProbe] = []
    for p in raw_probes[:_SCAN_MAX]:  # 원소스 순회 상한(DoS)
        if not isinstance(p, dict):
            continue
        url = _sanitize_url(p.get("url"))
        if url is None:
            continue  # 비허용 scheme·파싱 실패 probe skip
        probes.append(PivotProbe(
            url=url,
            status=_http_status(p.get("status")),
            exposed=bool(p.get("exposed")),
            contentType=_red(p.get("content_type"), _CONTENT_TYPE_MAX),
            evidenceMasked=_red(p.get("evidence_masked"), _EVIDENCE_MASKED_MAX),
        ))
        if len(probes) >= _PROBE_MAX:
            break
    exposed_count = _nonneg_int(pv.get("exposed_count"))
    if exposed_count is None:
        exposed_count = sum(1 for p in probes if p.exposed)
    if not probes and exposed_count == 0:
        return None
    return PivotSummary(exposedCount=exposed_count, probes=probes)


def _project_verification(extra: dict) -> Verification | None:
    v = extra.get("verification")
    if not isinstance(v, dict):
        return None
    status = _red(v.get("status"), _VERIF_MAX)
    method = _red(v.get("method"), _VERIF_MAX)
    source = _red(v.get("source"), _VERIF_MAX)
    if not any((status, method, source)):
        return None
    return Verification(status=status, method=method, source=source)


def _project_metadata(extra: dict) -> FindingMetadata | None:
    md = extra.get("metadata")
    if not isinstance(md, dict):
        return None
    kw: dict[str, str | None] = {}
    for src_key, out_key in _META_KEYS.items():
        if src_key not in md:
            continue
        kw[out_key] = _commit(md[src_key]) if src_key == "commit" else _red(md[src_key], _META_VAL_MAX)
    if not any(kw.values()):
        return None
    return FindingMetadata(**kw)


# ── 임직원 대장(knox) 조인 ────────────────────────────────────────────────────
# 게이트웨이는 knox MCP 를 부르지 않는다(격리 불변식). 스킬 수집기가 employee_directory 에
# 적재해 둔 것만 조인한다. sql/005 GRANT 가 없으면 조용히 이름 없이 지나가므로 프로브를 둔다
# — asset_owner 때 똑같이 당했다(권한 오류를 try/except 가 삼켜 "담당자 없음" 으로 보였다).
_employee_ok: bool | None = None


def _employee_readable(pool: ReadOnlyPool) -> bool:
    global _employee_ok
    if _employee_ok is None:
        try:
            pool.fetch_one("SELECT 1 AS ok FROM employee_directory LIMIT 1")
            _employee_ok = True
        except Exception:  # noqa: BLE001 — 42501(미부여)·42P01(미생성) 둘 다 "못 읽음"
            _employee_ok = False
    return _employee_ok


def reset_employee_probe() -> None:
    """테스트/재기동용."""
    global _employee_ok
    _employee_ok = None


def _employee(pool: ReadOnlyPool, knox_id: str | None) -> dict | None:
    if not knox_id or not _employee_readable(pool):
        return None
    try:
        return pool.fetch_one(
            "SELECT full_name, department, title FROM employee_directory WHERE knox_id = %s",
            [knox_id.strip().lower()],
        )
    except Exception:  # noqa: BLE001
        return None


def _knox_id(email: str | None) -> str | None:
    """사내 메일 → Knox ID(local part). knox 대장의 키다."""
    if not email or "@" not in email:
        return None
    return email.split("@", 1)[0].strip().lower() or None


def _with_employee(pool: ReadOnlyPool, assignee: Assignee) -> Assignee:
    """이름·부서·직급을 붙인다. 이미 있으면(SMB 는 asset_owner 가 준다) 덮지 않는다."""
    if assignee.name and assignee.dept:
        return assignee
    row = _employee(pool, _knox_id(assignee.email))
    if not row:
        return assignee
    return assignee.model_copy(update={
        "name": assignee.name or _owner_line(row.get("full_name"), 80),
        "dept": assignee.dept or _owner_line(row.get("department"), 120),
        "title": assignee.title or _owner_line(row.get("title"), 60),
    })


def _github_repo_owner(pool: ReadOnlyPool, asset: str) -> Assignee | None:
    """저장소 담당자. 커밋 작성자보다 **먼저** 본다 — 저장소 소유자가 더 정확하고,
    파일 검색으로 나온 finding(다수)엔 커밋 작성자가 아예 없다."""
    m = _GITHUB_REPO_RE.match(asset or "")
    if not m:
        return None
    try:
        row = pool.fetch_one(
            "SELECT knox_id, source FROM github_repo_owner WHERE repo = %s", [m.group(1)]
        )
    except Exception:  # noqa: BLE001 — 미부여/미생성이면 커밋 작성자 경로로 떨어진다
        return None
    if not row or not row.get("knox_id"):
        return None
    src = str(row.get("source") or "")
    email = _owner_email(f"{row['knox_id']}@samsung.com")
    if not email:
        return None
    return Assignee(
        status="resolved", email=email,
        sourceLabel=_OWNER_SOURCE_LABELS.get(src, _OWNER_SOURCE_LABELS["github"]),
        confirmed=src not in _UNCONFIRMED_SOURCES,
    )


def resolve_owner(pool: ReadOnlyPool, *, task_type: str, asset: str, finding_id: int) -> Assignee | None:
    """담당자 매칭(표시 전용 · 발송 아님). SMB=asset_owner(IP 정확조회), github/confluence=
    report_thread.owner_recipient(정확 멤버십, non-null 최신), dev_web=담당자 개념 없음(dssoc_only).

    recipient(발송대상)은 담당자로 취급하지 않는다 — owner_recipient/asset_owner 만 담당자."""
    tt = (task_type or "").lower()
    if tt == "smb":
        m = _SMB_IP_RE.match(asset or "")
        if not m:
            return Assignee(status="unresolved")
        ip = m.group(1)
        if any(int(o) > 255 for o in ip.split(".")):
            return Assignee(status="unresolved")
        row = pool.fetch_one(
            "SELECT user_name, user_dept, email, source FROM asset_owner WHERE ip = %s",
            [ip],
        )
        if not row:
            return Assignee(status="unresolved")
        email = _owner_email(row.get("email"))
        if _is_dssoc_email(email):  # dssoc 는 담당자 아님
            email = None
        name = _owner_line(row.get("user_name"), 80)
        dept = _owner_line(row.get("user_dept"), 120)
        status = "resolved" if (email or name) else "unresolved"
        # ★ 담당자를 **사람이 바꿨는지** 화면이 말해야 한다(2026-09-01). 예전엔 도메인
        #   고정 라벨("Splunk 매칭")만 써서, 콘솔에서 수동 지정해도 화면은 여전히
        #   Splunk 가 매칭한 것처럼 보였다 — 바꾼 사실이 어디에도 안 남는다.
        src = str(row.get("source") or "")
        return _with_employee(pool, Assignee(
            status=status, name=name, dept=dept, email=email,
            sourceLabel=_OWNER_SOURCE_LABELS.get(src, _OWNER_SOURCE_LABELS["smb"])))
    if tt in ("github", "confluence"):
        # 저장소 담당자 우선. 커밋 작성자는 파일 검색 finding 엔 없고(대다수가 그렇다),
        # 있어도 "그 줄을 쓴 사람" 이지 "그 저장소를 책임지는 사람" 이 아니다.
        if tt == "github":
            repo_owner = _github_repo_owner(pool, asset)
            if repo_owner is not None:
                return _with_employee(pool, repo_owner)
        table = "github_report_thread" if tt == "github" else "confluence_report_thread"
        # 정확 멤버십: 스칼라 finding_id OR finding_ids(JSON 배열) 정확 포함. LIKE 금지(12⊂112).
        rows = pool.fetch_all(
            f"SELECT owner_recipient FROM {table} "
            f"WHERE owner_recipient IS NOT NULL AND (finding_id = %s OR "
            f"(finding_ids IS JSON AND (finding_ids::jsonb) @> to_jsonb(%s::bigint))) "
            f"ORDER BY updated_at DESC NULLS LAST LIMIT 8",
            [finding_id, finding_id],
        )
        emails: list[str] = []
        for r in rows:
            e = _owner_email(r.get("owner_recipient"))
            if e and not _is_dssoc_email(e) and e not in emails:  # dssoc/soc 는 담당자 제외
                emails.append(e)
        if not emails:
            return Assignee(status="unresolved")
        return _with_employee(pool, Assignee(
            status="resolved", email=emails[0],
            sourceLabel=_OWNER_SOURCE_LABELS[tt], ambiguous=len(emails) > 1))
    if tt in ("dev_web", "web"):
        return Assignee(status="dssoc_only")
    return None


def _safe_owner(pool: ReadOnlyPool, r: dict) -> Assignee | None:
    try:
        return resolve_owner(
            pool, task_type=str(r.get("task_type") or ""),
            asset=str(r.get("asset") or ""), finding_id=int(r["id"]),
        )
    except Exception:  # noqa: BLE001 — 담당자 조회 실패가 상세 500 이 되면 안 됨
        return None


def _base_kwargs(r: dict) -> dict[str, Any]:
    # read 경계 방어 재마스킹: asset(seal 전무)·summary(update 경로 unsealed)·owner/ticket_ref.
    return dict(
        id=int(r["id"]),
        taskType=r["task_type"],
        asset=redact(r["asset"]) or "",
        assetKind=r["asset_kind"],
        severity=r["severity"],
        summary=redact(r["summary"]) or "",
        status=r["status"],
        owner=redact(r.get("owner")),
        ticketRef=redact(r.get("ticket_ref")),
        firstSeen=float(r["first_seen"]),
        lastSeen=float(r["last_seen"]),
        seenCount=int(r["seen_count"]),
        hasEvidence=bool(r["has_evidence"]),
        maskedHits=None,  # DEPRECATED — 상시 None(codex). 상세 증거는 detail.hits.
    )


def _to_finding(r: dict) -> GatewayFinding:
    return GatewayFinding(**_base_kwargs(r), **_cats_from_row(r))


def _to_finding_detail(r: dict, *, assignee: Assignee | None = None) -> GatewayFindingDetail:
    base = _base_kwargs(r)
    cat: dict[str, Any] = {"category": _UNCLASSIFIED, "categories": []}
    # 리치필드 조립은 통째로 fail-closed: 어떤 malformed extra_json 도 500 이 아니라 base finding 으로
    # 강등(라우트 500 → 404 와 구분되는 응답으로 finding 존재 여부 enumeration 될 수 있음). 개별 투영은
    # _safe 로 감싸 한 필드의 예외가 나머지 리치필드까지 날리지 않게 격리한다(적대검증 반영).
    rich: dict[str, Any] = {}
    try:
        extra = _load_extra(r.get("extra_json"))
        cat = _cat_kwargs(taxonomy.categories_from_extra(extra))
        hits = _safe(_project_hits, extra)
        rich = dict(
            hits=hits,
            # 헤더 배지용 파생 플래그 — **투영된 hits 에서만** 계산한다(원본 extra 재해석 금지:
            # 화이트리스트를 통과 못한 값이 플래그로 되살아나는 우회를 막는다).
            loginValidated=any(
                h.loginValidation is not None
                and h.loginValidation.result == "authenticated"
                and h.loginValidation.provesValidity
                for h in (hits or [])
            ),
            riskNarrative=_safe(_project_risk, extra),
            recommendedActions=_str_list(extra.get("recommended_actions"), item_cap=_ACTION_MAX, n=_ACTIONS_MAX) or None,
            pivotInterpretation=_red(extra.get("pivot_interpretation"), _TEXT_MAX),
            evidenceNotes=_safe(_project_evidence_notes, extra),
            pivot=_safe(_project_pivot, extra),
            verification=_safe(_project_verification, extra),
            metadata=_safe(_project_metadata, extra),
            confidence=_confidence(extra.get("confidence")),
            target=_red(extra.get("target"), _TARGET_MAX),
            assetCountScanned=_nonneg_int(extra.get("asset_count_scanned")),
        )
    except Exception:  # noqa: BLE001 — 리치필드 조립 실패는 base finding 으로 강등(500 금지)
        rich = {}
    return GatewayFindingDetail(**base, **cat, assignee=assignee, **rich)


def _in_clause(col: str, values: tuple[str, ...]) -> tuple[str, list]:
    ph = ", ".join(["%s"] * len(values))
    return f"{col} IN ({ph})", list(values)


# 카테고리 서버측 필터: hits[].category 또는 hit_categories 에 요청 카테고리로 canon 되는 DB 원시값이
# 하나라도 있으면 매칭('any' 시맨틱). credential 요청은 병합된 'secret' 태그까지 잡는다(expand_db_values).
# 카테고리는 allowlist(taxonomy.known_keys) 검증·canon 후에만 전달 — 미지 키는 라우트에서 거부.
# ?| text[] : jsonb 배열 원소 중 하나라도 주어진 문자열 집합에 속하면 true.
_CAT_FILTER_SQL = (
    "extra_json IS JSON AND ("
    "jsonb_path_query_array(extra_json::jsonb, '$.hits[*].category') ?| %s::text[]"
    " OR COALESCE((extra_json::jsonb) -> 'hit_categories', '[]'::jsonb) ?| %s::text[])"
)


# 주차(ISO week) 표기 — smb 파이프라인의 `cycle_key` 와 **같은 형식**(2026-W34)으로 맞춘다.
# 8767 smb UI 가 cycle_key 로 주차를 고르고 있어서, 게이트웨이도 같은 라벨을 써야
# 두 화면의 "W34" 가 같은 주를 가리킨다.
# ⚠️ 기준은 `last_seen` 이다 — "그 주 run 이 관측한 노출". `first_seen` 으로 하면
# "그 주에 처음 발견된 것"이 되어 재관측분이 빠진다(주차별 run 결과를 보는 용도와 어긋남).
WEEK_EXPR = "to_char(to_timestamp(last_seen), 'IYYY-\"W\"IW')"


def _filters(
    status: str | None, task_types: tuple[str, ...] | None, since: float | None,
    category: str | None = None, week: str | None = None,
    severity: str | None = None, src_key: str | None = None,
):
    where: list[str] = []
    params: list = []
    if status is not None:
        where.append("status = %s")
        params.append(status)
    if task_types:
        clause, p = _in_clause("task_type", task_types)
        where.append(clause)
        params += p
    if since is not None:
        where.append("last_seen >= %s")
        params.append(since)
    if category is not None:
        where.append(_CAT_FILTER_SQL)
        vals = taxonomy.expand_db_values(category)  # credential → ['credential','secret']
        params += [vals, vals]
    if week:
        where.append(f"{WEEK_EXPR} = %s")
        params.append(week)
    if severity:
        # 코어 severity 는 informational/low/medium/high/critical. 웹은 'info' 라 부르므로
        # 그 별칭도 받는다(웹 4단계 시절 잔재 — critical 을 high 로 접던 버그와 같은 뿌리).
        vals = ["informational", "info"] if severity in ("info", "informational") else [severity]
        where.append("lower(severity) = ANY(%s)")
        params.append(vals)
    if src_key:
        # 대시보드/티켓에서 "이 대상의 발견만" 으로 넘어오는 경로. 원문 src 를 되묻기 키로 쓰지
        # 않는 이유는 마스킹 때문이다 — 서로 다른 두 대상이 같은 라벨로 보일 수 있어서(source_repo
        # 주석), 라벨로 필터하면 남의 것이 섞인다. 대신 불투명 해시로 되묻는다.
        # 여기 SQL 과 source_repo.src_key() 는 **같은 값**을 내야 한다(test_sources 가 대조).
        from .source_repo import src_key_sql  # 순환 import 회피(런타임 지연)
        from ..domains import domain_case_sql, src_case_sql

        where.append(f"{src_key_sql(domain_case_sql(), src_case_sql())} = %s")
        params.append(src_key)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    return clause, params


def category_counts(
    pool: ReadOnlyPool,
    *,
    status: str | None = None,
    task_types: tuple[str, ...] | None = None,
    since: float | None = None,
    week: str | None = None,
    severity: str | None = None,
    src_key: str | None = None,
) -> dict[str, int]:
    """카테고리별 finding 수.

    ★ 칩을 눌렀을 때 나오는 목록과 **같은 술어**(`_filters`)로 센다. 별도 SQL 로 세면
    "칩엔 12건인데 눌러보니 9건" 같은 어긋남이 생긴다 — 카테고리는 컬럼이 아니라
    `extra_json.hits[].category` 안에 있어서 조건이 미묘하다.

    ⚠️ finding 하나가 여러 카테고리 hit 을 가질 수 있으므로 **합계는 총계와 다르다**
    (중복 계수). 화면에서 그렇게 읽히지 않도록 라벨을 붙일 것.
    """
    out: dict[str, int] = {}
    for key in sorted(taxonomy.known_keys()):
        clause, params = _filters(status, task_types, since, key, week, severity, src_key)
        row = pool.fetch_one(f"SELECT COUNT(*) AS n FROM finding_lifecycle{clause}", params)
        out[key] = int(row["n"]) if row else 0
    return out


def list_weeks(pool: ReadOnlyPool, task_types: tuple[str, ...] | None = None) -> list[str]:
    """관측된 주차 목록(최신순). UI 주차 선택기용 — 빈 주는 애초에 안 나온다."""
    clause, params = _filters(None, task_types, None, None, None, None)
    rows = pool.fetch_all(
        f"SELECT DISTINCT {WEEK_EXPR} AS wk FROM finding_lifecycle{clause} "
        "ORDER BY wk DESC",
        params,
    )
    return [str(r["wk"]) for r in rows if r["wk"]]


def list_findings(
    pool: ReadOnlyPool,
    *,
    status: str | None = None,
    task_types: tuple[str, ...] | None = None,
    since: float | None = None,
    category: str | None = None,
    week: str | None = None,
    severity: str | None = None,
    src_key: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> FindingList:
    clause, params = _filters(status, task_types, since, category, week, severity, src_key)
    total_row = pool.fetch_one(f"SELECT COUNT(*) AS n FROM finding_lifecycle{clause}", params)
    total = int(total_row["n"]) if total_row else 0
    rows = pool.fetch_all(
        f"SELECT {_LIST_COLS} FROM finding_lifecycle{clause} "
        "ORDER BY last_seen DESC, id DESC LIMIT %s OFFSET %s",
        [*params, limit, offset],
    )
    return FindingList(total=total, items=[_to_finding(r) for r in rows])


def get_finding(pool: ReadOnlyPool, finding_id: int) -> GatewayFindingDetail | None:
    # 단건 상세: 리치필드 투영 위해 extra_json 포함 SELECT(리스트는 여전히 _COLS lean).
    row = pool.fetch_one(f"SELECT {_DETAIL_COLS} FROM finding_lifecycle WHERE id = %s", [finding_id])
    if not row:
        return None
    return _to_finding_detail(row, assignee=_safe_owner(pool, row))


def count_open(pool: ReadOnlyPool, task_types: tuple[str, ...]) -> int:
    """열린 finding 수(status IN open/triaged AND task_type IN task_types)."""
    st_clause, st_params = _in_clause("status", _OPEN_STATUSES)
    tt_clause, tt_params = _in_clause("task_type", task_types)
    row = pool.fetch_one(
        f"SELECT COUNT(*) AS n FROM finding_lifecycle WHERE {st_clause} AND {tt_clause}",
        [*st_params, *tt_params],
    )
    return int(row["n"]) if row else 0
