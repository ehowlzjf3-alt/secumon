"""SMB E2E 에이전트 공용 런타임 — 도메인 도구 + skill 프롬프트로 GuardedHarness 직접 구동.

엔진 무수정: cli.py 가 도메인 task_type 워커를 안 받고 build_registry_for_task 가
하드코딩이므로, skill repo 가 자체 런타임을 소유한다. 엔진 코어의 GuardedHarness/
ToolRegistry/LLM client/system_prompt 는 **그대로 사용**(import)하되, 노출 도구셋과
프롬프트(skill 본문)는 skill repo 가 결정한다 → contract layer = skill 단위.

run_agent(tool_classes, skill_md_path, user_text, ...) 한 번 = 한 에이전트 1 실행.
종료 도구(예: smb_submit_finding) 호출 = 성공 신호.
"""
from __future__ import annotations

import logging
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

log = logging.getLogger("service.agents.runtime")


def _ensure_dotenv() -> None:
    """Load repo env files and plugin bootstrap without importing collector code."""
    from service.runtime_env import load_runtime_env

    try:
        load_runtime_env(load_plugins=True)
    except Exception as e:  # noqa: BLE001
        log.warning("plugin bootstrap failed in agent runtime: %r", e)


def _evidence_root(label: str = "") -> Path:
    if str(label).startswith("dev_web"):
        root = Path(
            os.environ.get("SA_DEV_WEB_EVIDENCE_DIR", "")
            or os.environ.get("SA_E2E_EVIDENCE_DIR", "")
            or (Path(tempfile.gettempdir()) / "dev_web_e2e_evidence")
        )
    elif str(label).startswith("github"):
        root = Path(
            os.environ.get("SA_GITHUB_EVIDENCE_DIR", "")
            or os.environ.get("SA_E2E_EVIDENCE_DIR", "")
            or (Path(tempfile.gettempdir()) / "github_e2e_evidence")
        )
    elif str(label).startswith("confluence"):
        root = Path(
            os.environ.get("SA_CONFLUENCE_EVIDENCE_DIR", "")
            or os.environ.get("SA_E2E_EVIDENCE_DIR", "")
            or (Path(tempfile.gettempdir()) / "confluence_e2e_evidence")
        )
    else:
        root = Path(os.environ.get("SA_SMB_EVIDENCE_DIR", "")
                    or (Path(tempfile.gettempdir()) / "smb_e2e_evidence"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def make_evidence_dir(label: str) -> Path:
    base = _evidence_root(label)
    ts = time.strftime("%Y%m%dT%H%M%S")
    nonce = uuid.uuid4().hex[:6]
    safe = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in label)[:48]
    d = base / f"{ts}-{nonce}-{safe}"
    d.mkdir(parents=True, exist_ok=False)
    return d


def _build_registry(tool_classes: list[type]) -> Any:
    """주어진 Tool 클래스들로 ToolRegistry 구성 (엔진 ToolRegistry 재사용).

    deferred 도구는 unlock 돼야 catalog 에 노출되므로, 여기선 전부 non-deferred 로
    취급하도록 unlocked set 에 모두 넣는다(에이전트 전용 registry = 화이트리스트 자체).
    """
    from secu_agent.agent.tools.registry import ToolRegistry
    r = ToolRegistry()
    for cls in tool_classes:
        r.register(cls)
    return r


# 사내 fail-safe 기본값. 외부 egress 프로파일은 **명시**해야만 쓰인다 —
# 자동 대체로 사외로 나가면 워커가 본 파일 본문·크리덴셜이 그대로 따라 나간다.
_INTERNAL_DEFAULT_PROFILE = "gemma"
_EXTERNAL_PROFILES = frozenset({"codex", "o4-mini"})


def _select_profile_name() -> str | None:
    name = (os.environ.get("SA_CHAT_PROFILE") or os.environ.get("SA_SMB_AGENT_PROFILE") or "").strip()
    return name or None


# 체인 env 기본값. 역할별 client(리드 등)는 자기 env 를 넘겨 **전역 체인을 상속하지
# 않는다** — 상속하면 리드가 codex 로 시작해 gemma 로 조용히 넘어가고, 그러면 "누가
# 판단했나" 가 로그로 구분되지 않는다(2026-08-22 실제로 그 확인에 시간을 썼다).
GLOBAL_CHAIN_ENV = "SA_CHAT_PROFILE_CHAIN"


def _build_client(
    preferred: str | None = None, *, require_vision: bool = False,
    override: str | None = None, chain_env: str = GLOBAL_CHAIN_ENV,
):
    """세션 LLM client — env SA_CHAT_PROFILE/llm_profiles.yaml 기반 (엔진 factory 재사용).

    v3.90+: `SA_CHAT_PROFILE_CHAIN` 을 존중해 transient(5xx) 스트림 에러에 **폴백**한다.
    헌팅 워커는 여태 단일 프로파일 client 라, gauss 게이트웨이의 간헐 500(mid-stream,
    `'async for' … NoneType`)이 한 번만 나도 엔진이 stream_error 로 턴을 끝내 태스크가 죽었다
    (라이브 confluence keyword_search 에서 재현). 코어 `FallbackLLMClient` 는 출력 시작 전
    retryable 에러(5xx→transient)에 다음 프로파일로 넘어가므로, 체인(deepseek→gemma)을
    태우면 간헐 500 을 흡수한다. 명시 선택 프로파일(per-worker `SA_CHAT_PROFILE` override)을
    **선두**로 유지하고 체인의 나머지를 폴백으로 뒤에 붙인다(코어의 chain-우선과 달리 override 보존).
    체인 미설정/단일이면 기존과 동일(단일 client, byte-for-byte).

    v3.93: 각 프로파일 client 를 `ProfileTaggedClient` 로 감싸 **실제로 응답한 모델**을
    기록한다(`service.agents.llm_provenance`). 폴백이 뛰면 finding 에 남는 `llm_profile`
    이 설정 선두가 아니라 서빙한 프로파일이 된다 — A/B 어트리뷰션의 전제.

    v3.94: `preferred` = **도메인 기본 프로파일**(워커가 넘긴다). env `SA_CHAT_PROFILE`
    이 있으면 언제나 그쪽이 이긴다 — skill `.env` 핀 금지 정책과 per-worker override
    (A/B 하니스)를 둘 다 보존한다. 또 vision 미지원 프로파일은 `wrap_vision_compat` 로
    감싸 ImageBlock 400 태스크킬러를 막는다(프로파일별 적용).
    """
    from secu_agent.agent.llm.factory import (
        _build_client as core_build,
        _profile_names_from_env,
    )
    from secu_agent.agent.llm.fallback import FallbackLLMClient
    from secu_agent.agent.llm.profile import load_profiles

    from service.agents.gateway_compat import wrap_gateway_compat
    from service.agents.llm_provenance import (
        ServedProfileRecorder, attach_recorder, tag_profile,
    )
    from service.agents.retry_client import wrap_retry
    from service.agents.vision_compat import supports_vision, wrap_vision_compat

    profile_path = Path(os.environ.get(
        "SA_CHAT_PROFILES_PATH",
        str(Path(os.environ.get("SA_ENGINE_DIR", str(Path.home() / "project" / "secu-agent")))
            / "config" / "llm_profiles.yaml"),
    ))
    profiles = load_profiles(profile_path)
    # 우선순위: env override > 워커 도메인 기본값 > codex > 첫 프로파일.
    # env 를 최상위에 두는 것이 계약이다 — 운영/실험이 언제나 되찾아올 수 있어야 한다.
    # v3.96 Phase 3c: **역할별** 프로파일 override. 리드는 사외(codex), 검토원은 사내 —
    # 같은 프로세스 트리 안에서 역할마다 다른 모델을 써야 한다. 전역 `SA_CHAT_PROFILE`
    # 하나로는 표현할 수 없다.
    #
    # ⚠️ 이건 skill `.env` 핀 금지 불변식과 충돌하지 않는다. 그 불변식이 막는 것은
    # "전역 기본을 스킬이 몰래 고정하는 것" 이고, 이건 호출자(리드 계약)가 자기 역할에
    # 대해 명시적으로 지정하는 것이다. 아래 fail-safe 도 그대로 적용된다 —
    # 오타/은퇴한 이름이면 **사내 기본**으로 떨어진다(codex 로 안 떨어진다).
    name = (override or "").strip() or None
    if name is None:
        name = _select_profile_name()
    if name is None and preferred and preferred in profiles:
        name = preferred
    elif (
        require_vision and name in profiles
        and not supports_vision(name)
        and preferred in profiles and supports_vision(preferred)
    ):
        # ⚠️ env 우선 계약의 **유일한 예외**: 선택된 모델이 이 도메인의 일을 구조적으로
        # 할 수 없을 때. deepseek 는 이미지를 400 으로 거부하는데 smb/dev_web 은 이미지가
        # 근거의 핵심이다. 전역 핀(`SA_CHAT_PROFILE`, 엔진 .env — 현재 deepseek)이
        # 있으면 도메인 기본값이 영영 안 먹어서, 이 예외가 없으면 배선 자체가 死코드가 된다.
        # "운영자 의도를 무시" 가 아니라 "못 하는 모델을 안 쓴다" 이다. 로그로 드러낸다.
        log.warning(
            "[runtime] %s 는 이미지 입력을 지원하지 않아 이 워커에는 부적합 — "
            "%s 로 대체한다(SA_CHAT_PROFILE 무시). 강제하려면 워커별 env 를 쓰라.",
            name, preferred,
        )
        name = preferred
    if name is None or name not in profiles:
        # ★ 사내로 fail-safe 한다. 구 코드는 여기서 **codex 로 떨어졌다** —
        # chatgpt.com 외부 egress 다. 코어는 이미 같은 자리를 고쳤고
        # (`llm/factory.py`: "env 미설정은 사고이지 의도가 아니므로 사내로 fail-safe"),
        # 스킬 사본만 옛 동작으로 남아 있었다.
        #
        # 실제로 터질 수 있는 경로가 둘이다:
        #   1) SA_CHAT_PROFILE 미상속(워커 subprocess 에 env 가 안 넘어간 경우)
        #   2) SA_CHAT_PROFILE 이 **없는 프로파일**을 가리킴 — 2026-08-20 에
        #      gauss-o32/gpt-oss/gauss-o41 을 은퇴시켜서 구 env·구 이미지가 여기 걸린다
        #
        # 외부 프로파일(codex/o4-mini)은 SA_CHAT_PROFILE 로 **명시**해야만 쓰인다.
        if name is not None:
            log.warning(
                "[runtime] 프로파일 %r 이 llm_profiles.yaml 에 없다 — 사내 기본값 %r 로 "
                "떨어진다. 은퇴한 이름(gauss-o32/gpt-oss/gauss-o41)을 가리키고 있지 않은지 "
                "확인하라.", name, _INTERNAL_DEFAULT_PROFILE,
            )
        name = (
            _INTERNAL_DEFAULT_PROFILE if _INTERNAL_DEFAULT_PROFILE in profiles
            else next((n for n in profiles if n not in _EXTERNAL_PROFILES), None)
        )
    if name is None:
        raise RuntimeError(
            f"llm_profiles.yaml 에 쓸 수 있는 **사내** profile 이 없다: {profile_path} "
            f"(외부 프로파일 {sorted(_EXTERNAL_PROFILES)} 로는 자동 대체하지 않는다)"
        )
    # `chain_env` 가 미설정이면 체인은 **선택 프로파일 하나**다(코어
    # `_profile_names_from_env` 가 chain_raw=None 을 그렇게 푼다) — 즉 폴백 없음.
    # 역할별 client 는 그래서 전역 체인을 물려받지 않는다.
    chain = _profile_names_from_env(
        profiles=profiles, profile_name=name,
        chain_raw=os.environ.get(chain_env),
    )
    ordered = [name] + [n for n in chain if n != name]  # 선택 프로파일 선두 + 폴백
    # 각 client 를 턴별 재시도 래퍼로 감싼다(폴백 전에 같은 모델부터 되살림 —
    # 간헐 게이트웨이 500 흡수). SA_STREAM_RETRY=0 이면 무래핑(byte-for-byte 원복).
    # 래퍼 순서: 태그(최외곽, 서빙 기록) → 재시도 → 게이트웨이 보정 → vision 보정
    # (최내곽, transport 직전). 보정을 안쪽에 두는 이유: 재시도가 같은 요청을 다시 보낼
    # 때도 보정된 형태로 나간다. vision 보정은 **프로파일별**이라 폴백 체인에서 gauss 만
    # 강등되고 gemma 는 이미지를 그대로 받는다.
    recorder = ServedProfileRecorder()
    clients = [
        tag_profile(
            wrap_retry(wrap_gateway_compat(
                wrap_vision_compat(core_build(profiles[n]), profile=n),
            )),
            profile=n, model=getattr(profiles[n], "model", None), recorder=recorder,
        )
        for n in ordered
    ]
    client = clients[0] if len(clients) == 1 else FallbackLLMClient(clients)
    return attach_recorder(client, recorder)


def _unlock_all(harness: Any, registry: Any) -> None:
    """에이전트 전용 registry = 화이트리스트 — 모든 도구를 unlock 상태로 노출."""
    for cls in registry.all():
        harness.context.unlocked_tools.add(cls.name)


async def run_agent(
    *,
    tool_classes: list[type],
    skill_body: str,
    user_text: str,
    label: str,
    terminal_tools: set[str],
    charter_ref: str = "",
    max_turns: int = 40,
    max_wall_clock_sec: int | None = None,
    max_idle_sec: int | None = None,
    max_tokens_total: int | None = None,
    evidence_dir: Path | None = None,
    extra_metadata: dict[str, Any] | None = None,
    candidate_ledger_enforce: bool = False,
    require_terminal_tool: bool = False,
    llm_profile: str | None = None,
    require_vision: bool = False,
) -> dict[str, Any]:
    """한 에이전트 1 실행. 반환: {reason, turns, saw_terminal, tokens_in/out, evidence_dir}.

    skill_body 가 system 프롬프트(=contract 본문). tool_classes 가 노출 도구 화이트리스트.
    candidate_ledger_enforce: 침묵 게이트(v3.90) opt-in — 헌팅 워커만 True.
    SA_CANDIDATE_LEDGER=0 은 운영 kill-switch (코어 워커 cli 와 동일 시맨틱).
    require_terminal_tool: 종료도구 게이트(CORE-ASK ④) opt-in — set_status 종료가 **필수**인
      워커만 True(confluence/github/smb task). gauss 가 종료 도구를 tool_use 대신 텍스트로만
      내고 끝내는 weak-model 실패모드를 엔진 텍스트-only 캐스케이드에서 리마인더로 되돌린다.
      코어 ④ 미머지 시 이 metadata 키는 코어가 무시(additive·무해). SA_REQUIRE_TERMINAL_TOOL=0
      은 운영 kill-switch.
    llm_profile: **도메인 기본 프로파일**(워커가 자기 도메인에 맞는 모델을 선언). env
      `SA_CHAT_PROFILE` 이 있으면 그쪽이 이긴다 — 기본값이지 핀이 아니다.
    require_vision: 이 워커는 이미지 근거가 필수(smb_inspect_image·스크린샷). True 면
      선택된 프로파일이 이미지를 못 받을 때만 `llm_profile` 로 **대체**한다 — env 우선
      계약의 유일한 예외이자, 전역 핀 아래에서 이 배선이 死코드가 되지 않게 하는 장치.
    """
    _ensure_dotenv()
    from secu_agent.agent.candidate_ledger import (
        candidate_ledger_stats, candidate_ledger_unreconciled,
    )
    from secu_agent.agent.events import (
        LoopCompleted, LoopError, ToolCallCompleted, ToolCallStarted,
    )
    from secu_agent.agent.finding_provenance import runtime_llm_metadata
    from secu_agent.agent.harness.budget import AgentBudget
    from secu_agent.agent.harness.runner import GuardedHarness
    from secu_agent.agent.llm.messages import TextBlock, UserMessage

    from service.agents.llm_provenance import llm_recorder

    ev_dir = evidence_dir or make_evidence_dir(label)
    registry = _build_registry(tool_classes)
    client = _build_client(llm_profile, require_vision=require_vision)
    budget_kwargs: dict[str, Any] = {"max_turns": max_turns}
    if max_wall_clock_sec is not None:
        budget_kwargs["max_wall_clock_sec"] = max_wall_clock_sec
    if max_idle_sec is not None:
        budget_kwargs["max_idle_sec"] = max_idle_sec
    if max_tokens_total is not None:
        budget_kwargs["max_tokens_total"] = max_tokens_total
    harness = GuardedHarness(
        client=client, registry=registry, evidence_dir=ev_dir,
        budget=AgentBudget(**budget_kwargs),
    )
    harness.context.metadata["charter_ref"] = charter_ref or os.environ.get(
        "DEFAULT_CHARTER_REF", "SECOPS-2026-001",
    )
    # v3.93 finding provenance: 설정된 프로파일/체인을 먼저 심는다. 엔진
    # `agent_provenance` 가 이 고정 키들만 finding extra 로 옮기므로, 이게 있어야
    # "어떤 모델이 찾았나"가 DB 에 남는다(이전엔 워커 finding 전부 llm_profile=None).
    harness.context.metadata.update(runtime_llm_metadata(client))
    if extra_metadata:
        harness.context.metadata.update(extra_metadata)
    # 실제 서빙 프로파일로 실시간 갱신 — 폴백이 뛰면 설정값을 덮는다. extra_metadata
    # **뒤**에 bind 하는 이유: 런타임 실측이 호출자가 넘긴 정적 값보다 우선이다.
    _recorder = llm_recorder(client)
    if _recorder is not None:
        _recorder.bind(harness.context.metadata)
    # SA_CANDIDATE_LEDGER=0 은 권위적 kill-switch(codex #18): extra_metadata 가
    # 넣은 True 도 끈다. 아니면 헌팅 워커 opt-in 만 켠다.
    if os.environ.get("SA_CANDIDATE_LEDGER", "1").strip().lower() in {
        "0", "false", "no", "off",
    }:
        harness.context.metadata["candidate_ledger_enforce"] = False
    elif candidate_ledger_enforce:
        harness.context.metadata.setdefault("candidate_ledger_enforce", True)
    # codex 2R #2: 엔진에 terminal_tools 를 알려야 엔진 terminal-분기 침묵 게이트가
    # 도메인 set_status 에 대해 리마인더→캡→완료를 태운다. 없으면 set_status 가
    # 엔진엔 일반 도구라, 침묵 시 max_turns 소진→over-block 으로 샌다.
    harness.context.metadata.setdefault("terminal_tools", set(terminal_tools))
    # CORE-ASK ④: 종료도구 게이트 opt-in. candidate_ledger_enforce 와 직교(그건 "후보
    # 미정산", 이건 "필수 종료 도구를 텍스트로만 냄"). SA_REQUIRE_TERMINAL_TOOL=0 kill-switch.
    if os.environ.get("SA_REQUIRE_TERMINAL_TOOL", "1").strip().lower() in {
        "0", "false", "no", "off",
    }:
        harness.context.metadata["require_terminal_tool"] = False
    elif require_terminal_tool:
        harness.context.metadata.setdefault("require_terminal_tool", True)
    _unlock_all(harness, registry)

    saw_terminal = False
    terminal_reason: str | None = None
    completion = None
    loop_error_message: str | None = None
    tool_inputs: dict[str, dict[str, Any]] = {}
    tool_calls: list[dict[str, Any]] = []
    terminal_calls: list[dict[str, Any]] = []
    try:
        async for evx in harness.run(
            initial_messages=[UserMessage(content=[TextBlock(text=user_text)])],
            system=skill_body,
        ):
            if isinstance(evx, ToolCallStarted):
                tool_input = evx.input if isinstance(evx.input, dict) else {}
                tool_inputs[evx.tool_use_id] = {
                    "name": evx.name,
                    "input": dict(tool_input),
                }
            elif isinstance(evx, ToolCallCompleted):
                from secu_agent.agent.tools.base import ToolSuccess
                call = dict(tool_inputs.get(evx.tool_use_id) or {
                    "name": evx.name,
                    "input": {},
                })
                call["success"] = isinstance(evx.result, ToolSuccess)
                tool_calls.append(call)
                if evx.name in terminal_tools and isinstance(evx.result, ToolSuccess):
                    saw_terminal = True
                    terminal_reason = f"terminal_tool:{evx.name}"
                    call["result_content"] = evx.result.content
                    terminal_calls.append(call)
                    if candidate_ledger_unreconciled(harness.context.metadata):
                        # 침묵 부채(후보 관찰 & 제출·기각 0) — 여기서 끊으면 엔진
                        # 침묵 게이트가 개입할 기회가 없다. break 를 미루고 계속
                        # 소비해 엔진이 terminal 분기에서 리마인더를 주입하게 둔다
                        # (게이트 캡 도달 시 엔진이 스스로 완료를 내보내므로 유한).
                        continue
                    harness.context.signal.set()
                    break
            elif isinstance(evx, LoopError):
                log.warning("[agent:%s] loop error: %s", label, evx.message)
                loop_error_message = evx.message
            elif isinstance(evx, LoopCompleted):
                completion = evx
    finally:
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001
            pass

    seen, submitted, triaged = candidate_ledger_stats(harness.context.metadata)
    return {
        "label": label,
        "reason": completion.reason if completion else (terminal_reason or "no_completion"),
        "turns": completion.total_turns if completion else 0,
        "saw_terminal": saw_terminal,
        "error": loop_error_message,
        "tokens_in": (completion.usage.input_tokens if completion and completion.usage else 0),
        "tokens_out": (completion.usage.output_tokens if completion and completion.usage else 0),
        "evidence_dir": str(ev_dir),
        "tool_calls": tool_calls,
        "terminal_calls": terminal_calls,
        "candidates_seen": seen,
        "candidates_accounted": submitted + triaged,
    }


def load_skill_body(skill_path: str | Path) -> str:
    """SKILL.md 본문 로드 (frontmatter 제거 후 시스템 프롬프트로 사용)."""
    text = Path(skill_path).read_text(encoding="utf-8")
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            return parts[2].strip()
    return text.strip()


def _skill_search_dirs() -> list[Path]:
    """skill 탐색 경로 — 4도메인 기본 + env `SA_SKILLS_DIRS`. **해석 경로로 dedup.**

    ⚠️ dedup 이 없으면 같은 디렉터리를 두 번 스캔한다. 실제로 그랬다(2026-08-20 실측):

      1. 여기서 4도메인 skills 를 **하드코딩**으로 넣는다.
      2. 각 도메인 `infrastructure/runtime.py` 가 워커 subprocess 를 띄울 때
         `SA_SKILLS_DIRS=<자기 도메인 skills>` 를 주입한다(자기 계약 위치 명시).
      3. → 스폰한 도메인의 디렉터리가 목록에 **두 번** 들어간다.

    결과는 워커 로그마다 도는 경고였다 — `skill 이름 충돌 — 무시: github_task
    (<경로>; 선등록 <같은 경로>)`, 도메인 skill 수만큼(github 은 4줄). 같은 디렉터리라
    first-wins 가 같은 skill 을 고르므로 **동작 자체는 옳았다.** 문제는 두 가지다:
    디렉터리를 두 번 훑고, 진짜 이름 충돌(다른 경로의 동명 skill)이 이 소음에 묻힌다.

    코어 `resolve_skills_dirs()` 는 처음부터 `if resolved in dirs: continue` 로
    dedup 한다 — 같은 시맨틱으로 맞춘다.
    """
    repo = Path(__file__).resolve().parents[2]
    raw_dirs: list[Path] = [
        # 도메인 무관 계약(리드) — 4도메인이 **같은 본문**을 쓴다. 도메인 skills 에
        # 복사하면 5벌이 되고 그중 하나가 조용히 뒤처진다.
        repo / "_shared" / "skills",
        repo / "domains" / "smb" / "skills",
        repo / "domains" / "dev_web" / "skills",
        repo / "domains" / "services" / "github" / "skills",
        repo / "domains" / "services" / "confluence" / "skills",
    ]
    for raw in (os.environ.get("SA_SKILLS_DIRS") or "").split(os.pathsep):
        raw = raw.strip()
        if raw:
            raw_dirs.append(Path(raw))

    dirs: list[Path] = []
    seen: set[Path] = set()
    for d in raw_dirs:
        # 심볼릭 링크/상대경로가 섞여도 같은 곳을 가리키면 한 번만 넣는다. 없는 경로를
        # 여기서 거르지는 않는다 — 코어 loader 가 빈 목록으로 처리하는 게 그쪽 소관이다.
        key = d.expanduser().resolve()
        if key in seen:
            continue
        seen.add(key)
        dirs.append(d)
    return dirs


def load_skill_contract(skill_name: str, *, resource: str | None = None) -> str:
    """Load an individually selectable skill or one of its resource files.

    Core `secu-agent` already supports loading external directory skills through
    SA_SKILLS_DIRS. The SMB E2E agents use the same loader instead of hard-coded
    prompt paths so each worker can run with exactly one skill contract.
    """
    from secu_agent.agent.skills import load_skills_all

    skills = load_skills_all(dirs=_skill_search_dirs())
    skill = next((s for s in skills if s.name == skill_name), None)
    if skill is None:
        raise FileNotFoundError(f"skill not found: {skill_name}")
    if resource is None:
        return skill.body.strip()
    if skill.dir_path is None:
        raise FileNotFoundError(f"skill has no resources: {skill_name}")
    if resource not in skill.resources:
        raise FileNotFoundError(f"resource not found: {skill_name}/{resource}")
    target = (skill.dir_path / resource).resolve()
    target.relative_to(skill.dir_path.resolve())
    return target.read_text(encoding="utf-8").strip()
