"""워커 시작 줄은 **실제로 서빙하는** 프로파일을 말해야 한다 (2026-08-20 실측).

## 무엇이 있었나

`cli.py` 는 코어가 고른 프로파일을 시작 줄에 찍는데, 계약의 `build_client` 훅은 그
**뒤에** 능력 기반으로 모델을 바꿀 수 있다(이미지가 필수인 워커에 vision 불가 모델이
선택된 경우). 그래서 로그가 거짓이 됐다:

    [runtime] deepseek 는 이미지 입력을 지원하지 않아 … gemma 로 대체한다
    [agent] start … profile=deepseek model=private-deepseek-v4-seunghanee   ← 실제는 gemma

dev_web 실기동에서 실측됐다. 표시 문제로 보이지만 **모델 A/B 어트리뷰션을 뒤집는다** —
이 저장소가 `ProfileTaggedClient`("실제로 응답한 모델")를 만든 이유와 같은 종류의 사고다.

## 폴백 체인

체인이면 `client.name` 이 체인 전체 문자열이라("fallback(retry(a) -> retry(b))")
그대로 찍으면 대체가 없는데도 대체된 것처럼 보인다 — github 실기동에서 실제로 그랬다.
선두 client 를 한 겹 벗겨 이름만 꺼낸다.
"""
from __future__ import annotations

import re
from pathlib import Path


class _Tagged:
    def __init__(self, name: str) -> None:
        self._profile_name = name


class _Chain:
    """FallbackLLMClient 형상 — name 은 체인 전체 문자열이다."""

    def __init__(self, members) -> None:
        self._clients = list(members)
        self.name = "fallback(" + " -> ".join(
            f"retry({m._profile_name})" for m in members) + ")"


def _served(client):
    """cli.py 의 `_served_profile` 을 소스에서 그대로 가져와 검증한다."""
    src = (Path(__file__).resolve().parents[1] / "src" / "secu_agent" / "agent"
           / "cli.py").read_text(encoding="utf-8")
    m = re.search(r"    def _served_profile\(c\).*?\n        return None\n", src, re.S)
    assert m, "cli.py 에서 _served_profile 을 못 찾음 — 이름이 바뀌었나?"
    body = "\n".join(line[4:] for line in m.group(0).splitlines())
    ns: dict = {}
    exec(body, ns)      # noqa: S102 — 코어 소스 자체를 검증 대상으로 실행
    return ns["_served_profile"](client)


def test_direct_client_reports_its_profile() -> None:
    assert _served(_Tagged("gemma")) == "gemma"


def test_chain_reports_its_head_not_the_whole_chain() -> None:
    """★ 체인 문자열을 그대로 찍으면 대체가 없는데도 대체처럼 보인다."""
    chain = _Chain([_Tagged("deepseek"), _Tagged("gemma")])
    assert _served(chain) == "deepseek"
    assert "->" not in (_served(chain) or "")


def test_unknown_client_shape_reports_none_instead_of_guessing() -> None:
    assert _served(object()) is None


def test_cli_marks_substitution_explicitly() -> None:
    """대체가 일어났을 때만 화살표 표기 — 아니면 조용해야 한다."""
    src = (Path(__file__).resolve().parents[1] / "src" / "secu_agent" / "agent"
           / "cli.py").read_text(encoding="utf-8")
    assert "계약이 대체" in src, "대체를 로그에 드러내는 표기가 사라졌다"
    assert "_served == profile.name" in src, (
        "대체 여부 비교가 사라졌다 — 항상 화살표를 찍으면 로그를 못 믿는다"
    )


def test_substitution_also_reports_the_substituted_model() -> None:
    """★ 220731b 가 고친 사고의 **남은 절반**.

    실측 2026-08-22(ab28_deepseek_smb 검토원 세션):

        profile=deepseek→gemma model=private-deepseek-v4-seunghanee

    화살표는 맞는데 `model=` 은 여전히 코어가 고른 쪽이었다. 프로파일 이름만 고치고
    모델 필드를 같이 안 고친 것이다. 로그를 `model=` 으로 세면(A/B 집계가 정확히 그렇게
    센다) 어트리뷰션이 뒤집힌다 — 220731b 커밋 메시지가 경계한 바로 그 사고다.
    """
    src = (Path(__file__).resolve().parents[1] / "src" / "secu_agent" / "agent"
           / "cli.py").read_text(encoding="utf-8")
    m = re.search(r"_served_model = .*?\n", src)
    assert m, "대체된 프로파일의 모델을 꺼내는 줄이 없다"
    # 대체 분기의 f-string 이 `profile.model` 을 **직접** 쓰면 안 된다(폴백 표기 제외).
    branch = src[src.index("_served_model = "):src.index("(계약이 대체)") + 20]
    assert "_served_model or profile.model" in branch, (
        "대체 분기가 코어 선택 모델을 그대로 찍는다 — 화살표만 맞고 모델은 거짓이 된다")

