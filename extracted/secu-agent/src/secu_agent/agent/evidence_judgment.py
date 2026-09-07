"""Evidence judgment contract for persisted findings.

This module is intentionally side-effect free. Tools call it before turning a
claim into a lifecycle finding, but it does not import state, web routes, or tool
runtime code.
"""
from __future__ import annotations

import logging
import re
import json
from dataclasses import dataclass, replace
from typing import Any, Literal
from urllib.parse import urlparse

from secu_agent.agent.schema.finding import TaskFinding

EvidenceVerdict = Literal["confirmed", "suspected", "rejected", "informational"]

log = logging.getLogger(__name__)

_ENV_ASSIGN_RE = re.compile(
    r"(?m)^\s*[A-Za-z_][A-Za-z0-9_.-]{1,80}\s*=\s*['\"]?[^'\"\s#]{2,}"
)
_HTML_MARKERS = (
    "<html",
    "<!doctype",
    "<body",
    "<script",
    "<title",
    "access denied",
    "forbidden",
    "cloudflare",
    "captcha",
    "waf",
    "blocked",
    "sign in",
    "login",
)
# content 증거(masked/preview)가 필수인 코어 category. plugin 분류는
# register_finding_category(requires_content_evidence=True) 로 같은 게이트에
# 합류한다 (v3.82 U3a — legacy 도메인 분류 2종 literal 을 등록형으로 이전).
_CORE_CONTENT_EVIDENCE_CATEGORIES = frozenset({
    "secret",
    "pii",
    "credential",
    "internal_system",
})


def _content_evidence_categories() -> frozenset[str]:
    from secu_agent.finding_taxonomy import plugin_content_evidence_categories
    return _CORE_CONTENT_EVIDENCE_CATEGORIES | plugin_content_evidence_categories()


_DOMAIN_RE = re.compile(
    r"(?i)^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?$"
)
_IP_RE = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$")

# v3.54: masked/preview 에 들어온 "플레이스홀더 라벨" 거부. 모델이 web_task_scan 의
# 키워드 lead("... keyword context" 등 라벨)를 실제 관찰값 대신 masked 에
# 넣고 finding 으로 제출하던 오탐(#27 재발) 차단. 진짜 증거 = 화면에서 본 값/본문.
_PLACEHOLDER_EVIDENCE_SUBSTR = (
    "keyword context", "keyword_context", "process keyword", "context detected",
    "keyword detected", "placeholder", "example value", "n/a", "todo",
)
_CREDENTIAL_VALUE_KEYS = (
    "access_key",
    "access-key",
    "apikey",
    "api_key",
    "api-key",
    "auth",
    "bearer",
    "client_secret",
    "client-secret",
    "credential",
    "pass",
    "passwd",
    "password",
    "private_key",
    "private-key",
    "pwd",
    "pw",
    "secret",
    "token",
)
_CREDENTIAL_ID_KEYS = (
    "account",
    "email",
    "id",
    "login",
    "user",
    "username",
)
# ## 왜 `\b` 가 아니라 lookaround 인가 (2026-08-27 실측)
#
# `\b` 는 `_` 를 단어문자로 본다. 그래서 `OBSERVABILITY_API_KEY=` 안의 `API_KEY` 앞에는
# 경계가 없고, 실무의 접두어 붙은 키 이름이 통째로 안 잡혔다:
#
#     api_key=…                 통과      OBSERVABILITY_API_KEY=…    거부
#     password=…                통과      DB_PASSWORD=…              거부
#                                         INFRA_PW=…                 거부
#                                         AWS_SECRET_ACCESS_KEY=…    거부
#                                         MYSQL_ROOT_PASSWORD=…      거부
#
# 다만 경계를 그냥 풀면 **키가 뒤쪽에 붙은 부정/동사 식별자**가 새로 걸린다
# (`disable_auth=yes` · `no_token=abc` · `use_auth: yes` · `skip_auth=on`).
# 이건 크리덴셜이 아니라 설정 플래그다. 그래서 두 겹을 덧댄다:
#   ① 값이 boolean-스러운 낱말이면 거부 (`_ASSIGNMENT_VALUE_EXCLUDED`)
#   ② 키 앞에 부정/동사 접두어가 붙었으면 거부 (`_VALUE_KEY_PREFIX_DENY`)
#
# 정탐 14건 + 오탐 23건 코퍼스 실측 (tests/test_scanner_gate_round_trip.py 가 고정한다):
#
#            \b(현재)   경계만 완화   경계+①②
#     정탐      3/14        14/14        14/14
#     오탐      0/23         6/23         0/23
#
# ⚠️ 접미 와일드카드(`\w*password\w*`)는 쓰지 않는다 — 별도 실측에서 정탐 12/12 지만
#   오탐이 8/21 로 튀었다.
# ⚠️ `_CREDENTIAL_ID_KEYS`(id/user/email…)에는 **적용하지 않는다.** 완화하면
#   `user_id = 12345` 가 크리덴셜 증거로 통과한다. ID 키는 보조 신호라 좁게 둔다.
# (Python `re` 는 고정폭 lookbehind 만 허용해서 접두어마다 하나씩 쓴다.)
_VALUE_KEY_PREFIX_DENY = "".join(
    f"(?<!{prefix})" for prefix in (
        "disable_", "enable_", "no_", "use_", "has_", "is_",
        "skip_", "allow_", "require_", "with_", "without_",
    )
)
_VALUE_KEY_BOUNDARY_PRE = _VALUE_KEY_PREFIX_DENY + r"(?<![A-Za-z0-9])"
_VALUE_KEY_BOUNDARY_POST = r"(?![A-Za-z0-9])"
#: 값 자리에 오면 "값이 아니라 상태" 인 낱말들. 기존 4개(true/false/null/none)에
#: yes/on/off … 를 더한 것 — 경계 완화로 `…_auth=yes` 류가 새로 들어왔기 때문이다.
#: 여기에 **값의 생김새**로 거르는 두 가지를 더한다:
#:   · 파일 경로 (`workspace_pwd=/srv/build/output` — `pwd` 는 working directory 이기도 하다)
#:   · CSS 치수  (`column_pw=1200px` — `pw` 는 pixel width 이기도 하다)
#: 둘 다 크리덴셜 값이 될 수 없는 형상이고, 정탐 코퍼스 14건에는 하나도 안 걸린다.
#:
#: ⚠️ 남는 한계(codex 적대검증 2026-08-27, 고치지 않고 기록한다): 키 이름이
#:   크리덴셜스러운 설정 플래그는 여전히 통과한다 —
#:   `compiler_pass=dead_code_elimination_42` · `lexer_token=IDENTIFIER_LITERAL_42` ·
#:   `default_auth=oauth2_proxy` · `image_pull_secret=…` · `vault_credential=…`.
#:   더 좁히려면 값의 엔트로피/문자구성을 봐야 하는데, 그러면 짧은 실제 비밀번호가
#:   같이 죽는다. 이 게이트는 단독 판정자가 아니라 여러 검사 중 하나이므로
#:   (도메인 secret_gate·category judge 가 뒤에 있다) 여기서는 넓게 두는 쪽을 택했다.
_ASSIGNMENT_VALUE_EXCLUDED = (
    r"(?!(?:true|false|null|none|empty|<empty>|<masked|<redacted|value_present"
    r"|yes|no|on|off|enabled|disabled|required|optional|auto)\b)"
    r"(?!\.{0,2}/|[A-Za-z]:[\\/])"                 # 파일 경로 (`/srv/…` `./x` `C:\…`)
    r"(?!\d+(?:px|em|rem|pt|vh|vw)(?![A-Za-z0-9])|\d+%)"   # CSS 치수
)
_CREDENTIAL_ASSIGNMENT_RE = re.compile(
    r"(?im)(?:"
    + _VALUE_KEY_BOUNDARY_PRE + r"(?:"
    + "|".join(re.escape(k) for k in _CREDENTIAL_VALUE_KEYS)
    + r")" + _VALUE_KEY_BOUNDARY_POST
    + r"|\b(?:"
    + "|".join(re.escape(k) for k in _CREDENTIAL_ID_KEYS)
    + r")\b"
    + r")\s*[:=]\s*['\"]?"
    r"(?!\s*(?:$|[,;}\]\r\n]))"
    + _ASSIGNMENT_VALUE_EXCLUDED +
    r"[A-Za-z0-9가-힣._~+/$:@%#*!?=-]{2,}"
)
# 탐지기와 **같은 정본**을 쓴다. 따로 적어 두면 어긋난다 — 실제로 어긋나서
# PGP armor(`… PRIVATE KEY BLOCK-----`)가 탐지는 되는데 제출은 거부됐다.
from secu_agent.detectors.secrets import _PRIVATE_KEY_ARMOR_RE as _PRIVATE_KEY_MARKER_RE
_HTTP_OR_HOST_RE = re.compile(
    r"(?i)(?:https?://|(?<![A-Za-z0-9_.-])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?"
    r"|(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,63}(?::\d{1,5})?)"
)
_VALIDATION_TEXT_MARKERS = (
    "credential_reachability",
    "safe_probe",
    "get 도달",
    "GET 도달",
    "basic 인증 get",
    "Basic 인증 GET",
    "token 인증 get",
    "Token 인증 GET",
    "로그인 post",
    "로그인 POST",
    "form_login_post",
    "token_get",
    "basic_get",
)


def _is_placeholder_evidence(masked: str, kind: str) -> bool:
    """masked 가 실제 관찰값이 아니라 카테고리/키워드 라벨(플레이스홀더)인가."""
    k = (kind or "").strip().lower()
    # kind 자체가 'keyword context' 리드면 masked 가 뭐든 증거 아님 — 키워드 존재는
    # 단서일 뿐 확정 노출이 아니다(#27). 실제 노출은 다른 kind(필드명/레코드)로 와야 함.
    if "keyword_context" in k or "keyword context" in k:
        return True
    m = (masked or "").strip().lower()
    if not m:
        return False
    if any(s in m for s in _PLACEHOLDER_EVIDENCE_SUBSTR):
        return True
    # masked 가 kind 라벨 그대로(예: masked == "process_keyword_context")면 증거 아님.
    if m == (kind or "").strip().lower().replace("_", " "):
        return True
    if m == (kind or "").strip().lower():
        return True
    return False


def _has_direct_credential_value_evidence(kind: str, masked: str, preview: str) -> bool:
    """A credential/secret hit must show a real value-bearing line, not a label."""
    text = "\n".join(v for v in (masked or "", preview or "") if v).strip()
    if not text:
        return False
    if _PRIVATE_KEY_MARKER_RE.search(text):
        return True
    lower_kind = (kind or "").lower()
    lower_text = text.lower()
    if "aws_access_key" in lower_kind and "akia" in lower_text:
        return True
    if "github" in lower_kind and ("ghp_" in lower_text or "github_pat_" in lower_text):
        return True
    if "slack" in lower_kind and "xox" in lower_text:
        return True
    return bool(_CREDENTIAL_ASSIGNMENT_RE.search(text))


def _credential_pair_or_token_in_text(text: str) -> bool:
    lower = str(text or "").lower()
    has_value_secret = any(k in lower for k in _CREDENTIAL_VALUE_KEYS)
    has_user = any(k in lower for k in _CREDENTIAL_ID_KEYS)
    return has_value_secret and (has_user or "token" in lower or "api" in lower)


def _has_probe_validation(hit: object, finding: TaskFinding) -> bool:
    validation = getattr(hit, "validation", None)
    if isinstance(validation, dict) and validation.get("kind") == "credential_reachability":
        return True
    rn = getattr(finding, "risk_narrative", None)
    rn_text = ""
    if rn is not None:
        try:
            rn_text = json.dumps(rn.model_dump(mode="json"), ensure_ascii=False)
        except Exception:  # noqa: BLE001
            rn_text = str(rn)
    notes_text = ""
    try:
        notes_text = json.dumps(finding.evidence_notes, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001
        notes_text = str(getattr(finding, "evidence_notes", "") or "")
    text = "\n".join([
        str(getattr(hit, "preview", "") or ""),
        str(getattr(finding, "pivot_interpretation", "") or ""),
        rn_text,
        notes_text,
    ])
    return any(marker.lower() in text.lower() for marker in _VALIDATION_TEXT_MARKERS)


# ── B1/B2 하드닝 (codex 합심): 정교한 위조 우회 차단 ──────────────────────
# value key **만** (ID key 제외) 대입 — username=alice 로 credential 확정되는 것 방지.
# 경계 규칙은 `_CREDENTIAL_ASSIGNMENT_RE` 와 같다(위 주석 참조) — 여기는 값 키만 본다.
_CREDENTIAL_VALUE_ASSIGNMENT_RE = re.compile(
    r"(?im)" + _VALUE_KEY_BOUNDARY_PRE + r"(?:"
    + "|".join(re.escape(k) for k in _CREDENTIAL_VALUE_KEYS)
    + r")" + _VALUE_KEY_BOUNDARY_POST + r"\s*[:=]\s*['\"]?"
    r"(?!\s*(?:$|[,;}\]\r\n]))"
    + _ASSIGNMENT_VALUE_EXCLUDED +
    r"[A-Za-z0-9가-힣._~+/$:@%#*!?=-]{2,}"
)
# masked 가 실제 값이 아니라 '있다는 주장'(assertion) 뿐 — <masked,len=N>, value_present,
# 전부 * 등. 실제 값 형상은 scan_text/regex 가 별도로 인정한다.
_ASSERTION_MASK_RE = re.compile(r"(?i)(<masked|<redacted|value_present|len\s*=)")
# 고정밀 token prefix — 뒤가 부분 마스킹돼도(예: AKIA1234****, ghp_abc***) prefix 자체가
# 강한 증거다(codex: high-precision token prefix). scan_text 는 full shape 만 잡으므로 보완.
_TOKEN_PREFIX_RE = re.compile(
    r"(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{2,}"          # AWS access key
    r"|gh[posru]_[A-Za-z0-9]{2,}|github_pat_[A-Za-z0-9_]{2,}"      # GitHub
    r"|xox[baprs]-[A-Za-z0-9-]{2,}"                                # Slack
    r"|AIza[A-Za-z0-9_-]{2,}"                                      # Google API
    r"|(?:sk|rk|pk)_live_[A-Za-z0-9]{2,}"                          # Stripe
    r"|eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\."                  # JWT
)


# ── 파이프라인이 만든 마스킹 형상 (2026-08-28) ────────────────────────────
#
# 바로 위 `_TOKEN_PREFIX_RE` 를 쓰는 자리의 주석은 "부분 마스킹된 고정밀 토큰(prefix)도
# 인정" 이라고 적혀 있지만 **패턴은 접두어 뒤에 원문 글자를 요구한다.** 파이프라인
# 마스킹은 접두어 뒤가 전부 `*` 라 한 건도 안 걸린다. 그런데 워커가 손에 쥐는 값은
# 처음부터 마스킹된 것뿐이다 — 탐지기가 `Hit.masked`/`line_preview` 를 `mask_secret`
# 출력으로 만들어 준다. **탐지기가 지운 것을 게이트가 요구했다.**
# 개인키 armor 때와 같은 자기무효화다(`detectors/secrets.py` mask_secret docstring).
#
# 실측(2026-08-28): 이 형상이 4개 증거트리 798개 파일에 4,687회 있고 전부 거부됐다.
#     250  AKIA************6FOK      51  ghp_********************************7k4N
#      72  AIza*******************************1EAE
#
# 인정하는 것은 `mask_secret` 이 **접두어를 살려두는 계열**의 형상뿐이다:
#     mask_secret(v) = v[:4] + "*" * (len(v) - 8) + v[-4:]      (len(v) > 8)
#
# ⚠️ 접두어가 4자를 넘는 계열은 뺐다 — 마스킹이 접두어를 먹어 계열 식별이 안 된다.
#    `sk_live_…` → `sk_l************************DDDD`, URL 계열 → `http****`.
#    규칙이 "아무 문자열 + 별표런" 이 되므로 일부러 제외했다(코퍼스 회수 0건).
# ⚠️ `AGPA|AIDA|AROA|ANPA|ANVA` 는 넣지 않는다 — 탐지기 규칙에 없는 死문자열이다.
# ⚠️ 별표 개수를 못박지 않는다(`{8,}`). 워커가 필사하며 한 글자 자른 값이 그대로 온다
#    (실측: 같은 토큰이 20자/19자, 40자/41자 두 변형으로 제출됐다).
# ⚠️ 위조 저항성은 **동급**이지 상향이 아니다. `_TOKEN_PREFIX_RE` 는 이미 `AKIAXX`
#    6자를 인정한다(실행 확인) — 문은 이미 열려 있고, 여기서 하는 것은 같은 문에
#    파이프라인 자신의 출력 모양을 추가하는 것뿐이다.
_MASK_CHARS = r"[*•●·]"   # `_is_assertion_only_masked` 와 같은 집합
_MASKED_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:"
    r"(?:AKIA|ASIA)" + _MASK_CHARS + r"{8,}[A-Za-z0-9]{2,6}"
    r"|(?:gh[posru]|npm)_" + _MASK_CHARS + r"{8,}[A-Za-z0-9]{2,6}"
    r"|AIza" + _MASK_CHARS + r"{8,}[A-Za-z0-9_-]{2,6}"
    r"|xox[baprs]" + _MASK_CHARS + r"{8,}[A-Za-z0-9-]{2,6}"
    r"|eyJ[A-Za-z0-9_-]" + _MASK_CHARS + r"{8,}[A-Za-z0-9_-]{2,6}"
    r")(?![A-Za-z0-9])"
)
# ⚠️ 경계는 탐지기와 **같은 것**을 쓴다(`detectors/secrets.py` `_TOKEN_PRE/_POST`).
#    `_`·`-` 를 배제하면 `GIT_SYNC_ghp_****…jONL`(k8s git-sync 에 박힌 실제 PAT)이
#    떨어진다 — 평문 쪽에서 `\b` 로 같은 실수를 이미 겪고 기록해 뒀다.

#: masked 는 형상을 갖췄는데 preview 가 "그 자리는 이미 지워져 있다" 고 말하는 경우.
#: 실측 1건: masked='AIza…RgNA' 인데 preview='…maps/api/js?key=%3Credacted%3E'.
#: 그 masked 는 관찰이 아니라 조립이다.
_PREVIEW_REDACTED_RE = re.compile(
    r"(?i)(<redacted|%3credacted|\[redacted\]|\*{2,}\s*redacted)"
)


def _has_pipeline_masked_token(masked: str, preview: str) -> bool:
    """`mask_secret` 이 접두어를 살려둔 계열의 마스킹 형상이 증거로 서 있는가.

    preview 에서 잡히면 그대로 인정한다 — 탐지기 출력을 옮긴 것이다. masked 에만
    있는데 preview 가 "이 자리는 이미 지워졌다" 고 말하면 거부한다(실측 오탐 1건).

    ⚠️ masked ∪ preview 를 보는 것은 의식적 결정이다. 다른 분기도 두 필드를 합쳐서
       본다 — 여기만 좁히면 계약이 갈라진다. 대가로 preview 에 형상이 없고 masked
       만이 근거인 건이 통과하지만, preview 에도 형상을 요구하면 preview 가 빈
       정탐이 함께 죽는다(실측 4건).
    """
    if _MASKED_TOKEN_RE.search(preview or ""):
        return True
    if _MASKED_TOKEN_RE.search(masked or ""):
        return not _PREVIEW_REDACTED_RE.search(preview or "")
    return False


def _is_assertion_only_masked(masked: str) -> bool:
    """masked 가 공백/assertion 마커뿐이면 True(증거 아님). B2/B1 위조 우회 차단."""
    m = (masked or "").strip()
    if not m:
        return True
    if _ASSERTION_MASK_RE.search(m):
        return True
    if set(m) <= {"*", "•", "●", "·", " "}:  # 전부 마스킹 문자
        return True
    return False


def _has_hardened_credential_value(kind: str, masked: str, preview: str) -> bool:
    """credential/secret 확정 증거(codex 하드닝) — **실제 값 형상만** 인정:
    ① PEM private key 헤더 ② 고정밀 토큰 접두어(평문) ③ **파이프라인 마스킹 형상**
    (`mask_secret` 출력: 접두어 + 별표런 + 꼬리 — 접두어가 살아남는 계열만)
    ④ 실제 secret detector 형상(scan_text 전체 shape) ⑤ credential **value key** 대입
    (username 등 ID key 제외).
    placeholder/assertion/산문 라벨·ID-only 는 전부 거부(위조 산문 통과 차단)."""
    text = "\n".join(v for v in (masked or "", preview or "") if v).strip()
    if not text:
        return False
    if _PRIVATE_KEY_MARKER_RE.search(text):
        return True
    if _TOKEN_PREFIX_RE.search(text):  # 부분 마스킹된 고정밀 토큰(prefix)도 인정
        return True
    # ③ 위 패턴은 접두어 **뒤에 원문 글자**를 요구해서, 정작 파이프라인이 만든
    #    마스킹(`AKIA************6FOK`)을 한 건도 못 받는다. 탐지기가 지운 것을
    #    게이트가 요구하던 자리다.
    if _has_pipeline_masked_token(masked or "", preview or ""):
        return True
    try:
        from secu_agent.detectors import scan_text
        if any(h.category == "secret" for h in scan_text(text).hits):
            return True
    except Exception:  # noqa: BLE001 — detector 사망이 게이트를 못 열게(보수적 False)
        pass
    return bool(_CREDENTIAL_VALUE_ASSIGNMENT_RE.search(text))


def _has_successful_probe(hit: object) -> bool:
    """구조화된 **성공** probe 만 인정(codex): attempted=False·산문 marker 배제.
    validation dict 의 kind=='credential_reachability' 이고 attempted 가 False 가 아닐 때만."""
    validation = getattr(hit, "validation", None)
    if isinstance(validation, dict) and validation.get("kind") == "credential_reachability":
        return validation.get("attempted") is not False
    return False


# ── plugin 등록 훅 (v3.82 U3a) ───────────────────────────────────────
# 도메인 전용 hit 판정(예: 구 SMB credential 심층 판정·프린터드라이버 INI
# 휴리스틱)은 plugin 이 task_type 별로 등록한다. 코어는 generic 계약만 소유.
# plugin judge 는 이 모듈의 generic 헬퍼(_has_direct_credential_value_evidence /
# _credential_pair_or_token_in_text / _has_probe_validation / _rejected /
# _suspected / _confirmed)를 재사용할 수 있다 — 도메인 정보 없는 공용 패턴.
#
# 시그니처: judge(finding, hit) -> EvidenceJudgment | None (None = 미적용,
# generic 계약으로 폴백). should_persist=True 판정은 confirmed 로 계수된다.

_TASK_TYPE_JUDGES: dict[str, Any] = {}

# browser 검증 게이트 대상 task_type (정책 A — SSO/web finding 은 대상 호스트를
# browser 로 실제 열어본 기록이 있어야 제출 가능). 코어 기본 = 없음: 코어 단독
# 형상은 generic/finding_narrator/package_sandbox 만 생산한다. 도메인 plugin
# (web/github/confluence 등 SSO 점검)이 자기 task_type 을 등록한다.
_BROWSER_VERIFIED_TASK_TYPES: set[str] = set()


def register_evidence_judge(task_type: str, judge: Any) -> None:
    """plugin hit 판정 등록 — 중복은 명시 에러 (등록 API 공통 규약)."""
    ht = str(task_type or "").strip()
    if not ht:
        raise ValueError("task_type 비어 있음")
    if ht in _TASK_TYPE_JUDGES:
        raise ValueError(f"evidence judge {ht!r} 이미 등록됨")
    _TASK_TYPE_JUDGES[ht] = judge


def unregister_evidence_judge(task_type: str) -> bool:
    return _TASK_TYPE_JUDGES.pop(str(task_type or ""), None) is not None


def register_browser_verified_task_type(task_type: str) -> None:
    """browser 검증 게이트 대상 task_type 등록 (중복 등록 허용 — 집합 합류)."""
    ht = str(task_type or "").strip()
    if not ht:
        raise ValueError("task_type 비어 있음")
    _BROWSER_VERIFIED_TASK_TYPES.add(ht)


def unregister_browser_verified_task_type(task_type: str) -> bool:
    try:
        _BROWSER_VERIFIED_TASK_TYPES.remove(str(task_type or ""))
        return True
    except KeyError:
        return False


def browser_verification_required(task_type: str) -> bool:
    return str(task_type or "") in _BROWSER_VERIFIED_TASK_TYPES


# browser 검증 게이트 **면제** 판정자 (정책 A 예외 — 등록형).
#
# 왜 필요한가 (2026-08-27 실측): 같은 task_type 'github' 아래에 성격이 다른 두 레인이
# 있다. SSO URL 점검 레인은 브라우저로 화면을 열어 확인하는 것이 곧 검증이지만, repo
# API 스캔 레인은 **브라우저 도구를 의도적으로 안 준다**(무인 워커가 승인 앞에서 멈춘다).
# 그래서 스캔 레인은 게이트를 만족시킬 방법이 원천적으로 없었고, 오늘 제출 14건이
# 14건 모두 거부됐다 — 진짜 시크릿을 찾아놓고 워커가 스스로 기각했다.
#
# ⚠️ 판정자는 **finding.target / hit.location 같은 LLM 이 쓴 문자열로 판단하면 안 된다.**
#    "비-URL 이면 면제" 류의 규칙은 워커가 target="site-a", location="/.env" 라고만 쓰면
#    브라우저 없이 통과하는 **일반 우회로**가 된다(codex 적대검증에서 이 안이 폐기됐다).
#    실행 시작 시 코드가 심은 context.metadata 처럼 **에이전트가 못 건드리는 근거**만 봐야
#    한다.
#
# ⚠️ fail-closed: 판정자가 예외를 던지면 면제하지 않는다. 판정자 버그가 게이트를 여는
#    방향으로 작동해선 안 된다.
_BROWSER_VERIFICATION_EXEMPTIONS: list[Any] = []


def register_browser_verification_exemption(fn: Any) -> None:
    """browser 게이트 면제 판정자 등록. fn(finding, context) -> bool (True=면제).

    등록 순서대로 시도하고 하나라도 True 면 면제한다. 같은 함수 중복 등록은 명시
    에러(등록 API 공통 규약). 코어 기본 = 등록 없음 → 현행 동작 불변.
    """
    if fn in _BROWSER_VERIFICATION_EXEMPTIONS:
        raise ValueError("browser 면제 판정자 이미 등록됨")
    _BROWSER_VERIFICATION_EXEMPTIONS.append(fn)


def unregister_browser_verification_exemption(fn: Any) -> bool:
    try:
        _BROWSER_VERIFICATION_EXEMPTIONS.remove(fn)
        return True
    except ValueError:
        return False


def browser_verification_exempt(finding: Any, context: Any) -> bool:
    """등록된 판정자 중 하나라도 면제라고 하면 True. 예외는 면제 아님(fail-closed)."""
    for fn in tuple(_BROWSER_VERIFICATION_EXEMPTIONS):
        try:
            # ⚠️ `is True` 로 본다. truthy 검사면 실수로 `async def` 를 등록했을 때
            #    coroutine 객체가 참이라 게이트가 통째로 열린다(codex 적대검증).
            if fn(finding, context) is True:
                return True
        except Exception:  # noqa: BLE001 — 판정자 버그가 게이트를 열지 않는다
            log.warning(
                "browser 면제 판정자 실패 — 면제하지 않는다 (%r)", fn, exc_info=True)
    return False


# ── category 별 증거 판정 + PII 제외 정책 (v3.85: 등록형) ─────────────────────
# 코어는 핵심 category(content-evidence/attack_surface/web_vuln/misconfig)의
# 기본 계약을 fall-through 로 소유한다. 도메인이 새 category 를 도입하면
# register_category_evidence_judge 로 그 category 의 계약을 직접 등록한다 —
# 코어 분기를 건드리지 않는다. task_type judge(_TASK_TYPE_JUDGES)와 달리 이건
# category 축이라 도메인이 자기 분류에만 계약을 붙일 수 있다.
_CATEGORY_JUDGES: dict[str, Any] = {}

# pii kind 저가치/범위제외 판정 — 코어는 식별자-only 기본 목록을 들고, 도메인/운영
# 정책(추가 제외 kind)은 등록형으로 붙인다. **진짜 민감 PII 는 절대 제외 금지**
# (rrn/card/bank/account/phone/passport 가드는 코어 하드).
_PII_EXCLUSION_POLICIES: list[Any] = []


def register_category_evidence_judge(category: str, judge: Any) -> None:
    """category 별 증거 판정 등록 (plugin API). 중복은 명시 에러.

    judge(finding, hit) -> EvidenceJudgment | None (None = 미적용, 코어 계약 폴백).
    코어 category judge 디스패치가 하드코딩 분기보다 먼저 소비한다.
    """
    c = str(category or "").strip()
    if not c:
        raise ValueError("category 비어 있음")
    if c in _CATEGORY_JUDGES:
        raise ValueError(f"category evidence judge {c!r} 이미 등록됨")
    _CATEGORY_JUDGES[c] = judge


def unregister_category_evidence_judge(category: str) -> bool:
    return _CATEGORY_JUDGES.pop(str(category or ""), None) is not None


def register_pii_exclusion_policy(fn: Any) -> None:
    """추가 저가치/범위제외 PII kind 판정 등록 (plugin/운영정책용).

    fn(kind_lower: str) -> bool. 하나라도 True 면 제외 후보(단, 진짜 민감 PII
    가드는 코어가 먼저 걸러 절대 제외되지 않는다).
    """
    if not callable(fn):
        raise TypeError("pii exclusion policy 는 callable 이어야 한다")
    _PII_EXCLUSION_POLICIES.append(fn)


def unregister_all_pii_exclusion_policies() -> None:
    _PII_EXCLUSION_POLICIES.clear()


@dataclass(frozen=True, slots=True)
class HitOutcome:
    """hit 하나의 판정 결과 — **좌표와 코드만.** 값은 담지 않는다.

    ⚠️ `masked`/`preview` 를 넣지 마라. 이 구조는 `finding.json` 과 DB `extra` 양쪽에
    실려 나가는데(`submit_finding.py`), 마스킹은 탐지기 커버리지에 묶여 있어서
    체크섬 무효 주민번호처럼 **마스킹을 통과해 버리는 값**이 있다. 좌표만 담으면
    그 표면이 아예 생기지 않는다.
    """

    index: int
    category: str
    kind: str
    hit_verdict: Literal["confirmed", "blocked"]
    hit_reason_code: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "category": self.category,
            "kind": self.kind,
            "hit_verdict": self.hit_verdict,
            "hit_reason_code": self.hit_reason_code,
        }


@dataclass(frozen=True, slots=True)
class EvidenceJudgment:
    verdict: EvidenceVerdict
    reason: str
    confidence: float
    should_persist: bool
    required_actions: tuple[str, ...] = ()
    #: 판정 사유의 기계 판독용 코드. 산문 `reason` 과 달리 닫힌 집합이라 셀 수 있다.
    reason_code: str = ""
    #: hit 별 판정. 순회 전에 끝난 판정(hits 없음·low_value_only)에서는 비어 있다 —
    #: 소비자는 `len(hit_outcomes) == len(finding.hits)` 를 확인하고 써야 한다.
    hit_outcomes: tuple[HitOutcome, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "reason": self.reason,
            "confidence": self.confidence,
            "should_persist": self.should_persist,
            "required_actions": list(self.required_actions),
            "reason_code": self.reason_code,
            "hit_outcomes": [o.to_dict() for o in self.hit_outcomes],
        }


def _confirmed(reason: str, *, confidence: float = 0.9) -> EvidenceJudgment:
    return EvidenceJudgment(
        verdict="confirmed",
        reason=reason,
        confidence=confidence,
        should_persist=True,
    )


def _suspected(reason: str, *actions: str) -> EvidenceJudgment:
    return EvidenceJudgment(
        verdict="suspected",
        reason=reason,
        confidence=0.45,
        should_persist=False,
        required_actions=tuple(actions),
    )


def _rejected(reason: str, *actions: str) -> EvidenceJudgment:
    return EvidenceJudgment(
        verdict="rejected",
        reason=reason,
        confidence=0.0,
        should_persist=False,
        required_actions=tuple(actions),
    )


def _informational(reason: str) -> EvidenceJudgment:
    return EvidenceJudgment(
        verdict="informational",
        reason=reason,
        confidence=1.0,
        should_persist=False,
    )


def _stamp(
    judgment: EvidenceJudgment,
    code: str,
    outcomes: "list[HitOutcome] | tuple[HitOutcome, ...]" = (),
) -> EvidenceJudgment:
    """판정에 코드와 hit 좌표를 얹는다. **판정 자체는 바꾸지 않는다.**

    ⚠️ `judge_task_finding` 의 **모든** 반환 경로가 이걸 통과해야 한다. 한 경로라도
    빠지면 하류가 `hit_outcomes=()` 를 "hit 이 없다" 로 오독한다 — 실제로는
    "이 경로가 안 실었다" 인데.
    """
    return replace(judgment, reason_code=code, hit_outcomes=tuple(outcomes))


def _blocked_coords(outcomes: "list[HitOutcome]") -> str:
    """막힌 hit 의 **좌표**만 문자열로. 워커가 어느 hit 을 빼야 할지 알게 한다.

    ⚠️ `hit_reason_code` 값은 넣지 않는다 — 규칙 이름이 노출되면 그 이름을 피해가는
    쪽으로 모델이 학습한다. 무엇이 부족한지는 `required_actions` 가 이미 산문으로 말한다.
    """
    blocked = [o for o in outcomes if o.hit_verdict == "blocked"]
    if not blocked:
        return ""
    parts = "; ".join(f"[{o.index}] {o.category}/{o.kind}" for o in blocked)
    return f" blocked hits: {parts}"


def _body_from_evidence(evidence: dict[str, Any]) -> str:
    for key in ("body_preview", "body_sample", "preview", "text_preview"):
        value = evidence.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _status_from_evidence(evidence: dict[str, Any]) -> int | None:
    value = evidence.get("status")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _looks_like_html_or_block_page(text: str, content_type: str = "") -> bool:
    haystack = f"{content_type}\n{text[:4096]}".lower()
    return any(marker in haystack for marker in _HTML_MARKERS)


def _looks_like_env(text: str) -> bool:
    return bool(_ENV_ASSIGN_RE.search(text))


# probe/leak 성격 경로 — "노출됐다" 주장하려면 실제 응답 증거가 필요한 것들.
_PROBE_ENDPOINT_MARKERS = (
    "/server-status", "/actuator", "/metrics", "/debug", "/.env", "/.git",
    "/admin", "/console", "/swagger", "/openapi", "/redoc", "/.well-known",
    "/config", "/phpinfo", "/info.php",
)


def _looks_like_probe_endpoint(location: str) -> bool:
    path = (urlparse(location).path or location).lower()
    return any(m in path for m in _PROBE_ENDPOINT_MARKERS)


def _looks_like_attack_surface_location(location: str) -> bool:
    parsed = urlparse(location)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return True
    candidate = location.strip().split("/", 1)[0]
    return bool(_DOMAIN_RE.match(candidate) or _IP_RE.match(candidate))


def _judge_exposed_file(url: str, evidence: dict[str, Any]) -> EvidenceJudgment:
    parsed = urlparse(url)
    path = (parsed.path or "").lower()
    body = _body_from_evidence(evidence)
    content_type = str(evidence.get("content_type") or "")
    status = _status_from_evidence(evidence)

    if status is not None and status != 200:
        return _rejected(f"exposed_file requires HTTP 200 evidence, got {status}")
    if not body:
        return _suspected(
            "missing body evidence for exposed_file claim",
            "fetch the suspected URL and capture a bounded body preview",
        )
    if _looks_like_html_or_block_page(body, content_type):
        return _rejected(
            "response body/content-type looks like HTML, login, WAF, or block page",
            "fetch the URL and verify the raw sensitive file content",
        )

    lower = body.lower()
    if path.endswith("/.env") or path.endswith(".env"):
        if _looks_like_env(body):
            return _confirmed(".env response contains key=value body evidence")
        return _rejected(".env response body does not contain key=value evidence")

    if path.endswith("/.git/config"):
        if "[core]" in lower or "repositoryformatversion" in lower:
            return _confirmed(".git/config body contains git config markers")
        return _rejected(".git/config response lacks git config markers")

    if path.endswith("/.git/head"):
        if lower.lstrip().startswith("ref:"):
            return _confirmed(".git/HEAD body contains ref marker")
        return _rejected(".git/HEAD response lacks ref marker")

    if "/actuator/env" in path:
        if "propertysources" in lower:
            return _confirmed("actuator/env body contains propertySources marker")
        return _rejected("actuator/env response lacks propertySources marker")

    if path.endswith("/dockerfile"):
        if re.search(r"(?im)^\s*FROM\s+\S+", body):
            return _confirmed("Dockerfile body contains FROM instruction")
        return _rejected("Dockerfile response lacks FROM instruction")

    if path.endswith(("/package.json", "/composer.json", "/composer.lock")):
        if body.lstrip().startswith("{") and re.search(r'"(scripts|dependencies|require|packages)"', body):
            return _confirmed("package/config JSON body contains expected keys")
        return _rejected("package/config response lacks expected JSON keys")

    return _confirmed("non-HTML exposed file body evidence captured", confidence=0.75)


def judge_web_finding(finding: Any) -> EvidenceJudgment:
    """Judge a deterministic web finding before lifecycle persistence."""
    kind = str(getattr(finding, "kind", "") or "")
    url = str(getattr(finding, "url", "") or "")
    detail = str(getattr(finding, "detail", "") or "")
    evidence = getattr(finding, "evidence", None) or {}
    if not isinstance(evidence, dict):
        evidence = {}

    if kind == "exposed_file":
        return _judge_exposed_file(url, evidence)
    if kind == "missing_security_header":
        if "missing:" in detail.lower():
            return _confirmed("missing security headers are explicitly listed", confidence=0.8)
        return _suspected("missing header finding lacks explicit missing header list")
    if kind in {"default_page", "autoindex", "reflective_xss", "sqli_error"}:
        return _confirmed(f"{kind} probe produced a concrete marker", confidence=0.85)
    if kind in {"admin_unauth", "admin_page_reachable"}:
        return _suspected(
            "HTTP 200 admin page reachability is not enough to prove unauthenticated access",
            "capture authentication state, redirect chain, and page marker evidence",
        )
    return _suspected(f"no evidence contract rule for web finding kind {kind!r}")


_LOW_VALUE_OR_EXCLUDED_PII = (
    "email", "username", "user_id", "userid", "login", "person_name",
    "name", "employee", "사번", "contact_info", "contact",
    # Operator policy: vehicle/license plate numbers are excluded from the PII
    # target set for findings unless another sensitive category is present.
    "vehicle_plate", "vehicle_registration", "license_plate", "car_plate",
    "차량번호", "차량등록", "번호판",
)


def _is_identifier_only_pii(kind: str) -> bool:
    """pii kind 가 finding 제외 대상인가.

    PW 없는 단순 ID/이름류와 자동차 번호는 노이즈/범위 제외로 본다.
    진짜 민감 PII(주민번호/카드/계좌/전화)는 False — 유지."""
    k = (kind or "").strip().lower()
    # SAFETY-KEEP: 진짜 민감 PII 는 어떤 등록 정책도 제외할 수 없다 (코어 하드 가드).
    if any(s in k for s in ("rrn", "card", "bank", "account", "phone",
                            "passport", "ssn", "주민", "전화", "계좌")):
        return False
    if any(s in k for s in _LOW_VALUE_OR_EXCLUDED_PII):
        return True
    # 도메인/운영 정책이 추가 제외 kind 를 붙일 수 있다 (등록형).
    for fn in _PII_EXCLUSION_POLICIES:
        try:
            if fn(k):
                return True
        except Exception:
            continue
    return False


def _hit_category_kind(hit: object) -> tuple[str, str]:
    """hit(dict 또는 .category/.kind 객체) → (category, kind). service_task=dict, submit_finding=객체."""
    if isinstance(hit, dict):
        return str(hit.get("category") or ""), str(hit.get("kind") or "")
    return str(getattr(hit, "category", "") or ""), str(getattr(hit, "kind", "") or "")


def is_low_value_only(hits: object) -> bool:
    """hit 들이 전부 제외 대상 PII 뿐 → True(노이즈), 아니면 False(유지).

    v3.78.1: pii 가 아닌 카테고리(secret/credential/공정·경영/내부시스템/misconfig/web_vuln/
    attack_surface 등 무엇이든)가 **하나라도** 있으면 진짜 신호 → False. 전부 pii 일 때만,
    그 pii 가 전부 식별자-only(이메일/이름/사번) 또는 자동차 번호면 노이즈/범위 제외.
    고가치 PII(주민번호/카드/계좌/전화/여권)가 섞이면 False(유지). hit 없으면 False.
    service_task(dict)·submit_finding(객체)
    양쪽 동일 판정에 재사용(F1)."""
    pairs = [_hit_category_kind(h) for h in hits]  # type: ignore[union-attr]
    if not pairs:
        return False
    if any(cat != "pii" for cat, _ in pairs):
        return False  # pii 외 카테고리 = 진짜 신호 → 유지
    return all(_is_identifier_only_pii(kind) for _, kind in pairs)


def judge_task_finding(finding: TaskFinding) -> EvidenceJudgment:
    """Judge an LLM-submitted final finding before persistence."""
    if not finding.hits:
        if finding.severity == "informational":
            return _stamp(
                _informational("informational task result without confirmed hits"),
                "no_hits")
        return _stamp(_rejected("non-informational finding submitted without hits"),
                      "no_hits")

    # v3.54/v3.78: 사내 맥락 — PW/크리덴셜 없이 단순 ID(이메일/이름/사번)만 노출된 건 finding 제외.
    # v3.80: 자동차 번호는 이번 SMB/PII 점검 범위에서 제외.
    # OSS 라이선스/문서/AUTHORS 의 연락처 이메일, commit author 이메일도 여기서 걸러진다.
    # (주민번호/카드/계좌/전화 같은 진짜 민감 PII, 또는 secret 동반은 is_low_value_only=False → 유지.)
    if is_low_value_only(finding.hits):
        # ⚠️ hit 을 **순회하기 전에** finding 전체를 거부한다 → hit_outcomes 는 빈다.
        #    소비자는 len(hit_outcomes) == len(finding.hits) 를 확인하고 써야 한다.
        return _stamp(_rejected(
            "PW/크리덴셜 없는 단순 ID(이메일/이름/사번) 또는 자동차 번호만 노출 — "
            "사내 맥락/운영 범위상 finding 아님. "
            "OSS 라이선스·문서·AUTHORS 의 연락처 이메일이나 commit author 이메일도 마찬가지. "
            "계정 탈취로 이어지는 비밀번호·토큰·세션, 또는 주민번호/카드/공정·경영 데이터 등 "
            "실제 민감 정보가 함께 노출될 때만 보고하라."
        ), "low_value_only")

    blockers: list[EvidenceJudgment] = []
    outcomes: list[HitOutcome] = []
    confirmed_count = 0

    def _pass(index: int, hit: Any) -> None:
        nonlocal confirmed_count
        confirmed_count += 1
        outcomes.append(HitOutcome(
            index=index, category=hit.category, kind=hit.kind,
            hit_verdict="confirmed", hit_reason_code="",
        ))

    def _block(index: int, hit: Any, judgment: EvidenceJudgment, code: str) -> None:
        blockers.append(judgment)
        outcomes.append(HitOutcome(
            index=index, category=hit.category, kind=hit.kind,
            hit_verdict="blocked", hit_reason_code=code,
        ))

    for index, hit in enumerate(finding.hits):
        category = hit.category
        location = hit.location.strip()
        preview = hit.preview or ""
        if not location:
            _block(index, hit, _rejected("hit is missing location evidence"),
                   "hit_missing_location")
            continue

        plugin_judge = _TASK_TYPE_JUDGES.get(finding.task_type)
        if plugin_judge is not None:
            plugin_judgment = plugin_judge(finding, hit)
            if plugin_judgment is not None:
                if plugin_judgment.should_persist:
                    _pass(index, hit)
                else:
                    # 도메인이 코드를 주면 그대로, 아니면 소유자만 표시.
                    _block(index, hit, plugin_judgment,
                           plugin_judgment.reason_code or f"plugin:{finding.task_type}")
                continue

        # v3.85: category 별 등록 judge — 도메인이 도입한 분류의 계약을 소유
        # (코어 하드코딩 category 분기보다 먼저). None = 미적용, 코어 계약 폴백.
        category_judge = _CATEGORY_JUDGES.get(category)
        if category_judge is not None:
            cj = category_judge(finding, hit)
            if cj is not None:
                if cj.should_persist:
                    _pass(index, hit)
                else:
                    _block(index, hit, cj, cj.reason_code or f"category:{category}")
                continue

        if category in _content_evidence_categories():
            # 실제 증거 = 비어있지 않은 preview, 또는 플레이스홀더가 아닌 masked 관찰값.
            # masked 에 "... keyword context" 같은 카테고리 라벨만 넣고 preview
            # 비운 채 제출하는 오탐 거부 (#27 재발 — masked 가 truthy 라 통과하던 버그).
            # 하드닝(codex): whitespace-only·assertion(<masked,len=N>·value_present)·전부
            # 마스킹문자 masked 는 증거 아님. 실제 값/설정 관찰만 인정.
            masked_real = (
                not _is_assertion_only_masked(hit.masked or "")
                and not _is_placeholder_evidence(hit.masked or "", hit.kind)
            )
            if category in ("credential", "secret"):
                # B1: credential/secret 은 라벨·산문·ID key 가 아니라 **실제 값 형상**
                # (PEM·secret detector 형상 AKIA/ghp_/xox/AIza/…·value key 대입) 또는
                # 구조화된 성공 probe 가 있어야 confirmed. 위조 산문/ID-only 통과 차단.
                # (pii/internal_system 은 마스킹 플로어 압박 방지 — 완화 게이트 유지.)
                confirmed_ok = _has_hardened_credential_value(
                    hit.kind, hit.masked or "", preview,
                ) or _has_successful_probe(hit)
                reject = _rejected(
                    f"{category} hit '{hit.kind}' 값 증거 없음 — 실제 노출된 값을 담은 줄"
                    "(예: key=value, 토큰 접두어, PEM 헤더) 또는 도달성 검증이 필요하다. "
                    "산문 설명·라벨만으론 credential/secret finding 금지.",
                    "실제 노출된 값(마스킹)이 담긴 줄 또는 probe 도달성 검증을 넣어 재제출",
                )
            else:
                confirmed_ok = bool(preview.strip() or masked_real)
                reject = _rejected(
                    f"{category} hit '{hit.kind}' 증거 없음 — masked={hit.masked!r} 는 "
                    "플레이스홀더/라벨이고 preview 가 비었다. 키워드 매칭만으론 finding 금지. "
                    "browser 로 화면을 열어 **실제 관찰한 값(마스킹)** 또는 본문 preview 를 "
                    "담아 재제출하거나, 실제 노출이 아니면 이 hit 를 빼라.",
                    "실제 화면에서 관찰한 구체 증거(masked 값 또는 preview)를 넣어 재제출",
                )
            if confirmed_ok:
                _pass(index, hit)
            else:
                _block(index, hit, reject,
                       "value_evidence_missing" if category in ("credential", "secret")
                       else "content_evidence_missing")
            continue

        if category == "attack_surface":
            # probe/leak 성격 경로(server-status, actuator, metrics, .env, .git, admin,
            # console, swagger, openapi 등)를 빈 증거로 attack_surface 에 끼워넣는 우회 차단.
            # 이런 건 "발견된 참조" 가 아니라 "노출됐다는 주장" 이므로 실제 응답 증거 필수.
            # (server-status 가 실제론 404 인데 finding 화되던 오탐 — preview="" 였음)
            if _looks_like_probe_endpoint(location) and not (hit.masked or preview):
                _block(index, hit, _suspected(
                    f"probe-style endpoint {location!r} claimed as attack_surface with no "
                    "evidence — fetch it and capture real 200 body, or drop it",
                    "GET the URL; if 404/SPA-fallback/redirect, it is NOT exposed — do not report",
                ), "probe_endpoint_unverified")
            elif _looks_like_attack_surface_location(location):
                _pass(index, hit)
            else:
                _block(index, hit, _suspected(
                    "attack_surface hit location is not a concrete URL/domain/IP",
                    "submit the discovered URL, domain, or IP as the hit location",
                ), "attack_surface_location_invalid")
            continue

        if category == "web_vuln":
            web_judgment = judge_web_finding(_WebFindingLike(
                url=location,
                kind=hit.kind,
                detail=finding.summary,
                evidence={"status": 200, "body_preview": preview} if preview else {},
            ))
            if web_judgment.should_persist:
                _pass(index, hit)
            else:
                _block(index, hit, web_judgment, "web_vuln_unverified")
            continue

        if category == "misconfig":
            # B2: finding.summary 는 필수 필드라 **항상 truthy** → 과거엔 모든 misconfig
            # hit 가 무조건 confirmed 됐다(고무도장). summary 는 서술이지 증거가 아니다.
            # 실제 관찰 증거(비어있지 않은 preview·플레이스홀더 아닌 masked·probe 검증)를 요구.
            # 하드닝(codex): whitespace-only·assertion masked 는 증거 아님.
            masked_real = (
                not _is_assertion_only_masked(hit.masked or "")
                and not _is_placeholder_evidence(hit.masked or "", hit.kind)
            )
            if preview.strip() or masked_real or _has_successful_probe(hit):
                _pass(index, hit)
            else:
                _block(index, hit, _suspected(
                    "misconfig hit lacks observed evidence — 실제 관찰한 설정/응답 "
                    "값(masked) 또는 본문 preview 를 담아 재제출하거나 이 hit 를 빼라",
                    "실제 화면·응답에서 관찰한 구체 증거(masked 값 또는 preview)를 넣어 재제출",
                ), "misconfig_unobserved")
            continue

        # audit #6: 위 어느 분기에도 안 걸린 미지/공백 category(모델 누락 또는
        # plugin_judge 없는 미등록 분류)는 증거 계약을 적용할 수 없다 → fail-closed.
        # (이 blocker 가 없으면 confirmed_count=0·blockers=[] 로 아래 _confirmed 에
        # 떨어져, 증거 없는 finding 이 "0 hit(s) passed" 로 영속되던 버그.)
        _block(index, hit, _rejected(
            f"hit category {category!r} 는 알 수 없는 분류라 증거 계약을 적용할 수 없다 — "
            "핵심 카테고리(secret/pii/credential/internal_system/attack_surface/"
            "web_vuln/misconfig) 또는 등록된 plugin 분류로 제출하라.",
            "hit 의 category 를 지원되는 분류로 지정하고 실제 증거를 담아 재제출",
        ), "unknown_category")

    if blockers:
        first = blockers[0]
        if confirmed_count == 0:
            return _stamp(first, "all_blocked", outcomes)
        # ★ 좌표를 붙인다. 예전엔 "1 hit(s) confirmed but 1 hit(s) need more evidence"
        #   뿐이라 워커가 **어느 hit 을 빼야 하는지 알 수 없었다.** 판정은 그대로다 —
        #   바뀌는 것은 거부가 자기 위치를 말하느냐뿐이다.
        return _stamp(_suspected(
            f"{confirmed_count} hit(s) confirmed but {len(blockers)} hit(s) "
            f"need more evidence.{_blocked_coords(outcomes)}",
            "remove weak hits or collect concrete evidence before final submission",
        ), "mixed_confidence", outcomes)
    # audit #6: 방어적 — 어떤 hit 도 증거 게이트를 통과하지 못했으면(정상 경로에선
    # 위 catch-all blocker 로 도달 불가) confirmed 로 영속하지 않는다.
    if confirmed_count == 0:
        return _stamp(_rejected("no hit passed the evidence contract"),
                      "no_hit_passed", outcomes)
    return _stamp(_confirmed(f"{confirmed_count} hit(s) passed evidence contract"),
                  "all_confirmed", outcomes)


@dataclass(frozen=True, slots=True)
class _WebFindingLike:
    url: str
    kind: str
    detail: str
    evidence: dict[str, Any]
