"""담당자 이름·부서는 마스킹 대상이 아니다 (사용자 결정 2026-08-23).

이 파일이 지키는 것은 두 가지다.
1. 이름/부서가 `redact()` 를 타지 **않는다** — 영문 성명·긴 부서 문자열이 봉인되면
   담당자 열의 존재 이유가 사라진다. 이전 구현은 redact 를 탔고 한글 값이 우연히
   패턴에 안 걸렸을 뿐이라, 그 우연에 기대지 않도록 고정한다.
2. 그래도 **표시 안전**은 지킨다 — 제어문자·제로폭·BIDI override 는 제거한다.
   이건 마스킹이 아니라 UI 스푸핑 방어라 성격이 다르다.
"""
from __future__ import annotations

from digisecu_gateway.masking import redact
from digisecu_gateway.repos.finding_repo import _owner_line


def test_영문_성명과_긴_부서명이_봉인되지_않는다():
    for value in (
        "Shane Baek",
        "shaneee.baek",
        "Infra Security Engineering Group",
        "Foundry FAB투자기획그룹(글로벌 제조&인프라총괄)",
        "전략마케팅실 정보보호그룹 클라우드보안파트",
    ):
        assert _owner_line(value, 120) == value


def test_마스킹_패턴에_걸리는_모양도_담당자_칸에서는_통과한다():
    # redact 는 20~39자 토큰런을 봉인한다. 부서명이 그 모양이어도 담당자 칸은 보존한다 —
    # 이 테스트가 깨지면 "우연히 안 걸린다" 로 되돌아간 것이다.
    value = "SecurityEngineeringGroup2026"
    assert redact(value) != value, "전제: 이 값은 redact 대상이다"
    assert _owner_line(value, 120) == value


def test_제어문자_제로폭_BIDI_는_제거한다():
    assert _owner_line("백​승훈", 80) == "백승훈"          # 제로폭
    assert _owner_line("‮백승훈", 80) == "백승훈"          # BIDI override
    assert _owner_line("백승훈\x00", 80) == "백승훈"            # NUL


def test_여러_줄과_중복_공백은_한_줄로_접는다():
    assert _owner_line("보안기술팀\n\n  보안기술그룹", 120) == "보안기술팀 보안기술그룹"


def test_절단은_정화_뒤에_한다():
    assert _owner_line("가나다라마바사", 3) == "가나다"


def test_문자열이_아니거나_비면_None():
    assert _owner_line(None, 80) is None
    assert _owner_line(123, 80) is None
    assert _owner_line("   ", 80) is None
    assert _owner_line("​​", 80) is None


def test_시크릿_계열은_이름_칸에서도_봉인한다():
    # 이름을 보존한다는 결정이 게이트웨이를 시크릿 반출 통로로 만들면 안 된다.
    # (test_finding_v2.test_assignee_smb_secret_in_name_masked_bad_email_rejected 와 같은 취지)
    for value, leaked in (
        ("이름 AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"),
        ("홍길동 900101-1234567", "1234567"),
        ("팀 password=hunter2xyz", "hunter2xyz"),
        ("부서 https://u:p4ssw0rd@host/x", "p4ssw0rd"),
    ):
        out = _owner_line(value, 120) or ""
        assert leaked not in out, f"{leaked!r} 가 {out!r} 로 새어나갔다"
        assert "«마스킹»" in out


def test_시크릿_봉인이_이름_부분까지_먹지는_않는다():
    out = _owner_line("이름 AKIAIOSFODNN7EXAMPLE", 120) or ""
    assert out.startswith("이름 ")
