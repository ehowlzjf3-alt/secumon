"""Regex-based secret redaction — hermes-agent 패턴 port.

context_summarizer 가 LLM-summary 보내기 전에 secret 마스킹. logs 도 hook 가능.

secu_agent 는 사내 gateway 전용 — 기본 OFF (SA_REDACT_SECRETS=true 로 ON).
"""
from __future__ import annotations

import os
import re

# 사내 gateway 전용 — 기본 OFF. opt-in 으로 ON 가능.
_REDACT_ENABLED = os.getenv("SA_REDACT_SECRETS", "false").lower() in ("1", "true", "yes", "on")


# 알려진 API key prefix 패턴들 (hermes 에서 핵심만 포팅).
_PREFIX_PATTERNS = [
    r"sk-[A-Za-z0-9_-]{10,}",           # OpenAI / OpenRouter / Anthropic (sk-ant-*)
    r"ghp_[A-Za-z0-9]{10,}",            # GitHub PAT (classic)
    r"github_pat_[A-Za-z0-9_]{10,}",    # GitHub PAT (fine-grained)
    r"gho_[A-Za-z0-9]{10,}",            # GitHub OAuth
    r"ghu_[A-Za-z0-9]{10,}",            # GitHub user-to-server
    r"ghs_[A-Za-z0-9]{10,}",            # GitHub server-to-server
    r"ghr_[A-Za-z0-9]{10,}",            # GitHub refresh
    r"xox[baprs]-[A-Za-z0-9-]{10,}",    # Slack
    r"AIza[A-Za-z0-9_-]{30,}",          # Google
    r"AKIA[A-Z0-9]{16}",                # AWS access key id
    r"sk_live_[A-Za-z0-9]{10,}",        # Stripe live
    r"sk_test_[A-Za-z0-9]{10,}",        # Stripe test
    r"SG\.[A-Za-z0-9_-]{10,}",          # SendGrid
    r"hf_[A-Za-z0-9]{10,}",             # HuggingFace
    r"npm_[A-Za-z0-9]{10,}",            # npm
    r"pypi-[A-Za-z0-9_-]{10,}",         # PyPI
    r"glpat-[A-Za-z0-9_-]{10,}",        # GitLab PAT
]

# ENV 할당: KEY=value, KEY 가 secret-like 이름
_SECRET_ENV_NAMES = r"(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)"
_ENV_ASSIGN_RE = re.compile(
    rf"([A-Z0-9_]{{0,50}}{_SECRET_ENV_NAMES}[A-Z0-9_]{{0,50}})\s*=\s*(['\"]?)(\S+)\2",
)

# JSON field: "apiKey": "value" 등
_JSON_KEY_NAMES = (
    r"(?:api_?[Kk]ey|token|secret|password|access_token|refresh_token"
    r"|auth_token|bearer|secret_value|raw_secret|secret_input|key_material)"
)
_JSON_FIELD_RE = re.compile(
    rf'("{_JSON_KEY_NAMES}")\s*:\s*"([^"]+)"',
    re.IGNORECASE,
)

# Authorization: Bearer ...
_AUTH_HEADER_RE = re.compile(
    r"(Authorization:\s*Bearer\s+)(\S+)",
    re.IGNORECASE,
)

# -----BEGIN ... PRIVATE KEY-----
_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----"
)

# postgres://user:PASSWORD@host 류
_DB_CONNSTR_RE = re.compile(
    r"((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)://[^:]+:)([^@]+)(@)",
    re.IGNORECASE,
)

# JWT: header.payload[.signature]
_JWT_RE = re.compile(
    r"eyJ[A-Za-z0-9_-]{10,}"
    r"(?:\.[A-Za-z0-9_=-]{4,}){0,2}"
)

_PREFIX_RE = re.compile(
    r"(?<![A-Za-z0-9_-])(" + "|".join(_PREFIX_PATTERNS) + r")(?![A-Za-z0-9_-])"
)


def _mask_token(token: str) -> str:
    """짧으면 전부 마스킹, 길면 앞 6 + 뒤 4 보존."""
    if len(token) < 18:
        return "***"
    return f"{token[:6]}...{token[-4:]}"


def mask_secret(
    value: str,
    *,
    head: int = 4,
    tail: int = 4,
    floor: int = 12,
    placeholder: str = "***",
    empty: str = "",
) -> str:
    """단일 secret 마스킹 — head/tail 글자 보존.

    floor 미만 길이면 전부 placeholder. 빈 문자열은 empty 반환.
    """
    if not value:
        return empty
    if len(value) < floor:
        return placeholder
    return f"{value[:head]}{placeholder}{value[-tail:]}"


def redact_sensitive_text(
    text: object, *, force: bool = False, code_file: bool = False,
) -> str:
    """모든 패턴 적용. 매치 없으면 그대로 통과.

    SA_REDACT_SECRETS=true 환경변수 / force=True 일 때만 활성.
    code_file=True 면 ENV/JSON 패턴 skip (false positive 회피).
    """
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)
    if not text:
        return text
    if not (force or _REDACT_ENABLED):
        return text

    # 1) 알려진 prefix (sk-, ghp_, AKIA…)
    text = _PREFIX_RE.sub(lambda m: _mask_token(m.group(1)), text)

    # 2) ENV 할당 + JSON field (code_file=True 면 skip)
    if not code_file:
        def _redact_env(m: re.Match) -> str:
            name, quote, value = m.group(1), m.group(2), m.group(3)
            return f"{name}={quote}{_mask_token(value)}{quote}"
        text = _ENV_ASSIGN_RE.sub(_redact_env, text)

        def _redact_json(m: re.Match) -> str:
            key, value = m.group(1), m.group(2)
            return f'{key}: "{_mask_token(value)}"'
        text = _JSON_FIELD_RE.sub(_redact_json, text)

    # 3) Authorization: Bearer
    text = _AUTH_HEADER_RE.sub(
        lambda m: m.group(1) + _mask_token(m.group(2)),
        text,
    )

    # 4) PRIVATE KEY block
    text = _PRIVATE_KEY_RE.sub("[REDACTED PRIVATE KEY]", text)

    # 5) DB conn string password
    text = _DB_CONNSTR_RE.sub(lambda m: f"{m.group(1)}***{m.group(3)}", text)

    # 6) JWT
    text = _JWT_RE.sub(lambda m: _mask_token(m.group(0)), text)

    return text
