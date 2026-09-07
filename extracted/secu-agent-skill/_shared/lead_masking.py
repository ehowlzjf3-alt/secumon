"""리드(lead) 경계 값 필터 — 사외 egress 앞의 마지막 관문 (Phase 2b).

## 무엇을 막는가

리드는 Phase 3 에서 **codex**(`https://chatgpt.com/backend-api/codex` — 사외)가 앉을
자리다. 그래서 리드 프로세스가 보는 모든 문자열은 여기를 통과해야 한다.

정책은 상수 두 개가 **단일 근거**다(`EGRESS_ALLOWED` / `EGRESS_BLOCKED`). 문서에
흩어 놓으면 코드와 갈린다.

## 세 겹 — 각각이 무엇을 하는지 정직하게

1. **구조(가장 강함)** — 리드 도구셋에 본문 반환 도구가 **없다**(`_shared/lead_tools.py`).
   리드는 파일/페이지 본문을 애초에 가져올 수 없다. 이건 마스킹이 아니라 도구 등록이다.
2. **모양** — 검토원 보고는 닫힌 봉투로 재조립된다. `agent_result.json` 의 raw payload
   덤프(코어 fail-open 보조 채널)는 마스킹이 아니라 **버려진다**.
3. **값(여기)** — 남은 산문에서 시크릿/PII 값을 지운다.

★ 3만으로는 "파일 본문 금지"를 지킬 수 없다 — 시크릿이 없는 본문 20줄은 마스커가
그대로 통과시킨다. 그건 1·2 가 막는다. 이 모듈은 **마지막 겹**이지 유일한 겹이 아니다.

## fail-safe 방향

마스커가 예외를 던지면 **더 많이 가린다**(통째 placeholder). 덜 가리는 쪽으로 실패하면
그게 곧 유출이다. 코어 `mask_deep` 이 이미 같은 방향이라 그걸 재사용한다.

## 알려진 한계 (약화가 아니라 설계)

RRN 은 **체크섬이 맞을 때만** 마스킹된다(`900101-1234568` ✓ / `801231-2345671` ✗).
정오탐 게이트(KEEP 4건)의 규칙을 그대로 쓴 결과다. egress 관점에서도 옳다 —
체크섬이 틀린 문자열은 실재 개인의 주민번호가 아니다. 여기서 규칙을 따로 세게 만들면
finding 게이트와 판정이 갈려서 두 개의 진실이 생긴다.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
from typing import Any, Callable

log = logging.getLogger("shared.lead_masking")

# ── egress 정책: 이 두 상수가 단일 근거 ────────────────────────────────
#
# 사용자 확정(2026-08-21): codex 는 "어디를 볼지" 판단에 필요한 좌표는 봐도 되고,
# "거기 무엇이 적혀 있는지"는 보면 안 된다.

EGRESS_ALLOWED: tuple[str, ...] = (
    "IP", "호스트/도메인", "URL 경로", "포트",
    "repo/조직 이름", "confluence space key", "SMB share 이름",
    "파일명·경로·크기·확장자",
    "타깃 id/상태/카운트",
    "담당자 실명·사번",          # ← 사용자가 명시적으로 허용
)

EGRESS_BLOCKED: tuple[str, ...] = (
    "파일/페이지 **본문**",
    "크리덴셜 **값**(비밀번호·토큰·API key·개인키)",
    "PII **값**(주민번호·카드번호·계좌)",
)

# 마스킹 자체가 실패했을 때 원문 대신 나가는 것. 코어 `mask_deep` 의
# `<masked:unwalkable>` 과 같은 방향(fail-closed).
FAILSAFE_PLACEHOLDER = "<lead-masked:failsafe>"

# ── egress 전용 추가 패턴 (코어 탐지기보다 **세다**) ────────────────────
#
# ⚠️ 이건 정오탐 게이트를 건드리는 게 아니다. 방향이 반대라서 규칙도 달라야 한다:
#
#   finding 게이트  — 오탐이 비싸다(사람이 확인해야 한다) → 보수적
#   egress 경계     — 미탐이 비싸다(값이 사외로 나간다)   → 공격적
#
# 실측(2026-08-21): 코어 `mask_scanned_text` 는 산문 속 `AKIAIOSFODNN7EXAMPLE` 을
# 통과시킨다(AWS key id 규칙 없음). github PAT·개인키 블록은 잡는다. 그 구멍을
# 여기서만 메운다 — 코어 규칙은 그대로 둔다(두 개의 진실을 만들지 않는다).
_EXTRA_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = ()


def _compile_extra() -> tuple[tuple[str, Any], ...]:
    return (
        # 벤더 접두어가 붙은 키 — 모양만으로 크리덴셜임이 확정된다.
        ("aws_key", re.compile(r"\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b")),
        ("gcp_key", re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}")),
        ("slack_token", re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}")),
        ("jwt", re.compile(
            r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
        # 크리덴셜 어휘 + 구분자 + 값.
        #
        # ★ `\b` 를 쓰면 안 된다 — `_` 가 단어문자라 `AWS_SECRET` 사이에 경계가 **없다**.
        #   2026-08-21 실측에서 이 규칙이 아래를 전부 통과시켰다:
        #       AWS_SECRET_ACCESS_KEY=…  DB_PASSWORD=…  GITHUB_TOKEN=…
        #   크리덴셜이 실제로 나타나는 가장 흔한 모양(SCREAMING_SNAKE env)이 통째로
        #   빠져 있었다. 그래서 lookbehind + `_`/`-` 접두·접미 허용으로 바꾼다.
        #
        # 구분자는 **요구**한다 — "password policy is weak" 같은 일반 산문은 안 건드린다.
        # ("the password is Hunter2Hunter" 의 값은 가린다 — 과잉 마스킹은 허용된 방향.)
        ("keyword_value", re.compile(
            r"(?i)(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{0,40}"
            r"(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|"
            r"access[_-]?key|private[_-]?key|credential)"
            r"[A-Za-z0-9_-]{0,40}\s*(?:is|[:=]|=>|->)\s*"
            r"[\"']?([^\s\"',;]{6,})")),
    )


# 값이 **좌표**면 가리지 않는다 — 리드가 판단하려면 URL·경로는 보여야 한다.
# 크리덴셜이 박힌 URL(`https://user:pw@host`)은 이 규칙이 돌기 **전에** 코어
# `mask_credential_urls` 가 이미 지운다(mask_scanned_text → _mask_extra 순서).
_COORDINATE_VALUE = re.compile(r"(?i)^(?:https?://|/|\./|\.\./|\\\\|[a-z]:\\)")


def _mask_extra(text: str) -> str:
    """벤더 키·키워드-값 형태를 지운다. 그룹이 있으면 그 그룹만, 없으면 매치 전체."""
    global _EXTRA_SECRET_PATTERNS
    if not _EXTRA_SECRET_PATTERNS:
        _EXTRA_SECRET_PATTERNS = _compile_extra()
    out = text
    for _kind, rx in _EXTRA_SECRET_PATTERNS:
        def _sub(m):
            if not m.lastindex:                        # 벤더키: 매치 전체
                return "***REDACTED***"
            val = m.group(m.lastindex)
            if _COORDINATE_VALUE.match(val):           # URL/경로 = 좌표, 살린다
                return m.group(0)
            whole = m.group(0)
            return whole[: whole.rfind(val)] + partial_mask(val)
        out = rx.sub(_sub, out)
    return out


# 도메인이 자기 어휘를 더 가릴 수 있게 하는 등록형 훅. 코어 훅 패턴과 동형
# (register_task_toolset / register_no_stash_tool 과 같은 결).
_MASKERS: list[Callable[[str], str]] = []


def register_lead_masker(fn: Callable[[str], str]) -> None:
    """도메인 추가 마스커 등록. 예외를 던지면 fail-safe 로 통째 가려진다."""
    if fn not in _MASKERS:
        _MASKERS.append(fn)


def unregister_lead_masker(fn: Callable[[str], str]) -> bool:
    try:
        _MASKERS.remove(fn)
    except ValueError:
        return False
    return True


def lead_maskers() -> tuple[Callable[[str], str], ...]:
    return tuple(_MASKERS)


def mask_text_for_lead(text: str) -> str:
    """문자열 하나를 리드 경계 규칙으로 마스킹한다.

    순서: 세션 sensitive env 값 → 코어 정규 마스커(구조화 시크릿·크리덴셜 URL·
    시크릿·PII) → 도메인 등록 마스커.

    ⚠️ 어느 단계든 예외면 **원문을 반환하지 않는다**.
    """
    if not text:
        return ""
    try:
        from secu_agent.agent.secret_redact import redact_secrets
        from secu_agent.detectors.text_scan import mask_scanned_text

        # ★ 순서: 세션값 → **egress 규칙(길이 기반)** → 코어 정규 마스커 → 도메인.
        #
        # egress 규칙이 코어보다 **먼저** 와야 한다. 코어 `mask_secret` 은 앞뒤를 남기는데
        # (긴 값엔 합리적) 짧은 값엔 과다 노출이다 — 2026-08-21 실측:
        #     password=P@ssw0rd123  →  코어 먼저:  P@ss***d123   (11자 중 8자 = 73% 노출)
        #                              내 규칙 먼저: <len=11 …>    (0자 노출)
        # 코어는 이제 backstop 이다: 내 규칙이 놓친 RRN·카드·PAT·개인키 블록을 잡는다.
        out = mask_scanned_text(_mask_extra(redact_secrets(str(text))))
        for fn in _MASKERS:
            out = fn(out)
        return out
    except Exception:  # noqa: BLE001 — 마스킹 실패가 원문을 흘리면 안 된다
        log.exception("리드 마스킹 실패 — 원문 대신 placeholder 로 대체한다")
        return FAILSAFE_PLACEHOLDER


def mask_payload_for_lead(obj: Any) -> Any:
    """dict/list 를 재귀 마스킹. 코어 `mask_deep`(fail-closed) 위에 등록형 마스커를 얹는다."""
    try:
        from secu_agent.detectors.text_scan import mask_deep

        masked = mask_deep(obj)
    except Exception:  # noqa: BLE001
        log.exception("리드 payload 마스킹 실패 — 통째 placeholder")
        return FAILSAFE_PLACEHOLDER
    return _apply_domain_maskers(masked)


def _apply_domain_maskers(obj: Any) -> Any:
    if isinstance(obj, str):
        try:
            out = _mask_extra(obj)
            for fn in _MASKERS:
                out = fn(out)
            return out
        except Exception:  # noqa: BLE001
            return FAILSAFE_PLACEHOLDER
    if isinstance(obj, dict):
        return {k: _apply_domain_maskers(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_apply_domain_maskers(v) for v in obj]
    return obj


# ══════════════════════════════════════════════════════════════════════
# 공정 레시피 본문 관문 (사용자 결정 2026-08-26)
# ══════════════════════════════════════════════════════════════════════
#
# 사용자 결정 두 줄로 요약된다:
#   "codex 는 엔터프라이즈라 이 정도 정보까지는 괜찮다"
#   "실제 사내 공정 레시피 파일 읽는 것만 안 나가면 된다"
#
# 그래서 리드에게 레포트 본문은 열되, **레시피 파일의 원문 줄**만 막는다.
# 회의록·수율 현황·사업 내용은 막지 않는다 — 사용자가 명시적으로 허용했다.
#
# ⚠️ 기존 `semiconductor_process` 분류기 전체를 그대로 쓰면 안 된다.
#    `_PROCESS_PATH_TERMS` 에는 `mask`·`fab`·`photo`·`euv` 같은 넓은 낱말이 있어
#    `github:org/mask-service/...` 같은 무관한 경로까지 잡는다. 실측된 레포트 본문
#    (github 400/400 마스킹 완료)이 통째로 가려지면 리드가 판단할 재료를 잃는다.
#    여기서는 **레시피로 좁힌다.**
#
# 리드는 여전히 **좌표를 본다** — path·kind·line_no·건수·검토원 narrative.
# 막는 것은 원문을 나르는 필드뿐이다. "무엇이 어디 있나" 는 그대로 가고
# "그 파일에 뭐라고 적혀 있나" 만 안 간다.

# 원문(파일 줄)을 나르는 필드. `narrative`/`why` 는 **넣지 않는다** — 그건 검토원이
# 쓴 판단이지 파일 내용이 아니고, 그게 리드가 받는 가장 중요한 재료다.
_VERBATIM_FIELDS = frozenset({
    "context", "preview", "line_preview", "body", "excerpt", "snippet",
    "sample_line", "content",
})
# 같은 dict 안에서 "이게 어느 파일인가" 를 말해 주는 필드.
_PATH_FIELDS = ("path", "asset", "location", "sample_ref", "file", "url")

_RECIPE_PATH_RE = re.compile(
    r"(?i)(recipe|레시피|공정\s*조건|공정조건|process[ _-]?recipe|\.rcp\b)")
# 본문 자체가 레시피인 경우(경로가 없는 confluence 붙여넣기 등).
_RECIPE_BODY_RE = re.compile(
    r"(?i)(recipe\s*(id|name|step|sheet)|레시피\s*(id|명|단계|시트)|"
    r"step\s*\d+\s*[:\t].*\b(time|temp|press|flow|power)\b)")

RECIPE_WITHHELD = "«공정 레시피 본문 — 리드에 미전달(경로·종류는 위에 있다)»"


def _looks_like_recipe(text: str, *, path_hint: str) -> bool:
    """이 원문이 공정 레시피 파일의 내용인가.

    판정은 **경로 우선**이다 — `DSARecipe.xml`·`공정조건.xlsx` 처럼 이름이 말해 준다
    (2026-08-26 smb 실기동에서 검토원이 실제로 `DSARecipe.xml`·`RecipeDomainConfig.xml`
    을 열었다). 경로가 없으면 본문 구조로 본다.

    ★ 넓게 잡지 않는다. 회의록·수율 현황은 사용자가 허용했고, 과하게 막으면 리드가
      판단을 못 해 검토원에게 다 떠넘기게 된다 — 그게 리드 층을 만든 이유의 반대다.
    """
    if path_hint and _RECIPE_PATH_RE.search(path_hint):
        return True
    return bool(_RECIPE_BODY_RE.search(str(text or "")[:4000]))


def _withhold_recipe_bodies(obj: Any, *, path_hint: str = "") -> Any:
    """dict 를 걸으며 원문 필드만 골라 레시피면 대체한다. 좌표는 건드리지 않는다."""
    if isinstance(obj, dict):
        hint = path_hint
        for key in _PATH_FIELDS:
            got = obj.get(key)
            if isinstance(got, str) and got:
                hint = got
                break
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if k in _VERBATIM_FIELDS:
                out[k] = _withhold_verbatim(v, path_hint=hint)
            else:
                out[k] = _withhold_recipe_bodies(v, path_hint=hint)
        return out
    if isinstance(obj, (list, tuple)):
        return [_withhold_recipe_bodies(v, path_hint=path_hint) for v in obj]
    return obj


def _withhold_verbatim(value: Any, *, path_hint: str) -> Any:
    if isinstance(value, str):
        return RECIPE_WITHHELD if _looks_like_recipe(value, path_hint=path_hint) else value
    if isinstance(value, list):
        # context 는 줄 목록이다. 한 줄이라도 레시피면 그 묶음 전체를 막는다 —
        # 줄 단위로 남기면 앞뒤가 붙어 결국 같은 내용이 재구성된다.
        if any(isinstance(x, str) and _looks_like_recipe(x, path_hint=path_hint)
               for x in value):
            return [RECIPE_WITHHELD]
        return value
    return value


def mask_tool_content(content: str) -> str:
    """리드 도구가 내보내는 최종 문자열. JSON 이면 구조를 보존한 채 leaf 만 마스킹한다.

    JSON 을 문자열로 통째 마스킹하면 `mask_structured_secret_fields` 가 키까지 삼켜
    리드가 파싱할 수 없는 덩어리가 된다 — 구조는 남기고 값만 지운다.
    """
    raw = str(content or "")
    if not raw:
        return ""
    stripped = raw.lstrip()
    if stripped[:1] in ("{", "["):
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            parsed = None
        if parsed is not None:
            try:
                masked = mask_payload_for_lead(parsed)
                # ★ 값 마스킹 **뒤에** 건다. 레시피 판정은 값의 모양이 아니라 파일의
                #   종류를 보는 것이라 순서가 서로를 방해하지 않고, 뒤에 걸어야
                #   마스킹이 만든 문자열까지 함께 본다.
                return json.dumps(_withhold_recipe_bodies(masked), ensure_ascii=False)
            except Exception:  # noqa: BLE001
                return FAILSAFE_PLACEHOLDER
    return mask_text_for_lead(raw)


# ══════════════════════════════════════════════════════════════════════
# 판단 재료 — 값을 주지 않으면서 리드가 판단할 수 있게 (Phase 3a)
# ══════════════════════════════════════════════════════════════════════
#
# `***REDACTED***` 는 리드에게 아무것도 안 알려준다. 리드가 실제로 답해야 하는 질문은
# 셋이고, 각각에 맞는 재료가 다르다:
#
#   "진짜 비번인가 placeholder 인가"    → shape      (값 노출 0)
#   "아까 그 크리덴셜과 같은 건가"       → fingerprint (값 노출 0)
#   "어떤 맥락에 있나"                 → context    (값 노출 0, 주변은 마스킹 통과)
#   "눈으로 대조해야겠다"               → partial_mask (소량, 길이 기반)
#
# ★ 재사용 판정은 **fingerprint** 로 한다. 같은 값인지 알고 싶은 것이지 값을 알고 싶은
#   게 아니다 — 해시는 상관관계가 완벽하고 노출이 0이다. 부분 마스킹은 사람이 눈으로
#   대조할 때만 쓴다.

FINGERPRINT_SALT_ENV = "SA_LEAD_FP_SALT"

# 부분 마스킹 정책 — **길이 기반**. 짧은 값은 한 글자도 안 보인다.
# 8자 비번에서 앞3+뒤2 를 보이면 5/8 이 나간다 — 그건 마스킹이 아니다.
_PARTIAL_TIERS: tuple[tuple[int, int], ...] = (
    (12, 0),    # len < 12  → 0글자
    (24, 2),    # len < 24  → 앞2 + 뒤2
)
_PARTIAL_LONG = 4          # len >= 24 → 앞4 + 뒤4
_PARTIAL_MAX_RATIO = 0.25  # 하드 상한 — 어떤 경우도 25% 를 넘기지 않는다

# 봉투 총량 캡. notable 이 20건이면 context 만으로 본문 80줄이 나간다.
MAX_NOTABLE = 8
MAX_CONTEXT_LINES = 5
MAX_CONTEXT_CHARS = 4000


def _fp_salt() -> str:
    """지문 salt. 리드 프로세스가 만들고 검토원이 env 로 상속받는다.

    ★ salt 없이 sha256 을 쓰면 안 된다 — 8자 비번의 해시는 사전 대입으로 확인 가능하다.
    per-run salt 면 상관관계는 그 런 안에서 완벽하고, 밖으로는 아무 의미도 없다.
    없으면 즉석에서 만든다 — 그 프로세스 안에서만 correlate 된다(그게 맞는 동작이다).
    """
    salt = os.environ.get(FINGERPRINT_SALT_ENV)
    if not salt:
        salt = os.urandom(16).hex()
        os.environ[FINGERPRINT_SALT_ENV] = salt
    return salt


def fingerprint(value: str) -> str:
    """값 노출 0 인 재사용 상관 키. 같은 런 안에서 같은 값 → 같은 지문."""
    raw = str(value or "")
    if not raw:
        return ""
    return hashlib.sha256((_fp_salt() + raw).encode("utf-8")).hexdigest()[:8]


def _charset_of(raw: str) -> str:
    has_l = any(c.islower() for c in raw)
    has_u = any(c.isupper() for c in raw)
    has_d = any(c.isdigit() for c in raw)
    has_s = any(not c.isalnum() for c in raw)
    if has_d and not (has_l or has_u or has_s):
        return "digits"
    if all(c in "0123456789abcdefABCDEF" for c in raw) and has_d:
        return "hex"
    parts = []
    if has_l or has_u or has_d:
        parts.append("alnum" if (has_d and (has_l or has_u)) else
                     ("alpha" if (has_l or has_u) else "digits"))
    if has_s:
        parts.append("sym")
    return "+".join(parts) or "empty"


def _entropy_of(raw: str) -> float:
    if not raw:
        return 0.0
    counts: dict[str, int] = {}
    for c in raw:
        counts[c] = counts.get(c, 0) + 1
    n = len(raw)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def shape_of(value: str) -> str:
    """값의 **모양**. `changeme`(entropy 2.5) 와 진짜 비번(entropy 3.5+)을 구분하게 해 준다."""
    raw = str(value or "")
    if not raw:
        return "<empty>"
    return (f"<len={len(raw)} charset={_charset_of(raw)} "
            f"entropy={_entropy_of(raw):.1f}>")


def partial_mask(value: str) -> str:
    """길이 기반 부분 마스킹. 짧으면 한 글자도 안 보인다.

    반환은 항상 `<…>` 로 감싼 요약이라, 리드 컨텍스트에서 원문과 혼동되지 않는다.
    """
    raw = str(value or "")
    n = len(raw)
    if not n:
        return "<empty>"
    keep = _PARTIAL_LONG
    for limit, k in _PARTIAL_TIERS:
        if n < limit:
            keep = k
            break
    keep = min(keep, int(n * _PARTIAL_MAX_RATIO) // 2)
    if keep <= 0:
        return f"<len={n} …>"
    return f"<{raw[:keep]}…{raw[-keep:]} len={n}>"


def mask_context_lines(
    lines: list[str], *, max_lines: int = MAX_CONTEXT_LINES,
    max_chars: int = MAX_CONTEXT_CHARS,
) -> list[str]:
    """플래그된 지점의 **주변 줄**. 각 줄이 마스커를 통과하고 총량이 캡된다.

    ⚠️ 이건 정의상 **파일 본문 조각**이다 — Phase 2 에서는 차단 대상이었고, 사용자가
    2026-08-21 에 명시적으로 허용했다("주변 맥락하고 같이 부분 마스킹 된 값을 본다").
    허용 범위는 "검토원이 지목한 지점의 근방" 이지 벌크 본문이 아니다. 그래서:
      · 줄 수 캡(기본 5), 총 글자 캡(기본 4000)
      · 각 줄이 값 마스커를 통과한다(주변 줄에 다른 시크릿이 있을 수 있다)
      · 리드는 이걸 **스스로 가져올 수 없다** — 검토원이 골라 준 것만 온다(도구 경계)
    """
    out: list[str] = []
    used = 0
    for line in list(lines or [])[:max(0, max_lines)]:
        masked = mask_text_for_lead(str(line))[:400]
        if used + len(masked) > max_chars:
            out.append(f"…[맥락 {len(lines) - len(out)}줄 생략 — 총량 캡]")
            break
        out.append(masked)
        used += len(masked)
    return out
