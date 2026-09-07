"""리드 프로세스 안의 열린 검토원 세션 장부 (Phase 4c).

## 왜 모듈 레벨인가

계약 후처리 훅은 `on_no_submit(evidence_dir, spec, reason)` 로 **ToolContext 를 못 받는다.**
세션을 `ctx.metadata` 에만 두면 리드가 끝날 때 닫을 방법이 없다 — 검토원 프로세스와
(도메인에 따라) 브라우저가 남는다. 그래서 `evidence_dir` 를 키로 잡아 훅이 찾아 닫는다.

리드 프로세스 하나당 하나의 장부다. 프로세스가 곧 경계라 전역이어도 섞이지 않는다.

## 병렬

세션끼리는 독립이라 동시에 여러 개가 산다. 상한은 **자원** 기준이다:

    SA_LEAD_MAX_SESSIONS   살아있는 검토원 프로세스 수 (기본 4)

기본 4 는 dev_web 러너가 이미 `DEV_WEB_TASK_PARALLEL=3` 으로 도는 것과 같은 눈금이다.

⚠️ 상한에 걸리면 **거부하고 이유를 말한다.** 조용히 오래된 세션을 죽이지 않는다 —
리드가 무엇을 잃는지 알아야 한다(그리고 그 세션의 진행 중 작업도 잃는다).
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from pathlib import Path
from typing import Any

log = logging.getLogger("shared.session_registry")

MAX_SESSIONS_ENV = "SA_LEAD_MAX_SESSIONS"
_MAX_SESSIONS_DEFAULT = 4

# session_id → (evidence_dir, SessionChannel)
_SESSIONS: dict[str, tuple[str, Any]] = {}


class SessionLimitReached(RuntimeError):
    """상한 초과 — 리드에게 그대로 보고된다."""


def max_sessions() -> int:
    try:
        return max(1, int(os.environ.get(MAX_SESSIONS_ENV, "") or _MAX_SESSIONS_DEFAULT))
    except ValueError:
        return _MAX_SESSIONS_DEFAULT


def live_count(evidence_dir: Path | str | None = None) -> int:
    if evidence_dir is None:
        return len(_SESSIONS)
    key = str(evidence_dir)
    return sum(1 for d, _ in _SESSIONS.values() if d == key)


def live_sessions(evidence_dir: Path | str) -> list[dict[str, Any]]:
    """리드가 "지금 뭐가 열려 있나" 를 볼 수 있게 — 값 없는 요약."""
    key = str(evidence_dir)
    return [
        {"session_id": sid, "agent": ch.agent, "target_id": ch.target_id,
         "domain": ch.domain}
        for sid, (d, ch) in _SESSIONS.items() if d == key
    ]


async def open_session(
    *, evidence_dir: Path, agent: str, domain: str, target_id: int,
    spec: dict[str, Any],
) -> Any:
    """검토원 세션을 띄우고 장부에 올린다. 상한 초과면 `SessionLimitReached`."""
    from _shared.inspector_channel import SessionChannel

    cap = max_sessions()
    if live_count(evidence_dir) >= cap:
        raise SessionLimitReached(
            f"열린 세션이 상한 {cap}개다 ({MAX_SESSIONS_ENV}). "
            f"다 본 세션을 close_inspection 으로 닫고 다시 열어라 — "
            f"오래된 세션을 임의로 죽이지 않는다(진행 중 작업을 잃는다). "
            f"현재: {live_sessions(evidence_dir)}"
        )
    session_id = f"s{len(_SESSIONS) + 1}-{uuid.uuid4().hex[:6]}"
    sub_dir = Path(evidence_dir) / f"session-{session_id}-{domain}"
    ch = SessionChannel(
        agent=agent, domain=domain, target_id=target_id,
        evidence_dir=sub_dir, spec=spec, session_id=session_id,
    )
    await ch.start()
    _SESSIONS[session_id] = (str(evidence_dir), ch)
    log.info("[session] 열림 %s (%s/target=%s) — 현재 %d/%d",
             session_id, domain, target_id, live_count(evidence_dir), cap)
    return ch


def get_session(session_id: str) -> Any | None:
    got = _SESSIONS.get(str(session_id))
    return got[1] if got else None


async def close_session(session_id: str) -> Any | None:
    got = _SESSIONS.pop(str(session_id), None)
    if got is None:
        return None
    _, ch = got
    return await ch.close()


async def close_all(evidence_dir: Path | str) -> int:
    """리드가 끝날 때 남은 세션을 전부 닫는다 — 검토원/브라우저 누수 1차 방어.

    2차 방어는 코어 serve 루프의 stdin EOF 다(부모가 사라지면 워커도 끝난다).
    둘 다 있어야 한다 — 여기는 정상 종료, EOF 는 비정상 종료를 덮는다.
    """
    key = str(evidence_dir)
    ids = [sid for sid, (d, _) in _SESSIONS.items() if d == key]
    closed = 0
    for sid in ids:
        try:
            await close_session(sid)
            closed += 1
        except Exception:  # noqa: BLE001 — 하나가 실패해도 나머지는 닫는다
            log.exception("[session] 종료 실패 %s", sid)
    if closed:
        log.info("[session] 리드 종료 — 세션 %d개 정리", closed)
    return closed


def _reset_for_test() -> None:
    _SESSIONS.clear()
