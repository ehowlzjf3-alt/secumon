# [REORG 3축=G] verify-pivot — HEAD 파일 재fetch(agent_type 라이드 P) 후 재scan 분류는 (G).
#   hit 추출+sig 매칭 절차는 generic. TODO: domains/services/github/SKILL.md 흡수.
"""v3.78 G2: github API hit HEAD 재확인 (verify-pivot, record-only).

API detector 가 commit_patch/repository_file 에서 secret 을 잡으면, 그게 지금도
현재 HEAD 에 살아있는지(live_in_HEAD) 아니면 이미 제거됐는지(historical_only)
파일이 사라졌는지(gone) 를 contents API 로 GET 재확인한다. 토큰 능동 사용·검증
없음 — 노출 내용을 다시 읽어 분류만. 결과는 finding extra['verification'] 에 기록.

브라우저 SSO 교차확인([API+SSO])은 별개 — agent 가 web_site_sweep 로 SSO URL 실접속
시 discovery_method='sso' finding 이 같은 repo 로 dedup 되며 cross_confirmed 표시된다
(skill 가이드). 이 모듈은 코드로 결정 가능한 API HEAD 재확인만 담당.
"""
from __future__ import annotations

from typing import Any

from secu_agent.detectors import scan_text

from domains.services.github.plugin.agent_types import github as gh

_MAX_FILES = 5  # commit 이 많은 파일 건드려도 재확인은 상한


def _secret_sigs(hits: list[dict[str, Any]]) -> tuple[set[tuple[str, str]], set[str]]:
    """secret hit → ((kind,masked) 풀시그, masked 없는 kind 집합).

    v3.78.1: live 판정은 같은 종류(kind)뿐 아니라 같은 마스킹 값(masked)까지 일치해야
    한다 — HEAD 에 같은 종류 '다른' 키가 있다고 원본을 live 로 오판하지 않도록. 단 finding
    hit 에 masked 가 없으면(레거시/수동) kind-only 폴백."""
    full: set[tuple[str, str]] = set()
    kinds_nomask: set[str] = set()
    for h in hits:
        if not (isinstance(h, dict) and h.get("category") == "secret" and h.get("kind")):
            continue
        kind = str(h["kind"])
        masked = h.get("masked")
        if masked:
            full.add((kind, str(masked)))
        else:
            kinds_nomask.add(kind)
    return full, kinds_nomask


def _paths_for(asset_kind: str, metadata: dict[str, Any]) -> list[str]:
    if asset_kind == "repository_file":
        p = metadata.get("path")
        return [p] if p else []
    if asset_kind == "commit_patch":
        return [f for f in (metadata.get("files") or []) if f][:_MAX_FILES]
    return []


def verify_github_finding(
    asset_kind: str, metadata: dict[str, Any], hits: list[dict[str, Any]],
    *, ref: str = "HEAD",
) -> dict[str, Any] | None:
    """API hit 의 secret 이 현재 HEAD 에 살아있는지 GET 재확인.

    secret hit 이 없으면(이메일 등) None. repo/path 없으면 None. 반환:
    {method, status(live_in_HEAD|historical_only|gone), ref, files:[{path,status}]}."""
    orig_full, orig_kinds_nomask = _secret_sigs(hits)
    if not orig_full and not orig_kinds_nomask:
        return None
    repo = metadata.get("repo")
    paths = _paths_for(asset_kind, metadata)
    if not repo or not paths:
        return None

    checked: list[dict[str, str]] = []
    any_live = False
    any_present = False
    any_unknown = False
    for path in paths:
        try:
            text = gh.fetch_file_at_ref(repo, path, ref=ref)
        except Exception:
            # v3.78.1: rate-limit/transient → 'gone' 으로 오표시 금지. unknown 으로 분리.
            any_unknown = True
            checked.append({"path": path, "status": "unknown"})
            continue
        if text is None:
            checked.append({"path": path, "status": "gone"})
            continue
        any_present = True
        head_full: set[tuple[str, str]] = set()
        head_kinds: set[str] = set()
        for h in scan_text(text).hits:
            if h.category == "secret":
                head_full.add((h.kind, h.masked))
                head_kinds.add(h.kind)
        live = bool(orig_full & head_full) or bool(orig_kinds_nomask & head_kinds)
        if live:
            checked.append({"path": path, "status": "live_in_HEAD"})
            any_live = True
        else:
            checked.append({"path": path, "status": "historical_only"})

    if not checked:
        return None
    if any_live:
        status = "live_in_HEAD"
    elif any_unknown:
        status = "unknown"   # 일부 경로 확인 실패 — 'resolved' 라 단정하지 않음
    elif any_present:
        status = "historical_only"
    else:
        status = "gone"
    return {"method": "api_head_recheck", "status": status, "ref": ref, "files": checked}
