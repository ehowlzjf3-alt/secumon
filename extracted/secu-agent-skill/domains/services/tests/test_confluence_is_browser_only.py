"""confluence 는 브라우저 전용이다 — REST 를 도구면에 되살리지 못하게 (2026-08-26).

## 왜

confluence REST 는 두 겹으로 막혀 있다. 실측(2026-08-26):

    /rest/api/search   (CQL 스캔)       Basic 403   Bearer 429
    /rest/api/space    (discovery)      Basic 403   Bearer 429
    /rest/api/content  (recheck 재조회)  Basic 403   Bearer 429

    Basic  403  {"message":"Basic Authentication has been disabled on this instance."}
    Bearer 429  {"message":"속도 제한이 초과되었습니다."}

403 은 **권한이 아니라 인증 방식** 문제였다 — DC 는 Basic 을 껐는데 `_client()` 가
`CONFLUENCE_USER` 가 있다는 이유로 Basic 을 골랐다. 그걸 고쳐도 상시 429 가 남는다.

## 이 파일이 막는 것

진단은 이미 있었다. `confluence_browser_search_tool.py` 주석이 2026-08-24 에
"살아 있는 건 이 브라우저 검색 하나뿐이다" 라고 적었다. **그런데 도구셋이 안 따라왔다.**
그 사이 space 25건이 전부

    "CQL search returned HTTP 403; access blocked, not assessed clean."

로 닫혔다 — 도구 선택 실패가 **타깃의 속성**으로 기록됐고, 그게 다시 판단 재료가 됐다.

REST 도구를 도구면에 다시 올리면 워커가 그걸 먼저 집는다. 그래서 여기서 고정한다.
"""
from __future__ import annotations

import pytest

# 되살리면 안 되는 REST 도구 이름
_REST_TOOLS = frozenset({
    "confluence_task_scan",
    "confluence_list_pages",
    "confluence_fetch_page",
    "confluence_list_attachments",
    "confluence_fetch_attachment",
})


def _tool_names(kind):
    from domains.services.confluence.plugin.toolsets import confluence_task_tools

    return {c.name for c in confluence_task_tools(kind)}


@pytest.mark.parametrize("kind", [None, "space_batch", "sso_url", "keyword_search"])
def test_no_rest_tool_is_exposed_to_any_kind(kind):
    """★ 어느 kind 에도 REST 도구가 없어야 한다."""
    leaked = _tool_names(kind) & _REST_TOOLS
    assert not leaked, (
        f"kind={kind!r} 에 REST 도구가 노출됐다: {sorted(leaked)} — "
        f"confluence REST 는 403/429 로 죽어 있다(2026-08-26 실측)")


@pytest.mark.parametrize("kind", [None, "space_batch", "sso_url", "keyword_search"])
def test_the_browser_search_is_always_available(kind):
    """★ 유일한 살아 있는 경로다. 빠지면 그 kind 는 아무것도 못 본다."""
    assert "confluence_browser_search" in _tool_names(kind)


def test_contracts_do_not_instruct_rest_calls():
    """계약이 없는 도구를 지시하면 워커가 턴을 버리고 halt 로 간다.

    ⚠️ "쓰지 마라" 문맥의 언급은 허용한다 — 그건 되살아남을 막는 문장이다.
       금지하는 것은 **호출 형태**(`confluence_task_scan(` 처럼 여는 괄호가 붙은 것).
    """
    from pathlib import Path

    root = Path(__file__).resolve().parents[2] / "confluence" / "skills" / "confluence_task"
    for name in ("SKILL.md", "worker.md", "plan.md"):
        path = root / name
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for tool in _REST_TOOLS:
            assert f"{tool}(" not in text, (
                f"{name} 이 {tool}() 호출을 지시한다 — 그 도구는 도구면에 없다")


def test_basic_auth_is_not_what_this_instance_accepts():
    """★ 403 의 정체를 코드에 남긴다.

    `_client()` 는 `CONFLUENCE_USER` 가 있으면 Basic 을 고른다. 이 인스턴스는 Basic 을
    껐다(DC). 즉 user 를 설정해 둔 것 자체가 403 의 직접 원인이었다.
    REST 를 되살리려는 사람이 먼저 이 사실을 만나게 한다.
    """
    import inspect

    from domains.services.confluence.plugin.agent_types import confluence as cf

    src = inspect.getsource(cf._client)
    assert "Bearer" in src and "Basic" in src, "인증 분기가 사라졌다 — 이 테스트를 갱신하라"
    assert 'auth = (user, token)' in src, (
        "Basic 분기가 바뀌었다. 이 인스턴스는 Basic 을 거부한다("
        "403 'Basic Authentication has been disabled') — 되살리려면 Bearer 가 정본이고, "
        "그래도 429 가 남는다는 것을 먼저 확인하라")


# ── 크리덴셜 프로브: 도구셋에서 뺀 게 아니라 **무장했을 때만** 올라온다 ──────────
#
# ★ 여기가 진짜 위험했다. 위의 REST 도구들은 도구면에서 빠졌지만 이 프로브는
#   `SA_CRED_PROBE` 를 켜는 순간 올라오고, 올라오면 `cf.fetch_page_body` 로 REST 를 친다.
#
#   그리고 이 도구의 판정은 **"이 크리덴셜로 로그인 되나"** 다.
#   403 을 받으면 그게 "크리덴셜이 죽었다" 로 기록된다 — 살아 있는 유출이
#   "이미 무효" 로 접힌다. space 25건이 닫힌 것과 같은 오진이고, 이쪽이 더 나쁘다.


def _probe_result():
    import asyncio

    from domains.services.confluence.plugin.tools.confluence_credential_login_probe_tool import (
        ConfluenceCredentialLoginProbeInput, ConfluenceCredentialLoginProbeTool,
    )

    tool = ConfluenceCredentialLoginProbeTool()
    vi = ConfluenceCredentialLoginProbeInput(page_id="123456")
    return asyncio.run(tool.execute(vi, None))


def test_credential_probe_never_reaches_rest(monkeypatch):
    """프로브가 REST 를 치면 안 된다 — 치는 순간 403 을 판정 재료로 삼는다."""
    from domains.services.confluence.plugin.agent_types import confluence as cf

    called: list[str] = []

    def _boom(page_id, *a, **kw):  # noqa: ANN001, ARG001
        called.append(str(page_id))
        raise AssertionError("REST 를 쳤다 — 이 경로는 막혀 있어야 한다")

    monkeypatch.setattr(cf, "fetch_page_body", _boom, raising=False)
    res = _probe_result()
    assert called == [], "fetch_page_body 가 호출됐다"
    assert res.type == "error"


def test_the_refusal_is_not_confusable_with_a_transient_failure():
    """★ 구조적 차단과 일시적 조회 실패는 **다른 사유**로 나가야 한다.

    처음엔 이 차단을 `try` 안에 뒀다가 아래 `except` 가 삼켜서
    `credential_source_fetch_failed` 로 나갔다. 그건 "잠깐 안 됐다, 재시도하면 된다"
    로 읽힌다 — 사실은 "이 인스턴스에선 원리적으로 안 된다" 인데.
    """
    res = _probe_result()
    assert res.kind != "execution", "일시적 실패 kind 로 나가고 있다"
    assert "credential_source_fetch_failed" not in res.message
    assert "confluence_rest_unavailable" in res.message


def test_the_refusal_says_it_did_not_judge_the_credential():
    """'검증 못 했다' 와 '유효하지 않다' 를 구분해서 말해야 한다.

    이 둘을 뭉개면 운영자가 살아 있는 크리덴셜을 정리 대상에서 뺀다.
    """
    msg = _probe_result().message
    assert "유효하지 않다는 뜻이 아니다" in msg, "무판정임을 명시하지 않았다"
