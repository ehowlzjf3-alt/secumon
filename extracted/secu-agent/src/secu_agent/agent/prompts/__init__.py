"""System prompt loader + operator 동적 합성.

- 사용자 task_type 별로 prompts/system_*.txt 가 있음.
- v3.12-C: operator 의 경우 registry 가 주어지면 동적 합성:
    operator_core.txt
    + dispatch cheat sheet (registry 메타)
    + 도구 섹션 (registry 메타)
    + SKILLS_GUIDANCE (skills/ 디렉토리 frontmatter)
  registry 없으면 monolithic system_operator.txt 로 fallback (회귀 안전).
"""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from secu_agent.agent.tools.registry import ToolRegistry


_PROMPTS_DIR = Path(__file__).parent


def _load(name: str) -> str:
    return (_PROMPTS_DIR / name).read_text(encoding="utf-8")


# 운영자에게 물어서 답이 돌아오는 세션인지 — 대화형(web/TUI/knox)은 True, 무인(scheduler
# tick 등)은 False. 무인에서 "물어라" 는 아무도 읽지 않는 질문으로 turn 이 끝나는 것이라
# 조용한 정지가 된다. 규칙이 갈리는 건 **묻느냐 마느냐** 하나뿐 — 막힌 항목을 기록하고
# 나머지를 마저 진행하는 건 operator_core 원칙 6 이 두 모드 공통으로 이미 규정한다.
_ASK_MODE_INTERACTIVE = (
    "## 이 세션\n\n"
    "운영자가 지금 붙어 있다 — 조회로도 대상이 안 좁혀지면 묻는 것이 정상적인 마무리다."
)
_ASK_MODE_UNATTENDED = (
    "## 이 세션\n\n"
    "**무인 실행이다 — 물어도 읽을 사람이 없다.** 조회로도 안 좁혀지는 항목은 묻지 말고 "
    "`todo(action=\"write\", merge=True, ...)` 로 그 항목을 `status=\"blocked\"` + 미해결 사유로 "
    "남긴 뒤 다음 항목으로 넘어간다(원칙 6). \"다음 항목\" 은 이미 정해진 범위 안의 다음 것이지 "
    "네가 새로 만든 일이 아니다. 멈추기 싫다고 대상을 찍지 마라.\n"
    "- **못 묻는 것은 승인된 것이 아니다** — 원칙 7 의 대규모 batch 확인 게이트는 무인에서도 "
    "그대로다. 여기선 승인을 받을 방법이 없으므로 **그 작업을 수행하지 말고** blocked 로 기록한 뒤 "
    "넘어간다. 침묵은 승인이 아니다. (파괴적 도구는 무인에서 실행 계층이 이미 거부하므로 "
    "네가 판단할 일이 아니다 — 그 거부를 다른 도구로 대신하려 들지 마라: 원칙 6.)\n"
    "- 보고 직전 `todo(action=\"read\")` 로 blocked 항목을 다시 읽어 하나도 빠뜨리지 마라. "
    "건너뛴 게 있으면 **보고 첫 줄에 \"미완 N건\"** 을 먼저 적는다 — 무인 실행 기록은 앞부분만 "
    "저장되므로 뒤에 적으면 잘려 나가고, 운영자에겐 완주한 점검으로 보인다.\n"
    "- 전부 막혔으면 그때는 멈추고, 무엇이 왜 안 됐는지 보고한다."
)


def _compose_operator_prompt(
    registry: "ToolRegistry", skills_selection=None,
    *, can_ask_operator: bool = False,
) -> str:
    from secu_agent.agent.skills import build_skills_guidance

    core = _load("operator_core.txt").strip()
    cheat = registry.dispatch_cheat_sheet_text().strip()
    tools = registry.tools_section_text().strip()
    deferred = registry.deferred_tools_listing_text().strip()
    # v3.81 T3: None → resolve_skills_dirs() / v3.82 U4: per-session selection
    skills_guidance = build_skills_guidance(None, selection=skills_selection).strip()
    subagents = _build_subagents_listing().strip()

    parts = [core]
    parts.append(
        _ASK_MODE_INTERACTIVE if can_ask_operator else _ASK_MODE_UNATTENDED
    )
    if subagents:
        parts.append("## 등록된 sub-agent (자동 생성)\n\n" + subagents)
    if cheat:
        parts.append("## 도구 dispatch 치트 시트 (자동 생성)\n\n" + cheat)
    if tools:
        parts.append("## 도구 (자동 생성)\n\n" + tools)
    if deferred:
        parts.append(
            "## deferred 도구 — schema 미로드 (자동 생성)\n\n"
            "아래 도구들은 schema 가 system prompt 에 없음. 호출하려면 먼저 "
            "`tool_search(query='키워드')` 또는 `tool_search(query='select:이름')` 로 "
            "schema 를 unlock 한 다음 turn 에 호출.\n\n"
            + deferred
        )
    if skills_guidance:
        parts.append(skills_guidance)
    return "\n\n".join(parts) + "\n"


def _build_subagents_listing() -> str:
    """agents/ 디렉토리 frontmatter 스캔 → operator 에게 위임 가능한 sub-agent 표.

    [DEPRECATED ...] 마킹된 description 은 자동 제외.
    """
    from secu_agent.agent.agents import load_agents

    agents = load_agents()
    if not agents:
        return ""
    lines: list[str] = []
    for a in agents:
        if "[DEPRECATED" in a.description:
            continue
        keys = ", ".join(a.input_keys) if a.input_keys else "(none)"
        lines.append(
            f"- **`{a.name}`** — {a.description}\n"
            f"  - input_keys: `{keys}`\n"
            f"  - 호출 시점: {a.when_to_use or '(미정)'}"
        )
    if not lines:
        return ""
    header = (
        "운영자 task 가 sub-agent 의 도메인과 분명히 일치하면 `agent(subagent_type=..., input={...})` "
        "한 호출로 위임. 위임 후 sub-agent 가 자체 multi-turn 으로 처리 + 요약 반환.\n\n"
    )
    return header + "\n".join(lines)


def system_prompt(
    task_type: str, *, registry: "ToolRegistry | None" = None,
    skills_selection=None, can_ask_operator: bool = False,
) -> str:
    """task_type에 맞는 system prompt 반환.

    - operator + registry 주어지면 동적 합성 (v3.12-C).
    - 그 외 (또는 registry None) → 기존 static file.
    - 알 수 없는 task_type → system_generic.txt fallback.

    can_ask_operator: 운영자에게 물으면 답이 돌아오는 세션인가. 호출부는
        `"interactive_approval" in frontend_capabilities` 로 넘긴다 — 대화형(web/TUI/
        knox)만 True. 기본 False 는 fail-safe: 사람이 있는지 모르면 없다고 보고
        "묻지 말고 기록 후 진행" 쪽으로 떨어진다(질문으로 조용히 멈추는 것보다 낫다).
    """
    if task_type == "operator" and registry is not None:
        return _compose_operator_prompt(
            registry, skills_selection=skills_selection,
            can_ask_operator=can_ask_operator,
        )

    # de-domain: 도메인 task_type 프롬프트는 secu-agent-skill 로 추출됨 —
    # 미지의 task_type 은 system_generic.txt fallback (재부착 plugin 이 재공급).
    candidates = {
        "operator": "system_operator.txt",
        "finding_narrator": "system_finding_narrator.txt",
        "package_sandbox": "system_package_sandbox.txt",
    }
    fname = candidates.get(task_type, "system_generic.txt")
    return _load(fname)
