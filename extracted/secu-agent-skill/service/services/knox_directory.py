"""사내 임직원 대장 조회 — Knox ID → 이름·부서·직급.

담당자를 화면과 메일에 **사람 이름**으로 띄우기 위한 유일한 경로다. 그전까지는 메일 주소만
있었고(`github_report_thread.owner_recipient`), 화면에 `jd2016.lee@samsung.com` 만 떴다.

## 왜 Splunk 자산 대장이 아니라 knox 인가 (실측 2026-08-23)

github 커밋 작성자 176계정으로 두 경로를 나란히 재봤다:

| 경로 | 매칭 | 이름 | 부서 | 직급 |
|---|---|---|---|---|
| **knox MCP** | **154 (88%)** | 154 | **154** | 154 |
| Splunk `LOOKUP_CONTEXT_ASSET_LIST_V2` (USER_ID 축) | 145 (82%) | 145 | 131 | ✗ |

합집합은 155 — Splunk 를 폴백으로 붙여도 **1건**만 더 건진다. 붙일 값이 없어 knox 단독으로 간다.
knox 가 SPL 도 필요 없고, 자산 스냅샷의 "전일 기준" 함정도 없고, `USER_DEPT` vs `USER_DEPT_NAME`
같은 필드명 함정도 없다.

## ⚠️ 인자는 Knox ID 다 — 메일 주소를 주면 못 찾는다

    knox_get_employee_info("bi95.park")             → success
    knox_get_employee_info("bi95.park@samsung.com") → "임직원을 찾을 수 없습니다"

## ⚠️ GitHub 로그인은 Knox ID 가 아니다

GitHub 로그인에는 `.` 을 쓸 수 없어 `-` 로 치환돼 있다(`donghun.yi` → `donghun-yi`).
되돌려야 조회된다. 다만 `-` 가 원래 이름의 일부인 계정도 있어서(`a-rom-lee`) 후보를
여러 개 만들어 순서대로 시도한다. `sungduk-cho` 처럼 조직명이 사람 이름 모양인 경우도
있으므로 **"못 찾음" 은 정상 결과다**(조직 계정이라는 뜻).
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from service.services import mcp_gateway

_SERVER = "knox"
_TOOL = "knox-knox_get_employee_info"
_MAIL_DOMAIN = "@samsung.com"

#: 프로세스 수명 캐시. 한 번 돌 때 같은 사람을 수십 번 묻는다(저장소마다 같은 담당자).
_cache: dict[str, "Employee | None"] = {}


@dataclass(frozen=True, slots=True)
class Employee:
    knox_id: str
    full_name: str | None = None
    department: str | None = None
    en_department: str | None = None
    title: str | None = None
    employee_number: str | None = None

    @property
    def email(self) -> str:
        """사내 메일. knox 응답엔 메일이 없고 Knox ID 가 곧 local part 다."""
        return f"{self.knox_id}{_MAIL_DOMAIN}"


def knox_id_from_email(value: str) -> str:
    """`a.b@samsung.com` → `a.b`. 이미 Knox ID 면 그대로."""
    return str(value or "").strip().lower().split("@", 1)[0]


def knox_id_candidates(login: str) -> list[str]:
    """GitHub 로그인 → 시도할 Knox ID 후보(순서 있음).

    `.` 이 `-` 로 바뀌어 있으므로 되돌린다. 어느 `-` 가 원래 `.` 이었는지는 알 수 없어
    **뒤에서부터**(성이 마지막이라 `이름-성` 이 흔하다) 그리고 **앞에서부터** 둘 다 만든다.
    원문도 후보에 남긴다 — `rupin` 처럼 `-` 가 없는 계정이 그대로 Knox ID 인 경우가 있다.
    """
    raw = str(login or "").strip().lower()
    if not raw:
        return []
    out = [raw]
    if "-" in raw:
        cut = raw.rfind("-")
        out.append(raw[:cut] + "." + raw[cut + 1:])
        out.append(raw.replace("-", ".", 1))
        # 하이픈이 둘 이상이면 **마지막만 `.` 이고 나머지는 원래 없던 문자**인 경우가 있다.
        # Knox ID 는 `bc123.kim`·`mk8.kim` 처럼 앞부분에 하이픈이 없다.
        # 실측 2026-08-29(Knox 라이브): `js-53-lee` → `js53.lee` 가 맞고, 이건 위 두
        # 후보(`js-53.lee`·`js.53-lee`) 어디에도 없어서 담당자 미상으로 떨어지고 있었다.
        if raw.count("-") >= 2:
            out.append(raw[:cut].replace("-", "") + "." + raw[cut + 1:])
    seen: set[str] = set()
    return [x for x in out if not (x in seen or seen.add(x))]


def _employee(knox_id: str, payload: Any) -> Employee | None:
    if not isinstance(payload, dict) or not payload.get("success"):
        return None
    def s(key: str) -> str | None:
        v = payload.get(key)
        v = str(v).strip() if v is not None else ""
        return v or None
    return Employee(
        knox_id=str(payload.get("knox_id") or knox_id).strip().lower(),
        full_name=s("full_name"),
        department=s("department"),
        en_department=s("en_department"),
        title=s("title"),
        employee_number=s("employee_number"),
    )


def lookup_many(knox_ids: list[str]) -> dict[str, Employee]:
    """Knox ID 여러 개를 한 세션에서 조회. 못 찾은 것은 키가 없다(예외 아님).

    ⚠️ 게이트웨이 자체가 죽으면 `McpGatewayError` 가 올라간다 — **빈 dict 로 삼키지 않는다.**
    "아무도 못 찾았다" 와 "물어보지도 못했다" 를 호출부가 구분해야 한다.
    """
    wanted = [i for i in dict.fromkeys(str(x or "").strip().lower() for x in knox_ids) if i]
    todo = [i for i in wanted if i not in _cache]
    if todo:
        results = asyncio.run(
            mcp_gateway.call_tools(_SERVER, [(_TOOL, {"target_user": i}) for i in todo])
        )
        for knox_id, payload in zip(todo, results, strict=True):
            _cache[knox_id] = (
                None if isinstance(payload, Exception) else _employee(knox_id, payload)
            )
    out: dict[str, Employee] = {}
    for knox_id in wanted:
        emp = _cache.get(knox_id)
        if emp is not None:
            out[knox_id] = emp
    return out


def lookup(knox_id: str) -> Employee | None:
    return lookup_many([knox_id]).get(str(knox_id or "").strip().lower())


def resolve_login(login: str) -> Employee | None:
    """GitHub 로그인 → 임직원. 후보를 순서대로 시도하고 처음 맞는 것을 쓴다."""
    cands = knox_id_candidates(login)
    if not cands:
        return None
    found = lookup_many(cands)
    for c in cands:
        if c in found:
            return found[c]
    return None


def clear_cache() -> None:
    _cache.clear()
