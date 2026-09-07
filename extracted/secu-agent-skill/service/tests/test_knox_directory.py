"""knox 임직원 대장 조회 계약.

라이브 게이트웨이를 부르지 않는다 — `mcp_gateway.call_tools` 를 대체해 응답 형태만 고정한다.
실제 응답 모양은 2026-08-23 라이브에서 뜬 것 그대로다.
"""
from __future__ import annotations

import pytest

from service.services import knox_directory as kd


@pytest.fixture(autouse=True)
def _clear():
    kd.clear_cache()
    yield
    kd.clear_cache()


def _stub(monkeypatch, table: dict[str, dict]):
    """target_user 로 조회되는 가짜 게이트웨이. 없는 계정은 knox 실제 응답과 같은 실패형."""
    seen: list[str] = []

    async def call_tools(server, calls, *, concurrency=6):
        assert server == "knox"
        out = []
        for tool, args in calls:
            assert tool == "knox-knox_get_employee_info"
            uid = args["target_user"]
            seen.append(uid)
            out.append(table.get(uid) or {
                "success": False, "error": f"임직원 '{uid}'를 찾을 수 없습니다.",
            })
        return out

    monkeypatch.setattr(kd.mcp_gateway, "call_tools", call_tools)
    return seen


_PARK = {
    "success": True, "knox_id": "bi95.park", "full_name": "Byung-In Park",
    "employee_number": "04035090", "title_code": "CL4E", "title": "Principal Engineer",
    "department": "DC Infra그룹(AX/PI센터)", "en_department": "DC Infra Group(AX/PI Center)",
}


def test_knox_id_후보는_github_로그인의_하이픈을_점으로_되돌린다():
    # `.` 을 못 쓰는 GitHub 로그인 → Knox ID. 어느 하이픈이 점이었는지 모르므로 뒤·앞 둘 다.
    assert kd.knox_id_candidates("donghun-yi") == ["donghun-yi", "donghun.yi"]
    # 하이픈이 둘 이상이면 후보가 하나 더 붙는다 — 마지막만 `.` 이고 나머지는 **없던 문자**.
    # Knox ID 는 앞부분에 하이픈이 없다(`bc123.kim`·`mk8.kim`). 실측 2026-08-29(Knox 라이브):
    # `js-53-lee` → `js53.lee` 가 맞는데 기존 3후보 어디에도 없어 담당자 미상이었다.
    assert kd.knox_id_candidates("a-rom-lee") == [
        "a-rom-lee", "a-rom.lee", "a.rom-lee", "arom.lee",
    ]
    # 하이픈이 없으면 원문 하나뿐 — `rupin` 처럼 그대로가 Knox ID 인 계정이 있다.
    assert kd.knox_id_candidates("rupin") == ["rupin"]
    assert kd.knox_id_candidates("") == []


def test_메일_주소는_local_part_만_쓴다():
    # knox 는 메일 주소를 주면 못 찾는다(라이브 확인). 호출부가 반드시 잘라야 한다.
    assert kd.knox_id_from_email("BI95.Park@samsung.com") == "bi95.park"
    assert kd.knox_id_from_email("bi95.park") == "bi95.park"


def test_조회되면_이름_부서_직급이_온다(monkeypatch):
    _stub(monkeypatch, {"bi95.park": _PARK})
    emp = kd.lookup("bi95.park")
    assert emp is not None
    assert emp.full_name == "Byung-In Park"
    assert emp.department == "DC Infra그룹(AX/PI센터)"
    assert emp.title == "Principal Engineer"
    # 메일은 응답에 없다 — Knox ID 가 곧 local part 다.
    assert emp.email == "bi95.park@samsung.com"


def test_없는_계정은_None_이고_예외가_아니다(monkeypatch):
    _stub(monkeypatch, {})
    assert kd.lookup("nobody.here") is None
    # 조직 계정(`python-project` 등)이 못 찾히는 건 **정상 결과**다.
    assert kd.lookup_many(["python-project", "devops-template"]) == {}


def test_로그인_해석은_첫_성공_후보를_쓴다(monkeypatch):
    seen = _stub(monkeypatch, {"donghun.yi": {**_PARK, "knox_id": "donghun.yi"}})
    emp = kd.resolve_login("donghun-yi")
    assert emp is not None and emp.knox_id == "donghun.yi"
    # 후보 둘 다 물어보되(한 세션에 묶어서) 우선순위는 후보 순서를 따른다.
    assert seen == ["donghun-yi", "donghun.yi"]


def test_같은_계정을_다시_물으면_게이트웨이를_또_부르지_않는다(monkeypatch):
    seen = _stub(monkeypatch, {"bi95.park": _PARK})
    kd.lookup("bi95.park")
    kd.lookup("bi95.park")
    assert seen == ["bi95.park"]
    # 못 찾은 것도 캐시한다 — 조직 계정 수백 개를 매번 되묻지 않도록.
    kd.lookup("no.such")
    kd.lookup("no.such")
    assert seen == ["bi95.park", "no.such"]


def test_게이트웨이_실패는_못찾음으로_삼키지_않는다(monkeypatch):
    """★ 개별 호출 실패는 값으로 오지만, 그걸 '없는 사람' 과 섞으면 안 된다.

    splunk_owner 가 평문 에러를 빈 결과로 내려 5일간 조용히 0건이었던 사고와 같은 축이다.
    여기서는 실패를 None 으로 두되, **게이트웨이 자체가 안 뜨면 예외가 올라간다**.
    """
    from service.services.mcp_gateway import McpGatewayError

    async def boom(server, calls, *, concurrency=6):
        raise McpGatewayError("게이트웨이 미설정")

    monkeypatch.setattr(kd.mcp_gateway, "call_tools", boom)
    with pytest.raises(McpGatewayError):
        kd.lookup("bi95.park")
