"""Terminal-tool contract — 필수 종료 상태 도구를 "텍스트로만" 낸 워커 되돌리기.

candidate ledger 침묵 게이트의 **형제**: 그건 "후보를 관찰하고도 제출·기각 없이
침묵(미정산)"을 지키고, 이건 "실질 작업은 다 했는데 완료 신호(종료 상태 도구)를
tool_use 가 아니라 **assistant 텍스트로 서술**하고 끝냄(미종료)"을 지킨다. 약한
모델(gauss/gpt-oss)의 실패모드 — tool call 을 산문/JSON 으로 적는 것 — 이 대상.

도메인-프리: 코어는 종료 도구가 무엇인지(confluence_search_set_status 등) 그
인자 스키마도 모른다. 워커가 metadata["terminal_tools"] 로 이름을 주입하고,
metadata["require_terminal_tool"]=True 로 이 게이트를 opt-in 한다(chat 경로는
미설정 → 비발동). 리마인더 텍스트도 특정 도메인 인자를 하드코딩하지 않는다.
"""
from __future__ import annotations

import time
from collections.abc import Iterable

# 워커 cli 가 set 하는 opt-in 플래그. chat/operator 경로는 미설정.
REQUIRE_TERMINAL_TOOL_KEY = "require_terminal_tool"
# 종료 도구가 실제로 tool_use 로 성공 완료됐는지의 크로스-턴 신호. 성공 시
# candidate ledger 게이트가 continue 로 루프를 이어갈 수 있어(터미널 후 텍스트-only
# 턴이 가능), per-turn 이 아니라 metadata 로 누적 추적한다.
TERMINAL_INVOKED_KEY = "terminal_tool_invoked"
# 종료 계약의 **세 번째 상태**: "호출했다" 도 "안 했다" 도 아닌 **"닫을 대상이
# 원리적으로 없다"**. 큐가 비면 리드는 claim 한 적 없는 대상에 상태를 찍을 수 없고,
# 그때 이 계약은 이행 불가능한 요구가 된다 — 실측 2026-08-27: 리드 20건이
# contract_violation 으로 죽었고 그중 19건이 도구를 `list_targets`(읽기 전용,
# "claim 하지 않는다") 하나만 불렀다.
#
# ⚠️ 값은 반드시 provenance dict 다 — 누가(source) 무엇을 관찰해서(evidence) 면제했는지가
#    없으면 면제가 아니다. LLM 이 "할 일 없었다" 고 쓰면 통과하는 문을 만들면 그건
#    계약 무력화다. 코어는 이 키를 **읽기만** 한다(도메인 지식 금지).
# ⚠️ 이 면제는 **provisional** 이다 — 면제 뒤 실제로 무언가를 보면 도메인 도구가 회수한다.
#    안 그러면 "면제 먼저 받고 일은 나중에" 로 그대로 뚫린다.
TERMINAL_WAIVED_KEY = "terminal_tool_waived"


def waive_terminal_tool(metadata: dict, *, source: str, evidence: dict) -> None:
    """종료 계약 면제 — **코드가 관찰한 사실로만.**

    `source` 는 도구 이름(코드 리터럴), `evidence` 는 어댑터 조회 결과다.
    하나라도 비면 예외를 던진다 — 근거 없는 면제를 조용히 통과시키지 않는다.
    """
    src = str(source or "").strip()
    if not src or not isinstance(evidence, dict) or not evidence:
        raise ValueError(
            "terminal 면제에는 source(도구 이름)와 evidence(코드가 관찰한 사실)가 "
            f"둘 다 필요하다: source={source!r} evidence={evidence!r}")
    metadata[TERMINAL_WAIVED_KEY] = {
        "source": src, "evidence": dict(evidence), "ts": time.time(),
    }


def build_terminal_tool_reminder(terminal_names: Iterable[str]) -> str | None:
    """필수 종료 도구를 호출로 발행하라는 시스템 노트 (None = 요구할 도구 없음).

    terminal_names 는 워커가 주입한 종료 도구 이름들. 도메인 인자 스키마는
    코어가 모르므로 일반적으로만 지시한다(모델이 방금 텍스트로 적은 그 인자를
    그대로 도구 호출로 발행하면 된다).
    """
    names = sorted({str(n) for n in (terminal_names or ()) if n})
    if not names:
        return None
    shown = " 또는 ".join(f"`{n}`" for n in names)
    return (
        "[SYSTEM NOTE] 너의 마지막 메시지는 종료 상태 도구를 **글로 적기만** 했고 "
        "실제로 호출하지 않았다. 텍스트나 JSON 으로 적은 것은 완료로 인정되지 않는다 "
        "— 작업이 아직 종료되지 않았다.\n"
        f"지금 {shown} 를 **도구(tool call)로 호출**하라 — 방금 텍스트로 적은 것과 "
        "같은 인자를 그대로 도구 호출로 발행하면 된다. 이미 끝냈다고 서술하지 마라.\n"
        "정상 완료라도(발견 0건이라도) 종료 도구 호출은 필수다 — 그것이 이 작업의 "
        "완료 신호다."
    )
