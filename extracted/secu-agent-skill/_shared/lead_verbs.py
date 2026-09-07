"""리드의 **닫힌 동사 집합** — 좌표를 주고 닫힌 결과를 받는다 (v3.99 §B).

## 왜 동사가 필요한가

사용자 질문(2026-08-21): "리드가 좀 구체적으로 워커한테 명령을 내릴 필요는?
00tool 에 00 넣어서 호출해서 확인 등."

임의 `tool + args` 를 리드가 지정할 수 있게 하면 경계가 무너진다 — `smb_task_python(code=…)`
하나면 본문 읽기 능력을 그대로 얻고, 마스킹은 시크릿·PII 만 지우지 임의 본문은 못 지운다.
안전한 형태는 **좌표만 받고 닫힌 enum 만 돌려주는 동작 동사**다. 그건 리드 프로세스
안에서 결정론적으로 돌고, 리드 LLM 은 반환값만 본다(`target_hit_summary` 와 같은 구조).

## 지금 동사는 하나다 — 근거가 있는 것만 넣는다

`reachable`. 실측(2026-08-22 gate_smb): 리드 피벗 3건 중 **2건이 "host 445 timeout"**
이었고 `repeat_error_halt` 3건도 같은 원인이다. 리드가 세션을 열고 8턴을 태운 **뒤에야**
호스트가 죽은 걸 알았다. 세션 열기 전 1회 확인이면 그 낭비가 사라진다.

## ⚠️ `credential` 은 여기 없다 — 검토원 일이다 (사용자 결정 2026-08-22)

크리덴셜 유효성 검증은 `<d>_credential_login_probe` 로 **4도메인에 이미 있다**. 리드
쪽에 다시 만들면 세 가지가 나빠진다:
  ① 동작이 fetch→parse→probe→persist 라 복사하면 정본이 둘이 된다
  ② 리드 프로세스가 **파일 본문을 fetch** 하게 된다 — codex 인접 프로세스의 표면이 넓어진다
  ③ `SA_CRED_PROBE` 해제가 기본이라 게이트에서 검증조차 안 된다
v3.99 §A 로 답 채널이 고쳐졌으니, 리드는 `ask_inspector` 로 요청하고 구조화된 답을 받는다.

동사를 더할 때 이 세 질문을 먼저 답하라: 정본이 이미 있나 / 리드 프로세스가 본문을
만지나 / 실기동에서 검증되나.
"""
from __future__ import annotations

import os
import socket
import time
from typing import Any

# 닫힌 동사 집합. 여기 없는 이름은 도구가 pydantic 단계에서 거부한다.
ACTIONS: tuple[str, ...] = ("reachable",)

# 닫힌 결과 집합 — 어댑터가 아무 문자열이나 돌려줄 수 없다.
RESULTS: dict[str, tuple[str, ...]] = {
    "reachable": ("alive", "dead", "skipped", "unsupported", "error"),
}

MAX_DETAIL = 200
MAX_REF = 200
TIMEOUT_ENV = "SA_LEAD_VERIFY_TIMEOUT_SEC"
_TIMEOUT_DEFAULT = 3.0


def timeout_sec() -> float:
    try:
        return max(0.2, min(float(os.environ.get(TIMEOUT_ENV, "") or _TIMEOUT_DEFAULT), 15.0))
    except ValueError:
        return _TIMEOUT_DEFAULT


def unsupported(action: str, why: str) -> dict[str, Any]:
    """이 큐가 못 하는 동사 — **빈 구현이 아니라 명시적 미지원**.

    조용히 `{"performed": false}` 만 주면 리드가 "해봤는데 아무 일도 없었다" 로 읽는다.
    """
    return {"performed": False, "result": "unsupported", "detail": why}


def tcp_probe(host: str, port: int) -> dict[str, Any]:
    """TCP connect 1회. **내부망 판정은 호출자 책임이다**(도메인마다 근거가 다르다).

    GET 도 HEAD 도 아니다 — "살아 있나" 에 필요한 최소 동작이고, 애플리케이션 계층을
    건드리지 않아 부작용이 없다.
    """
    t0 = time.monotonic()
    try:
        with socket.create_connection((host, int(port)), timeout=timeout_sec()):
            pass
    except OSError:
        return {"performed": True, "result": "dead", "port": int(port),
                "ms": int((time.monotonic() - t0) * 1000)}
    return {"performed": True, "result": "alive", "port": int(port),
            "ms": int((time.monotonic() - t0) * 1000)}


def url_reachable(url: str) -> dict[str, Any]:
    """웹 타깃 도달성 — 내부 호스트만, TCP connect 1회.

    ⚠️ smb 는 이 함수를 **안 쓴다.** 거기엔 `domains.smb.plugin.agent_types.smb.tcp_alive`
    라는 정본이 이미 있다(스윕이 쓰는 것과 같은 함수). 계약(닫힌 결과)만 같고 구현은
    각자의 정본을 따른다 — 복사본을 만드는 것이 이 저장소가 반복해서 데인 실패다.
    """
    from urllib.parse import urlparse

    from secu_agent.agent.tools import url_safety

    raw = str(url or "").strip()
    if not raw:
        return {"performed": False, "result": "skipped", "detail": "url 없음"}
    parsed = urlparse(raw if "://" in raw else f"https://{raw}")
    host = parsed.hostname
    if not host:
        return {"performed": False, "result": "skipped", "detail": "host 파싱 실패"}
    try:
        internal = url_safety._is_internal_host(raw if "://" in raw else f"https://{raw}")
    except Exception:  # noqa: BLE001
        internal = False
    if not internal:
        # 사외 호스트는 건드리지 않는다 — 이건 점검 범위가 아니고, 리드가 시켰다고
        # 나가면 그 자체가 사고다.
        return {"performed": False, "result": "skipped", "detail": "내부 호스트가 아니다"}
    port = parsed.port or (80 if parsed.scheme == "http" else 443)
    return tcp_probe(host, port)


def build_verify_result(
    *, action: str, target_id: int, ref: str | None, raw: Any,
) -> dict[str, Any]:
    """리드가 받는 봉투. **닫힌 필드 집합** — 어댑터가 무엇을 더 넣어도 안 실린다.

    결과 문자열도 닫혀 있다. 어댑터가 목록 밖 값을 주면 `error` 로 접는다 — 조용히
    통과시키면 리드가 모르는 어휘로 판단하게 된다.
    """
    got = raw if isinstance(raw, dict) else {}
    allowed = RESULTS.get(action, ())
    result = str(got.get("result") or "error")
    detail = str(got.get("detail") or "")
    if result not in allowed:
        detail = f"어댑터가 규격 밖 결과를 줬다: {result!r}"[:MAX_DETAIL]
        result = "error"
    out: dict[str, Any] = {
        "action": action,
        "target_id": int(target_id),
        "performed": bool(got.get("performed")),
        "result": result,
    }
    if ref:
        out["ref"] = str(ref)[:MAX_REF]
    if detail:
        out["detail"] = detail[:MAX_DETAIL]
    for key in ("port", "ms"):
        if got.get(key) is not None:
            try:
                out[key] = int(got[key])
            except (TypeError, ValueError):
                pass
    return out
