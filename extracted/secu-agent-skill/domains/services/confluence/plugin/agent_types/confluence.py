"""Confluence (Atlassian) 에이전트.

Cloud/Server 양쪽 REST v1 호환. 페이지 본문(storage format) + comments + attachment.
가장 자주 새는 자료:
  - 'onboarding' 문서에 admin/DB 자격증명 평문
  - 첨부된 .env, terraform.tfstate, kubeconfig

읽기 전용. comment 작성 / page 수정 절대 안 함.
"""
from __future__ import annotations

import logging
import os
from collections.abc import Iterable
from dataclasses import dataclass, field

import httpx

logger = logging.getLogger(__name__)


def _client() -> httpx.Client:
    base = os.environ.get("CONFLUENCE_BASE_URL", "").rstrip("/")
    user = os.environ.get("CONFLUENCE_USER", "")
    token = os.environ.get("CONFLUENCE_API_TOKEN", "")
    if not base:
        raise RuntimeError("CONFLUENCE_BASE_URL 미설정")
    headers = {"Accept": "application/json", "User-Agent": "secu-agent/0.1"}
    auth = None
    if user and token:
        auth = (user, token)                            # Basic (Cloud/back-compat)
    elif token:
        headers["Authorization"] = f"Bearer {token}"    # Confluence DC Personal Access Token
    return httpx.Client(
        base_url=base,
        auth=auth,
        timeout=20.0,
        verify=False,
        trust_env=False,   # 사내 confluence 직결 — MWG 프록시 우회(github 클라와 동일)
        headers=headers,
    )


@dataclass(slots=True)
class CfPage:
    id: str
    title: str
    space_key: str
    version: int
    url: str            # webui URL


@dataclass(slots=True)
class CfAttachment:
    id: str
    filename: str
    media_type: str
    size: int
    download_url: str   # base 상대경로
    parent_page_id: str


@dataclass(slots=True)
class CfComment:
    id: str
    body: str
    parent_page_id: str


@dataclass(slots=True)
class CfSpace:
    key: str
    name: str
    type: str           # "global" | "personal"
    url: str            # webui URL


def _raise_http_error(operation: str, response: httpx.Response) -> None:
    raise RuntimeError(f"Confluence {operation} failed: HTTP {response.status_code}")


def _is_missing(response: httpx.Response) -> bool:
    return response.status_code == 404


def _list_content(space_key: str, *, content_type: str, limit: int, operation: str) -> list[CfPage]:
    out: list[CfPage] = []
    with _client() as c:
        start = 0
        while len(out) < limit:
            r = c.get(
                "/rest/api/content",
                params={
                    "spaceKey": space_key,
                    "type": content_type,
                    "limit": min(100, limit - len(out)),
                    "start": start,
                    "expand": "version",
                },
            )
            if r.status_code != 200:
                _raise_http_error(operation, r)
            body = r.json()
            results = body.get("results", [])
            if not results:
                break
            for p in results:
                out.append(CfPage(
                    id=p["id"],
                    title=p.get("title", ""),
                    space_key=space_key,
                    version=(p.get("version") or {}).get("number", 0),
                    url=p.get("_links", {}).get("webui", ""),
                ))
            start += len(results)
            if len(results) < 100:
                break
    return out


def list_pages(space_key: str, *, limit: int = 500) -> list[CfPage]:
    return _list_content(space_key, content_type="page", limit=limit, operation="list_pages")


def list_blogposts(space_key: str, *, limit: int = 500) -> list[CfPage]:
    """List bounded blogpost candidates in one space.

    Blog listing URLs expose a candidate list like page-list URLs; callers
    should fetch body detail only for these returned content IDs.
    """
    return _list_content(
        space_key,
        content_type="blogpost",
        limit=limit,
        operation="list_blogposts",
    )


def fetch_page_body(page_id: str) -> str | None:
    with _client() as c:
        r = c.get(f"/rest/api/content/{page_id}", params={"expand": "body.storage"})
        if _is_missing(r):
            return None
        if r.status_code != 200:
            _raise_http_error("fetch_page_body", r)
        body = r.json()
        return ((body.get("body") or {}).get("storage") or {}).get("value")


def list_attachments(page_id: str) -> list[CfAttachment]:
    out: list[CfAttachment] = []
    with _client() as c:
        r = c.get(f"/rest/api/content/{page_id}/child/attachment", params={"limit": 200})
        if _is_missing(r):
            return out
        if r.status_code != 200:
            _raise_http_error("list_attachments", r)
        for a in r.json().get("results", []):
            out.append(CfAttachment(
                id=a["id"],
                filename=a.get("title", ""),
                media_type=(a.get("metadata") or {}).get("mediaType", ""),
                size=(a.get("extensions") or {}).get("fileSize", 0),
                download_url=a.get("_links", {}).get("download", ""),
                parent_page_id=page_id,
            ))
    return out


def fetch_attachment_text(download_path: str, *, max_bytes: int = 512 * 1024) -> str | None:
    """download_path는 _links.download (상대). text 후보만 텍스트로 돌려준다."""
    with _client() as c:
        r = c.get(download_path)
        if _is_missing(r):
            return None
        if r.status_code != 200:
            _raise_http_error("fetch_attachment_text", r)
        raw = r.content[:max_bytes]
        if raw[:8192].count(b"\x00") > 4:
            return None
        return raw.decode("utf-8", errors="replace")


def fetch_comment_detail(comment_id: str) -> CfComment | None:
    """Fetch one Confluence comment body by content id.

    Direct comment links are already precise detail scopes; callers should use
    this instead of listing every page comment when the URL exposes a concrete
    comment id.
    """
    cid = str(comment_id or "").strip()
    if not cid:
        return None
    with _client() as c:
        r = c.get(
            f"/rest/api/content/{cid}",
            params={"expand": "body.storage,container"},
        )
        if _is_missing(r):
            return None
        if r.status_code != 200:
            _raise_http_error("fetch_comment_detail", r)
        body = r.json()
        return CfComment(
            id=str(body.get("id") or cid),
            body=((body.get("body") or {}).get("storage") or {}).get("value") or "",
            parent_page_id=str((body.get("container") or {}).get("id") or ""),
        )


def list_spaces(*, limit: int = 200, space_type: str | None = None) -> list[CfSpace]:
    """전사 space enumerate (전사 enum). space_type=None 이면 global+personal 전체."""
    out: list[CfSpace] = []
    with _client() as c:
        start = 0
        while len(out) < limit:
            params: dict[str, object] = {
                "limit": min(100, limit - len(out)),
                "start": start,
            }
            if space_type:
                params["type"] = space_type
            r = c.get("/rest/api/space", params=params)
            if r.status_code != 200:
                _raise_http_error("list_spaces", r)
            results = r.json().get("results", [])
            if not results:
                break
            for s in results:
                out.append(CfSpace(
                    key=s.get("key", ""),
                    name=s.get("name", ""),
                    type=s.get("type", ""),
                    url=s.get("_links", {}).get("webui", ""),
                ))
            start += len(results)
            if len(results) < 100:
                break
    return out


def cql_search(cql: str, *, limit: int = 100) -> list[CfPage]:
    """CQL 전역 검색 (github code_search analog). space_key 사전지식 없이
    'text ~ "password"' 같은 쿼리로 전 space 페이지를 찾는다."""
    out: list[CfPage] = []
    with _client() as c:
        start = 0
        while len(out) < limit:
            r = c.get(
                "/rest/api/content/search",
                params={
                    "cql": cql,
                    "limit": min(100, limit - len(out)),
                    "start": start,
                    "expand": "version,space",
                },
            )
            if r.status_code != 200:
                _raise_http_error("cql_search", r)
            results = r.json().get("results", [])
            if not results:
                break
            for p in results:
                out.append(CfPage(
                    id=str(p.get("id", "")),
                    title=p.get("title", ""),
                    space_key=(p.get("space") or {}).get("key", ""),
                    version=(p.get("version") or {}).get("number", 0),
                    url=p.get("_links", {}).get("webui", ""),
                ))
            start += len(results)
            if len(results) < 100:
                break
    return out


def list_page_versions(page_id: str, *, limit: int = 10) -> list[int]:
    """page 의 version number 목록 (내림차순). 현재 버전 포함 — 호출 측이 거른다."""
    with _client() as c:
        r = c.get(f"/rest/api/content/{page_id}/version", params={"limit": limit})
        if _is_missing(r):
            return []
        if r.status_code != 200:
            _raise_http_error("list_page_versions", r)
        nums = [
            v.get("number")
            for v in r.json().get("results", [])
            if isinstance(v.get("number"), int)
        ]
        return sorted(nums, reverse=True)


def fetch_page_body_version(page_id: str, version: int) -> str | None:
    """특정 version 의 page 본문(storage). 현재 페이지에서 지운 시크릿이 옛 버전에
    남은 케이스(github git history analog) 포착용."""
    with _client() as c:
        for params in (
            {"status": "historical", "version": version, "expand": "body.storage"},
            {"version": version, "expand": "body.storage"},
        ):
            r = c.get(f"/rest/api/content/{page_id}", params=params)
            if r.status_code == 200:
                value = ((r.json().get("body") or {}).get("storage") or {}).get("value")
                if value is not None:
                    return value
            elif not _is_missing(r):
                _raise_http_error("fetch_page_body_version", r)
        return None


def list_comments(page_id: str, *, limit: int = 50) -> list[str]:
    """page 의 코멘트 본문(storage) 목록. 평문 자격증명이 코멘트로 붙는 유출 경로."""
    with _client() as c:
        r = c.get(
            f"/rest/api/content/{page_id}/child/comment",
            params={"expand": "body.storage", "limit": limit},
        )
        if _is_missing(r):
            return []
        if r.status_code != 200:
            _raise_http_error("list_comments", r)
        out: list[str] = []
        for cmt in r.json().get("results", []):
            value = ((cmt.get("body") or {}).get("storage") or {}).get("value")
            out.append(value if value is not None else "")
        return out
