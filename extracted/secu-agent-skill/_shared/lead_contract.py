"""리드 공통 실행계약 팩토리 — 5개 큐 동일 규격 (Phase 2a).

검토원 계약(`_shared/inspect_contract.py`)과 대칭이다. 다른 점만 적는다:

| | 검토원 | 리드 |
|---|---|---|
| 도구셋 | 도메인마다 다름(오늘 워커) | **5개 고정**(`lead_tools`) |
| 본문 열람 | 한다(그게 일이다) | **못 한다**(도구 없음) |
| 종료 도구 | 도메인마다 다름 | `set_target_status` 하나 |
| 큐 소유 | 위임된 경우 **아님** | **소유자** |
| 모델(Phase 3) | 사내(deepseek/gemma) | codex(사외) |

## agents_dir 를 metadata 로 싣는 이유

코어 `load_agents()` 는 **디렉터리 하나**만 본다(`AgentTool._resolve_agents_dir` →
`ctx.metadata["agents_dir"]`). 리드마다 자기 도메인 `agents/` 를 실으면:
  · 코어 확장 없이 도메인 검토원에 닿는다(`register_subagent_dir` 불필요).
  · **github 리드는 smb 검토원을 spawn 할 수 없다** — 경계가 하나 더 생긴다.

## 큐 소유권 분담 (사용자 확정 2026-08-21)

큐는 리드가 닫는다. 그러면 smb 는 닫는 주체가 리드와 검토원 계약(`on_no_submit`)
**둘**이 되므로 depth 로 나눈다 — `_shared/agent_depth.py` 참조.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("shared.lead_contract")

LEAD_SKILL_NAME = "lead"
LEAD_SKILL_RESOURCE = "lead.md"

# 역할별 프로파일. Phase 3 에서 여기에 codex 가 들어간다.
LEAD_PROFILE_ENV = "SA_LEAD_PROFILE"
# 리드 전용 폴백 체인. **미설정 = 폴백 없음**(리드 프로파일 하나로만 돈다).
LEAD_CHAIN_ENV = "SA_LEAD_PROFILE_CHAIN"

_OFF = {"0", "false", "no", "off"}


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _flag(name: str, default: bool) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw not in _OFF


def _ensure_env() -> None:
    """검토원 계약과 같은 이유 — 코어 워커 CLI 경로에는 스킬 `.env` 를 부르는 사람이 없다."""
    from service.agents import runtime
    runtime._ensure_dotenv()


# ══════════════════════════════════════════════════════════════════════════════
# 리드 예산 — 벽시계·토큰은 풀고, idle·턴만 남긴다 (사용자 결정 2026-08-27)
# ══════════════════════════════════════════════════════════════════════════════
#
# ## 왜 풀었나
#
# 벽시계 1800s 는 **건강한 일을 죽이고 있었다.** github 리드 실기동:
#
#     15턴 · 1800.8s · 166k 토큰 · 닫은 타깃 0건 · finding 0건
#     budget_trip: kind=wall_clock
#
# 리드는 멀쩡히 검토원과 대화하는 중이었다. 브라우저·GHE 검색은 답 하나에 5분을
# 쉽게 넘기고, 그게 정상 속도다. 시간으로 자르면 느린 도메인이 영원히 못 끝낸다.
#
# ## 무엇이 대신 지키나
#
#     idle 300s   ★ 진짜 backstop. **자식이 죽었을 때만** 운다.
#                   keepalive(`inspector_channel.keep_parent_alive`)가 자식 evidence 가
#                   실제로 변할 때만 진척을 보고하므로, 살아 있으면 안 울고 죽으면 운다.
#     turns 40    폭주 방어. 도구를 계속 부르며 안 끝나는 런은 idle 에 안 걸린다 —
#                 이걸 지우면 멈출 것이 하나도 없다. 그래서 남긴다.
#
# ⚠️ 0 을 쓰면 안 된다. `AgentBudget` 필드는 int 이고 검사가 `elapsed > limit` 라
#    0 은 "무제한" 이 아니라 **즉시 초과**다. 그래서 센티넬을 쓴다.
_NO_LIMIT_SEC = 10 ** 9          # ≈ 31년. 사실상 무제한이되 산술은 안전하다.
_NO_LIMIT_TOKENS = 10 ** 12


def lead_wall_sec_default() -> int:
    """리드 벽시계 기본값. **러너가 이걸 읽는다** — 숫자를 두 곳에 적지 않기 위해서다."""
    return _NO_LIMIT_SEC


def lead_tokens_default() -> int:
    """리드 토큰 상한 기본값."""
    return _NO_LIMIT_TOKENS


def build_lead_contract(
    *,
    domain: str,
    agents_dir: Path,
    default_turns: int = 40,
    default_wall_sec: int = _NO_LIMIT_SEC,
    default_idle_sec: int = 300,
    default_tokens: int = _NO_LIMIT_TOKENS,
    env_prefix: str = "SA_LEAD",
    extra_metadata: Callable[[dict], dict[str, Any]] | None = None,
):
    """리드 하나의 실행계약. `domain` 은 등록된 `LeadAdapter.domain` 과 같아야 한다."""
    from secu_agent.agent.task_contract import TaskContract

    from _shared.egress_capture import wrap_egress_capture
    from _shared.lead_tools import LEAD_DOMAIN_KEY

    task_type = f"{domain}_lead"

    def _system_prompt(spec: dict) -> str:
        _ensure_env()
        from service.agents import runtime
        body = runtime.load_skill_contract(
            LEAD_SKILL_NAME, resource=LEAD_SKILL_RESOURCE)
        if not body.strip():
            raise RuntimeError(
                f"리드 계약 본문이 비어 있다: {LEAD_SKILL_NAME}/{LEAD_SKILL_RESOURCE}"
            )
        # ★ 롤백 스위치가 **도구만** 끄고 계약 본문은 그대로 두면, 리드가 없는 도구를
        #   부르며 턴을 버린다 — 2026-08-21 A/B 에서 `open_inspection: err:not_found`
        #   가 두 번 났다. 도구면이 바뀌면 계약도 같이 바뀌어야 한다.
        from _shared.lead_tools import _sessions_enabled

        if not _sessions_enabled():
            body += (
                "\n\n---\n\n"
                "⚠️ **이 런에서는 세션 도구가 비활성이다** (`open_inspection` / "
                "`ask_inspector` / `close_inspection` 은 존재하지 않는다). 위 세션 절차는 "
                "무시하고 위임은 `delegate_inspect` 로만 하라 — 없는 도구를 부르면 "
                "not_found 로 턴만 버린다."
            )
        return body

    def _user_message(spec: dict, evidence_dir: Path | None) -> str:
        _ensure_env()
        from _shared.lead_adapter import get_lead_adapter, lead_adapter_names

        adapter = get_lead_adapter(domain)
        if adapter is None:
            raise RuntimeError(
                f"리드 어댑터 미등록: {domain!r} (등록된 것: {list(lead_adapter_names())})"
            )
        target = spec.get("target") or {}
        goal = str(target.get("goal") or "").strip()
        focus = target.get("target_ids") or target.get("target_id")
        lines = [
            f"[{adapter.queue_label} 리드] charter_ref={spec.get('charter_ref') or ''}",
            f"도메인={adapter.domain}  검토원={adapter.inspect_agent}",
            f"큐 상태 어휘={list(adapter.statuses)}",
            "",
            "너는 **판단**한다: 큐를 보고, 어디를 볼지 정하고, 검토원에게 맡기고, "
            "돌아온 보고로 다음 수를 정한다.",
            "본문·크리덴셜 값·PII 값은 너에게 오지 않는다 — 그건 검토원이 본다. "
            "네가 받는 것은 좌표(호스트/경로/repo/크기/담당자)와 마스킹된 요약이다.",
            "",
            "절차:",
            "1. list_targets 로 큐를 본다.",
            "2. target_detail 로 후보를 좁히고, target_hit_summary 로 이미 잡힌 것을 본다 "
            "(본문은 안 온다 — 목록·메타·마스킹된 요약뿐).",
            "3. open_inspection 으로 검토원 **세션**을 열고 ask_inspector 로 하나씩 묻는다. "
            "여러 세션에 같은 턴에 물으면 병렬로 돈다. 다 본 세션은 close_inspection 으로 "
            "즉시 닫아라(열어놓고 놀리면 자리만 먹는다).",
            "4. 보고가 다음 수를 바꾸면 record_pivot 으로 근거를 남긴다.",
            "5. **타깃 하나를 다 봤으면 그 자리에서** set_target_status 로 닫는다. "
            "전부 본 뒤 몰아서 닫지 마라 — 예산이 먼저 끝나면 그때까지 한 일을 통째로 "
            "잃는다(github 리드가 15턴·166k 토큰을 쓰고 0건을 닫았다). "
            "검토원은 위임받았을 때 큐를 닫지 않는다.",
            "6. **닫았으면 다음 타깃으로 간다.** 큐가 비거나 턴이 다할 때까지 3~5를 반복하라 "
            "— 한 라운드 하고 끝내지 마라. 실측 2026-08-27: smb 리드가 9턴만 쓰고 "
            "1건만 닫고 끝냈다(상한 40턴). 큐에는 215건이 밀려 있었다. "
            "세션 상한에 걸리면 다 본 세션을 close_inspection 으로 닫고 그 자리를 다음 "
            "타깃에 써라 — 상한은 동시 개수 제한이지 총 개수 제한이 아니다.",
        ]
        # ★ 도구면이 바뀌면 절차도 같이 바뀐다. 계약 본문(`lead.md`)에만 롤백 안내를
        #   달고 여기를 그대로 두면, **유저 메시지가 없는 도구를 지시**한다 — 그리고
        #   유저 메시지는 시스템 프롬프트보다 늦게 읽히는 '이번 작업 지시' 라 모델이
        #   더 무겁게 받는다. 2026-08-21 에 계약 본문에서 한 번 데인 자리다
        #   (중복 섹션 → 리드가 단발을 골랐다). 같은 함정이 여기 남아 있었다.
        from _shared.lead_tools import _sessions_enabled

        if not _sessions_enabled():
            # 인덱스로 짚지 않는다 — 위 리터럴에 줄이 하나 끼면 조용히 엉뚱한 줄을
            # 덮어쓴다. 접두어로 찾고, 못 찾으면 그건 버그다(조용히 넘어가지 않는다).
            hits = [i for i, ln in enumerate(lines) if ln.startswith("3. ")]
            if len(hits) != 1:
                raise RuntimeError(
                    f"리드 절차 3을 특정 못 했다(후보 {len(hits)}개) — "
                    f"lines 리터럴이 바뀌었으면 이 분기도 같이 고쳐라"
                )
            lines[hits[0]] = (
                "3. delegate_inspect 로 **범위 단위** 위임한다"
                "(파일 1개씩 맡기지 마라 — 위임 비용). "
                "이 런에서는 세션 도구가 비활성이다."
            )
        if goal:
            lines += ["", f"이번 런의 목표: {goal}"]
        if focus:
            lines += ["", f"우선 볼 타깃: {focus}"]
        return "\n".join(lines)

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
        # Phase 3a: 크리덴셜 **지문** salt. 검토원 subprocess 가 os.environ 를 상속하므로
        # 여기서 한 번 만들면 이 런 안의 모든 검토원이 같은 salt 를 쓴다 → 리드가
        # "아까 그 크리덴셜과 같은 건가" 를 값 노출 0 으로 판정할 수 있다.
        # ⚠️ salt 없이 sha256 을 쓰면 짧은 비번은 사전 대입으로 확인된다.
        from _shared.lead_masking import _fp_salt
        _fp_salt()

        md: dict[str, Any] = {
            "terminal_tools": {"set_target_status"},
            # 세션 spec 이 부모 charter 를 상속한다(코어 AgentTool 의 inherit_charter_ref
            # 와 같은 목적 — 감사추적을 끊지 않는다).
            "charter_ref": str(spec.get("charter_ref") or ""),
            LEAD_DOMAIN_KEY: domain,
            # 코어 AgentTool 이 검토원 정의를 찾는 유일한 경로. 이 리드는 이 디렉터리
            # 안의 검토원만 spawn 할 수 있다.
            "agents_dir": str(agents_dir),
        }
        if extra_metadata is not None:
            md.update(extra_metadata(spec))
        md["candidate_ledger_enforce"] = _flag("SA_CANDIDATE_LEDGER", False)
        md["require_terminal_tool"] = _flag("SA_REQUIRE_TERMINAL_TOOL", True)
        return md

    def _build_client(profile: Any, profiles: dict[str, Any], spec: dict) -> Any:
        """리드 client — 검토원과 같은 래퍼 체인.

        ⚠️ 리드는 **이미지를 받지 않는다**(스크린샷은 본문이다) — vision 대체 슬롯 없음.
        Phase 3 에서 여기 profile 이 codex 로 바뀐다. 지금은 전역 프로파일 그대로다.
        """
        _ensure_env()
        from service.agents.runtime import _build_client as skill_build_client

        # Phase 3c: 리드만 다른 모델을 쓴다(사외 codex). 검토원은 전역 프로파일 그대로.
        # 오타/은퇴 이름이면 runtime 이 **사내 기본**으로 떨어뜨린다(codex fail-open 아님).
        role_profile = (os.environ.get(LEAD_PROFILE_ENV) or "").strip() or None
        # ★ 역할 프로파일이 명시됐으면 **전역 체인을 물려받지 않는다.**
        #   전역 `SA_CHAT_PROFILE_CHAIN` 은 검토원(사내 모델)용이다. 그걸 리드가 물면
        #   codex 로 시작해 gemma 로 조용히 넘어가고, 리드의 판단이 어느 모델에서 나왔는지
        #   구분되지 않는다 — 2026-08-22 게이트에서 실제로 그 확인에 시간을 썼다.
        #   폴백을 원하면 `SA_LEAD_PROFILE_CHAIN` 으로 **명시**하면 된다(미설정=폴백 없음).
        kwargs = {"require_vision": False, "override": role_profile}
        if role_profile:
            kwargs["chain_env"] = LEAD_CHAIN_ENV
        client = skill_build_client(None, **kwargs)
        # Phase 3d: egress 실측 — 리드가 실제로 내보내는 요청을 그대로 적는다.
        # 프롬프트를 신뢰하지 않는다. 미설정이면 무래핑(byte-for-byte 동일).
        client = wrap_egress_capture(client, role="lead", task_type=task_type)
        served = getattr(client, "_profile_name", None)
        core_choice = getattr(profile, "name", None)
        if served and core_choice and served != core_choice:
            log.warning(
                "[%s] 프로파일 선택이 갈렸다 — 코어=%s, 실제=%s", task_type,
                core_choice, served,
            )
        return client

    def _audit_egress(evidence_dir: Path) -> None:
        """리드가 실제로 내보낸 바이트를 판정하고 결과를 증거로 남긴다.

        경계는 프롬프트가 아니라 세 겹(도구 등록·닫힌 봉투·마스킹)이고, 그게 지켜졌는지는
        **보낸 바이트**로만 알 수 있다. 그 판정기(`docs/probes/egress_audit.py`)는 여태
        손으로만 돌렸다 — 즉 대부분의 런은 검사된 적이 없다. 여기서 자동으로 돌린다.

        ⚠️ **런을 실패시키지 않는다.** 여기 도달했을 땐 바이트가 이미 나갔다. 실패로
        만들어도 되돌릴 수 없고, 정리(세션 닫기)까지 같이 죽이면 더 나쁘다. 대신
        `egress_audit.json` 에 남기고 PASS 가 아니면 크게 로그한다.
        ⚠️ INCONCLUSIVE 도 PASS 가 아니다 — 코퍼스가 비면 "검사를 안 한 것" 이다.
        """
        try:
            from docs.probes.egress_audit import audit
        except Exception as e:  # noqa: BLE001 — 판정기 부재가 런을 죽이면 안 된다
            log.debug("[%s] egress 판정기 로드 실패: %r", task_type, e)
            return
        try:
            report = audit(evidence_dir)
        except Exception as e:  # noqa: BLE001
            log.warning("[%s] egress 판정 실패: %r", task_type, e)
            return
        try:
            (evidence_dir / "egress_audit.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            log.warning("[%s] egress 판정 기록 실패: %r", task_type, e)
        verdict = str(report.get("verdict") or "?")
        if verdict == "PASS":
            log.info("[%s] egress 판정 PASS — 요청 %s건 / 교차대조 윈도 %s개",
                     task_type, report.get("requests"), report.get("inspector_windows"))
            return
        log.error(
            "[%s] ★ egress 판정 %s — 모양위반=%s 교차대조=%s 코퍼스빔=%s (%s)",
            task_type, verdict, report.get("shape_hits"), report.get("crossed_total"),
            report.get("corpus_empty"), evidence_dir / "egress_audit.json",
        )

    async def _cleanup(evidence_dir, *_a, **_k) -> int:
        """리드가 끝나면 열린 검토원 세션을 전부 닫는다.

        ★ 이 훅은 `ToolContext` 를 못 받는다 — 그래서 세션 장부가 모듈 레벨이고
        `evidence_dir` 를 키로 쓴다. 여기가 **1차 방어**다.

        ⚠️ **async 여야 한다.** 이 훅은 async `_run` 안에서 불려 실행 중 루프가 항상
        있으므로 sync 버전은 `asyncio.run()` 을 못 쓰고 정리를 건너뛴다 —
        2026-08-21 실기동에서 세션 4개가 그대로 남았다. 코어가 awaitable 을 await 한다.
        2차는 코어 serve 루프의 stdin EOF(부모가 사라지면 워커도 끝난다) — 둘 다 있어야
        정상 종료와 비정상 종료가 모두 덮인다. 검토원이 브라우저를 들고 있는 도메인이
        있어서(dev_web/confluence/github) 누수가 파일 하나로 끝나지 않는다.
        """
        from _shared.session_registry import close_all
        await close_all(evidence_dir)
        await asyncio.to_thread(_audit_egress, Path(evidence_dir))
        return 0

    async def _on_no_submit(evidence_dir, spec: dict, reason: str) -> int:
        await _cleanup(evidence_dir)
        # 리드의 '제출' 은 큐를 닫는 것(`set_target_status`)이다. 안 닫고 끝났으면
        # 그 타깃은 판정이 없는 채로 남는다 — 정상 종료가 아니다.
        # ⚠️ no_work 는 예외다: **코드가 큐를 조회해서** 닫을 대상이 하나도 없음을
        #    확인한 것이라 "안 닫고 끝났다" 가 아니라 "닫을 게 없었다" 다.
        #    (`report_no_targets` 가 세우는 면제. LLM 주장으로는 못 선다.)
        return 0 if str(reason or "").strip() in {"end_turn", "stop", "", "no_work"} else 3

    return TaskContract(
        task_type=task_type,
        build_user_message=_user_message,
        terminal_tools=frozenset({"set_target_status"}),
        budget=_budget,
        metadata=_metadata,
        system_prompt=_system_prompt,
        build_client=_build_client,
        on_submit=_cleanup,
        on_no_submit=_on_no_submit,
    )
