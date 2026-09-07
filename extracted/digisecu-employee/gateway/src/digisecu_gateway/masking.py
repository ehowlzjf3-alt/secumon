"""게이트웨이 read 경계 방어 재마스킹 (defense-in-depth).

적대적 검증 발견: finding_lifecycle의 일부 free-text 컬럼은 **저장시점 seal 가정이 거짓**이다 —
`asset`은 애초에 마스킹되지 않고(submit_finding이 원문 hit.location을 raw 저장), `summary`도 엔진 web
update(PATCH) 경로는 마스킹을 우회한다. 엔진 자신도 read 경계(ralph_controller)에서 asset·summary를
**재마스킹**한다("F3 우회 경로 대비 defense-in-depth"). 게이트웨이도 무수정 제약과 무관하게 자기 read
경계에서 동일 방어를 적용한다 — 게이트웨이가 반환하는 free-text 컬럼을 여기서 재마스킹한다.

주의: 이것은 게이트웨이 **로컬 안전망**이다(엔진 detectors를 런타임 import하지 않아 격리·lean 이미지 유지).
권위 있는 마스킹은 여전히 엔진 write-time seal이며, 여기서는 알려진 고위험 패턴(주민번호·SSN·자격증명·
시크릿·이메일·카드번호·고엔트로피 토큰)을 보수적으로(과마스킹 우선) 봉인한다.

finding 상세 확장(codex 적대검증 반영): extra_json 리치 필드를 표면화하려면 (1) 화이트리스트 필드만
투영하고, (2) 모든 str leaf 를 redact() 하되 **마스킹 후 절단**(자르고 마스킹하면 토큰이 detector 임계
밑으로 짧아져 누수), (3) 중첩 구조는 redact_deep() 로 재귀 방어(fail-closed) 한다.
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

# 제로폭/BIDI/제어문자 정규화(codex 적대검증): 이 문자들은 (1) 시크릿 사이에 삽입돼 detector 패턴
# 매칭을 깨 마스킹을 우회하거나, (2) BIDI override 로 UI 상 텍스트를 시각적으로 뒤집어 스푸핑에 쓰일 수
# 있다. redact() 진입 즉시 제거해 패턴 매칭을 복원하고 스푸핑을 막는다. \t\n\r 은 보존(줄바꿈·정렬).
# 리터럴 제어문자를 소스에 넣지 않도록 코드포인트 range 로 패턴을 구성한다(NUL 등 소스 삽입 방지).
_UNSAFE_RANGES = (
    (0x00, 0x08), (0x0B, 0x0C), (0x0E, 0x1F),  # C0 제어(단 \t=09 \n=0A \r=0D 보존)
    (0x7F, 0x9F),                              # DEL + C1 제어
    (0x200B, 0x200F),                          # 제로폭 space/non-joiner/joiner + LRM/RLM
    (0x2028, 0x2029),                          # line/paragraph separator
    (0x202A, 0x202E),                          # BIDI embedding/override
    (0x2060, 0x2064),                          # word-joiner·invisible operator
    (0x2066, 0x206F),                          # BIDI isolate + deprecated format chars
    (0xFEFF, 0xFEFF),                          # zero-width no-break space(BOM)
)
_UNSAFE_CHARS = re.compile(
    "[" + "".join(fr"\U{lo:08x}-\U{hi:08x}" for lo, hi in _UNSAFE_RANGES) + "]"
)

# 숫자 lookaround(\b는 밑줄/문자 인접 시 실패 — 파일명 안 번호를 놓침).
_RRN = re.compile(r"(?<!\d)(\d{6})[-\s]?\d{7}(?!\d)")  # 주민등록번호
_SSN = re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)")  # US SSN(구분자 有)
# SSN/주민번호 라벨 뒤 미구분 9자리(적대적 검증: 'ssn 123456789' 누출). 라벨 있을 때만(오탐 방지).
_SSN9 = re.compile(r"(?i)((?:ssn|social\s*security|주민(?:등록)?번호)\D{0,4})(\d{9})(?!\d)")
# scheme://user:pass@ — 패스워드에 @ 포함 시(greedy로 host 앞 마지막 @까지) 전체 봉인.
# 적대검증 반영: userinfo 그룹을 * 로(빈 username 허용) → redis://:pass@host 같은 password-only 형태도 봉인.
_CRED_URL = re.compile(r"(://[^/:@\s]*):[^/\s]+@")
# key=value / "key": "value" 시크릿 — 따옴표(JSON) 값도 커버.
# 적대적 검증 반영: 키워드 앞 \b 제거 → db_password·client_secret·authToken·api_secret 같은
# underscore/camelCase 키도 매칭(값만 봉인, 키 접두는 매치 밖이라 보존). 과마스킹 우선.
_KV_SECRET = re.compile(
    r"(?i)(password|passwd|pwd|secret|token|api[_-]?key|authorization|bearer)\b"
    r"([\"']?\s*[=:]\s*[\"']?|\s+)([^\s,;'\"]+)"
)
_AWS_KEY = re.compile(r"\bAKIA[0-9A-Z]{16}\b")
_EMAIL = re.compile(r"\b([\w.+-]+)@([\w-]+\.[\w.-]+)\b")
_CARD = re.compile(r"\b(?:\d[ -]?){13,16}\b")
# 적대검증 반영: 경계를 \b 대신 (?<![A-Za-z0-9]) 로 — \b 는 `_` 를 word char 로 봐 ghp_<토큰>·
# xoxb_<토큰> 처럼 밑줄에 붙은 고엔트로피부를 놓쳤다(밑줄이 경계로 안 잡힘). 이제 밑줄/구분자도 경계.
# 라이브 관측 반영: 토큰 클래스에서 `/` 를 뺀다 — `/` 는 경로/URL 구분자라 이를 토큰 문자로 두면
# `Platform-Backend/PlatformAPI`·`src/.../file.py` 같은 repo·경로가 통째 봉인돼(UI가 꼭 봐야 할 값)
# 과마스킹된다. `/`-glued hex 는 _HEX16 이, keyed 시크릿은 _KV_SECRET 이 여전히 잡는다(커버리지 유지).
_HI_ENTROPY = re.compile(r"(?<![A-Za-z0-9])[A-Za-z0-9+=_-]{40,}(?![A-Za-z0-9])")  # 긴 base64/hex(안전망)
# 40자 하한이 32자 hex·24자 base64 토큰을 놓침. 20~39자 '토큰형' 런을 별도 봉인하되 사전형 식별자
# (generic_password_assignment 같은 kind·snake_case)는 보존 — 숫자 포함 or 대소문자 혼합 or 순수 hex/base32.
_TOKEN_RUN = re.compile(r"(?<![A-Za-z0-9])[A-Za-z0-9+=-]{20,39}(?![A-Za-z0-9])")
# 단일 케이스(대문자만/소문자만·숫자 없음) 런 판별 — 순수 hex/base32 는 인코딩된 키 재료 형태.
_HEX_RUN = re.compile(r"\A[0-9a-fA-F]+\Z")
_BASE32_RUN = re.compile(r"\A[A-Z2-7]+\Z")
# 적대검증 반영: 구분자(/-)에 붙은 hex 는 _TOKEN_RUN 이 non-hex 접두와 한 런으로 묶어 hex 판정을
# 놓친다(예 loc-deadbeef…·https://h/deadbeef…). 16자+ 연속 hex 런을 독립적으로 봉인(구분자 무관).
# 경계는 영숫자 아님(구분자/공백/슬래시가 경계) — 다른 단어 속 hex 조각은 안 건드림.
_HEX16 = re.compile(r"(?<![0-9A-Za-z])[0-9a-fA-F]{16,}(?![0-9A-Za-z])")


def _mask_token_like(m: "re.Match[str]") -> str:
    s = m.group(0)
    has_digit = any(c.isdigit() for c in s)
    has_upper = any(c.isupper() for c in s)
    has_lower = any(c.islower() for c in s)
    if has_digit or (has_upper and has_lower):
        return _MASK
    # 적대검증 반영: 단일 케이스 런이라도 순수 hex(소문자 a-f 등) 또는 base32(대문자 A-Z2-7)면
    # 봉인한다 — deadbeefdeadbeef… 32자 hex 키·TOTP base32 시크릿이 여기로 새던 구멍(digit·mixed-case
    # 신호가 없음). 사전형 단어(a-f 밖 문자 포함)는 hex/base32 미매치라 그대로 보존(과마스킹 회귀 방지).
    if len(s) >= 16 and (_HEX_RUN.match(s) or _BASE32_RUN.match(s)):
        return _MASK
    return s

_MASK = "«마스킹»"


def strip_unsafe(text: str | None) -> str | None:
    """제로폭/BIDI/제어문자만 제거(시크릿 마스킹은 하지 않음).

    owner 이메일처럼 **마스킹하면 용도가 사라지는**(local-part 봉인 시 발송대상 식별 불가) 값에
    쓴다 — 대신 호출부가 별도 문법 검증(_owner_email 등)으로 단일 유효 메일박스만 통과시킨다."""
    if text is None:
        return None
    return _UNSAFE_CHARS.sub("", str(text))


def redact(text: str | None) -> str | None:
    """free-text 재마스킹. None은 그대로, 그 외는 고위험 패턴을 봉인해 반환.

    **주의(codex)**: 반드시 마스킹 후에 절단하라 — 절단을 먼저 하면 토큰이 detector 임계 밑으로
    짧아져 누수한다. 이 함수는 절단하지 않는다(호출부가 redact 결과를 [:cap] 한다)."""
    if text is None:
        return None
    s = _UNSAFE_CHARS.sub("", str(text))  # 제로폭/BIDI/제어문자 제거(우회·스푸핑 방지) — 패턴 매칭 전
    s = _CRED_URL.sub(r"\1:«마스킹»@", s)
    s = _RRN.sub(r"\1-«마스킹»", s)
    s = _SSN.sub(_MASK, s)
    s = _SSN9.sub(lambda m: f"{m.group(1)}{_MASK}", s)  # 라벨 보존, 9자리만 봉인
    s = _AWS_KEY.sub(_MASK, s)
    s = _KV_SECRET.sub(lambda m: f"{m.group(1)}{m.group(2)}{_MASK}", s)  # 키+구분자 보존, 값만 봉인
    s = _CARD.sub(_MASK, s)
    s = _EMAIL.sub(r"«마스킹»@\2", s)  # 이메일 local part(PII) 봉인, 도메인 보존
    s = _TOKEN_RUN.sub(_mask_token_like, s)  # 20~39자 토큰형(식별자는 보존)
    s = _HEX16.sub(_MASK, s)  # 구분자에 붙은 16자+ hex 런(키 재료) — _TOKEN_RUN 우회분 봉인
    s = _HI_ENTROPY.sub(_MASK, s)
    return s


def redact_secrets_only(text: str | None) -> str | None:
    """**담당자 이름·부서 전용** 축소 마스킹 — 시크릿 계열만 봉인하고 사람 이름·조직명은 보존한다.

    ★ 왜 `redact()` 를 그대로 못 쓰나: 사용자 결정(2026-08-23)으로 담당자 이름·소속은
    마스킹 대상이 아니다. 그런데 `redact()` 의 뒷단 휴리스틱은 **평범한 이름·부서명을 먹는다** —
    `_EMAIL` 은 local part 를 지우고, `_TOKEN_RUN`(20~39자)·`_HI_ENTROPY`(40자+)는 공백 없는
    영문 조직명(`SecurityEngineeringGroup2026`)을 통째로 봉인한다. 그 열의 존재 이유가 사라진다.

    ★ 왜 그냥 통과시키지도 않나: `asset_owner.user_name` 에 AWS 키가 들어와 있으면 게이트웨이가
    시크릿 반출 통로가 된다(`test_assignee_smb_secret_in_name_masked_bad_email_rejected` 가
    적대검증으로 못박은 지점). 이름은 보존하면서 그 구멍만 막는다.

    그래서 **앞단(고신뢰 시크릿 패턴)만** 돌린다. 여기 있는 패턴은 실제 사람 이름·부서명과
    겹치지 않는다 — 자격증명 URL·주민번호·SSN·AWS 키·`key=value` 시크릿·카드번호.
    ⚠️ 새 패턴을 `redact()` 에 추가할 때, 그것이 시크릿 계열이면 **여기에도** 넣어라.
    """
    if text is None:
        return None
    s = _UNSAFE_CHARS.sub("", str(text))
    s = _CRED_URL.sub(r"\1:«마스킹»@", s)
    s = _RRN.sub(r"\1-«마스킹»", s)
    s = _SSN.sub(_MASK, s)
    s = _SSN9.sub(lambda m: f"{m.group(1)}{_MASK}", s)
    s = _AWS_KEY.sub(_MASK, s)
    s = _KV_SECRET.sub(lambda m: f"{m.group(1)}{m.group(2)}{_MASK}", s)
    s = _CARD.sub(_MASK, s)
    return s


# ── 중첩 구조 재귀 마스킹(finding 상세 확장 전용, codex 적대검증) ──
# 엔진 mask_deep 의 read-경계판. 화이트리스트 투영이 우선이지만, 표면화하는 필드가 dict/list 를
# 품을 경우(evidence_notes·metadata 등) 그 안의 모든 str leaf 를 redact() 한다. fail-closed:
# 과깊이/순환/예외/미지원 타입은 원문/str()/repr() 이 아니라 고정 placeholder 로 대체(평문 유출 금지).
_REDACT_DEEP_FAILCLOSED = _MASK


def redact_deep(obj: Any, *, _depth: int = 0, _max_depth: int = 12, _seen: set[int] | None = None) -> Any:
    """dict/list/tuple/set 을 재귀하며 모든 str leaf 를 redact(), dict 키도 redact().

    비-str primitive(bool/int/float/None)는 그대로. 미지원 타입은 placeholder(never str()/repr()).
    과깊이·순환·redact 예외는 fail-closed(placeholder). egress 경계 전용."""
    if _seen is None:
        _seen = set()
    if _depth > _max_depth:
        return _REDACT_DEEP_FAILCLOSED
    try:
        if obj is None or isinstance(obj, bool):
            return obj
        if isinstance(obj, (int, float)):
            return obj
        if isinstance(obj, str):
            return redact(obj)
        if isinstance(obj, Mapping):
            oid = id(obj)
            if oid in _seen:
                return _REDACT_DEEP_FAILCLOSED
            _seen.add(oid)
            out: dict[Any, Any] = {}
            for k, v in obj.items():
                rk = redact(k) if isinstance(k, str) else _REDACT_DEEP_FAILCLOSED
                out[rk] = redact_deep(v, _depth=_depth + 1, _max_depth=_max_depth, _seen=_seen)
            _seen.discard(oid)
            return out
        if isinstance(obj, (list, tuple, set)):
            oid = id(obj)
            if oid in _seen:
                return _REDACT_DEEP_FAILCLOSED
            _seen.add(oid)
            out_list = [
                redact_deep(v, _depth=_depth + 1, _max_depth=_max_depth, _seen=_seen) for v in obj
            ]
            _seen.discard(oid)
            return out_list
        return _REDACT_DEEP_FAILCLOSED  # 미지원 타입 — str()/repr() 금지(평문 유출 방지)
    except Exception:  # noqa: BLE001 — 마스킹 실패가 원문을 흘리면 안 됨
        return _REDACT_DEEP_FAILCLOSED
