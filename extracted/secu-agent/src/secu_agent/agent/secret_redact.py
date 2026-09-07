"""v3.51-S1: sensitive env 값을 tool output / chat 영속 layer 에서 redact.

배경: agent code 가 `python_exec` / `smb_python` / `bash_evidence` 안에서
`os.environ.get("SMB_PASSWORD")` 같이 평문 noun 노출 가능. tool 결과는
stash / DB chat_message / evidence_dir 까지 영속화돼서 leak surface 큼.

전략: substring 매칭 redact. agent 코드를 막는 게 아니라 output 만 사후 검열.
- 너무 짧은 값 (< 4 chars) 은 우연 매칭 위험 → skip.
- 값이 정상 단어와 겹치는 경우 (예: "password" 같이 settings 일부) 도 redact
  되긴 하지만 그건 false positive — defense-in-depth 우선.
"""
from __future__ import annotations

import os

# 추가하려면 여기에. 환경변수 이름만 — 값은 runtime 에 lookup.
SENSITIVE_ENV_KEYS: tuple[str, ...] = (
    "SMB_PASSWORD",
    "OPENAI_API_KEY",
    "OPENAI_CRED_KEY",
    "SA_BROWSER_BASIC_AUTH_PASS",
    "SA_CONFLUENCE_PAT",
    "SA_GITHUB_PAT",
    "SA_JENKINS_API_TOKEN",
)

_MIN_REDACT_LEN = 4
_REDACTED = "***REDACTED***"


def _collect_sensitive_values() -> list[tuple[str, str]]:
    """현재 process env 에서 sensitive 값들 수집. (key, value) 페어."""
    out: list[tuple[str, str]] = []
    for k in SENSITIVE_ENV_KEYS:
        v = os.environ.get(k)
        if not v:
            continue
        if len(v) < _MIN_REDACT_LEN:
            # 너무 짧으면 우연 매칭 비용 > 보호 가치. skip.
            continue
        out.append((k, v))
    # 긴 값부터 매칭 (짧은 값이 긴 값의 substring 인 경우 우선)
    out.sort(key=lambda kv: -len(kv[1]))
    return out


def redact_secrets(text: str) -> str:
    """text 내 sensitive env 값 모든 등장을 ***REDACTED*** 로 치환."""
    if not text:
        return text
    sens = _collect_sensitive_values()
    if not sens:
        return text
    for key, val in sens:
        if val in text:
            text = text.replace(val, f"{_REDACTED}({key})")
    return text
