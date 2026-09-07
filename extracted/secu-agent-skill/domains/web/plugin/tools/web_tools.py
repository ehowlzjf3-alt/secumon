"""Web domain agent tools."""
from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import re
import time
from dataclasses import asdict
from pathlib import Path
from typing import ClassVar
from urllib.parse import urljoin, urlparse
from uuid import uuid4

import httpx
from pydantic import BaseModel, Field

from secu_agent.agent.evidence_judgment import EvidenceJudgment, judge_web_finding
from secu_agent.agent.finding_followup import FindingSignal, append_finding_signal
from secu_agent.agent.semantic_validation import validate_web_resource
from secu_agent.agent.tools._untrusted import wrap_untrusted
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess
from domains.web.plugin.agent_types import webdomain as web


# ─── URL safety 가드는 코어 모듈 url_safety 로 추출됨 (de-domain C.2) ───
from secu_agent.agent.tools.url_safety import (  # noqa: F401
    _ALLOWED_SCHEMES, URLSafetyError, _is_internal_host, _origin,
    _probe_web_resources, validate_url_safe,
)


def _mark_web_content_inspected(context: Any, url: str) -> None:
    """web_fetch / web_resource_probe 가 실제 본문을 가져온 host 기록 —
    set_status('tasked') 게이트(내용 분석 증거)가 사용."""
    try:
        host = (urlparse(url).hostname or "").lower()
        if not host or not hasattr(context, "metadata"):
            return
        hosts = context.metadata.setdefault("_web_content_inspected_hosts", [])
        if host not in hosts:
            hosts.append(host)
    except Exception:
        pass


class WebCrawlInput(BaseModel):
    seed: str = Field(..., description="크롤 시드 URL (http/https). same-origin BFS.")
    max_pages: int = Field(default=30, ge=1, le=100)


class WebCrawlTool(Tool[WebCrawlInput]):
    name: ClassVar[str] = "web_crawl"
    domain: ClassVar[str] = "web"
    description: ClassVar[str] = (
        "seed URL부터 same-origin BFS 크롤. 각 페이지의 url/status/content_type/headers/body_preview 반환."
    )
    input_model: ClassVar[type[BaseModel]] = WebCrawlInput
    search_hint: ClassVar[str] = "web crawl bfs pages"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True

    async def execute(self, validated_input: WebCrawlInput, context: ToolContext) -> ToolResult:
        try:
            validate_url_safe(validated_input.seed)
        except URLSafetyError as e:
            return ToolError(kind="forbidden", message=f"seed blocked: {e}")
        env_max = int(os.environ.get("WEB_MAX_PAGES_PER_DOMAIN", "50"))
        max_pages = min(validated_input.max_pages, env_max)

        def _crawl() -> list[dict]:
            return [
                {
                    "url": p.url, "status": p.status,
                    "content_type": p.content_type,
                    "headers": p.headers,
                    "body_preview": p.body[:2048],
                    "body_size": len(p.body),
                }
                for p in web.crawl(validated_input.seed, max_pages=max_pages)
            ]
        pages = await asyncio.to_thread(_crawl)
        return ToolSuccess(content=wrap_untrusted(
            f"web_crawl://{validated_input.seed}", json.dumps(pages),
        ))


class WebFetchInput(BaseModel):
    url: str
    max_bytes: int = Field(default=128 * 1024, ge=128, le=1024 * 1024)


class WebFetchTool(Tool[WebFetchInput]):
    name: ClassVar[str] = "web_fetch"
    domain: ClassVar[str] = "web"
    description: ClassVar[str] = "단일 URL 직접 fetch. crawl로 못 잡힌 깊은 URL 확인용."
    input_model: ClassVar[type[BaseModel]] = WebFetchInput
    search_hint: ClassVar[str] = "web fetch single url get"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True

    async def execute(self, validated_input: WebFetchInput, context: ToolContext) -> ToolResult:
        try:
            validate_url_safe(validated_input.url)
        except URLSafetyError as e:
            return ToolError(kind="forbidden", message=f"url blocked: {e}")
        _mark_web_content_inspected(context, validated_input.url)
        ua = os.environ.get("WEB_USER_AGENT", "secu-agent/0.1")
        timeout = float(os.environ.get("WEB_REQUEST_TIMEOUT", "10"))
        # v3.45: 사내 host 면 system proxy (MWG) 우회 — trust_env=False
        internal = _is_internal_host(validated_input.url)
        def _fetch() -> tuple[int, dict, bytes]:
            with httpx.Client(headers={"User-Agent": ua}, verify=False, timeout=timeout,
                              follow_redirects=True,
                              trust_env=not internal) as c:
                r = c.get(validated_input.url)
                return r.status_code, dict(r.headers), r.content[:validated_input.max_bytes]
        try:
            status, headers, content = await asyncio.to_thread(_fetch)
        except httpx.HTTPError as e:
            return ToolError(kind="execution", message=repr(e))
        if content[:8192].count(b"\x00") > 4:
            text = "<binary content omitted>"
        else:
            text = content.decode("utf-8", errors="replace")
        payload = {"url": validated_input.url, "status": status, "headers": headers, "body": text}
        return ToolSuccess(content=wrap_untrusted(validated_input.url, json.dumps(payload)))


class WebResourceProbeInput(BaseModel):
    urls: list[str] = Field(..., min_length=1, max_length=50)
    compare_to_root: bool = True
    max_bytes: int = Field(default=256 * 1024, ge=512, le=1024 * 1024)


class WebResourceProbeTool(Tool[WebResourceProbeInput]):
    name: ClassVar[str] = "web_resource_probe"
    domain: ClassVar[str] = "web"
    description: ClassVar[str] = (
        "Passive GET probe with semantic validation. Use before claiming exposed files, "
        "admin pages, robots/sitemap, JS signals, credentials, PII, internal systems, "
        "semiconductor process info, business confidential info, or attack surface."
    )
    input_model: ClassVar[type[BaseModel]] = WebResourceProbeInput
    search_hint: ClassVar[str] = (
        "web semantic validate probe exposed file robots sitemap env git config "
        "credentials pii domains attack surface semiconductor process business"
    )
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    prompt_section: ClassVar[str] = (
        "### web_resource_probe(urls, compare_to_root=True)\n"
        "Passive GET probe with semantic validation. **urls 는 최대 50개** "
        "(`max_length=50`). 사용자가 50+ URL 박으면 batch 분할:\n"
        "  for batch in [urls[i:i+50] for i in range(0, len(urls), 50)]:\n"
        "      web_resource_probe(urls=batch)\n"
        "결과는 `semantic_status`를 근거로 보고 — `confirmed`만 finding, "
        "`inconclusive`는 추가 확인, `rejected`는 fallback/오탐. 200/length "
        "만으로 노출 판정 X. 민감 신호는 masked 형태로."
    )

    async def execute(
        self, validated_input: WebResourceProbeInput, context: ToolContext,
    ) -> ToolResult:
        for url in validated_input.urls:
            try:
                validate_url_safe(url)
            except URLSafetyError as e:
                return ToolError(kind="forbidden", message=f"url blocked: {url}: {e}")
            _mark_web_content_inspected(context, url)

        resources = await asyncio.to_thread(
            _probe_web_resources,
            validated_input.urls,
            compare_to_root=validated_input.compare_to_root,
            max_bytes=validated_input.max_bytes,
        )
        evidence_ref = _write_web_resource_probe_evidence(
            evidence_dir=context.evidence_dir,
            urls=validated_input.urls,
            resources=resources,
        )
        payload = {
            "kind": "web_resource_probe",
            "evidence_ref": str(evidence_ref),
            "resources": resources,
            "summary": {
                "total": len(resources),
                "confirmed": sum(1 for r in resources if r["semantic_status"] == "confirmed"),
                "inconclusive": sum(1 for r in resources if r["semantic_status"] == "inconclusive"),
                "rejected": sum(1 for r in resources if r["semantic_status"] == "rejected"),
                "sensitive_signals": sum(len(r.get("sensitive_signals") or []) for r in resources),
            },
        }
        _record_web_followup_signals(
            context=context,
            source_tool=self.name,
            seed=validated_input.urls[0],
            evidence_ref=str(evidence_ref),
            confirmed_findings=[],
            unconfirmed_findings=[],
            resources=resources,
        )
        return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))


class WebVulnProbeInput(BaseModel):
    seed: str
    max_pages: int = Field(default=30, ge=1, le=100)


class WebVulnProbeTool(Tool[WebVulnProbeInput]):
    name: ClassVar[str] = "web_vuln_probe"
    domain: ClassVar[str] = "web"
    description: ClassVar[str] = (
        "비파괴 웹 취약점 휴리스틱 모음 — exposed_file/missing_security_header/"
        "default_page/autoindex/reflective_xss/sqli_error/admin_unauth."
    )
    input_model: ClassVar[type[BaseModel]] = WebVulnProbeInput
    search_hint: ClassVar[str] = "web vuln probe scan vulnerability"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    prompt_section: ClassVar[str] = (
        "### web_vuln_probe(seed, max_pages=30)\n"
        "Non-destructive web heuristic probe. 반환값의 `findings`/"
        "`confirmed_findings`만 confirmed evidence로 보고 가능하다. "
        "`unconfirmed_findings`는 휴리스틱 원본이 evidence judgment를 통과하지 "
        "못한 항목이므로 취약점으로 단정하지 말고 추가 `web_resource_probe`/"
        "`web_fetch`/browser capture 대상 또는 inconclusive observation으로만 "
        "보고한다."
    )

    async def execute(self, validated_input: WebVulnProbeInput, context: ToolContext) -> ToolResult:
        if os.environ.get("WEB_VULN_PROBE_ENABLED", "true").lower() != "true":
            return ToolError(kind="forbidden", message="WEB_VULN_PROBE_ENABLED=false")
        try:
            validate_url_safe(validated_input.seed)
        except URLSafetyError as e:
            return ToolError(kind="forbidden", message=f"seed blocked: {e}")

        def _run() -> tuple[list[web.CrawledPage], list[web.WebFinding]]:
            pages = list(web.crawl(validated_input.seed, max_pages=validated_input.max_pages))
            findings = web.run_vuln_probes(validated_input.seed, pages)
            return pages, findings

        pages, findings = await asyncio.to_thread(_run)
        evidence_ref = _write_web_probe_evidence(
            evidence_dir=context.evidence_dir,
            seed=validated_input.seed,
            max_pages=validated_input.max_pages,
            pages=pages,
            findings=findings,
        )
        # v3.54: 자동 적재 제거 — 후보로만 반환(judge만). finding_lifecycle 적재의
        # 유일 경로는 submit_finding (policy A: browser 확인 + 한국어 분류 rubric).
        # 자동 적재가 "{kind}: {detail}" 영어 기계요약 저질 finding 을 양산했음.
        judgments = _judge_web_probe_findings(findings)
        lifecycle_ids: list[int] = []
        confirmed_findings, unconfirmed_findings = _split_web_probe_findings(
            findings, judgments,
        )
        payload = {
            "seed": validated_input.seed,
            "evidence_ref": str(evidence_ref),
            "page_count": len(pages),
            "raw_finding_count": len(findings),
            "findings": confirmed_findings,
            "confirmed_findings": confirmed_findings,
            "unconfirmed_findings": unconfirmed_findings,
            "lifecycle_ids": lifecycle_ids,
            "judgments": judgments,
            "reporting_contract": (
                "findings 는 heuristic 후보일 뿐 — 자동 적재되지 않는다. "
                "confirmed_findings 도 browser 로 직접 열어 확인한 뒤 submit_finding "
                "(한국어 위협분류 summary)으로만 보고하라. "
                "unconfirmed_findings 는 추가 증거 없이 노출/취약으로 단정 금지."
            ),
        }
        _record_web_followup_signals(
            context=context,
            source_tool=self.name,
            seed=validated_input.seed,
            evidence_ref=str(evidence_ref),
            confirmed_findings=confirmed_findings,
            unconfirmed_findings=unconfirmed_findings,
            lifecycle_ids=lifecycle_ids,
        )
        return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))


class WebTaskScanInput(BaseModel):
    seed: str
    max_pages: int = Field(default=30, ge=1, le=100)
    max_probe_urls: int = Field(default=30, ge=1, le=100)
    max_bytes: int = Field(default=256 * 1024, ge=512, le=1024 * 1024)


class WebTaskScanTool(Tool[WebTaskScanInput]):
    name: ClassVar[str] = "web_task_scan"
    domain: ClassVar[str] = "web"
    description: ClassVar[str] = (
        "Passive web tasking harness: crawl, semantic resource probe, "
        "non-destructive vuln heuristics, evidence judgment, and follow-up split."
    )
    input_model: ClassVar[type[BaseModel]] = WebTaskScanInput
    search_hint: ClassVar[str] = (
        "web task scan crawl semantic validation sensitive info attack surface "
        "credentials pii semiconductor process business confidential"
    )
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    prompt_section: ClassVar[str] = (
        "### web_task_scan(seed, max_pages=30, max_probe_urls=30)\n"
        "Recommended first tool for scoped web tasking. It combines crawl, "
        "semantic resource validation, heuristic vuln probes, and an evidence "
        "judgment split. Report only `confirmed_findings` and confirmed "
        "`resources`; keep `unconfirmed_findings` and `follow_up` separate."
    )

    async def execute(
        self,
        validated_input: WebTaskScanInput,
        context: ToolContext,
    ) -> ToolResult:
        try:
            validate_url_safe(validated_input.seed)
        except URLSafetyError as e:
            return ToolError(kind="forbidden", message=f"seed blocked: {e}")

        def _crawl_and_probe() -> tuple[list[web.CrawledPage], list[web.WebFinding]]:
            pages = list(web.crawl(
                validated_input.seed,
                max_pages=validated_input.max_pages,
            ))
            findings = web.run_vuln_probes(validated_input.seed, pages)
            return pages, findings

        pages, findings = await asyncio.to_thread(_crawl_and_probe)
        judgments = _judge_web_probe_findings(findings)
        confirmed_findings, unconfirmed_findings = _split_web_probe_findings(
            findings, judgments,
        )
        candidate_urls = _candidate_web_probe_urls(
            seed=validated_input.seed,
            pages=pages,
            findings=findings,
            limit=validated_input.max_probe_urls,
        )
        resources = await asyncio.to_thread(
            _probe_web_resources,
            candidate_urls,
            compare_to_root=True,
            max_bytes=validated_input.max_bytes,
        )
        follow_up = _web_task_follow_up(
            resources=resources,
            unconfirmed_findings=unconfirmed_findings,
        )
        evidence_ref = _write_web_task_scan_evidence(
            evidence_dir=context.evidence_dir,
            seed=validated_input.seed,
            max_pages=validated_input.max_pages,
            max_probe_urls=validated_input.max_probe_urls,
            pages=pages,
            resources=resources,
            findings=findings,
            judgments=judgments,
            follow_up=follow_up,
        )
        # v3.54: crawler 는 finding 을 DB 에 자동 적재하지 않는다 (policy A).
        # judgments 는 위에서 _judge_web_probe_findings 로 이미 계산됨. heuristic
        # finding 은 후보일 뿐 — agent 가 browser 확인 후 submit_finding 으로만 적재.
        lifecycle_ids: list[int] = []
        resource_summary = _resource_summary(resources)
        payload = {
            "kind": "web_task_scan",
            "seed": validated_input.seed,
            "evidence_ref": str(evidence_ref),
            "page_count": len(pages),
            "resource_count": len(resources),
            "raw_finding_count": len(findings),
            "resource_summary": resource_summary,
            "resources": resources,
            "findings": confirmed_findings,
            "confirmed_findings": confirmed_findings,
            "unconfirmed_findings": unconfirmed_findings,
            "follow_up": follow_up,
            "lifecycle_ids": lifecycle_ids,
            "judgments": judgments,
            "reporting_contract": (
                "findings/resources 는 heuristic 후보일 뿐 — 자동 적재되지 않는다. "
                "confirmed_findings 도 browser 로 직접 열어 확인한 뒤 submit_finding "
                "(한국어 위협분류 summary)으로만 보고하라. inconclusive resources / "
                "unconfirmed_findings 는 추가 증거 없이 노출/취약으로 단정 금지."
            ),
            "not_performed": [],
        }
        _record_web_followup_signals(
            context=context,
            source_tool=self.name,
            seed=validated_input.seed,
            evidence_ref=str(evidence_ref),
            confirmed_findings=confirmed_findings,
            unconfirmed_findings=unconfirmed_findings,
            resources=resources,
            follow_up=follow_up,
            lifecycle_ids=lifecycle_ids,
        )
        return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))


_WEB_ATTR_RE = re.compile(
    r"""(?is)\b(?:href|src|action)\s*=\s*["']([^"']{1,2048})["']"""
)
_WEB_JS_URL_RE = re.compile(
    r"""(?is)\b(?:fetch|axios\.(?:get|post|put|delete)|open)\s*\(\s*["']([^"']{1,2048})["']"""
)


def _candidate_web_probe_urls(
    *,
    seed: str,
    pages: list[web.CrawledPage],
    findings: list[web.WebFinding],
    limit: int,
) -> list[str]:
    parsed_seed = urlparse(seed)
    seed_host = parsed_seed.hostname
    candidates = [
        seed,
        urljoin(seed, "/robots.txt"),
        urljoin(seed, "/sitemap.xml"),
        urljoin(seed, "/.env"),
        urljoin(seed, "/.git/config"),
        urljoin(seed, "/.git/HEAD"),
        urljoin(seed, "/admin"),
        urljoin(seed, "/admin/"),
        urljoin(seed, "/login"),
        urljoin(seed, "/wp-admin/"),
        urljoin(seed, "/phpmyadmin/"),
        urljoin(seed, "/manager/html"),
        urljoin(seed, "/composer.json"),
        urljoin(seed, "/package.json"),
        urljoin(seed, "/Dockerfile"),
    ]
    for finding in findings:
        candidates.append(finding.url)
    for page in pages:
        candidates.append(page.url)
        for match in _WEB_ATTR_RE.finditer(page.body[:256 * 1024]):
            candidates.append(urljoin(page.url, match.group(1).strip()))
        for match in _WEB_JS_URL_RE.finditer(page.body[:256 * 1024]):
            candidates.append(urljoin(page.url, match.group(1).strip()))

    return _same_origin_urls(seed_host, candidates, limit)


def _same_origin_urls(
    seed_host: str | None, candidates: list[str], limit: int,
) -> list[str]:
    """candidate URL 들을 same-origin·allowed-scheme·url-safe 필터 + dedup → 최대 limit.

    _candidate_web_probe_urls 와 web_site_sweep 의 라우트 수집이 공용으로 쓴다."""
    out: list[str] = []
    seen: set[str] = set()
    for url in candidates:
        if not url:
            continue
        parsed = urlparse(url)
        if parsed.scheme not in _ALLOWED_SCHEMES or not parsed.hostname:
            continue
        if seed_host and parsed.hostname.lower() != seed_host.lower():
            continue
        normalized = parsed.geturl()
        if normalized in seen:
            continue
        try:
            validate_url_safe(normalized)
        except URLSafetyError:
            continue
        seen.add(normalized)
        out.append(normalized)
        if len(out) >= limit:
            break
    return out


def _resource_summary(resources: list[dict]) -> dict[str, int]:
    return {
        "total": len(resources),
        "confirmed": sum(1 for r in resources if r.get("semantic_status") == "confirmed"),
        "inconclusive": sum(1 for r in resources if r.get("semantic_status") == "inconclusive"),
        "rejected": sum(1 for r in resources if r.get("semantic_status") == "rejected"),
        "sensitive_signals": sum(len(r.get("sensitive_signals") or []) for r in resources),
    }


def _web_task_follow_up(
    *,
    resources: list[dict],
    unconfirmed_findings: list[dict],
) -> dict[str, list[str]]:
    urls: list[str] = []
    actions: list[str] = []
    seen_urls: set[str] = set()
    seen_actions: set[str] = set()

    def add_url(url: str | None) -> None:
        if url and url not in seen_urls:
            seen_urls.add(url)
            urls.append(url)

    def add_action(action: str | None) -> None:
        if action and action not in seen_actions:
            seen_actions.add(action)
            actions.append(action)

    for finding in unconfirmed_findings:
        add_url(str(finding.get("url") or ""))
        kind = str(finding.get("kind") or "web observation")
        add_action(f"validate {kind} with semantic body evidence before reporting")
    for resource in resources:
        if resource.get("semantic_status") == "inconclusive":
            add_url(str(resource.get("url") or ""))
            for action in resource.get("required_actions") or []:
                add_action(str(action))
    return {"urls": urls, "actions": actions}


def _resource_signal_severity(resource: dict) -> str:
    categories = {
        str(sig.get("category") or "")
        for sig in (resource.get("sensitive_signals") or [])
        if isinstance(sig, dict)
    }
    if categories & {"credential", "semiconductor_process", "business_confidential"}:
        return "high"
    if categories & {"pii", "internal_system"}:
        return "medium"
    if categories & {"attack_surface"}:
        return "low"
    return "informational"


def _record_web_followup_signals(
    *,
    context: ToolContext,
    source_tool: str,
    seed: str,
    evidence_ref: str,
    confirmed_findings: list[dict],
    unconfirmed_findings: list[dict],
    resources: list[dict] | None = None,
    follow_up: dict[str, list[str]] | None = None,
    lifecycle_ids: list[int] | None = None,
) -> None:
    """Translate web-specific observations into generic finding follow-up signals."""

    follow_up_actions = tuple((follow_up or {}).get("actions") or ())
    ids = lifecycle_ids or []
    for idx, finding in enumerate(confirmed_findings[:10]):
        url = str(finding.get("url") or seed)
        kind = str(finding.get("kind") or "web_finding")
        detail = str(finding.get("detail") or kind)
        # v3.54: crawler 는 finding 을 적재하지 않는다. heuristic confirmed 도
        # browser 확인 + submit_finding 거쳐야 하는 '후보'이므로 suspected 로 신호.
        persisted = bool(ids and idx < len(ids))
        append_finding_signal(
            context.metadata,
            FindingSignal(
                source_tool=source_tool,
                task_type="web",
                asset=url,
                asset_kind="url",
                severity=str(finding.get("severity") or "medium"),
                status="confirmed" if persisted else "suspected",
                confidence=1.0 if persisted else 0.5,
                finding_id=ids[idx] if idx < len(ids) else None,
                evidence_ref=evidence_ref,
                summary=(
                    f"{kind}: {detail}" if persisted
                    else f"{kind} 후보 — browser 확인 후 submit_finding 필요: {detail}"
                ),
                recommended_actions=follow_up_actions,
                report_updated=persisted,
            ),
        )

    for finding in unconfirmed_findings[:10]:
        url = str(finding.get("url") or seed)
        kind = str(finding.get("kind") or "web_observation")
        judgment = finding.get("judgment") if isinstance(finding.get("judgment"), dict) else {}
        required = tuple(str(a) for a in (judgment.get("required_actions") or ()))
        verdict = str(judgment.get("verdict") or "suspected")
        append_finding_signal(
            context.metadata,
            FindingSignal(
                source_tool=source_tool,
                task_type="web",
                asset=url,
                asset_kind="url",
                severity=str(finding.get("severity") or "medium"),
                status="inconclusive" if verdict == "inconclusive" else "suspected",
                confidence=0.5,
                evidence_ref=evidence_ref,
                summary=f"{kind}: evidence not confirmed",
                recommended_actions=required or follow_up_actions,
            ),
        )

    for resource in (resources or [])[:10]:
        url = str(resource.get("url") or seed)
        semantic_status = str(resource.get("semantic_status") or "")
        semantic_type = str(resource.get("semantic_type") or "resource")
        signals = resource.get("sensitive_signals") or []
        required = tuple(str(a) for a in (resource.get("required_actions") or ()))
        if semantic_status == "confirmed" and signals:
            append_finding_signal(
                context.metadata,
                FindingSignal(
                    source_tool=source_tool,
                    task_type="web",
                    asset=url,
                    asset_kind="url",
                    severity=_resource_signal_severity(resource),
                    status="confirmed",
                    confidence=0.85,
                    evidence_ref=evidence_ref,
                    summary=(
                        f"confirmed {semantic_type} with "
                        f"{len(signals)} sensitive/attack-surface signal(s)"
                    ),
                    recommended_actions=required or follow_up_actions,
                ),
            )
        elif semantic_status == "inconclusive" and required:
            append_finding_signal(
                context.metadata,
                FindingSignal(
                    source_tool=source_tool,
                    task_type="web",
                    asset=url,
                    asset_kind="url",
                    severity="informational",
                    status="inconclusive",
                    confidence=0.4,
                    evidence_ref=evidence_ref,
                    summary=f"inconclusive {semantic_type}: {resource.get('reason') or ''}",
                    recommended_actions=required,
                ),
            )


def _write_web_probe_evidence(
    *,
    evidence_dir: Path,
    seed: str,
    max_pages: int,
    pages: list[web.CrawledPage],
    findings: list[web.WebFinding],
) -> Path:
    out_dir = Path(evidence_dir) / "web_probes"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"web_probe_{uuid4().hex[:12]}.json"
    payload = {
        "kind": "web_vuln_probe_evidence",
        "created_at": time.time(),
        "seed": seed,
        "max_pages": max_pages,
        "page_count": len(pages),
        "finding_count": len(findings),
        "pages": [
            {
                "url": page.url,
                "status": page.status,
                "content_type": page.content_type,
                "headers": page.headers,
                "body_preview": page.body[:4096],
                "body_size": len(page.body),
            }
            for page in pages
        ],
        "findings": [asdict(finding) for finding in findings],
    }
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return out_path


def _write_web_resource_probe_evidence(
    *,
    evidence_dir: Path,
    urls: list[str],
    resources: list[dict],
) -> Path:
    out_dir = Path(evidence_dir) / "web_resource_probes"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"web_resource_probe_{uuid4().hex[:12]}.json"
    payload = {
        "kind": "web_resource_probe_evidence",
        "created_at": time.time(),
        "urls": urls,
        "resources": resources,
    }
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return out_path


def _write_web_task_scan_evidence(
    *,
    evidence_dir: Path,
    seed: str,
    max_pages: int,
    max_probe_urls: int,
    pages: list[web.CrawledPage],
    resources: list[dict],
    findings: list[web.WebFinding],
    judgments: list[dict],
    follow_up: dict[str, list[str]],
) -> Path:
    out_dir = Path(evidence_dir) / "web_task_scans"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"web_task_scan_{uuid4().hex[:12]}.json"
    payload = {
        "kind": "web_task_scan_evidence",
        "created_at": time.time(),
        "seed": seed,
        "max_pages": max_pages,
        "max_probe_urls": max_probe_urls,
        "page_count": len(pages),
        "resource_count": len(resources),
        "finding_count": len(findings),
        "resource_summary": _resource_summary(resources),
        "follow_up": follow_up,
        "pages": [
            {
                "url": page.url,
                "status": page.status,
                "content_type": page.content_type,
                "headers": page.headers,
                "body_preview": page.body[:4096],
                "body_size": len(page.body),
            }
            for page in pages
        ],
        "resources": resources,
        "findings": [asdict(finding) for finding in findings],
        "judgments": judgments,
    }
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return out_path


def _judge_web_probe_findings(findings: list[web.WebFinding]) -> list[dict]:
    judgments: list[dict] = []
    for finding in findings:
        judgment: EvidenceJudgment = judge_web_finding(finding)
        judgments.append({
            "url": finding.url,
            "kind": finding.kind,
            **judgment.to_dict(),
        })
    return judgments


def _split_web_probe_findings(
    findings: list[web.WebFinding],
    judgments: list[dict],
) -> tuple[list[dict], list[dict]]:
    confirmed: list[dict] = []
    unconfirmed: list[dict] = []
    for idx, finding in enumerate(findings):
        judgment = judgments[idx] if idx < len(judgments) else {}
        row = asdict(finding)
        row["judgment"] = judgment
        if (
            judgment.get("verdict") == "confirmed"
            and judgment.get("should_persist") is True
        ):
            confirmed.append(row)
        else:
            unconfirmed.append(row)
    return confirmed, unconfirmed
