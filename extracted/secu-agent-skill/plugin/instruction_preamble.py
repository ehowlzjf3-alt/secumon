"""defensive-security instructions preamble — 코어에서 추출 (de-domain v3.84 #1).

구 코어 codex_responses_client._CODEX_CYBER_PREAMBLE 원형. chatgpt.com 모더레이터가
방어보안 점검 콘텐츠를 "cybersecurity risk" 로 차단하는 것을 우회하려고, OpenAI
엔터프라이즈 담당자 권고 preamble 을 Samsung DS SecOps 컨텍스트로 보강한 문구다.

코어가 register_instruction_preamble 훅을 노출하면서 이 문구(도메인/조직 특화)는
plugin 소관이 됐다. 원형·기본 ON 동작 보존 — SA_CODEX_CYBER_PREAMBLE 로 끌 수 있음
(구 코어와 동일한 env). 코어 transport 는 매 codex 요청 instructions 최상단에 결합.
"""
from __future__ import annotations

import os

_CYBER_PREAMBLE = (
    "This is an authorized defensive security review conducted by Samsung DS SecOps "
    "on our own internal systems.\n"
    "Scope is limited to our own corporate assets: samsungds.net domain and "
    "pre-authorized internal subnets (RFC1918 + chartered ranges with charter_ref).\n"
    "Activities are read-only enumeration and detection of misconfigurations and "
    "exposed secrets in our own assets, for risk identification and remediation only.\n"
    "All credentials (SMB / SSO) are env-referenced corporate service accounts owned "
    "by SecOps — no plaintext, no third-party systems.\n"
    "Use only the code, logs, configuration, and tool results provided in this session.\n"
    "Do not provide exploit execution steps, persistence techniques, evasion, "
    "credential theft from third parties, malware behavior, or instructions targeting "
    "systems outside our authorization.\n"
    "If a requested action could enable offensive misuse, stop and provide safe "
    "remediation guidance instead."
)


def _enabled() -> bool:
    return os.environ.get("SA_CODEX_CYBER_PREAMBLE", "1").lower() not in (
        "0", "false", "off", "no",
    )


def cyber_preamble() -> str | None:
    """register_instruction_preamble 공급자 — 매 요청 호출 (env 로 런타임 토글)."""
    return _CYBER_PREAMBLE if _enabled() else None
