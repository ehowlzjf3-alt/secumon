"""검토원(inspector) 공통 실행계약 팩토리 — 4도메인 동일 규격 (Phase 1).

## 무엇인가

오늘의 도메인 워커를 **코어가 sub-agent 로 spawn 할 수 있는 부품**으로 만든다.
`AgentTool` → `WorkerPool` → `python -m secu_agent.agent <dir>` → `cli.py::_run` 경로가
`task_spec.json` 의 `task_type` 으로 여기 등록된 계약을 찾는다.

계약이 채우는 자리(코어가 미등록이면 어떻게 되는지):

| cli.py | 미등록 시 | 여기서 공급 |
|---|---|---|
| `get_task_contract` | unsupported → fail-closed | `register_task_contract` |
| `build_registry_for_task` | **generic fallback (조용함)** | `register_task_toolset` |
| `contract.system_prompt` | 코어 기본 프롬프트 | `skills/<d>/worker.md` |
| `contract.build_client` | **날것 client** | 스킬 런타임 래퍼 |

## 설계 원칙

**값을 새로 정하지 않는다.** 예산·종료도구·프롬프트를 오늘 워커에서 그대로 옮긴다.
Phase 1 의 게이트가 "오늘과 동등한 결과" 이므로, 여기서 무엇 하나라도 바꾸면 회귀가
났을 때 원인 분리가 불가능해진다.

**모델은 도메인이 고르지 않는다.** 워커 프로파일의 단일소스는 엔진 `.env` 의
`SA_CHAT_PROFILE` 이다. `vision_fallback` 은 '도메인 전용 모델'이 아니라 **능력 슬롯**
이다 — 선택된 모델이 이미지를 받으면 쓰이지 않는다. (도메인별 모델 특화 A/B 결론은
게이트웨이 버그로 뒤집혀 무효다.)

⚠️ `agents/<name>.md` 에 `profile:` 을 넣지 마라. 그건 `--profile-name` 으로 argv 에
실려 우선순위 1위 = **핀**이 되고, `SA_CHAT_PROFILE` 핀 금지 불변식에 걸린다.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("shared.inspect_contract")

_OFF = {"0", "false", "no", "off"}


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _flag(name: str, default: bool) -> bool:
    """운영 kill-switch — 코어 워커 cli 와 같은 시맨틱."""
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw not in _OFF



def _ensure_env() -> None:
    """스킬 `.env` 를 이 프로세스에 로드한다 (idempotent).

    ★ 코어 워커 CLI 경로(`python -m secu_agent.agent`)에는 **이걸 부르는 사람이 없다.**
    기존 러너 경로는 `run_agent()` 안의 `_ensure_dotenv()` 가 처리했는데, 검토원은
    `run_agent` 을 타지 않는다. 그래서 SMB_USERNAME 같은 스킬 전용 크리덴셜이 없는 채로
    돌았다 — 2026-08-20 첫 실기동에서 STATUS_LOGON_FAILURE 로 실측됐다.
    엔진 `.env`(DB·SA_PLUGINS)만 들어와서 **워커는 잘 도는 것처럼 보였다.**

    로드 순서는 `load_runtime_env` 가 정한다(스킬 → 엔진, first-wins) — 기존 러너 경로와
    같은 순서라 새 split-brain 위험은 없다.
    """
    from service.agents import runtime
    runtime._ensure_dotenv()



def _wrap_post(fn):
    """후처리 훅 래퍼 — env 를 보장하고, 후처리 실패가 워커 종료를 막지 않게 한다.

    후처리가 예외를 올리면 코어는 rc 를 못 받고 부모는 결과 누락(crash 단정)만 본다.
    큐 정리가 실패했다는 사실은 로그로 남기고, 워커 자신의 판정은 보존한다.
    """
    import functools

    @functools.wraps(fn)
    def _inner(*args, **kwargs):
        _ensure_env()
        try:
            return fn(*args, **kwargs)
        except Exception:
            log.exception("검토원 후처리 실패 — 워커 판정은 보존한다")
            return 3
    return _inner


_REPORT_HINT = (
    "\n\n끝내기 전에 `report_inspection(verdict=…, narrative=…, notable=[…], "
    "reinspect=[…])` 을 한 번 불러라 — 점검 결과를 구조화해 남기는 채널이다. "
    "원문 값을 `notable[].value` 에 넣어도 도구가 shape/지문/부분마스킹으로 바꿔 저장한다."
)


def _serve_answer_hint() -> str:
    """세션(serve)으로 돌 때만 붙는 **타이밍** 안내 (v3.99).

    실측(2026-08-22): 리드 질문 22건 중 17건(77%)이 빈 답이었다. 워커가 리포트를 쓰고
    산문 없이 끝내는데, 세션 transport 는 산문을 답으로 읽었기 때문이다.

    ★ 여기서 프롬프트가 하는 일은 **금지가 아니라 타이밍 안내**다. 강제는 코어가 한다 —
    serve 에서 `report_inspection` 이 종료 도구라 부르는 순간 이번 답이 끝난다
    (`cli._arm_serve_answer_tools`). 프롬프트 가드는 경계가 아니라는 이 저장소의 결론은
    그대로다. 안내가 없으면 워커가 그 사실을 모르고 리포트를 너무 일찍 부른다.

    단발 경로에서는 빈 문자열 — 오늘 프롬프트와 **바이트 동일**(Phase 1 동등성).
    """
    import os

    from secu_agent.agent.cli import SERVE_MODE_ENV

    if (os.environ.get(SERVE_MODE_ENV) or "").strip() not in {"1", "true", "yes", "on"}:
        return ""
    return (
        "\n\n── 이번 실행은 **세션**이다 ──\n"
        "리드가 질문을 하나씩 던지고 너는 하나씩 답한다. **질문 하나에 "
        "`report_inspection` 하나**가 답이다.\n"
        "⚠️ 그 도구를 부르는 순간 **이번 답이 종료된다** — 확인을 다 끝낸 뒤에 불러라. "
        "먼저 부르면 하던 일이 거기서 끊긴다.\n"
        "부르지 않고 끝내면 리드는 **아무것도 못 받는다**(빈 답). 예산이 모자라 다 못 "
        "봤어도, 거기까지 본 것을 리포트로 남겨라 — 리드가 `reinspect[]` 를 보고 범위를 "
        "좁혀 다시 묻는다. 세션은 살아 있다."
    )


def _lead_directive(spec: dict) -> str:
    """리드가 위임에 실은 지시를 검토원 프롬프트 끝에 붙인다 (Phase 2).

    ★ 이게 없으면 `delegate_inspect(question=..., scope=..., use_cred=...)` 가 **조용히
    버려진다.** 도메인 `_build_user_text` 들은 자기가 아는 키(kind/target_id/…)만 읽고
    모르는 키는 무시하기 때문이다. 리드 프롬프트는 질문을 던지라고 가르치는데 그 질문이
    워커에 닿지 않으면 2단 구조가 겉모양만 남는다.

    러너 경로(리드 없음)에서는 이 키들이 없으므로 반환이 빈 문자열 — 오늘 프롬프트와
    **바이트 동일**하다(Phase 1 동등성 보존).
    """
    target = spec.get("target") or {}
    scope = str(target.get("scope") or "").strip()
    question = str(target.get("question") or "").strip()
    cred_id = target.get("cred_id")
    if not (scope or question or cred_id is not None):
        # 리드 없이 도는 러너 경로. 지시는 없지만 보고 채널은 안내한다 — 있으면
        # 나중에 리드가 붙었을 때 프롬프트 차이가 없고, 없어도 워커는 오늘처럼 끝난다.
        return _REPORT_HINT + _serve_answer_hint()
    lines = ["", "", "── 리드 지시 ──"]
    if question:
        lines.append(f"이번 위임에서 답해야 할 질문: {question}")
    if scope:
        lines.append(f"우선 볼 범위: {scope}")
    if cred_id is not None:
        lines.append(
            f"쓸 크리덴셜 핸들: cred_id={cred_id}. **값은 리드가 모른다** — 크리덴셜 "
            f"도구가 좌표로 원문을 재-fetch 한다. 평문을 프롬프트/요약에 옮기지 마라."
        )
    lines += [
        "",
        "끝내기 전에 **`report_inspection` 을 한 번 불러라.** 그게 네 판단이 리드에게 닿는",
        "유일한 통로다 — 부르지 않으면 리드는 `reason=end_turn, submit=True` 같은 기계",
        "문구만 받는다(코어가 만드는 템플릿이라 내용이 0이다).",
        "  · narrative: 무엇을 봤고 왜 그렇게 판단했는지 (≤1000자)",
        "  · notable[]: 눈에 걸린 것. `value` 에 원문을 넣어도 된다 — 도구가 프로세스 안에서",
        "    shape/fingerprint/부분마스킹으로 바꾸고 **원문은 버린다.** `context` 로 주변",
        "    줄을 넘기면 마스킹 후 ≤5줄이 전달된다.",
        "  · reinspect[]: 예산이 모자라 못 본 곳. 리드가 범위를 좁혀 다시 맡길 근거다.",
        "리드는 파일 본문을 볼 수 없다 — 네가 골라 준 것만 본다.",
    ]
    return "\n".join(lines) + _serve_answer_hint()


# ══════════════════════════════════════════════════════════════════════════════
# 검토원 idle 예산 — **클라이언트 타임아웃보다 커야 한다** (2026-08-27)
# ══════════════════════════════════════════════════════════════════════════════
#
# ## 무엇이 있었나
#
# 검토원이 죽는 이유가 예산 부족이 아니라 **순서 역전**이었다. 실측:
#
#     LLM 클라이언트 timeout   300s   (llm_profiles.yaml)
#     검토원 idle 예산         300s   (여기)
#     실제 사망                300.3s · 300.3 · 300.4 · 300.3
#
#     github     검토원 idle 사망  7/7   (100%)
#     confluence                  10/38  (26%)
#
# 두 숫자가 같으면 워치독이 `idle_check_interval_sec=1.0` 만큼 늦게, 그러나 **먼저**
# 이긴다. 호출은 아직 살아 있는데 런이 죽는다.
#
# ## 왜 크게 두면 되나
#
# 클라이언트 타임아웃은 **관측 가능한 사건**이다. 300s 에 터지면 `stream_error →
# LoopError` 가 나오고 하네스가 `activity.touch(ev.type)` 로 시계를 되돌린다.
# 즉 워치독이 조금만 늦으면 개입할 필요가 없다 — 클라이언트가 먼저 말한다.
#
# 그래서 워치독의 역할이 제자리를 찾는다: **클라이언트조차 아무 말이 없는 진짜 죽음**
# 만 잡는다. 리드에서 keepalive 로 고친 것과 같은 종류의 순서 문제다.
#
# ⚠️ 프로파일마다 timeout 이 다르다(현재 300 과 600 이 섞여 있다). 그래서 숫자를
#    "제일 큰 timeout 보다 크게" 잡고, 그 관계를 테스트가 실제 YAML 로 검증한다
#    (`_shared/tests/test_inspector_idle_ordering.py`). 프로파일 timeout 을 올리면
#    테스트가 먼저 깨져서 여기도 올리라고 말한다.
INSPECTOR_IDLE_SEC_DEFAULT = 900


def build_inspect_contract(
    *,
    task_type: str,
    skill_name: str,
    tools: Callable[[], Any],
    terminal_tools: frozenset[str],
    user_message: Callable[[dict], str],
    env_prefix: str,
    default_turns: int,
    default_wall_sec: int,
    default_idle_sec: int,
    default_tokens: int,
    metadata: Callable[[dict], dict[str, Any]] | None = None,
    vision_fallback: str | None = None,
    candidate_ledger_enforce: bool = True,
    require_terminal_tool: bool = False,
    worker_resource: str = "worker.md",
    on_submit=None,
    on_no_submit=None,
):
    """도메인 하나의 검토원 계약을 만든다. 인자는 전부 오늘 워커에서 옮겨온 값이다.

    tools: `register_task_toolset` 에 그대로 넘길 provider(무인자 호출).
    vision_fallback: 이미지가 근거인 도메인만 지정(현재 smb/dev_web → "gemma").
    """
    from secu_agent.agent.task_contract import TaskContract

    def _system_prompt(spec: dict) -> str:
        _ensure_env()
        from service.agents import runtime
        body = runtime.load_skill_contract(skill_name, resource=worker_resource)
        if not body.strip():
            # 조용히 빈 프롬프트로 돌면 워커가 아무 계약 없이 도구를 쥔다.
            raise RuntimeError(
                f"skill 계약 본문이 비어 있다: {skill_name}/{worker_resource} — "
                f"SKILL.md 의 name 이 디렉터리 이름과 같은지 확인하라(다르면 조용히 skip 된다)"
            )
        return body

    def _user_message(spec: dict, evidence_dir: Path | None) -> str:
        _ensure_env()
        return user_message(spec) + _lead_directive(spec)

    def _budget(spec: dict, profile: Any):
        _ensure_env()
        from secu_agent.agent.harness.budget import AgentBudget
        return AgentBudget(
            max_turns=_int_env(f"{env_prefix}_MAX_TURNS", default_turns),
            max_wall_clock_sec=_int_env(f"{env_prefix}_MAX_WALL_SEC", default_wall_sec),
            max_idle_sec=_int_env(f"{env_prefix}_MAX_IDLE_SEC", default_idle_sec),
            max_tokens_total=_int_env(f"{env_prefix}_MAX_TOKENS_TOTAL", default_tokens),
        )

    def _metadata(spec: dict) -> dict[str, Any]:
        _ensure_env()
        md: dict[str, Any] = {"terminal_tools": set(terminal_tools)}
        if metadata is not None:
            md.update(metadata(spec))
        # v3.90 침묵 게이트 / CORE-ASK ④ 종료도구 게이트 — env 가 kill-switch.
        md["candidate_ledger_enforce"] = _flag(
            "SA_CANDIDATE_LEDGER", candidate_ledger_enforce)
        md["require_terminal_tool"] = _flag(
            "SA_REQUIRE_TERMINAL_TOOL", require_terminal_tool)
        return md

    def _build_client(profile: Any, profiles: dict[str, Any], spec: dict) -> Any:
        """스킬 런타임 래퍼를 태운 client — 이게 없으면 워커가 방어막 없이 돈다.

        ⚠️ 프로파일 **선택 권한은 스킬 런타임**에 둔다(`SA_CHAT_PROFILE` 우선 +
        vision 능력 대체). 코어 선택과 갈리면 로그로 드러낸다 — 조용한 모델 교체는
        finding provenance 를 거짓으로 만든다.
        """
        _ensure_env()
        from service.agents.runtime import _build_client as skill_build_client

        client = skill_build_client(
            vision_fallback, require_vision=bool(vision_fallback),
        )
        served = getattr(client, "_profile_name", None)
        core_choice = getattr(profile, "name", None)
        if served and core_choice and served != core_choice:
            log.warning(
                "[%s] 프로파일 선택이 갈렸다 — 코어=%s, 실제=%s "
                "(vision 능력 대체이거나 선택 규칙 차이). finding provenance 는 실제값을 쓴다.",
                task_type, core_choice, served,
            )
        return client

    return TaskContract(
        task_type=task_type,
        build_user_message=_user_message,
        terminal_tools=terminal_tools,
        budget=_budget,
        metadata=_metadata,
        system_prompt=_system_prompt,
        build_client=_build_client,
        on_submit=(None if on_submit is None else _wrap_post(on_submit)),
        on_no_submit=(None if on_no_submit is None else _wrap_post(on_no_submit)),
    )
