"""담당자 지정 — 4도메인 한 벌.

## 왜 필요한가 (2026-09-01 실측)

스레드 37 은 `jaehun82.sim`(심재훈)에게 보냈는데 `donghee4.kim`(김동희)이 답했다.
담당자가 바뀐 것이 분명한데 —

    상태 어휘   `owner_reassignment_review` · `reassigned`   있다
    콘솔        "대기" 그룹으로 보인다                        있다
    담당자 교체 코드                                          ★ **없었다**

상태만 있고 그 상태에서 나가는 길이 없었다. 사람이 보고도 할 수 있는 게 없다.

## 무엇을 쓰나

    스레드      recipient · owner_recipient   → 다음 메일이 그리로 간다
    smb         asset_owner(그 IP)            → 다음 주차 스레드가 이걸 읽는다
    github      github_repo_owner(그 저장소)   → 같은 이유

⚠️ **이미 나간 메일의 수신처는 고치지 않는다.** 그건 일어난 일이다.
⚠️ Knox 에 없는 ID 는 거부한다 — 파트너·외부 주소를 담당자로 적으면 조치요청이 사외로
   나간다. 발송 게이트가 막겠지만 애초에 적지 않는다.
"""
from __future__ import annotations

import time
from typing import Any


class OwnerAssignError(RuntimeError):
    """지정하지 못한 이유 — 화면까지 그대로 올라간다."""


#: 도메인별 스레드 조회. 발송 CLI 의 `_THREAD_GET` 과 같은 어휘를 쓴다.
_THREAD_GET = {
    "smb": "mail_thread_get",
    "github": "github_report_thread_get",
    "confluence": "confluence_report_thread_get",
    "dev_web": "dev_web_report_thread_get",
}
_THREAD_SET = {
    "smb": "mail_thread_set_status",
    "github": "github_report_thread_set_status",
    "confluence": "confluence_report_thread_set_status",
    "dev_web": "dev_web_report_thread_set_status",
}


def resolve_employee(knox_id: str) -> Any:
    """Knox ID → 임직원. 없으면 `OwnerAssignError`.

    ⚠️ 메일 주소를 넣어도 받는다(`donghee4.kim@samsung.com` → `donghee4.kim`) —
       사람이 콘솔에서 주소를 그대로 붙여넣는 것이 자연스럽다.
    """
    from service.services import knox_directory as kd

    raw = str(knox_id or "").strip()
    if not raw:
        raise OwnerAssignError("Knox ID 가 비어 있습니다.")
    candidate = kd.knox_id_from_email(raw) if "@" in raw else raw
    try:
        emp = kd.lookup(candidate)
    except Exception as e:  # noqa: BLE001 — 조회 실패와 "없음" 을 구분해 말한다
        raise OwnerAssignError(f"Knox 조회에 실패했습니다: {e!r}") from e
    if emp is None:
        raise OwnerAssignError(
            f"Knox 에서 '{candidate}' 를 찾을 수 없습니다 — 사내 계정이 맞는지 확인해 주세요.")
    return emp


def _korean_name_from_replies(domain: str, thread_id: int, email: str) -> str | None:
    """그 사람이 보낸 답장 헤더에서 한글 표시 이름을 찾는다.

    ⚠️ Knox 는 영문 이름만 준다. 메일 헤더의 표시 이름은 **본인이 쓴 이름**이라 한글이다.
       못 찾으면 None — 지어내지 않는다(영문 이름을 그대로 쓴다).
    """
    from email.utils import getaddresses

    from service import state_domain as state

    table = "mail_message" if domain == "smb" else "service_reply_message"
    want = str(email or "").strip().lower()
    if not want:
        return None
    try:
        with state.connect() as c:
            rows = [dict(r) for r in c.execute(
                f"SELECT mail_from FROM {table} "
                "WHERE thread_id=? AND direction='in' ORDER BY id DESC LIMIT 20",
                (int(thread_id),),
            )]
    except Exception:  # noqa: BLE001 — 이름은 부가물이다. 실패가 지정을 막지 않는다
        return None
    for row in rows:
        for name, addr in getaddresses([str(row.get("mail_from") or "")]):
            if addr.strip().lower() != want:
                continue
            display = str(name or "").strip().strip('"')
            # 한글이 들어 있을 때만 쓴다 — 영문 표시명은 Knox 값과 다를 이유가 없다.
            if display and any("가" <= ch <= "힣" for ch in display):
                return display
    return None

def assign_owner(
    *, domain: str, thread_id: int, knox_id: str, requested_by: str = "",
) -> dict[str, Any]:
    """티켓의 담당자를 바꾼다. 반환값은 화면이 그대로 보여준다."""
    from service import state_domain as state

    dom = str(domain or "").lower()
    getter = _THREAD_GET.get(dom)
    setter = _THREAD_SET.get(dom)
    if getter is None or setter is None:
        raise OwnerAssignError(f"모르는 도메인: {domain}")

    thread = getattr(state, getter)(int(thread_id))
    if not thread:
        raise OwnerAssignError(f"{dom} 스레드 {thread_id} 를 찾을 수 없습니다.")

    emp = resolve_employee(knox_id)
    email = str(getattr(emp, "email", "") or "").strip()
    if not email:
        raise OwnerAssignError("임직원 메일 주소를 확인할 수 없습니다.")

    previous = str(thread.get("recipient") or "") or None
    korean = _korean_name_from_replies(dom, int(thread_id), email)

    # ★ 표시 이름은 **한글을 우선**한다. Knox 는 영문만 준다(`full_name: "Donghee Kim"`,
    #   2026-09-01 확인 — 응답에 한글 이름 필드가 없다). 그런데 그 사람이 우리에게 답장을
    #   보냈다면 메일 헤더에 본인이 쓴 한글 이름이 있다(`김동희 <donghee4.kim@…>`).
    #   기존 담당자가 한글로 보이던 것은 Splunk 자산목록에서 온 값이라, Knox 로만 채우면
    #   같은 화면에서 어떤 사람은 한글·어떤 사람은 영문이 된다.
    display_name = korean or getattr(emp, "full_name", None)

    # ① 임직원 대장에 남긴다 — 게이트웨이는 Knox 를 못 부르므로 여기 없으면 화면에 이름이 안 뜬다.
    state.employee_directory_upsert(
        emp.knox_id, full_name=display_name,
        department=getattr(emp, "department", None),
        en_department=getattr(emp, "en_department", None),
        title=getattr(emp, "title", None),
        employee_number=getattr(emp, "employee_number", None),
    )

    # ② 스레드 — 다음 메일이 그리로 간다. 상태는 그대로 둔다(담당자 지정이 큐 자리를 옮기지 않는다).
    #   ⚠️ smb 의 `mail_thread` 에는 `owner_recipient` 열이 **없다**. 도메인마다 스레드
    #      스키마가 다르다 — 있는 열만 쓴다(없는 열을 쓰면 SQL 이 죽고 지정이 통째로 실패한다).
    fields: dict[str, Any] = {"recipient": email}
    if "owner_recipient" in thread:
        fields["owner_recipient"] = email
    getattr(state, setter)(
        int(thread_id), str(thread.get("status") or "reported"),
        last_reason=f"담당자 지정: {previous or '(없음)'} → {email}",
        **fields,
    )

    # ③ 도메인별 담당자 기록 — 다음 주차 스레드가 이걸 읽는다.
    scope: dict[str, Any] = {}
    if dom == "smb" and thread.get("host"):
        state.asset_owner_upsert(
            str(thread["host"]),
            user_id=emp.knox_id, user_name=display_name,
            user_dept=getattr(emp, "department", None), email=email,
            source="console:manual",
        )
        scope = {"kind": "host", "value": str(thread["host"])}
    elif dom == "github" and thread.get("repo"):
        state.github_repo_owner_upsert(
            str(thread["repo"]), knox_id=emp.knox_id, login=None, source="repo_login",
        )
        scope = {"kind": "repo", "value": str(thread["repo"])}

    return {
        "domain": dom,
        "threadId": int(thread_id),
        "previous": previous,
        "owner": {
            "knoxId": emp.knox_id,
            "email": email,
            "name": display_name,
            "nameEn": getattr(emp, "full_name", None),
            "dept": getattr(emp, "department", None),
        },
        "scope": scope,
        "requestedBy": requested_by or None,
        "at": time.time(),
    }
