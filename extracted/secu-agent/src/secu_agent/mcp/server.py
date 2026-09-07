"""코어 MCP server — state 의 read-only 조회를 MCP 표준 도구로 노출.

외부 client(Claude Desktop, 다른 agent 등)가 코어 finding state 를 표준 채널로 조회한다.
코어는 도메인-프리라 서버 identity/instructions 는 도메인 어휘를 담지 않는다: 실제
등록된 read-only 도구(list_findings/get_finding)만 기술한다. 서버명은 운영자
`SA_MCP_SERVER_NAME` 로 설정 가능(미설정 시 배포 기본값). 도메인 어댑터가 추가 조회
도구를 노출하려면 등록형 확장으로 붙여야 하며 코어 텍스트에 하드코딩하지 않는다.

mutating tool 노출은 approval 가드 통합 후 (read-only 우선).
"""
from __future__ import annotations

import json
import os
from typing import Any

from mcp.server.fastmcp import FastMCP

from secu_agent import state

# 배포 identity — 도메인 개념이 아니라 제품 브랜딩. 운영자/재부착이 override 가능.
_SERVER_NAME = os.environ.get("SA_MCP_SERVER_NAME", "secu-agent")
_SERVER_INSTRUCTIONS = (
    "코어 read-only finding 조회 MCP server. "
    "list_findings → finding 목록(severity/task_type 필터), get_finding → 단건 본문."
)


def _json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str)


def build_mcp_server() -> FastMCP:
    """FastMCP 인스턴스를 새로 만들어 우리 도구를 등록 후 반환.

    매 호출이 새 인스턴스라 테스트 격리 + 매 프로세스 단일 인스턴스 둘 다 OK.
    """
    mcp = FastMCP(name=_SERVER_NAME, instructions=_SERVER_INSTRUCTIONS)

    @mcp.tool(
        name="list_findings",
        description=(
            "submitted findings 조회. severity / task_type 필터 가능. "
            "최신 (last_seen) 순으로 정렬."
        ),
    )
    def list_findings(
        limit: int = 50,
        severity: str | None = None,
        task_type: str | None = None,
    ) -> str:
        rows = state.finding_list(
            task_type=task_type, limit=limit,
        )
        if severity:
            rows = [r for r in rows if r.get("severity") == severity]
        return _json({"findings": rows, "count": len(rows)})

    @mcp.tool(
        name="get_finding",
        description="finding id 로 단건 조회. 존재 안 하면 {'finding': null}.",
    )
    def get_finding(id: int) -> str:
        row = state.finding_get(id)
        return _json({"finding": row})

    return mcp


__all__ = ["build_mcp_server"]
