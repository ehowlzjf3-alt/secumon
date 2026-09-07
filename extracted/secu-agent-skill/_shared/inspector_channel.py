"""검토원 채널 — 리드가 검토원과 말하는 **유일한 인터페이스** (Phase 4 준비).

## 왜 이 파일이 생겼나

Phase 2/3 의 `delegate_inspect` 는 검토원 결과를 **파일에서 주워왔다**: 스폰 전후로
`evidence_dir.glob("sub-*")` 를 diff 해 새 디렉터리를 찾고, 그 안의
`worker_result.json` / `recommended_status.json` / `inspector_report.json` 을 읽었다.

그건 "한 번 스폰하고 죽는 워커" 에만 성립한다. 세션(장수명 검토원)이 되면:
  · 질문마다 새 디렉터리가 안 생긴다 → diff 할 게 없다
  · `worker_result.json` 은 **세션 종료** 때나 나온다 → 매 답을 못 받는다

그래서 **답을 파일에서 줍는 대신 호출의 반환값으로 받는다.** 파일은 인터페이스가 아니라
한 transport 의 내부 사정으로 내려간다.

## 구조

    InspectorAnswer      ← 리드가 받는 봉투. 이게 곧 나중의 A2A 페이로드다.
    InspectorChannel     ← ask(question) -> InspectorAnswer
      ├ SubprocessOneShotChannel   지금(스폰→파일→봉투). 동작 무변.
      ├ SessionChannel             Phase 4a — 장수명 세션, 반환값 직행
      └ (HttpChannel)              나중 — 파드가 갈릴 때 transport 만 교체

⚠️ 배포 토폴로지(한 파드 / 파드 분리)는 여기서 결정하지 않는다. 인터페이스가 메시지면
어느 쪽으로도 간다 — 그게 이 분리의 요점이다.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

# 검토원 산문이 리드로 들어오는 통로. 워커 계약상 worker summary 는 ≤500 자이고
# (`worker_result.py::_MAX_SUMMARY`), 검토원 보고의 narrative 는 ≤1000 자다.
MAX_SUMMARY = 500


@dataclass(slots=True)
class InspectorAnswer:
    """검토원 한 번의 답. **닫힌 필드 집합** — 여기 없는 것은 리드에게 가지 않는다.

    `agent_result.json` 의 raw payload 덤프(코어 fail-open 보조 채널)가 여기 없는 것은
    의도다 — 본문이 리드로 새는 가장 넓은 통로가 그 덤프였다.
    """

    agent: str
    domain: str
    target_id: int
    source: str                      # worker_result | session | text-fallback
    status: str = "ok"
    summary: str = ""
    findings_count: int = 0
    turns: int = 0
    tokens: dict[str, int] = field(default_factory=dict)
    candidates_seen: int = 0
    candidates_accounted: int = 0
    completion_reason: str | None = None
    report: dict[str, Any] | None = None            # inspector_report 스키마
    # ★ 이 답이 **어디서 왔는가**. v3.99 이전에는 리드가 그걸 몰랐다 — `summary` 가 비어
    #   있어도 "답이 왔다" 와 구분되지 않았다(실측: 질문 22건 중 17건이 빈 답).
    #   "report" 검토원이 이번 답으로 쓴 구조화 보고
    #   "text"   모델 산문
    #   "none"   **아무것도 없다** — 조용히 빈 문자열을 주지 않는다
    answer_source: str = ""
    recommended_status: str | None = None
    recommendation: dict[str, Any] | None = None
    notes: dict[str, str] = field(default_factory=dict)   # silence_warning 등 경고문
    # 세션 경로에서만 채워진다. 리드가 여러 세션을 동시에 굴릴 때 답을 짝지어야 한다.
    session_id: str = ""

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "agent": self.agent, "domain": self.domain,
            "target_id": self.target_id, "source": self.source,
            "status": self.status, "summary": self.summary,
            "findings_count": self.findings_count, "turns": self.turns,
            "tokens": self.tokens,
            "candidates_seen": self.candidates_seen,
            "candidates_accounted": self.candidates_accounted,
            "completion_reason": self.completion_reason,
        }
        if self.answer_source:
            out["answer_source"] = self.answer_source
        if self.report is not None:
            out["report"] = self.report
        if self.recommended_status is not None:
            out["recommended_status"] = self.recommended_status
        if self.recommendation is not None:
            out["recommendation"] = self.recommendation
        if self.session_id:
            out["session_id"] = self.session_id
        out.update(self.notes)
        return out

    def to_json(self) -> str:
        return json.dumps(self.as_dict(), ensure_ascii=False, default=str)


class InspectorChannel(Protocol):
    """리드 → 검토원. 구현이 subprocess 든 세션이든 HTTP 든 리드는 모른다."""

    async def ask(self, question: str, **kwargs: Any) -> InspectorAnswer: ...


# ── 지금의 transport: 스폰 1회, 파일로 결과 회수 ──────────────────────

def answer_from_evidence(
    *, agent: str, domain: str, target_id: int, sub_dir: Path | None,
    fallback_text: str = "", spawn_error: str | None = None,
    call_failed: bool = False,
) -> InspectorAnswer:
    """sub-evidence 디렉터리에서 봉투를 조립한다 — **one-shot transport 전용**.

    권위 있는 소스는 `worker_result.json`(코어가 '유일 판정 채널' 이라 부르는 것)이다.
    못 읽으면 문자열로 물러서되 **그 사실을 봉투에 남긴다**(`source`) — 조용한 저품질
    대체는 금지다.
    """
    from _shared.inspector_report import read_report
    from _shared.queue_ownership import read_recommendation

    ans = InspectorAnswer(
        agent=agent, domain=domain, target_id=target_id, source="worker_result")

    wr = None
    if sub_dir is not None:
        from secu_agent.agent.schema.worker_result import (
            WorkerResult, read_worker_result,
        )
        got = read_worker_result(sub_dir)
        if isinstance(got, WorkerResult):
            wr = got
        else:
            ans.notes["worker_result_invalid"] = f"{got.reason}: {got.detail[:200]}"
        rec = read_recommendation(sub_dir)
        if rec:
            ans.recommended_status = rec.get("recommended_status")
            ans.recommendation = rec
        rep = read_report(sub_dir)
        if rep:
            ans.report = rep
        else:
            ans.notes["report_missing"] = (
                "검토원이 report_inspection 을 부르지 않았다 — 판단 근거가 상태·카운트뿐이다")
    else:
        ans.notes["worker_result_invalid"] = spawn_error or "sub evidence dir 없음"

    if wr is not None:
        ans.status = wr.status
        ans.findings_count = wr.findings_count
        ans.turns = wr.turns_used
        ans.tokens = {"in": wr.tokens_in, "out": wr.tokens_out}
        ans.candidates_seen = wr.candidates_seen
        ans.candidates_accounted = wr.candidates_accounted
        ans.completion_reason = wr.completion_reason
        ans.summary = str(wr.summary or "")[:MAX_SUMMARY]
        _add_silence_notes(ans)
        _set_oneshot_answer_source(ans)
        return ans

    ans.source = "text-fallback"
    # ★ 판정 기준은 "디렉터리가 있었나" 가 아니라 **호출이 실패했나** 다.
    #   스폰은 됐는데(디렉터리 생성) 워커가 결과를 못 쓰고 죽은 경우가 있다 —
    #   그때 status 를 ok 로 두면 리드가 실패를 성공으로 읽는다.
    ans.status = "error_crash" if (call_failed or spawn_error) else "ok"
    ans.summary = strip_raw_payload(fallback_text)[:MAX_SUMMARY]
    _set_oneshot_answer_source(ans)
    return ans


def _set_oneshot_answer_source(ans: InspectorAnswer) -> None:
    """단발/세션종료 경로의 답 출처.

    ⚠️ 세션의 `_classify_answer` 를 재사용하면 안 된다. 여기서 `summary` 는 **코어가
    만드는 템플릿**(`task … : reason=end_turn, submit=True`)이라 항상 비어 있지 않다 —
    그걸 "text 로 답이 왔다" 로 세면 Phase 3 에서 고친 착시가 되돌아온다.
    판단이 실린 자리는 `report` 뿐이고, 없으면 `report_missing` 노트가 그 사실을 말한다.

    그리고 여기엔 `continuable` 을 붙이지 않는다 — 단발도 세션 종료도 **이미 끝났다**.
    """
    if ans.report:
        ans.answer_source = "report"
    elif str(ans.summary or "").strip():
        ans.answer_source = "text"
    else:
        ans.answer_source = "none"


def report_fingerprint(evidence_dir: Path | str) -> str | None:
    """`inspector_report.json` 의 내용 지문. 없으면 None.

    ★ mtime 이 아니라 **내용**이다. 리포트 파일은 덮어쓰기라 mtime 은 초 해상도에서
    같은 값이 나올 수 있고, 반대로 같은 내용을 다시 써도 mtime 은 바뀐다. 리드가 알고
    싶은 것은 "이번 질문에 대해 **새로 판단한 것이 있나**" 이지 파일이 언제 닿았나가 아니다.
    """
    from _shared.inspector_report import REPORT_FILENAME

    try:
        raw = (Path(evidence_dir) / REPORT_FILENAME).read_bytes()
    except OSError:
        return None
    return hashlib.sha256(raw).hexdigest()


def _classify_answer(
    ans: InspectorAnswer, *, text: str, report: dict[str, Any] | None, fresh: bool,
) -> None:
    """답의 출처를 정하고, 없으면 **없다고 말한다.**

    우선순위는 text > 신선한 report 다. 산문이 있으면 그게 이번 질문에 대한 대답이고,
    리포트는 구조화 보고로 함께 실린다(`report` 필드). 산문이 없으면 신선한 리포트의
    narrative 를 답으로 승격한다 — 그게 워커가 실제로 답한 자리이기 때문이다.
    """
    body = str(text or "").strip()
    if body:
        ans.answer_source = "text"
        ans.summary = body[:MAX_SUMMARY]
    elif fresh and report:
        ans.answer_source = "report"
        ans.summary = str(report.get("narrative") or "")[:MAX_SUMMARY]
    else:
        ans.answer_source = "none"
        ans.summary = ""
        ans.notes["no_answer"] = (
            "이번 질문에 대한 답이 없다 — 산문도 없고 새 보고도 없다. "
            "'방금 확인한 것을 report_inspection 으로 남겨줘' 로 다시 물어라.")
    if report is not None and not fresh:
        ans.notes["report_stale"] = (
            "붙어 있는 report 는 **이전 답의 것**이다(이번 질문에 갱신되지 않았다). "
            "이번 질문의 답으로 읽지 마라.")


def _add_continuable_note(ans: InspectorAnswer) -> None:
    """끊긴 답에 "세션은 살아 있다" 를 붙인다.

    ★ `max_turns` 만 다루면 안 된다. 실측(2026-08-22 smb 게이트)에서 9 asks 중 **3건이
    `repeat_error_halt`** 였다 — 도구가 같은 에러로 두 번 실패해 엔진이 런을 멈춘 것이다.
    리드는 그게 "세션이 죽었다" 인지 "이번 시도만 실패" 인지 알 방법이 없었고, 죽은 줄
    알고 타깃을 닫았다. 세션은 살아 있다 — 다만 **같은 방법으로 다시 물으면 또 멈춘다.**
    """
    reason = ans.completion_reason
    if reason == "max_turns":
        ans.notes["continuable"] = (
            "턴 예산에서 끊겼다 — 답이 완결이 아니다. 세션은 살아 있으니 "
            "'계속해' 로 이어가면 컨텍스트 그대로 진행한다.")
    elif reason in {"repeat_error_halt", "repeat_call_halt"}:
        ans.notes["continuable"] = (
            "도구가 같은 실패를 반복해 이번 시도가 멈췄다 — **세션은 살아 있다.** "
            "같은 방법으로 다시 물으면 또 멈춘다. 범위를 좁히거나 다른 경로로 물어라 "
            "(예: 파일 하나만, 또는 목록/메타만).")
    elif reason == "contract_violation":
        ans.notes["continuable"] = (
            "계약 위반으로 이번 시도가 멈췄다 — 세션은 살아 있다. "
            "무엇을 답해야 하는지 명시해서 다시 물어라.")


def _add_silence_warning(ans: InspectorAnswer) -> None:
    """v3.90 침묵 게이트를 리드에게도 보이게 — **이진 신호만.**

    `silence_warning` 은 **코어가 정의한 침묵**(seen>0 & accounted==0)이다 — 여기서 그
    정의를 다시 쓰지 않는다(두 개의 진실 금지). 이진이라 단위 불일치·이중집계에 면역이고,
    그래서 단발·세션 어느 경로에서든 붙일 수 있다.
    """
    seen, acc = ans.candidates_seen, ans.candidates_accounted
    if seen > 0 and acc == 0:
        ans.notes["silence_warning"] = (
            "후보를 봤는데 해명(제출/기각)이 0건이다 — 깨끗하다고 읽지 마라")


def _add_partial_accounting_note(ans: InspectorAnswer) -> None:
    """부분 해명(`accounted < seen`)을 판단 재료로 — ★ **단발 경로 전용**이다.

    쓰는 이유: 2026-08-21 실기동에서 github 검토원이 `seen=6 accounted=1` 로 끝났다.
    코어 기준으로는 침묵이 아니지만 "깨끗함" 으로 읽으면 안 되는 상태다.

    ★ **세션의 매 답에는 붙이지 않는다.** 카운터는 후보 identity 가 없는 cumulative
    정수라(엔진 `candidate_ledger.py:128` 이 정확-대조를 명시적으로 포기한 이유), 한 번
    스폰하고 끝나는 단발에서만 "이 작업의 총계" 로 읽을 수 있다. 세션은 ask 마다 같은
    카운터가 계속 자라고, `seen` 은 ask 끝에서 오르고 `accounted` 는 다음 ask 에서 오르는
    **구조적 지연**이 있다. 그래서 정상적인 세션이 매번 1건 모자란 것처럼 보인다.

    2026-08-26 실측(smb 리드, 세션 s2) — 이 함수가 세션에 붙어 있었을 때:

        ask#1  seen=19 acc=19          정상
        ask#2  seen=20 acc=19   note   → 리드가 "미해명 1건" 을 추궁 (turn 5)
        ask#3  seen=21 acc=20   note   → 또 추궁 (turn 6)
        ask#4  seen=21 acc=34          재스캔 이중집계로 acc 가 seen 을 추월, note 소멸

    미해명 후보 같은 건 없었다. 8턴 중 2턴을 유령 추궁에 썼다. 세션에서 남는 것은
    이진 신호(`silence_warning`)뿐이고, 그건 이 드리프트에 영향받지 않는다.
    """
    seen, acc = ans.candidates_seen, ans.candidates_accounted
    if seen > 0 and acc == 0:
        return                      # 그건 silence_warning 의 자리다
    if acc < seen:
        ans.notes["silence_note"] = (
            f"후보 {seen}건 중 {acc}건만 해명됐다 — 나머지 {seen - acc}건은 판정이 없다. "
            f"'깨끗함' 과 '안 봤음' 을 구분하라.")


def _add_silence_notes(ans: InspectorAnswer) -> None:
    """단발(및 세션 종료) 경로의 침묵 재료 — 이진 경고 + 부분해명 노트."""
    _add_silence_warning(ans)
    _add_partial_accounting_note(ans)


def strip_raw_payload(text: str) -> str:
    """`AgentTool` 문자열에서 raw payload 덤프를 잘라낸다 (text-fallback 전용).

    코어 형식: `[<name> result] (...)\\nsummary: ...\\nraw: {...}`.
    `raw: ` 이후는 통째 버린다 — 마스킹으로 거르는 게 아니라 아예 안 넘긴다.
    형식이 바뀌면 `test_lead_delegate_envelope.py` 가 깨진다(조용한 유출 대신 실패).
    """
    s = str(text or "")
    idx = s.find("\nraw: ")
    return s[:idx] if idx >= 0 else s


def resolve_new_sub_dir(
    evidence_dir: Path, before: set[str], after: set[str],
) -> tuple[Path | None, str | None]:
    """스폰 전후 diff 로 이번 위임의 evidence 디렉터리를 찾는다.

    ⚠️ **one-shot transport 에만 성립한다.** 세션은 질문마다 디렉터리를 안 만든다 —
    그래서 이 함수가 `SessionChannel` 에는 없다(있으면 안 된다).
    """
    new = sorted(after - before)
    if len(new) == 1:
        return evidence_dir / new[0], None
    if len(new) > 1:
        return None, f"sub evidence dir 판별 불가 (신규 {len(new)}개) — 동시 위임?"
    return None, "sub evidence dir 생성 안 됨 (spawn 실패)"


def sub_dirs(evidence_dir: Path) -> set[str]:
    try:
        return {p.name for p in evidence_dir.glob("sub-*") if p.is_dir()}
    except OSError:
        return set()


# ── Phase 4a transport: 장수명 세션 ───────────────────────────────────
#
# 검토원을 `--serve` 로 띄우고 질문/답을 줄 단위 JSON 으로 주고받는다. 답이 **반환값**이라
# 파일시스템을 안 탄다 — 그래서 나중에 파드가 갈려도 transport 만 바뀐다.
#
# ⚠️ 프로세스 경계는 그대로다. 검토원은 여전히 별도 프로세스이고, 리드는 여기서 나오는
#    `InspectorAnswer` 만 본다. 마스킹은 리드 도구 경계에서 한다(여기서 하지 않는다 —
#    두 번 하면 진실이 둘이 된다).

import asyncio
import logging
import os
import sys

log = logging.getLogger("shared.inspector_channel")

SESSION_START_TIMEOUT = 120.0


# ══════════════════════════════════════════════════════════════════════════════
# 부모 생존신호 — 검토원이 일하는 동안 리드가 idle 로 죽지 않게 (2026-08-26)
# ══════════════════════════════════════════════════════════════════════════════
#
# ## 무엇이 있었나
#
# confluence 리드가 **3연속** 같은 자리에서 죽었다(21:12·21:38 등):
#
#     --- turn 8 ---
#     [tool→] ask_inspector(session_id='s1-fcb788', question='이 space 에 접근 …')
#     [tool→] ask_inspector(session_id='s2-9c218a', question='이 space 에 접근 …')
#     [loop error] harness idle timeout: no observable activity for 300.3s
#     [agent] done — reason=aborted turns=8
#
# 검토원은 **멀쩡히 일하고 있었다.** 브라우저 SSO 로그인 + 검색 + 결과 페이지 방문은
# 5분을 쉽게 넘긴다. 죽은 건 리드다.
#
# ## 왜 구조적으로 죽게 돼 있었나
#
#     ask() 타임아웃      1800s   (SA_SESSION_ASK_TIMEOUT_SEC)
#     부모 idle 워치독     300s   (harness budget.max_idle_sec)
#
# **6배 역전.** ask 가 답을 기다리는 동안 부모 하네스에는 아무 이벤트도 안 올라가서,
# 300s 를 넘기는 답은 하나도 받을 수 없었다. 타임아웃 1800s 는 처음부터 도달 불가였다.
#
# ★ 단발 위임(`delegate_inspect`)에는 이미 이 방어가 있다 —
#   `agent_tool._watch_subagent` 가 자식 evidence 를 폴링해 `report_progress` 를 친다.
#   **세션 경로만 그 배선이 없었다.** 함수는 있는데 부르는 곳이 없던 종류다.
#
# ## 규칙: 살아 있을 때만 살아 있다고 말한다
#
# 하트비트가 아니다. 자식 evidence 디렉터리가 **실제로 변할 때만** 진척을 보고한다.
# 검토원이 정말 멎으면 보고가 끊기고 부모 워치독이 제 일을 한다 — 그게 맞는 결과다.
# 무조건 핑을 보내면 죽은 검토원을 붙잡고 리드가 1800s 를 버린다.


def _liveness(evidence_dir: Path) -> tuple[int, int, int] | None:
    """자식 evidence 의 생존 지문. 정의는 **코어와 공유한다** — 두 벌이면 갈라진다."""
    try:
        from secu_agent.agent.tools.agent_tool import _liveness_fingerprint

        return _liveness_fingerprint(Path(evidence_dir))
    except Exception:  # noqa: BLE001 — 관측 실패가 대화를 죽이지 않는다
        return None


def _keepalive_interval() -> float:
    try:
        from secu_agent.agent.tools.agent_tool import _progress_interval_sec

        return max(1.0, float(_progress_interval_sec()))
    except Exception:  # noqa: BLE001
        return 15.0


@asynccontextmanager
async def keep_parent_alive(evidence_dir: Path | str, ctx: Any, *, label: str = ""):
    """블록이 도는 동안 자식이 **진짜 움직일 때만** 부모에게 진척을 보고한다.

    `ctx` 가 `report_progress` 를 안 가지면(테스트 더블 등) 아무것도 안 한다.
    """
    hook = getattr(ctx, "report_progress", None)
    if not callable(hook):
        yield
        return

    sub = Path(evidence_dir)
    interval = _keepalive_interval()

    async def _watch() -> None:
        last = await asyncio.to_thread(_liveness, sub)
        while True:
            await asyncio.sleep(interval)
            now = await asyncio.to_thread(_liveness, sub)
            if now is None or now == last:
                continue        # ★ 변화가 없으면 침묵한다 — 워치독을 속이지 않는다
            last = now
            try:
                hook("inspector_progress")
            except Exception:  # noqa: BLE001
                pass

    task = asyncio.create_task(_watch())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task

SESSION_ASK_TIMEOUT_ENV = "SA_SESSION_ASK_TIMEOUT_SEC"
_ASK_TIMEOUT_DEFAULT = 1800.0


def _ask_timeout() -> float:
    try:
        return max(30.0, float(os.environ.get(SESSION_ASK_TIMEOUT_ENV, "") or
                               _ASK_TIMEOUT_DEFAULT))
    except ValueError:
        return _ASK_TIMEOUT_DEFAULT


class SessionChannel:
    """검토원 세션 하나. `ask()` 가 `InspectorAnswer` 를 **반환**한다.

    수명: 리드가 `close()` 하거나 리드 프로세스가 끝날 때. 고아 프로세스를 남기지 않는
    책임이 여기 있다 — `close()` 는 언제 불러도 안전하고, 실패해도 kill 로 끝낸다.
    """

    def __init__(self, *, agent: str, domain: str, target_id: int,
                 evidence_dir: Path, spec: dict[str, Any],
                 session_id: str = "") -> None:
        self.agent = agent
        self.domain = domain
        self.target_id = target_id
        self.evidence_dir = Path(evidence_dir)
        self.spec = spec
        self.session_id = session_id
        self._proc: asyncio.subprocess.Process | None = None
        self._turn = 0
        self._closed = False
        # ★ 파이프는 **단일 스트림**이다. 같은 세션에 동시 ask 가 오면 요청/응답 짝이
        #   어긋난다(A 의 질문에 B 의 답이 붙는다) — 조용히 틀리는 종류다.
        #   다른 세션끼리는 각자 락이라 진짜 병렬로 돈다. `ask_inspector` 를
        #   `is_concurrency_safe=True` 로 둘 수 있는 근거가 정확히 이 락이다.
        self._lock = asyncio.Lock()
        self.slots: list[dict[str, Any]] = []

    # ── 수명 ──────────────────────────────────────────────────────
    async def start(self) -> None:
        """검토원 프로세스를 띄우고 ready 를 기다린다."""
        import secu_agent

        self.evidence_dir.mkdir(parents=True, exist_ok=True)
        (self.evidence_dir / "task_spec.json").write_text(
            json.dumps(self.spec, ensure_ascii=False, indent=2), encoding="utf-8")

        src = str(Path(secu_agent.__file__).resolve().parents[1])
        existing = os.environ.get("PYTHONPATH", "")
        env = dict(os.environ)
        env["PYTHONPATH"] = src if not existing else src + os.pathsep + existing
        # 코어 `AgentTool` 과 같은 시맨틱 — 재귀 spawn 차단 + 큐 소유권 판정.
        env["SA_AGENT_DEPTH"] = str(int(os.environ.get("SA_AGENT_DEPTH") or 0) + 1)

        engine = Path(os.environ.get("SA_ENGINE_DIR") or Path.home() / "project" / "secu-agent")
        argv = [sys.executable, "-m", "secu_agent.agent", str(self.evidence_dir),
                "--serve", "--profile", str(engine / "config" / "llm_profiles.yaml")]
        self._proc = await asyncio.create_subprocess_exec(
            *argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=open(self.evidence_dir / "stderr.log", "wb"),
            cwd=str(Path(__file__).resolve().parents[1]), env=env,
        )
        hello = await self._read(timeout=SESSION_START_TIMEOUT)
        if not hello or not hello.get("ready"):
            raise RuntimeError(f"검토원 세션 기동 실패: {hello!r} — "
                               f"stderr={self.evidence_dir / 'stderr.log'}")

    async def close(self) -> InspectorAnswer | None:
        """세션 종료. **언제 불러도 안전하다**(중복 호출·이미 죽음 포함)."""
        async with self._lock:
            if self._closed:
                return None
            self._closed = True
        proc = self._proc
        if proc is None:
            return None
        try:
            if proc.returncode is None and proc.stdin is not None:
                proc.stdin.write((json.dumps({"close": True}) + "\n").encode())
                await proc.stdin.drain()
                await self._read(timeout=30.0)
                proc.stdin.close()
            await asyncio.wait_for(proc.wait(), timeout=60.0)
        except Exception:  # noqa: BLE001 — 정상종료 실패는 kill 로 끝낸다
            log.warning("검토원 세션 정상 종료 실패 — kill 한다 (agent=%s)", self.agent)
            with_suppress_kill(proc)
        # 세션 종료 시점에야 worker_result.json 이 나온다 — 최종 판정은 그걸로.
        return answer_from_evidence(
            agent=self.agent, domain=self.domain, target_id=self.target_id,
            sub_dir=self.evidence_dir)

    # ── 대화 ──────────────────────────────────────────────────────
    async def ask(self, question: str, **_: Any) -> InspectorAnswer:
        """질문 하나 → 답 하나. 실패는 **fail-closed**(성공으로 안 읽힌다).

        같은 세션 동시 호출은 락으로 직렬화된다 — 다른 세션은 안 막는다.
        """
        async with self._lock:
            if self._closed or self._proc is None or self._proc.returncode is not None:
                return self._dead_answer("세션이 이미 종료됐다")
            self._turn += 1
            # ★ 질문 **전** 지문. 답이 돌아온 뒤 같으면 리포트가 안 갱신된 것이다 —
            #   그때 붙어 있는 report 는 이전 답의 잔상이지 이번 질문의 답이 아니다.
            before = report_fingerprint(self.evidence_dir)
            try:
                assert self._proc.stdin is not None
                self._proc.stdin.write(
                    (json.dumps({"ask": question}, ensure_ascii=False) + "\n").encode())
                await self._proc.stdin.drain()
                payload = await self._read(timeout=_ask_timeout())
            except Exception as e:  # noqa: BLE001
                return self._dead_answer(f"세션 통신 실패: {e!r}")
        if payload is None:
            return self._dead_answer("검토원이 답 없이 죽었다 (stdout EOF)")
        if not payload.get("ok"):
            return self._dead_answer(str(payload.get("error") or "검토원이 거부했다"))
        return self._answer_from_payload(payload, report_before=before)

    # ── 내부 ──────────────────────────────────────────────────────
    async def _read(self, *, timeout: float) -> dict[str, Any] | None:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            line = await asyncio.wait_for(self._proc.stdout.readline(), timeout=timeout)
        except asyncio.TimeoutError:
            return None
        if not line:
            return None
        try:
            got = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            return None
        return got if isinstance(got, dict) else None

    def _dead_answer(self, why: str) -> InspectorAnswer:
        ans = InspectorAnswer(
            agent=self.agent, domain=self.domain, target_id=self.target_id,
            source="session", status="error_crash", summary=why, turns=0)
        ans.notes["session_error"] = why
        return ans

    def _answer_from_payload(
        self, p: dict[str, Any], *, report_before: str | None = None,
    ) -> InspectorAnswer:
        ans = InspectorAnswer(
            session_id=self.session_id,
            agent=self.agent, domain=self.domain, target_id=self.target_id,
            source="session",
            status="ok",
            findings_count=int(p.get("findings_count") or 0),
            turns=int(p.get("turns_used") or 0),
            tokens={"in": int(p.get("tokens_in") or 0)},
            candidates_seen=int(p.get("candidates_seen") or 0),
            candidates_accounted=int(p.get("candidates_accounted") or 0),
            completion_reason=p.get("reason"),
        )
        # ★ 세션의 매 답에는 **이진 경고만** 붙인다. 부분해명 노트는 단발 전용이다
        #   (`_add_partial_accounting_note` 의 주석에 실측 궤적이 있다).
        _add_silence_warning(ans)
        _add_continuable_note(ans)
        # 검토원이 남긴 구조화 보고. **신선한지**가 핵심이다 — 파일은 덮어쓰기라
        # 갱신 안 돼도 이전 것이 그대로 읽힌다.
        from _shared.inspector_report import read_report

        rep = read_report(self.evidence_dir)
        fresh = report_fingerprint(self.evidence_dir) != report_before
        if rep:
            ans.report = rep
        _classify_answer(ans, text=str(p.get("text") or ""), report=rep, fresh=fresh)
        return ans


def with_suppress_kill(proc: Any) -> None:
    try:
        proc.kill()
    except Exception:  # noqa: BLE001
        pass
