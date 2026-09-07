"""도메인 런타임 집계 서비스 — repo(SQL) + components(분류/파생)를 응답 모델로 조립.

codex A1/A2 반영: 도메인 단위 3축(liveness/activity/health) + 활동 피드. per-employee 귀속·과거 phase 없음.
detail 은 응답 직전 redact(URL userinfo/query/fragment 제거 후 재마스킹, 길이 제한) — RO 크레덴셜 탈취 대비.
"""
from __future__ import annotations

import re
from typing import Any

from .db import ReadOnlyPool
from .domains import DOMAINS
from .masking import redact
from .models import (
    ComponentCounts,
    ComponentRuntime,
    DomainRuntime,
    RuntimeActivityItem,
    RuntimeActivityList,
    RuntimePresence,
)
from .repos import runtime_repo
from .runtime_components import (
    activity_of_phase,
    aggregate_activity,
    aggregate_health,
    aggregate_liveness,
    domain_of_component,
    health_of_terminal_status,
    liveness_of_age,
)

POLICY_VERSION = "v1"
_DETAIL_MAX = 200
_COUNTER_KEYS = ("subnets_swept", "hosts_found", "shares_found", "shares_walked", "owners_enriched")

# 임베디드 URL(모든 scheme — http/https/postgres/s3/redis/…) 매칭. userinfo/query/fragment 를 떼어낸다.
_URL_RE = re.compile(r"[a-zA-Z][a-zA-Z0-9+.\-]*://[^\s<>\"']+")


def _strip_url(m: "re.Match[str]") -> str:
    full = m.group(0)
    scheme, _, rest = full.partition("://")
    rest = rest.split("#", 1)[0].split("?", 1)[0]  # fragment·query 제거(검색어·토큰 담김)
    if "@" in rest:  # userinfo(user:pass@) 제거
        rest = rest.split("@", 1)[1]
    return f"{scheme}://{rest}"


def _sanitize_detail(detail: Any) -> str | None:
    """free-text detail 안전화 — 임베디드 URL(모든 scheme)의 userinfo/query/fragment 제거 후 redact + 길이 제한.

    codex #2: 기존엔 전체가 http URL일 때만 조각 제거 → 비-HTTP(postgres://user:pw@)·문장 내 임베디드 URL 의
    query/userinfo 가 남았다. 이제 임베디드 URL 을 전부 정규식으로 벗기고, 그 위에 redact(kv-secret·cred-URL·
    고엔트로피 토큰)로 이중 봉인한다.
    """
    if detail is None:
        return None
    s = _URL_RE.sub(_strip_url, str(detail))
    out = redact(s) or ""
    return out[:_DETAIL_MAX]


def _server_epoch(pool: ReadOnlyPool) -> float:
    row = pool.fetch_one("SELECT extract(epoch FROM now()) AS now")
    return float(row["now"]) if row and row.get("now") is not None else 0.0


def presence(pool: ReadOnlyPool) -> RuntimePresence:
    as_of = _server_epoch(pool)
    hbs = runtime_repo.heartbeats_all(pool)
    terminals = {
        str(r["component"]): str(r.get("status") or "")
        for r in runtime_repo.latest_terminal_run_by_component(pool)
    }
    run_components = runtime_repo.recent_run_components(pool)

    # 컴포넌트별 도메인 귀속(미상=제외). heartbeat 없는데 최근 run 만 있는 컴포넌트도 포착.
    hb_by_component: dict[str, dict[str, Any]] = {str(r["component"]): r for r in hbs if r.get("component")}
    all_components = set(hb_by_component) | set(run_components)

    domains_out: list[DomainRuntime] = []
    for dom in DOMAINS:
        comps = sorted(c for c in all_components if domain_of_component(c) == dom)
        comp_models: list[ComponentRuntime] = []
        counts = {"live": 0, "delayed": 0, "stale": 0, "unknown": 0}
        healths: list[str] = []
        last_beats: list[float] = []
        for c in comps:
            hb = hb_by_component.get(c)
            age = hb.get("age_seconds") if hb else None
            live = liveness_of_age(float(age) if age is not None else None)
            phase = hb.get("phase") if hb else None
            act = activity_of_phase(phase)
            counts[live] = counts.get(live, 0) + 1
            lb = float(hb["last_beat"]) if hb and hb.get("last_beat") is not None else None
            if lb is not None:
                last_beats.append(lb)
            comp_models.append(ComponentRuntime(
                component=c, liveness=live, activity=act,
                phase=str(phase) if phase else None, lastBeatAt=lb,
            ))
            # health 는 live/delayed 컴포넌트의 최신 terminal 결과만(codex).
            if live in ("live", "delayed"):
                healths.append(health_of_terminal_status(terminals.get(c)))

        livenesses = [m.liveness for m in comp_models]
        live_delayed_acts = [m.activity for m in comp_models if m.liveness in ("live", "delayed")]
        domains_out.append(DomainRuntime(
            domain=dom,
            liveness=aggregate_liveness(livenesses),
            activity=aggregate_activity(live_delayed_acts),
            health=aggregate_health(healths),
            lastBeatAt=max(last_beats) if last_beats else None,
            componentCounts=ComponentCounts(
                total=len(comp_models), live=counts["live"], delayed=counts["delayed"],
                stale=counts["stale"], unknown=counts["unknown"],
            ),
            components=comp_models,
        ))

    return RuntimePresence(asOf=as_of, policyVersion=POLICY_VERSION, domains=domains_out)


def domain_activity(pool: ReadOnlyPool, domain: str, limit: int) -> RuntimeActivityList:
    as_of = _server_epoch(pool)
    hbs = runtime_repo.heartbeats_all(pool)
    run_components = runtime_repo.recent_run_components(pool)
    comps = sorted({
        c for c in (
            [str(r["component"]) for r in hbs if r.get("component")] + list(run_components)
        ) if domain_of_component(c) == domain
    })
    rows = runtime_repo.recent_runs_for_components(pool, comps, limit)
    items = [
        RuntimeActivityItem(
            component=str(r["component"]),
            startedAt=float(r["started_at"]),
            finishedAt=float(r["finished_at"]) if r.get("finished_at") is not None else None,
            status=str(r.get("status") or ""),
            counters={k: int(r.get(k) or 0) for k in _COUNTER_KEYS},
            detailRedacted=_sanitize_detail(r.get("detail")),
        )
        for r in rows
    ]
    return RuntimeActivityList(domain=domain, asOf=as_of, items=items)
