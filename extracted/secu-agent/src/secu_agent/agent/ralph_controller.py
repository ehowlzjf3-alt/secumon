"""v3.64 (H2): RalphController — ChatSession 에서 분리한 Ralph 루프/goal 오케스트레이터.

ai-soc 의 `tickets/phase_runner` 대응. engine(단일 turn LLM↔tool executor) + ChatSession
(영속/UX state holder) 위에서 **goal 진행·batch driver·continuation 을 결정론적으로 통제**한다.
통제권은 그대로 코드(컨트랙트-driven) — 모델로 넘기지 않는다(증명 가능한 결정론적 커버리지).

설계: stateless. ChatSession 을 collaborator(`self._s`)로 들고 그 자원
(session_id/client/messages/context/_run_engine_pass/_persist_last_assistant)을 콜백.
ChatSession.turn() 은 setup(메시지 영속·skill/brief 주입) 후 `RalphController(self).run()` 에 위임.

순수 relocation — 기존 ChatSession.turn() 의 Ralph 루프 + phase 메서드를 동작/이벤트/DB write
순서 무변으로 이동한 것. 기존 테스트가 동작 spec.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import os
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING, Any

from secu_agent import state
from secu_agent.agent.events import (
    GoalChecklistUpdated, GoalContinuation, GoalDecomposed, GoalDone, GoalPaused,
    LoopEvent,
)
from secu_agent.agent.goal_manager import (
    ChecklistItem, all_terminal, apply_evaluate, build_continuation_prompt,
    decompose as goal_decompose, evaluate as goal_evaluate, fallback_decompose,
    is_fallback_only_checklist,
    pause_goal_for_user_cancel,
)
from secu_agent.agent.llm.factory import make_role_client
from secu_agent.detectors.text_scan import mask_scanned_text
from secu_agent.agent.llm.messages import TextBlock, UserMessage

if TYPE_CHECKING:
    from secu_agent.agent.chat_session import ChatSession

log = logging.getLogger(__name__)

_DEFAULT_GOAL_JUDGE_EVERY = 3
_DEFAULT_GOAL_NO_PROGRESS_LIMIT = 3
_DEFAULT_GOAL_EVIDENCE_SKIP_MAX = 5

# F2-B evidence-delta pre-gate: goal 별 마지막으로 **clean judge 한** 증거 digest 해시와
# 그때의 turns_used(프로세스 수명 in-memory). judge 간격을 **턴 기준**(cap)으로 묶어
# judge_every 와의 곱셈 폭주를 막고, 재시작 시 비어 있어 첫 판정 턴은 judge(fail-safe).
# judge phase 는 부모 Ralph 루프(단일 스레드)에서만 돌아 goal 별 경합이 없다.
_LAST_JUDGE_HASH: dict[int, str] = {}
_LAST_JUDGE_TURN: dict[int, int] = {}


def _goal_evidence_skip_max() -> int:
    """evidence-unchanged 상태에서 judge 를 미룰 수 있는 **최대 턴 수**(turns_used 기준).
    SA_GOAL_EVIDENCE_SKIP_MAX(기본 5, 0=비활성). judge_every 와 무관하게 실제 judge 간격을
    이 턴수로 상한 → 안정 증거 위 산문-완료 케이스의 판정 지연을 묶는다."""
    raw = (os.environ.get("SA_GOAL_EVIDENCE_SKIP_MAX") or "").strip()
    if not raw:
        return _DEFAULT_GOAL_EVIDENCE_SKIP_MAX
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_GOAL_EVIDENCE_SKIP_MAX
    return value if value >= 0 else 0


def _clear_evidence_gate(goal_id: int) -> None:
    """goal 종료/일시정지 시 evidence-gate in-memory 상태 전체 정리(무한증가 방지).
    지워도 재개 시 첫 턴 judge(fail-safe) 라 안전. 이력이 남아도 turn-cap 이 self-heal."""
    _LAST_JUDGE_HASH.pop(goal_id, None)
    _LAST_JUDGE_TURN.pop(goal_id, None)


def _invalidate_judge_hash(goal_id: int) -> None:
    """판정 실패(예외/parse_fail) 시 **해시만** 무효화 — 다음 턴 stale 해시 스킵을 막되,
    last_turn(=cap 마감선)은 보존해 turn-cap 강제 판정이 계속 작동하게 한다(Z2/Z3)."""
    _LAST_JUDGE_HASH.pop(goal_id, None)


def _done_critic_enabled() -> bool:
    """F2-E done-critic 활성 여부. SA_GOAL_DONE_CRITIC=0/false 로 끌 수 있음(기본 on)."""
    raw = (os.environ.get("SA_GOAL_DONE_CRITIC") or "").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _done_critic_reason(
    checklist: list["ChecklistItem"], evidence_digest: str,
) -> str | None:
    """F2-E: 터미널-done 이 **인용 증거 없이** 완료를 주장하면 다운그레이드 사유를 반환.

    결정론 크리틱(LLM 없음). completed 항목이 있는데도
      ① 확정 findings digest 가 비어있고, ② 어떤 completed 항목도 실질 evidence 를
    인용하지 않으면 → needs_review 로 낮춘다(자동 done 보류, 사람 검토). findings 나 evidence
    가 하나라도 있으면 통과(informational goal 처럼 산문 evidence 로 완료도 정상 인정).
    completed 가 없으면(전부 impossible 등) 이 크리틱 대상 아님(None).

    G1(대폭 완화, #17): evidence_digest 는 goal-scoped(since=created_at)로 좁혀져 무관 goal 의
    finding 이 이 goal 판정에 섞이는 것을 크게 줄인다(완전 해소 아님 — paused-overlap 등 시간창
    근사 한계는 _build_evidence_digest 참조). SA_GOAL_SCOPED_EVIDENCE=0 이면 전역 구동작.
    """
    completed = [it for it in checklist if it.status == "completed"]
    if not completed:
        return None
    if evidence_digest and evidence_digest.strip():
        return None  # 확정 findings 로 접지됨
    if any(it.evidence and it.evidence.strip() for it in completed):
        return None  # 최소 한 completed 항목이 실질 evidence 인용
    return (
        f"완료 주장 {len(completed)}건이 인용 증거 없음(확정 finding·evidence 모두 부재) "
        "— 자동 done 보류, 사람 검토 필요(F2-E done-critic)"
    )


def _goal_pause_checked(session_id: int, *, reason: str | None) -> bool:
    """v3.80 1주차-#2: goal_pause 반환값 가시화 래퍼.

    rowcount=0 = 이 코드가 보던 status 가 UPDATE 시점엔 이미 다른 경로
    (동시 세션·사용자 cancel·goal tool)로 전이됨. race 자체는 WHERE guard
    가 원자적으로 처리하므로 호출부 동작(이벤트/시스템노트)은 기존 그대로
    두고, 지금까지 운영 중 조용히 사라지던 실패만 로그로 드러낸다.
    """
    ok = state.goal_pause(session_id, reason=reason)
    if not ok:
        log.warning(
            "goal_pause 무효과 (rowcount=0) — 동시 전이 race: "
            "session=%s reason=%r", session_id, reason,
        )
    return ok


def _goal_mark_done_checked(session_id: int, *, reason: str | None) -> bool:
    """goal_mark_done 반환값 가시화 래퍼 — _goal_pause_checked 와 동일 취지."""
    ok = state.goal_mark_done(session_id, reason=reason)
    if not ok:
        log.warning(
            "goal_mark_done 무효과 (rowcount=0) — 동시 전이 race: "
            "session=%s reason=%r", session_id, reason,
        )
    return ok


def _goal_judge_every() -> int:
    raw = (os.environ.get("SA_GOAL_JUDGE_EVERY") or "").strip()
    if not raw:
        return _DEFAULT_GOAL_JUDGE_EVERY
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_GOAL_JUDGE_EVERY
    return value if value > 1 else 1


def _goal_scoped_evidence() -> bool:
    """F2 goal-scoped: evidence digest 를 goal 수명(last_seen>=created_at)으로 스코핑할지.
    SA_GOAL_SCOPED_EVIDENCE=0/false 로 끄면 전역 digest(구동작). 기본 on."""
    raw = (os.environ.get("SA_GOAL_SCOPED_EVIDENCE") or "").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _build_evidence_digest(
    *, since: float | None = None, limit: int = 15, max_chars: int = 1600,
) -> str:
    """F2: 최근 **확정(confirmed) findings** 를 judge 접지용 digest 로 만든다.

    judge 가 에이전트 산문(주장)이 아니라 **증거 게이트를 통과한 검증된 사실**로 완료를
    판정하게 한다(증거 맹목 해소). finding.summary 등은 F3 로 이미 마스킹됨 → judge 컨텍스트에
    평문 유출 없음. 조회 실패/빈 결과는 "" (fail-open — judge 는 기존대로 응답만 보고 판정,
    회귀 없음).

    F2 goal-scoped(#17): since(=goal.created_at)를 주면 **그 goal 수명 동안 관측된 finding**
    만 담는다(전역 dedup 모델이라 goal 소유가 없어 last_seen 시간창으로 근사). 무관한 이전
    goal 의 finding 이 이 goal 판정에 섞이는 것(F2-B/F2-E 의 전역-digest G1)을 크게 줄인다.
    since=None 이면 전역(구동작).

    근사 한계(true goal-scoping 아님 — finding-관측 추적이 필요한 더 큰 변경):
      ① goal 이 '이전 발견된 finding' 대상이고 재관측 안 하면 스코프 digest 가 비어 보임
         (재관측 시 last_seen 갱신→포함).
      ② goal B 가 paused 인 동안 다른 goal A 가 관측한 finding 은 last_seen>=B.created_at 이라
         B 재개 시 B digest 에 섞일 수 있음(S2).
    안전 방향: F2-E(done-critic)는 스코프가 좁아질수록 단조롭게 더 안전(더 자주 검토 pause).
    F2-B 는 혼합 — 스코프 밖 finding 만 있으면 digest 비어 항상 judge(더 안전), 스코프 안
    findings 는 digest 가 더 안정적이라 스킵이 늘 수 있음(S3, cap+boundary 로 상한=Z5 절충).
    """
    # 조회+행처리+마스킹 전체를 감싼다(F2-B V5): 마스킹/행 파싱 예외가 Ralph 루프를
    # 중단시키지 않게 — 어떤 실패든 "" 로 fail-open(=judge 진행, 안전).
    try:
        # lifecycle 의 확정 finding 은 status="open"(신규/활성) — "confirmed" 는 없다.
        # finding_lifecycle 에는 증거 게이트를 통과한(should_persist) finding 만 들어간다.
        rows = state.finding_list(status="open", since=since, limit=limit)
        lines: list[str] = []
        for r in rows:
            sev = str(r.get("severity", "?"))
            tt = str(r.get("task_type", "") or "")
            # 경계 재마스킹(codex 리뷰): asset(원문 가능)·summary 를 judge 컨텍스트에 넣기 전
            # 다시 마스킹 — F3 를 우회한 경로로 들어온 finding 도 평문 유출 없게(defense-in-depth).
            asset = mask_scanned_text(str(r.get("asset", "") or ""))
            summary = mask_scanned_text(
                str(r.get("summary") or "").strip().replace("\n", " "),
            )
            lines.append(f"- [{sev}] {tt} @ {asset}: {summary}"[:200])
        return "\n".join(lines)[:max_chars]
    except Exception as e:  # noqa: BLE001 — 조회/행처리/마스킹 실패 전부 fail-open("")
        log.debug("evidence digest 실패 (무시): %r", e)
        return ""


def _goal_no_progress_limit() -> int:
    """v3.81 T1a: 연속 무진전 judge 턴 허용치. 0 = 비활성(termination_gap 재개방 — 운영자 명시 선택)."""
    raw = (os.environ.get("SA_GOAL_NO_PROGRESS_LIMIT") or "").strip()
    if not raw:
        return _DEFAULT_GOAL_NO_PROGRESS_LIMIT
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_GOAL_NO_PROGRESS_LIMIT
    return max(0, value)


class RalphController:
    """ChatSession 의 Ralph 루프 + goal/batch 오케스트레이션 소유 (v3.64 H2)."""

    def __init__(self, session: "ChatSession") -> None:
        self._s = session

    async def run(self) -> AsyncIterator[LoopEvent]:
        """Ralph loop — 한 번 engine pass 돌리고, active goal 있고 미완료면 continuation.

        ChatSession.turn() 의 setup(user msg 영속·skill/brief/plan-ack append) 이후 호출됨.
        """
        s = self._s
        while True:
            # v3.71: 루프 매 iteration 마다 압축 점검. batch 점검은 turn() 1회가
            # run() 루프로 수십 타깃을 도는데, turn() 시작의 maybe_compress 1번만으론
            # 루프 안에서 컨텍스트가 무한 증가(세션24 423K chars→176K tokens). 매 pass
            # 직전(직전 _persist_last_assistant/continuation 직후 = tool-pair 깨끗한 경계)
            # 에서 점검 → input 토큰 bounded. 비대상 세션은 즉시 no-op, 임계 미달도 cheap.
            await s.maybe_compress()
            async for ev in s._run_engine_pass():
                yield ev
                # ESC / cancel 신호면 즉시 outer loop 도 종료.
                # v3.79 ④: active goal 도 pause — 안 하면 batch driver 가 다음
                # 아무 user 메시지에서 goal 을 코드 결정론으로 재가동(재동작 버그).
                if s.context.signal.is_set():
                    s._persist_last_assistant()
                    pause_goal_for_user_cancel(s.session_id)
                    return

            assistant_text = s._persist_last_assistant()

            # goal evaluation phase — active goal 있으면 judge 돌림
            goal = await asyncio.to_thread(state.goal_get_active, s.session_id)
            if not goal or goal["status"] != "active":
                return

            # de-domain: 도메인 batch driver(web/smb/subnet/github/confluence/devops)
            # 디스패치는 secu-agent-skill 로 적출됨 — 재부착 plugin hook 이 재공급.
            # (적출 원형: secu-agent-skill/engine_extracts/ralph_domain_phases.py)

            # decompose 안 됐으면 먼저 Phase-A
            if not goal["decomposed"]:
                async for ev in self._goal_decompose_phase(goal):
                    yield ev
                # 갱신된 goal 다시 읽기
                goal = await asyncio.to_thread(state.goal_get_active, s.session_id)
                if not goal or goal["status"] != "active":
                    return
                # decompose 실패면 paused → 빠져나감
                if not goal["decomposed"]:
                    return

            # Phase B
            done_event = None
            async for ev in self._goal_evaluate_phase(goal, assistant_text):
                yield ev
                if isinstance(ev, (GoalDone, GoalPaused)):
                    done_event = ev
            if done_event is not None:
                return

            # budget / continuation
            goal = await asyncio.to_thread(state.goal_get_active, s.session_id)
            if not goal or goal["status"] != "active":
                return
            # max_turns <= 0 → 무제한 (turn 캡 없음). 종료 경로: judge 완료 /
            # ESC / parse-fail 3x / 무진전 judge N회 (v3.81 T1a). 그 외엔 소진 시 pause.
            if goal["max_turns"] > 0 and goal["turns_used"] >= goal["max_turns"]:
                _goal_pause_checked(s.session_id, reason="max_turns 소진")
                _clear_evidence_gate(int(goal["id"]))  # R5: 외부 pause 경로도 gate 정리
                note = "goal pause: max_turns 소진"
                state.chat_message_add(
                    s.session_id, role="system", content={"text": note},
                )
                yield GoalPaused(
                    goal_text=goal["goal_text"], reason="max_turns 소진",
                )
                return
            if goal["parse_fail_streak"] >= 3:
                _goal_pause_checked(s.session_id, reason="judge parse fail 3x")
                _clear_evidence_gate(int(goal["id"]))  # R5: 외부 pause 경로도 gate 정리
                state.chat_message_add(
                    s.session_id, role="system",
                    content={"text": "goal pause: judge parse fail 3x"},
                )
                yield GoalPaused(
                    goal_text=goal["goal_text"], reason="judge parse fail 3x",
                )
                return

            # continuation inject — 새 user message 로 박고 다음 iteration
            items = [
                ChecklistItem.from_dict(d) for d in goal["checklist"]
            ]
            cont_text = build_continuation_prompt(
                goal["goal_text"], items, criteria=goal.get("criteria") or [],
            )
            state.chat_message_add(
                s.session_id, role="user", content={"text": cont_text},
            )
            s.messages.append(UserMessage(content=[TextBlock(text=cont_text)]))
            yield GoalContinuation(
                turn_used=goal["turns_used"], max_turns=goal["max_turns"],
            )
            # 다음 iteration → engine 다시 호출

    async def _goal_decompose_phase(
        self, goal: dict[str, Any],
    ) -> AsyncIterator[LoopEvent]:
        """Phase A — judge LLM 으로 goal → checklist 분해. 결과 영속 + event yield."""
        s = self._s
        # v3.81 T1c: judge 역할 모델 분리 — SA_JUDGE_PROFILE 설정 시 그 모델,
        # 아니면 세션 client (decompose/evaluate 동일 라우팅).
        judge_client = make_role_client("judge", default=s.client)
        try:
            result = await goal_decompose(
                client=judge_client, goal_text=goal["goal_text"],
            )
        except Exception as e:
            result = None
            err = str(e)
        else:
            err = None
        if result is None or result.parse_failed:
            reason = f"decompose 실패: {err}" if err else "decompose 응답 JSON 파싱 실패"
            raw = err or (result.raw if result is not None else "")
            result = fallback_decompose(goal["goal_text"], raw=raw)
            state.chat_message_add(
                s.session_id, role="system",
                content={
                    "text": (
                        "goal decompose fallback — "
                        f"{reason}; checklist {len(result.items)}개 생성"
                    )
                },
            )
        checklist_dicts = [it.to_dict() for it in result.items]
        state.goal_update_checklist(
            goal["id"], checklist=checklist_dicts, decomposed=True,
        )
        note = (
            f"goal decompose 완료 — checklist {len(result.items)}개 생성"
        )
        state.chat_message_add(
            s.session_id, role="system", content={"text": note},
        )
        yield GoalDecomposed(
            goal_text=goal["goal_text"], item_count=len(result.items),
        )

    async def _goal_evaluate_phase(
        self, goal: dict[str, Any], assistant_text: str,
    ) -> AsyncIterator[LoopEvent]:
        """Phase B — judge 로 checklist update + 완료 여부 결정."""
        s = self._s
        gid = int(goal["id"])
        turns_used = int(goal.get("turns_used", 0) or 0)
        max_turns = int(goal.get("max_turns", 0) or 0)
        cap = _goal_evidence_skip_max()
        last_hash = _LAST_JUDGE_HASH.get(gid)
        last_turn = _LAST_JUDGE_TURN.get(gid)

        # F2-B force-judge: 아래 두 조건은 **% N 스로틀·evidence 게이트를 모두 우회**해
        # 반드시 judge 하게 한다(R1/R2). ① boundary: max_turns 직전 마지막 턴은 스킵으로
        # 완료를 놓치지 않게. ② turn-cap: 마지막 clean judge 이후 cap 턴이 지나면 강제 —
        # judge_every 와 곱해져 실제 간격이 폭주하는 것을 막고, 실 judge 간격을 cap 턴으로 상한.
        near_boundary = max_turns > 0 and (turns_used + 1) >= max_turns
        cap_exceeded = (
            cap > 0 and last_turn is not None and (turns_used - last_turn) >= cap
        )
        force_judge = near_boundary or cap_exceeded

        judge_every = _goal_judge_every()
        if not force_judge and judge_every > 1 and turns_used % judge_every != 0:
            # v3.81 T1a: 게이트 턴은 parse_fail=None — judge 를 안 돌렸으므로 streak 을
            # 건드리면 안 된다 (False 로 리셋하면 parse-fail 3x 탈출구가 영구 미발동).
            state.goal_record_turn(
                goal["id"], verdict="continue",
                reason=f"judge gated every {judge_every} turns",
                parse_fail=None,
            )
            return

        # F2-B evidence-delta pre-gate: 접지 신호(확정 증거)가 직전 clean judge 이후 변하지
        # 않았고 비어있지 않으면(=findings 기반) 판정을 스킵. 빈 digest(informational goal,
        # 산문으로 완료)는 이 evidence-게이트로는 스킵 안 함(단 위 %N 게이트는 별개로 적용).
        # digest 실패는 ""(fail-open)→judge. force_judge
        # 이면 스킵 안 함.
        # 정직한 경계(Z5): judge 는 **최신 assistant_text 만** 본다 → 증거에 안 남고 딱 한 번
        # 산문으로만 선언된 완료는 스킵 턴에서 소실될 수 있다. 이는 **기존 % N 스로틀도 갖는
        # 동일한 절충**이며 F2-B 가 새로 만든 결함이 아니다(cap+boundary 로 지연·소실 창을 상한).
        # **증거 접지 완료는 절대 놓치지 않는다**(증거 변화=hash 불일치=judge). (#17 로 digest 를
        # goal-scoped=since 로 좁혀 무관 finding 혼입 해소; SA_GOAL_SCOPED_EVIDENCE=0 이면 전역.)
        # F2 goal-scoped(#17): 이 goal 수명 동안 관측된 finding 만 접지에 쓴다(무관 goal
        # finding 혼입=G1 해소). SA_GOAL_SCOPED_EVIDENCE=0 이면 전역(구동작).
        since = None
        if _goal_scoped_evidence():
            try:
                created = float(goal.get("created_at") or 0)
                # 유한 양수만(S1: inf/nan/≤0 은 잘못된 시간창 → 전역=구동작으로 폴백. 실 DB
                # 타임스탬프라 도달 불가한 방어. 폴백은 F2-E 엔 fail-open 임에 유의).
                since = created if (math.isfinite(created) and created > 0) else None
            except (TypeError, ValueError):
                since = None
        try:
            evidence_digest = _build_evidence_digest(since=since)
        except Exception as e:  # noqa: BLE001 — 방어적: digest 실패는 judge(안전)
            log.debug("evidence digest 실패 → judge 진행: %r", e)
            evidence_digest = ""
        digest_hash = (
            hashlib.sha256(evidence_digest.encode("utf-8")).hexdigest()
            if evidence_digest else ""
        )
        if (
            not force_judge
            and evidence_digest
            and cap > 0
            and last_hash is not None
            and last_hash == digest_hash
        ):
            # % N 게이트와 동일: streak 무접촉(parse_fail=None, progress=None 기본).
            state.goal_record_turn(
                gid, verdict="continue",
                reason=(
                    f"evidence unchanged — judge skipped "
                    f"(turn {turns_used}, last judged {last_turn}, cap {cap})"
                ),
                parse_fail=None,
            )
            return

        checklist = [ChecklistItem.from_dict(d) for d in goal["checklist"]]
        try:
            result = await goal_evaluate(
                client=make_role_client("judge", default=s.client),
                goal_text=goal["goal_text"],
                checklist=checklist,
                assistant_text=assistant_text,
                criteria=goal.get("criteria") or [],
                evidence_digest=evidence_digest,  # F2: 확정 findings 접지(위에서 1회 계산 재사용)
            )
        except Exception as e:
            _invalidate_judge_hash(gid)  # R3/Z2: 해시만 무효화(cap 마감선 last_turn 보존)
            state.goal_record_turn(
                goal["id"], verdict=None, reason=f"evaluate error: {e}",
                parse_fail=True,
            )
            return
        if result.parse_failed:
            _invalidate_judge_hash(gid)  # R3/Z2: 해시만 무효화(cap 마감선 last_turn 보존)
            state.goal_record_turn(
                goal["id"], verdict=None, reason="evaluate parse fail",
                parse_fail=True,
            )
            return

        new_checklist, flips = apply_evaluate(checklist, result)
        new_dicts = [it.to_dict() for it in new_checklist]
        state.goal_update_checklist(goal["id"], checklist=new_dicts)

        pending = sum(
            1 for it in new_checklist if it.status == "pending"
        )
        completed = sum(
            1 for it in new_checklist if it.status == "completed"
        )

        terminal = all_terminal(new_checklist)
        fallback_only_terminal = terminal and is_fallback_only_checklist(new_checklist)
        # F2-E done-critic: 실제 완료 주장이 인용 증거 없이 done 되는 것을 결정론적으로
        # needs_review 로 낮춘다(fallback-only 는 이미 needs_review 라 제외). fire-once:
        # 이미 검토 pause 된 goal(operator 가 resume=검토완료)은 재발동 안 함 → 재-pause 루프 방지.
        critic_reason = None
        already_flagged = bool(goal.get("done_critic_flagged"))
        if (
            terminal and not fallback_only_terminal
            and _done_critic_enabled() and not already_flagged
        ):
            critic_reason = _done_critic_reason(new_checklist, evidence_digest)
        needs_review_terminal = fallback_only_terminal or (critic_reason is not None)
        verdict = "needs_review" if needs_review_terminal else ("done" if terminal else "continue")
        # v3.81 T1a / audit #5: 진전 = flip 또는 **실제로 추가된** 신규 item.
        # apply_evaluate 가 new_items 를 dedup+cap 하므로 added 는 중복/무한증식을
        # 제거한 순증분이다(flip 은 in-place 교체라 길이 불변). judge 가 같은 항목을
        # 반복 재방출하면 added=0 → 무진전 streak 누적 → 안전 pause 발동(종료 갭 차단).
        added = len(new_checklist) - len(checklist)
        progressed = flips > 0 or added > 0
        streaks = state.goal_record_turn(
            goal["id"], verdict=verdict, reason=result.reason,
            parse_fail=False, progress=progressed,
        )

        # F2-B: verdict(checklist+turn)까지 영속된 뒤에야 이 증거 상태를 'clean judged'로 표시
        # (V3b: 영속 실패 시 해시를 남기지 않아 다음 턴 재판정). 예외/parse_fail 은 여기 못 옴 →
        # 해시 미갱신 → 재판정으로 streak 정상 진행. turn 도 저장해 turn-cap 을 건다.
        _LAST_JUDGE_HASH[gid] = digest_hash
        _LAST_JUDGE_TURN[gid] = turns_used

        # system note + frontend event
        if flips > 0 or result.new_items:
            note = (
                f"goal checklist update: flips={flips}, "
                f"new={len(result.new_items)}, "
                f"pending={pending}, completed={completed} — {result.reason}"
            )
            state.chat_message_add(
                s.session_id, role="system", content={"text": note},
            )
        yield GoalChecklistUpdated(
            flipped=flips, pending=pending, completed=completed,
            total=len(new_checklist), reason=result.reason,
        )

        if needs_review_terminal:
            # fallback-only 또는 F2-E done-critic 다운그레이드 → 자동 done 대신 검토 pause.
            pause_reason = (
                "fallback checklist reached terminal; not marking goal done automatically"
                if fallback_only_terminal else critic_reason
            )
            paused = _goal_pause_checked(s.session_id, reason=pause_reason)
            # F2-E fire-once: **pause 성공 후에만** flag(E1: 비원자성 안전측 — 도중 실패 시
            # flag 미설정→재-pause 이 skip-review 보다 안전). fallback 은 flag 안 함.
            # 성격(문서화): 이 크리틱은 evidence-less done 을 **자율 루프 정지 + GoalPaused +
            # 영속 flag(감사 흔적)**으로 surface 하는 review 게이트다. resume(operator/scheduler/
            # goal_tool) 은 fire-once 로 통과시킨다 — 강제 human sign-off(=flag 된 goal 을 자동
            # resume 금지)는 배포 정책. A1/A2(세션스코프 pause·동시 judge)는 단일스레드 judge
            # +기존 pause 의미라 F2-E 신규 회귀 아님.
            if critic_reason is not None and paused:
                state.goal_mark_critic_flagged(gid)
            _clear_evidence_gate(gid)  # V4: yield 前 정리(소비자 취소로 우회 방지)
            state.chat_message_add(
                s.session_id,
                role="system",
                content={"text": f"goal pause: {pause_reason}"},
            )
            yield GoalPaused(goal_text=goal["goal_text"], reason=pause_reason)
            return

        if terminal:
            _goal_mark_done_checked(s.session_id, reason=result.reason)
            _clear_evidence_gate(gid)  # V4: yield 前 정리
            done_note = "goal 완료"
            state.chat_message_add(
                s.session_id, role="system", content={"text": done_note},
            )
            yield GoalDone(
                goal_text=goal["goal_text"], reason="completed",
            )
            return

        # v3.81 T1a: 무진전 안전 종료. max_turns=0(무제한) goal 의 유일한
        # 긍정 종료가 judge terminal flip 인데, judge 가 변화 없이 continue 만
        # 반복하면 무한루프(비용·정확성 리스크). 연속 N회 무진전 judge 턴이면
        # GoalPaused — 결정론 종료(claim None ∧ 활성 0)는 T1d 어댑터 훅에서.
        limit = _goal_no_progress_limit()
        if limit > 0 and streaks["no_progress_streak"] >= limit:
            pause_reason = (
                f"judge 무진전 {streaks['no_progress_streak']}회 연속 "
                "(flips=0, new_items=0)"
            )
            _goal_pause_checked(s.session_id, reason=pause_reason)
            _clear_evidence_gate(gid)  # V4: yield 前 정리
            state.chat_message_add(
                s.session_id, role="system",
                content={"text": f"goal pause: {pause_reason}"},
            )
            yield GoalPaused(goal_text=goal["goal_text"], reason=pause_reason)
