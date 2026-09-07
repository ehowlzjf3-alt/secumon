"""confluence_submit_finding — 코어 generic submit 에 **task_type 핀**을 씌운 도메인 도구.

`github_submit_finding` 과 대칭. 근거는 `_shared.submit_task_type` docstring 에 있다.

## confluence 에서 특히 중요한 이유

코어 judge 디스패치는 `finding.task_type` 의 raw 문자열 조회이고 기본값은 `"generic"`
이다. task_type 이 빠지면 `_CATEGORY_JUDGES` 로 내려가는데, 거기 등록된 것이
`pii`(전 도메인 적용)와 `secret`(github 전용)이다.

`secret` judge 는 `task_type != "github"` 이면 `None` 을 돌려 코어 계약에 맡긴다 —
**의도된 방어**다. `secret_gate` 의 fixture/vendor 경로 규칙은 코드 저장소를 전제로
만들어져서, 위키 본문·`.md` 를 전량 제외해 버린다. confluence 에 그걸 적용하면 진짜
유출이 죽는다.

그런데 confluence finding 이 `generic` 으로 오면 그 판단 자체가 흐려진다 — judge 는
"github 이 아니다"까지만 알고 그게 confluence 인지 미상인지 구분하지 못한다. 라우팅
(리포트·대시보드)도 함께 어긋난다. 그래서 도메인 쪽에서 못박는다.
"""
from __future__ import annotations

from typing import ClassVar

from pydantic import BaseModel

from secu_agent.agent.schema.finding import TaskFinding
from secu_agent.agent.tools.base import ToolContext, ToolError, ToolResult
from secu_agent.agent.tools.submit_finding import SubmitFindingTool, _asset_kind_from_location
from secu_agent.finding_taxonomy import canonical_task_type, host_of

from service import state_domain as state
from service.services.finding_verification import make_agent_verification


class ConfluenceSubmitFindingInput(BaseModel):
    finding: TaskFinding


class ConfluenceSubmitFindingTool(SubmitFindingTool):
    name: ClassVar[str] = "confluence_submit_finding"
    domain: ClassVar[str] = "confluence"
    search_hint: ClassVar[str] = "confluence submit finding page attachment space"
    input_model: ClassVar[type[BaseModel]] = ConfluenceSubmitFindingInput
    description: ClassVar[str] = (
        SubmitFindingTool.description
        + "\n\n[confluence] task_type 은 'confluence' 로 제출한다(비워두면 도구가 확정한다). "
        "코어 generic submit_finding 을 쓰면 도메인 라우팅과 게이트 판단이 흐려진다."
    )

    async def execute(
        self, validated_input: ConfluenceSubmitFindingInput, context: ToolContext,
    ) -> ToolResult:
        from _shared.submit_task_type import ensure_task_type

        pinned = ensure_task_type(
            validated_input.finding, "confluence",
            tool_name="confluence_submit_finding")
        if isinstance(pinned, ToolError):
            return pinned
        result = await super().execute(
            SubmitFindingTool.input_model(finding=pinned), context)
        if isinstance(result, ToolError) or "lifecycle" not in result.content:
            return result
        _stamp_extra(pinned, context)
        return result


# ── agent_verification 마킹 ───────────────────────────────────────────────────
# `sync_report_threads` 가 `is_agent_verified_extra` 로 거른다. confluence 만 이 마커를
# 안 붙여서 finding 10건이 **전량** `skipped_unverified` 로 버려졌다(라이브 3회 재현).
# 그 뒤의 space_key 파서·담당자 해석은 여기서 막혀 도달조차 못 했다.
#
# ★ 형식만 채워 넣지 않는다. `status="verified"` 를 무조건 박으면 게이트가 무의미해진다.
#   근거는 **코어 정책 A 가 이미 쓰는 것과 같은 기록**이다 —
#   `confluence_browser_search` 가 본문(body)을 실제로 받은 뒤에만 남기는
#   `metadata['_web_browser_hosts']`. goto 실패·로그인벽·off-origin 리다이렉트는 안 남는다.
#   ⚠️ 그 기록이 없으면 **마커를 아예 안 붙인다.** "확인 안 함" 과 "확인했는데 실패" 를
#      섞지 않기 위해서다(status="unverified" 같은 값을 넣는 것보다 없는 게 낫다).


def _visited_hosts(context: ToolContext) -> set[str]:
    return {
        str(h).lower()
        for h in (getattr(context, "metadata", {}) or {}).get("_web_browser_hosts") or []
        if isinstance(h, str)
    }


def _finding_hosts(finding: TaskFinding) -> set[str]:
    target = host_of(str(getattr(finding, "target", "") or ""))
    if target:
        return {target}
    return {h for h in (host_of(hit.location) for hit in finding.hits) if h}


def _finding_id_by_fingerprint(fingerprint: str) -> int | None:
    with state.connect() as c:
        row = c.execute(
            "SELECT id FROM finding_lifecycle WHERE fingerprint=?", (fingerprint,),
        ).fetchone()
    return int(row["id"]) if row else None


def _page_author_keys(finding: TaskFinding, context: ToolContext) -> dict[str, str]:
    """글 작성자 → 리포터가 읽는 담당자 키. 못 얻으면 빈 dict.

    ★ confluence 담당자의 유일한 경로다. REST 는 Basic 403 / Bearer 429 로 두 겹 막혀 있고
    space CQL 레인도 전량 403 이다. `confluence_browser_search` 가 본문을 받은 그 자리에서
    byline 의 `/display/~<계정>` 을 긁어 두면, 그 계정이 곧 Knox ID 라
    `<계정>@samsung.com` 이 그대로 담당자 메일이 된다(실측: byline 의 이름·부서가
    knox 대장과 정확히 일치).

    키 이름은 `owner_recipients.CONFLUENCE_KEYS` 가 이미 기대하던 것이다 — 읽는 쪽은
    처음부터 있었고 쓰는 쪽이 없었다. 여기가 그 생산자다.
    """
    from domains.services.confluence.plugin.tools.confluence_browser_search_tool import (
        PAGE_AUTHORS_KEY,
    )

    store = (getattr(context, "metadata", {}) or {}).get(PAGE_AUTHORS_KEY) or {}
    if not isinstance(store, dict) or not store:
        return {}
    wanted = {str(getattr(finding, "target", "") or "")}
    wanted |= {str(h.location or "") for h in finding.hits}
    wanted.discard("")
    authors: dict[str, str] = {}
    for url in wanted:
        found = store.get(url)
        if isinstance(found, dict) and found:
            authors = found
            break
    if not authors:
        return {}
    out: dict[str, str] = {}
    if authors.get("creator"):
        out["creator_email"] = f"{authors['creator']}@samsung.com"
    if authors.get("last_editor"):
        out["last_modified_by_email"] = f"{authors['last_editor']}@samsung.com"
    return out


def _page_access_keys(finding: TaskFinding, context: ToolContext) -> dict[str, object]:
    """페이지 접근 범위 → finding 키. 못 얻으면 **빈 dict**.

    ★ 같은 시크릿이라도 **몇 명이 볼 수 있느냐**로 사건의 크기가 다르다. 지금까지
    finding 은 `sso_session_established`("로그인하면 보였다") 만 기록했고, 팀 5명이 보는
    페이지와 전사가 보는 페이지가 같은 severity 로 나갔다.

    실측(2026-08-26): 이 인스턴스는 익명 접근이 **사이트 전체 302 로그인 리다이렉트**다.
    그래서 남는 구분은 "제한 있음" vs "로그인한 전 임직원" 둘이고, 후자가
    `#content-metadata-page-restrictions` = "무제한" 이다.

    ⚠️ 못 읽으면 키를 넣지 않는다. 모르는 것을 "무제한" 으로 적으면 severity 가
    근거 없이 올라가고, 반대로 "제한됨" 으로 적으면 진짜 전사 노출이 묻힌다.
    """
    from domains.services.confluence.plugin.tools.confluence_browser_search_tool import (
        PAGE_ACCESS_KEY,
    )

    store = (getattr(context, "metadata", {}) or {}).get(PAGE_ACCESS_KEY) or {}
    if not isinstance(store, dict) or not store:
        return {}
    wanted = {str(getattr(finding, "target", "") or "")}
    wanted |= {str(h.location or "") for h in finding.hits}
    wanted.discard("")
    for url in wanted:
        found = store.get(url)
        if isinstance(found, dict) and found.get("scope"):
            return {"page_access": {
                "scope": found["scope"],
                "restrictions": found.get("restrictions", ""),
                # 이 인스턴스에서 확인된 사실 — 익명 열람은 사이트 전체가 막혀 있다.
                "anonymous_readable": False,
                "source": "confluence_page_restrictions_indicator",
            }}
    return {}


def _stamp_extra(finding: TaskFinding, context: ToolContext) -> None:
    """브라우저로 본문을 실제 열어본 기록이 있을 때만 마커·작성자를 남긴다."""
    hosts = _finding_hosts(finding)
    visited = hosts & _visited_hosts(context)
    if not visited:
        return                      # 확인 못 함 — 마커 없음이 정직하다
    from secu_agent import state as core_state

    asset = finding.hits[0].location if finding.hits else finding.task_id
    asset_kind = _asset_kind_from_location(asset) if finding.hits else "task"
    fingerprint = core_state.finding_fingerprint(
        task_type=canonical_task_type(finding.task_type, asset),
        asset=asset,
        asset_kind=asset_kind,
        discriminator="|".join(sorted({h.category for h in finding.hits})),
    )
    finding_id = _finding_id_by_fingerprint(fingerprint)
    if finding_id is None:
        return                      # 조회 실패 — 마커를 엉뚱한 행에 붙이지 않는다
    extra: dict[str, object] = {
        # 작성자 — 못 얻으면 키 자체가 없다. 빈 문자열을 넣으면 리포터가 "담당자 있음" 으로 읽는다.
        **_page_author_keys(finding, context),
        # 접근 범위 — 몇 명이 볼 수 있는가. 못 얻으면 키 자체가 없다.
        **_page_access_keys(finding, context),
        "agent_verification": make_agent_verification(
            method="confluence_browser_authenticated_search",
            source="confluence_submit_finding",
            checks=(
                "sso_session_established",
                "page_body_fetched_via_browser",
                "scan_text_hits_present",
            ),
            details={"hit_count": len(finding.hits), "hosts": sorted(visited)},
        ),
    }
    core_state.finding_update(finding_id, extra=extra, merge_extra=True)
