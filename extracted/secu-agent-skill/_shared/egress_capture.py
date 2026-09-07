"""egress 실측 — 리드가 **실제로 내보낸 것**을 그대로 적는다 (Phase 3d).

## 왜 필요한가

Phase 2 는 evidence/audit 로그 기준으로 "리드가 본 바이트에 시크릿 0건" 을 셌다.
그건 **도구 반환**만 본 것이다. 리드 프로세스가 모델에 보내는 요청에는 그 밖에도
system prompt·전체 대화 히스토리·도구 스키마·리드 자신이 쓴 텍스트가 들어간다.
Phase 3 에서 그 수신처가 `chatgpt.com` 이 되므로, 세는 대상은 **요청 본문**이어야 한다.

프롬프트를 신뢰하지 않는다. 바이트로 확인한다.

## 캡처 지점과 그 한계 (정직하게)

`LLMClient.stream(request)` 를 감싸 `LLMRequest` 를 직렬화한다. 이건 에이전트 층이
transport 에 건네는 **내용 전부**다 — system, 모든 메시지, 도구 스키마.

transport(`CodexResponsesClient._build_kwargs`)는 이걸 벤더 JSON 으로 **재배치**하고
인증 헤더를 붙이지만 의미 있는 내용을 새로 만들지 않는다. 그 주장은 손으로 확인할 수
있게 `docs/probes/egress_diff.py` 가 같은 요청의 transport kwargs 를 떠서 대조한다
(캡처에 없는 문자열이 kwargs 에 있으면 실패).

## 캡처 파일은 원문이다

마스킹하지 않는다 — 마스킹된 것을 세면 아무것도 못 잡는다. 이 파일은 **로컬 증거**이고
나가지 않는다. 기본 경로는 evidence_dir 밑이다.
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any, AsyncIterator

log = logging.getLogger("shared.egress_capture")

CAPTURE_ENV = "SA_EGRESS_CAPTURE"
CAPTURE_FILENAME = "egress.jsonl"


def capture_path() -> Path | None:
    """`SA_EGRESS_CAPTURE=<dir 또는 file>`. 미설정이면 **증거 디렉터리**로 떨어진다.

    2026-08-22 이전엔 미설정 = 캡처 없음이었다. 그래서 경계의 유일한 실측인
    `docs/probes/egress_audit.py` 가 **손으로 env 를 켠 런에서만** 볼 게 있었고,
    평소 런은 검사 대상이 아예 남지 않았다. 리드가 사외로 나가는 구조에서 그건
    "경계를 지킨다" 를 증거 없이 말하는 것이다 → 기본을 켜는 쪽으로 바꾼다.

    비용은 실측했다: 게이트 런 5개에서 **88KB~428KB**. 리드 메시지는 좌표뿐이라
    작다(검토원은 이 래퍼를 안 탄다 — 본문이 디스크에 복사되지 않는다).

    `SA_EVIDENCE_DIR` 는 코어가 워커 기동 때 setdefault 한다(cli.py:EVIDENCE_DIR_ENV).
    둘 다 없으면 예전처럼 캡처하지 않는다.
    """
    raw = (os.environ.get(CAPTURE_ENV) or "").strip()
    if not raw:
        raw = (os.environ.get("SA_EVIDENCE_DIR") or "").strip()
        if raw:
            p = Path(raw).expanduser()
            if p.is_dir():
                return p / CAPTURE_FILENAME
        return None
    p = Path(raw).expanduser()
    if p.is_dir() or raw.endswith("/"):
        p.mkdir(parents=True, exist_ok=True)
        return p / CAPTURE_FILENAME
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _plain(obj: Any) -> Any:
    """LLMRequest 트리를 JSON 으로. **내용을 줄이지 않는다** — 세는 게 목적이다."""
    if is_dataclass(obj) and not isinstance(obj, type):
        try:
            return {k: _plain(v) for k, v in asdict(obj).items()}
        except Exception:  # noqa: BLE001 — slots/비직렬화 필드
            return {k: _plain(getattr(obj, k, None))
                    for k in getattr(obj, "__slots__", ()) or ()}
    if isinstance(obj, dict):
        return {str(k): _plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_plain(v) for v in obj]
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    return str(obj)


class EgressCaptureClient:
    """client 를 감싸 요청을 적는다. 응답 스트림은 그대로 흘려보낸다."""

    def __init__(self, inner: Any, path: Path, *, role: str, task_type: str) -> None:
        self._inner = inner
        self._path = path
        self._role = role
        self._task_type = task_type
        self._seq = 0

    # 래핑 투명성 — provenance/폴백 코드가 보는 속성을 그대로 위임한다.
    def __getattr__(self, item: str) -> Any:
        return getattr(self._inner, item)

    @property
    def name(self) -> str:
        return getattr(self._inner, "name", "?")

    def _record(self, request: Any) -> None:
        self._seq += 1
        entry = {
            "seq": self._seq,
            "ts": time.time(),
            "role": self._role,
            "task_type": self._task_type,
            "profile": getattr(self._inner, "name", None),
            "request": _plain(request),
        }
        try:
            with self._path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
        except OSError:
            # 캡처 실패가 헌트를 막지 않는다 — 다만 조용하지 않게 남긴다.
            log.exception("egress 캡처 기록 실패: %s", self._path)

    def stream(self, request: Any) -> AsyncIterator[Any]:
        """요청을 적고, 스트림이 끝나면 **누가 응답했는지**를 이어서 적는다.

        ★ 왜 서빙 프로파일까지 적나: 캡처의 `profile` 은 래퍼 이름
        (`fallback(retry(codex) -> retry(gemma))`)이라 **어느 arm 이 답했는지 말하지
        않는다.** 2026-08-22 에 "리드가 정말 codex 로 돌았나" 를 확인하려다 이 자료로는
        판정이 안 된다는 걸 알았다 — 요청 본문의 `reasoning_effort` 도 arm 선택 전
        값이라 근거가 못 된다. 폴백이 조용히 뛰면 판단의 출처가 사라진다.

        서빙 기록은 응답이 시작돼야 생기므로 **스트림 소진 뒤**에 별도 줄로 적는다.
        """
        self._record(request)
        seq = self._seq
        return self._stream_and_note(request, seq)

    async def _stream_and_note(self, request: Any, seq: int) -> AsyncIterator[Any]:
        try:
            async for ev in self._inner.stream(request):
                yield ev
        finally:
            # 예외로 끊겨도 적는다 — 실패한 arm 도 기록 가치가 있다.
            self._note_served(seq)

    def _note_served(self, seq: int) -> None:
        try:
            from service.agents.llm_provenance import process_served_llm

            served = process_served_llm()
        except Exception:  # noqa: BLE001 — 기록 실패가 헌트를 막지 않는다
            return
        if not served:
            return
        try:
            with self._path.open("a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "seq": seq, "ts": time.time(), "role": self._role,
                    "task_type": self._task_type, "served": served,
                }, ensure_ascii=False, default=str) + "\n")
        except OSError:
            log.exception("egress 서빙기록 실패: %s", self._path)


def wrap_egress_capture(client: Any, *, role: str, task_type: str) -> Any:
    """`SA_EGRESS_CAPTURE` 가 있을 때만 감싼다. 없으면 원본 그대로(무래핑)."""
    path = capture_path()
    if path is None:
        return client
    log.warning("[egress] %s(%s) 요청을 %s 에 기록한다 — 원문이다(로컬 증거).",
                role, task_type, path)
    return EgressCaptureClient(client, path, role=role, task_type=task_type)
