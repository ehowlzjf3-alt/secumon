"""dev_web target discovery application service."""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
import re
from typing import Any
from urllib.parse import urlparse

from domains.dev_web.application.ports import DevWebDiscoveryStorePort, SplunkSearchPort

_SPL_TEMPLATE = (
    "index=hq_escort sourcetype=escort_web_access "
    "earliest={earliest} latest={latest} {siem_filter} "
    "| eval domain=lower(coalesce(domain, URL_Host, host)) "
    '| where isnotnull(domain) AND domain!="" '
    '| where match(domain, "(?i)cdep") '
    '| eval _day=strftime(_time,"%Y-%m-%d") '
    "| stats count as count by domain _day "
    "| eventstats max(_day) as _latest "
    "| where _day=_latest "
    "| fields domain count "
    "| sort -count"
)


@dataclass(frozen=True)
class DevWebDiscoveryConfig:
    siem_filter: str = "cdep"
    include_regex: str = r"(?i)(dev|stage|stg|test|qa|sandbox|cdep)"
    day_bucket: str | None = None
    earliest: str = "-7d@d"
    latest: str = "now"
    max_domains: int = 1000
    source: str = "splunk"

    def resolved_day_bucket(self) -> str:
        day = self.day_bucket or dt.date.today().isoformat()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", day):
            raise ValueError(f"day_bucket must be YYYY-MM-DD: {day!r}")
        return day

    def bounded_max_domains(self) -> int:
        return max(1, min(int(self.max_domains), 10000))


def build_discovery_spl(config: DevWebDiscoveryConfig) -> str:
    return _SPL_TEMPLATE.format(
        earliest=config.earliest,
        latest=config.latest,
        siem_filter=config.siem_filter,
    )


def _domain_from_row(row: dict[str, Any]) -> str:
    raw = str(row.get("domain") or row.get("host") or row.get("url") or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw if "://" in raw else f"//{raw}")
    host = (parsed.hostname or raw.split("/", 1)[0]).strip().lower()
    return host.rstrip(".")


def _event_count(row: dict[str, Any]) -> int:
    try:
        return max(0, int(row.get("count") or row.get("event_count") or 0))
    except (TypeError, ValueError):
        return 0


def _priority_score(domain: str, include: re.Pattern[str]) -> int:
    return 100 if include.search(domain) else 0


def ingest_discovery_rows(
    rows: list[dict[str, Any]],
    *,
    config: DevWebDiscoveryConfig,
    store: DevWebDiscoveryStorePort,
) -> dict[str, Any]:
    day_bucket = config.resolved_day_bucket()
    include = re.compile(config.include_regex)
    before = store.dev_web_targets_summary(day_bucket=day_bucket)
    matched = 0
    priority_matched = 0
    upserted = 0
    max_event = 0
    seen: set[str] = set()

    for row in rows[: config.bounded_max_domains()]:
        if not isinstance(row, dict):
            continue
        domain = _domain_from_row(row)
        if not domain or domain in seen:
            continue
        seen.add(domain)
        matched += 1
        priority_score = _priority_score(domain, include)
        if priority_score:
            priority_matched += 1
        event_count = _event_count(row)
        max_event = max(max_event, event_count)
        store.dev_web_target_upsert(
            f"https://{domain}",
            domain=domain,
            source=config.source,
            day_bucket=day_bucket,
            event_count=event_count,
            priority_score=priority_score,
        )
        upserted += 1

    after = store.dev_web_targets_summary(day_bucket=day_bucket)
    return {
        "kind": "dev_web_discovery",
        "day_bucket": day_bucket,
        "splunk_rows": len(rows),
        "matched": matched,
        "priority_matched": priority_matched,
        "upserted": upserted,
        "new": max(0, after["total"] - before["total"]),
        "pending": after["pending"],
        "tasked": after["tasked"],
        "skipped": after["skipped"],
        "error": after["error"],
        "total": after["total"],
        "max_event_count": max_event,
    }


def run_discovery(
    *,
    config: DevWebDiscoveryConfig,
    searcher: SplunkSearchPort,
    store: DevWebDiscoveryStorePort,
) -> dict[str, Any]:
    rows = searcher.search(
        build_discovery_spl(config),
        max_results=config.bounded_max_domains(),
    )
    return ingest_discovery_rows(rows, config=config, store=store)
