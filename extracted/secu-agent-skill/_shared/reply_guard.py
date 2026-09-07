"""회신 안전장치 — **하지 않은 검증을 했다고 말하지 않는다.** 4도메인 한 벌.

## 무엇을 막는가

`smb_build_reply(reply_kind='not_fixed')` 의 자료 경로는 이렇다:

    reverify_open_rows(thread_id, host)     ← 실제 재검증 결과(mail_reverify_result)
      비어 있으면 ↓
    host_open_share_rows(host)              ← **저장된 지난 스캔 결과**

본문은 어느 쪽이든 "재점검한 결과 …" 라고 쓴다. 그래서 워커가 재검증 도구를 건너뛰면
**옛 스캔 데이터를 방금 확인한 것처럼** 보내게 된다. 담당자가 실제로 조치를 마쳤어도
지난 스캔엔 열려 있으므로 "아직 안 됐다" 고 잘못 답한다.

## ⚠️ 이건 아직 일어난 적 없는 사고다 (2026-08-31 확인)

내가 한 번 "실제로 일어났다" 고 보고했는데 **오진이었다.** `mail_reverify_latest_by_finding`
에 finding_id 를 넘겨서(그 함수는 thread_id 를 받는다) 기록이 없는 줄 알았다. 실측하면
그 스레드엔 재검증 기록이 8건 있었고 회신은 매번 재검증 **뒤에** 나갔다.

그래도 이 게이트를 둔다. 폴백 경로는 실재하고, 워커 프롬프트의 *"조치 완료 주장이면
반드시 재검증"* 은 **부탁일 뿐 강제가 아니다.** 부탁으로 지켜지는 불변식은 언젠가
깨지고, 깨져도 조용하다 — 메일은 여전히 그럴듯하게 나간다.

## 규칙

    상태를 단언하는 회신    재검증 기록이 **필요하다**
      not_fixed / still_exposed / partial / confirmed / remediated / still_open
    상태를 단언하지 않는 회신  그냥 통과
      how_to(방법 안내) · 일반 답변

"신선하다" 는 **담당자 답장 이후에 생긴 기록**을 뜻한다. 지난주 재검증으로 이번 주
주장을 확인해 줄 수는 없다.
"""
from __future__ import annotations

from typing import Any

#: 현재 상태를 단언하는 회신 종류 — 재검증 없이는 만들 수 없다.
STATE_ASSERTING_KINDS = frozenset({
    "not_fixed", "confirmed", "still_exposed", "partial", "remediated", "still_open",
})


def asserts_current_state(reply_kind: str) -> bool:
    """이 회신이 "지금 어떤 상태다" 를 말하는가."""
    return str(reply_kind or "").strip().lower() in STATE_ASSERTING_KINDS


#: 도메인 → 스레드 어댑터 팩토리. 등록은 멱등이라 몇 번 불러도 안전하다.
_ADAPTER_FACTORIES = {
    "smb": ("domains.smb.plugin.thread_adapter", "smb_thread_adapter"),
    "dev_web": ("domains.dev_web.plugin.thread_adapter", "dev_web_thread_adapter"),
    "github": ("domains.services.github.plugin.thread_adapter", "github_thread_adapter"),
    "confluence": ("domains.services.confluence.plugin.thread_adapter",
                   "confluence_thread_adapter"),
}


def _ensure_adapter(domain: str):
    """이 도메인의 스레드 어댑터가 등록돼 있게 한다.

    ★ "누가 먼저 부트스트랩해 줬겠지" 에 기대지 않는다. 이 게이트는 **회신 도구 안**에서
      돌고, 도구 단위 테스트나 부트스트랩이 실패한 런타임에서는 레지스트리가 비어 있다
      (`service/agents/runtime.py` 는 부트스트랩 실패를 warning 으로 넘긴다).
      그때 "확인 불가" 로 거부해 버리면 정당한 회신까지 막힌다.
      같은 실수를 `service_reply_guidance_agent` 에서 이미 한 번 했다(2026-08-31).
    """
    from importlib import import_module

    from _shared.thread_adapter import get_thread_adapter, register_thread_adapter

    found = get_thread_adapter(str(domain))
    if found is not None:
        return found
    spec = _ADAPTER_FACTORIES.get(str(domain))
    if spec is None:
        return None
    try:
        register_thread_adapter(getattr(import_module(spec[0]), spec[1])())
    except Exception:  # noqa: BLE001 — 등록 실패는 "확인 불가" 로 이어진다(거부)
        return None
    return get_thread_adapter(str(domain))


def _created_at(row: dict[str, Any]) -> float | None:
    try:
        return float(row.get("created_at"))
    except (TypeError, ValueError):
        return None


def fresh_recheck_records(
    domain: str,
    thread_id: int,
    *,
    after: float | None = None,
) -> list[dict[str, Any]]:
    """`after` 이후에 생긴 재검증 기록. 어댑터가 없으면 빈 리스트.

    ⚠️ 어댑터 미등록을 "기록 없음" 과 같게 취급하지 않는다 — 호출부가
       `check_state_assertion` 을 통해 사유를 받는다.
    """
    adapter = _ensure_adapter(domain)
    if adapter is None or adapter.recheck_records is None:
        return []
    try:
        rows = adapter.recheck_records(int(thread_id)) or []
    except Exception:  # noqa: BLE001 — 조회 실패가 회신 판정을 뒤집지 않는다
        return []
    if after is None:
        return list(rows)
    out = []
    for r in rows:
        ts = _created_at(r)
        if ts is not None and ts > float(after):
            out.append(r)
    return out


def check_state_assertion(
    domain: str,
    thread_id: int,
    reply_kind: str,
    *,
    after: float | None = None,
    verify_hint: str = "",
) -> str | None:
    """이 회신을 만들어도 되는가. **거부 사유 문자열** 또는 통과면 None.

    호출부는 사유를 그대로 워커에게 돌려주면 된다 — 워커가 무엇을 해야 하는지
    알아야 재시도가 의미 있다.
    """
    if not asserts_current_state(reply_kind):
        return None

    adapter = _ensure_adapter(domain)
    if adapter is None:
        return (
            f"{domain} 스레드 어댑터가 등록되지 않아 재검증 기록을 확인할 수 없다 — "
            "상태를 단언하는 회신을 만들지 않는다 (plugin/bootstrap.register_all 확인)."
        )
    if adapter.recheck_records is None:
        return (
            f"{domain} 은 재검증 기록 조회가 배선되지 않았다 — "
            f"'{reply_kind}' 회신은 '지금 어떤 상태다' 를 단언하므로 만들지 않는다."
        )
    rows = fresh_recheck_records(domain, thread_id, after=after)
    if rows:
        return None
    hint = verify_hint or "재검증 도구를 먼저 실행하라"
    when = "담당자 답장 이후" if after is not None else "이 스레드"
    return (
        f"'{reply_kind}' 회신은 재점검 결과를 단언한다. 그런데 {when}에 생긴 재검증 "
        f"기록이 없다 — 하지 않은 검증을 했다고 쓸 수 없다. {hint}. "
        "확인이 어려우면 상태를 단언하지 말고 방법 안내나 일반 답변으로 회신하라."
    )


# ── 담당자 아님 — 조치를 요구하지 않는다 ─────────────────────────────────────

#: "나는 담당자가 아니다" 신호. 담당자가 그렇게 말했으면 **조치를 요구하면 안 된다** —
#: 사람이 담당자를 다시 정해야 하는 자리다(HITL).
#:
#: ⚠️ 프롬프트에 이미 규칙이 있었다("담당자가 아니라고 하면 기록만 하고 멈춘다").
#:    2026-09-01 에 그게 안 지켜졌다 — 워커가 `how_to 질문` 으로 분류하고 답장했고,
#:    "난생 처음 보는 주소" 라고 한 사람에게 "입사 전 폴더라 하더라도 삭제해 주시기
#:    바랍니다" 가 나갔다. 부탁으로 지켜지는 불변식은 언젠가 깨진다.
_NOT_OWNER_PHRASES = (
    "담당자가 아니", "담당이 아니", "제 담당", "저희 담당이 아니",
    "처음 보는", "처음보는", "본 적이 없", "본적이 없", "알지 못하는",
    "입사 전", "입사전", "저희 부서가 아니", "우리 부서가 아니",
    "이관", "인수인계", "퇴사", "전배", "다른 팀", "타 팀",
)

#: 조치를 **요구하는** 회신. 담당자가 아니라는 사람에게 이걸 보내면 안 된다.
_DEMANDING_KINDS = frozenset({"not_fixed", "how_to", "still_exposed", "still_open", "partial"})


def looks_like_not_owner(text: str) -> bool:
    """답장이 "나는 담당자가 아니다" 로 읽히는가."""
    body = str(text or "")
    # 인용된 원문(우리가 보낸 메일)은 빼고 본다 — 거기 우리 문장이 걸리면 오탐이다.
    for sep in ("--------- Original Message", "-----Original Message", "----- Original Message"):
        if sep in body:
            body = body.split(sep, 1)[0]
    return any(p in body for p in _NOT_OWNER_PHRASES)


def check_owner_dispute(reply_kind: str, inbound_text: str) -> str | None:
    """담당자가 아니라는 답장에 조치를 요구하려 하면 거절 사유를 돌려준다.

    ⚠️ 막는 쪽이 안전하다. 오탐이면 사람이 HITL 에서 보고 풀면 되지만, 놓치면 **엉뚱한
       사람에게 조치를 요구하는 메일**이 나간다(회수할 수 없다).
    """
    if str(reply_kind or "") not in _DEMANDING_KINDS:
        return None
    if not looks_like_not_owner(inbound_text):
        return None
    return (
        "담당자가 아니라는 답장이다 — 조치를 요구하는 회신을 만들 수 없다. "
        "`smb_record_reply_decision(decision='not_owner')` 로 기록하고 멈춰라. "
        "런타임이 담당자 재지정 검토(HITL)로 옮긴다."
    )
