"""Scheduler helpers — cron 표현식 + prompt injection scan.

state.schedule_create 의 caller (operator 의 schedule tool, background tick)
공통으로 쓰는 도우미.

설계 의도:
- agent 가 자율적으로 schedule 을 만들기 때문에, 사용자/모델의 prompt 가
  악의적 / 부주의 한 내용을 담을 수 있다. 평문 비번, 'ignore previous instructions'
  같은 prompt injection 토큰, 빈 prompt 등은 거부.
- env:VAR_NAME 형식의 자격증명 ref 는 평문이 아니므로 통과 (정책 일관).
- cron 검증은 croniter 위임.
"""
from __future__ import annotations

import re
import time

from croniter import croniter


_MIN_PROMPT_LEN = 4
_MAX_PROMPT_LEN = 2000


# password= / pwd: / password is foo 같은 평문 비번 패턴
# env: 패턴은 별도 처리 (자격증명 ref 는 평문 아님)
_PLAINTEXT_PW_PATTERNS = [
    re.compile(r"\bpassword\s*[:=]\s*\S+", re.IGNORECASE),
    re.compile(r"\bpwd\s*[:=]\s*\S+", re.IGNORECASE),
    re.compile(r"\bpassword\s+is\s+\S+", re.IGNORECASE),
    re.compile(r"\bsenha\s*[:=]\s*\S+", re.IGNORECASE),
    re.compile(r"비밀번호\s*[:=]?\s*\S+"),
]

# prompt injection 시도 — 흔한 패턴들
_INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(all\s+)?previous\s+instructions?", re.IGNORECASE),
    re.compile(r"disregard\s+(all\s+)?(previous|prior)\s+", re.IGNORECASE),
    re.compile(r"system\s+override", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+", re.IGNORECASE),
    re.compile(r"act\s+as\s+(an?\s+)?(evil|malicious|jailbroken)", re.IGNORECASE),
    re.compile(r"새로운\s*지시", re.IGNORECASE),
    re.compile(r"이전\s*지시\s*무시", re.IGNORECASE),
]


def validate_cron_expr(expr: str) -> None:
    """croniter 가 받아들이면 통과. 아니면 ValueError."""
    if not expr or not expr.strip():
        raise ValueError("cron_expr is empty")
    try:
        # 단순 valid 체크 — base 는 임의값
        croniter(expr, 0)
    except Exception as e:
        raise ValueError(f"invalid cron expression {expr!r}: {e}") from e


def compute_next_run(cron_expr: str, *, base: float | None = None) -> float:
    """다음 fire 의 epoch seconds. base 이후 가장 가까운 trigger."""
    if base is None:
        base = time.time()
    validate_cron_expr(cron_expr)
    it = croniter(cron_expr, base)
    return float(it.get_next())


def _has_plaintext_password(prompt: str) -> bool:
    # env:VAR 패턴이 같이 들어있으면 평문 영역은 거기서 빼고 검사
    # 단순화: 전체 prompt 에서 env:WORD 토큰을 임시 마스킹 후 패턴 검사
    masked = re.sub(r"env:[A-Z0-9_]+", "__ENVREF__", prompt)
    for pat in _PLAINTEXT_PW_PATTERNS:
        if pat.search(masked):
            return True
    return False


def _has_injection(prompt: str) -> bool:
    for pat in _INJECTION_PATTERNS:
        if pat.search(prompt):
            return True
    return False


def scan_cron_prompt(prompt: str) -> str | None:
    """OK 면 None, 거부 사유 (str) 면 schedule 생성 차단.

    검사 순서: 길이 → injection → 평문 비번.
    """
    if not isinstance(prompt, str):
        return "prompt must be a string"
    stripped = prompt.strip()
    if len(stripped) < _MIN_PROMPT_LEN:
        return f"prompt too short (min {_MIN_PROMPT_LEN} chars)"
    if len(stripped) > _MAX_PROMPT_LEN:
        return f"prompt too long (max {_MAX_PROMPT_LEN} chars)"
    if _has_injection(stripped):
        return "prompt contains injection-like phrases (ignore previous / system override 등)"
    if _has_plaintext_password(stripped):
        return ("prompt appears to contain a plaintext password / credential. "
                "Use 'env:VAR_NAME' reference instead.")
    return None
