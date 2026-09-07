"""Domain overview service for agent-filled web UI panels."""
from __future__ import annotations

import os
from typing import Any

# 코어 잔존 함수(finding_list/schedule_list/chat_session_list)는 엔진 state,
# 도메인 테이블 raw SQL 은 service.state_domain.connect() (v3.82 U3d).
from secu_agent import state

from service import state_domain


def _env_present(name: str) -> bool:
    return bool((os.environ.get(name) or "").strip())


def _split_env_list(name: str) -> list[str]:
    raw = os.environ.get(name) or ""
    return [part.strip() for part in raw.split(",") if part.strip()]


def _finding_count(task_type: str, *, status: str | None = None) -> int:
    return len(state.finding_list(task_type=task_type, status=status, limit=10_000))


def _schedule_count(agent_type: str) -> int:
    return len(state.schedule_list(agent_type=agent_type, status="active"))


def _agent_count(agent_type: str) -> int:
    return len(state.chat_session_list(agent_type=agent_type, include_archived=False, limit=10_000))


def _smb_domain() -> dict[str, Any]:
    with state_domain.connect() as c:
        share_total = int(c.execute("SELECT COUNT(*) FROM smb_share").fetchone()[0])
        readable = int(c.execute(
            "SELECT COUNT(*) FROM smb_share WHERE share_read=1",
        ).fetchone()[0])
        file_total = int(c.execute("SELECT COUNT(*) FROM smb_file").fetchone()[0])
        confirmed_hits = int(c.execute(
            "SELECT COUNT(*) FROM smb_file_hit WHERE agent_verdict='confirmed'",
        ).fetchone()[0])
        target_subnets = int(c.execute(
            "SELECT COUNT(*) FROM smb_target_subnet WHERE enabled=1",
        ).fetchone()[0])
    missing = []
    if target_subnets == 0 and share_total == 0:
        missing.append("scan target subnet")
    if share_total == 0:
        missing.append("SMB discovery result")
    return {
        "key": "smb",
        "label": "SMB / Office Shares",
        "agent_count": _agent_count("smb"),
        "active_schedules": _schedule_count("smb"),
        "required": [
            "target subnets",
            "readable share inventory",
            "walked file metadata",
            "secret/PII hits",
            "confirmed findings",
        ],
        "discovered": {
            "target_subnets": target_subnets,
            "shares": share_total,
            "readable_shares": readable,
            "files": file_total,
            "confirmed_hits": confirmed_hits,
            "open_findings": _finding_count("smb", status="open"),
        },
        "missing": missing,
    }


def _web_domain() -> dict[str, Any]:
    allowed_domains = _split_env_list("SA_WEB_ALLOWED_DOMAINS")
    allowed_cidrs = _split_env_list("SA_WEB_ALLOWED_CIDRS")
    missing = []
    if not allowed_domains and not allowed_cidrs:
        missing.append("web scope")
    if _finding_count("web") == 0:
        missing.append("web probe findings")
    return {
        "key": "web",
        "label": "Internal Web",
        "agent_count": _agent_count("web"),
        "active_schedules": _schedule_count("web"),
        "required": [
            "allowed domains/CIDRs",
            "seed URLs or discovered services",
            "HTTP/TLS fingerprints",
            "crawl/probe evidence",
            "confirmed web findings",
        ],
        "discovered": {
            "allowed_domains": len(allowed_domains),
            "allowed_cidrs": len(allowed_cidrs),
            "all_findings": _finding_count("web"),
            "open_findings": _finding_count("web", status="open"),
        },
        "missing": missing,
    }


def _known_domain(
    *,
    key: str,
    label: str,
    base_env: str,
    token_env: str,
    required: list[str],
) -> dict[str, Any]:
    configured = _env_present(base_env)
    credentialed = _env_present(token_env)
    missing = []
    if not configured:
        missing.append(base_env)
    if not credentialed:
        missing.append(token_env)
    if _finding_count(key) == 0:
        missing.append("confirmed findings or clean baseline")
    return {
        "key": key,
        "label": label,
        "agent_count": _agent_count(key),
        "active_schedules": _schedule_count(key),
        "required": required,
        "discovered": {
            "base_url_configured": configured,
            "credential_configured": credentialed,
            "all_findings": _finding_count(key),
            "open_findings": _finding_count(key, status="open"),
        },
        "missing": missing,
    }


def domain_overview() -> dict[str, Any]:
    domains = [
        _smb_domain(),
        _web_domain(),
        _known_domain(
            key="github",
            label="GitHub",
            base_env="GITHUB_BASE_URL",
            token_env="GITHUB_TOKEN",
            required=[
                "base URL",
                "API token",
                "repo inventory",
                "hot paths",
                "secret findings",
            ],
        ),
        _known_domain(
            key="jenkins",
            label="Jenkins",
            base_env="JENKINS_BASE_URL",
            token_env="JENKINS_API_TOKEN",
            required=[
                "base URL",
                "API token",
                "job inventory",
                "config.xml evidence",
                "console log findings",
            ],
        ),
        _known_domain(
            key="confluence",
            label="Confluence",
            base_env="CONFLUENCE_BASE_URL",
            token_env="CONFLUENCE_API_TOKEN",
            required=[
                "base URL",
                "API token",
                "space/page inventory",
                "attachment evidence",
                "sensitive content findings",
            ],
        ),
    ]
    return {
        "total": len(domains),
        "items": domains,
    }
