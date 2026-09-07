# [REORG 3축=G] services 공통 레이어 — artifact 정규화→scan+mask→evidence write→
#   state persist→signal emit 오케스트레이션. 빌딩블록 전부 generic(scan_text/state/JSON).
#   per-service agent_type 는 교체 가능한 입력. TODO: 절차를 domains/services/SKILL.md 로 흡수.
"""High-level GitHub/Jenkins/Confluence tasking tools."""
from __future__ import annotations

import asyncio
import importlib
import importlib.util
import json
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, ClassVar
from urllib.parse import unquote
from uuid import uuid4

from pydantic import BaseModel, Field

from secu_agent import state
from secu_agent.agent.evidence_judgment import is_low_value_only
from secu_agent.agent.finding_followup import (
    FindingSignal,
    append_finding_signal,
)
from secu_agent.agent.finding_provenance import with_agent_provenance
from secu_agent.agent.tools.base import (
    Tool,
    ToolContext,
    ToolError,
    ToolResult,
    ToolSuccess,
)
from secu_agent.detectors import scan_text
from secu_agent.detectors.secrets import find_high_entropy, mask_secret
from secu_agent.detectors.text_scan import Hit
from domains.services.confluence.plugin.agent_types import confluence as cf
from domains.services.github.plugin.agent_types import github as gh
from domains.services.jenkins.plugin.agent_types import jenkins as jk
from service import state_domain
from service.services.finding_verification import make_agent_verification


_DEFAULT_GITHUB_HOT_PATHS = (
    ".env",
    ".npmrc",
    ".pypirc",
    "secret",
    "credential",
    "password",
    "token",
    "Jenkinsfile",
    "terraform",
    "tfvars",
    "kubeconfig",
    "application.properties",
    "application.yml",
    "config/",
)
# v3.92: **일반 어휘(`password`/`secret`/`token`) 를 뺐다.**
#
# 실측(최근 open finding 600건의 `candidate_query`):
#   token 89 · secret 46 · password 43  =  178건(98%)   ←  오탐의 원천
#   ghp_ 2 · AKIA 1                     =    3건
# `token` 이 최악이다 — GHES 검색 토크나이저는 구두점을 무시해서 `totalTokens`,
# `max_tokens`, `sumsInputTokens` 같은 **식별자**가 전부 걸린다. 그렇게 뽑힌 파일을
# detector 가 훑으면 `generic_config_secret_assignment` 가 `Math.max(1` 까지 잡는다.
# (실측 itdevsec/SecuLens: 27건 전량 오탐, 워커 자신도 "27건 모두 기각"으로 닫았다)
#
# ⚠️ 회수(recall) 를 잃지 않는지 **사람이 KEEP 판정한 진짜 4건으로 검산**했다:
#   #18333 query=`secret` → hit `private_key_block`  ⇒ "BEGIN … PRIVATE KEY" 가 잡는다
#   #18393 query=`token`  → hit `github_pat` ghp_…   ⇒ `ghp_` 가 잡는다
#   #18343 query=없음     → hit `database_url_with_password` postgres://… ⇒ `postgres://`
#   #18562 query=없음     → hit `github_pat` ghp_…   ⇒ `ghp_`
# 4건 전부 값 접두로 재발견된다. 즉 일반 어휘가 **단독으로 건진 진짜는 없다**.
#
# 하드코딩 비밀번호(`password=hunter2`)는 어휘가 아니라 아래 `filename:` 표적이 맡는다 —
# 걸린 파일은 detector 전체 스캔을 받으므로 값이 무엇이든 잡힌다(#18620 이 그 경로로 나왔다).
_DEFAULT_GITHUB_CODE_SEARCH_TERMS = (
    # ── 값 접두: 오탐이 구조적으로 거의 없다
    "AKIA",
    "ASIA",
    "ghp_",
    "gho_",
    "github_pat",
    "glpat-",
    "AIza",
    "xoxb-",
    # ── 값 블록/접속문자열
    "BEGIN RSA PRIVATE KEY",
    "BEGIN OPENSSH PRIVATE KEY",
    "BEGIN PRIVATE KEY",
    "postgres://",
    "mongodb+srv",
    # ── 파일 표적: 진짜 시크릿이 사는 곳. 걸리면 파일 전체를 detector 가 훑는다
    "filename:.env",
    "filename:.npmrc",
    "filename:.pypirc",
    "filename:.netrc",
    "filename:credentials",
    "filename:id_rsa",
    "filename:.pem",
    "filename:.tfvars",
    "filename:kubeconfig",
    "filename:application.properties",
    "filename:application.yml",
)
_GITHUB_AUTH_FAILURE_STATUS_CODES = {401}
_GITHUB_LIMIT_FAILURE_STATUS_CODES = {429}
_GITHUB_LIMIT_FAILURE_TEXT = (
    "abuse detection",
    "rate limit",
    "rate-limit",
    "rate_limited",
    "ratelimit",
    "retry-after",
    "secondary rate limit",
    "too many requests",
)
_DEFAULT_CONFLUENCE_TITLE_KEYWORDS = (
    "credential",
    "password",
    "secret",
    "token",
    "account",
    "admin",
    "onboarding",
    "runbook",
    "incident",
    "vpn",
    "deploy",
    "jenkins",
    "github",
    "운영",
    "배포",
    "계정",
    "자격",
    "비밀번호",
    "개인정보",
    "인사",
    "사번",
    "임직원",
    "주민번호",
    "급여",
    "경영진",
    "임원회의",
    "회의록",
    "사업계획",
    "경영계획",
    "매출",
    "원가",
    "고객사",
    "계약",
    "공정",
    "레시피",
    "recipe",
    "yield",
    "수율",
    "wafer",
    "lot",
    "equipment",
    "설비",
)
_DEFAULT_CONFLUENCE_CQL_TERMS = (
    "password",
    "credential",
    "secret",
    "token",
    "api key",
    "apikey",
    "AKIA",
    "ghp_",
    "xoxb-",
    "sk_live",
    "DB_PASSWORD",
    "DATABASE_URL",
    "kubeconfig",
    "tfvars",
    "계정",
    "비밀번호",
    "토큰",
    "자격",
    "개인정보",
    "인사정보",
    "사번",
    "임직원",
    "employee",
    "payroll",
    "salary",
    "주민번호",
    "급여",
    "경영진",
    "임원회의",
    "회의록",
    "executive meeting",
    "business review",
    "사업계획",
    "경영계획",
    "매출",
    "원가",
    "고객사",
    "계약",
    "revenue forecast",
    "pricing strategy",
    "contract value",
    "process recipe",
    "recipe",
    "yield",
    "wafer",
    "lot id",
    "equipment",
    "공정",
    "레시피",
    "수율",
    "웨이퍼",
    "설비",
)
_CONFLUENCE_AUTH_FAILURE_STATUS_CODES = {401}
_CONFLUENCE_LIMIT_FAILURE_STATUS_CODES = {429}
_CONFLUENCE_LIMIT_FAILURE_TEXT = (
    "abuse detection",
    "rate limit",
    "rate-limit",
    "rate_limited",
    "ratelimit",
    "retry-after",
    "secondary rate limit",
    "too many requests",
)
_TEXT_ATTACHMENT_HINTS = (
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".yaml",
    ".yml",
    ".xml",
    ".properties",
    ".env",
    ".conf",
    ".cfg",
    ".ini",
    ".tfstate",
    ".tfvars",
    ".log",
)
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")
_GITHUB_COMMIT_SHA_RE = re.compile(r"^[0-9a-fA-F]{7,64}$")
_ATTACHMENT_DOWNLOAD_PAGE_RE = re.compile(r"/attachments/(?P<page_id>[^/?#]+)/")


def _invalid_github_repo_path_reason(path: str, *, subject: str) -> str | None:
    value = str(path or "").strip()
    if not value:
        return f"{subject} missing path"
    if len(value) > 4096:
        return f"{subject} invalid path"
    if value.startswith("/") or "\\" in value or _CONTROL_CHAR_RE.search(value):
        return f"{subject} invalid path"
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return f"{subject} invalid path"
    return None


def _invalid_github_commit_sha_reason(sha: str) -> str | None:
    value = str(sha or "").strip()
    if not value:
        return "GitHub commit candidate missing sha"
    if not _GITHUB_COMMIT_SHA_RE.fullmatch(value):
        return "GitHub commit candidate invalid sha"
    return None


def _valid_github_commit_shas(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in values:
        sha = str(raw or "").strip()
        if _invalid_github_commit_sha_reason(sha):
            continue
        key = sha.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(sha)
    return out


def _invalid_github_file_path_reason(path: str) -> str | None:
    return _invalid_github_repo_path_reason(path, subject="GitHub file candidate")


def _invalid_github_directory_path_reason(path: str) -> str | None:
    if str(path or "").strip() == ".":
        return None
    return _invalid_github_repo_path_reason(path, subject="GitHub directory candidate")


def _valid_github_file_paths(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in values:
        path = str(raw or "").strip()
        if _invalid_github_file_path_reason(path):
            continue
        key = path.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(path)
    return out


def _valid_github_directory_paths(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in values:
        path = str(raw or "").strip().strip("/")
        if _invalid_github_directory_path_reason(path):
            continue
        key = path.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(path)
    return out


def _invalid_github_pull_number_reason(number: Any) -> str | None:
    try:
        value = int(number)
    except (TypeError, ValueError):
        return "GitHub pull request candidate invalid number"
    if value <= 0:
        return "GitHub pull request candidate invalid number"
    return None


def _valid_github_pull_numbers(values: list[int]) -> list[int]:
    out: list[int] = []
    seen: set[int] = set()
    for raw in values:
        if _invalid_github_pull_number_reason(raw):
            continue
        number = int(raw)
        if number in seen:
            continue
        seen.add(number)
        out.append(number)
    return out


def _invalid_github_issue_number_reason(number: Any) -> str | None:
    try:
        value = int(number)
    except (TypeError, ValueError):
        return "GitHub issue candidate invalid number"
    if value <= 0:
        return "GitHub issue candidate invalid number"
    return None


def _valid_github_issue_numbers(values: list[int]) -> list[int]:
    out: list[int] = []
    seen: set[int] = set()
    for raw in values:
        if _invalid_github_issue_number_reason(raw):
            continue
        number = int(raw)
        if number in seen:
            continue
        seen.add(number)
        out.append(number)
    return out


def _invalid_github_compare_ref_reason(compare_ref: str) -> str | None:
    value = str(compare_ref or "").strip()
    if not value:
        return "GitHub compare candidate missing ref"
    if len(value) > 512 or "\\" in value or _CONTROL_CHAR_RE.search(value):
        return "GitHub compare candidate invalid ref"
    if value.count("...") != 1:
        return "GitHub compare candidate invalid ref"
    base, head = value.split("...", 1)
    if not base.strip() or not head.strip():
        return "GitHub compare candidate invalid ref"
    parts = value.replace("...", "/").split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return "GitHub compare candidate invalid ref"
    return None


def _valid_github_compare_refs(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in values:
        compare_ref = str(raw or "").strip()
        if _invalid_github_compare_ref_reason(compare_ref):
            continue
        key = compare_ref.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(compare_ref)
    return out


def _invalid_github_release_tag_reason(tag_name: str) -> str | None:
    value = str(tag_name or "").strip()
    if not value:
        return "GitHub release candidate missing tag"
    if len(value) > 512 or "\\" in value or _CONTROL_CHAR_RE.search(value):
        return "GitHub release candidate invalid tag"
    if value.startswith("/") or value.endswith("/") or "//" in value or "@{" in value:
        return "GitHub release candidate invalid tag"
    if any(ch in value for ch in ("~", "^", ":", "?", "*", "[", "]")):
        return "GitHub release candidate invalid tag"
    parts = value.split("/")
    if any(part in {"", ".", ".."} or part.endswith(".") for part in parts):
        return "GitHub release candidate invalid tag"
    return None


def _valid_github_release_tags(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in values:
        tag_name = str(raw or "").strip()
        if _invalid_github_release_tag_reason(tag_name):
            continue
        key = tag_name.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(tag_name)
    return out


def _invalid_github_branch_name_reason(branch_name: str) -> str | None:
    value = str(branch_name or "").strip()
    if not value:
        return "GitHub branch candidate missing name"
    if len(value) > 512 or "\\" in value or _CONTROL_CHAR_RE.search(value):
        return "GitHub branch candidate invalid name"
    if value.startswith("/") or value.endswith("/") or "//" in value or "@{" in value:
        return "GitHub branch candidate invalid name"
    if any(ch in value for ch in ("~", "^", ":", "?", "*", "[", "]")):
        return "GitHub branch candidate invalid name"
    parts = value.split("/")
    if any(part in {"", ".", ".."} or part.endswith(".") for part in parts):
        return "GitHub branch candidate invalid name"
    if value.endswith(".lock"):
        return "GitHub branch candidate invalid name"
    return None


def _invalid_github_tag_name_reason(tag_name: str) -> str | None:
    reason = _invalid_github_release_tag_reason(tag_name)
    if reason is None:
        return None
    return reason.replace("release candidate", "tag candidate")


def _invalid_confluence_page_id_reason(page_id: str) -> str | None:
    value = str(page_id or "").strip()
    if not value:
        return "Confluence page candidate missing id"
    if len(value) > 512:
        return "Confluence page candidate invalid id"
    if "/" in value or "\\" in value or _CONTROL_CHAR_RE.search(value):
        return "Confluence page candidate invalid id"
    return None


def _invalid_confluence_comment_id_reason(comment_id: str) -> str | None:
    value = str(comment_id or "").strip()
    if not value:
        return "Confluence comment candidate missing comment_id"
    if len(value) > 512:
        return "Confluence comment candidate invalid comment_id"
    if "/" in value or "\\" in value or _CONTROL_CHAR_RE.search(value):
        return "Confluence comment candidate invalid comment_id"
    return None


def _invalid_confluence_attachment_download_reason(
    download_url: str,
    *,
    page_id: str,
) -> str | None:
    value = str(download_url or "").strip()
    if not value:
        return "Confluence attachment candidate missing id, filename, or download_url"
    if (
        "\\" in value
        or "://" in value
        or value.startswith("//")
        or _CONTROL_CHAR_RE.search(value)
        or any(part == ".." for part in value.split("/"))
    ):
        return "Confluence attachment candidate invalid download_url"
    match = _ATTACHMENT_DOWNLOAD_PAGE_RE.search(value)
    if match and str(match.group("page_id") or "").strip() != str(page_id or "").strip():
        return "Confluence attachment candidate invalid download_url"
    return None


def _invalid_jenkins_job_name_reason(job_name: str) -> str | None:
    value = str(job_name or "").strip()
    if not value:
        return "Jenkins job candidate missing full_name"
    if len(value) > 1024:
        return "Jenkins job candidate invalid full_name"
    if "\\" in value or _CONTROL_CHAR_RE.search(value):
        return "Jenkins job candidate invalid full_name"
    parts = value.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return "Jenkins job candidate invalid full_name"
    return None


def _confluence_attachment_download_match_key(download_url: str) -> str:
    return unquote(str(download_url or "").strip())


def _positive_int_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    text = str(value or "").strip()
    if not text or not text.isdecimal():
        return None
    parsed = int(text)
    return parsed if parsed > 0 else None


def _candidate_label(value: Any) -> str:
    text = str(value or "").strip()
    return text or "(missing)"


@dataclass(slots=True)
class _Artifact:
    task_type: str
    asset: str
    asset_kind: str
    label: str
    text: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class _ScannedArtifact:
    artifact: _Artifact
    hits: list[dict[str, Any]]
    bytes_scanned: int


_GITHUB_IMPORTANCE_SIGNALS: dict[str, tuple[str, ...]] = {
    "production": ("prod", "prd", "production", "운영"),
    "manufacturing_process": (
        "recipe", "yield", "wafer", "lot", "eqp", "equipment", "process", "공정", "설비",
    ),
    "hr_or_bulk_personal": ("hr", "human", "payroll", "personnel", "employee", "인사", "급여"),
    "business_confidential": (
        "finance", "cost", "price", "sales", "customer", "contract", "executive",
        "회의록", "경영", "원가", "매출", "고객", "계약",
    ),
    "credential_infra": (
        "auth", "sso", "iam", "vault", "token", "secret", "credential", "kube", "jenkins",
    ),
}


def _github_repo_context(target: dict[str, Any] | None, repo: str) -> dict[str, Any]:
    target = target or {}
    out: dict[str, Any] = {
        "repo": str(target.get("full_name") or repo or "").strip(),
        "default_branch": str(target.get("default_branch") or "main").strip() or "main",
        "source": str(target.get("source") or "").strip(),
    }
    for key in ("visibility", "private", "archived", "pushed_at", "size_kb"):
        value = target.get(key)
        if value is not None and value != "":
            out[key] = value
    return out


def _github_system_importance(*, repo: str, path: str, label: str, text: str) -> dict[str, Any]:
    haystack = " ".join([
        str(repo or ""),
        str(path or ""),
        str(label or ""),
        str(text or "")[:5000],
    ]).lower()
    signals: list[str] = []
    for signal, terms in _GITHUB_IMPORTANCE_SIGNALS.items():
        if any(term.lower() in haystack for term in terms):
            signals.append(signal)
    if any(signal in signals for signal in (
        "production", "manufacturing_process", "hr_or_bulk_personal", "business_confidential",
    )):
        level = "high"
    elif signals:
        level = "medium"
    else:
        level = "low"
    return {
        "level": level,
        "signals": sorted(set(signals)),
        "basis": "repo/path/content keyword context; read-only importance hint, not a finding by itself",
    }


def _enrich_github_artifacts(
    artifacts: list[_Artifact],
    *,
    targets: list[dict[str, Any]],
) -> None:
    target_by_repo = {
        str(t.get("full_name") or "").strip().lower(): t
        for t in targets
        if str(t.get("full_name") or "").strip()
    }
    for artifact in artifacts:
        if artifact.task_type != "github":
            continue
        repo = str(artifact.metadata.get("repo") or "").strip()
        path = str(artifact.metadata.get("path") or "").strip()
        artifact.metadata["repo_context"] = _github_repo_context(
            target_by_repo.get(repo.lower()),
            repo,
        )
        artifact.metadata["system_importance"] = _github_system_importance(
            repo=repo,
            path=path,
            label=artifact.label,
            text=artifact.text,
        )


def _line_bounds(text: str, span: tuple[int, int]) -> tuple[int, int]:
    start = text.rfind("\n", 0, span[0]) + 1
    end = text.find("\n", span[1])
    if end == -1:
        end = len(text)
    return start, end


def _other_hit_on_same_line(text: str, target: Hit, all_hits: list[Hit]) -> bool:
    """v3.78.1: target hit 과 같은 줄에 다른 hit 이 있나 (author-email 억제 가드).

    같은 줄에 secret/다른 PII 가 있으면 author 이메일이라도 드랍하지 않는다 — 노출 증거 보존."""
    start, end = _line_bounds(text, target.span)
    for h in all_hits:
        if h is target:
            continue
        if start <= h.span[0] < end:
            return True
    return False


def _masked_preview(text: str, hit: Hit, *, max_chars: int = 220) -> str:
    start, end = _line_bounds(text, hit.span)
    rel_start = max(0, hit.span[0] - start)
    rel_end = max(rel_start, hit.span[1] - start)
    line = text[start:end]
    masked_line = line[:rel_start] + hit.masked + line[rel_end:]
    masked_line = " ".join(masked_line.strip().split())
    if len(masked_line) <= max_chars:
        return masked_line
    return masked_line[: max_chars - 1].rstrip() + "…"


def _hit_payload(text: str, hit: Hit) -> dict[str, Any]:
    return {
        "category": hit.category,
        "kind": hit.kind,
        "masked": hit.masked,
        "line_no": hit.line_no,
        "line_preview": _masked_preview(text, hit),
    }


def _hit_signatures_from_text(text: str, *, high_entropy: bool = False) -> list[dict[str, str]]:
    result = scan_text(text, label="confluence-current-page")
    out = [
        {"kind": h.kind, "masked": h.masked}
        for h in result.hits
        if h.kind and h.masked
    ]
    if high_entropy:
        taken = [hit.span for hit in result.hits]
        for he in find_high_entropy(text):
            if any(s <= he.span[0] < e for s, e in taken):
                continue
            out.append({"kind": "high_entropy_string", "masked": mask_secret(he.matched)})
    return out


def _hit_signature_set(hits: list[dict[str, Any]]) -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for hit in hits:
        kind = str(hit.get("kind") or "")
        masked = str(hit.get("masked") or "")
        if kind and masked:
            out.add((kind, masked))
    return out


def _public_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in metadata.items() if not str(k).startswith("_")}


def _github_secret_gate_pass(artifact: _Artifact, hits: list[dict[str, Any]]) -> bool:
    """github 시크릿 정오탐 게이트 통과 여부(hit 하나라도 통과하면 finding 유지).

    규칙 본체는 `domains/services/github/application/secret_gate.py` — clone 스캐너
    경로(`scanner._persist_scan_findings`)와 **같은 규칙**을 쓴다. 지연 import 인 이유는
    scanner 가 mail/delivery 까지 끌고 오는 무거운 모듈이라 여기서 직접 참조하면
    도구 로딩 비용과 순환 위험이 생기기 때문이다(secret_gate 자체는 os/re 만 쓴다).
    """
    from domains.services.github.application import secret_gate

    path = str((artifact.metadata or {}).get("path") or "")
    # 본문을 같이 넘긴다 — 공개 인증서 판정은 hit 조각(`MIIE****…CQYD`)만으로는 불가능하고
    # 파일 전체에 `BEGIN CERTIFICATE` 가 있는지 봐야 한다(finding #18900, 2026-08-16).
    return secret_gate.any_reportable_hit(hits, path, document=artifact.text)


def _confluence_initial_verification(
    artifact: _Artifact,
    hits: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if artifact.task_type != "confluence":
        return None
    metadata = artifact.metadata
    page_id = str(metadata.get("page_id") or "").strip()
    labels = [page_id] if page_id else []
    kind = artifact.asset_kind
    if kind == "page_version":
        original = _hit_signature_set(hits)
        current = _hit_signature_set(metadata.get("_current_page_signatures") or [])
        matched = bool(original & current)
        verification: dict[str, Any] = {
            "method": "confluence_current_page_signature",
            "status": "current_page" if matched else "historical_version",
            "matched_current": matched,
            "surface_labels": labels,
        }
        if metadata.get("version") is not None:
            verification["source_version"] = metadata.get("version")
        return verification
    status_by_kind = {
        "page": "current_page",
        "comment": "comment_surface",
        "attachment": "attachment_surface",
    }
    status = status_by_kind.get(kind)
    if not status:
        return None
    return {
        "method": "confluence_detail_scan",
        "status": status,
        "matched_current": kind == "page",
        "surface_labels": labels,
    }


def _severity_for_hits(hits: list[dict[str, Any]]) -> str:
    if any(hit.get("category") == "secret" for hit in hits):
        return "high"
    if any(hit.get("category") in {"semiconductor_process", "business_confidential"} for hit in hits):
        return "high"
    if any(hit.get("category") == "pii" for hit in hits):
        return "medium"
    return "informational"


def _confidence_for_hits(hits: list[dict[str, Any]]) -> float:
    if any(hit.get("category") == "secret" for hit in hits):
        return 0.88
    if any(hit.get("category") in {"semiconductor_process", "business_confidential"} for hit in hits):
        return 0.82
    if hits:
        return 0.76
    return 0.0


def _recommended_actions(task_type: str, asset_kind: str) -> list[str]:
    if task_type == "github":
        return [
            "validate whether the detected value is live or example-only",
            "rotate confirmed exposed credentials and review repository history",
            "scan sibling repositories for the same pattern",
        ]
    if task_type == "jenkins":
        return [
            "validate whether the value is still usable and identify job owner",
            "move secrets to Jenkins credentials binding or approved secret storage",
            "review recent builds and linked jobs for repeat exposure",
        ]
    if task_type == "confluence":
        return [
            "validate page owner and classify whether the content is credential, bulk HR/PII, business-confidential, or process-sensitive",
            "move credentials to approved secret storage and restrict confidential documents to least-privilege groups",
            "review linked pages, attachments, comments, and prior page versions for repeat exposure",
        ]
    return [f"validate {asset_kind} evidence and assign owner"]


def _cql_quote(value: str) -> str:
    return str(value or "").replace("\\", "\\\\").replace('"', '\\"')


def _confluence_search_queries(space_key: str | None, terms: list[str]) -> list[str]:
    queries: list[str] = []
    prefix = "type = page"
    if space_key:
        prefix = f'space = "{_cql_quote(space_key)}" AND {prefix}'
    for term in terms:
        cleaned = str(term or "").strip()
        if not cleaned:
            continue
        quoted = _cql_quote(cleaned)
        queries.append(f'{prefix} AND text ~ "{quoted}"')
        queries.append(f'{prefix} AND title ~ "{quoted}"')
    return queries


def _github_code_search_queries(repo: str, terms: list[str]) -> list[str]:
    queries: list[str] = []
    for term in terms:
        cleaned = str(term or "").strip()
        if cleaned:
            queries.append(f"repo:{repo} {cleaned}")
    return queries


def _github_api_unavailable(error: Exception) -> bool:
    if _github_api_auth_failed(error) or _github_api_limit_failed(error):
        return False
    text = repr(error)
    return (
        "GITHUB_BASE_URL" in text
        or "GITHUB_TOKEN" in text
        or error.__class__.__module__.startswith("httpx")
    )


def _http_status_code(error: Exception) -> int | None:
    response = getattr(error, "response", None)
    status = getattr(response, "status_code", None)
    if isinstance(status, int):
        return status
    match = re.search(r"\bHTTP\s+(\d{3})\b", str(error))
    if match:
        return int(match.group(1))
    return None


def _http_error_text(error: Exception) -> str:
    parts = [repr(error)]
    response = getattr(error, "response", None)
    if response is not None:
        try:
            parts.append(str(response.text))
        except Exception:  # noqa: BLE001
            pass
        try:
            parts.extend(f"{k}: {v}" for k, v in response.headers.items())
        except Exception:  # noqa: BLE001
            pass
    return "\n".join(parts).lower()


def _github_api_auth_failed(error: Exception) -> bool:
    return _http_status_code(error) in _GITHUB_AUTH_FAILURE_STATUS_CODES


def _github_api_limit_failed(error: Exception) -> bool:
    status_code = _http_status_code(error)
    if status_code in _GITHUB_LIMIT_FAILURE_STATUS_CODES:
        return True
    if status_code == 403:
        text = _http_error_text(error)
        return any(token in text for token in _GITHUB_LIMIT_FAILURE_TEXT)
    return False


def _confluence_api_auth_failed(error: Exception) -> bool:
    return _http_status_code(error) in _CONFLUENCE_AUTH_FAILURE_STATUS_CODES


def _confluence_api_limit_failed(error: Exception) -> bool:
    status_code = _http_status_code(error)
    if status_code in _CONFLUENCE_LIMIT_FAILURE_STATUS_CODES:
        return True
    if status_code == 403:
        text = _http_error_text(error)
        return any(token in text for token in _CONFLUENCE_LIMIT_FAILURE_TEXT)
    return False


def _error_status_code(error: dict[str, Any]) -> int | None:
    status = error.get("status_code")
    if isinstance(status, int):
        return status
    try:
        return int(status)
    except (TypeError, ValueError):
        return None


def _error_has_http_status(error: dict[str, Any], statuses: set[int]) -> bool:
    status = _error_status_code(error)
    if status in statuses:
        return True
    text = str(error.get("error") or "")
    return any(f"HTTP {code}" in text for code in statuses)


def _github_repo_meta_missing_error(
    repo_name: str,
    *,
    status_code: int | None = None,
) -> dict[str, Any]:
    err = {
        "target": repo_name,
        "phase": "repo_meta",
        "error": "repo metadata not found",
    }
    if status_code is not None:
        err["status_code"] = status_code
    return err


def _github_repo_meta_inaccessible_error(
    repo_name: str,
    error: Exception,
) -> dict[str, Any] | None:
    if _github_api_limit_failed(error):
        return None
    if _http_status_code(error) not in {403, 404}:
        return None
    return _github_repo_meta_missing_error(repo_name, status_code=_http_status_code(error))


def _github_missing_repo_error(repo_name: str, error: Exception) -> dict[str, Any] | None:
    if _github_api_limit_failed(error):
        return None
    if _http_status_code(error) not in {403, 404}:
        return None
    try:
        meta = gh.repo_meta(repo_name)
    except Exception as exc:  # noqa: BLE001
        return _github_repo_meta_inaccessible_error(repo_name, exc)
    if meta is not None:
        return None
    return _github_repo_meta_missing_error(repo_name, status_code=_http_status_code(error))


def _scan_artifacts(
    artifacts: list[_Artifact],
    *,
    high_entropy: bool = False,
    include_document_signals: bool = False,
) -> list[_ScannedArtifact]:
    """artifact 텍스트를 결정론적 detector 로 스캔.

    high_entropy=True 면 find_secrets/pii 외에 키워드 없는 고엔트로피 토큰까지
    추가로 포착(github_scan 와 동일 탐지력). 기본 False — github/jenkins 호출부의
    노이즈 프로파일은 불변. 같은 span 을 이미 잡은 hit 이 있으면 중복 제외.
    """
    if include_document_signals:
        _ensure_document_sensitivity_detector()
    scanned: list[_ScannedArtifact] = []
    for artifact in artifacts:
        result = scan_text(
            artifact.text,
            label=artifact.label,
            include_document_signals=include_document_signals,
        )
        # v3.78 F1: metadata.suppress_emails(예: commit author 이메일)와 동일한 email hit 드랍.
        # v3.78.1: 단, 같은 줄에 다른 hit(secret 등)이 있으면 드랍 금지 — 노출 증거 보존.
        suppress = {
            str(e).strip().lower()
            for e in (artifact.metadata.get("suppress_emails") or [])
            if e
        }
        kept_hits = []
        for hit in result.hits:
            if (suppress and hit.category == "pii" and hit.kind == "email"
                    and artifact.text[hit.span[0]:hit.span[1]].strip().lower() in suppress
                    and not _other_hit_on_same_line(artifact.text, hit, result.hits)):
                continue
            kept_hits.append(hit)
        hits = [_hit_payload(artifact.text, hit) for hit in kept_hits]
        if high_entropy:
            taken = [hit.span for hit in result.hits]
            for he in find_high_entropy(artifact.text):
                if any(s <= he.span[0] < e for s, e in taken):
                    continue
                line_no = artifact.text.count("\n", 0, he.span[0]) + 1
                he_hit = Hit(
                    category="secret",
                    kind="high_entropy_string",
                    masked=mask_secret(he.matched),
                    line_no=line_no,
                    line_preview="",  # _hit_payload 가 _masked_preview 로 재계산
                    span=he.span,
                )
                hits.append(_hit_payload(artifact.text, he_hit))
        if not hits:
            continue
        scanned.append(_ScannedArtifact(
            artifact=artifact,
            hits=hits,
            bytes_scanned=result.bytes_scanned,
        ))
    return scanned


def _ensure_document_sensitivity_detector() -> None:
    mod_name = "_shared.detectors.document_sensitivity"
    if mod_name in sys.modules:
        return
    try:
        importlib.import_module(mod_name)
        return
    except ImportError:
        pass
    repo = Path(__file__).resolve().parents[4]
    path = repo / "_shared" / "detectors" / "document_sensitivity.py"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        return
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)


def _evidence_path(evidence_dir: Path, domain: str) -> Path:
    out_dir = Path(evidence_dir) / "service_task_scans"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / f"{domain}_task_scan_{uuid4().hex[:12]}.json"


def _write_evidence(
    *,
    evidence_dir: Path,
    domain: str,
    input_summary: dict[str, Any],
    scanned: list[_ScannedArtifact],
    errors: list[dict[str, Any]],
    findings: list[dict[str, Any]] | None = None,
    api_search: dict[str, Any] | None = None,
    scan_status: str | None = None,
    recommended_target_status: str | None = None,
    status_reason: str | None = None,
    targets: list[Any] | None = None,
    target_details: list[dict[str, Any]] | None = None,
    file_details: list[dict[str, Any]] | None = None,
    commit_details: list[dict[str, Any]] | None = None,
    pull_request_details: list[dict[str, Any]] | None = None,
    issue_details: list[dict[str, Any]] | None = None,
    compare_details: list[dict[str, Any]] | None = None,
    release_details: list[dict[str, Any]] | None = None,
    branch_details: list[dict[str, Any]] | None = None,
    tag_details: list[dict[str, Any]] | None = None,
    config_details: list[dict[str, Any]] | None = None,
    build_details: list[dict[str, Any]] | None = None,
    page_details: list[dict[str, Any]] | None = None,
    attachment_details: list[dict[str, Any]] | None = None,
    comment_details: list[dict[str, Any]] | None = None,
    version_details: list[dict[str, Any]] | None = None,
    out_path: Path | None = None,
    charter_ref: str = "",
) -> Path:
    out_path = out_path or _evidence_path(evidence_dir, domain)
    payload = {
        "kind": f"{domain}_task_scan_evidence",
        "created_at": time.time(),
        "input": input_summary,
        "scanned_count": len(scanned),
        "finding_count": len(findings or []),
        "errors": errors,
        "artifacts": [
            {
                "task_type": item.artifact.task_type,
                "asset": item.artifact.asset,
                "asset_kind": item.artifact.asset_kind,
                "label": item.artifact.label,
                "metadata": item.artifact.metadata,
                "bytes_scanned": item.bytes_scanned,
                "hits": item.hits,
            }
            for item in scanned
        ],
        "findings": findings or [],
    }
    if targets is not None:
        payload["target_count"] = len(targets)
        payload["targets"] = targets
    if target_details is not None:
        payload["target_details"] = target_details
    if file_details is not None:
        payload["file_details"] = file_details
    if commit_details is not None:
        payload["commit_details"] = commit_details
    if pull_request_details is not None:
        payload["pull_request_details"] = pull_request_details
    if issue_details is not None:
        payload["issue_details"] = issue_details
    if compare_details is not None:
        payload["compare_details"] = compare_details
    if release_details is not None:
        payload["release_details"] = release_details
    if branch_details is not None:
        payload["branch_details"] = branch_details
    if tag_details is not None:
        payload["tag_details"] = tag_details
    if config_details is not None:
        payload["config_details"] = config_details
    if build_details is not None:
        payload["build_details"] = build_details
    if page_details is not None:
        payload["page_details"] = page_details
    if attachment_details is not None:
        payload["attachment_details"] = attachment_details
    if comment_details is not None:
        payload["comment_details"] = comment_details
    if version_details is not None:
        payload["version_details"] = version_details
    if api_search is not None:
        payload["api_search"] = api_search
    if scan_status is not None:
        payload["scan_status"] = scan_status
    if recommended_target_status is not None:
        payload["recommended_target_status"] = recommended_target_status
    if scan_status is not None or recommended_target_status is not None or status_reason is not None:
        payload["status_reason"] = status_reason
    if charter_ref:
        payload["charter_ref"] = charter_ref
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return out_path


def _detail_status_counts(*detail_groups: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for group in detail_groups:
        for detail in group:
            status = str(detail.get("status") or "unknown").strip() or "unknown"
            counts[status] = counts.get(status, 0) + 1
    return counts


def _detail_status_by_kind(**detail_groups: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for kind, group in detail_groups.items():
        counts = _detail_status_counts(group)
        if counts:
            out[kind] = counts
    return out


def _detail_source_counts(*detail_groups: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for group in detail_groups:
        for detail in group:
            source = _detail_source_key(detail)
            counts[source] = counts.get(source, 0) + 1
    return counts


def _detail_status_by_source(*detail_groups: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for group in detail_groups:
        for detail in group:
            source = _detail_source_key(detail)
            status = str(detail.get("status") or "unknown").strip() or "unknown"
            counts = out.setdefault(source, {})
            counts[status] = counts.get(status, 0) + 1
    return out


def _detail_source_key(detail: dict[str, Any]) -> str:
    return str(detail.get("candidate_source") or "unknown").strip() or "unknown"


def _artifact_source_key(artifact: _Artifact) -> str:
    return str(artifact.metadata.get("candidate_source") or "unknown").strip() or "unknown"


def _scan_outcome_summary(
    artifacts: list[_Artifact],
    scanned: list[_ScannedArtifact],
) -> dict[str, Any]:
    artifact_source_counts: dict[str, int] = {}
    hit_source_counts: dict[str, int] = {}
    hit_count_by_source: dict[str, int] = {}
    hit_category_counts: dict[str, int] = {}
    hit_kind_counts: dict[str, int] = {}
    reportable_source_counts: dict[str, int] = {}
    hit_count = 0
    reportable = 0
    low_value_only = 0
    for artifact in artifacts:
        source = _artifact_source_key(artifact)
        artifact_source_counts[source] = artifact_source_counts.get(source, 0) + 1
    for item in scanned:
        source = _artifact_source_key(item.artifact)
        hits = item.hits
        hit_source_counts[source] = hit_source_counts.get(source, 0) + 1
        hit_count_by_source[source] = hit_count_by_source.get(source, 0) + len(hits)
        hit_count += len(hits)
        if is_low_value_only(hits):
            low_value_only += 1
        else:
            reportable += 1
            reportable_source_counts[source] = reportable_source_counts.get(source, 0) + 1
        for hit in hits:
            category = str(hit.get("category") or "unknown").strip() or "unknown"
            kind = str(hit.get("kind") or "unknown").strip() or "unknown"
            hit_category_counts[category] = hit_category_counts.get(category, 0) + 1
            hit_kind_counts[kind] = hit_kind_counts.get(kind, 0) + 1
    return {
        "artifact_count": len(artifacts),
        "artifact_source_counts": artifact_source_counts,
        "hit_artifact_count": len(scanned),
        "hit_source_counts": hit_source_counts,
        "hit_count": hit_count,
        "hit_count_by_source": hit_count_by_source,
        "hit_category_counts": hit_category_counts,
        "hit_kind_counts": hit_kind_counts,
        "reportable_artifact_count": reportable,
        "reportable_source_counts": reportable_source_counts,
        "low_value_only_artifact_count": low_value_only,
    }


def _finding_source_key(finding: dict[str, Any]) -> str:
    return str(finding.get("candidate_source") or "unknown").strip() or "unknown"


def _bool_count_key(value: Any) -> str:
    return "true" if bool(value) else "false"


def _finding_lifecycle_summary(findings: list[dict[str, Any]]) -> dict[str, Any]:
    status_counts: dict[str, int] = {}
    source_counts: dict[str, int] = {}
    status_by_source: dict[str, dict[str, int]] = {}
    report_updated_counts: dict[str, int] = {}
    report_updated_by_source: dict[str, dict[str, int]] = {}
    followup_signal_counts: dict[str, int] = {}
    created = 0
    for finding in findings:
        if finding.get("created"):
            created += 1
        status = str(finding.get("status") or "unknown").strip() or "unknown"
        source = _finding_source_key(finding)
        report_key = _bool_count_key(finding.get("report_updated"))
        signal_key = _bool_count_key(finding.get("followup_signal_emitted"))
        status_counts[status] = status_counts.get(status, 0) + 1
        source_counts[source] = source_counts.get(source, 0) + 1
        status_source = status_by_source.setdefault(source, {})
        status_source[status] = status_source.get(status, 0) + 1
        report_updated_counts[report_key] = report_updated_counts.get(report_key, 0) + 1
        report_source = report_updated_by_source.setdefault(source, {})
        report_source[report_key] = report_source.get(report_key, 0) + 1
        followup_signal_counts[signal_key] = followup_signal_counts.get(signal_key, 0) + 1
    return {
        "total": len(findings),
        "created_count": created,
        "existing_count": len(findings) - created,
        "status_counts": status_counts,
        "source_counts": source_counts,
        "status_by_source": status_by_source,
        "report_updated_counts": report_updated_counts,
        "report_updated_by_source": report_updated_by_source,
        "followup_signal_counts": followup_signal_counts,
    }


def _target_status_key(target: dict[str, Any]) -> str:
    return str(target.get("status") or "selected").strip() or "selected"


def _target_source_key(target: dict[str, Any]) -> str:
    return str(
        target.get("source")
        or target.get("candidate_source")
        or "unknown"
    ).strip() or "unknown"


def _target_status_counts(target_details: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for target in target_details:
        status = _target_status_key(target)
        counts[status] = counts.get(status, 0) + 1
    return counts


def _target_source_counts(target_details: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for target in target_details:
        source = _target_source_key(target)
        counts[source] = counts.get(source, 0) + 1
    return counts


def _target_status_by_source(target_details: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for target in target_details:
        source = _target_source_key(target)
        status = _target_status_key(target)
        counts = out.setdefault(source, {})
        counts[status] = counts.get(status, 0) + 1
    return out


def _query_status_counts(query_details: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for detail in query_details:
        status = str(detail.get("status") or "unknown").strip() or "unknown"
        counts[status] = counts.get(status, 0) + 1
    return counts


def _query_candidate_totals(query_details: list[dict[str, Any]]) -> dict[str, int]:
    if not query_details:
        return {}
    fields = ("returned", "added", "invalid", "out_of_scope", "duplicate", "skipped")
    totals = {field: 0 for field in fields}
    for detail in query_details:
        for field in fields:
            try:
                totals[field] += int(detail.get(field) or 0)
            except (TypeError, ValueError):
                continue
    return totals


def _fallback_attempt_status(attempt: dict[str, Any]) -> str:
    if attempt.get("error") or attempt.get("phase"):
        return "error"
    if str(attempt.get("skipped") or "") == "max_pages_reached":
        return "skipped"
    return "searched"


def _fallback_status_counts(fallback_attempts: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for attempt in fallback_attempts:
        status = _fallback_attempt_status(attempt)
        counts[status] = counts.get(status, 0) + 1
    return counts


def _fallback_reason_counts(fallback_attempts: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for attempt in fallback_attempts:
        reason = str(attempt.get("reason") or "unknown").strip() or "unknown"
        counts[reason] = counts.get(reason, 0) + 1
    return counts


def _fallback_candidate_totals(fallback_attempts: list[dict[str, Any]]) -> dict[str, int]:
    if not fallback_attempts:
        return {}
    fields = (
        "returned",
        "selected",
        "added",
        "invalid",
        "out_of_scope",
        "duplicate",
        "limit_skipped",
        "skipped",
    )
    totals = {field: 0 for field in fields}
    for attempt in fallback_attempts:
        for field in fields:
            try:
                totals[field] += int(attempt.get(field) or 0)
            except (TypeError, ValueError):
                continue
    return totals


def _detail_query_key(detail: dict[str, Any]) -> str:
    query = str(detail.get("candidate_query") or "").strip()
    return query or "(no query)"


def _detail_query_counts(*detail_groups: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for group in detail_groups:
        for detail in group:
            query = _detail_query_key(detail)
            counts[query] = counts.get(query, 0) + 1
    return counts


def _detail_status_by_query(*detail_groups: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for group in detail_groups:
        for detail in group:
            query = _detail_query_key(detail)
            status = str(detail.get("status") or "unknown").strip() or "unknown"
            counts = out.setdefault(query, {})
            counts[status] = counts.get(status, 0) + 1
    return out


def _detail_error_summary(detail_errors: list[dict[str, Any]]) -> dict[str, Any]:
    by_phase: dict[str, int] = {}
    by_source: dict[str, int] = {}
    by_query: dict[str, int] = {}
    by_status_code: dict[str, int] = {}
    for err in detail_errors:
        phase = str(err.get("phase") or "unknown").strip() or "unknown"
        by_phase[phase] = by_phase.get(phase, 0) + 1
        source = _detail_source_key(err)
        by_source[source] = by_source.get(source, 0) + 1
        query = _detail_query_key(err)
        by_query[query] = by_query.get(query, 0) + 1
        status_code = err.get("status_code")
        if status_code is None:
            continue
        key = str(status_code)
        by_status_code[key] = by_status_code.get(key, 0) + 1
    return {
        "total": len(detail_errors),
        "by_phase": by_phase,
        "by_source": by_source,
        "by_query": by_query,
        "by_status_code": by_status_code,
    }


def _confluence_asset_space_key(asset: str) -> str:
    parts = str(asset or "").split(":", 2)
    if len(parts) < 3 or parts[0] != "confluence":
        return ""
    return parts[1].strip()


def _confluence_space_error_status(detail: dict[str, Any]) -> str:
    if (
        _error_has_http_status(detail, {403, 404})
        and not detail.get("limit_failed")
    ):
        return "skipped"
    return "error"


def _confluence_space_target_statuses(
    *,
    space_keys: list[str],
    target_details: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    detail_groups: tuple[list[dict[str, Any]], ...],
) -> dict[str, dict[str, Any]]:
    """Summarize a batched space scan as per-space terminal recommendations."""
    ordered_spaces: list[str] = []
    seen: set[str] = set()
    for raw in space_keys:
        space_key = str(raw or "").strip()
        key = space_key.lower()
        if not space_key or key in seen:
            continue
        ordered_spaces.append(space_key)
        seen.add(key)

    finding_counts: dict[str, int] = {}
    for finding in findings:
        space_key = _confluence_asset_space_key(str(finding.get("asset") or ""))
        if not space_key:
            continue
        finding_counts[space_key.lower()] = finding_counts.get(space_key.lower(), 0) + 1

    selected_spaces: set[str] = set()
    target_errors: dict[str, dict[str, Any]] = {}
    for detail in target_details:
        space_key = str(detail.get("space_key") or "").strip()
        if not space_key:
            continue
        key = space_key.lower()
        status = str(detail.get("status") or "").strip()
        if detail.get("id") and status not in {"error", "skipped"}:
            selected_spaces.add(key)
            continue
        if status in {"error", "skipped"}:
            target_errors.setdefault(key, detail)

    detail_statuses: dict[str, list[dict[str, Any]]] = {}
    for group in detail_groups:
        for detail in group:
            space_key = str(detail.get("space_key") or "").strip()
            if not space_key:
                continue
            detail_statuses.setdefault(space_key.lower(), []).append(detail)

    out: dict[str, dict[str, Any]] = {}
    for space_key in ordered_spaces:
        key = space_key.lower()
        finding_count = finding_counts.get(key, 0)
        statuses = detail_statuses.get(key, [])
        fetched = any(
            str(detail.get("status") or "").strip() in {"fetched", "same_as_current"}
            or detail.get("content_present") is True
            for detail in statuses
        )
        failed_details = [
            detail for detail in statuses
            if str(detail.get("status") or "").strip() in {"error", "missing", "empty"}
        ]
        if finding_count > 0 or fetched:
            out[space_key] = {
                "status": "tasked",
                "finding_count": finding_count,
                "reason": f"space scan completed; findings={finding_count}",
            }
            continue
        if failed_details:
            first = failed_details[0]
            first_reason = str(first.get("error") or "").strip()
            if not first_reason and str(first.get("status") or "").strip() in {"missing", "empty"}:
                first_reason = "detail fetch returned no content"
            out[space_key] = {
                "status": _confluence_space_error_status(first),
                "finding_count": 0,
                "reason": (first_reason or "detail fetch failed")[:500],
            }
            continue
        if key in selected_spaces:
            out[space_key] = {
                "status": "tasked",
                "finding_count": 0,
                "reason": "space scan completed; findings=0",
            }
            continue
        target_error = target_errors.get(key)
        if target_error:
            out[space_key] = {
                "status": _confluence_space_error_status(target_error),
                "finding_count": 0,
                "reason": str(target_error.get("error") or "target scan failed")[:500],
            }
            continue
        out[space_key] = {
            "status": "tasked",
            "finding_count": 0,
            "reason": "space scan completed; findings=0",
        }
    return out


async def _persist_scanned_findings(
    *,
    context: ToolContext,
    source_tool: str,
    scanned: list[_ScannedArtifact],
    evidence_ref: Path,
    register: bool = True,
) -> list[dict[str, Any]]:
    """스캔 결과를 finding 으로 **등록**하거나(register=True) 후보로만 돌려준다.

    ## register=False 가 왜 있나 (2026-08-27)

    github finding 등록 경로는 셋인데 LLM 이 결정하는 것은 하나뿐이었다:

        ① scanner._persist_scan_findings   결정론 스캔        (호출부 제거됨)
        ② 이 함수(github_task_scan)         스캔 도구가 자동 등록  ← 여기
        ③ github_submit_finding            **에이전트가 결정**

    ②는 도구가 자기가 찾은 것을 그대로 DB 에 넣는다. 에이전트는 결과를 통보받을 뿐
    판단하지 않는다. 그래서 `high_entropy_string` 6,850건 같은 것이 그대로 등록됐다
    (오늘 github finding 27,414건 중 판정을 거친 것은 7건뿐이었다).

    사용자 결정: **모든 finding 은 등록 전에 LLM 판정을 타야 한다.**
    그래서 github 은 `register=False` 로 부른다 — 이 함수는 후보만 돌려주고,
    실제 등록은 에이전트가 `github_submit_finding` 을 부를 때 일어난다.

    ⚠️ 도구셋 주석(`github_scan_tools`)은 이미 "finding 은 반드시
      `github_submit_finding` 으로 낸다" 고 적어 뒀는데 코드가 안 따라오고 있었다.
      계약과 코드가 어긋난 자리였다.
    """
    findings: list[dict[str, Any]] = []
    for item in scanned:
        artifact = item.artifact
        metadata = _public_metadata(artifact.metadata)
        verification = _confluence_initial_verification(artifact, item.hits)
        # v3.78 F1: 이메일/식별자-only PII 노이즈는 finding 생성 안 함 (secret·고가치 PII 동반은 유지).
        # service_task 경로(github/jenkins/confluence)는 submit_finding 의 judge 를 안 거치므로
        # 동일 판정을 여기서 직접 적용한다.
        if is_low_value_only(item.hits):
            continue
        # github 시크릿 정오탐 게이트. `is_low_value_only` 는 pii 아닌 category 가 하나라도
        # 있으면 무조건 통과시키므로 category='secret' 인 generic key-name 오탐(코드/문서의
        # password 변수·shell 명령치환·플레이스홀더)을 전혀 못 막는다. 실측 정밀도 2.6%
        # (진짜 4 / 오탐 149) 였고 그 오탐이 전부 이 경로(source='github_task_scan')로 들어왔다.
        # ⚠️ github 한정 — confluence 는 근거가 위키 본문이라 같은 규칙을 먹이면 전량 제외된다.
        if artifact.task_type == "github" and not _github_secret_gate_pass(artifact, item.hits):
            continue
        severity = _severity_for_hits(item.hits)
        confidence = _confidence_for_hits(item.hits)
        actions = _recommended_actions(artifact.task_type, artifact.asset_kind)
        agent_verification = make_agent_verification(
            method=f"{artifact.task_type}_service_task_scan",
            source=source_tool,
            checks=(
                "candidate_detail_collected",
                "detector_hits_present",
                "low_value_noise_filtered",
            ),
            details={
                "asset_kind": artifact.asset_kind,
                "hit_count": len(item.hits),
                "candidate_source": metadata.get("candidate_source"),
                "scan_method": metadata.get("scan_method"),
            },
        )
        summary = (
            f"{len(item.hits)} detector hit(s) in {artifact.asset_kind}: "
            f"{artifact.label}"
        )
        if not register:
            # ★ 등록하지 않는다. lifecycle 전이·enrichment·follow-up 신호는 finding_id 를
            #   쓰므로 **하지 않는다** — 에이전트가 제출할 때 일어난다.
            #
            # ⚠️ 다만 `verification`(github HEAD 재확인 = live_in_HEAD 인가)은 **붙인다.**
            #    이건 finding_id 가 필요 없는 순수 계산이고, 에이전트가 "지금도 살아 있는
            #    노출인가 vs 과거 커밋에만 있는가" 를 가르는 **바로 그 신호**다.
            #    빼면 후보만 주고 판단 재료는 뺏는 꼴이 된다.
            head_check = None
            if artifact.task_type == "github":
                try:
                    from domains.services.github.plugin import github_verify

                    head_check = await asyncio.wait_for(
                        asyncio.to_thread(
                            github_verify.verify_github_finding,
                            artifact.asset_kind, artifact.metadata, item.hits,
                        ),
                        timeout=8.0,
                    )
                except Exception:  # noqa: BLE001 — 확인 실패가 후보 자체를 죽이지 않는다
                    head_check = None
            findings.append({
                "id": None,
                "created": False,
                "registered": False,
                "task_type": artifact.task_type,
                "asset": artifact.asset,
                "asset_kind": artifact.asset_kind,
                "candidate_source": str(metadata.get("candidate_source") or "unknown"),
                "scan_method": str(metadata.get("scan_method") or ""),
                # 스캔 문맥(ref·scan_method·candidate_source…). 에이전트가 "어디를 어떻게
                # 봤나" 를 알아야 제출/기각을 판단한다 — 빼면 후보만 주고 맥락은 뺏는다.
                "metadata": metadata,
                "severity": severity,
                "status": "candidate",
                "confidence": confidence,
                "summary": summary,
                "hits": item.hits,
                "hit_count": len(item.hits),
                "evidence_ref": str(evidence_ref),
                "recommended_actions": actions,
                **({"verification": head_check} if head_check else {}),
                **({"verification": verification} if verification and not head_check else {}),
                "next": (f"실제 노출이면 {artifact.task_type}_submit_finding 으로 제출하고, "
                         f"아니면 기각 사유를 남겨라 — 이 도구는 등록하지 않는다."),
            })
            continue

        finding_id, created = state.finding_upsert(
            task_type=artifact.task_type,
            asset=artifact.asset,
            asset_kind=artifact.asset_kind,
            severity=severity,
            summary=summary,
            evidence_ref=str(evidence_ref),
            extra=with_agent_provenance({
                "source": source_tool,
                "confidence": confidence,
                "recommended_actions": actions,
                "hits": item.hits,
                "metadata": metadata,
                **({"verification": verification} if verification else {}),
                "agent_verification": agent_verification,
                "report_updated": True,
            }, context.metadata),
        )
        finding_row = state.finding_get(finding_id) or {}
        lifecycle_status = str(finding_row.get("status") or "open")
        report_updated = True
        emit_followup_signal = True
        if artifact.task_type in {"github", "confluence"} and lifecycle_status == "remediated":
            state.finding_set_status(
                finding_id,
                "open",
                reason=f"{artifact.task_type} scan reobserved active exposure",
            )
            lifecycle_status = "open"
        elif artifact.task_type in {"github", "confluence"} and lifecycle_status in {
            "false_positive",
            "accepted_risk",
        }:
            report_updated = False
            emit_followup_signal = False
            state.finding_update(
                finding_id,
                extra={
                    "report_updated": False,
                    "report_skip_reason": f"lifecycle status {lifecycle_status}",
                },
                merge_extra=True,
            )
        # de-domain: finding enrichment(구 pivot — 라이브 내부 표면 GET probe)은 등록형.
        # 코어 seam(run_finding_enrichers)만 호출; 도메인 pivot 은 _shared/pivot.py 가
        # plugin/bootstrap._bind_pivot_and_register 로 등록. record-only, fail-open.
        pivot_exposed = 0
        try:
            from secu_agent.agent.finding_enrichment import (
                ENRICHMENT_META_KEYS, run_finding_enrichers,
            )

            enrichments = await asyncio.to_thread(
                run_finding_enrichers,
                asset=artifact.asset, summary=summary, hits=item.hits,
            )
            for enr in enrichments:
                slot = str(enr.get("slot") or "pivot")
                payload = enr.get("payload")
                if payload is None:
                    payload = {k: v for k, v in enr.items()
                               if k not in ENRICHMENT_META_KEYS} or enr
                state.finding_attach_enrichment(finding_id, payload, slot=slot)
                pivot_exposed += int(
                    enr.get("signal_count", enr.get("exposed_count", 0)) or 0
                )
        except Exception:
            pivot_exposed = 0
        # v3.78 G2: github secret hit HEAD 재확인 (record-only, GET) — live_in_HEAD/
        # historical_only/gone 를 extra['verification'] 에 기록. 브라우저 SSO 교차확인은
        # agent 가 web_site_sweep 로 (skill 가이드) — 여기선 코드 결정 가능한 API 재확인만.
        if artifact.task_type == "github":
            try:
                from domains.services.github.plugin import github_verify

                # v3.78.1: 행 GHES contents endpoint 가 스캔 전체를 멈추지 않게 총시간 상한.
                verification = await asyncio.wait_for(
                    asyncio.to_thread(
                        github_verify.verify_github_finding,
                        artifact.asset_kind, artifact.metadata, item.hits,
                    ),
                    timeout=8.0,
                )
                if verification:
                    state.finding_update(
                        finding_id, extra={"verification": verification}, merge_extra=True,
                    )
            except Exception:
                pass
        finding = {
            "id": finding_id,
            "created": created,
            "task_type": artifact.task_type,
            "asset": artifact.asset,
            "asset_kind": artifact.asset_kind,
            "candidate_source": str(metadata.get("candidate_source") or "unknown"),
            "scan_method": str(metadata.get("scan_method") or ""),
            "severity": severity,
            "status": lifecycle_status,
            "report_updated": report_updated,
            "followup_signal_emitted": emit_followup_signal,
            "confidence": confidence,
            "summary": summary,
            "hit_count": len(item.hits),
            "evidence_ref": str(evidence_ref),
            "recommended_actions": actions,
        }
        if not report_updated:
            finding["report_skip_reason"] = f"lifecycle status {lifecycle_status}"
        findings.append(finding)
        if emit_followup_signal:
            append_finding_signal(
                context.metadata,
                FindingSignal(
                    source_tool=source_tool,
                    task_type=artifact.task_type,
                    asset=artifact.asset,
                    asset_kind=artifact.asset_kind,
                    severity=severity,
                    status="confirmed",
                    confidence=confidence,
                    finding_id=finding_id,
                    evidence_ref=str(evidence_ref),
                    summary=summary,
                    recommended_actions=tuple(actions),
                    report_updated=report_updated,
                    pivot_exposed=pivot_exposed,
                ),
            )
    return findings


def _payload(
    *,
    kind: str,
    evidence_ref: Path,
    target_count: int,
    artifacts_scanned: int,
    findings: list[dict[str, Any]],
    errors: list[dict[str, Any]],
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # 후보만 돌려주는 경로가 하나라도 있으면 계약 문구를 바꾼다 — 아래 주석 참조.
    candidates_only = any(not f.get("registered", True) for f in findings)
    return {
        "kind": kind,
        "evidence_ref": str(evidence_ref),
        "target_count": target_count,
        "artifacts_scanned": artifacts_scanned,
        "finding_count": len(findings),
        "findings": findings,
        "errors": errors,
        # ⚠️ 문구는 `registered` 값을 따라간다. 예전엔 이 도구가 항상 적재해서 "already
        #    upserted" 가 참이었지만, 후보만 돌려주는 경로(github)에서는 거짓말이 된다 —
        #    워커가 "이미 등록됐다" 고 믿으면 제출을 안 한다.
        "reporting_contract": (
            (
                "Findings in this payload were scanned with deterministic detectors "
                "and already upserted into the normalized domain report state. "
            ) if not candidates_only else (
                "These are CANDIDATES ONLY — nothing was written to the report state. "
                "You must judge each one and submit the real ones with the domain "
                "submit_finding tool, or dismiss them with triage_candidates. "
            )
        ) + (
            "Use todo for validation, impact deep-dive, owner/ticket follow-up, "
            "or blocked/cancelled rationale when no follow-up is valid."
        ),
        **(extra or {}),
    }


def _scan_status_from_errors(
    *,
    errors: list[dict[str, Any]],
    artifacts_scanned: int,
    api_search: dict[str, Any] | None = None,
) -> tuple[str, str, str | None]:
    fatal_candidate_phases = {
        "code_search_candidate",
        "cql_candidate",
        "page_candidate",
        "space_candidate",
        "file_candidate",
        "directory_candidate",
        "recent_commit_patch_candidate",
        "pull_request_candidate",
        "issue_candidate",
        "compare_candidate",
        "release_candidate",
        "tag_candidate",
        "attachment_candidate",
        "page_version_candidate",
        "blob_candidate",
        "repo_candidate",
        "commit_candidate",
        "job_candidate",
        "build_candidate",
    }
    if not errors:
        if api_search:
            try:
                candidate_count = int(api_search.get("candidate_count") or 0)
                file_path_count = int(api_search.get("file_path_count") or 0)
                directory_path_count = int(api_search.get("directory_path_count") or 0)
                commit_count = int(api_search.get("commit_count") or 0)
                commit_list_count = int(api_search.get("commit_list_count") or 0)
                pull_request_count = int(api_search.get("pull_request_count") or 0)
                issue_count = int(api_search.get("issue_count") or 0)
                compare_count = int(api_search.get("compare_count") or 0)
                release_count = int(api_search.get("release_count") or 0)
                branch_count = int(api_search.get("branch_count") or 0)
                tag_count = int(api_search.get("tag_count") or 0)
                page_list_count = int(api_search.get("page_list_count") or 0)
                blogpost_list_count = int(api_search.get("blogpost_list_count") or 0)
                attachment_list_count = int(api_search.get("attachment_list_count") or 0)
                list_no_candidates = int(api_search.get("list_no_candidates") or 0)
                detail_fetched = int(api_search.get("detail_fetched") or 0)
                detail_missing = int(api_search.get("detail_missing") or 0)
                out_of_scope_count = int(api_search.get("out_of_scope_count") or 0)
                fallback_count = int(
                    api_search.get("fallback_hot_path_tree")
                    or api_search.get("fallback_list_pages")
                    or 0
                )
            except (TypeError, ValueError):
                candidate_count = file_path_count = directory_path_count = 0
                commit_count = commit_list_count = pull_request_count = issue_count = compare_count = 0
                release_count = branch_count = tag_count = 0
                page_list_count = blogpost_list_count = attachment_list_count = 0
                list_no_candidates = 0
                detail_fetched = detail_missing = out_of_scope_count = fallback_count = 0
            candidate_sources = api_search.get("candidate_sources") or {}
            if not isinstance(candidate_sources, dict):
                candidate_sources = {}
            detail_status_counts = api_search.get("detail_status_counts") or {}
            if not isinstance(detail_status_counts, dict):
                detail_status_counts = {}
            target_status_counts = api_search.get("target_status_counts") or {}
            if not isinstance(target_status_counts, dict):
                target_status_counts = {}
            try:
                detail_skipped = int(detail_status_counts.get("skipped") or 0)
                detail_status_total = sum(
                    int(count or 0) for count in detail_status_counts.values()
                )
            except (TypeError, ValueError):
                detail_skipped = detail_status_total = 0
            try:
                target_skipped = int(target_status_counts.get("skipped") or 0)
                target_status_total = sum(
                    int(count or 0) for count in target_status_counts.values()
                )
            except (TypeError, ValueError):
                target_skipped = target_status_total = 0
            try:
                explicit_page_count = int(candidate_sources.get("explicit_page") or 0)
                explicit_comment_count = int(candidate_sources.get("explicit_comment") or 0)
                explicit_page_version_count = int(candidate_sources.get("explicit_page_version") or 0)
                explicit_attachment_count = int(candidate_sources.get("explicit_attachment") or 0)
                page_body_none_missing = int(api_search.get("page_body_none_missing") or 0)
            except (TypeError, ValueError):
                explicit_page_count = explicit_comment_count = explicit_page_version_count = explicit_attachment_count = page_body_none_missing = 0
            explicit_confluence_detail_count = (
                explicit_comment_count
                + explicit_page_version_count
                + explicit_attachment_count
            )
            if (
                candidate_count > 0
                and candidate_count == explicit_page_count
                and page_body_none_missing == candidate_count
                and detail_fetched == 0
                and artifacts_scanned == 0
            ):
                return (
                    "skipped",
                    "skipped",
                    f"explicit Confluence page target not found (missing={page_body_none_missing})"[:500],
                )
            if (
                (
                    candidate_count > 0
                    or file_path_count > 0
                    or directory_path_count > 0
                    or commit_count > 0
                    or commit_list_count > 0
                    or pull_request_count > 0
                    or issue_count > 0
                    or compare_count > 0
                    or release_count > 0
                    or branch_count > 0
                    or tag_count > 0
                    or page_list_count > 0
                    or blogpost_list_count > 0
                    or attachment_list_count > 0
                    or fallback_count > 0
                    or explicit_confluence_detail_count > 0
                    or list_no_candidates > 0
                )
                and detail_fetched == 0
                and detail_missing == 0
                and out_of_scope_count > 0
                and artifacts_scanned == 0
            ):
                return (
                    "skipped",
                    "skipped",
                    (
                        "Candidate search/fallback/file/directory/commit/PR/issue/compare scan returned "
                        "only out-of-scope targets "
                        f"(out_of_scope={out_of_scope_count})"
                    )[:500],
                )
            if (
                candidate_count == 0
                and detail_fetched == 0
                and detail_missing == 0
                and out_of_scope_count == 0
                and target_skipped > 0
                and target_status_total == target_skipped
                and artifacts_scanned == 0
            ):
                return (
                    "skipped",
                    "skipped",
                    (
                        "Candidate search/fallback/file/directory/commit/PR/issue/compare scan returned "
                        "no selected targets "
                        f"(skipped={target_skipped})"
                    )[:500],
                )
            if (
                (
                    candidate_count > 0
                    or file_path_count > 0
                    or directory_path_count > 0
                    or commit_count > 0
                    or commit_list_count > 0
                    or pull_request_count > 0
                    or issue_count > 0
                    or compare_count > 0
                    or release_count > 0
                    or branch_count > 0
                    or tag_count > 0
                    or page_list_count > 0
                    or blogpost_list_count > 0
                    or attachment_list_count > 0
                    or fallback_count > 0
                    or explicit_confluence_detail_count > 0
                    or list_no_candidates > 0
                )
                and detail_fetched == 0
                and detail_missing == 0
                and out_of_scope_count == 0
                and detail_skipped > 0
                and detail_status_total == detail_skipped
                and artifacts_scanned == 0
            ):
                return (
                    "skipped",
                    "skipped",
                    (
                        "Candidate search/fallback/file/directory/commit/PR/issue/compare scan returned "
                        "only skipped targets "
                        f"(skipped={detail_skipped})"
                    )[:500],
                )
            if (
                (
                    candidate_count > 0
                    or file_path_count > 0
                    or directory_path_count > 0
                    or commit_count > 0
                    or commit_list_count > 0
                    or pull_request_count > 0
                    or issue_count > 0
                    or compare_count > 0
                    or release_count > 0
                    or branch_count > 0
                    or tag_count > 0
                    or page_list_count > 0
                    or blogpost_list_count > 0
                    or attachment_list_count > 0
                    or fallback_count > 0
                    or explicit_confluence_detail_count > 0
                )
                and detail_fetched == 0
                and detail_missing > 0
                and artifacts_scanned == 0
            ):
                return (
                    "error",
                    "error",
                    (
                        "Candidate search/fallback/file/directory/commit/PR/issue/compare scan returned targets but detail fetch returned "
                        "no content "
                        f"(candidates={candidate_count}, files={file_path_count}, directories={directory_path_count}, "
                        f"commits={commit_count}, commit_lists={commit_list_count}, prs={pull_request_count}, "
                        f"issues={issue_count}, compares={compare_count}, releases={release_count}, "
                        f"branches={branch_count}, tags={tag_count}, page_lists={page_list_count}, "
                        f"blogposts={blogpost_list_count}, attachments={attachment_list_count}, "
                        f"fallback={fallback_count}, "
                        f"confluence_exact={explicit_confluence_detail_count}, "
                        f"missing={detail_missing})"
                    )[:500],
                )
            if detail_missing > 0:
                return "partial", "tasked", f"partial detail missing={detail_missing}"[:500]
        return "ok", "tasked", None
    skip_candidate = next(
        (
            err for err in errors
            if str(err.get("phase") or "") == "repo_meta"
            and "repo metadata not found" in str(err.get("error") or "")
        ),
        None,
    )
    if skip_candidate is not None and artifacts_scanned == 0:
        first_error = str(skip_candidate.get("error") or skip_candidate)
        return "skipped", "skipped", first_error[:500]
    if api_search and api_search.get("limit_failed") and artifacts_scanned == 0:
        first_error = str(errors[0].get("error") or errors[0])
        return "error", "error", first_error[:500]
    confluence_explicit_page_errors = [
        err for err in errors
        if str(err.get("phase") or "") == "fetch_page_body"
        and str(err.get("candidate_source") or "") == "explicit_page"
        and not err.get("limit_failed")
        and _error_has_http_status(err, {403, 404})
    ]
    if (
        confluence_explicit_page_errors
        and len(confluence_explicit_page_errors) == len(errors)
        and artifacts_scanned == 0
    ):
        first_error = str(
            confluence_explicit_page_errors[0].get("error")
            or confluence_explicit_page_errors[0]
        )
        return "skipped", "skipped", first_error[:500]
    confluence_target_errors = [
        err for err in errors
        if str(err.get("phase") or "") in {"cql_search", "list_pages"}
        and not err.get("limit_failed")
        and _error_has_http_status(err, {403, 404})
    ]
    if (
        confluence_target_errors
        and len(confluence_target_errors) == len(errors)
        and artifacts_scanned == 0
    ):
        first_error = str(confluence_target_errors[0].get("error") or confluence_target_errors[0])
        return "skipped", "skipped", first_error[:500]
    fatal_candidate = next(
        (err for err in errors if str(err.get("phase") or "") in fatal_candidate_phases),
        None,
    )
    if fatal_candidate is not None:
        first_error = str(fatal_candidate.get("error") or fatal_candidate)
        return "error", "error", first_error[:500]
    if artifacts_scanned > 0:
        first = str(errors[0].get("target") or errors[0].get("error") or "partial scan error")
        return "partial", "tasked", f"partial scan errors; first={first}"[:500]
    first_error = str(errors[0].get("error") or errors[0])
    return "error", "error", first_error[:500]


class GithubTaskScanInput(BaseModel):
    org: str | None = Field(default=None, description="GitHub org to enumerate.")
    repos: list[str] = Field(default_factory=list, description="Explicit owner/name repos.")
    repo_limit: int = Field(default=20, ge=1, le=100)
    ref: str | None = Field(default=None, description="Branch/ref. Defaults to repo default_branch.")
    # ⚠️ 2026-08-22 은퇴 — 워커 안에서 켜지 마라.
    # GitHub **전역 검색은 discovery 배치의 것**이다(`run_search_discovery_pass`,
    # `--search-sync`). 실전 간격이 키워드당 30초이고(`SA_GH_SEARCH_SPACING_SEC=30`,
    # `MAX_WAIT_SEC=240`) secondary rate limit 은 1/2/4초 백오프로 못 넘는다 —
    # 21키워드 중 12개가 403 이었다가 30초 간격으로 11/12 로 회복된 실측이 있다.
    # 그 백오프를 idle 상한 300초짜리 검토원 안에서 돌리면 **매번 죽는다**
    # (실측 2026-08-22: `github_task_scan` 이 300.3초 무활동으로 런을 통째로 abort).
    # 워커는 hot-path 열거로 간다 — 그건 검색 API 를 안 쓴다.
    api_search_first: bool = Field(
        default=False,
        description=(
            "DEPRECATED — 항상 False 로 둔다. 전역 code_search 는 discovery 경로의 "
            "것이고 워커 안에서는 rate-limit 백오프가 idle 상한을 넘겨 런을 죽인다."
        ),
    )
    code_search_terms: list[str] = Field(
        default_factory=lambda: list(_DEFAULT_GITHUB_CODE_SEARCH_TERMS),
        description="Terms used for API code search candidate selection.",
    )
    code_search_limit_per_query: int = Field(default=50, ge=1, le=100)
    max_candidate_files: int = Field(default=80, ge=1, le=500)
    hot_paths: list[str] = Field(default_factory=lambda: list(_DEFAULT_GITHUB_HOT_PATHS))
    max_files_per_repo: int = Field(default=12, ge=1, le=50)
    commit_shas: list[str] = Field(
        default_factory=list,
        description="Explicit commit SHA candidates to fetch by API before broad history fallback.",
    )
    include_commit_list: bool = Field(
        default=False,
        description="Fetch a bounded recent commit list by API and inspect commit patch details.",
    )
    file_paths: list[str] = Field(
        default_factory=list,
        description="Explicit repo-relative file paths to fetch by API before broad fallback.",
    )
    directory_paths: list[str] = Field(
        default_factory=list,
        description="Explicit repo-relative directory paths to list by API before broad fallback.",
    )
    pull_numbers: list[int] = Field(
        default_factory=list,
        description="Explicit pull request numbers to fetch by API before broad fallback.",
    )
    include_pull_requests: bool = Field(
        default=False,
        description="Fetch a bounded pull request list by API and inspect PR file patch details.",
    )
    pull_request_limit: int = Field(default=20, ge=1, le=100)
    issue_numbers: list[int] = Field(
        default_factory=list,
        description="Explicit issue numbers to fetch by API before broad fallback.",
    )
    include_issues: bool = Field(
        default=False,
        description="Fetch a bounded issue list by API and inspect issue body/comment details.",
    )
    issue_limit: int = Field(default=20, ge=1, le=100)
    max_issue_comments_per_issue: int = Field(default=50, ge=0, le=500)
    compare_refs: list[str] = Field(
        default_factory=list,
        description="Explicit base...head compare refs to fetch by API before broad fallback.",
    )
    compare_limit: int = Field(default=20, ge=1, le=100)
    release_tags: list[str] = Field(
        default_factory=list,
        description="Explicit release tags to fetch by API before broad fallback.",
    )
    include_releases: bool = Field(
        default=False,
        description="Fetch a bounded release list by API before broad fallback.",
    )
    release_limit: int = Field(default=10, ge=1, le=50)
    max_release_assets_per_release: int = Field(default=100, ge=0, le=500)
    include_branches: bool = Field(
        default=False,
        description="Fetch a bounded branch list by API and inspect branch hot-path blobs.",
    )
    branch_limit: int = Field(default=20, ge=1, le=100)
    include_tags: bool = Field(
        default=False,
        description="Fetch a bounded tag list by API and inspect tag hot-path blobs.",
    )
    tag_limit: int = Field(default=20, ge=1, le=100)
    include_commits: bool = True
    commit_limit: int = Field(default=3, ge=1, le=20)


class GithubTaskScanTool(Tool[GithubTaskScanInput]):
    name: ClassVar[str] = "github_task_scan"
    domain: ClassVar[str] = "github"
    description: ClassVar[str] = (
        "High-level GitHub Enterprise tasking: enumerate target repos, use API code "
        "search for candidate files, fetch candidate details and recent commit patches, "
        "scan with detectors, and update domain report state."
    )
    input_model: ClassVar[type[BaseModel]] = GithubTaskScanInput
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "github task scan repositories secrets commits domain report"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "github task",
        "repo task",
        "repository scan",
        "github",
        "repo",
    )
    prompt_section: ClassVar[str] = (
        "### github_task_scan(org=None, repos=[], repo_limit=20)\n"
        "Preferred first tool for GitHub Enterprise tasking. It uses GitHub API "
        "code search to select candidate files, fetches only those file details, "
        "then scans exact file_paths, exact directory_paths, exact commit_shas, commit lists, exact pull_numbers, pull request lists, "
        "exact issue_numbers, issue lists, exact compare_refs, exact release_tags, release lists, branch lists, tag lists, or recent commit patches. Hot-path tree scan is "
        "only a bounded fallback when API search is unavailable or returns no "
        "candidates and no exact file/directory/commit/commit-list/PR/PR-list/issue/issue-list/compare/release/branch/tag scope was supplied."
    )

    async def execute(
        self,
        validated_input: GithubTaskScanInput,
        context: ToolContext,
    ) -> ToolResult:
        if not validated_input.org and not validated_input.repos:
            return ToolError(kind="validation", message="org 또는 repos 중 하나 필요")

        artifacts: list[_Artifact] = []
        errors: list[dict[str, Any]] = []
        targets: list[dict[str, str]] = []
        github_target_errors: list[dict[str, Any]] = []
        file_details: list[dict[str, Any]] = []
        commit_details: list[dict[str, Any]] = []
        pull_request_details: list[dict[str, Any]] = []
        issue_details: list[dict[str, Any]] = []
        compare_details: list[dict[str, Any]] = []
        release_details: list[dict[str, Any]] = []
        branch_details: list[dict[str, Any]] = []
        tag_details: list[dict[str, Any]] = []
        search_meta: dict[str, Any] = {
            "enabled": bool(validated_input.api_search_first),
            "query_count": 0,
            "queries": [],
            "query_details": [],
            "candidate_count": 0,
            "duplicate_count": 0,
            "repo_duplicate_count": 0,
            "detail_fetched": 0,
            "detail_missing": 0,
            "detail_errors": [],
            "errors": [],
            "unavailable": False,
            "auth_failed": False,
            "limit_failed": False,
            "fallback_hot_path_tree": 0,
            "fallback_reason": None,
            "fallback_attempts": [],
            "repo_list_attempts": [],
            "file_path_count": 0,
            "directory_path_count": 0,
            "commit_count": 0,
            "commit_list_count": 0,
            "commit_list_attempts": [],
            "pull_request_count": 0,
            "pull_request_list_attempts": [],
            "issue_count": 0,
            "issue_list_attempts": [],
            "compare_count": 0,
            "release_count": 0,
            "release_list_attempts": [],
            "branch_count": 0,
            "branch_list_attempts": [],
            "tag_count": 0,
            "tag_list_attempts": [],
            "list_no_candidates": 0,
            "out_of_scope_count": 0,
            "candidate_limit_hit": False,
        }
        seen_repo_targets: set[str] = set()
        missing_repo_targets: set[str] = set()
        # v3.78.1: commit dedup 커서는 persist 성공 후에만 전진(중간 실패 시 commit 손실 방지).
        pending_cursor: dict[str, str] = {}

        def _record_empty_github_list(
            attempt: dict[str, Any],
            details: list[dict[str, Any]],
            *,
            repo_name: str,
            candidate_source: str,
            candidate_query: str,
            error: str,
            extra_detail: dict[str, Any] | None = None,
        ) -> None:
            attempt["no_candidates"] = 1
            search_meta["list_no_candidates"] = int(
                search_meta.get("list_no_candidates") or 0,
            ) + 1
            detail = {
                "repo": repo_name,
                "candidate_source": candidate_source,
                "candidate_query": candidate_query,
                "status": "skipped",
                "content_present": False,
                "error": error,
            }
            if extra_detail:
                detail.update(extra_detail)
            details.append(detail)

        def _collect_code_search_candidates(repo_name: str) -> list[dict[str, str]]:
            candidates: list[dict[str, str]] = []
            seen: set[str] = set()
            for query in _github_code_search_queries(
                repo_name,
                validated_input.code_search_terms,
            ):
                if len(candidates) >= validated_input.max_candidate_files:
                    search_meta["candidate_limit_hit"] = True
                    break
                search_meta["queries"].append(query)
                search_meta["query_count"] += 1
                query_detail: dict[str, Any] = {
                    "repo": repo_name,
                    "query": query,
                    "status": "pending",
                    "returned": 0,
                    "added": 0,
                    "invalid": 0,
                    "out_of_scope": 0,
                    "duplicate": 0,
                    "skipped": 0,
                }
                search_meta["query_details"].append(query_detail)
                try:
                    hits = gh.code_search(
                        query,
                        per_page=validated_input.code_search_limit_per_query,
                        max_results=validated_input.code_search_limit_per_query,
                    )
                except Exception as exc:  # noqa: BLE001
                    missing_repo = _github_missing_repo_error(repo_name, exc)
                    if missing_repo is not None:
                        missing_repo_targets.add(repo_name.lower())
                        search_meta["errors"].append(missing_repo)
                        errors.append(missing_repo)
                        query_detail.update({
                            "status": "error",
                            "phase": missing_repo.get("phase") or "repo_meta",
                            "error": missing_repo.get("error") or repr(exc),
                            "status_code": missing_repo.get("status_code"),
                        })
                        break
                    err = {"target": repo_name, "phase": "code_search", "query": query, "error": repr(exc)}
                    err["status_code"] = _http_status_code(exc)
                    search_meta["errors"].append(err)
                    query_detail.update({
                        "status": "error",
                        "phase": "code_search",
                        "error": err["error"],
                        "status_code": err["status_code"],
                    })
                    if _github_api_auth_failed(exc):
                        search_meta["auth_failed"] = True
                        errors.append(err)
                        break
                    if _github_api_limit_failed(exc):
                        search_meta["limit_failed"] = True
                        errors.append(err)
                        break
                    if _github_api_unavailable(exc):
                        search_meta["unavailable"] = True
                        errors.append(err)
                        break
                    errors.append(err)
                    continue
                query_detail["returned"] = len(hits)
                before_added = len(candidates)
                for idx, hit in enumerate(hits):
                    hit_repo = str(hit.repo or "").strip()
                    if not hit_repo:
                        query_detail["invalid"] += 1
                        path = str(hit.path or "").strip()
                        err = {
                            "target": repo_name,
                            "phase": "code_search_candidate",
                            "query": query,
                            "error": "code search candidate missing repo",
                        }
                        search_meta["errors"].append(err)
                        errors.append(err)
                        file_details.append({
                            "repo": hit_repo,
                            "target_repo": repo_name,
                            "path": path,
                            "candidate_source": "code_search",
                            "candidate_query": query,
                            "status": "error",
                            "error": err["error"],
                        })
                        continue
                    if hit_repo.lower() != repo_name.lower():
                        search_meta["out_of_scope_count"] += 1
                        query_detail["out_of_scope"] += 1
                        file_details.append({
                            "repo": hit_repo,
                            "target_repo": repo_name,
                            "path": str(hit.path or "").strip(),
                            "candidate_source": "code_search",
                            "candidate_query": query,
                            "status": "skipped",
                            "error": "GitHub code-search candidate out of requested repo scope",
                        })
                        continue
                    path = str(hit.path or "").strip()
                    invalid_path = _invalid_github_repo_path_reason(
                        path,
                        subject="code search candidate",
                    )
                    if invalid_path:
                        query_detail["invalid"] += 1
                        err = {
                            "target": repo_name,
                            "phase": "code_search_candidate",
                            "query": query,
                            "path": path,
                            "error": invalid_path,
                        }
                        search_meta["errors"].append(err)
                        errors.append(err)
                        file_details.append({
                            "repo": hit_repo,
                            "path": path,
                            "candidate_source": "code_search",
                            "candidate_query": query,
                            "status": "error",
                            "error": err["error"],
                        })
                        continue
                    if path in seen:
                        search_meta["duplicate_count"] += 1
                        query_detail["duplicate"] += 1
                        file_details.append({
                            "repo": hit_repo,
                            "path": path,
                            "candidate_source": "code_search",
                            "candidate_query": query,
                            "status": "skipped",
                            "error": "duplicate code search candidate",
                        })
                        continue
                    seen.add(path)
                    candidates.append({"path": path, "query": query})
                    if len(candidates) >= validated_input.max_candidate_files:
                        search_meta["candidate_limit_hit"] = True
                        limit_skipped = len(hits) - idx - 1
                        if limit_skipped > 0:
                            query_detail["candidate_limit_hit"] = True
                            query_detail["limit_skipped"] = limit_skipped
                            for skipped_hit in hits[idx + 1:]:
                                skipped_repo = str(skipped_hit.repo or "").strip()
                                skipped_path = str(skipped_hit.path or "").strip()
                                file_details.append({
                                    "repo": skipped_repo or repo_name,
                                    "target_repo": repo_name,
                                    "path": skipped_path,
                                    "candidate_source": "code_search",
                                    "candidate_query": query,
                                    "status": "skipped",
                                    "error": "GitHub code-search candidate beyond max_candidate_files",
                                })
                        break
                query_detail["added"] = len(candidates) - before_added
                query_detail["skipped"] = (
                    int(query_detail["invalid"])
                    + int(query_detail["out_of_scope"])
                    + int(query_detail["duplicate"])
                    + int(query_detail.get("limit_skipped") or 0)
                )
                query_detail["status"] = "searched"
            search_meta["candidate_count"] += len(candidates)
            return candidates

        def _collect_api_file_details(repo_name: str, ref: str, candidates: list[dict[str, str]]) -> None:
            for candidate in candidates:
                path = candidate["path"]
                query = candidate.get("query") or ""
                file_detail = {
                    "repo": repo_name,
                    "path": path,
                    "ref": ref,
                    "candidate_source": "code_search",
                    "candidate_query": query,
                    "status": "pending",
                }
                file_details.append(file_detail)
                try:
                    text = gh.fetch_file_at_ref(repo_name, path, ref=ref)
                except Exception as exc:  # noqa: BLE001
                    err = {
                        "target": repo_name,
                        "phase": "fetch_file_at_ref",
                        "path": path,
                        "ref": ref,
                        "error": repr(exc),
                        "status_code": _http_status_code(exc),
                        "candidate_source": "code_search",
                        "candidate_query": query,
                    }
                    search_meta["detail_errors"].append(err)
                    errors.append(err)
                    file_detail["status"] = "error"
                    file_detail["status_code"] = err["status_code"]
                    file_detail["error"] = err["error"]
                    if _github_api_auth_failed(exc):
                        search_meta["auth_failed"] = True
                        break
                    if _github_api_limit_failed(exc):
                        search_meta["limit_failed"] = True
                        break
                    continue
                if text is None or not str(text).strip():
                    file_detail["status"] = "missing" if text is None else "empty"
                    file_detail["content_present"] = False
                    file_detail["error"] = "GitHub code-search file detail returned no content"
                    search_meta["detail_missing"] += 1
                    continue
                file_detail["status"] = "fetched"
                file_detail["content_present"] = True
                search_meta["detail_fetched"] += 1
                artifacts.append(_Artifact(
                    task_type="github",
                    asset=f"github:{repo_name}/{path}",
                    asset_kind="repository_file",
                    label=f"gh://{repo_name}/{path}@{ref}",
                    text=text,
                    metadata={
                        "repo": repo_name,
                        "path": path,
                        "ref": ref,
                        "scan_method": "api_code_search_detail_scan",
                        "candidate_source": "code_search",
                        "candidate_query": query,
                    },
                ))

        def _collect_explicit_file_details(repo_name: str, ref: str) -> None:
            seen_file_paths: set[str] = set()
            selected_file_count = 0
            for raw_path in validated_input.file_paths:
                path = str(raw_path or "").strip()
                invalid_path = _invalid_github_file_path_reason(path)
                if invalid_path:
                    err = {
                        "target": repo_name,
                        "phase": "file_candidate",
                        "path": path,
                        "ref": ref,
                        "error": invalid_path,
                    }
                    search_meta["errors"].append(err)
                    errors.append(err)
                    file_details.append({
                        "repo": repo_name,
                        "path": path,
                        "ref": ref,
                        "candidate_source": "explicit_file",
                        "candidate_query": "",
                        "status": "error",
                        "error": invalid_path,
                    })
                    continue
                path_key = path.lower()
                if path_key in seen_file_paths:
                    search_meta["duplicate_count"] += 1
                    file_details.append({
                        "repo": repo_name,
                        "path": path,
                        "ref": ref,
                        "candidate_source": "explicit_file",
                        "candidate_query": "",
                        "status": "skipped",
                        "error": "duplicate explicit file candidate",
                    })
                    continue
                seen_file_paths.add(path_key)
                if selected_file_count >= validated_input.max_candidate_files:
                    search_meta["candidate_limit_hit"] = True
                    file_details.append({
                        "repo": repo_name,
                        "path": path,
                        "ref": ref,
                        "candidate_source": "explicit_file",
                        "candidate_query": "",
                        "status": "skipped",
                        "error": "GitHub explicit file candidate beyond max_candidate_files",
                    })
                    continue
                selected_file_count += 1
                search_meta["file_path_count"] += 1
                file_detail = {
                    "repo": repo_name,
                    "path": path,
                    "ref": ref,
                    "candidate_source": "explicit_file",
                    "candidate_query": "",
                    "status": "pending",
                }
                file_details.append(file_detail)
                try:
                    text = gh.fetch_file_at_ref(repo_name, path, ref=ref)
                except Exception as exc:  # noqa: BLE001
                    err = {
                        "target": repo_name,
                        "phase": "fetch_file_at_ref",
                        "path": path,
                        "ref": ref,
                        "error": repr(exc),
                        "status_code": _http_status_code(exc),
                        "candidate_source": "explicit_file",
                        "candidate_query": "",
                    }
                    search_meta["detail_errors"].append(err)
                    errors.append(err)
                    file_detail["status"] = "error"
                    file_detail["status_code"] = err["status_code"]
                    file_detail["error"] = err["error"]
                    if _github_api_auth_failed(exc):
                        search_meta["auth_failed"] = True
                        break
                    if _github_api_limit_failed(exc):
                        search_meta["limit_failed"] = True
                        break
                    continue
                if text is None or not str(text).strip():
                    file_detail["status"] = "missing" if text is None else "empty"
                    file_detail["content_present"] = False
                    file_detail["error"] = "GitHub explicit file detail returned no content"
                    search_meta["detail_missing"] += 1
                    continue
                file_detail["status"] = "fetched"
                file_detail["content_present"] = True
                search_meta["detail_fetched"] += 1
                artifacts.append(_Artifact(
                    task_type="github",
                    asset=f"github:{repo_name}/{path}",
                    asset_kind="repository_file",
                    label=f"gh://{repo_name}/{path}@{ref}",
                    text=text,
                    metadata={
                        "repo": repo_name,
                        "path": path,
                        "ref": ref,
                        "scan_method": "api_exact_file_scan",
                        "candidate_source": "explicit_file",
                        "candidate_query": "",
                    },
                ))

        def _collect_explicit_directory_details(repo_name: str, ref: str) -> None:
            seen_directory_paths: set[str] = set()
            selected_directory_count = 0
            for raw_path in validated_input.directory_paths:
                directory = str(raw_path or "").strip().strip("/")
                invalid_path = _invalid_github_directory_path_reason(directory)
                if invalid_path:
                    err = {
                        "target": repo_name,
                        "phase": "directory_candidate",
                        "path": directory,
                        "ref": ref,
                        "error": invalid_path,
                    }
                    search_meta["errors"].append(err)
                    errors.append(err)
                    file_details.append({
                        "repo": repo_name,
                        "path": directory,
                        "ref": ref,
                        "candidate_source": "explicit_directory",
                        "candidate_query": directory,
                        "status": "error",
                        "error": invalid_path,
                    })
                    continue
                directory_key = directory.lower()
                if directory_key in seen_directory_paths:
                    search_meta["duplicate_count"] += 1
                    file_details.append({
                        "repo": repo_name,
                        "path": directory,
                        "ref": ref,
                        "candidate_source": "explicit_directory",
                        "candidate_query": directory,
                        "status": "skipped",
                        "error": "duplicate explicit directory candidate",
                    })
                    continue
                seen_directory_paths.add(directory_key)
                if selected_directory_count >= validated_input.max_candidate_files:
                    search_meta["candidate_limit_hit"] = True
                    file_details.append({
                        "repo": repo_name,
                        "path": directory,
                        "ref": ref,
                        "candidate_source": "explicit_directory",
                        "candidate_query": directory,
                        "status": "skipped",
                        "error": "GitHub explicit directory candidate beyond max_candidate_files",
                    })
                    continue
                selected_directory_count += 1
                search_meta["directory_path_count"] += 1
                try:
                    blobs = gh.list_directory_blobs(repo_name, ref, directory)
                except Exception as exc:  # noqa: BLE001
                    err = {
                        "target": repo_name,
                        "phase": "list_directory_blobs",
                        "path": directory,
                        "ref": ref,
                        "error": repr(exc),
                        "status_code": _http_status_code(exc),
                        "candidate_source": "explicit_directory",
                        "candidate_query": directory,
                    }
                    search_meta["detail_errors"].append(err)
                    errors.append(err)
                    file_details.append({
                        "repo": repo_name,
                        "path": directory,
                        "ref": ref,
                        "candidate_source": "explicit_directory",
                        "candidate_query": directory,
                        "status": "error",
                        "status_code": err["status_code"],
                        "error": err["error"],
                    })
                    if _github_api_auth_failed(exc):
                        search_meta["auth_failed"] = True
                        break
                    if _github_api_limit_failed(exc):
                        search_meta["limit_failed"] = True
                        break
                    continue
                if not blobs:
                    file_details.append({
                        "repo": repo_name,
                        "path": directory,
                        "ref": ref,
                        "candidate_source": "explicit_directory",
                        "candidate_query": directory,
                        "status": "missing",
                        "content_present": False,
                        "error": "GitHub explicit directory returned no blob candidates",
                    })
                    search_meta["detail_missing"] += 1
                    continue
                selected_blobs = blobs[: validated_input.max_files_per_repo]
                if len(blobs) > len(selected_blobs):
                    search_meta["candidate_limit_hit"] = True
                for blob in selected_blobs:
                    blob_repo = str(getattr(blob, "repo", "") or "").strip()
                    blob_path = str(getattr(blob, "path", "") or "").strip()
                    blob_sha = str(getattr(blob, "sha", "") or "").strip()
                    blob_ref = str(getattr(blob, "ref", "") or "").strip()
                    if blob_repo.lower() != repo_name.lower():
                        search_meta["out_of_scope_count"] += 1
                        file_details.append({
                            "repo": blob_repo,
                            "target_repo": repo_name,
                            "path": blob_path,
                            "ref": blob_ref,
                            "sha": blob_sha,
                            "candidate_source": "explicit_directory",
                            "candidate_query": directory,
                            "status": "skipped",
                            "error": "GitHub directory blob candidate out of requested repo scope",
                        })
                        continue
                    invalid_blob_path = _invalid_github_repo_path_reason(
                        blob_path,
                        subject="GitHub directory blob candidate",
                    )
                    if not blob_repo or invalid_blob_path or not blob_sha or not blob_ref:
                        err = {
                            "target": blob_repo or repo_name,
                            "phase": "blob_candidate",
                            "path": blob_path,
                            "sha": blob_sha,
                            "ref": blob_ref,
                            "error": (
                                invalid_blob_path
                                or "GitHub directory blob candidate missing repo, path, sha, or ref"
                            ),
                            "candidate_source": "explicit_directory",
                            "candidate_query": directory,
                        }
                        search_meta["detail_errors"].append(err)
                        errors.append(err)
                        file_details.append({
                            "repo": blob_repo,
                            "target_repo": repo_name,
                            "path": blob_path,
                            "ref": blob_ref,
                            "sha": blob_sha,
                            "candidate_source": "explicit_directory",
                            "candidate_query": directory,
                            "status": "error",
                            "error": err["error"],
                        })
                        continue
                    file_detail = {
                        "repo": blob_repo,
                        "path": blob_path,
                        "ref": blob_ref,
                        "sha": blob_sha,
                        "size": int(getattr(blob, "size", 0) or 0),
                        "candidate_source": "explicit_directory",
                        "candidate_query": directory,
                        "status": "pending",
                    }
                    file_details.append(file_detail)
                    try:
                        text = gh.fetch_blob_text(blob_repo, blob_sha)
                    except Exception as exc:  # noqa: BLE001
                        err = {
                            "target": blob_repo,
                            "phase": "fetch_blob_text",
                            "path": blob_path,
                            "sha": blob_sha,
                            "ref": blob_ref,
                            "error": repr(exc),
                            "status_code": _http_status_code(exc),
                            "candidate_source": "explicit_directory",
                            "candidate_query": directory,
                        }
                        search_meta["detail_errors"].append(err)
                        errors.append(err)
                        file_detail["status"] = "error"
                        file_detail["status_code"] = err["status_code"]
                        file_detail["error"] = err["error"]
                        if _github_api_auth_failed(exc):
                            search_meta["auth_failed"] = True
                            break
                        if _github_api_limit_failed(exc):
                            search_meta["limit_failed"] = True
                            break
                        continue
                    if text is None or not str(text).strip():
                        file_detail["status"] = "missing" if text is None else "empty"
                        file_detail["content_present"] = False
                        search_meta["detail_missing"] += 1
                        continue
                    file_detail["status"] = "fetched"
                    file_detail["content_present"] = True
                    search_meta["detail_fetched"] += 1
                    artifacts.append(_Artifact(
                        task_type="github",
                        asset=f"github:{blob_repo}/{blob_path}",
                        asset_kind="repository_file",
                        label=f"gh://{blob_repo}/{blob_path}@{blob_ref}",
                        text=text,
                        metadata={
                            "repo": blob_repo,
                            "path": blob_path,
                            "sha": blob_sha,
                            "size": int(getattr(blob, "size", 0) or 0),
                            "ref": blob_ref,
                            "scan_method": "api_directory_tree_scan",
                            "candidate_source": "explicit_directory",
                            "candidate_query": directory,
                        },
                    ))
                if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                    break
                for blob in blobs[len(selected_blobs):]:
                    blob_repo = str(getattr(blob, "repo", "") or "").strip()
                    blob_path = str(getattr(blob, "path", "") or "").strip()
                    blob_sha = str(getattr(blob, "sha", "") or "").strip()
                    blob_ref = str(getattr(blob, "ref", "") or "").strip()
                    file_details.append({
                        "repo": blob_repo or repo_name,
                        "target_repo": repo_name,
                        "path": blob_path,
                        "ref": blob_ref,
                        "sha": blob_sha,
                        "size": int(getattr(blob, "size", 0) or 0),
                        "candidate_source": "explicit_directory",
                        "candidate_query": directory,
                        "status": "skipped",
                        "error": "GitHub directory blob candidate beyond max_files_per_repo",
                    })

        def _collect_commit_patch_artifacts(
            commits: list[gh.GhCommitPatch],
            *,
            source: str,
            since_sha: str | None = None,
        ) -> bool:
            candidate_error = False
            for commit in commits:
                commit_sha = str(getattr(commit, "sha", "") or "").strip()
                commit_repo = str(getattr(commit, "repo", "") or "").strip()
                if not commit_sha or not commit_repo:
                    err = {
                        "target": commit_repo or "(missing)",
                        "phase": "recent_commit_patch_candidate",
                        "error": "commit patch candidate missing repo or sha",
                        "repo": commit_repo,
                        "sha": commit_sha,
                    }
                    search_meta["errors"].append(err)
                    errors.append(err)
                    detail = {
                        "repo": commit_repo,
                        "sha": commit_sha,
                        "candidate_source": source,
                        "status": "error",
                        "error": err["error"],
                    }
                    if since_sha:
                        detail["since_sha"] = since_sha
                    commit_details.append(detail)
                    candidate_error = True
                    continue
                files = list(getattr(commit, "files", []) or [])
                detail = {
                    "repo": commit_repo,
                    "sha": commit_sha,
                    "candidate_source": source,
                    "files": [
                        str(f.get("filename") or "").strip()
                        for f in files
                        if str(f.get("filename") or "").strip()
                    ],
                    "file_count": len(files),
                    "scannable_file_count": 0,
                    "status": "pending",
                }
                if since_sha:
                    detail["since_sha"] = since_sha
                commit_details.append(detail)
                if not files:
                    detail["status"] = "missing"
                    detail["content_present"] = False
                    detail["error"] = "GitHub commit patch returned no files"
                    search_meta["detail_missing"] += 1
                    continue
                patch_chunks: list[str] = []
                file_error_count = 0
                for f in files:
                    filename = str(f.get("filename") or "").strip()
                    patch = str(f.get("patch") or "")
                    invalid_filename = _invalid_github_repo_path_reason(
                        filename,
                        subject="commit patch file candidate",
                    )
                    if invalid_filename:
                        err = {
                            "target": commit_repo,
                            "phase": "recent_commit_patch_candidate",
                            "error": invalid_filename,
                            "repo": commit_repo,
                            "sha": commit_sha,
                            "path": filename,
                        }
                        search_meta["errors"].append(err)
                        errors.append(err)
                        candidate_error = True
                        file_error_count += 1
                        continue
                    if not patch.strip():
                        search_meta["detail_missing"] += 1
                        continue
                    patch_chunks.append(f"### {filename}\n{patch}")
                detail["scannable_file_count"] = len(patch_chunks)
                if file_error_count:
                    detail["file_error_count"] = file_error_count
                if not patch_chunks:
                    detail["content_present"] = False
                    if file_error_count:
                        detail["status"] = "error"
                        detail["error"] = "one or more commit patch file candidates invalid"
                    else:
                        detail["status"] = "empty"
                        detail["error"] = (
                            "GitHub commit patch returned no scannable patch content"
                        )
                    continue
                detail["status"] = "fetched"
                detail["content_present"] = True
                patch_text = "\n\n".join(patch_chunks)
                search_meta["detail_fetched"] += 1
                artifacts.append(_Artifact(
                    task_type="github",
                    asset=f"github:{commit_repo}/commit/{commit_sha}",
                    asset_kind="commit_patch",
                    label=f"gh://{commit_repo}/commit/{commit_sha}",
                    text=patch_text,
                    metadata={
                        "repo": commit_repo,
                        "sha": commit_sha,
                        "author": commit.author,
                        "message": commit.message[:200],
                        "files": [f.get("filename") for f in commit.files],
                        "scan_method": "api_recent_commit_patch_scan",
                        "candidate_source": source,
                        # ★ 담당자 채널. 구 스캐너(github/application/scanner.py:1064)는
                        #   metadata["author_email"] 을 썼는데 이 경로가 그걸 빠뜨려서,
                        #   신 경로 finding 2,177건의 author_email 이 **0건**이 됐다
                        #   (구 경로는 17,544건 중 9,237건 보유). 리포터의 담당자 키 목록은
                        #   author_email 을 보므로, 빠지면 스레드가 담당자 없이 만들어지고
                        #   `github_report_thread_claim_next` 의 owner_recipient 필터에 걸려
                        #   통보가 아예 안 나간다.
                        #   ⚠️ metadata["author"] 는 GitHub **로그인명**이라 대체재가 못 된다 —
                        #   수신자 검증(`_is_internal_owner_email`)이 메일 주소만 통과시킨다.
                        **({"author_email": commit.author_email} if commit.author_email else {}),
                        # 아래는 담당자가 아니라 **탐지 억제** 목록이다(이름이 정반대로 읽히니 주의).
                        # 커밋 작성자 본인 메일이 자기 커밋에서 유출 hit 으로 잡히는 걸 막는다
                        # (service_task_tools.py:989 가 이 값과 같은 email hit 을 드랍한다).
                        "suppress_emails": [commit.author_email] if commit.author_email else [],
                    },
                ))
            return candidate_error

        def _collect_explicit_commit_details(repo_name: str) -> None:
            seen_commit_shas: set[str] = set()
            selected_commit_count = 0
            for raw_sha in validated_input.commit_shas:
                sha = str(raw_sha or "").strip()
                invalid_sha = _invalid_github_commit_sha_reason(sha)
                if invalid_sha:
                    err = {
                        "target": repo_name,
                        "phase": "commit_candidate",
                        "sha": sha,
                        "error": invalid_sha,
                    }
                    search_meta["errors"].append(err)
                    errors.append(err)
                    commit_details.append({
                        "repo": repo_name,
                        "sha": sha,
                        "candidate_source": "explicit_commit",
                        "status": "error",
                        "error": invalid_sha,
                    })
                    continue
                sha_key = sha.lower()
                if sha_key in seen_commit_shas:
                    search_meta["duplicate_count"] += 1
                    commit_details.append({
                        "repo": repo_name,
                        "sha": sha,
                        "candidate_source": "explicit_commit",
                        "status": "skipped",
                        "error": "duplicate explicit commit candidate",
                    })
                    continue
                seen_commit_shas.add(sha_key)
                if selected_commit_count >= validated_input.commit_limit:
                    search_meta["candidate_limit_hit"] = True
                    commit_details.append({
                        "repo": repo_name,
                        "sha": sha,
                        "candidate_source": "explicit_commit",
                        "status": "skipped",
                        "error": "GitHub explicit commit candidate beyond commit_limit",
                    })
                    continue
                selected_commit_count += 1
                search_meta["commit_count"] += 1
                try:
                    commit = gh.fetch_commit_patch(repo_name, sha)
                except Exception as exc:  # noqa: BLE001
                    err = {
                        "target": repo_name,
                        "phase": "fetch_commit_patch",
                        "sha": sha,
                        "error": repr(exc),
                        "status_code": _http_status_code(exc),
                        "candidate_source": "explicit_commit",
                        "candidate_query": "",
                    }
                    search_meta["detail_errors"].append(err)
                    errors.append(err)
                    commit_details.append({
                        "repo": repo_name,
                        "sha": sha,
                        "candidate_source": "explicit_commit",
                        "status": "error",
                        "status_code": err["status_code"],
                        "error": err["error"],
                    })
                    if _github_api_auth_failed(exc):
                        search_meta["auth_failed"] = True
                        break
                    if _github_api_limit_failed(exc):
                        search_meta["limit_failed"] = True
                        break
                    continue
                if commit is None:
                    commit_details.append({
                        "repo": repo_name,
                        "sha": sha,
                        "candidate_source": "explicit_commit",
                        "status": "missing",
                        "content_present": False,
                    })
                    search_meta["detail_missing"] += 1
                    continue
                commit_repo = str(getattr(commit, "repo", "") or "").strip()
                if commit_repo.lower() != repo_name.lower():
                    search_meta["out_of_scope_count"] += 1
                    commit_details.append({
                        "repo": commit_repo,
                        "target_repo": repo_name,
                        "sha": sha,
                        "candidate_source": "explicit_commit",
                        "status": "skipped",
                        "error": "GitHub commit candidate out of requested repo scope",
                    })
                    continue
                _collect_commit_patch_artifacts([commit], source="explicit_commit")

        def _collect_commit_list_details(repo_name: str) -> None:
            attempt: dict[str, Any] = {
                "repo": repo_name,
                "limit": validated_input.commit_limit,
                "returned": 0,
                "selected": 0,
                "invalid": 0,
                "out_of_scope": 0,
                "duplicate": 0,
                "skipped": 0,
            }
            try:
                commits = gh.recent_commit_patches(
                    repo_name,
                    limit=validated_input.commit_limit,
                    since_sha=None,
                )
            except Exception as exc:  # noqa: BLE001
                missing_repo = _github_missing_repo_error(repo_name, exc)
                if missing_repo is not None:
                    search_meta["errors"].append(missing_repo)
                    errors.append(missing_repo)
                    attempt.update({
                        "phase": "list_commits",
                        "error": missing_repo["error"],
                        "status_code": missing_repo.get("status_code"),
                    })
                    search_meta["commit_list_attempts"].append(attempt)
                    return
                err = {
                    "target": repo_name,
                    "phase": "list_commits",
                    "error": repr(exc),
                    "status_code": _http_status_code(exc),
                    "candidate_source": "commit_list",
                    "candidate_query": "commits",
                }
                search_meta["detail_errors"].append(err)
                errors.append(err)
                commit_details.append({
                    "repo": repo_name,
                    "sha": "",
                    "candidate_source": "commit_list",
                    "candidate_query": "commits",
                    "status": "error",
                    "status_code": err["status_code"],
                    "error": err["error"],
                })
                if _github_api_auth_failed(exc):
                    search_meta["auth_failed"] = True
                if _github_api_limit_failed(exc):
                    search_meta["limit_failed"] = True
                attempt.update({
                    "phase": "list_commits",
                    "error": err["error"],
                    "status_code": err["status_code"],
                })
                search_meta["commit_list_attempts"].append(attempt)
                return
            attempt["returned"] = len(commits)
            if not commits:
                _record_empty_github_list(
                    attempt,
                    commit_details,
                    repo_name=repo_name,
                    candidate_source="commit_list",
                    candidate_query="commits",
                    error="GitHub commit list returned no candidates",
                )
                search_meta["commit_list_attempts"].append(attempt)
                return
            seen_commit_shas: set[str] = set()
            for idx, commit in enumerate(commits):
                commit_sha = str(getattr(commit, "sha", "") or "").strip()
                commit_repo = str(getattr(commit, "repo", "") or "").strip()
                if idx >= validated_input.commit_limit:
                    if not attempt.get("candidate_limit_hit"):
                        search_meta["candidate_limit_hit"] = True
                        attempt["candidate_limit_hit"] = True
                        attempt["limit_skipped"] = len(commits) - idx
                    commit_details.append({
                        "repo": commit_repo or repo_name,
                        "target_repo": repo_name,
                        "sha": commit_sha,
                        "candidate_source": "commit_list",
                        "candidate_query": "commits",
                        "status": "skipped",
                        "error": "GitHub commit-list candidate beyond commit_limit",
                    })
                    continue
                if not commit_sha:
                    err = {
                        "target": repo_name,
                        "phase": "recent_commit_patch_candidate",
                        "error": "commit patch candidate missing sha",
                        "repo": commit_repo,
                        "sha": commit_sha,
                        "candidate_source": "commit_list",
                    }
                    search_meta["errors"].append(err)
                    errors.append(err)
                    commit_details.append({
                        "repo": commit_repo,
                        "target_repo": repo_name,
                        "sha": commit_sha,
                        "candidate_source": "commit_list",
                        "candidate_query": "commits",
                        "status": "error",
                        "error": err["error"],
                    })
                    attempt["invalid"] += 1
                    continue
                if commit_repo.lower() != repo_name.lower():
                    search_meta["out_of_scope_count"] += 1
                    attempt["out_of_scope"] += 1
                    commit_details.append({
                        "repo": commit_repo,
                        "target_repo": repo_name,
                        "sha": commit_sha,
                        "candidate_source": "commit_list",
                        "candidate_query": "commits",
                        "status": "skipped",
                        "error": "GitHub commit candidate out of requested repo scope",
                    })
                    continue
                commit_key = commit_sha.lower()
                if commit_key in seen_commit_shas:
                    search_meta["duplicate_count"] += 1
                    attempt["duplicate"] += 1
                    continue
                seen_commit_shas.add(commit_key)
                attempt["selected"] += 1
                search_meta["commit_count"] += 1
                search_meta["commit_list_count"] += 1
                _collect_commit_patch_artifacts([commit], source="commit_list")
            attempt["skipped"] = (
                int(attempt["invalid"])
                + int(attempt["out_of_scope"])
                + int(attempt["duplicate"])
                + int(attempt.get("limit_skipped") or 0)
            )
            search_meta["commit_list_attempts"].append(attempt)

        seen_pull_numbers: set[tuple[str, int]] = set()
        selected_pull_number_counts: dict[tuple[str, str], int] = {}

        def _collect_pull_request_detail(
            repo_name: str,
            raw_number: Any,
            *,
            candidate_source: str,
            candidate_query: str = "",
            candidate_limit: int | None = None,
            title: str = "",
            state: Any = None,
            author: Any = None,
            head_sha: Any = None,
            base_ref: Any = None,
        ) -> None:
            invalid_number = _invalid_github_pull_number_reason(raw_number)
            if invalid_number:
                err = {
                    "target": repo_name,
                    "phase": "pull_request_candidate",
                    "pull_number": raw_number,
                    "error": invalid_number,
                    "candidate_source": candidate_source,
                    "candidate_query": candidate_query,
                }
                search_meta["errors"].append(err)
                errors.append(err)
                pull_request_details.append({
                    "repo": repo_name,
                    "pull_number": raw_number,
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                    "status": "error",
                    "error": invalid_number,
                })
                return
            pull_number = int(raw_number)
            pull_key = (repo_name.lower(), pull_number)
            if pull_key in seen_pull_numbers:
                search_meta["duplicate_count"] += 1
                pull_request_details.append({
                    "repo": repo_name,
                    "pull_number": pull_number,
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                    "status": "skipped",
                    "error": "duplicate pull request candidate",
                })
                return
            if candidate_limit is not None:
                limit_key = (repo_name.lower(), candidate_source)
                selected_count = selected_pull_number_counts.get(limit_key, 0)
                if selected_count >= candidate_limit:
                    search_meta["candidate_limit_hit"] = True
                    pull_request_details.append({
                        "repo": repo_name,
                        "pull_number": pull_number,
                        "candidate_source": candidate_source,
                        **({"candidate_query": candidate_query} if candidate_query else {}),
                        "status": "skipped",
                        "error": "GitHub explicit pull request candidate beyond pull_request_limit",
                    })
                    return
                selected_pull_number_counts[limit_key] = selected_count + 1
            seen_pull_numbers.add(pull_key)
            search_meta["pull_request_count"] += 1
            try:
                pull_patch = gh.fetch_pull_request_files(repo_name, pull_number)
            except Exception as exc:  # noqa: BLE001
                err = {
                    "target": repo_name,
                    "phase": "fetch_pull_request_files",
                    "pull_number": pull_number,
                    "error": repr(exc),
                    "status_code": _http_status_code(exc),
                    "candidate_source": candidate_source,
                    "candidate_query": candidate_query,
                }
                search_meta["detail_errors"].append(err)
                errors.append(err)
                pull_request_details.append({
                    "repo": repo_name,
                    "pull_number": pull_number,
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                    "status": "error",
                    "status_code": err["status_code"],
                    "error": err["error"],
                })
                if _github_api_auth_failed(exc):
                    search_meta["auth_failed"] = True
                if _github_api_limit_failed(exc):
                    search_meta["limit_failed"] = True
                return
            if pull_patch is None:
                pull_request_details.append({
                    "repo": repo_name,
                    "pull_number": pull_number,
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                    "status": "missing",
                    "content_present": False,
                    "error": "GitHub pull request detail returned no files",
                })
                search_meta["detail_missing"] += 1
                return
            pull_repo = str(getattr(pull_patch, "repo", "") or "").strip()
            if pull_repo.lower() != repo_name.lower():
                search_meta["out_of_scope_count"] += 1
                pull_request_details.append({
                    "repo": pull_repo,
                    "target_repo": repo_name,
                    "pull_number": pull_number,
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                    "status": "skipped",
                    "error": "GitHub pull request candidate out of requested repo scope",
                })
                return
            files = list(getattr(pull_patch, "files", []) or [])
            total_file_count = getattr(pull_patch, "total_file_count", None)
            try:
                total_file_count_int = int(total_file_count)
            except (TypeError, ValueError):
                total_file_count_int = len(files)
            total_file_count_int = max(len(files), total_file_count_int)
            try:
                limit_skipped = max(
                    0,
                    int(getattr(pull_patch, "limit_skipped", 0) or 0),
                )
            except (TypeError, ValueError):
                limit_skipped = 0
            skipped_files = [
                str(path or "").strip()
                for path in (getattr(pull_patch, "skipped_files", []) or [])
                if str(path or "").strip()
            ]
            detail = {
                "repo": repo_name,
                "pull_number": pull_number,
                "candidate_source": candidate_source,
                **({"candidate_query": candidate_query} if candidate_query else {}),
                **({"title": title} if title else {}),
                **({"state": state} if state is not None else {}),
                **({"author": author} if author else {}),
                **({"head_sha": head_sha} if head_sha else {}),
                **({"base_ref": base_ref} if base_ref else {}),
                "files": [
                    str(f.get("filename") or "").strip()
                    for f in files
                    if str(f.get("filename") or "").strip()
                ],
                "file_count": total_file_count_int,
                "scannable_file_count": 0,
                "status": "pending",
            }
            if limit_skipped:
                search_meta["candidate_limit_hit"] = True
                detail["candidate_limit_hit"] = True
                detail["limit_skipped"] = limit_skipped
                if skipped_files:
                    detail["skipped_files"] = skipped_files
            pull_request_details.append(detail)
            for skipped_path in skipped_files:
                pull_request_details.append({
                    "repo": repo_name,
                    "pull_number": pull_number,
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                    "path": skipped_path,
                    "status": "skipped",
                    "error": "GitHub pull-request file candidate beyond max_files",
                })
            if not files:
                detail["status"] = "missing"
                detail["content_present"] = False
                detail["error"] = "GitHub pull request detail returned no files"
                search_meta["detail_missing"] += 1
                return
            patch_chunks: list[str] = []
            file_error_count = 0
            for f in files:
                filename = str(f.get("filename") or "").strip()
                patch = str(f.get("patch") or "")
                invalid_filename = _invalid_github_repo_path_reason(
                    filename,
                    subject="pull request file candidate",
                )
                if invalid_filename:
                    err = {
                        "target": repo_name,
                        "phase": "pull_request_candidate",
                        "error": invalid_filename,
                        "repo": repo_name,
                        "pull_number": pull_number,
                        "path": filename,
                        "candidate_source": candidate_source,
                        "candidate_query": candidate_query,
                    }
                    search_meta["errors"].append(err)
                    errors.append(err)
                    file_error_count += 1
                    continue
                if not patch.strip():
                    search_meta["detail_missing"] += 1
                    continue
                patch_chunks.append(f"### {filename}\n{patch}")
            detail["scannable_file_count"] = len(patch_chunks)
            if file_error_count:
                detail["file_error_count"] = file_error_count
            if not patch_chunks:
                detail["content_present"] = False
                if file_error_count:
                    detail["status"] = "error"
                    detail["error"] = "one or more pull request file candidates invalid"
                else:
                    detail["status"] = "empty"
                    detail["error"] = (
                        "GitHub pull request detail returned no scannable patch content"
                    )
                return
            detail["status"] = "fetched"
            detail["content_present"] = True
            patch_text = "\n\n".join(patch_chunks)
            search_meta["detail_fetched"] += 1
            artifacts.append(_Artifact(
                task_type="github",
                asset=f"github:{repo_name}/pull/{pull_number}",
                asset_kind="commit_patch",
                label=f"gh://{repo_name}/pull/{pull_number}/files",
                text=patch_text,
                metadata={
                    "repo": repo_name,
                    "pull_number": pull_number,
                    "files": detail["files"],
                    "scan_method": "api_pull_request_files_scan",
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                },
            ))

        def _collect_explicit_pull_request_details(repo_name: str) -> None:
            for raw_number in validated_input.pull_numbers:
                _collect_pull_request_detail(
                    repo_name,
                    raw_number,
                    candidate_source="explicit_pull_request",
                    candidate_limit=validated_input.pull_request_limit,
                )
                if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                    break

        def _collect_pull_request_list_details(repo_name: str) -> None:
            attempt: dict[str, Any] = {
                "repo": repo_name,
                "limit": validated_input.pull_request_limit,
                "returned": 0,
                "selected": 0,
                "duplicate": 0,
                "invalid": 0,
                "out_of_scope": 0,
                "skipped": 0,
            }
            before_duplicates = int(search_meta.get("duplicate_count") or 0)
            try:
                pulls = gh.list_pull_requests(
                    repo_name,
                    limit=validated_input.pull_request_limit,
                )
            except Exception as exc:  # noqa: BLE001
                err = {
                    "target": repo_name,
                    "phase": "list_pull_requests",
                    "error": repr(exc),
                    "status_code": _http_status_code(exc),
                    "candidate_source": "pull_request_list",
                    "candidate_query": "pulls",
                }
                search_meta["detail_errors"].append(err)
                errors.append(err)
                pull_request_details.append({
                    "repo": repo_name,
                    "candidate_source": "pull_request_list",
                    "candidate_query": "pulls",
                    "status": "error",
                    "status_code": err["status_code"],
                    "error": err["error"],
                })
                attempt.update({
                    "phase": "list_pull_requests",
                    "error": err["error"],
                    "status_code": err["status_code"],
                })
                search_meta["pull_request_list_attempts"].append(attempt)
                if _github_api_auth_failed(exc):
                    search_meta["auth_failed"] = True
                if _github_api_limit_failed(exc):
                    search_meta["limit_failed"] = True
                return
            attempt["returned"] = len(pulls)
            if not pulls:
                _record_empty_github_list(
                    attempt,
                    pull_request_details,
                    repo_name=repo_name,
                    candidate_source="pull_request_list",
                    candidate_query="pulls",
                    error="GitHub pull request list returned no candidates",
                )
                search_meta["pull_request_list_attempts"].append(attempt)
                return
            for idx, pull in enumerate(pulls):
                pull_repo = str(getattr(pull, "repo", "") or "").strip()
                pull_number = getattr(pull, "number", None)
                if idx >= validated_input.pull_request_limit:
                    if not attempt.get("candidate_limit_hit"):
                        search_meta["candidate_limit_hit"] = True
                        attempt["candidate_limit_hit"] = True
                        attempt["limit_skipped"] = len(pulls) - idx
                    pull_request_details.append({
                        "repo": pull_repo or repo_name,
                        "target_repo": repo_name,
                        "pull_number": pull_number,
                        "candidate_source": "pull_request_list",
                        "candidate_query": "pulls",
                        "status": "skipped",
                        "error": "GitHub pull-request-list candidate beyond pull_request_limit",
                    })
                    continue
                if pull_repo.lower() != repo_name.lower():
                    search_meta["out_of_scope_count"] += 1
                    attempt["out_of_scope"] += 1
                    pull_request_details.append({
                        "repo": pull_repo,
                        "target_repo": repo_name,
                        "pull_number": pull_number,
                        "candidate_source": "pull_request_list",
                        "candidate_query": "pulls",
                        "status": "skipped",
                        "error": "GitHub pull request candidate out of requested repo scope",
                    })
                    continue
                before_detail_count = len(pull_request_details)
                before_errors = len(errors)
                _collect_pull_request_detail(
                    repo_name,
                    getattr(pull, "number", None),
                    candidate_source="pull_request_list",
                    candidate_query="pulls",
                    title=str(getattr(pull, "title", "") or ""),
                    state=getattr(pull, "state", None),
                    author=getattr(pull, "author", None),
                    head_sha=getattr(pull, "head_sha", None),
                    base_ref=getattr(pull, "base_ref", None),
                )
                if len(pull_request_details) > before_detail_count:
                    latest = pull_request_details[-1]
                    if latest.get("status") != "error":
                        attempt["selected"] += 1
                    else:
                        attempt["invalid"] += 1
                elif int(search_meta.get("duplicate_count") or 0) > before_duplicates:
                    attempt["duplicate"] += 1
                    before_duplicates = int(search_meta.get("duplicate_count") or 0)
                elif len(errors) > before_errors:
                    attempt["invalid"] += 1
                if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                    break
            attempt["skipped"] = (
                int(attempt.get("duplicate") or 0)
                + int(attempt.get("invalid") or 0)
                + int(attempt.get("out_of_scope") or 0)
                + int(attempt.get("limit_skipped") or 0)
            )
            search_meta["pull_request_list_attempts"].append(attempt)

        seen_issue_numbers: set[tuple[str, int]] = set()
        selected_issue_number_counts: dict[tuple[str, str], int] = {}

        def _collect_issue_detail(
            repo_name: str,
            raw_number: Any,
            *,
            candidate_source: str,
            candidate_query: str = "",
            candidate_limit: int | None = None,
            title_hint: str = "",
            state_hint: Any = None,
            author_hint: Any = None,
        ) -> None:
            invalid_number = _invalid_github_issue_number_reason(raw_number)
            if invalid_number:
                err = {
                    "target": repo_name,
                    "phase": "issue_candidate",
                    "issue_number": raw_number,
                    "error": invalid_number,
                    "candidate_source": candidate_source,
                    "candidate_query": candidate_query,
                }
                search_meta["errors"].append(err)
                errors.append(err)
                issue_details.append({
                    "repo": repo_name,
                    "issue_number": raw_number,
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                    "status": "error",
                    "error": invalid_number,
                })
                return
            issue_number = int(raw_number)
            issue_key = (repo_name.lower(), issue_number)
            if issue_key in seen_issue_numbers:
                search_meta["duplicate_count"] += 1
                issue_details.append({
                    "repo": repo_name,
                    "issue_number": issue_number,
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                    "status": "skipped",
                    "error": "duplicate issue candidate",
                })
                return
            if candidate_limit is not None:
                limit_key = (repo_name.lower(), candidate_source)
                selected_count = selected_issue_number_counts.get(limit_key, 0)
                if selected_count >= candidate_limit:
                    search_meta["candidate_limit_hit"] = True
                    issue_details.append({
                        "repo": repo_name,
                        "issue_number": issue_number,
                        "candidate_source": candidate_source,
                        **({"candidate_query": candidate_query} if candidate_query else {}),
                        "status": "skipped",
                        "error": "GitHub explicit issue candidate beyond issue_limit",
                    })
                    return
                selected_issue_number_counts[limit_key] = selected_count + 1
            seen_issue_numbers.add(issue_key)
            search_meta["issue_count"] += 1
            try:
                issue = gh.fetch_issue_detail(repo_name, issue_number)
            except Exception as exc:  # noqa: BLE001
                err = {
                    "target": repo_name,
                    "phase": "fetch_issue_detail",
                    "issue_number": issue_number,
                    "error": repr(exc),
                    "status_code": _http_status_code(exc),
                    "candidate_source": candidate_source,
                    "candidate_query": candidate_query,
                }
                search_meta["detail_errors"].append(err)
                errors.append(err)
                issue_details.append({
                    "repo": repo_name,
                    "issue_number": issue_number,
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                    "status": "error",
                    "status_code": err["status_code"],
                    "error": err["error"],
                })
                if _github_api_auth_failed(exc):
                    search_meta["auth_failed"] = True
                if _github_api_limit_failed(exc):
                    search_meta["limit_failed"] = True
                return
            if issue is None:
                issue_details.append({
                    "repo": repo_name,
                    "issue_number": issue_number,
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                    "status": "missing",
                    "content_present": False,
                })
                search_meta["detail_missing"] += 1
                return
            issue_repo = str(getattr(issue, "repo", "") or "").strip()
            if issue_repo.lower() != repo_name.lower():
                search_meta["out_of_scope_count"] += 1
                issue_details.append({
                    "repo": issue_repo,
                    "target_repo": repo_name,
                    "issue_number": issue_number,
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                    "status": "skipped",
                    "error": "GitHub issue candidate out of requested repo scope",
                })
                return
            comments = list(getattr(issue, "comments", []) or [])
            selected_comments = comments[: validated_input.max_issue_comments_per_issue]
            skipped_comments = comments[validated_input.max_issue_comments_per_issue:]
            # List endpoint titles are candidate hints; content evidence must
            # come from the fetched issue detail body/title/comments.
            title = str(getattr(issue, "title", "") or "").strip()
            state_value = getattr(issue, "state", None) or state_hint
            author_value = getattr(issue, "author", None) or author_hint
            detail = {
                "repo": repo_name,
                "issue_number": issue_number,
                "candidate_source": candidate_source,
                **({"candidate_query": candidate_query} if candidate_query else {}),
                "title": title,
                "state": state_value,
                "author": author_value,
                "comment_count": len(comments),
                "status": "pending",
            }
            issue_details.append(detail)
            parts: list[str] = []
            body = str(getattr(issue, "body", "") or "").strip()
            if title:
                parts.append(f"### title\n{title}")
            if body:
                parts.append(f"### body\n{body}")
            if skipped_comments:
                search_meta["candidate_limit_hit"] = True
                detail["candidate_limit_hit"] = True
                detail["limit_skipped"] = len(skipped_comments)
            for idx, comment in enumerate(selected_comments):
                comment_body = str(comment.get("body") or "").strip()
                if not comment_body:
                    continue
                author = str(comment.get("author") or "").strip()
                label = f"comment {idx}"
                if author:
                    label += f" by {author}"
                parts.append(f"### {label}\n{comment_body}")
            for skipped_idx, _comment in enumerate(
                skipped_comments,
                start=len(selected_comments),
            ):
                issue_details.append({
                    "repo": repo_name,
                    "issue_number": issue_number,
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                    "comment_index": skipped_idx,
                    "status": "skipped",
                    "error": "GitHub issue comment candidate beyond max_issue_comments_per_issue",
                })
            if not parts:
                detail["status"] = "empty"
                detail["content_present"] = False
                search_meta["detail_missing"] += 1
                return
            detail["status"] = "fetched"
            detail["content_present"] = True
            search_meta["detail_fetched"] += 1
            artifacts.append(_Artifact(
                task_type="github",
                asset=f"github:{repo_name}/issue/{issue_number}",
                asset_kind="issue",
                label=f"gh://{repo_name}/issues/{issue_number}",
                text="\n\n".join(parts),
                metadata={
                    "repo": repo_name,
                    "issue_number": issue_number,
                    "title": title,
                    "state": state_value,
                    "author": author_value,
                    "comment_count": len(comments),
                    "scan_method": "api_issue_detail_scan",
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                },
            ))

        def _collect_explicit_issue_details(repo_name: str) -> None:
            for raw_number in validated_input.issue_numbers:
                _collect_issue_detail(
                    repo_name,
                    raw_number,
                    candidate_source="explicit_issue",
                    candidate_limit=validated_input.issue_limit,
                )
                if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                    break

        def _collect_issue_list_details(repo_name: str) -> None:
            attempt: dict[str, Any] = {
                "repo": repo_name,
                "limit": validated_input.issue_limit,
                "returned": 0,
                "selected": 0,
                "duplicate": 0,
                "invalid": 0,
                "out_of_scope": 0,
                "skipped": 0,
            }
            before_duplicates = int(search_meta.get("duplicate_count") or 0)
            try:
                issues = gh.list_issues(repo_name, limit=validated_input.issue_limit)
            except Exception as exc:  # noqa: BLE001
                err = {
                    "target": repo_name,
                    "phase": "list_issues",
                    "error": repr(exc),
                    "status_code": _http_status_code(exc),
                    "candidate_source": "issue_list",
                    "candidate_query": "issues",
                }
                search_meta["detail_errors"].append(err)
                errors.append(err)
                issue_details.append({
                    "repo": repo_name,
                    "candidate_source": "issue_list",
                    "candidate_query": "issues",
                    "status": "error",
                    "status_code": err["status_code"],
                    "error": err["error"],
                })
                attempt.update({
                    "phase": "list_issues",
                    "error": err["error"],
                    "status_code": err["status_code"],
                })
                search_meta["issue_list_attempts"].append(attempt)
                if _github_api_auth_failed(exc):
                    search_meta["auth_failed"] = True
                if _github_api_limit_failed(exc):
                    search_meta["limit_failed"] = True
                return
            attempt["returned"] = len(issues)
            if not issues:
                _record_empty_github_list(
                    attempt,
                    issue_details,
                    repo_name=repo_name,
                    candidate_source="issue_list",
                    candidate_query="issues",
                    error="GitHub issue list returned no candidates",
                )
                search_meta["issue_list_attempts"].append(attempt)
                return
            for idx, issue in enumerate(issues):
                issue_repo = str(getattr(issue, "repo", "") or "").strip()
                issue_number = getattr(issue, "number", None)
                if idx >= validated_input.issue_limit:
                    if not attempt.get("candidate_limit_hit"):
                        search_meta["candidate_limit_hit"] = True
                        attempt["candidate_limit_hit"] = True
                        attempt["limit_skipped"] = len(issues) - idx
                    issue_details.append({
                        "repo": issue_repo or repo_name,
                        "target_repo": repo_name,
                        "issue_number": issue_number,
                        "candidate_source": "issue_list",
                        "candidate_query": "issues",
                        "status": "skipped",
                        "error": "GitHub issue-list candidate beyond issue_limit",
                    })
                    continue
                if issue_repo.lower() != repo_name.lower():
                    search_meta["out_of_scope_count"] += 1
                    attempt["out_of_scope"] += 1
                    issue_details.append({
                        "repo": issue_repo,
                        "target_repo": repo_name,
                        "issue_number": issue_number,
                        "candidate_source": "issue_list",
                        "candidate_query": "issues",
                        "status": "skipped",
                        "error": "GitHub issue candidate out of requested repo scope",
                    })
                    continue
                before_detail_count = len(issue_details)
                before_errors = len(errors)
                _collect_issue_detail(
                    repo_name,
                    getattr(issue, "number", None),
                    candidate_source="issue_list",
                    candidate_query="issues",
                    title_hint=str(getattr(issue, "title", "") or ""),
                    state_hint=getattr(issue, "state", None),
                    author_hint=getattr(issue, "author", None),
                )
                if len(issue_details) > before_detail_count:
                    latest = issue_details[-1]
                    if latest.get("status") != "error":
                        attempt["selected"] += 1
                    else:
                        attempt["invalid"] += 1
                elif int(search_meta.get("duplicate_count") or 0) > before_duplicates:
                    attempt["duplicate"] += 1
                    before_duplicates = int(search_meta.get("duplicate_count") or 0)
                elif len(errors) > before_errors:
                    attempt["invalid"] += 1
                if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                    break
            attempt["skipped"] = (
                int(attempt.get("duplicate") or 0)
                + int(attempt.get("invalid") or 0)
                + int(attempt.get("out_of_scope") or 0)
                + int(attempt.get("limit_skipped") or 0)
            )
            search_meta["issue_list_attempts"].append(attempt)

        def _collect_explicit_compare_details(repo_name: str) -> None:
            seen_compare_refs: set[str] = set()
            selected_compare_count = 0
            for raw_compare_ref in validated_input.compare_refs:
                compare_ref = str(raw_compare_ref or "").strip()
                invalid_compare_ref = _invalid_github_compare_ref_reason(compare_ref)
                if invalid_compare_ref:
                    err = {
                        "target": repo_name,
                        "phase": "compare_candidate",
                        "compare_ref": compare_ref,
                        "error": invalid_compare_ref,
                    }
                    search_meta["errors"].append(err)
                    errors.append(err)
                    compare_details.append({
                        "repo": repo_name,
                        "compare_ref": compare_ref,
                        "candidate_source": "explicit_compare",
                        "status": "error",
                        "error": invalid_compare_ref,
                    })
                    continue
                compare_key = compare_ref.lower()
                if compare_key in seen_compare_refs:
                    search_meta["duplicate_count"] += 1
                    compare_details.append({
                        "repo": repo_name,
                        "compare_ref": compare_ref,
                        "candidate_source": "explicit_compare",
                        "status": "skipped",
                        "error": "duplicate compare candidate",
                    })
                    continue
                seen_compare_refs.add(compare_key)
                if selected_compare_count >= validated_input.compare_limit:
                    search_meta["candidate_limit_hit"] = True
                    compare_details.append({
                        "repo": repo_name,
                        "compare_ref": compare_ref,
                        "candidate_source": "explicit_compare",
                        "status": "skipped",
                        "error": "GitHub explicit compare candidate beyond compare_limit",
                    })
                    continue
                selected_compare_count += 1
                search_meta["compare_count"] += 1
                try:
                    compare_patch = gh.fetch_compare_files(repo_name, compare_ref)
                except Exception as exc:  # noqa: BLE001
                    err = {
                        "target": repo_name,
                        "phase": "fetch_compare_files",
                        "compare_ref": compare_ref,
                        "error": repr(exc),
                        "status_code": _http_status_code(exc),
                        "candidate_source": "explicit_compare",
                        "candidate_query": "",
                    }
                    search_meta["detail_errors"].append(err)
                    errors.append(err)
                    compare_details.append({
                        "repo": repo_name,
                        "compare_ref": compare_ref,
                        "candidate_source": "explicit_compare",
                        "status": "error",
                        "status_code": err["status_code"],
                        "error": err["error"],
                    })
                    if _github_api_auth_failed(exc):
                        search_meta["auth_failed"] = True
                        break
                    if _github_api_limit_failed(exc):
                        search_meta["limit_failed"] = True
                        break
                    continue
                if compare_patch is None:
                    compare_details.append({
                        "repo": repo_name,
                        "compare_ref": compare_ref,
                        "candidate_source": "explicit_compare",
                        "status": "missing",
                        "content_present": False,
                        "error": "GitHub compare detail returned no files",
                    })
                    search_meta["detail_missing"] += 1
                    continue
                compare_repo = str(getattr(compare_patch, "repo", "") or "").strip()
                if compare_repo.lower() != repo_name.lower():
                    search_meta["out_of_scope_count"] += 1
                    compare_details.append({
                        "repo": compare_repo,
                        "target_repo": repo_name,
                        "compare_ref": compare_ref,
                        "candidate_source": "explicit_compare",
                        "status": "skipped",
                        "error": "GitHub compare candidate out of requested repo scope",
                    })
                    continue
                files = list(getattr(compare_patch, "files", []) or [])
                total_file_count = getattr(compare_patch, "total_file_count", None)
                try:
                    total_file_count_int = int(total_file_count)
                except (TypeError, ValueError):
                    total_file_count_int = len(files)
                total_file_count_int = max(len(files), total_file_count_int)
                try:
                    limit_skipped = max(
                        0,
                        int(getattr(compare_patch, "limit_skipped", 0) or 0),
                    )
                except (TypeError, ValueError):
                    limit_skipped = 0
                skipped_files = [
                    str(path or "").strip()
                    for path in (getattr(compare_patch, "skipped_files", []) or [])
                    if str(path or "").strip()
                ]
                detail = {
                    "repo": repo_name,
                    "compare_ref": compare_ref,
                    "candidate_source": "explicit_compare",
                    "files": [
                        str(f.get("filename") or "").strip()
                        for f in files
                        if str(f.get("filename") or "").strip()
                    ],
                    "file_count": total_file_count_int,
                    "scannable_file_count": 0,
                    "status": "pending",
                }
                if limit_skipped:
                    search_meta["candidate_limit_hit"] = True
                    detail["candidate_limit_hit"] = True
                    detail["limit_skipped"] = limit_skipped
                    if skipped_files:
                        detail["skipped_files"] = skipped_files
                compare_details.append(detail)
                for skipped_path in skipped_files:
                    compare_details.append({
                        "repo": repo_name,
                        "compare_ref": compare_ref,
                        "candidate_source": "explicit_compare",
                        "path": skipped_path,
                        "status": "skipped",
                        "error": "GitHub compare file candidate beyond max_files",
                    })
                if not files:
                    detail["status"] = "missing"
                    detail["content_present"] = False
                    detail["error"] = "GitHub compare detail returned no files"
                    search_meta["detail_missing"] += 1
                    continue
                patch_chunks: list[str] = []
                file_error_count = 0
                for f in files:
                    filename = str(f.get("filename") or "").strip()
                    patch = str(f.get("patch") or "")
                    invalid_filename = _invalid_github_repo_path_reason(
                        filename,
                        subject="compare file candidate",
                    )
                    if invalid_filename:
                        err = {
                            "target": repo_name,
                            "phase": "compare_candidate",
                            "error": invalid_filename,
                            "repo": repo_name,
                            "compare_ref": compare_ref,
                            "path": filename,
                        }
                        search_meta["errors"].append(err)
                        errors.append(err)
                        file_error_count += 1
                        continue
                    if not patch.strip():
                        search_meta["detail_missing"] += 1
                        continue
                    patch_chunks.append(f"### {filename}\n{patch}")
                detail["scannable_file_count"] = len(patch_chunks)
                if file_error_count:
                    detail["file_error_count"] = file_error_count
                if not patch_chunks:
                    detail["content_present"] = False
                    if file_error_count:
                        detail["status"] = "error"
                        detail["error"] = "one or more compare file candidates invalid"
                    else:
                        detail["status"] = "empty"
                        detail["error"] = (
                            "GitHub compare detail returned no scannable patch content"
                        )
                    continue
                detail["status"] = "fetched"
                detail["content_present"] = True
                patch_text = "\n\n".join(patch_chunks)
                search_meta["detail_fetched"] += 1
                artifacts.append(_Artifact(
                    task_type="github",
                    asset=f"github:{repo_name}/compare/{compare_ref}",
                    asset_kind="commit_patch",
                    label=f"gh://{repo_name}/compare/{compare_ref}",
                    text=patch_text,
                    metadata={
                        "repo": repo_name,
                        "compare_ref": compare_ref,
                        "files": detail["files"],
                        "scan_method": "api_compare_files_scan",
                        "candidate_source": "explicit_compare",
                    },
                ))

        def _append_release_detail_artifact(
            repo_name: str,
            release: Any,
            *,
            requested_tag_name: str,
            candidate_source: str,
            candidate_query: str = "",
        ) -> None:
            release_repo = str(getattr(release, "repo", "") or "").strip()
            if release_repo.lower() != repo_name.lower():
                search_meta["out_of_scope_count"] += 1
                release_details.append({
                    "repo": release_repo,
                    "target_repo": repo_name,
                    "tag_name": requested_tag_name,
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                    "status": "skipped",
                    "error": "GitHub release candidate out of requested repo scope",
                })
                return
            release_tag = str(getattr(release, "tag_name", "") or requested_tag_name).strip()
            release_name = str(getattr(release, "name", "") or "").strip()
            assets = list(getattr(release, "assets", []) or [])
            selected_assets = assets[: validated_input.max_release_assets_per_release]
            skipped_assets = assets[validated_input.max_release_assets_per_release:]
            detail = {
                "repo": repo_name,
                "tag_name": requested_tag_name,
                "fetched_tag_name": release_tag,
                "candidate_source": candidate_source,
                **({"candidate_query": candidate_query} if candidate_query else {}),
                "name": release_name,
                "author": getattr(release, "author", None),
                "draft": bool(getattr(release, "draft", False)),
                "prerelease": bool(getattr(release, "prerelease", False)),
                "asset_count": len(assets),
                "assets": [
                    {
                        "name": str(asset.get("name") or ""),
                        "label": str(asset.get("label") or ""),
                        "browser_download_url": str(asset.get("browser_download_url") or ""),
                        "content_type": str(asset.get("content_type") or ""),
                    }
                    for asset in selected_assets
                ],
                "status": "pending",
            }
            release_details.append(detail)
            parts: list[str] = []
            if release_name:
                parts.append(f"### release name\n{release_name}")
            body = str(getattr(release, "body", "") or "").strip()
            if body:
                parts.append(f"### release body\n{body}")
            if skipped_assets:
                search_meta["candidate_limit_hit"] = True
                detail["candidate_limit_hit"] = True
                detail["limit_skipped"] = len(skipped_assets)
            for idx, asset in enumerate(selected_assets):
                asset_lines = []
                name = str(asset.get("name") or "").strip()
                label = str(asset.get("label") or "").strip()
                url = str(asset.get("browser_download_url") or "").strip()
                content_type = str(asset.get("content_type") or "").strip()
                if name:
                    asset_lines.append(f"name: {name}")
                if label:
                    asset_lines.append(f"label: {label}")
                if url:
                    asset_lines.append(f"url: {url}")
                if content_type:
                    asset_lines.append(f"content_type: {content_type}")
                if asset_lines:
                    parts.append(f"### asset {idx}\n" + "\n".join(asset_lines))
            for skipped_idx, _asset in enumerate(
                skipped_assets,
                start=len(selected_assets),
            ):
                release_details.append({
                    "repo": repo_name,
                    "tag_name": requested_tag_name,
                    "fetched_tag_name": release_tag,
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                    "asset_index": skipped_idx,
                    "status": "skipped",
                    "error": (
                        "GitHub release asset candidate beyond "
                        "max_release_assets_per_release"
                    ),
                })
            if not parts:
                detail["status"] = "empty"
                detail["content_present"] = False
                search_meta["detail_missing"] += 1
                return
            detail["status"] = "fetched"
            detail["content_present"] = True
            search_meta["detail_fetched"] += 1
            artifacts.append(_Artifact(
                task_type="github",
                asset=f"github:{repo_name}/release/{release_tag or requested_tag_name}",
                asset_kind="release",
                label=f"gh://{repo_name}/releases/tag/{release_tag or requested_tag_name}",
                text="\n\n".join(parts),
                metadata={
                    "repo": repo_name,
                    "tag_name": release_tag or requested_tag_name,
                    "requested_tag_name": requested_tag_name,
                    "name": release_name,
                    "author": getattr(release, "author", None),
                    "draft": bool(getattr(release, "draft", False)),
                    "prerelease": bool(getattr(release, "prerelease", False)),
                    "asset_count": len(assets),
                    "scan_method": "api_release_detail_scan",
                    "candidate_source": candidate_source,
                    **({"candidate_query": candidate_query} if candidate_query else {}),
                },
            ))

        def _collect_explicit_release_details(repo_name: str) -> None:
            seen_release_tags: set[str] = set()
            selected_release_count = 0
            for raw_tag in validated_input.release_tags:
                tag_name = str(raw_tag or "").strip()
                invalid_tag = _invalid_github_release_tag_reason(tag_name)
                if invalid_tag:
                    err = {
                        "target": repo_name,
                        "phase": "release_candidate",
                        "tag_name": tag_name,
                        "error": invalid_tag,
                    }
                    search_meta["errors"].append(err)
                    errors.append(err)
                    release_details.append({
                        "repo": repo_name,
                        "tag_name": tag_name,
                        "candidate_source": "explicit_release",
                        "status": "error",
                        "error": invalid_tag,
                    })
                    continue
                tag_key = tag_name.lower()
                if tag_key in seen_release_tags:
                    search_meta["duplicate_count"] += 1
                    release_details.append({
                        "repo": repo_name,
                        "tag_name": tag_name,
                        "candidate_source": "explicit_release",
                        "status": "skipped",
                        "error": "duplicate release candidate",
                    })
                    continue
                seen_release_tags.add(tag_key)
                if selected_release_count >= validated_input.release_limit:
                    search_meta["candidate_limit_hit"] = True
                    release_details.append({
                        "repo": repo_name,
                        "tag_name": tag_name,
                        "candidate_source": "explicit_release",
                        "status": "skipped",
                        "error": "GitHub explicit release candidate beyond release_limit",
                    })
                    continue
                selected_release_count += 1
                search_meta["release_count"] += 1
                try:
                    release = gh.fetch_release_by_tag(repo_name, tag_name)
                except Exception as exc:  # noqa: BLE001
                    err = {
                        "target": repo_name,
                        "phase": "fetch_release_by_tag",
                        "tag_name": tag_name,
                        "error": repr(exc),
                        "status_code": _http_status_code(exc),
                        "candidate_source": "explicit_release",
                        "candidate_query": "",
                    }
                    search_meta["detail_errors"].append(err)
                    errors.append(err)
                    release_details.append({
                        "repo": repo_name,
                        "tag_name": tag_name,
                        "candidate_source": "explicit_release",
                        "status": "error",
                        "status_code": err["status_code"],
                        "error": err["error"],
                    })
                    if _github_api_auth_failed(exc):
                        search_meta["auth_failed"] = True
                        break
                    if _github_api_limit_failed(exc):
                        search_meta["limit_failed"] = True
                        break
                    continue
                if release is None:
                    release_details.append({
                        "repo": repo_name,
                        "tag_name": tag_name,
                        "candidate_source": "explicit_release",
                        "status": "missing",
                        "content_present": False,
                    })
                    search_meta["detail_missing"] += 1
                    continue
                _append_release_detail_artifact(
                    repo_name,
                    release,
                    requested_tag_name=tag_name,
                    candidate_source="explicit_release",
                )

        def _collect_release_list_details(repo_name: str) -> None:
            attempt: dict[str, Any] = {
                "repo": repo_name,
                "limit": validated_input.release_limit,
                "returned": 0,
                "selected": 0,
                "duplicate": 0,
                "invalid": 0,
                "out_of_scope": 0,
                "skipped": 0,
            }
            try:
                releases = gh.list_releases(repo_name, limit=validated_input.release_limit)
            except Exception as exc:  # noqa: BLE001
                err = {
                    "target": repo_name,
                    "phase": "list_releases",
                    "error": repr(exc),
                    "status_code": _http_status_code(exc),
                    "candidate_source": "release_list",
                    "candidate_query": "releases",
                }
                search_meta["detail_errors"].append(err)
                errors.append(err)
                release_details.append({
                    "repo": repo_name,
                    "candidate_source": "release_list",
                    "candidate_query": "releases",
                    "status": "error",
                    "status_code": err["status_code"],
                    "error": err["error"],
                })
                if _github_api_auth_failed(exc):
                    search_meta["auth_failed"] = True
                if _github_api_limit_failed(exc):
                    search_meta["limit_failed"] = True
                attempt.update({
                    "phase": "list_releases",
                    "error": err["error"],
                    "status_code": err["status_code"],
                })
                search_meta["release_list_attempts"].append(attempt)
                return
            attempt["returned"] = len(releases)
            if not releases:
                _record_empty_github_list(
                    attempt,
                    release_details,
                    repo_name=repo_name,
                    candidate_source="release_list",
                    candidate_query="releases",
                    error="GitHub release list returned no candidates",
                )
                search_meta["release_list_attempts"].append(attempt)
                return
            seen_release_tags: set[str] = set()
            for idx, release in enumerate(releases):
                release_repo = str(getattr(release, "repo", "") or "").strip()
                tag_name = str(getattr(release, "tag_name", "") or "").strip()
                if idx >= validated_input.release_limit:
                    if not attempt.get("candidate_limit_hit"):
                        search_meta["candidate_limit_hit"] = True
                        attempt["candidate_limit_hit"] = True
                        attempt["limit_skipped"] = len(releases) - idx
                    release_details.append({
                        "repo": release_repo or repo_name,
                        "target_repo": repo_name,
                        "tag_name": tag_name,
                        "candidate_source": "release_list",
                        "candidate_query": "releases",
                        "status": "skipped",
                        "error": "GitHub release-list candidate beyond release_limit",
                    })
                    continue
                if release_repo.lower() != repo_name.lower():
                    search_meta["out_of_scope_count"] += 1
                    attempt["out_of_scope"] += 1
                    release_details.append({
                        "repo": release_repo,
                        "target_repo": repo_name,
                        "tag_name": tag_name,
                        "candidate_source": "release_list",
                        "candidate_query": "releases",
                        "status": "skipped",
                        "error": "GitHub release candidate out of requested repo scope",
                    })
                    continue
                invalid_tag = _invalid_github_release_tag_reason(tag_name)
                if invalid_tag:
                    err = {
                        "target": repo_name,
                        "phase": "release_candidate",
                        "tag_name": tag_name,
                        "error": invalid_tag,
                        "candidate_source": "release_list",
                    }
                    search_meta["errors"].append(err)
                    errors.append(err)
                    release_details.append({
                        "repo": repo_name,
                        "tag_name": tag_name,
                        "candidate_source": "release_list",
                        "candidate_query": "releases",
                        "status": "error",
                        "error": invalid_tag,
                    })
                    attempt["invalid"] += 1
                    continue
                tag_key = tag_name.lower()
                if tag_key in seen_release_tags:
                    search_meta["duplicate_count"] += 1
                    attempt["duplicate"] += 1
                    release_details.append({
                        "repo": release_repo or repo_name,
                        "target_repo": repo_name,
                        "tag_name": tag_name,
                        "candidate_source": "release_list",
                        "candidate_query": "releases",
                        "status": "skipped",
                        "error": "duplicate release candidate",
                    })
                    continue
                seen_release_tags.add(tag_key)
                search_meta["release_count"] += 1
                attempt["selected"] += 1
                _append_release_detail_artifact(
                    repo_name,
                    release,
                    requested_tag_name=tag_name,
                    candidate_source="release_list",
                    candidate_query="releases",
                )
            attempt["skipped"] = (
                int(attempt["duplicate"])
                + int(attempt["invalid"])
                + int(attempt["out_of_scope"])
                + int(attempt.get("limit_skipped") or 0)
            )
            search_meta["release_list_attempts"].append(attempt)

        def _collect_branch_list_details(repo_name: str) -> None:
            branch_attempt: dict[str, Any] = {
                "repo": repo_name,
                "limit": validated_input.branch_limit,
                "returned": 0,
                "selected": 0,
                "invalid": 0,
                "out_of_scope": 0,
                "duplicate": 0,
                "skipped": 0,
            }
            try:
                branches = gh.list_branches(repo_name, limit=validated_input.branch_limit)
            except Exception as exc:  # noqa: BLE001
                err = {
                    "target": repo_name,
                    "phase": "list_branches",
                    "error": repr(exc),
                    "status_code": _http_status_code(exc),
                    "candidate_source": "branch_list",
                    "candidate_query": "branches",
                }
                search_meta["detail_errors"].append(err)
                errors.append(err)
                branch_details.append({
                    "repo": repo_name,
                    "candidate_source": "branch_list",
                    "candidate_query": "branches",
                    "status": "error",
                    "status_code": err["status_code"],
                    "error": err["error"],
                })
                branch_attempt.update({
                    "phase": "list_branches",
                    "error": err["error"],
                    "status_code": err["status_code"],
                })
                search_meta["branch_list_attempts"].append(branch_attempt)
                if _github_api_auth_failed(exc):
                    search_meta["auth_failed"] = True
                if _github_api_limit_failed(exc):
                    search_meta["limit_failed"] = True
                return

            branch_attempt["returned"] = len(branches)
            if not branches:
                _record_empty_github_list(
                    branch_attempt,
                    branch_details,
                    repo_name=repo_name,
                    candidate_source="branch_list",
                    candidate_query="branches",
                    error="GitHub branch list returned no candidates",
                )
                search_meta["branch_list_attempts"].append(branch_attempt)
                return
            seen_branch_names: set[str] = set()
            for idx, branch in enumerate(branches):
                branch_repo = str(getattr(branch, "repo", "") or "").strip()
                branch_name = str(getattr(branch, "name", "") or "").strip()
                branch_sha = str(getattr(branch, "commit_sha", "") or "").strip()
                invalid_branch = _invalid_github_branch_name_reason(branch_name)
                branch_detail: dict[str, Any] = {
                    "repo": branch_repo,
                    "target_repo": repo_name,
                    "name": branch_name,
                    "commit_sha": branch_sha,
                    "candidate_source": "branch_list",
                    "candidate_query": "branches",
                    "status": "pending",
                }
                branch_details.append(branch_detail)
                if idx >= validated_input.branch_limit:
                    if not branch_attempt.get("candidate_limit_hit"):
                        search_meta["candidate_limit_hit"] = True
                        branch_attempt["candidate_limit_hit"] = True
                        branch_attempt["limit_skipped"] = len(branches) - idx
                    branch_detail["status"] = "skipped"
                    branch_detail["error"] = "GitHub branch-list candidate beyond branch_limit"
                    continue
                if branch_repo.lower() != repo_name.lower():
                    search_meta["out_of_scope_count"] += 1
                    branch_attempt["out_of_scope"] += 1
                    branch_detail["status"] = "skipped"
                    branch_detail["error"] = "GitHub branch candidate out of requested repo scope"
                    continue
                if invalid_branch or not branch_sha:
                    err = {
                        "target": branch_repo or repo_name,
                        "phase": "branch_candidate",
                        "branch": branch_name,
                        "commit_sha": branch_sha,
                        "error": invalid_branch or "GitHub branch candidate missing commit sha",
                        "candidate_source": "branch_list",
                    }
                    search_meta["errors"].append(err)
                    errors.append(err)
                    branch_attempt["invalid"] += 1
                    branch_detail["status"] = "error"
                    branch_detail["error"] = err["error"]
                    continue
                branch_key = branch_name.lower()
                if branch_key in seen_branch_names:
                    search_meta["duplicate_count"] += 1
                    branch_attempt["duplicate"] += 1
                    branch_detail["status"] = "skipped"
                    branch_detail["error"] = "duplicate branch candidate"
                    continue
                seen_branch_names.add(branch_key)
                search_meta["branch_count"] += 1
                try:
                    blobs = gh.list_paths_matching(
                        repo_name,
                        branch_name,
                        hot_paths=validated_input.hot_paths,
                    )
                    branch_detail["returned"] = len(blobs)
                except Exception as exc:  # noqa: BLE001
                    err = {
                        "target": repo_name,
                        "phase": "branch_list_paths_matching",
                        "branch": branch_name,
                        "commit_sha": branch_sha,
                        "error": repr(exc),
                        "status_code": _http_status_code(exc),
                        "candidate_source": "branch_list",
                        "candidate_query": branch_name,
                    }
                    search_meta["detail_errors"].append(err)
                    errors.append(err)
                    branch_detail["status"] = "error"
                    branch_detail["status_code"] = err["status_code"]
                    branch_detail["error"] = err["error"]
                    if _github_api_auth_failed(exc):
                        search_meta["auth_failed"] = True
                        break
                    if _github_api_limit_failed(exc):
                        search_meta["limit_failed"] = True
                        break
                    continue

                selected_blobs = blobs[: validated_input.max_files_per_repo]
                branch_detail["selected"] = len(selected_blobs)
                if not blobs:
                    branch_detail["status"] = "skipped"
                    branch_detail["content_present"] = False
                    branch_detail["error"] = (
                        "GitHub branch-list blob search returned no candidates"
                    )
                    branch_attempt["no_candidates"] = int(
                        branch_attempt.get("no_candidates") or 0,
                    ) + 1
                    continue
                if len(blobs) > len(selected_blobs):
                    skipped = len(blobs) - len(selected_blobs)
                    search_meta["candidate_limit_hit"] = True
                    branch_attempt["candidate_limit_hit"] = True
                    branch_attempt["limit_skipped"] = int(branch_attempt.get("limit_skipped") or 0) + skipped
                    branch_detail["candidate_limit_hit"] = True
                    branch_detail["limit_skipped"] = skipped
                branch_detail["status"] = "listed"
                for blob in selected_blobs:
                    blob_repo = str(getattr(blob, "repo", "") or "").strip()
                    blob_path = str(getattr(blob, "path", "") or "").strip()
                    blob_sha = str(getattr(blob, "sha", "") or "").strip()
                    blob_ref = str(getattr(blob, "ref", "") or "").strip()
                    if blob_repo.lower() != repo_name.lower():
                        search_meta["out_of_scope_count"] += 1
                        branch_attempt["out_of_scope"] += 1
                        file_details.append({
                            "repo": blob_repo,
                            "target_repo": repo_name,
                            "path": blob_path,
                            "ref": blob_ref,
                            "sha": blob_sha,
                            "branch": branch_name,
                            "candidate_source": "branch_list",
                            "candidate_query": branch_name,
                            "status": "skipped",
                            "error": "GitHub branch-list blob candidate out of requested repo scope",
                        })
                        continue
                    invalid_blob_path = _invalid_github_repo_path_reason(
                        blob_path,
                        subject="GitHub branch-list blob candidate",
                    )
                    if not blob_repo or invalid_blob_path or not blob_sha or not blob_ref:
                        branch_attempt["invalid"] += 1
                        err = {
                            "target": blob_repo or repo_name,
                            "phase": "blob_candidate",
                            "path": blob_path,
                            "sha": blob_sha,
                            "ref": blob_ref,
                            "branch": branch_name,
                            "error": (
                                invalid_blob_path
                                or "GitHub branch-list blob candidate missing repo, path, sha, or ref"
                            ),
                            "candidate_source": "branch_list",
                            "candidate_query": branch_name,
                        }
                        search_meta["detail_errors"].append(err)
                        errors.append(err)
                        file_details.append({
                            "repo": blob_repo,
                            "target_repo": repo_name,
                            "path": blob_path,
                            "ref": blob_ref,
                            "sha": blob_sha,
                            "branch": branch_name,
                            "candidate_source": "branch_list",
                            "candidate_query": branch_name,
                            "status": "error",
                            "error": err["error"],
                        })
                        continue
                    branch_attempt["selected"] += 1
                    file_detail = {
                        "repo": blob_repo,
                        "path": blob_path,
                        "ref": blob_ref,
                        "sha": blob_sha,
                        "size": int(getattr(blob, "size", 0) or 0),
                        "branch": branch_name,
                        "branch_commit_sha": branch_sha,
                        "candidate_source": "branch_list",
                        "candidate_query": branch_name,
                        "status": "pending",
                    }
                    file_details.append(file_detail)
                    try:
                        text = gh.fetch_blob_text(blob_repo, blob_sha)
                    except Exception as exc:  # noqa: BLE001
                        err = {
                            "target": blob_repo,
                            "phase": "fetch_blob_text",
                            "path": blob_path,
                            "sha": blob_sha,
                            "ref": blob_ref,
                            "branch": branch_name,
                            "error": repr(exc),
                            "status_code": _http_status_code(exc),
                            "candidate_source": "branch_list",
                            "candidate_query": branch_name,
                        }
                        search_meta["detail_errors"].append(err)
                        errors.append(err)
                        file_detail["status"] = "error"
                        file_detail["status_code"] = err["status_code"]
                        file_detail["error"] = err["error"]
                        if _github_api_auth_failed(exc):
                            search_meta["auth_failed"] = True
                            break
                        if _github_api_limit_failed(exc):
                            search_meta["limit_failed"] = True
                            break
                        continue
                    if text is None or not str(text).strip():
                        file_detail["status"] = "missing" if text is None else "empty"
                        file_detail["content_present"] = False
                        search_meta["detail_missing"] += 1
                        continue
                    file_detail["status"] = "fetched"
                    file_detail["content_present"] = True
                    search_meta["detail_fetched"] += 1
                    artifacts.append(_Artifact(
                        task_type="github",
                        asset=f"github:{blob_repo}/{blob_path}",
                        asset_kind="repository_file",
                        label=f"gh://{blob_repo}/{blob_path}@{blob_ref}",
                        text=text,
                        metadata={
                            "repo": blob_repo,
                            "path": blob_path,
                            "sha": blob_sha,
                            "size": int(getattr(blob, "size", 0) or 0),
                            "ref": blob_ref,
                            "branch": branch_name,
                            "branch_commit_sha": branch_sha,
                            "scan_method": "api_branch_hot_path_tree_scan",
                            "candidate_source": "branch_list",
                            "candidate_query": branch_name,
                        },
                    ))
                if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                    break
                for blob in blobs[len(selected_blobs):]:
                    blob_repo = str(getattr(blob, "repo", "") or "").strip()
                    blob_path = str(getattr(blob, "path", "") or "").strip()
                    blob_sha = str(getattr(blob, "sha", "") or "").strip()
                    blob_ref = str(getattr(blob, "ref", "") or "").strip()
                    file_details.append({
                        "repo": blob_repo or repo_name,
                        "target_repo": repo_name,
                        "path": blob_path,
                        "ref": blob_ref,
                        "sha": blob_sha,
                        "size": int(getattr(blob, "size", 0) or 0),
                        "branch": branch_name,
                        "branch_commit_sha": branch_sha,
                        "candidate_source": "branch_list",
                        "candidate_query": branch_name,
                        "status": "skipped",
                        "error": "GitHub branch-list blob candidate beyond max_files_per_repo",
                    })
            branch_attempt["skipped"] = (
                int(branch_attempt.get("invalid") or 0)
                + int(branch_attempt.get("out_of_scope") or 0)
                + int(branch_attempt.get("duplicate") or 0)
                + int(branch_attempt.get("no_candidates") or 0)
                + int(branch_attempt.get("limit_skipped") or 0)
            )
            search_meta["branch_list_attempts"].append(branch_attempt)

        def _collect_tag_list_details(repo_name: str) -> None:
            tag_attempt: dict[str, Any] = {
                "repo": repo_name,
                "limit": validated_input.tag_limit,
                "returned": 0,
                "selected": 0,
                "invalid": 0,
                "out_of_scope": 0,
                "duplicate": 0,
                "skipped": 0,
            }
            try:
                tags = gh.list_tags(repo_name, limit=validated_input.tag_limit)
            except Exception as exc:  # noqa: BLE001
                err = {
                    "target": repo_name,
                    "phase": "list_tags",
                    "error": repr(exc),
                    "status_code": _http_status_code(exc),
                    "candidate_source": "tag_list",
                    "candidate_query": "tags",
                }
                search_meta["detail_errors"].append(err)
                errors.append(err)
                tag_details.append({
                    "repo": repo_name,
                    "candidate_source": "tag_list",
                    "candidate_query": "tags",
                    "status": "error",
                    "status_code": err["status_code"],
                    "error": err["error"],
                })
                tag_attempt.update({
                    "phase": "list_tags",
                    "error": err["error"],
                    "status_code": err["status_code"],
                })
                search_meta["tag_list_attempts"].append(tag_attempt)
                if _github_api_auth_failed(exc):
                    search_meta["auth_failed"] = True
                if _github_api_limit_failed(exc):
                    search_meta["limit_failed"] = True
                return

            tag_attempt["returned"] = len(tags)
            if not tags:
                _record_empty_github_list(
                    tag_attempt,
                    tag_details,
                    repo_name=repo_name,
                    candidate_source="tag_list",
                    candidate_query="tags",
                    error="GitHub tag list returned no candidates",
                )
                search_meta["tag_list_attempts"].append(tag_attempt)
                return
            seen_tag_names: set[str] = set()
            for idx, tag in enumerate(tags):
                tag_repo = str(getattr(tag, "repo", "") or "").strip()
                tag_name = str(getattr(tag, "name", "") or "").strip()
                tag_sha = str(getattr(tag, "commit_sha", "") or "").strip()
                invalid_tag = _invalid_github_tag_name_reason(tag_name)
                tag_detail: dict[str, Any] = {
                    "repo": tag_repo,
                    "target_repo": repo_name,
                    "name": tag_name,
                    "commit_sha": tag_sha,
                    "candidate_source": "tag_list",
                    "candidate_query": "tags",
                    "status": "pending",
                }
                tag_details.append(tag_detail)
                if idx >= validated_input.tag_limit:
                    if not tag_attempt.get("candidate_limit_hit"):
                        search_meta["candidate_limit_hit"] = True
                        tag_attempt["candidate_limit_hit"] = True
                        tag_attempt["limit_skipped"] = len(tags) - idx
                    tag_detail["status"] = "skipped"
                    tag_detail["error"] = "GitHub tag-list candidate beyond tag_limit"
                    continue
                if tag_repo.lower() != repo_name.lower():
                    search_meta["out_of_scope_count"] += 1
                    tag_attempt["out_of_scope"] += 1
                    tag_detail["status"] = "skipped"
                    tag_detail["error"] = "GitHub tag candidate out of requested repo scope"
                    continue
                if invalid_tag or not tag_sha:
                    err = {
                        "target": tag_repo or repo_name,
                        "phase": "tag_candidate",
                        "tag": tag_name,
                        "commit_sha": tag_sha,
                        "error": invalid_tag or "GitHub tag candidate missing commit sha",
                        "candidate_source": "tag_list",
                    }
                    search_meta["errors"].append(err)
                    errors.append(err)
                    tag_attempt["invalid"] += 1
                    tag_detail["status"] = "error"
                    tag_detail["error"] = err["error"]
                    continue
                tag_key = tag_name.lower()
                if tag_key in seen_tag_names:
                    search_meta["duplicate_count"] += 1
                    tag_attempt["duplicate"] += 1
                    tag_detail["status"] = "skipped"
                    tag_detail["error"] = "duplicate tag candidate"
                    continue
                seen_tag_names.add(tag_key)
                search_meta["tag_count"] += 1
                try:
                    blobs = gh.list_commit_paths_matching(
                        repo_name,
                        tag_sha,
                        hot_paths=validated_input.hot_paths,
                    )
                    tag_detail["returned"] = len(blobs)
                except Exception as exc:  # noqa: BLE001
                    err = {
                        "target": repo_name,
                        "phase": "tag_list_commit_paths_matching",
                        "tag": tag_name,
                        "commit_sha": tag_sha,
                        "error": repr(exc),
                        "status_code": _http_status_code(exc),
                        "candidate_source": "tag_list",
                        "candidate_query": tag_name,
                    }
                    search_meta["detail_errors"].append(err)
                    errors.append(err)
                    tag_detail["status"] = "error"
                    tag_detail["status_code"] = err["status_code"]
                    tag_detail["error"] = err["error"]
                    if _github_api_auth_failed(exc):
                        search_meta["auth_failed"] = True
                        break
                    if _github_api_limit_failed(exc):
                        search_meta["limit_failed"] = True
                        break
                    continue

                selected_blobs = blobs[: validated_input.max_files_per_repo]
                tag_detail["selected"] = len(selected_blobs)
                if not blobs:
                    tag_detail["status"] = "skipped"
                    tag_detail["content_present"] = False
                    tag_detail["error"] = (
                        "GitHub tag-list blob search returned no candidates"
                    )
                    tag_attempt["no_candidates"] = int(
                        tag_attempt.get("no_candidates") or 0,
                    ) + 1
                    continue
                if len(blobs) > len(selected_blobs):
                    skipped = len(blobs) - len(selected_blobs)
                    search_meta["candidate_limit_hit"] = True
                    tag_attempt["candidate_limit_hit"] = True
                    tag_attempt["limit_skipped"] = int(tag_attempt.get("limit_skipped") or 0) + skipped
                    tag_detail["candidate_limit_hit"] = True
                    tag_detail["limit_skipped"] = skipped
                tag_detail["status"] = "listed"
                for blob in selected_blobs:
                    blob_repo = str(getattr(blob, "repo", "") or "").strip()
                    blob_path = str(getattr(blob, "path", "") or "").strip()
                    blob_sha = str(getattr(blob, "sha", "") or "").strip()
                    blob_ref = str(getattr(blob, "ref", "") or "").strip()
                    if blob_repo.lower() != repo_name.lower():
                        search_meta["out_of_scope_count"] += 1
                        tag_attempt["out_of_scope"] += 1
                        file_details.append({
                            "repo": blob_repo,
                            "target_repo": repo_name,
                            "path": blob_path,
                            "ref": blob_ref,
                            "sha": blob_sha,
                            "tag": tag_name,
                            "candidate_source": "tag_list",
                            "candidate_query": tag_name,
                            "status": "skipped",
                            "error": "GitHub tag-list blob candidate out of requested repo scope",
                        })
                        continue
                    invalid_blob_path = _invalid_github_repo_path_reason(
                        blob_path,
                        subject="GitHub tag-list blob candidate",
                    )
                    if not blob_repo or invalid_blob_path or not blob_sha or not blob_ref:
                        tag_attempt["invalid"] += 1
                        err = {
                            "target": blob_repo or repo_name,
                            "phase": "blob_candidate",
                            "path": blob_path,
                            "sha": blob_sha,
                            "ref": blob_ref,
                            "tag": tag_name,
                            "error": (
                                invalid_blob_path
                                or "GitHub tag-list blob candidate missing repo, path, sha, or ref"
                            ),
                            "candidate_source": "tag_list",
                            "candidate_query": tag_name,
                        }
                        search_meta["detail_errors"].append(err)
                        errors.append(err)
                        file_details.append({
                            "repo": blob_repo,
                            "target_repo": repo_name,
                            "path": blob_path,
                            "ref": blob_ref,
                            "sha": blob_sha,
                            "tag": tag_name,
                            "candidate_source": "tag_list",
                            "candidate_query": tag_name,
                            "status": "error",
                            "error": err["error"],
                        })
                        continue
                    tag_attempt["selected"] += 1
                    file_detail = {
                        "repo": blob_repo,
                        "path": blob_path,
                        "ref": blob_ref,
                        "sha": blob_sha,
                        "size": int(getattr(blob, "size", 0) or 0),
                        "tag": tag_name,
                        "tag_commit_sha": tag_sha,
                        "candidate_source": "tag_list",
                        "candidate_query": tag_name,
                        "status": "pending",
                    }
                    file_details.append(file_detail)
                    try:
                        text = gh.fetch_blob_text(blob_repo, blob_sha)
                    except Exception as exc:  # noqa: BLE001
                        err = {
                            "target": blob_repo,
                            "phase": "fetch_blob_text",
                            "path": blob_path,
                            "sha": blob_sha,
                            "ref": blob_ref,
                            "tag": tag_name,
                            "error": repr(exc),
                            "status_code": _http_status_code(exc),
                            "candidate_source": "tag_list",
                            "candidate_query": tag_name,
                        }
                        search_meta["detail_errors"].append(err)
                        errors.append(err)
                        file_detail["status"] = "error"
                        file_detail["status_code"] = err["status_code"]
                        file_detail["error"] = err["error"]
                        if _github_api_auth_failed(exc):
                            search_meta["auth_failed"] = True
                            break
                        if _github_api_limit_failed(exc):
                            search_meta["limit_failed"] = True
                            break
                        continue
                    if text is None or not str(text).strip():
                        file_detail["status"] = "missing" if text is None else "empty"
                        file_detail["content_present"] = False
                        search_meta["detail_missing"] += 1
                        continue
                    file_detail["status"] = "fetched"
                    file_detail["content_present"] = True
                    search_meta["detail_fetched"] += 1
                    artifacts.append(_Artifact(
                        task_type="github",
                        asset=f"github:{blob_repo}/{blob_path}",
                        asset_kind="repository_file",
                        label=f"gh://{blob_repo}/{blob_path}@{blob_ref}",
                        text=text,
                        metadata={
                            "repo": blob_repo,
                            "path": blob_path,
                            "sha": blob_sha,
                            "size": int(getattr(blob, "size", 0) or 0),
                            "ref": blob_ref,
                            "tag": tag_name,
                            "tag_commit_sha": tag_sha,
                            "scan_method": "api_tag_hot_path_tree_scan",
                            "candidate_source": "tag_list",
                            "candidate_query": tag_name,
                        },
                    ))
                if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                    break
                for blob in blobs[len(selected_blobs):]:
                    blob_repo = str(getattr(blob, "repo", "") or "").strip()
                    blob_path = str(getattr(blob, "path", "") or "").strip()
                    blob_sha = str(getattr(blob, "sha", "") or "").strip()
                    blob_ref = str(getattr(blob, "ref", "") or "").strip()
                    file_details.append({
                        "repo": blob_repo or repo_name,
                        "target_repo": repo_name,
                        "path": blob_path,
                        "ref": blob_ref,
                        "sha": blob_sha,
                        "size": int(getattr(blob, "size", 0) or 0),
                        "tag": tag_name,
                        "tag_commit_sha": tag_sha,
                        "candidate_source": "tag_list",
                        "candidate_query": tag_name,
                        "status": "skipped",
                        "error": "GitHub tag-list blob candidate beyond max_files_per_repo",
                    })
            tag_attempt["skipped"] = (
                int(tag_attempt.get("invalid") or 0)
                + int(tag_attempt.get("out_of_scope") or 0)
                + int(tag_attempt.get("duplicate") or 0)
                + int(tag_attempt.get("no_candidates") or 0)
                + int(tag_attempt.get("limit_skipped") or 0)
            )
            search_meta["tag_list_attempts"].append(tag_attempt)

        def _add_repo_target(
            *,
            full_name: Any,
            default_branch: Any,
            source: str,
            repo_meta: Any | None = None,
        ) -> bool:
            repo_name = str(full_name or "").strip()
            branch = str(default_branch or "main").strip() or "main"
            if not repo_name:
                err = {
                    "target": source,
                    "phase": "repo_candidate",
                    "source": source,
                    "full_name": repo_name,
                    "default_branch": branch,
                    "error": "GitHub repo candidate missing full_name",
                }
                errors.append(err)
                search_meta["errors"].append(err)
                github_target_errors.append({
                    "repo": repo_name,
                    "ref": branch,
                    "default_branch": branch,
                    "source": source,
                    "status": "error",
                    "error": err["error"],
                })
                return False
            repo_key = repo_name.lower()
            if repo_key in seen_repo_targets:
                search_meta["repo_duplicate_count"] += 1
                github_target_errors.append({
                    "repo": repo_name,
                    "ref": branch,
                    "default_branch": branch,
                    "source": source,
                    "status": "skipped",
                    "error": "duplicate repo candidate",
                })
                return False
            seen_repo_targets.add(repo_key)
            target = {
                "full_name": repo_name,
                "default_branch": branch,
                "source": source,
            }
            if repo_meta is not None:
                for attr in ("visibility", "private", "archived", "pushed_at", "size_kb"):
                    value = getattr(repo_meta, attr, None)
                    if value is not None and value != "":
                        target[attr] = value
            targets.append(target)
            return True

        def _collect() -> None:
            if validated_input.repos:
                if len(validated_input.repos) > validated_input.repo_limit:
                    search_meta["candidate_limit_hit"] = True
                    search_meta["repo_limit_skipped"] = (
                        len(validated_input.repos) - validated_input.repo_limit
                    )
                    for repo in validated_input.repos[validated_input.repo_limit:]:
                        repo_name = str(repo or "").strip()
                        github_target_errors.append({
                            "repo": repo_name,
                            "ref": validated_input.ref or "main",
                            "default_branch": validated_input.ref or "main",
                            "source": "explicit_repo",
                            "status": "skipped",
                            "error": "GitHub repo candidate beyond repo_limit",
                        })
                for repo in validated_input.repos[: validated_input.repo_limit]:
                    repo_name = str(repo or "").strip()
                    if not repo_name:
                        _add_repo_target(
                            full_name=repo_name,
                            default_branch=validated_input.ref or "main",
                            source="explicit_repo",
                        )
                        continue
                    if repo_name.lower() in seen_repo_targets:
                        _add_repo_target(
                            full_name=repo_name,
                            default_branch=validated_input.ref or "main",
                            source="explicit_repo",
                        )
                        continue
                    default_branch = validated_input.ref or "main"
                    repo_meta = None
                    if not validated_input.ref:
                        try:
                            repo_meta = gh.repo_meta(repo_name)
                        except Exception as exc:  # noqa: BLE001
                            err = _github_repo_meta_inaccessible_error(repo_name, exc) or {
                                "target": repo_name,
                                "phase": "repo_meta",
                                "error": repr(exc),
                                "status_code": _http_status_code(exc),
                            }
                            errors.append(err)
                            search_meta["errors"].append(err)
                            github_target_errors.append({
                                "repo": repo_name,
                                "ref": default_branch,
                                "default_branch": default_branch,
                                "source": "explicit_repo",
                                "status": "error",
                                "phase": "repo_meta",
                                "error": err["error"],
                                **({"status_code": err["status_code"]} if err.get("status_code") is not None else {}),
                            })
                            if _github_api_auth_failed(exc):
                                search_meta["auth_failed"] = True
                                return
                            if _github_api_limit_failed(exc):
                                search_meta["limit_failed"] = True
                                return
                            continue
                        if repo_meta is None:
                            err = _github_repo_meta_missing_error(repo_name)
                            errors.append(err)
                            search_meta["errors"].append(err)
                            github_target_errors.append({
                                "repo": repo_name,
                                "ref": default_branch,
                                "default_branch": default_branch,
                                "source": "explicit_repo",
                                "status": "error",
                                "phase": "repo_meta",
                                "error": err["error"],
                            })
                            continue
                        default_branch = repo_meta.default_branch or "main"
                    _add_repo_target(
                        full_name=repo_name,
                        default_branch=default_branch,
                        source="explicit_repo",
                        repo_meta=repo_meta,
                    )
            else:
                repo_attempt: dict[str, Any] = {
                    "org": validated_input.org or "",
                    "source": "list_repos",
                    "limit": validated_input.repo_limit,
                    "returned": 0,
                    "selected": 0,
                    "duplicate": 0,
                    "invalid": 0,
                    "skipped": 0,
                }
                try:
                    repos = gh.list_repos(
                        validated_input.org or "",
                        limit=validated_input.repo_limit,
                    )
                    repo_attempt["returned"] = len(repos)
                except Exception as exc:  # noqa: BLE001
                    err = {
                        "target": validated_input.org or "",
                        "phase": "list_repos",
                        "error": repr(exc),
                        "status_code": _http_status_code(exc),
                    }
                    errors.append(err)
                    search_meta["errors"].append(err)
                    github_target_errors.append({
                        "repo": "",
                        "org": validated_input.org or "",
                        "ref": validated_input.ref or "main",
                        "default_branch": validated_input.ref or "main",
                        "source": "list_repos",
                        "status": "error",
                        "phase": "list_repos",
                        "error": err["error"],
                        **({"status_code": err["status_code"]} if err.get("status_code") is not None else {}),
                    })
                    if _github_api_auth_failed(exc):
                        search_meta["auth_failed"] = True
                    if _github_api_limit_failed(exc):
                        search_meta["limit_failed"] = True
                    repo_attempt.update({
                        "phase": "list_repos",
                        "error": err["error"],
                        "status_code": err["status_code"],
                    })
                    search_meta["repo_list_attempts"].append(repo_attempt)
                    return
                if not repos:
                    repo_attempt["no_candidates"] = 1
                    search_meta["list_no_candidates"] = int(
                        search_meta.get("list_no_candidates") or 0,
                    ) + 1
                    github_target_errors.append({
                        "repo": "",
                        "org": validated_input.org or "",
                        "ref": validated_input.ref or "main",
                        "default_branch": validated_input.ref or "main",
                        "source": "list_repos",
                        "status": "skipped",
                        "phase": "list_repos",
                        "error": "GitHub repo list returned no candidates",
                    })
                if len(repos) > validated_input.repo_limit:
                    search_meta["candidate_limit_hit"] = True
                    repo_attempt["candidate_limit_hit"] = True
                    repo_attempt["limit_skipped"] = len(repos) - validated_input.repo_limit
                    repo_attempt["skipped"] += repo_attempt["limit_skipped"]
                    for skipped_repo in repos[validated_input.repo_limit:]:
                        repo_name = str(getattr(skipped_repo, "full_name", "") or "").strip()
                        default_branch = str(
                            getattr(skipped_repo, "default_branch", "") or "main",
                        ).strip() or "main"
                        github_target_errors.append({
                            "repo": repo_name,
                            "ref": default_branch,
                            "default_branch": default_branch,
                            "source": "list_repos",
                            "status": "skipped",
                            "error": "GitHub repo candidate beyond repo_limit",
                        })
                for repo in repos[: validated_input.repo_limit]:
                    before_errors = len(errors)
                    before_duplicates = int(search_meta.get("repo_duplicate_count") or 0)
                    if _add_repo_target(
                        full_name=repo.full_name,
                        default_branch=repo.default_branch,
                        source="list_repos",
                        repo_meta=repo,
                    ):
                        repo_attempt["selected"] += 1
                    elif int(search_meta.get("repo_duplicate_count") or 0) > before_duplicates:
                        repo_attempt["duplicate"] += 1
                        repo_attempt["skipped"] += 1
                    elif len(errors) > before_errors:
                        repo_attempt["invalid"] += 1
                        repo_attempt["skipped"] += 1
                search_meta["repo_list_attempts"].append(repo_attempt)

            for target in targets:
                repo_name = target["full_name"]
                ref = validated_input.ref or target["default_branch"] or "main"
                if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                    continue
                try:
                    api_candidates: list[dict[str, str]] = []
                    repo_search_error_count = len(search_meta["errors"])
                    if (
                        validated_input.api_search_first
                        and not validated_input.file_paths
                        and not validated_input.directory_paths
                        and not validated_input.issue_numbers
                        and not validated_input.include_issues
                        and not validated_input.pull_numbers
                        and not validated_input.include_pull_requests
                        and not validated_input.compare_refs
                        and not validated_input.include_commit_list
                        and not validated_input.release_tags
                        and not validated_input.include_releases
                        and not validated_input.include_branches
                        and not validated_input.include_tags
                    ):
                        api_candidates = _collect_code_search_candidates(repo_name)
                        if repo_name.lower() in missing_repo_targets:
                            continue
                        if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                            continue
                        _collect_api_file_details(repo_name, ref, api_candidates)
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        continue
                    if validated_input.file_paths:
                        _collect_explicit_file_details(repo_name, ref)
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        continue
                    if validated_input.directory_paths:
                        _collect_explicit_directory_details(repo_name, ref)
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        continue
                    if validated_input.commit_shas:
                        _collect_explicit_commit_details(repo_name)
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        continue
                    if validated_input.include_commit_list:
                        _collect_commit_list_details(repo_name)
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        continue
                    if validated_input.pull_numbers:
                        _collect_explicit_pull_request_details(repo_name)
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        continue
                    if validated_input.include_pull_requests:
                        _collect_pull_request_list_details(repo_name)
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        continue
                    if validated_input.issue_numbers:
                        _collect_explicit_issue_details(repo_name)
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        continue
                    if validated_input.include_issues:
                        _collect_issue_list_details(repo_name)
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        continue
                    if validated_input.compare_refs:
                        _collect_explicit_compare_details(repo_name)
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        continue
                    if validated_input.release_tags:
                        _collect_explicit_release_details(repo_name)
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        continue
                    if validated_input.include_releases:
                        _collect_release_list_details(repo_name)
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        continue
                    if validated_input.include_branches:
                        _collect_branch_list_details(repo_name)
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        continue
                    if validated_input.include_tags:
                        _collect_tag_list_details(repo_name)
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        continue
                    repo_search_errors = len(search_meta["errors"]) > repo_search_error_count
                    fallback_allowed = (
                        not validated_input.file_paths
                        and not validated_input.directory_paths
                        and not validated_input.commit_shas
                        and not validated_input.include_commit_list
                        and not validated_input.pull_numbers
                        and not validated_input.include_pull_requests
                        and not validated_input.issue_numbers
                        and not validated_input.include_issues
                        and not validated_input.compare_refs
                        and not validated_input.release_tags
                        and not validated_input.include_releases
                        and not validated_input.include_branches
                        and not validated_input.include_tags
                        and (
                            not validated_input.api_search_first
                            or (search_meta["unavailable"] and not search_meta.get("limit_failed"))
                            or (not api_candidates and not repo_search_errors)
                        )
                    )
                    if fallback_allowed:
                        if validated_input.api_search_first:
                            search_meta["fallback_reason"] = (
                                "api_unavailable" if search_meta["unavailable"] else "no_api_candidates"
                            )
                        fallback_attempt: dict[str, Any] = {
                            "repo": repo_name,
                            "ref": ref,
                            "reason": search_meta.get("fallback_reason") or "api_search_disabled",
                            "returned": 0,
                            "selected": 0,
                            "invalid": 0,
                            "out_of_scope": 0,
                            "skipped": 0,
                        }
                        try:
                            blobs = gh.list_paths_matching(
                                repo_name,
                                ref,
                                hot_paths=validated_input.hot_paths,
                            )
                            fallback_attempt["returned"] = len(blobs)
                        except Exception as exc:  # noqa: BLE001
                            missing_repo = _github_missing_repo_error(repo_name, exc)
                            if missing_repo is not None:
                                missing_repo_targets.add(repo_name.lower())
                                search_meta["errors"].append(missing_repo)
                                errors.append(missing_repo)
                                fallback_attempt.update({
                                    "phase": "list_paths_matching",
                                    "error": missing_repo.get("error") or repr(exc),
                                    "status_code": missing_repo.get("status_code"),
                                    "missing_repo": True,
                                })
                                blobs = []
                            else:
                                status_code = _http_status_code(exc)
                                err = {
                                    "target": repo_name,
                                    "phase": "list_paths_matching",
                                    "ref": ref,
                                    "fallback_reason": search_meta.get("fallback_reason"),
                                    "error": repr(exc),
                                    "status_code": status_code,
                                }
                                search_meta["errors"].append(err)
                                errors.append(err)
                                auth_failed = _github_api_auth_failed(exc)
                                limit_failed = _github_api_limit_failed(exc)
                                if auth_failed:
                                    search_meta["auth_failed"] = True
                                if limit_failed:
                                    search_meta["limit_failed"] = True
                                fallback_attempt.update({
                                    "phase": "list_paths_matching",
                                    "error": repr(exc),
                                    "status_code": status_code,
                                })
                                if auth_failed:
                                    fallback_attempt["auth_failed"] = True
                                if limit_failed:
                                    fallback_attempt["limit_failed"] = True
                                blobs = []
                        search_meta["fallback_attempts"].append(fallback_attempt)
                        if repo_name.lower() in missing_repo_targets:
                            continue
                        selected_blobs = blobs[: validated_input.max_files_per_repo]
                        fallback_attempt["selected"] = len(selected_blobs)
                        if len(blobs) > len(selected_blobs):
                            fallback_attempt["candidate_limit_hit"] = True
                            fallback_attempt["limit_skipped"] = len(blobs) - len(selected_blobs)
                        empty_fallback = (
                            not blobs
                            and not fallback_attempt.get("error")
                            and not fallback_attempt.get("phase")
                        )
                        if empty_fallback and not validated_input.include_commits:
                            _record_empty_github_list(
                                fallback_attempt,
                                file_details,
                                repo_name=repo_name,
                                candidate_source="hot_path_tree",
                                candidate_query="",
                                error="GitHub hot-path fallback returned no candidates",
                                extra_detail={
                                    "ref": ref,
                                    "fallback_reason": fallback_attempt["reason"],
                                },
                            )
                        search_meta["fallback_hot_path_tree"] += len(selected_blobs)
                        fallback_out_of_scope = 0
                        fallback_invalid = 0
                        for blob in selected_blobs:
                            blob_repo = str(getattr(blob, "repo", "") or "").strip()
                            blob_path = str(getattr(blob, "path", "") or "").strip()
                            blob_sha = str(getattr(blob, "sha", "") or "").strip()
                            blob_ref = str(getattr(blob, "ref", "") or "").strip()
                            if blob_repo.lower() != repo_name.lower():
                                search_meta["out_of_scope_count"] += 1
                                fallback_out_of_scope += 1
                                fallback_attempt["out_of_scope"] = fallback_out_of_scope
                                file_details.append({
                                    "repo": blob_repo,
                                    "target_repo": repo_name,
                                    "path": blob_path,
                                    "ref": blob_ref,
                                    "sha": blob_sha,
                                    "size": int(getattr(blob, "size", 0) or 0),
                                    "candidate_source": "hot_path_tree",
                                    "candidate_query": "",
                                    "status": "skipped",
                                    "error": "GitHub hot-path blob candidate out of requested repo scope",
                                })
                                continue
                            invalid_blob_path = _invalid_github_repo_path_reason(
                                blob_path,
                                subject="GitHub hot-path blob candidate",
                            )
                            if not blob_repo or invalid_blob_path or not blob_sha or not blob_ref:
                                fallback_invalid += 1
                                fallback_attempt["invalid"] = fallback_invalid
                                err = {
                                    "target": blob_repo or repo_name,
                                    "phase": "blob_candidate",
                                    "path": blob_path,
                                    "sha": blob_sha,
                                    "ref": blob_ref,
                                    "error": (
                                        invalid_blob_path
                                        or "GitHub hot-path blob candidate missing repo, path, sha, or ref"
                                    ),
                                    "candidate_source": "hot_path_tree",
                                    "candidate_query": "",
                                }
                                search_meta["detail_errors"].append(err)
                                errors.append(err)
                                file_details.append({
                                    "repo": blob_repo,
                                    "target_repo": repo_name,
                                    "path": blob_path,
                                    "ref": blob_ref,
                                    "sha": blob_sha,
                                    "candidate_source": "hot_path_tree",
                                    "candidate_query": "",
                                    "status": "error",
                                    "error": err["error"],
                                })
                                continue
                            file_detail = {
                                "repo": blob_repo,
                                "path": blob_path,
                                "ref": blob_ref,
                                "sha": blob_sha,
                                "size": int(getattr(blob, "size", 0) or 0),
                                "candidate_source": "hot_path_tree",
                                "candidate_query": "",
                                "status": "pending",
                            }
                            file_details.append(file_detail)
                            try:
                                text = gh.fetch_blob_text(blob_repo, blob_sha)
                            except Exception as exc:  # noqa: BLE001
                                err = {
                                    "target": blob_repo,
                                    "phase": "fetch_blob_text",
                                    "path": blob_path,
                                    "sha": blob_sha,
                                    "ref": blob_ref,
                                    "error": repr(exc),
                                    "status_code": _http_status_code(exc),
                                    "candidate_source": "hot_path_tree",
                                    "candidate_query": "",
                                }
                                search_meta["detail_errors"].append(err)
                                errors.append(err)
                                file_detail["status"] = "error"
                                file_detail["status_code"] = err["status_code"]
                                file_detail["error"] = err["error"]
                                if _github_api_auth_failed(exc):
                                    search_meta["auth_failed"] = True
                                    break
                                if _github_api_limit_failed(exc):
                                    search_meta["limit_failed"] = True
                                    break
                                continue
                            if text is None or not str(text).strip():
                                file_detail["status"] = "missing" if text is None else "empty"
                                file_detail["content_present"] = False
                                search_meta["detail_missing"] += 1
                                continue
                            file_detail["status"] = "fetched"
                            file_detail["content_present"] = True
                            search_meta["detail_fetched"] += 1
                            artifacts.append(_Artifact(
                                task_type="github",
                                asset=f"github:{blob_repo}/{blob_path}",
                                asset_kind="repository_file",
                                label=f"gh://{blob_repo}/{blob_path}@{blob_ref}",
                                text=text,
                                metadata={
                                    "repo": blob_repo,
                                    "path": blob_path,
                                    "sha": blob_sha,
                                    "size": blob.size,
                                    "ref": blob_ref,
                                    "scan_method": "fallback_hot_path_tree_scan",
                                    "candidate_source": "hot_path_tree",
                                },
                            ))
                        if fallback_out_of_scope:
                            fallback_attempt["out_of_scope"] = fallback_out_of_scope
                        fallback_attempt["skipped"] = (
                            int(fallback_attempt.get("invalid") or 0)
                            + int(fallback_attempt.get("out_of_scope") or 0)
                            + int(fallback_attempt.get("limit_skipped") or 0)
                        )
                        for blob in blobs[len(selected_blobs):]:
                            blob_repo = str(getattr(blob, "repo", "") or "").strip()
                            blob_path = str(getattr(blob, "path", "") or "").strip()
                            blob_sha = str(getattr(blob, "sha", "") or "").strip()
                            blob_ref = str(getattr(blob, "ref", "") or "").strip()
                            file_details.append({
                                "repo": blob_repo or repo_name,
                                "target_repo": repo_name,
                                "path": blob_path,
                                "ref": blob_ref,
                                "sha": blob_sha,
                                "size": int(getattr(blob, "size", 0) or 0),
                                "candidate_source": "hot_path_tree",
                                "candidate_query": "",
                                "status": "skipped",
                                "error": "GitHub hot-path blob candidate beyond max_files_per_repo",
                            })
                    if (
                        validated_input.include_commits
                        and not validated_input.file_paths
                        and not validated_input.directory_paths
                        and not validated_input.issue_numbers
                        and not validated_input.include_issues
                        and not validated_input.pull_numbers
                        and not validated_input.include_pull_requests
                        and not validated_input.compare_refs
                        and not validated_input.include_commit_list
                        and not validated_input.release_tags
                        and not validated_input.include_releases
                        and not validated_input.include_branches
                        and not validated_input.include_tags
                        and not search_meta.get("auth_failed")
                        and not search_meta.get("limit_failed")
                    ):
                        # v3.78 G1: 마지막 스캔 sha 이후 새 commit 만 (재fetch dedup).
                        since_sha = state_domain.github_repo_get_scanned_sha(repo_name)
                        try:
                            commits = gh.recent_commit_patches(
                                repo_name,
                                limit=validated_input.commit_limit,
                                since_sha=since_sha,
                            )
                        except Exception as exc:  # noqa: BLE001
                            missing_repo = _github_missing_repo_error(repo_name, exc)
                            if missing_repo is not None:
                                search_meta["errors"].append(missing_repo)
                                errors.append(missing_repo)
                            else:
                                err = {
                                    "target": repo_name,
                                    "phase": "recent_commit_patches",
                                    "since_sha": since_sha,
                                    "error": repr(exc),
                                    "status_code": _http_status_code(exc),
                                    "candidate_source": "recent_commit_patches",
                                    "candidate_query": "",
                                }
                                search_meta["detail_errors"].append(err)
                                errors.append(err)
                                commit_details.append({
                                    "repo": repo_name,
                                    "sha": "",
                                    "candidate_source": "recent_commit_patches",
                                    "since_sha": since_sha,
                                    "status": "error",
                                    "status_code": err["status_code"],
                                    "error": err["error"],
                                })
                                if _github_api_auth_failed(exc):
                                    search_meta["auth_failed"] = True
                                if _github_api_limit_failed(exc):
                                    search_meta["limit_failed"] = True
                            commits = []
                        search_meta["commit_count"] += len(commits)
                        valid_commits: list[gh.GhCommitPatch] = []
                        for commit in commits:
                            commit_sha = str(getattr(commit, "sha", "") or "").strip()
                            commit_repo = str(getattr(commit, "repo", "") or "").strip()
                            if not commit_sha:
                                err = {
                                    "target": repo_name,
                                    "phase": "recent_commit_patch_candidate",
                                    "error": "commit patch candidate missing sha",
                                    "repo": commit_repo,
                                    "sha": commit_sha,
                                }
                                search_meta["errors"].append(err)
                                errors.append(err)
                                detail = {
                                    "repo": commit_repo,
                                    "target_repo": repo_name,
                                    "sha": commit_sha,
                                    "candidate_source": "recent_commit_patches",
                                    "status": "error",
                                    "error": err["error"],
                                }
                                if since_sha:
                                    detail["since_sha"] = since_sha
                                commit_details.append(detail)
                                continue
                            if commit_repo.lower() != repo_name.lower():
                                search_meta["out_of_scope_count"] += 1
                                detail = {
                                    "repo": commit_repo,
                                    "target_repo": repo_name,
                                    "sha": commit_sha,
                                    "candidate_source": "recent_commit_patches",
                                    "status": "skipped",
                                    "error": "GitHub commit patch candidate out of requested repo scope",
                                }
                                if since_sha:
                                    detail["since_sha"] = since_sha
                                commit_details.append(detail)
                                continue
                            valid_commits.append(commit)
                        commit_candidate_error = _collect_commit_patch_artifacts(
                            valid_commits,
                            source="recent_commit_patches",
                            since_sha=since_sha,
                        )
                        if valid_commits and not commit_candidate_error:
                            # newest-first → 첫 commit = 새 HEAD. persist 성공 후 전진(아래).
                            pending_cursor[repo_name] = valid_commits[0].sha
                except Exception as exc:  # keep scanning remaining repos
                    err = {
                        "target": repo_name,
                        "phase": "repo_detail",
                        "ref": ref,
                        "error": repr(exc),
                        "status_code": _http_status_code(exc),
                        "candidate_source": "repo_detail",
                        "candidate_query": "",
                    }
                    search_meta["detail_errors"].append(err)
                    errors.append(err)

        await asyncio.to_thread(_collect)
        search_meta["query_status_counts"] = _query_status_counts(search_meta["query_details"])
        search_meta["query_candidate_totals"] = _query_candidate_totals(search_meta["query_details"])
        search_meta["fallback_status_counts"] = _fallback_status_counts(search_meta["fallback_attempts"])
        search_meta["fallback_reason_counts"] = _fallback_reason_counts(search_meta["fallback_attempts"])
        search_meta["fallback_candidate_totals"] = _fallback_candidate_totals(
            search_meta["fallback_attempts"],
        )
        branch_summary_details = [
            detail for detail in branch_details
            if str(detail.get("status") or "").strip() != "listed"
        ]
        tag_summary_details = [
            detail for detail in tag_details
            if str(detail.get("status") or "").strip() != "listed"
        ]
        search_meta["detail_status_counts"] = _detail_status_counts(
            file_details,
            commit_details,
            pull_request_details,
            issue_details,
            compare_details,
            release_details,
            branch_summary_details,
            tag_summary_details,
        )
        search_meta["detail_status_by_kind"] = _detail_status_by_kind(
            file=file_details,
            commit=commit_details,
            pull_request=pull_request_details,
            issue=issue_details,
            compare=compare_details,
            release=release_details,
            branch=branch_summary_details,
            tag=tag_summary_details,
        )
        search_meta["detail_source_counts"] = _detail_source_counts(
            file_details,
            commit_details,
            pull_request_details,
            issue_details,
            compare_details,
            release_details,
            branch_summary_details,
            tag_summary_details,
        )
        search_meta["detail_status_by_source"] = _detail_status_by_source(
            file_details,
            commit_details,
            pull_request_details,
            issue_details,
            compare_details,
            release_details,
            branch_summary_details,
            tag_summary_details,
        )
        search_meta["detail_query_counts"] = _detail_query_counts(
            file_details,
            commit_details,
            pull_request_details,
            issue_details,
            compare_details,
            release_details,
            branch_summary_details,
            tag_summary_details,
        )
        search_meta["detail_status_by_query"] = _detail_status_by_query(
            file_details,
            commit_details,
            pull_request_details,
            issue_details,
            compare_details,
            release_details,
            branch_summary_details,
            tag_summary_details,
        )
        search_meta["detail_status_total"] = sum(search_meta["detail_status_counts"].values())
        search_meta["detail_error_summary"] = _detail_error_summary(search_meta["detail_errors"])
        valid_file_paths = _valid_github_file_paths(validated_input.file_paths)
        valid_directory_paths = _valid_github_directory_paths(validated_input.directory_paths)
        valid_commit_shas = _valid_github_commit_shas(validated_input.commit_shas)
        valid_pull_numbers = _valid_github_pull_numbers(validated_input.pull_numbers)
        valid_issue_numbers = _valid_github_issue_numbers(validated_input.issue_numbers)
        valid_compare_refs = _valid_github_compare_refs(validated_input.compare_refs)
        valid_release_tags = _valid_github_release_tags(validated_input.release_tags)
        target_details = github_target_errors + [
            {
                "repo": target["full_name"],
                "ref": validated_input.ref or target["default_branch"] or "main",
                "default_branch": target["default_branch"],
                "source": target.get("source") or "",
                **({
                    key: target[key]
                    for key in ("visibility", "private", "archived", "pushed_at", "size_kb")
                    if key in target
                }),
                **({"file_paths": valid_file_paths} if valid_file_paths else {}),
                **({"directory_paths": valid_directory_paths} if valid_directory_paths else {}),
                **({"commit_shas": valid_commit_shas} if valid_commit_shas else {}),
                **(
                    {"include_commit_list": True, "commit_limit": validated_input.commit_limit}
                    if validated_input.include_commit_list else {}
                ),
                **({"pull_numbers": valid_pull_numbers} if valid_pull_numbers else {}),
                **(
                    {"include_pull_requests": True, "pull_request_limit": validated_input.pull_request_limit}
                    if validated_input.include_pull_requests else {}
                ),
                **({"issue_numbers": valid_issue_numbers} if valid_issue_numbers else {}),
                **(
                    {"include_issues": True, "issue_limit": validated_input.issue_limit}
                    if validated_input.include_issues else {}
                ),
                **({"compare_refs": valid_compare_refs} if valid_compare_refs else {}),
                **({"release_tags": valid_release_tags} if valid_release_tags else {}),
                **(
                    {"include_releases": True, "release_limit": validated_input.release_limit}
                    if validated_input.include_releases else {}
                ),
                **(
                    {"include_branches": True, "branch_limit": validated_input.branch_limit}
                    if validated_input.include_branches else {}
                ),
                **(
                    {"include_tags": True, "tag_limit": validated_input.tag_limit}
                    if validated_input.include_tags else {}
                ),
            }
            for target in targets
        ]
        search_meta["target_status_counts"] = _target_status_counts(target_details)
        search_meta["target_source_counts"] = _target_source_counts(target_details)
        search_meta["target_status_by_source"] = _target_status_by_source(target_details)
        _enrich_github_artifacts(artifacts, targets=targets)
        scanned = _scan_artifacts(artifacts, high_entropy=True)
        search_meta["scan_summary"] = _scan_outcome_summary(artifacts, scanned)
        charter_ref = str(context.metadata.get("charter_ref") or "")
        evidence_ref = _write_evidence(
            evidence_dir=context.evidence_dir,
            domain="github",
            input_summary=validated_input.model_dump(),
            scanned=scanned,
            errors=errors,
            api_search=search_meta,
            charter_ref=charter_ref,
        )
        # ★ github 은 **등록하지 않는다** — 후보만 돌려주고 에이전트가 판단해 제출한다.
        #   근거는 `_persist_scanned_findings` docstring 참조(사용자 결정 2026-08-27).
        findings = await _persist_scanned_findings(
            context=context,
            source_tool=self.name,
            scanned=scanned,
            evidence_ref=evidence_ref,
            register=False,
        )
        search_meta["finding_summary"] = _finding_lifecycle_summary(findings)
        scan_status, recommended_status, status_reason = _scan_status_from_errors(
            errors=errors,
            artifacts_scanned=len(artifacts),
            api_search=search_meta,
        )
        context.metadata["_github_task_scan_status"] = scan_status
        context.metadata["_github_task_scan_recommended_status"] = recommended_status
        context.metadata["_github_task_scan_status_reason"] = status_reason or ""
        # commit dedup 커서 — **여기서 전진시키지 않는다** (2026-08-27).
        #
        # v3.78.1 주석은 "persist 성공 후에만 전진" 이었고 그때는 맞았다. 이 도구가
        # finding 을 직접 등록했으니 여기 도달 = 적재 완료였다. 그런데 github 은
        # `register=False` 로 바뀌어 **후보만 돌려주고 등록은 에이전트가** 한다.
        # 그대로 두면 제출이 거부되거나 워커가 죽어도 커서가 전진해서, 그 커밋들이
        # 다음 스캔에서 **영구히 건너뛰어진다** — 오늘 진짜 시크릿 하나가 그렇게
        # 사라졌다(제출 거부 → 워커 자체 기각 → 커서 전진).
        #
        # 종료 도구(`github_repo_set_status`)가 target 을 실제로 닫을 때 전진시킨다.
        # 워커가 죽으면 metadata 와 함께 사라지므로 전진하지 않는다(fail-closed).
        context.metadata["_github_pending_scanned_sha"] = {
            str(repo_name): str(sha) for repo_name, sha in pending_cursor.items()
        }
        _write_evidence(
            evidence_dir=context.evidence_dir,
            domain="github",
            input_summary=validated_input.model_dump(),
            scanned=scanned,
            errors=errors,
            findings=findings,
            api_search=search_meta,
            scan_status=scan_status,
            recommended_target_status=recommended_status,
            status_reason=status_reason,
            targets=[target["full_name"] for target in targets],
            target_details=target_details,
            file_details=file_details,
            commit_details=commit_details,
            pull_request_details=pull_request_details,
            issue_details=issue_details,
            compare_details=compare_details,
            release_details=release_details,
            branch_details=branch_details,
            tag_details=tag_details,
            out_path=evidence_ref,
            charter_ref=charter_ref,
        )
        return ToolSuccess(content=json.dumps(_payload(
            kind="github_task_scan",
            evidence_ref=evidence_ref,
            target_count=len(targets),
            artifacts_scanned=len(artifacts),
            findings=findings,
            errors=errors,
            extra={
                "repositories": [target["full_name"] for target in targets],
                "api_search": search_meta,
                "scan_status": scan_status,
                "recommended_target_status": recommended_status,
                "status_reason": status_reason,
                "charter_ref": charter_ref,
            },
        ), ensure_ascii=False))


class JenkinsBuildTarget(BaseModel):
    job_full_name: str = Field(default="", description="Jenkins job full name.")
    build_number: int = Field(default=0, ge=1, description="Exact Jenkins build number.")


class ConfluencePageVersionTarget(BaseModel):
    page_id: str = Field(default="", description="Confluence page ID.")
    version: Any = Field(default=None, description="Explicit historical page version number.")


class ConfluenceAttachmentTarget(BaseModel):
    page_id: str = Field(default="", description="Confluence parent page ID.")
    download_url: str = Field(default="", description="Attachment download path from the URL.")


class ConfluenceCommentTarget(BaseModel):
    page_id: str = Field(default="", description="Confluence parent page ID.")
    comment_id: str = Field(default="", description="Explicit Confluence comment content ID.")


class ConfluenceTaskScanInput(BaseModel):
    space_keys: list[str] = Field(default_factory=list, description="Spaces to enumerate.")
    page_ids: list[str] = Field(default_factory=list, description="Explicit page IDs to scan.")
    comment_ids: list[ConfluenceCommentTarget] = Field(
        default_factory=list,
        description="Explicit page/comment pairs to detail-fetch from direct comment URLs.",
    )
    page_versions: list[ConfluencePageVersionTarget] = Field(
        default_factory=list,
        description="Explicit page/version pairs to detail-fetch from version or diff URLs.",
    )
    attachment_downloads: list[ConfluenceAttachmentTarget] = Field(
        default_factory=list,
        description="Explicit page/download_url pairs to exact-match from direct attachment URLs.",
    )
    cql: str | None = Field(
        default=None,
        description='CQL 전역 검색으로 타깃 시드. 예: text ~ "password". space 모를 때.',
    )
    all_spaces: bool = Field(
        default=False,
        description="space_keys/page_ids/cql 미지정 시 전사 space enum 후 스캔 (전사 점검).",
    )
    include_pages: bool = Field(
        default=False,
        description="Fetch a bounded page list for supplied spaces before broad CQL/fallback.",
    )
    include_blogposts: bool = Field(
        default=False,
        description="Fetch a bounded blogpost list for supplied spaces before broad CQL/fallback.",
    )
    include_attachments: bool = Field(
        default=False,
        description="For attachment-list URLs, list/fetch bounded text attachments for supplied page_ids only.",
    )
    page_limit_per_space: int = Field(default=50, ge=1, le=500)
    max_pages: int = Field(default=80, ge=1, le=500)
    title_keywords: list[str] = Field(
        default_factory=lambda: list(_DEFAULT_CONFLUENCE_TITLE_KEYWORDS),
    )
    api_search_first: bool = Field(
        default=True,
        description="space/page enumerate 전에 CQL 검색으로 후보 page를 먼저 선별.",
    )
    cql_terms: list[str] = Field(
        default_factory=lambda: list(_DEFAULT_CONFLUENCE_CQL_TERMS),
        description="api_search_first가 space/all_spaces에서 사용할 CQL 검색어.",
    )
    cql_limit_per_query: int = Field(default=25, ge=1, le=100)
    fetch_attachments: bool = True
    max_attachments_per_page: int = Field(default=5, ge=0, le=50)
    scan_comments: bool = Field(default=True, description="페이지 코멘트 본문도 스캔.")
    max_comments_per_page: int = Field(default=20, ge=0, le=200)
    scan_history: bool = Field(
        default=True, description="옛 페이지 버전 본문 스캔 (지워진 시크릿 포착).",
    )
    history_versions: int = Field(default=3, ge=1, le=20)
    high_entropy: bool = Field(
        default=True, description="키워드 없는 고엔트로피 토큰까지 포착 (confluence 기본 ON).",
    )


class ConfluenceTaskScanTool(Tool[ConfluenceTaskScanInput]):
    name: ClassVar[str] = "confluence_task_scan"
    domain: ClassVar[str] = "confluence"
    description: ClassVar[str] = (
        "High-level Confluence tasking: enumerate pages, prioritize sensitive titles, "
        "scan page bodies and text attachments, then update domain report state."
    )
    input_model: ClassVar[type[BaseModel]] = ConfluenceTaskScanInput
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "confluence task scan pages attachments credentials domain report"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "confluence task",
        "confluence scan",
        "wiki scan",
        "page scan",
    )
    prompt_section: ClassVar[str] = (
        "### confluence_task_scan(space_keys=[], cql=None, all_spaces=False, include_pages=False, include_blogposts=False, include_attachments=False)\n"
        "Confluence 점검 1순위. space 모르면 cql('text ~ \"password\"')/all_spaces=True "
        "로 전사. page-list URL이면 include_pages=True로 bounded page 목록만 API 열거. "
        "blog-list URL이면 include_blogposts=True로 bounded blogpost 목록만 API 열거. "
        "attachment-list URL이면 include_attachments=True로 page 첨부 목록만 API 열거. "
        "scan_comments·scan_history·high_entropy(기본 ON) → "
        "evidence+domain report+todo signal."
    )

    async def execute(
        self,
        validated_input: ConfluenceTaskScanInput,
        context: ToolContext,
    ) -> ToolResult:
        if not (
            validated_input.space_keys
            or validated_input.page_ids
            or validated_input.comment_ids
            or validated_input.page_versions
            or validated_input.attachment_downloads
            or validated_input.cql
            or validated_input.all_spaces
        ):
            return ToolError(
                kind="validation",
                message=(
                    "space_keys / page_ids / comment_ids / page_versions / attachment_downloads / "
                    "cql / all_spaces 중 하나 필요"
                ),
            )

        artifacts: list[_Artifact] = []
        errors: list[dict[str, Any]] = []
        page_targets: list[dict[str, Any]] = []
        confluence_target_errors: list[dict[str, Any]] = []
        page_details: list[dict[str, Any]] = []
        attachment_details: list[dict[str, Any]] = []
        comment_details: list[dict[str, Any]] = []
        version_details: list[dict[str, Any]] = []
        seen_page_ids: set[str] = set()
        search_meta: dict[str, Any] = {
            "enabled": bool(validated_input.api_search_first),
            "query_count": 0,
            "queries": [],
            "query_details": [],
            "candidate_count": 0,
            "duplicate_count": 0,
            "space_duplicate_count": 0,
            "detail_fetched": 0,
            "detail_missing": 0,
            "detail_errors": [],
            "errors": [],
            "auth_failed": False,
            "limit_failed": False,
            "fallback_list_pages": 0,
            "fallback_reason": None,
            "fallback_attempts": [],
            "list_no_candidates": 0,
            "space_list_attempts": [],
            "page_list_count": 0,
            "page_list_attempts": [],
            "blogpost_list_count": 0,
            "blogpost_list_attempts": [],
            "attachment_list_count": 0,
            "attachment_list_attempts": [],
            "candidate_limit_hit": False,
            "candidate_sources": {},
            "out_of_scope_count": 0,
            "page_body_none_missing": 0,
        }
        normalized_space_keys: list[str] = []
        seen_space_keys: set[str] = set()
        explicit_comment_ids: dict[str, set[str]] = {}
        seen_comment_targets: set[tuple[str, str]] = set()
        explicit_page_versions: dict[str, list[int]] = {}
        seen_page_version_pairs: set[tuple[str, int]] = set()
        explicit_attachment_downloads: dict[str, set[str]] = {}

        def _mark_confluence_limit_failure(err: dict[str, Any], exc: Exception) -> bool:
            if not _confluence_api_limit_failed(exc):
                return False
            err["limit_failed"] = True
            search_meta["limit_failed"] = True
            return True

        def _add_space_key(raw_space_key: Any, *, source: str = "space_key") -> bool:
            space_key = str(raw_space_key or "").strip()
            if not space_key:
                return False
            space_key_id = space_key.lower()
            if space_key_id in seen_space_keys:
                search_meta["space_duplicate_count"] += 1
                confluence_target_errors.append({
                    "space_key": space_key,
                    "source": source,
                    "status": "skipped",
                    "error": "duplicate space candidate",
                })
                return False
            seen_space_keys.add(space_key_id)
            normalized_space_keys.append(space_key)
            return True

        for idx, raw_space_key in enumerate(validated_input.space_keys):
            space_key = str(raw_space_key or "").strip()
            if _add_space_key(space_key, source=f"space_keys[{idx}]"):
                continue
            if space_key:
                continue
            err = {
                "target": f"space_keys[{idx}]",
                "phase": "space_candidate",
                "error": "Confluence space candidate missing space_key",
            }
            errors.append(err)
            search_meta["errors"].append(err)
            confluence_target_errors.append({
                "space_key": space_key,
                "source": f"space_keys[{idx}]",
                "status": "error",
                "error": err["error"],
            })

        def _add_page(
            page: dict[str, Any],
            *,
            source: str,
            query: str | None = None,
        ) -> bool:
            page_id = str(page.get("id") or "").strip()
            invalid_page_id = _invalid_confluence_page_id_reason(page_id)
            if invalid_page_id:
                page_title = str(page.get("title") or "").strip() or page_id or source
                err = {
                    "target": page_title,
                    "phase": "cql_candidate" if "cql" in source else "page_candidate",
                    "source": source,
                    "candidate_source": source,
                    "candidate_query": query or "",
                    "query": query or "",
                    "page_id": page_id,
                    "error": invalid_page_id,
                }
                errors.append(err)
                search_meta["errors"].append(err)
                search_meta["detail_errors"].append(err)
                confluence_target_errors.append({
                    "page_id": page_id,
                    "space_key": str(page.get("space_key") or "").strip(),
                    "title": page_title,
                    "candidate_source": source,
                    "candidate_query": query or "",
                    "status": "error",
                    "error": invalid_page_id,
                })
                page_details.append({
                    "page_id": page_id,
                    "space_key": str(page.get("space_key") or "").strip(),
                    "title": page_title,
                    "url": str(page.get("url") or ""),
                    "version": page.get("version") or 0,
                    "candidate_source": source,
                    "candidate_query": query or "",
                    "scan_method": (
                        "api_cql_search_detail_scan"
                        if "cql" in source
                        else "api_page_detail_scan"
                    ),
                    "status": "error",
                    "error": invalid_page_id,
                })
                return False
            if page_id in seen_page_ids:
                search_meta["duplicate_count"] += 1
                confluence_target_errors.append({
                    "page_id": page_id,
                    "space_key": str(page.get("space_key") or "").strip(),
                    "title": str(page.get("title") or page_id or source),
                    "candidate_source": source,
                    "candidate_query": query or "",
                    "status": "skipped",
                    "error": "duplicate page candidate",
                })
                page_details.append({
                    "page_id": page_id,
                    "space_key": str(page.get("space_key") or "").strip(),
                    "title": str(page.get("title") or page_id or source),
                    "url": str(page.get("url") or ""),
                    "version": page.get("version") or 0,
                    "candidate_source": source,
                    "candidate_query": query or "",
                    "scan_method": (
                        "api_cql_search_detail_scan"
                        if "cql" in source
                        else "api_page_detail_scan"
                    ),
                    "status": "skipped",
                    "error": "duplicate page candidate",
                })
                return False
            if len(page_targets) >= validated_input.max_pages:
                search_meta["candidate_limit_hit"] = True
                # de-domain 회귀 수정: limit-skip 은 detail 감사(page_details)에만 남기고
                # target 회계(confluence_target_errors→target_details)에는 넣지 않는다.
                # limit-skip 행이 target_details 로 새면 target_source_counts 가 실제 선택
                # target 수를 초과한다(codex 진단). 실제 오류(out-of-scope/duplicate/fetch)는
                # target error 로 계속 계상.
                page_details.append({
                    "page_id": page_id,
                    "space_key": str(page.get("space_key") or "").strip(),
                    "title": str(page.get("title") or page_id or source),
                    "url": str(page.get("url") or ""),
                    "version": page.get("version") or 0,
                    "candidate_source": source,
                    "candidate_query": query or "",
                    "scan_method": (
                        "api_cql_search_detail_scan"
                        if "cql" in source
                        else "api_page_detail_scan"
                    ),
                    "status": "skipped",
                    "error": "Confluence page candidate beyond max_pages",
                })
                return False
            seen_page_ids.add(page_id)
            item = dict(page)
            item["id"] = page_id
            item["space_key"] = str(item.get("space_key") or "").strip()
            item["title"] = str(item.get("title") or page_id).strip() or page_id
            item["_candidate_source"] = source
            item["_candidate_query"] = query or ""
            page_targets.append(item)
            sources = search_meta["candidate_sources"]
            sources[source] = int(sources.get(source) or 0) + 1
            return True

        def _title_score(page: cf.CfPage) -> int:
            title = page.title.lower()
            return sum(1 for keyword in validated_input.title_keywords if keyword.lower() in title)

        def _is_text_attachment(att: cf.CfAttachment) -> bool:
            media = (att.media_type or "").lower()
            filename = (att.filename or "").lower()
            return (
                media.startswith("text/")
                or "json" in media
                or "xml" in media
                or any(filename.endswith(suffix) for suffix in _TEXT_ATTACHMENT_HINTS)
            )

        def _append_skipped_page_scope_detail(
            page: cf.CfPage,
            *,
            source: str,
            query: str,
            target_space_key: str,
            scan_method: str,
        ) -> None:
            confluence_target_errors.append({
                "page_id": str(getattr(page, "id", "") or "").strip(),
                "space_key": str(getattr(page, "space_key", "") or "").strip(),
                "target_space_key": target_space_key,
                "title": str(getattr(page, "title", "") or ""),
                "candidate_source": source,
                "candidate_query": query,
                "status": "skipped",
                "error": "Confluence page candidate out of requested space scope",
            })
            page_details.append({
                "page_id": str(getattr(page, "id", "") or "").strip(),
                "space_key": str(getattr(page, "space_key", "") or "").strip(),
                "target_space_key": target_space_key,
                "title": str(getattr(page, "title", "") or ""),
                "url": str(getattr(page, "url", "") or ""),
                "version": getattr(page, "version", 0) or 0,
                "candidate_source": source,
                "candidate_query": query,
                "scan_method": scan_method,
                "status": "skipped",
                "error": "Confluence page candidate out of requested space scope",
            })

        def _append_skipped_page_limit_detail(
            page: cf.CfPage,
            *,
            source: str,
            query: str,
            scan_method: str,
            error: str,
        ) -> None:
            # de-domain 회귀 수정: limit-skip 은 detail 감사(page_details)에만 남기고 target
            # 회계(confluence_target_errors→target_details, 8916)에는 넣지 않는다. 새면
            # target_source_counts 가 실제 선택 target 수를 초과한다(codex 진단).
            page_details.append({
                "page_id": str(getattr(page, "id", "") or "").strip(),
                "space_key": str(getattr(page, "space_key", "") or "").strip(),
                "title": str(getattr(page, "title", "") or ""),
                "url": str(getattr(page, "url", "") or ""),
                "version": getattr(page, "version", 0) or 0,
                "candidate_source": source,
                "candidate_query": query,
                "scan_method": scan_method,
                "status": "skipped",
                "error": error,
            })

        def _collect_cql(
            cql: str,
            *,
            source: str,
            expected_space_key: str | None = None,
        ) -> int:
            if len(page_targets) >= validated_input.max_pages:
                return 0
            remaining = validated_input.max_pages - len(page_targets)
            search_meta["queries"].append(cql)
            search_meta["query_count"] += 1
            query_detail: dict[str, Any] = {
                "query": cql,
                "source": source,
                "space_key": expected_space_key or "",
                "status": "pending",
                "returned": 0,
                "added": 0,
                "invalid": 0,
                "out_of_scope": 0,
                "duplicate": 0,
                "skipped": 0,
            }
            search_meta["query_details"].append(query_detail)
            try:
                query_limit = remaining if source == "space_cql" else remaining + 1
                pages = cf.cql_search(
                    cql,
                    limit=min(validated_input.cql_limit_per_query, query_limit),
                )
            except Exception as exc:
                err = {
                    "target": f"cql:{cql}",
                    "phase": "cql_search",
                    "query": cql,
                    "source": source,
                    "space_key": expected_space_key or "",
                    "candidate_source": source,
                    "candidate_query": cql,
                    "error": repr(exc),
                    "status_code": _http_status_code(exc),
                }
                errors.append(err)
                search_meta["errors"].append(err)
                query_detail.update({
                    "status": "error",
                    "phase": "cql_search",
                    "error": err["error"],
                    "status_code": err["status_code"],
                })
                if _confluence_api_auth_failed(exc):
                    search_meta["auth_failed"] = True
                limit_failed = _mark_confluence_limit_failure(err, exc)
                if err.get("limit_failed"):
                    query_detail["limit_failed"] = True
                if expected_space_key:
                    confluence_target_errors.append({
                        "space_key": expected_space_key,
                        "source": source,
                        "candidate_query": cql,
                        "status": _confluence_space_error_status(err),
                        "phase": "cql_search",
                        "status_code": err["status_code"],
                        "limit_failed": limit_failed,
                        "error": err["error"],
                    })
                return 0
            added = 0
            query_detail["returned"] = len(pages)
            if not pages and source == "explicit_cql":
                query_detail["no_candidates"] = 1
                search_meta["list_no_candidates"] = int(
                    search_meta.get("list_no_candidates") or 0,
                ) + 1
                confluence_target_errors.append({
                    "target": f"cql:{cql}",
                    "source": source,
                    "candidate_query": cql,
                    "status": "skipped",
                    "phase": "cql_search",
                    "error": "Confluence CQL search returned no candidates",
                })
            for idx, page in enumerate(pages):
                if len(page_targets) >= validated_input.max_pages:
                    limit_skipped = len(pages) - idx
                    if limit_skipped > 0:
                        search_meta["candidate_limit_hit"] = True
                        query_detail["candidate_limit_hit"] = True
                        query_detail["limit_skipped"] = limit_skipped
                        for skipped_page in pages[idx:]:
                            _append_skipped_page_limit_detail(
                                skipped_page,
                                source=source,
                                query=cql,
                                scan_method="api_cql_search_detail_scan",
                                error="Confluence CQL candidate beyond max_pages",
                            )
                    break
                if expected_space_key is not None:
                    candidate_space = str(getattr(page, "space_key", "") or "").strip()
                    if not candidate_space:
                        search_meta["out_of_scope_count"] += 1
                        query_detail["out_of_scope"] += 1
                        _append_skipped_page_scope_detail(
                            page,
                            source=source,
                            query=cql,
                            target_space_key=expected_space_key,
                            scan_method="api_cql_search_detail_scan",
                        )
                        continue
                    if candidate_space.lower() != expected_space_key.lower():
                        search_meta["out_of_scope_count"] += 1
                        query_detail["out_of_scope"] += 1
                        _append_skipped_page_scope_detail(
                            page,
                            source=source,
                            query=cql,
                            target_space_key=expected_space_key,
                            scan_method="api_cql_search_detail_scan",
                        )
                        continue
                before_errors = len(errors)
                before_duplicates = int(search_meta.get("duplicate_count") or 0)
                if _add_page(asdict(page), source=source, query=cql):
                    added += 1
                elif int(search_meta.get("duplicate_count") or 0) > before_duplicates:
                    query_detail["duplicate"] += 1
                elif len(errors) > before_errors:
                    query_detail["invalid"] += 1
            if (
                len(page_targets) >= validated_input.max_pages
                and (added > 0 or len(pages) >= remaining)
            ):
                search_meta["candidate_limit_hit"] = True
            search_meta["candidate_count"] = len(page_targets)
            query_detail["added"] = added
            query_detail["skipped"] = (
                int(query_detail["invalid"])
                + int(query_detail["out_of_scope"])
                + int(query_detail["duplicate"])
                + int(query_detail.get("limit_skipped") or 0)
            )
            query_detail["status"] = "searched"
            return added

        def _record_page_version_candidate_error(
            *,
            source: str,
            page_id: str,
            version: Any,
            error: str,
        ) -> None:
            err = {
                "target": f"{page_id or '(missing)'}/version/{_candidate_label(version)}",
                "phase": "page_version_candidate",
                "source": source,
                "page_id": page_id,
                "version": version,
                "error": error,
            }
            errors.append(err)
            search_meta["detail_errors"].append(err)
            version_details.append({
                "page_id": page_id,
                "space_key": "",
                "page_title": page_id or source,
                "version": version,
                "candidate_source": source,
                "candidate_query": "",
                "status": "error",
                "error": error,
            })

        def _record_comment_candidate_error(
            *,
            source: str,
            page_id: str,
            comment_id: str,
            error: str,
        ) -> None:
            err = {
                "target": f"{page_id or '(missing)'}/comment/{comment_id or '(missing)'}",
                "phase": "comment_candidate",
                "source": source,
                "page_id": page_id,
                "comment_id": comment_id,
                "error": error,
            }
            errors.append(err)
            search_meta["detail_errors"].append(err)
            comment_details.append({
                "page_id": page_id,
                "space_key": "",
                "page_title": page_id or source,
                "comment_id": comment_id,
                "candidate_source": source,
                "candidate_query": "",
                "status": "error",
                "error": error,
            })

        def _record_attachment_candidate_error(
            *,
            source: str,
            page_id: str,
            download_url: str,
            error: str,
        ) -> None:
            err = {
                "target": f"{page_id or '(missing)'}/attachment/{download_url or '(missing)'}",
                "phase": "attachment_candidate",
                "source": source,
                "page_id": page_id,
                "download_url": download_url,
                "error": error,
            }
            errors.append(err)
            search_meta["detail_errors"].append(err)
            attachment_details.append({
                "page_id": page_id,
                "space_key": "",
                "page_title": page_id or source,
                "download_url": download_url,
                "candidate_source": source,
                "candidate_query": "",
                "status": "error",
                "error": error,
            })

        def _page_limit_blocks_new_target(page_id: str) -> bool:
            if page_id in seen_page_ids:
                return False
            if len(page_targets) < validated_input.max_pages:
                return False
            search_meta["candidate_limit_hit"] = True
            return True

        def _collect_space_page_listing(
            space_key: str,
            *,
            fallback_reason: str | None = None,
            candidate_source: str = "space_list",
        ) -> int:
            explicit_page_list = fallback_reason is None and candidate_source != "space_list"
            explicit_blogpost_list = candidate_source == "space_blogpost_list"
            if len(page_targets) >= validated_input.max_pages:
                search_meta["candidate_limit_hit"] = True
                if fallback_reason:
                    search_meta["fallback_attempts"].append({
                        "space_key": space_key,
                        "reason": fallback_reason,
                        "returned": 0,
                        "added": 0,
                        "skipped": "max_pages_reached",
                    })
                elif explicit_blogpost_list:
                    search_meta["blogpost_list_attempts"].append({
                        "space_key": space_key,
                        "source": candidate_source,
                        "reason": "explicit_blogpost_list",
                        "returned": 0,
                        "added": 0,
                        "skipped": "max_pages_reached",
                    })
                elif explicit_page_list:
                    search_meta["page_list_attempts"].append({
                        "space_key": space_key,
                        "source": candidate_source,
                        "reason": "explicit_page_list",
                        "returned": 0,
                        "added": 0,
                        "skipped": "max_pages_reached",
                    })
                return 0
            if fallback_reason and search_meta.get("fallback_reason") is None:
                search_meta["fallback_reason"] = fallback_reason
            attempt: dict[str, Any] | None = None
            if fallback_reason:
                attempt = {
                    "space_key": space_key,
                    "reason": fallback_reason,
                    "returned": 0,
                    "added": 0,
                    "invalid": 0,
                    "out_of_scope": 0,
                    "duplicate": 0,
                    "skipped": 0,
                }
            elif explicit_page_list:
                attempt = {
                    "space_key": space_key,
                    "source": candidate_source,
                    "reason": (
                        "explicit_blogpost_list"
                        if explicit_blogpost_list
                        else "explicit_page_list"
                    ),
                    "returned": 0,
                    "added": 0,
                    "invalid": 0,
                    "out_of_scope": 0,
                    "duplicate": 0,
                    "skipped": 0,
                }
            try:
                if explicit_blogpost_list:
                    pages = cf.list_blogposts(
                        space_key,
                        limit=validated_input.page_limit_per_space,
                    )
                else:
                    pages = cf.list_pages(
                        space_key,
                        limit=validated_input.page_limit_per_space,
                    )
            except Exception as exc:
                status_code = _http_status_code(exc)
                err = {
                    "target": space_key,
                    "phase": "list_blogposts" if explicit_blogpost_list else "list_pages",
                    "error": repr(exc),
                    "status_code": status_code,
                }
                errors.append(err)
                search_meta["errors"].append(err)
                confluence_target_errors.append({
                    "space_key": space_key,
                    "source": candidate_source if explicit_page_list else "list_pages",
                    "fallback_reason": fallback_reason or "",
                    "status": "error",
                    "phase": err["phase"],
                    "status_code": status_code,
                    "error": err["error"],
                })
                auth_failed = _confluence_api_auth_failed(exc)
                if auth_failed:
                    search_meta["auth_failed"] = True
                limit_failed = _mark_confluence_limit_failure(err, exc)
                if attempt is not None:
                    attempt.update({
                        "phase": err["phase"],
                        "error": repr(exc),
                        "status_code": status_code,
                    })
                    if auth_failed:
                        attempt["auth_failed"] = True
                    if limit_failed:
                        attempt["limit_failed"] = True
                    if fallback_reason:
                        search_meta["fallback_attempts"].append(attempt)
                    elif explicit_blogpost_list:
                        search_meta["blogpost_list_attempts"].append(attempt)
                    else:
                        search_meta["page_list_attempts"].append(attempt)
                return 0
            if attempt is not None:
                attempt["returned"] = len(pages)
            if not pages and attempt is not None:
                attempt["no_candidates"] = 1
                search_meta["list_no_candidates"] = int(
                    search_meta.get("list_no_candidates") or 0,
                ) + 1
                phase = "list_blogposts" if explicit_blogpost_list else "list_pages"
                source = candidate_source if explicit_page_list else "space_list"
                list_kind = "blogpost list" if explicit_blogpost_list else "page list"
                confluence_target_errors.append({
                    "space_key": space_key,
                    "source": source,
                    "fallback_reason": fallback_reason or "",
                    "status": "skipped",
                    "phase": phase,
                    "error": f"Confluence {list_kind} returned no candidates",
                })
            pages.sort(key=lambda page: (_title_score(page), page.version), reverse=True)
            added = 0
            out_of_scope = 0
            invalid = 0
            duplicate = 0
            processed = 0
            for page in pages:
                if len(page_targets) >= validated_input.max_pages:
                    search_meta["candidate_limit_hit"] = True
                    if attempt is not None:
                        attempt["candidate_limit_hit"] = True
                        attempt["limit_skipped"] = len(pages) - processed
                    scan_method = (
                        "api_blogpost_list_detail_scan"
                        if explicit_blogpost_list
                        else "api_page_detail_scan"
                    )
                    error = (
                        "Confluence blogpost-list candidate beyond max_pages"
                        if explicit_blogpost_list
                        else "Confluence page-list candidate beyond max_pages"
                    )
                    for skipped_page in pages[processed:]:
                        _append_skipped_page_limit_detail(
                            skipped_page,
                            source=candidate_source,
                            query=fallback_reason or "",
                            scan_method=scan_method,
                            error=error,
                        )
                    break
                processed += 1
                candidate_space = str(getattr(page, "space_key", "") or "").strip()
                if not candidate_space:
                    search_meta["out_of_scope_count"] += 1
                    out_of_scope += 1
                    if attempt is not None:
                        attempt["out_of_scope"] = out_of_scope
                    _append_skipped_page_scope_detail(
                        page,
                        source=candidate_source,
                        query=fallback_reason or "",
                        target_space_key=space_key,
                        scan_method=(
                            "api_blogpost_list_detail_scan"
                            if explicit_blogpost_list
                            else "api_page_detail_scan"
                        ),
                    )
                    continue
                if candidate_space.lower() != space_key.lower():
                    search_meta["out_of_scope_count"] += 1
                    out_of_scope += 1
                    if attempt is not None:
                        attempt["out_of_scope"] = out_of_scope
                    _append_skipped_page_scope_detail(
                        page,
                        source=candidate_source,
                        query=fallback_reason or "",
                        target_space_key=space_key,
                        scan_method=(
                            "api_blogpost_list_detail_scan"
                            if explicit_blogpost_list
                            else "api_page_detail_scan"
                        ),
                    )
                    continue
                before_errors = len(errors)
                before_duplicates = int(search_meta.get("duplicate_count") or 0)
                if _add_page(asdict(page), source=candidate_source):
                    if explicit_blogpost_list:
                        search_meta["blogpost_list_count"] += 1
                    elif explicit_page_list:
                        search_meta["page_list_count"] += 1
                    else:
                        search_meta["fallback_list_pages"] += 1
                    added += 1
                elif int(search_meta.get("duplicate_count") or 0) > before_duplicates:
                    duplicate += 1
                    if attempt is not None:
                        attempt["duplicate"] = duplicate
                elif len(errors) > before_errors:
                    invalid += 1
                    if attempt is not None:
                        attempt["invalid"] = invalid
            if attempt is not None:
                attempt["added"] = added
                attempt["skipped"] = (
                    int(attempt.get("invalid") or 0)
                    + int(attempt.get("out_of_scope") or 0)
                    + int(attempt.get("duplicate") or 0)
                    + int(attempt.get("limit_skipped") or 0)
                )
                if fallback_reason:
                    search_meta["fallback_attempts"].append(attempt)
                elif explicit_blogpost_list:
                    search_meta["blogpost_list_attempts"].append(attempt)
                else:
                    search_meta["page_list_attempts"].append(attempt)
            return added

        def _collect() -> None:
            for page_id in validated_input.page_ids:
                _add_page(
                    {
                        "id": page_id,
                        "title": page_id,
                        "space_key": "",
                        "url": "",
                        "version": 0,
                    },
                    source=(
                        "explicit_attachment_list"
                        if validated_input.include_attachments
                        else "explicit_page"
                    ),
                )
            for idx, target in enumerate(validated_input.comment_ids):
                source = f"comment_ids[{idx}]"
                page_id = str(target.page_id or "").strip()
                comment_id = str(target.comment_id or "").strip()
                invalid_page_id = _invalid_confluence_page_id_reason(page_id)
                if invalid_page_id:
                    _record_comment_candidate_error(
                        source=source,
                        page_id=page_id,
                        comment_id=comment_id,
                        error=invalid_page_id,
                    )
                    continue
                invalid_comment_id = _invalid_confluence_comment_id_reason(comment_id)
                if invalid_comment_id:
                    _record_comment_candidate_error(
                        source=source,
                        page_id=page_id,
                        comment_id=comment_id,
                        error=invalid_comment_id,
                    )
                    continue
                pair = (page_id, comment_id)
                if pair in seen_comment_targets:
                    search_meta["duplicate_count"] += 1
                    comment_details.append({
                        "page_id": page_id,
                        "space_key": "",
                        "page_title": page_id,
                        "comment_id": comment_id,
                        "candidate_source": "explicit_comment",
                        "candidate_query": "",
                        "status": "skipped",
                        "error": "duplicate comment candidate",
                    })
                    continue
                seen_comment_targets.add(pair)
                if _page_limit_blocks_new_target(page_id):
                    comment_details.append({
                        "page_id": page_id,
                        "space_key": "",
                        "page_title": page_id,
                        "comment_id": comment_id,
                        "candidate_source": "explicit_comment",
                        "candidate_query": "",
                        "status": "skipped",
                        "error": "Confluence comment candidate beyond max_pages",
                    })
                    continue
                explicit_comment_ids.setdefault(page_id, set()).add(comment_id)
                _add_page(
                    {
                        "id": page_id,
                        "title": page_id,
                        "space_key": "",
                        "url": "",
                        "version": 0,
                    },
                    source="explicit_comment",
                )
            for idx, target in enumerate(validated_input.page_versions):
                source = f"page_versions[{idx}]"
                page_id = str(target.page_id or "").strip()
                version_no = _positive_int_or_none(target.version)
                invalid_page_id = _invalid_confluence_page_id_reason(page_id)
                if invalid_page_id:
                    _record_page_version_candidate_error(
                        source=source,
                        page_id=page_id,
                        version=target.version,
                        error=invalid_page_id,
                    )
                    continue
                if version_no is None:
                    _record_page_version_candidate_error(
                        source=source,
                        page_id=page_id,
                        version=target.version,
                        error="Confluence page version candidate missing version number",
                    )
                    continue
                pair = (page_id, version_no)
                if pair in seen_page_version_pairs:
                    search_meta["duplicate_count"] += 1
                    version_details.append({
                        "page_id": page_id,
                        "space_key": "",
                        "page_title": page_id,
                        "version": version_no,
                        "candidate_source": "explicit_page_version",
                        "candidate_query": "",
                        "status": "skipped",
                        "error": "duplicate page version candidate",
                    })
                    continue
                seen_page_version_pairs.add(pair)
                if _page_limit_blocks_new_target(page_id):
                    version_details.append({
                        "page_id": page_id,
                        "space_key": "",
                        "page_title": page_id,
                        "version": version_no,
                        "candidate_source": "explicit_page_version",
                        "candidate_query": "",
                        "status": "skipped",
                        "error": "Confluence page version candidate beyond max_pages",
                    })
                    continue
                explicit_page_versions.setdefault(page_id, []).append(version_no)
                _add_page(
                    {
                        "id": page_id,
                        "title": page_id,
                        "space_key": "",
                        "url": "",
                        "version": 0,
                    },
                    source="explicit_page_version",
                )
            seen_attachment_targets: set[tuple[str, str]] = set()
            for idx, target in enumerate(validated_input.attachment_downloads):
                source = f"attachment_downloads[{idx}]"
                page_id = str(target.page_id or "").strip()
                download_url = str(target.download_url or "").strip()
                invalid_page_id = _invalid_confluence_page_id_reason(page_id)
                if invalid_page_id:
                    _record_attachment_candidate_error(
                        source=source,
                        page_id=page_id,
                        download_url=download_url,
                        error=invalid_page_id,
                    )
                    continue
                invalid_download_url = _invalid_confluence_attachment_download_reason(
                    download_url,
                    page_id=page_id,
                )
                if invalid_download_url:
                    _record_attachment_candidate_error(
                        source=source,
                        page_id=page_id,
                        download_url=download_url,
                        error=invalid_download_url,
                    )
                    continue
                pair = (page_id, download_url)
                if pair in seen_attachment_targets:
                    search_meta["duplicate_count"] += 1
                    attachment_details.append({
                        "page_id": page_id,
                        "space_key": "",
                        "page_title": page_id,
                        "download_url": download_url,
                        "candidate_source": "explicit_attachment",
                        "candidate_query": "",
                        "status": "skipped",
                        "error": "duplicate attachment candidate",
                    })
                    continue
                seen_attachment_targets.add(pair)
                if _page_limit_blocks_new_target(page_id):
                    attachment_details.append({
                        "page_id": page_id,
                        "space_key": "",
                        "page_title": page_id,
                        "download_url": download_url,
                        "candidate_source": "explicit_attachment",
                        "candidate_query": "",
                        "status": "skipped",
                        "error": "Confluence attachment candidate beyond max_pages",
                    })
                    continue
                explicit_attachment_downloads.setdefault(page_id, set()).add(download_url)
                _add_page(
                    {
                        "id": page_id,
                        "title": page_id,
                        "space_key": "",
                        "url": "",
                        "version": 0,
                    },
                    source="explicit_attachment",
                )

            # CQL 전역 검색으로 타깃 시드 (space 사전지식 불요).
            if validated_input.cql:
                _collect_cql(validated_input.cql, source="explicit_cql")
                if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                    return

            # 전사 enum: 명시 타깃이 전혀 없고 all_spaces 면 전 space 를 끌어온다.
            space_keys = list(normalized_space_keys)
            if (
                not space_keys
                and not validated_input.page_ids
                and not validated_input.comment_ids
                and not validated_input.page_versions
                and not validated_input.attachment_downloads
                and not validated_input.cql
                and validated_input.all_spaces
            ):
                attempt: dict[str, Any] = {
                    "source": "list_spaces",
                    "returned": 0,
                    "selected": 0,
                    "duplicate": 0,
                    "skipped": 0,
                }
                try:
                    spaces = list(cf.list_spaces())
                    attempt["returned"] = len(spaces)
                    for space in spaces:
                        space_key = str(getattr(space, "key", "") or "").strip()
                        if not space_key:
                            err = {
                                "target": "list_spaces",
                                "phase": "space_candidate",
                                "source": "list_spaces",
                                "error": "Confluence space candidate missing space_key",
                            }
                            errors.append(err)
                            search_meta["errors"].append(err)
                            attempt["invalid"] = int(attempt.get("invalid") or 0) + 1
                            attempt["skipped"] += 1
                            confluence_target_errors.append({
                                "space_key": "",
                                "source": "list_spaces",
                                "status": "error",
                                "phase": "space_candidate",
                                "error": err["error"],
                            })
                            continue
                        before_duplicates = int(search_meta.get("space_duplicate_count") or 0)
                        if _add_space_key(space_key, source="list_spaces"):
                            attempt["selected"] += 1
                        elif int(search_meta.get("space_duplicate_count") or 0) > before_duplicates:
                            attempt["duplicate"] += 1
                            attempt["skipped"] += 1
                    if not spaces:
                        attempt["no_candidates"] = 1
                        search_meta["list_no_candidates"] = int(
                            search_meta.get("list_no_candidates") or 0,
                        ) + 1
                        confluence_target_errors.append({
                            "space_key": "",
                            "target": "all_spaces",
                            "source": "list_spaces",
                            "status": "skipped",
                            "phase": "list_spaces",
                            "error": "Confluence space list returned no candidates",
                        })
                    search_meta["space_list_attempts"].append(attempt)
                    space_keys = list(normalized_space_keys)
                except Exception as exc:
                    err = {
                        "target": "all_spaces",
                        "phase": "list_spaces",
                        "error": repr(exc),
                        "status_code": _http_status_code(exc),
                    }
                    errors.append(err)
                    search_meta["errors"].append(err)
                    confluence_target_errors.append({
                        "space_key": "",
                        "target": "all_spaces",
                        "source": "list_spaces",
                        "status": "error",
                        "phase": "list_spaces",
                        "status_code": err["status_code"],
                        "error": err["error"],
                    })
                    if _confluence_api_auth_failed(exc):
                        search_meta["auth_failed"] = True
                        return
                    if _mark_confluence_limit_failure(err, exc):
                        return
                    attempt.update({
                        "phase": "list_spaces",
                        "error": err["error"],
                        "status_code": err["status_code"],
                    })
                    search_meta["space_list_attempts"].append(attempt)

            for space_key in space_keys:
                if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                    break
                if len(page_targets) >= validated_input.max_pages:
                    break
                if validated_input.include_pages:
                    _collect_space_page_listing(
                        space_key,
                        candidate_source="space_page_list",
                    )
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        break
                    continue
                if validated_input.include_blogposts:
                    _collect_space_page_listing(
                        space_key,
                        candidate_source="space_blogpost_list",
                    )
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        break
                    continue
                if validated_input.api_search_first:
                    before_count = len(page_targets)
                    before_error_count = len(search_meta["errors"])
                    for query in _confluence_search_queries(space_key, validated_input.cql_terms):
                        if len(page_targets) >= validated_input.max_pages:
                            break
                        _collect_cql(
                            query,
                            source="space_cql",
                            expected_space_key=space_key,
                        )
                        if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                            break
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        break
                    if (
                        len(page_targets) == before_count
                        and len(search_meta["errors"]) == before_error_count
                        and len(page_targets) < validated_input.max_pages
                    ):
                        _collect_space_page_listing(
                            space_key,
                            fallback_reason="no_api_candidates",
                        )
                    continue
                _collect_space_page_listing(space_key)
                if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                    break

            for page in page_targets[: validated_input.max_pages]:
                if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                    break
                page_id = str(page["id"])
                # v3.76: space key 있으면 asset 을 `confluence:SPACE:pageid` 로 (교차확인
                # 식별자=space). CQL/page_ids 경로(space 미상)는 legacy `confluence:pageid`.
                sk = str(page.get("space_key") or "").strip()
                aid = f"confluence:{sk}:{page_id}" if sk else f"confluence:{page_id}"
                candidate_source = str(page.get("_candidate_source") or "unknown")
                candidate_query = str(page.get("_candidate_query") or "")
                scan_method = (
                    "api_cql_search_detail_scan"
                    if "cql" in candidate_source
                    else "api_blogpost_list_detail_scan"
                    if candidate_source == "space_blogpost_list"
                    else "api_page_detail_scan"
                )
                exact_comment_ids = explicit_comment_ids.get(page_id)
                if exact_comment_ids:
                    for comment_id in sorted(exact_comment_ids):
                        detail = {
                            "page_id": page_id,
                            "space_key": sk,
                            "page_title": str(page.get("title") or ""),
                            "comment_id": comment_id,
                            "candidate_source": "explicit_comment",
                            "candidate_query": "",
                            "status": "pending",
                        }
                        comment_details.append(detail)
                        try:
                            comment = cf.fetch_comment_detail(comment_id)
                        except Exception as exc:
                            err = {
                                "target": f"{page_id}/comment/{comment_id}",
                                "phase": "fetch_comment_detail",
                                "comment_id": comment_id,
                                "error": repr(exc),
                                "status_code": _http_status_code(exc),
                                "candidate_source": "explicit_comment",
                                "candidate_query": "",
                            }
                            errors.append(err)
                            search_meta["detail_errors"].append(err)
                            detail["status"] = "error"
                            detail["status_code"] = err["status_code"]
                            detail["error"] = err["error"]
                            if _confluence_api_auth_failed(exc):
                                search_meta["auth_failed"] = True
                                break
                            if _mark_confluence_limit_failure(err, exc):
                                break
                            continue
                        if comment is None:
                            detail["status"] = "missing"
                            detail["content_present"] = False
                            search_meta["detail_missing"] += 1
                            continue
                        fetched_page_id = str(getattr(comment, "parent_page_id", "") or "").strip()
                        if fetched_page_id != page_id:
                            search_meta["out_of_scope_count"] += 1
                            detail["status"] = "skipped"
                            detail["fetched_page_id"] = fetched_page_id
                            detail["error"] = (
                                "Confluence comment candidate out of requested page scope"
                            )
                            continue
                        text = str(getattr(comment, "body", "") or "")
                        if not text.strip():
                            detail["status"] = "empty"
                            detail["content_present"] = False
                            search_meta["detail_missing"] += 1
                            continue
                        detail["status"] = "fetched"
                        detail["content_present"] = True
                        search_meta["detail_fetched"] += 1
                        artifacts.append(_Artifact(
                            task_type="confluence",
                            asset=f"{aid}/comment/{comment_id}",
                            asset_kind="comment",
                            label=f"confluence://page/{page_id}/comment/{comment_id}",
                            text=text,
                            metadata={
                                "page_id": page_id,
                                "comment_id": comment_id,
                                "space_key": sk,
                                "candidate_source": "explicit_comment",
                                "candidate_query": "",
                                "scan_method": "api_comment_detail_scan",
                            },
                        ))
                    if candidate_source == "explicit_comment":
                        continue
                page_explicit_versions = explicit_page_versions.get(page_id, [])
                if candidate_source == "explicit_page_version" and page_explicit_versions:
                    for version_no in page_explicit_versions:
                        detail = {
                            "page_id": page_id,
                            "space_key": sk,
                            "page_title": str(page.get("title") or ""),
                            "version": version_no,
                            "candidate_source": "explicit_page_version",
                            "candidate_query": "",
                            "status": "pending",
                        }
                        version_details.append(detail)
                        try:
                            old_body = cf.fetch_page_body_version(page_id, version_no)
                        except Exception as exc:
                            err = {
                                "target": f"{page_id}/version/{version_no}",
                                "phase": "fetch_page_body_version",
                                "version": version_no,
                                "error": repr(exc),
                                "status_code": _http_status_code(exc),
                                "candidate_source": "explicit_page_version",
                                "candidate_query": "",
                            }
                            errors.append(err)
                            search_meta["detail_errors"].append(err)
                            detail["status"] = "error"
                            detail["status_code"] = err["status_code"]
                            detail["error"] = err["error"]
                            if _confluence_api_auth_failed(exc):
                                search_meta["auth_failed"] = True
                                break
                            if _mark_confluence_limit_failure(err, exc):
                                break
                            continue
                        old_text = str(old_body or "")
                        if not old_text.strip():
                            detail["status"] = "missing" if old_body is None else "empty"
                            detail["content_present"] = False
                            search_meta["detail_missing"] += 1
                            continue
                        detail["status"] = "fetched"
                        detail["content_present"] = True
                        search_meta["detail_fetched"] += 1
                        artifacts.append(_Artifact(
                            task_type="confluence",
                            asset=f"{aid}/version/{version_no}",
                            asset_kind="page_version",
                            label=f"confluence://page/{page_id}/version/{version_no}",
                            text=old_text,
                            metadata={
                                "page_id": page_id,
                                "version": version_no,
                                "space_key": sk,
                                "candidate_source": "explicit_page_version",
                                "candidate_query": "",
                                "scan_method": "api_page_version_detail_scan",
                                "_current_page_signatures": [],
                            },
                        ))
                    continue
                exact_downloads = explicit_attachment_downloads.get(page_id)
                attachment_list_only = (
                    validated_input.include_attachments
                    and candidate_source == "explicit_attachment_list"
                )
                if (
                    (exact_downloads and candidate_source == "explicit_attachment")
                    or attachment_list_only
                ):
                    attachment_source = (
                        "explicit_attachment_list"
                        if attachment_list_only
                        else "explicit_attachment"
                    )
                    try:
                        listed_attachments = list(cf.list_attachments(page_id))
                    except Exception as exc:
                        status_code = _http_status_code(exc)
                        err = {
                            "target": f"{page_id}/attachments",
                            "phase": "list_attachments",
                            "error": repr(exc),
                            "status_code": status_code,
                            "candidate_source": attachment_source,
                            "candidate_query": "",
                        }
                        errors.append(err)
                        search_meta["detail_errors"].append(err)
                        attachment_details.append({
                            "page_id": page_id,
                            "space_key": sk,
                            "page_title": str(page.get("title") or ""),
                            "candidate_source": attachment_source,
                            "candidate_query": "",
                            "status": "error",
                            "status_code": err["status_code"],
                            "error": err["error"],
                        })
                        if attachment_list_only:
                            search_meta["attachment_list_attempts"].append({
                                "page_id": page_id,
                                "space_key": sk,
                                "source": attachment_source,
                                "returned": 0,
                                "text_candidates": 0,
                                "selected": 0,
                                "skipped_non_text": 0,
                                "candidate_limit_hit": False,
                                "phase": "list_attachments",
                                "error": err["error"],
                                "status_code": status_code,
                            })
                        if _confluence_api_auth_failed(exc):
                            search_meta["auth_failed"] = True
                            break
                        if _mark_confluence_limit_failure(err, exc):
                            break
                        continue
                    attempt: dict[str, Any] | None = None
                    if attachment_list_only:
                        text_attachments = [
                            att for att in listed_attachments
                            if _is_text_attachment(att)
                        ]
                        non_text_attachments = [
                            att for att in listed_attachments
                            if not _is_text_attachment(att)
                        ]
                        attachments = text_attachments[: validated_input.max_attachments_per_page]
                        skipped_text_attachments = text_attachments[
                            validated_input.max_attachments_per_page:
                        ]
                        candidate_limit_hit = len(text_attachments) > len(attachments)
                        limit_skipped = max(0, len(text_attachments) - len(attachments))
                        if candidate_limit_hit:
                            search_meta["candidate_limit_hit"] = True
                        attempt = {
                            "page_id": page_id,
                            "space_key": sk,
                            "source": attachment_source,
                            "returned": len(listed_attachments),
                            "text_candidates": len(text_attachments),
                            "selected": 0,
                            "skipped_non_text": max(0, len(listed_attachments) - len(text_attachments)),
                            "candidate_limit_hit": candidate_limit_hit,
                        }
                        if candidate_limit_hit:
                            attempt["limit_skipped"] = limit_skipped
                        search_meta["attachment_list_attempts"].append(attempt)
                        if not listed_attachments:
                            attempt["missing"] = 1
                            attachment_details.append({
                                "page_id": page_id,
                                "space_key": sk,
                                "page_title": str(page.get("title") or ""),
                                "candidate_source": attachment_source,
                                "candidate_query": "",
                                "status": "missing",
                                "content_present": False,
                                "error": (
                                    "Confluence attachment list returned no candidates"
                                ),
                            })
                            search_meta["detail_missing"] += 1
                        for non_text_att in non_text_attachments:
                            attachment_details.append({
                                "page_id": page_id,
                                "space_key": sk,
                                "page_title": str(page.get("title") or ""),
                                "attachment_id": str(getattr(non_text_att, "id", "") or "").strip(),
                                "filename": str(getattr(non_text_att, "filename", "") or "").strip(),
                                "download_url": str(
                                    getattr(non_text_att, "download_url", "") or ""
                                ).strip(),
                                "media_type": str(getattr(non_text_att, "media_type", "") or ""),
                                "candidate_source": attachment_source,
                                "candidate_query": "",
                                "status": "skipped",
                                "content_present": False,
                                "error": (
                                    "Confluence attachment-list candidate is not text"
                                ),
                            })
                    else:
                        skipped_text_attachments = []
                        exact_download_keys = {
                            _confluence_attachment_download_match_key(url)
                            for url in exact_downloads
                        }
                        attachments = [
                            att for att in listed_attachments
                            if _confluence_attachment_download_match_key(
                                str(getattr(att, "download_url", "") or "").strip()
                            )
                            in exact_download_keys
                        ]
                        matched_downloads = {
                            _confluence_attachment_download_match_key(
                                str(getattr(att, "download_url", "") or "").strip()
                            )
                            for att in attachments
                        }
                        for missing_url in sorted(
                            url
                            for url in exact_downloads
                            if _confluence_attachment_download_match_key(url)
                            not in matched_downloads
                        ):
                            attachment_details.append({
                                "page_id": page_id,
                                "space_key": sk,
                                "page_title": str(page.get("title") or ""),
                                "download_url": missing_url,
                                "candidate_source": attachment_source,
                                "candidate_query": "",
                                "status": "missing",
                                "content_present": False,
                                "error": "explicit attachment URL not found in page attachment list",
                            })
                            search_meta["detail_missing"] += 1
                    for att in attachments:
                        attachment_id = str(getattr(att, "id", "") or "").strip()
                        filename = str(getattr(att, "filename", "") or "").strip()
                        download_url = str(getattr(att, "download_url", "") or "").strip()
                        parent_page_id = str(getattr(att, "parent_page_id", "") or "").strip()
                        invalid_download_url = _invalid_confluence_attachment_download_reason(
                            download_url,
                            page_id=page_id,
                        )
                        detail = {
                            "page_id": page_id,
                            "space_key": sk,
                            "page_title": str(page.get("title") or ""),
                            "attachment_id": attachment_id,
                            "filename": filename,
                            "download_url": download_url,
                            "candidate_source": attachment_source,
                            "candidate_query": "",
                            "status": "pending",
                        }
                        attachment_details.append(detail)
                        if parent_page_id != page_id:
                            search_meta["out_of_scope_count"] += 1
                            detail["status"] = "skipped"
                            detail["fetched_page_id"] = parent_page_id
                            detail["error"] = (
                                "Confluence attachment candidate out of requested page scope"
                            )
                            if attempt is not None:
                                attempt["out_of_scope"] = int(attempt.get("out_of_scope") or 0) + 1
                            continue
                        if not attachment_id or not filename or invalid_download_url:
                            err = {
                                "target": f"{page_id}/attachment/{attachment_id or filename or '(missing)'}",
                                "phase": "attachment_candidate",
                                "error": (
                                    invalid_download_url
                                    or "Confluence attachment candidate missing id, filename, or download_url"
                                ),
                                "attachment_id": attachment_id,
                                "filename": filename,
                                "download_url": download_url,
                                "candidate_source": attachment_source,
                                "candidate_query": "",
                            }
                            errors.append(err)
                            search_meta["detail_errors"].append(err)
                            detail["status"] = "error"
                            detail["error"] = err["error"]
                            if attempt is not None:
                                attempt["invalid"] = int(attempt.get("invalid") or 0) + 1
                            continue
                        if attempt is not None:
                            attempt["selected"] = int(attempt.get("selected") or 0) + 1
                            search_meta["attachment_list_count"] += 1
                        try:
                            text = cf.fetch_attachment_text(download_url)
                        except Exception as exc:
                            err = {
                                "target": f"{page_id}/attachment/{attachment_id}",
                                "phase": "fetch_attachment_text",
                                "filename": filename,
                                "download_url": download_url,
                                "error": repr(exc),
                                "status_code": _http_status_code(exc),
                                "candidate_source": attachment_source,
                                "candidate_query": "",
                            }
                            errors.append(err)
                            search_meta["detail_errors"].append(err)
                            detail["status"] = "error"
                            detail["status_code"] = err["status_code"]
                            detail["error"] = err["error"]
                            if _confluence_api_auth_failed(exc):
                                search_meta["auth_failed"] = True
                                break
                            if _mark_confluence_limit_failure(err, exc):
                                break
                            continue
                        text_value = str(text or "")
                        if not text_value.strip():
                            detail["status"] = "missing" if text is None else "empty"
                            detail["content_present"] = False
                            search_meta["detail_missing"] += 1
                            continue
                        detail["status"] = "fetched"
                        detail["content_present"] = True
                        search_meta["detail_fetched"] += 1
                        artifacts.append(_Artifact(
                            task_type="confluence",
                            asset=f"{aid}/attachment/{filename}",
                            asset_kind="attachment",
                            label=f"confluence://page/{page_id}/attachment/{filename}",
                            text=text_value,
                            metadata={
                                "page_id": page_id,
                                "attachment_id": attachment_id,
                                "filename": filename,
                                "media_type": att.media_type,
                                "size": att.size,
                                "download_url": download_url,
                                "space_key": sk,
                                "candidate_source": attachment_source,
                                "candidate_query": "",
                                "scan_method": "api_attachment_detail_scan",
                                "_current_page_signatures": [],
                            },
                        ))
                    for skipped_att in skipped_text_attachments:
                        attachment_details.append({
                            "page_id": page_id,
                            "space_key": sk,
                            "page_title": str(page.get("title") or ""),
                            "attachment_id": str(getattr(skipped_att, "id", "") or "").strip(),
                            "filename": str(getattr(skipped_att, "filename", "") or "").strip(),
                            "download_url": str(
                                getattr(skipped_att, "download_url", "") or ""
                            ).strip(),
                            "candidate_source": attachment_source,
                            "candidate_query": "",
                            "status": "skipped",
                            "error": (
                                "Confluence attachment-list candidate beyond "
                                "max_attachments_per_page"
                            ),
                        })
                    if attempt is not None:
                        candidate_skipped = (
                            int(attempt.get("limit_skipped") or 0)
                            + int(attempt.get("out_of_scope") or 0)
                            + int(attempt.get("invalid") or 0)
                        )
                        skipped = (
                            int(attempt.get("skipped_non_text") or 0)
                            + candidate_skipped
                        )
                        if skipped:
                            attempt["skipped"] = skipped
                    continue
                page_detail = {
                    "page_id": page_id,
                    "space_key": sk,
                    "title": str(page.get("title") or page_id),
                    "url": str(page.get("url") or ""),
                    "version": page.get("version") or 0,
                    "candidate_source": candidate_source,
                    "candidate_query": candidate_query,
                    "scan_method": scan_method,
                    "status": "pending",
                }
                page_details.append(page_detail)
                try:
                    current_body: str | None = None
                    current_signatures: list[dict[str, str]] = []
                    try:
                        body = cf.fetch_page_body(page_id)
                    except Exception as exc:
                        err = {
                            "target": page_id,
                            "phase": "fetch_page_body",
                            "error": repr(exc),
                            "status_code": _http_status_code(exc),
                            "candidate_source": candidate_source,
                            "candidate_query": candidate_query,
                        }
                        errors.append(err)
                        search_meta["detail_errors"].append(err)
                        page_detail["status"] = "error"
                        page_detail["status_code"] = err["status_code"]
                        page_detail["error"] = err["error"]
                        if _confluence_api_auth_failed(exc):
                            search_meta["auth_failed"] = True
                            break
                        if _mark_confluence_limit_failure(err, exc):
                            break
                        continue
                    body_text = str(body or "")
                    if body_text.strip():
                        page_detail["status"] = "fetched"
                        page_detail["body_present"] = True
                        search_meta["detail_fetched"] += 1
                        current_body = body_text
                        current_signatures = _hit_signatures_from_text(
                            body_text,
                            high_entropy=validated_input.high_entropy,
                        )
                        title = str(page.get("title") or page_id)
                        artifacts.append(_Artifact(
                            task_type="confluence",
                            asset=aid,
                            asset_kind="page",
                            label=f"confluence://page/{page_id}",
                            text=body_text,
                            metadata={
                                "page_id": page_id,
                                "title": title,
                                "space_key": sk,
                                "url": page.get("url") or "",
                                "version": page.get("version") or 0,
                                "candidate_source": candidate_source,
                                "candidate_query": candidate_query,
                                "scan_method": scan_method,
                                "_current_page_signatures": current_signatures,
                            },
                        ))
                    else:
                        page_detail["status"] = "missing" if body is None else "empty"
                        page_detail["body_present"] = False
                        search_meta["detail_missing"] += 1
                        if body is None:
                            search_meta["page_body_none_missing"] += 1
                    # 코멘트 — 평문 자격증명이 코멘트로 붙는 유출 경로. 독립 try:
                    # 코멘트/히스토리 API 실패가 본문/첨부 스캔을 죽이지 않게.
                    if validated_input.scan_comments:
                        try:
                            comments = list(cf.list_comments(page_id))
                            selected_comments = comments[
                                : validated_input.max_comments_per_page
                            ]
                            skipped_comments = comments[
                                validated_input.max_comments_per_page:
                            ]
                            if skipped_comments:
                                search_meta["candidate_limit_hit"] = True
                            for idx, comment_text in enumerate(selected_comments):
                                text = str(comment_text or "")
                                detail = {
                                    "page_id": page_id,
                                    "space_key": sk,
                                    "page_title": str(page.get("title") or ""),
                                    "comment_index": idx,
                                    "candidate_source": candidate_source,
                                    "candidate_query": candidate_query,
                                    "status": "pending",
                                }
                                comment_details.append(detail)
                                if not text.strip():
                                    detail["status"] = "missing" if comment_text is None else "empty"
                                    detail["content_present"] = False
                                    search_meta["detail_missing"] += 1
                                    continue
                                detail["status"] = "fetched"
                                detail["content_present"] = True
                                search_meta["detail_fetched"] += 1
                                artifacts.append(_Artifact(
                                    task_type="confluence",
                                    asset=f"{aid}/comment/{idx}",
                                    asset_kind="comment",
                                    label=f"confluence://page/{page_id}/comment/{idx}",
                                    text=text,
                                    metadata={
                                        "page_id": page_id,
                                        "comment_index": idx,
                                        "space_key": sk,
                                        "candidate_source": candidate_source,
                                        "candidate_query": candidate_query,
                                        "scan_method": scan_method,
                                        "_current_page_signatures": current_signatures,
                                    },
                                ))
                            for skipped_idx, _comment_text in enumerate(
                                skipped_comments,
                                start=len(selected_comments),
                            ):
                                comment_details.append({
                                    "page_id": page_id,
                                    "space_key": sk,
                                    "page_title": str(page.get("title") or ""),
                                    "comment_index": skipped_idx,
                                    "candidate_source": candidate_source,
                                    "candidate_query": candidate_query,
                                    "status": "skipped",
                                    "error": (
                                        "Confluence comment candidate beyond "
                                        "max_comments_per_page"
                                    ),
                                })
                        except Exception as exc:
                            err = {
                                "target": f"{page_id}/comments",
                                "phase": "list_comments",
                                "error": repr(exc),
                                "status_code": _http_status_code(exc),
                                "candidate_source": candidate_source,
                                "candidate_query": candidate_query,
                            }
                            errors.append(err)
                            search_meta["detail_errors"].append(err)
                            comment_details.append({
                                "page_id": page_id,
                                "space_key": sk,
                                "page_title": str(page.get("title") or ""),
                                "candidate_source": candidate_source,
                                "candidate_query": candidate_query,
                                "status": "error",
                                "status_code": err["status_code"],
                                "error": err["error"],
                            })
                            if _confluence_api_auth_failed(exc):
                                search_meta["auth_failed"] = True
                                break
                            if _mark_confluence_limit_failure(err, exc):
                                break
                    # 버전 히스토리 — 현재 페이지에서 지운 시크릿이 옛 버전에 남은 케이스.
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        break
                    page_explicit_versions = explicit_page_versions.get(page_id, [])
                    if validated_input.scan_history or page_explicit_versions:
                        try:
                            versions = cf.list_page_versions(page_id) if validated_input.scan_history else []
                        except Exception as exc:
                            err = {
                                "target": f"{page_id}/history",
                                "phase": "list_page_versions",
                                "error": repr(exc),
                                "status_code": _http_status_code(exc),
                                "candidate_source": candidate_source,
                                "candidate_query": candidate_query,
                            }
                            errors.append(err)
                            search_meta["detail_errors"].append(err)
                            version_details.append({
                                "page_id": page_id,
                                "space_key": sk,
                                "page_title": str(page.get("title") or ""),
                                "candidate_source": candidate_source,
                                "candidate_query": candidate_query,
                                "status": "error",
                                "status_code": err["status_code"],
                                "error": err["error"],
                            })
                            if _confluence_api_auth_failed(exc):
                                search_meta["auth_failed"] = True
                                break
                            if _mark_confluence_limit_failure(err, exc):
                                break
                            versions = []
                        current_ver = _positive_int_or_none(page.get("version"))
                        version_candidates: list[tuple[Any, str, str]] = []
                        seen_versions_for_page: set[int] = set()
                        for explicit_version in page_explicit_versions:
                            version_candidates.append((explicit_version, "explicit_page_version", ""))
                            seen_versions_for_page.add(explicit_version)
                        for ver in versions:
                            parsed_version = _positive_int_or_none(ver)
                            if parsed_version is not None and parsed_version in seen_versions_for_page:
                                continue
                            if parsed_version is not None:
                                seen_versions_for_page.add(parsed_version)
                            version_candidates.append((ver, candidate_source, candidate_query))
                        history_scanned_count = 0
                        for idx, (ver, version_source, version_query) in enumerate(
                            version_candidates,
                        ):
                            if (
                                version_source != "explicit_page_version"
                                and history_scanned_count >= validated_input.history_versions
                            ):
                                search_meta["candidate_limit_hit"] = True
                                for skipped_ver, skipped_source, skipped_query in version_candidates[
                                    idx:
                                ]:
                                    version_details.append({
                                        "page_id": page_id,
                                        "space_key": sk,
                                        "page_title": str(page.get("title") or ""),
                                        "version": skipped_ver,
                                        "candidate_source": skipped_source,
                                        "candidate_query": skipped_query,
                                        "status": "skipped",
                                        "error": "Confluence page version candidate beyond history_versions",
                                    })
                                break
                            version_no = _positive_int_or_none(ver)
                            if version_no is None:
                                err = {
                                    "target": f"{page_id}/version/{_candidate_label(ver)}",
                                    "phase": "page_version_candidate",
                                    "version": ver,
                                    "error": "Confluence page version candidate missing version number",
                                    "candidate_source": version_source,
                                    "candidate_query": version_query,
                                }
                                errors.append(err)
                                search_meta["detail_errors"].append(err)
                                version_details.append({
                                    "page_id": page_id,
                                    "space_key": sk,
                                    "page_title": str(page.get("title") or ""),
                                    "version": ver,
                                    "candidate_source": version_source,
                                    "candidate_query": version_query,
                                    "status": "error",
                                    "error": err["error"],
                                })
                                continue
                            if current_ver is not None and version_no == current_ver:
                                if version_source == "explicit_page_version":
                                    version_details.append({
                                        "page_id": page_id,
                                        "space_key": sk,
                                        "page_title": str(page.get("title") or ""),
                                        "version": version_no,
                                        "candidate_source": version_source,
                                        "candidate_query": version_query,
                                        "status": "current_version",
                                        "content_present": bool(current_body and current_body.strip()),
                                    })
                                continue
                            detail = {
                                "page_id": page_id,
                                "space_key": sk,
                                "page_title": str(page.get("title") or ""),
                                "version": version_no,
                                "candidate_source": version_source,
                                "candidate_query": version_query,
                                "status": "pending",
                            }
                            version_details.append(detail)
                            try:
                                old_body = cf.fetch_page_body_version(page_id, version_no)
                            except Exception as exc:
                                err = {
                                    "target": f"{page_id}/version/{version_no}",
                                    "phase": "fetch_page_body_version",
                                    "version": version_no,
                                    "error": repr(exc),
                                    "status_code": _http_status_code(exc),
                                    "candidate_source": version_source,
                                    "candidate_query": version_query,
                                }
                                errors.append(err)
                                search_meta["detail_errors"].append(err)
                                detail["status"] = "error"
                                detail["status_code"] = err["status_code"]
                                detail["error"] = err["error"]
                                if _confluence_api_auth_failed(exc):
                                    search_meta["auth_failed"] = True
                                    break
                                if _mark_confluence_limit_failure(err, exc):
                                    break
                                continue
                            old_text = str(old_body or "")
                            if not old_text.strip():
                                detail["status"] = "missing" if old_body is None else "empty"
                                detail["content_present"] = False
                                search_meta["detail_missing"] += 1
                                continue
                            if old_text == current_body:
                                detail["status"] = "same_as_current"
                                detail["content_present"] = True
                                continue
                            detail["status"] = "fetched"
                            detail["content_present"] = True
                            if version_source != "explicit_page_version":
                                history_scanned_count += 1
                            search_meta["detail_fetched"] += 1
                            artifacts.append(_Artifact(
                                task_type="confluence",
                                asset=f"{aid}/version/{version_no}",
                                asset_kind="page_version",
                                label=f"confluence://page/{page_id}/version/{version_no}",
                                text=old_text,
                                metadata={
                                    "page_id": page_id,
                                    "version": version_no,
                                    "space_key": sk,
                                    "candidate_source": version_source,
                                    "candidate_query": version_query,
                                    "scan_method": scan_method,
                                    "_current_page_signatures": current_signatures,
                                },
                            ))
                    if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                        break
                    if validated_input.fetch_attachments:
                        exact_downloads = explicit_attachment_downloads.get(page_id)
                        try:
                            listed_attachments = list(cf.list_attachments(page_id))
                        except Exception as exc:
                            err = {
                                "target": f"{page_id}/attachments",
                                "phase": "list_attachments",
                                "error": repr(exc),
                                "status_code": _http_status_code(exc),
                                "candidate_source": candidate_source,
                                "candidate_query": candidate_query,
                            }
                            errors.append(err)
                            search_meta["detail_errors"].append(err)
                            attachment_details.append({
                                "page_id": page_id,
                                "space_key": sk,
                                "page_title": str(page.get("title") or ""),
                                "candidate_source": candidate_source,
                                "candidate_query": candidate_query,
                                "status": "error",
                                "status_code": err["status_code"],
                                "error": err["error"],
                            })
                            if _confluence_api_auth_failed(exc):
                                search_meta["auth_failed"] = True
                                break
                            if _mark_confluence_limit_failure(err, exc):
                                break
                            listed_attachments = []
                        if exact_downloads:
                            exact_download_keys = {
                                _confluence_attachment_download_match_key(url)
                                for url in exact_downloads
                            }
                            attachments = [
                                att for att in listed_attachments
                                if _confluence_attachment_download_match_key(
                                    str(getattr(att, "download_url", "") or "").strip()
                                )
                                in exact_download_keys
                            ]
                            matched_downloads = {
                                _confluence_attachment_download_match_key(
                                    str(getattr(att, "download_url", "") or "").strip()
                                )
                                for att in attachments
                            }
                            for missing_url in sorted(
                                url
                                for url in exact_downloads
                                if _confluence_attachment_download_match_key(url)
                                not in matched_downloads
                            ):
                                attachment_details.append({
                                    "page_id": page_id,
                                    "space_key": sk,
                                    "page_title": str(page.get("title") or ""),
                                    "download_url": missing_url,
                                    "candidate_source": "explicit_attachment",
                                    "candidate_query": "",
                                    "status": "missing",
                                    "content_present": False,
                                    "error": "explicit attachment URL not found in page attachment list",
                                })
                                search_meta["detail_missing"] += 1
                        else:
                            text_attachments = [
                                att for att in listed_attachments
                                if _is_text_attachment(att)
                            ]
                            non_text_attachments = [
                                att for att in listed_attachments
                                if not _is_text_attachment(att)
                            ]
                            attachments = text_attachments[
                                : validated_input.max_attachments_per_page
                            ]
                            skipped_text_attachments = text_attachments[
                                validated_input.max_attachments_per_page:
                            ]
                            if skipped_text_attachments:
                                search_meta["candidate_limit_hit"] = True
                            for non_text_att in non_text_attachments:
                                attachment_details.append({
                                    "page_id": page_id,
                                    "space_key": sk,
                                    "page_title": str(page.get("title") or ""),
                                    "attachment_id": str(
                                        getattr(non_text_att, "id", "") or ""
                                    ).strip(),
                                    "filename": str(
                                        getattr(non_text_att, "filename", "") or ""
                                    ).strip(),
                                    "download_url": str(
                                        getattr(non_text_att, "download_url", "") or ""
                                    ).strip(),
                                    "media_type": str(
                                        getattr(non_text_att, "media_type", "") or ""
                                    ),
                                    "candidate_source": candidate_source,
                                    "candidate_query": candidate_query,
                                    "status": "skipped",
                                    "content_present": False,
                                    "error": "Confluence attachment candidate is not text",
                                })
                        for att in attachments:
                            attachment_id = str(getattr(att, "id", "") or "").strip()
                            filename = str(getattr(att, "filename", "") or "").strip()
                            download_url = str(getattr(att, "download_url", "") or "").strip()
                            parent_page_id = str(getattr(att, "parent_page_id", "") or "").strip()
                            if parent_page_id != page_id:
                                search_meta["out_of_scope_count"] += 1
                                attachment_details.append({
                                    "page_id": page_id,
                                    "space_key": sk,
                                    "page_title": str(page.get("title") or ""),
                                    "attachment_id": attachment_id,
                                    "filename": filename,
                                    "download_url": download_url,
                                    "fetched_page_id": parent_page_id,
                                    "candidate_source": candidate_source,
                                    "candidate_query": candidate_query,
                                    "status": "skipped",
                                    "error": "Confluence attachment candidate out of requested page scope",
                                })
                                continue
                            invalid_download_url = _invalid_confluence_attachment_download_reason(
                                download_url,
                                page_id=page_id,
                            )
                            if not attachment_id or not filename or invalid_download_url:
                                err = {
                                    "target": f"{page_id}/attachment/{attachment_id or filename or '(missing)'}",
                                    "phase": "attachment_candidate",
                                    "error": (
                                        invalid_download_url
                                        or "Confluence attachment candidate missing id, filename, or download_url"
                                    ),
                                    "attachment_id": attachment_id,
                                    "filename": filename,
                                    "download_url": download_url,
                                    "candidate_source": candidate_source,
                                    "candidate_query": candidate_query,
                                }
                                errors.append(err)
                                search_meta["detail_errors"].append(err)
                                attachment_details.append({
                                    "page_id": page_id,
                                    "space_key": sk,
                                    "page_title": str(page.get("title") or ""),
                                    "attachment_id": attachment_id,
                                    "filename": filename,
                                    "download_url": download_url,
                                    "candidate_source": candidate_source,
                                    "candidate_query": candidate_query,
                                    "status": "error",
                                    "error": err["error"],
                                })
                                continue
                            detail = {
                                "page_id": page_id,
                                "space_key": sk,
                                "page_title": str(page.get("title") or ""),
                                "attachment_id": attachment_id,
                                "filename": filename,
                                "download_url": download_url,
                                "candidate_source": candidate_source,
                                "candidate_query": candidate_query,
                                "status": "pending",
                            }
                            attachment_details.append(detail)
                            try:
                                text = cf.fetch_attachment_text(download_url)
                            except Exception as exc:
                                err = {
                                    "target": f"{page_id}/attachment/{attachment_id}",
                                    "phase": "fetch_attachment_text",
                                    "filename": filename,
                                    "download_url": download_url,
                                    "error": repr(exc),
                                    "status_code": _http_status_code(exc),
                                    "candidate_source": candidate_source,
                                    "candidate_query": candidate_query,
                                }
                                errors.append(err)
                                search_meta["detail_errors"].append(err)
                                detail["status"] = "error"
                                detail["status_code"] = err["status_code"]
                                detail["error"] = err["error"]
                                if _confluence_api_auth_failed(exc):
                                    search_meta["auth_failed"] = True
                                    break
                                if _mark_confluence_limit_failure(err, exc):
                                    break
                                continue
                            text_value = str(text or "")
                            if not text_value.strip():
                                detail["status"] = "missing" if text is None else "empty"
                                detail["content_present"] = False
                                search_meta["detail_missing"] += 1
                                continue
                            detail["status"] = "fetched"
                            detail["content_present"] = True
                            search_meta["detail_fetched"] += 1
                            artifacts.append(_Artifact(
                                task_type="confluence",
                                asset=f"{aid}/attachment/{filename}",
                                asset_kind="attachment",
                                label=f"confluence://page/{page_id}/attachment/{filename}",
                                text=text_value,
                                metadata={
                                    "page_id": page_id,
                                    "attachment_id": attachment_id,
                                    "filename": filename,
                                    "media_type": att.media_type,
                                    "size": att.size,
                                    "download_url": download_url,
                                    "space_key": sk,
                                    "candidate_source": candidate_source,
                                    "candidate_query": candidate_query,
                                    "scan_method": scan_method,
                                    "_current_page_signatures": current_signatures,
                                },
                            ))
                        if search_meta.get("auth_failed") or search_meta.get("limit_failed"):
                            break
                        if not exact_downloads:
                            for skipped_att in skipped_text_attachments:
                                attachment_details.append({
                                    "page_id": page_id,
                                    "space_key": sk,
                                    "page_title": str(page.get("title") or ""),
                                    "attachment_id": str(
                                        getattr(skipped_att, "id", "") or ""
                                    ).strip(),
                                    "filename": str(
                                        getattr(skipped_att, "filename", "") or ""
                                    ).strip(),
                                    "download_url": str(
                                        getattr(skipped_att, "download_url", "") or ""
                                    ).strip(),
                                    "candidate_source": candidate_source,
                                    "candidate_query": candidate_query,
                                    "status": "skipped",
                                    "error": (
                                        "Confluence attachment candidate beyond "
                                        "max_attachments_per_page"
                                    ),
                                })
                except Exception as exc:
                    err = {
                        "target": page_id,
                        "phase": "page_detail",
                        "space_key": sk,
                        "candidate_source": candidate_source,
                        "candidate_query": candidate_query,
                        "error": repr(exc),
                        "status_code": _http_status_code(exc),
                    }
                    search_meta["detail_errors"].append(err)
                    errors.append(err)
                    if _confluence_api_auth_failed(exc):
                        search_meta["auth_failed"] = True
                        break
                    if _mark_confluence_limit_failure(err, exc):
                        break

        await asyncio.to_thread(_collect)
        search_meta["candidate_count"] = len(page_targets[: validated_input.max_pages])
        search_meta["query_status_counts"] = _query_status_counts(search_meta["query_details"])
        search_meta["query_candidate_totals"] = _query_candidate_totals(search_meta["query_details"])
        search_meta["fallback_status_counts"] = _fallback_status_counts(search_meta["fallback_attempts"])
        search_meta["fallback_reason_counts"] = _fallback_reason_counts(search_meta["fallback_attempts"])
        search_meta["fallback_candidate_totals"] = _fallback_candidate_totals(
            search_meta["fallback_attempts"],
        )
        search_meta["detail_status_counts"] = _detail_status_counts(
            page_details,
            comment_details,
            version_details,
            attachment_details,
        )
        search_meta["detail_status_by_kind"] = _detail_status_by_kind(
            page=page_details,
            comment=comment_details,
            version=version_details,
            attachment=attachment_details,
        )
        search_meta["detail_source_counts"] = _detail_source_counts(
            page_details,
            comment_details,
            version_details,
            attachment_details,
        )
        search_meta["detail_status_by_source"] = _detail_status_by_source(
            page_details,
            comment_details,
            version_details,
            attachment_details,
        )
        search_meta["detail_query_counts"] = _detail_query_counts(
            page_details,
            comment_details,
            version_details,
            attachment_details,
        )
        search_meta["detail_status_by_query"] = _detail_status_by_query(
            page_details,
            comment_details,
            version_details,
            attachment_details,
        )
        search_meta["detail_status_total"] = sum(search_meta["detail_status_counts"].values())
        search_meta["detail_error_summary"] = _detail_error_summary(search_meta["detail_errors"])
        selected_page_targets = page_targets[: validated_input.max_pages]
        target_details = confluence_target_errors + [
            {
                "id": str(page["id"]),
                "space_key": str(page.get("space_key") or ""),
                "title": str(page.get("title") or ""),
                "candidate_source": str(page.get("_candidate_source") or ""),
                "candidate_query": str(page.get("_candidate_query") or ""),
            }
            for page in selected_page_targets
        ]
        search_meta["target_status_counts"] = _target_status_counts(target_details)
        search_meta["target_source_counts"] = _target_source_counts(target_details)
        search_meta["target_status_by_source"] = _target_status_by_source(target_details)
        scanned = _scan_artifacts(
            artifacts,
            high_entropy=validated_input.high_entropy,
            include_document_signals=True,
        )
        search_meta["scan_summary"] = _scan_outcome_summary(artifacts, scanned)
        charter_ref = str(context.metadata.get("charter_ref") or "")
        evidence_ref = _write_evidence(
            evidence_dir=context.evidence_dir,
            domain="confluence",
            input_summary=validated_input.model_dump(),
            scanned=scanned,
            errors=errors,
            api_search=search_meta,
            charter_ref=charter_ref,
        )
        findings = await _persist_scanned_findings(
            context=context,
            source_tool=self.name,
            scanned=scanned,
            evidence_ref=evidence_ref,
        )
        search_meta["finding_summary"] = _finding_lifecycle_summary(findings)
        scan_status, recommended_status, status_reason = _scan_status_from_errors(
            errors=errors,
            artifacts_scanned=len(artifacts),
            api_search=search_meta,
        )
        space_target_statuses = _confluence_space_target_statuses(
            space_keys=normalized_space_keys,
            target_details=target_details,
            findings=findings,
            detail_groups=(
                page_details,
                attachment_details,
                comment_details,
                version_details,
            ),
        )
        search_meta["space_target_statuses"] = space_target_statuses
        context.metadata["_confluence_task_scan_status"] = scan_status
        context.metadata["_confluence_task_scan_recommended_status"] = recommended_status
        context.metadata["_confluence_task_scan_status_reason"] = status_reason or ""
        context.metadata["_confluence_task_scan_space_statuses"] = space_target_statuses
        _write_evidence(
            evidence_dir=context.evidence_dir,
            domain="confluence",
            input_summary=validated_input.model_dump(),
            scanned=scanned,
            errors=errors,
            findings=findings,
            api_search=search_meta,
            scan_status=scan_status,
            recommended_target_status=recommended_status,
            status_reason=status_reason,
            targets=[str(page["id"]) for page in selected_page_targets],
            target_details=target_details,
            page_details=page_details,
            attachment_details=attachment_details,
            comment_details=comment_details,
            version_details=version_details,
            out_path=evidence_ref,
            charter_ref=charter_ref,
        )
        return ToolSuccess(content=json.dumps(_payload(
            kind="confluence_task_scan",
            evidence_ref=evidence_ref,
            target_count=len(page_targets[: validated_input.max_pages]),
            artifacts_scanned=len(artifacts),
            findings=findings,
            errors=errors,
            extra={
                "spaces": normalized_space_keys,
                "pages": [str(page["id"]) for page in selected_page_targets],
                "api_search": search_meta,
                "scan_status": scan_status,
                "recommended_target_status": recommended_status,
                "status_reason": status_reason,
                "charter_ref": charter_ref,
            },
        ), ensure_ascii=False))
