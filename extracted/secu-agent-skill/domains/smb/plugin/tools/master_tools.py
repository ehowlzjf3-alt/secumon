# [REORG 3축=G] share 메모리/세션 검색은 skill flow 로 재현 가능(G). SMB walk/fetch 만 (P).
"""SMB share 메모리/세션 검색 도구.

## 이 파일에 있던 것 (2026-08-21 정리)

원래 이름은 `smb_share_master` 도구셋이었다 — v3.23 2단 구조의 **리드**다:
`list_share_files` / `read_file_metadata` / `read_file_quick` / `set_file_finding` /
`submit_share_review`. Phase 2 에서 그 역할을 도메인 무관 리드
(`_shared/lead_tools.py` + `domains/smb/plugin/lead_adapter.py`)가 대체하면서 전부
제거했다. 근거:

  · 목록/메타(`list_share_files`·`read_file_metadata`) → 리드 `target_detail` 로 승격.
  · 본문 반환(`read_file_quick`) → **리드 규격 위반**. 리드는 본문을 못 본다(사외 egress).
    본문 열람은 검토원(`smb_file_inspect`)의 일이고 그쪽 도구셋이 이미 갖고 있다.
  · 큐 닫기(`submit_share_review`) → 리드 `set_target_status` 로 승격.
  · 역할 자체가 도달 불가였다 — `agents/*.md` 에 `task_type: smb_share_master` 가 없어
    `AgentTool` 로 spawn 할 수 없었고, 테스트만 `build_registry_for_task` 로 닿았다.

남긴 것은 도메인 메모리/세션 검색뿐이다. share scope 안에서만 동작한다.
"""
from __future__ import annotations

import asyncio
from typing import ClassVar, Literal

from pydantic import BaseModel, Field

from service import state_domain as state  # memory_recall_for_share 는 도메인 state (de-domain)
from secu_agent import state as core_state  # session_search 는 코어 state
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)


def _scoped_share_id(context: ToolContext) -> int | ToolError:
    sid = context.metadata.get("master_share_id")
    if sid is None:
        return ToolError(kind="execution",
                         message="master_share_id not set in context")
    return int(sid)  # type: ignore[arg-type]


# ============================================================
# memory_recall / memory_save — operator/host/부서 영속 룰
# ============================================================

_MEM_SCOPES = Literal["host", "share", "path_pattern", "global", "operator"]
_MEM_SEVERITY = Literal[
    "critical", "high", "medium", "low", "clean", "informational",
]


def _master_host_share(context: ToolContext, sid: int) -> tuple[str, str]:
    host = context.metadata.get("master_host")
    share = context.metadata.get("master_share")
    if host and share:
        return str(host), str(share)
    with state.connect() as c:
        sr = c.execute("SELECT host, share FROM smb_share WHERE id=?",
                       (sid,)).fetchone()
        return sr["host"], sr["share"]


class MemoryRecallInput(BaseModel):
    path_samples: list[str] = Field(
        default_factory=list, max_length=20,
        description="path_pattern scope 매칭용 — share 안 대표 path 몇 개. "
                    "(list_share_files 결과에서 골라 넘기면 됨)",
    )


class MemoryRecallTool(Tool[MemoryRecallInput]):
    name: ClassVar[str] = "memory_recall"
    domain: ClassVar[str] = "smb"
    description: ClassVar[str] = (
        "이 share/host 에 적용되는 영속 룰을 모두 가져온다.\n"
        "- host scope: 같은 host IP\n"
        "- share scope: 같은 'host:share'\n"
        "- path_pattern scope: 넘긴 path_samples 중 매칭되는 토큰\n"
        "- global / operator scope: 항상\n"
        "**share 평가 시작 시 한 번 호출 권장.** 룰 있으면 그에 맞춰 severity 판단."
    )
    input_model: ClassVar[type[BaseModel]] = MemoryRecallInput
    search_hint: ClassVar[str] = "memory recall rules persistent context"
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input: MemoryRecallInput,
                      context: ToolContext) -> ToolResult:
        sid = _scoped_share_id(context)
        if isinstance(sid, ToolError):
            return sid
        host, share = _master_host_share(context, sid)

        def _q():
            return state.memory_recall_for_share(
                host=host, share=share,
                path_samples=validated_input.path_samples or None,
            )
        rules = await asyncio.to_thread(_q)

        if not rules:
            return ToolSuccess(
                content="no memory rules matched for this share (없음)",
            )

        # hit_count 증가 (얼마나 자주 매칭되는 룰인지 추적)
        for r in rules:
            await asyncio.to_thread(core_state.memory_touch, r["id"])

        lines = [f"matched {len(rules)} memory rule(s):"]
        for r in rules:
            sev = f" [{r['severity_hint']}]" if r["severity_hint"] else ""
            tags = f" tags={','.join(r['tags'])}" if r["tags"] else ""
            lines.append(
                f"  - ({r['scope']}={r['key']}){sev}: {r['rule']}{tags}"
            )
        return ToolSuccess(content="\n".join(lines))


class MemorySaveInput(BaseModel):
    scope: _MEM_SCOPES
    key: str = Field(..., min_length=1, max_length=200,
                     description="scope-specific identifier. "
                                 "host=IP, share='host:share', "
                                 "path_pattern=부분매칭 토큰, global='*', "
                                 "operator=user-defined")
    rule: str = Field(..., min_length=1, max_length=500,
                      description="사람이 읽을 룰 텍스트")
    severity_hint: _MEM_SEVERITY | None = None
    tags: list[str] = Field(default_factory=list, max_length=10)


class MemorySaveTool(Tool[MemorySaveInput]):
    name: ClassVar[str] = "memory_save"
    domain: ClassVar[str] = "smb"
    description: ClassVar[str] = (
        "영속 룰을 메모리에 저장 — 다음 task 부터 적용됨.\n"
        "언제? share 안에서 확실히 일반화 가능한 패턴 발견 시:\n"
        "  - '이 host 의 print$ 는 항상 standard driver' (scope=share)\n"
        "  - '정유준님 폴더는 칩 설계 자산 — high default' (scope=path_pattern, key='정유준님')\n"
        "  - '이 host 는 dev sandbox' (scope=host)\n"
        "같은 (scope, key) 면 update. 1회용 결정은 set_file_finding 으로 충분 — memory 는 cross-share/cross-host 일반화 룰만."
    )
    input_model: ClassVar[type[BaseModel]] = MemorySaveInput
    search_hint: ClassVar[str] = "memory save persist rule remember"
    is_read_only: ClassVar[bool] = False

    async def execute(self, validated_input: MemorySaveInput,
                      context: ToolContext) -> ToolResult:
        sid = _scoped_share_id(context)
        if isinstance(sid, ToolError):
            return sid

        # share scope 면 key 가 'host:share' 형식이어야 recall 에서 매칭됨
        if validated_input.scope == "share" and ":" not in validated_input.key:
            return ToolError(
                kind="validation",
                message="share scope key must be in 'host:share' format "
                        "(e.g. '10.0.0.5:print$')",
            )

        try:
            mid = await asyncio.to_thread(
                core_state.memory_add,
                scope=validated_input.scope,
                key=validated_input.key,
                rule=validated_input.rule,
                severity_hint=validated_input.severity_hint,
                tags=validated_input.tags,
                source="master_agent",
            )
        except ValueError as e:
            return ToolError(kind="validation", message=str(e))
        except Exception as e:
            return ToolError(kind="execution", message=repr(e))

        return ToolSuccess(
            content=f"memory_rule#{mid} saved "
                    f"(scope={validated_input.scope}, key={validated_input.key})",
        )


# ============================================================
# session_search — FTS5 cross-share 패턴 검색
# ============================================================

_SESSION_KIND = Literal["file_review", "share_review", "memory_rule"]


class SessionSearchInput(BaseModel):
    query: str = Field(
        ..., min_length=2, max_length=200,
        description="검색어 (한글 OK, trigram 매칭). "
                    "전체 query 가 한 phrase 로 묶여 본문에 해당 순서로 나오면 매칭.",
    )
    kind: _SESSION_KIND | None = Field(
        None, description="필터: file_review / share_review / memory_rule",
    )
    include_self: bool = Field(
        False,
        description="기본 False — 자기 share 의 결과 제외 (cross-share 패턴 인지 목적). "
                    "True 면 자기 share 도 포함.",
    )
    limit: int = Field(15, ge=1, le=50)


class SessionSearchTool(Tool[SessionSearchInput]):
    name: ClassVar[str] = "session_search"
    description: ClassVar[str] = (
        "이전 share/file review 와 memory rule 을 통합 검색 — cross-share 패턴 인지용.\n"
        "예: '정유준' 으로 검색 → 다른 share 에도 정유준님 폴더 있었는지 확인.\n"
        "예: 'RSA private key' → 과거에 같은 종류 finding 있었는지.\n"
        "기본은 자기 share 제외 (include_self=False) — 너의 현재 결정은 set_file_finding 으로 만들고 있으니까, "
        "여기선 '다른 곳에서 본 적 있나' 만 알면 됨."
    )
    input_model: ClassVar[type[BaseModel]] = SessionSearchInput
    search_hint: ClassVar[str] = "session search cross-share pattern history"
    is_read_only: ClassVar[bool] = True
    domain: ClassVar[str] = "smb"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "찾아봐", "private key", "이름으로",
    )
    prompt_section: ClassVar[str] = (
        "### session_search(query, kind=None, include_self=False, limit=15)\n"
        "모든 share/file finding 통합 검색. cross-share 패턴.\n"
        "- 예: \"정유준\" → 다른 share 에도 같은 사람 폴더 있나\n"
        "- 예: \"RSA private key\" → 과거 finding 사례"
    )

    async def execute(self, validated_input: SessionSearchInput,
                      context: ToolContext) -> ToolResult:
        # master_share_id 있으면 share-scoped 모드, 없으면 (operator) unrestricted
        sid_or_err = _scoped_share_id(context)
        sid = None if isinstance(sid_or_err, ToolError) else sid_or_err

        # operator 모드는 항상 모든 share 검색. master 모드면 기본 self exclude.
        exclude = None
        if sid is not None and not validated_input.include_self:
            exclude = sid

        def _q():
            return core_state.session_search(
                validated_input.query,
                kind=validated_input.kind,
                exclude_share_id=exclude,
                limit=validated_input.limit,
            )
        rows = await asyncio.to_thread(_q)

        if not rows:
            return ToolSuccess(
                content=f"no results for '{validated_input.query}' "
                        f"(검색 결과 없음)",
            )

        lines = [f"found {len(rows)} match(es) for '{validated_input.query}':"]
        for r in rows:
            loc = ""
            if r["host"] and r["share_name"]:
                loc = f" @ {r['host']}/{r['share_name']}"
            path = f" path={r['path']}" if r["path"] else ""
            content = (r["content"] or "")[:200]
            lines.append(
                f"  - [{r['kind']} ref_id={r['ref_id']} share_id={r['share_id']}]{loc}{path}\n"
                f"    {content}"
            )
        return ToolSuccess(content="\n".join(lines))
