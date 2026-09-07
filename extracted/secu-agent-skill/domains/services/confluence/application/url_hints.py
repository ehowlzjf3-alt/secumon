"""Confluence URL → CQL/REST 힌트 도출.

`confluence_task_worker` 진입점 안에 481줄로 들어앉아 있던 블록을 도메인 계층으로
옮겼다. github 의 `url_hints` 와 대칭이다.

외부 인터페이스는 `confluence_url_api_hint_text(url)` **하나**다.
"""
from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


_SPACE_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,80}$", re.IGNORECASE)
_TITLE_QUERY_KEYS = ("title", "pageTitle", "page_title")
_SEARCH_QUERY_KEYS = (
    "queryString",
    "searchQuery.queryString",
    "text",
    "q",
    "searchString",
)
_SPACE_QUERY_KEYS = ("spaceKey", "space_key", "searchQuery.spaceKey")
_LABEL_QUERY_KEYS = ("label", "labels", "labelName", "label_name", "labelString")
_VERSION_QUERY_KEYS = (
    "selectedPageVersions",
    "selectedPageVersions[]",
    "pageVersion",
    "page_version",
)
_COMMENT_QUERY_KEYS = (
    "focusedCommentId",
    "commentId",
    "comment_id",
)
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")
_COMMENT_FRAGMENT_RE = re.compile(r"(?:^|[-_=])comment[-_=]?(\d+)$|focusedCommentId=(\d+)", re.IGNORECASE)


def _valid_space_key(value: str) -> bool:
    return bool(_SPACE_KEY_RE.fullmatch(str(value or "").strip()))


def _clean_page_title(raw: str) -> str:
    title = unquote(str(raw or "")).replace("+", " ").strip()
    title = re.sub(r"\s+", " ", title)
    return title[:160].strip()


def _looks_like_blog_date_path(path_parts: list[str], start: int) -> bool:
    if start + 3 >= len(path_parts):
        return False
    year = path_parts[start].strip()
    month = path_parts[start + 1].strip()
    day = path_parts[start + 2].strip()
    return (
        year.isdigit()
        and len(year) == 4
        and month.isdigit()
        and 1 <= len(month) <= 2
        and day.isdigit()
        and 1 <= len(day) <= 2
    )


def _blog_title_from_path(path_parts: list[str], date_start: int) -> str:
    if not _looks_like_blog_date_path(path_parts, date_start):
        return ""
    return _clean_page_title(" ".join(path_parts[date_start + 3:]))


def _clean_search_term(raw: str) -> str:
    term = unquote(str(raw or "")).replace("+", " ").strip()
    term = re.sub(r"\s+", " ", term)
    if _CONTROL_CHAR_RE.search(term):
        return ""
    if len(term) >= 2 and term[0] == term[-1] and term[0] in {"'", '"'}:
        term = term[1:-1].strip()
    return term[:160].strip()


def _cql_quote(value: str) -> str:
    return str(value or "").replace("\\", "\\\\").replace('"', '\\"')


def _title_cql_queries(space_keys: list[str], titles: list[str]) -> list[str]:
    queries: list[str] = []
    for title in titles[:3]:
        if not title:
            continue
        if space_keys:
            for space_key in space_keys[:3]:
                query = (
                    f'space = "{_cql_quote(space_key)}" AND type = page '
                    f'AND title ~ "{_cql_quote(title)}"'
                )
                if query not in queries:
                    queries.append(query)
            continue
        query = f'type = page AND title ~ "{_cql_quote(title)}"'
        if query not in queries:
            queries.append(query)
    return queries


def _blog_title_cql_queries(space_keys: list[str], titles: list[str]) -> list[str]:
    queries: list[str] = []
    for title in titles[:3]:
        if not title:
            continue
        if space_keys:
            for space_key in space_keys[:3]:
                query = (
                    f'space = "{_cql_quote(space_key)}" AND type = blogpost '
                    f'AND title ~ "{_cql_quote(title)}"'
                )
                if query not in queries:
                    queries.append(query)
            continue
        query = f'type = blogpost AND title ~ "{_cql_quote(title)}"'
        if query not in queries:
            queries.append(query)
    return queries


def _text_cql_queries(space_keys: list[str], terms: list[str]) -> list[str]:
    queries: list[str] = []
    for term in terms[:3]:
        if not term:
            continue
        if space_keys:
            for space_key in space_keys[:3]:
                for field in ("text", "title"):
                    query = (
                        f'space = "{_cql_quote(space_key)}" AND type = page '
                        f'AND {field} ~ "{_cql_quote(term)}"'
                    )
                    if query not in queries:
                        queries.append(query)
            continue
        for field in ("text", "title"):
            query = f'type = page AND {field} ~ "{_cql_quote(term)}"'
            if query not in queries:
                queries.append(query)
    return queries


def _label_cql_queries(space_keys: list[str], labels: list[str]) -> list[str]:
    queries: list[str] = []
    for label in labels[:3]:
        if not label:
            continue
        if space_keys:
            for space_key in space_keys[:3]:
                query = (
                    f'space = "{_cql_quote(space_key)}" '
                    f'AND label = "{_cql_quote(label)}"'
                )
                if query not in queries:
                    queries.append(query)
            continue
        query = f'label = "{_cql_quote(label)}"'
        if query not in queries:
            queries.append(query)
    return queries


def _confluence_search_path(path_parts: list[str]) -> bool:
    lowered = {part.lower() for part in path_parts}
    if "search" in lowered or "dosearchsite.action" in lowered:
        return True
    return any("search" in part.lower() for part in path_parts)


def _confluence_label_path(path_parts: list[str]) -> bool:
    lowered = {part.lower() for part in path_parts}
    if {"label", "labels", "viewlabel.action", "listlabels-heatmap.action"} & lowered:
        return True
    return any(
        part.lower().startswith("listlabels-") and part.lower().endswith(".action")
        for part in path_parts
    )


def _confluence_page_list_path(path_parts: list[str]) -> bool:
    lowered = [part.lower() for part in path_parts]
    if {"listpages.action", "listpages-dirview.action", "viewpagehierarchy.action"} & set(lowered):
        return True
    for idx, part in enumerate(lowered):
        if (
            part == "spaces"
            and idx + 2 < len(lowered)
            and lowered[idx + 2] in {"pages", "page-tree", "pagetree", "children"}
        ):
            return True
    return False


def _confluence_blog_list_path(path_parts: list[str]) -> bool:
    lowered = [part.lower() for part in path_parts]
    if {"viewrecentblogposts.action", "viewblogposts.action", "listblogposts.action"} & set(lowered):
        return True
    for idx, part in enumerate(lowered):
        if (
            part == "spaces"
            and idx + 2 < len(lowered)
            and lowered[idx + 2] in {"blog", "blogposts"}
        ):
            return not _looks_like_blog_date_path(path_parts, idx + 3)
    return False


def _confluence_attachment_list_path(path_parts: list[str]) -> bool:
    lowered = [part.lower() for part in path_parts]
    if {"viewpageattachments.action", "viewattachments.action"} & set(lowered):
        return True
    if "download" in lowered:
        return False
    for idx, part in enumerate(lowered):
        if (
            part == "pages"
            and idx + 2 < len(lowered)
            and lowered[idx + 2] in {"attachments", "viewattachments"}
        ):
            return True
    return False


def _confluence_history_path(path_parts: list[str]) -> bool:
    lowered = {part.lower() for part in path_parts}
    return bool({
        "viewpreviousversions.action",
        "diffpagesbyversion.action",
        "viewpageversion.action",
    } & lowered)


def _confluence_url_api_hints(url: str) -> dict[str, list[Any]]:
    parsed = urlparse(str(url or ""))
    path_segments = [
        (part.strip(), unquote(part).strip())
        for part in parsed.path.split("/")
        if unquote(part).strip()
    ]
    raw_path_parts = [raw for raw, _decoded in path_segments]
    path_parts = [decoded for _raw, decoded in path_segments]
    page_ids: list[str] = []
    comment_ids: list[dict[str, str]] = []
    page_versions: list[dict[str, int | str]] = []
    attachment_downloads: list[dict[str, str]] = []
    space_keys: list[str] = []
    titles: list[str] = []
    blog_titles: list[str] = []
    search_terms: list[str] = []
    labels: list[str] = []
    raw_comment_ids: list[str] = []
    qs = parse_qs(parsed.query)
    page_list_path = _confluence_page_list_path(path_parts)
    blog_list_path = _confluence_blog_list_path(path_parts)
    attachment_list_path = _confluence_attachment_list_path(path_parts)
    for raw in qs.get("pageId", []) + qs.get("page_id", []):
        value = str(raw or "").strip()
        if value.isdigit() and value not in page_ids:
            page_ids.append(value)
    for key in _COMMENT_QUERY_KEYS:
        for raw in qs.get(key, []):
            value = str(raw or "").strip()
            if value.isdigit() and value not in raw_comment_ids:
                raw_comment_ids.append(value)
    if parsed.fragment:
        fragment = unquote(parsed.fragment).strip()
        match = _COMMENT_FRAGMENT_RE.search(fragment)
        if match:
            value = str(match.group(1) or match.group(2) or "").strip()
            if value.isdigit() and value not in raw_comment_ids:
                raw_comment_ids.append(value)
    for key in _SPACE_QUERY_KEYS:
        for raw in qs.get(key, []):
            value = str(raw or "").strip()
            if _valid_space_key(value) and value not in space_keys:
                space_keys.append(value)
    label_path = _confluence_label_path(path_parts)
    if label_path or page_list_path or blog_list_path:
        for raw in qs.get("key", []):
            value = str(raw or "").strip()
            if _valid_space_key(value) and value not in space_keys:
                space_keys.append(value)
    for key in _TITLE_QUERY_KEYS:
        for raw in qs.get(key, []):
            title = _clean_page_title(str(raw or ""))
            if title and title not in titles:
                titles.append(title)
    if label_path:
        for key in _LABEL_QUERY_KEYS:
            for raw in qs.get(key, []):
                label = _clean_search_term(str(raw or ""))
                if label and label not in labels:
                    labels.append(label)
    if _confluence_history_path(path_parts):
        versions: list[int] = []
        for key in _VERSION_QUERY_KEYS:
            for raw in qs.get(key, []):
                value = str(raw or "").strip()
                if not value.isdigit():
                    continue
                parsed_version = int(value)
                if parsed_version > 0 and parsed_version not in versions:
                    versions.append(parsed_version)
        if page_ids and versions:
            for page_id in page_ids:
                for version in versions:
                    page_versions.append({"page_id": page_id, "version": version})
    if _confluence_search_path(path_parts):
        for key in _SEARCH_QUERY_KEYS:
            for raw in qs.get(key, []):
                term = _clean_search_term(str(raw or ""))
                if term and term not in search_terms:
                    search_terms.append(term)
    for idx, part in enumerate(path_parts):
        lowered = part.lower()
        if lowered in {"pages", "page"} and idx + 1 < len(path_parts):
            candidate = path_parts[idx + 1].strip()
            if candidate.isdigit() and candidate not in page_ids:
                page_ids.append(candidate)
        if lowered == "attachments" and idx + 1 < len(path_parts):
            candidate = path_parts[idx + 1].strip()
            if candidate.isdigit() and candidate not in page_ids:
                page_ids.append(candidate)
            if candidate.isdigit() and idx + 2 < len(path_parts):
                download_parts = raw_path_parts[idx - 1:] if idx > 0 else raw_path_parts
                download_url = "/" + "/".join(download_parts)
                download_url = download_url.strip()
                target = {"page_id": candidate, "download_url": download_url}
                if download_url and target not in attachment_downloads:
                    attachment_downloads.append(target)
        if lowered in {"display", "spaces"} and idx + 1 < len(path_parts):
            candidate = path_parts[idx + 1].strip()
            if not _valid_space_key(candidate):
                continue
            if candidate not in space_keys:
                space_keys.append(candidate)
            if lowered == "display" and idx + 2 < len(path_parts):
                blog_title = _blog_title_from_path(path_parts, idx + 2)
                if blog_title:
                    if blog_title not in blog_titles:
                        blog_titles.append(blog_title)
                    continue
                title = _clean_page_title(path_parts[idx + 2])
                if title and title not in titles:
                    titles.append(title)
            if (
                lowered == "spaces"
                and idx + 2 < len(path_parts)
                and path_parts[idx + 2].lower() in {"blog", "blogposts"}
            ):
                blog_title = _blog_title_from_path(path_parts, idx + 3)
                if blog_title and blog_title not in blog_titles:
                    blog_titles.append(blog_title)
        if lowered in {"label", "labels"} and idx + 2 < len(path_parts):
            candidate = path_parts[idx + 1].strip()
            if not _valid_space_key(candidate):
                continue
            if candidate not in space_keys:
                space_keys.append(candidate)
            label = _clean_search_term(path_parts[idx + 2])
            if label and label not in labels:
                labels.append(label)
    for page_id in page_ids:
        for comment_id in raw_comment_ids:
            target = {"page_id": page_id, "comment_id": comment_id}
            if target not in comment_ids:
                comment_ids.append(target)
    return {
        "space_keys": space_keys,
        "page_ids": page_ids,
        "comment_ids": comment_ids,
        "page_versions": page_versions,
        "attachment_downloads": attachment_downloads,
        "titles": titles,
        "blog_titles": blog_titles,
        "search_terms": search_terms,
        "labels": labels,
        "include_pages": page_list_path,
        "include_blogposts": blog_list_path,
        "title_cql": _title_cql_queries(space_keys, titles),
        "blog_title_cql": _blog_title_cql_queries(space_keys, blog_titles),
        "search_cql": _text_cql_queries(space_keys, search_terms),
        "label_cql": _label_cql_queries(space_keys, labels),
        "include_attachments": attachment_list_path,
    }


def confluence_url_api_hint_text(url: str) -> str:
    hints = _confluence_url_api_hints(url)
    lines: list[str] = []
    exact_scoped_page_ids = {
        str(target.get("page_id") or "").strip()
        for target in (
            list(hints["comment_ids"])
            + list(hints["attachment_downloads"])
            + list(hints["page_versions"])
        )
        if str(target.get("page_id") or "").strip()
    }
    if hints["include_attachments"] and hints["page_ids"]:
        lines.append(
            "URL에서 Confluence attachment list 후보가 보이면 "
            f"confluence_task_scan(page_ids={hints['page_ids']}, api_search_first=True, "
            "include_attachments=True, fetch_attachments=True, scan_comments=False, "
            "scan_history=False)를 먼저 호출해 해당 page의 bounded text attachment 목록만 "
            "API로 열거하고 첨부 detail만 정밀 조회한다."
        )
        exact_scoped_page_ids.update(str(page_id) for page_id in hints["page_ids"])
    if hints["comment_ids"]:
        lines.append(
            "URL에서 direct comment 후보가 보이면 "
            f"confluence_task_scan(comment_ids={hints['comment_ids']}, "
            "api_search_first=True, scan_comments=True, scan_history=True)를 먼저 호출한다."
        )
    if hints["attachment_downloads"]:
        lines.append(
            "URL에서 direct attachment 후보가 보이면 "
            f"confluence_task_scan(attachment_downloads={hints['attachment_downloads']}, "
            "api_search_first=True, scan_comments=True, scan_history=True)를 먼저 호출한다."
        )
    if hints["page_versions"]:
        lines.append(
            "URL에서 특정 page version 후보가 보이면 "
            f"confluence_task_scan(page_versions={hints['page_versions']}, "
            "api_search_first=True, scan_comments=True, scan_history=True)를 먼저 호출한다."
        )
    page_ids = [page_id for page_id in hints["page_ids"] if page_id not in exact_scoped_page_ids]
    if page_ids:
        lines.append(
            "URL에서 page_id 후보가 보이면 "
            f"confluence_task_scan(page_ids={page_ids}, api_search_first=True, "
            "scan_comments=True, scan_history=True)를 먼저 호출한다."
        )
    if hints["include_pages"] and hints["space_keys"]:
        lines.append(
            "URL에서 Confluence page list 후보가 보이면 "
            f"confluence_task_scan(space_keys={hints['space_keys']}, api_search_first=True, "
            "include_pages=True, scan_comments=True, scan_history=True)를 먼저 호출해 "
            "보이는 space의 bounded page 목록만 API로 열거하고 그 page detail만 정밀 조회한다."
        )
    if hints["include_blogposts"] and hints["space_keys"]:
        lines.append(
            "URL에서 Confluence blog list 후보가 보이면 "
            f"confluence_task_scan(space_keys={hints['space_keys']}, api_search_first=True, "
            "include_blogposts=True, scan_comments=True, scan_history=True)를 먼저 호출해 "
            "보이는 space의 bounded blogpost 목록만 API로 열거하고 그 blogpost detail만 정밀 조회한다."
        )
    if hints["space_keys"] and not hints["include_pages"] and not hints["include_blogposts"]:
        lines.append(
            "URL에서 space key 후보가 보이면 "
            f"confluence_task_scan(space_keys={hints['space_keys']}, api_search_first=True, "
            "scan_comments=True, scan_history=True)를 먼저 호출한다."
        )
    if hints["title_cql"]:
        for query in hints["title_cql"]:
            lines.append(
                "URL에서 page title 후보가 보이면 "
                f"confluence_task_scan(cql={query!r}, api_search_first=True, "
                "scan_comments=True, scan_history=True)를 먼저 호출해 제목 후보 page만 상세조회한다."
            )
    if hints["blog_title_cql"]:
        for query in hints["blog_title_cql"]:
            lines.append(
                "URL에서 blogpost title 후보가 보이면 "
                f"confluence_task_scan(cql={query!r}, api_search_first=True, "
                "scan_comments=True, scan_history=True)를 먼저 호출해 제목 후보 blogpost만 상세조회한다."
            )
    if hints["label_cql"]:
        for query in hints["label_cql"]:
            lines.append(
                "URL에서 Confluence label 후보가 보이면 "
                f"confluence_task_scan(cql={query!r}, api_search_first=True, "
                "scan_comments=True, scan_history=True)를 먼저 호출해 label 후보 content만 상세조회한다."
            )
    if hints["search_cql"]:
        for query in hints["search_cql"]:
            lines.append(
                "URL에서 Confluence search query 후보가 보이면 "
                f"confluence_task_scan(cql={query!r}, api_search_first=True, "
                "scan_comments=True, scan_history=True)를 먼저 호출해 검색 후보 page만 상세조회한다."
            )
    if not lines:
        lines.append(
            "URL에서 space/page 식별자를 바로 알 수 없으면 web_site_sweep digest에서 "
            "Confluence canonical URL, space key, pageId를 확인한 뒤 "
            "confluence_task_scan(..., api_search_first=True, scan_comments=True, "
            "scan_history=True)를 호출한다."
        )
    return "\n".join(f"            - {line}" for line in lines)
