"""메일이 나가는 문은 **하나뿐이어야 한다.**

2026-08-25 사용자 결정: "agent던 지금 만드는 버튼이든 드라이런 발송차단은 1개로 통일해서
막고 안 쓰는 건 버리고."

## 무엇이 있었나

`POST /api/findings/owner-mail-send` 가 **게이트를 타지 않는 발송 문**이었다.
수신자·제목·본문을 요청에서 그대로 받아 `send_owner_mail()` → Knox MCP 로 직행했다:

    apply_egress_gate 없음 · SA_DELIVERY_RECIPIENT_ALLOW 없음
    redact 스캔 없음 · SA_DELIVERY_AUTOSEND_SINKS opt-in 없음

게다가 토큰 기본값이 리터럴 `devtoken`(`SA_CHAT_TOKEN` 미설정)이고 8767 은 0.0.0.0
바인딩이라 실측상 `?token=devtoken` 이 통과했다 — 503 은 인증 실패가 아니라 MCP 미기동이었다.
바로 위 `notify-owner` 는 "직접 발송은 비활성화됨" 이라며 410 을 내면서 **그 대체 경로로
이 문을 안내**하고 있었다. 막은 문 옆에 안 막은 문.

## 지금의 유일한 경로

    deliver() → apply_egress_gate → knox_mail sink → send_owner_mail → Knox MCP

게이트 2축(sink opt-in + RECIPIENT_ALLOW)·redact 스캔·dry-run draft 폴백이 전부 그 안에 있다.
"""
from __future__ import annotations

import ast
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ENGINE_SRC = REPO.parent / "secu-agent" / "src"

#: MCP 로 직행하는 함수들. 이걸 부르는 곳은 **엔진 sink 하나뿐**이어야 한다.
_DIRECT_SEND = ("send_owner_mail", "call_knox_mail_tool")

#: 유일하게 허용된 호출자 — `deliver()` 안에서만 실행된다.
_ALLOWED = ("secu_agent/knox/mail_sink.py", "secu_agent/knox/owner_mail.py")


def _call_sites(root: Path) -> list[str]:
    """실제 **호출**만 센다.

    ⚠️ 처음엔 grep 으로 셌다가 이 파일 자신의 주석 문장(`send_owner_mail()` 이라고 쓴 것)을
       위반으로 잡았다. 텍스트 매칭은 코드와 산문을 구별 못 한다 — AST 로 센다.
    """
    out: list[str] = []
    for f in root.rglob("*.py"):
        sp = str(f)
        if "/.venv/" in sp or "/tests/" in sp or "/test_" in sp:
            continue
        if any(a in sp for a in _ALLOWED):
            continue
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            fn = node.func
            name = fn.id if isinstance(fn, ast.Name) else (
                fn.attr if isinstance(fn, ast.Attribute) else None
            )
            if name in _DIRECT_SEND:
                out.append(f"{sp}:{node.lineno}: {name}()")
    return out


def test_only_the_sink_reaches_the_mail_mcp():
    """★ 이 테스트가 이 저장소의 발송 불변식이다.

    새 호출자가 늘면 여기서 깨진다 — 콘솔 발송 버튼도 `deliver()` 를 거쳐야 하고,
    `send_owner_mail` 을 직접 부르면 안 된다.
    """
    offenders: list[str] = []
    for root in (REPO / "service", REPO / "domains", ENGINE_SRC):
        if root.exists():
            offenders.extend(_call_sites(root))
    assert not offenders, (
        "게이트를 거치지 않고 Knox MCP 로 직행하는 호출부가 생겼다 — "
        "발송은 deliver() 하나로만 나가야 한다:\n  " + "\n  ".join(offenders)
    )


def test_the_deleted_routes_do_not_come_back():
    """지운 것이 되살아나는 것을 막는다. 지우는 것보다 **안 돌아오게 하는 것**이 어렵다."""
    src = (REPO / "service" / "routes" / "findings_domain.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    paths = [
        d.args[0].value
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        for d in node.decorator_list
        if isinstance(d, ast.Call) and d.args
        and isinstance(d.args[0], ast.Constant) and isinstance(d.args[0].value, str)
    ]
    for gone in ("/owner-mail-send", "/owner-mail-draft", "/notify-owner"):
        assert gone not in paths, f"{gone} 이 되살아났다 — 게이트를 우회하는 문이다"


def test_the_gate_is_the_perimeter_not_just_an_opinion():
    """`apply_egress_gate` 는 **판정만** 한다 — 실제로 막는 것은 `deliver()` 다.

    게이트만 부르고 sink 를 직접 호출하면 "물어보고 안 지키는" 코드가 된다.
    """
    src = (ENGINE_SRC / "secu_agent" / "agent" / "delivery.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    # ⚠️ `deliver` 는 **async def** 다 — FunctionDef 만 보면 못 찾는다(처음에 그랬다).
    deliver = next(
        n for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == "deliver"
    )
    body = ast.dump(deliver)
    assert "apply_egress_gate" in body, "deliver() 가 게이트를 안 부른다"
    assert "'send'" in body or '"send"' in body or "attr='send'" in body, (
        "deliver() 가 sink.send 를 안 부른다 — 경로가 바뀌었다"
    )
