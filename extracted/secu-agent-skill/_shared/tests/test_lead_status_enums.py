"""리드 `set_target_status` 의 닫힌 enum 이 **실제 큐 어휘**와 같은가 (Phase 2a).

## 왜 별도 테스트인가

리드 enum 은 복사본이 되기 쉽고, 틀려도 조용하다:
  · 빠진 값 → 리드가 유효한 상태를 거부한다(큐가 안 닫힌다)
  · 없는 값 → smb 는 `share_set_status` 가 검증을 안 해서 **오타가 DB 로 들어간다**

실제로 2026-08-21 실측에서 smb enum 복사본이 틀려 있었다 — 실 DB 에는 `closed`/
`ignored` 가 있는데 복사본에는 없었다. 그래서 복사 대신 정본을 참조하게 고쳤고,
여기서 그 참조가 유지되는지 고정한다.
"""
from __future__ import annotations

import pytest

from domains.dev_web.plugin.lead_adapter import dev_web_lead_adapter
from domains.services.confluence.plugin.lead_adapter import (
    confluence_lead_adapter, confluence_search_lead_adapter,
)
from domains.services.github.plugin.lead_adapter import github_lead_adapter
from domains.smb.plugin.lead_adapter import smb_lead_adapter


def _canonical(name: str) -> set[str]:
    import service.state_domain as sd
    return set(getattr(sd, name))


CASES = [
    ("dev_web", dev_web_lead_adapter, lambda: _canonical("_DEV_WEB_TARGET_STATUSES")),
    ("github", github_lead_adapter, lambda: _canonical("_DEVOPS_TARGET_STATUSES")),
    ("confluence", confluence_lead_adapter,
     lambda: _canonical("_CONFLUENCE_SPACE_STATUSES")),
    ("confluence_search", confluence_search_lead_adapter,
     lambda: _canonical("_CONFLUENCE_SEARCH_STATUSES")),
]


@pytest.mark.parametrize("name,factory,canon", CASES)
def test_lead_enum_matches_the_queue_vocabulary(name, factory, canon):
    got = set(factory().statuses)
    want = canon()
    assert got == want, (
        f"{name} 리드 enum 이 큐 어휘와 다르다.\n"
        f"  리드에만: {sorted(got - want)}\n"
        f"  큐에만:   {sorted(want - got)}"
    )


def test_smb_lead_enum_tracks_the_canonical_share_statuses():
    """★ smb 는 setter 가 검증을 **안 한다** — 이 enum 이 유일한 가드다."""
    from service.services.shares import SHARE_STATUSES

    got = set(smb_lead_adapter().statuses)
    assert got == set(SHARE_STATUSES)
    # 실 DB 에서 관측된 값들이 반드시 포함돼야 한다(2026-08-21 실측).
    assert {"closed", "ignored", "triaged_completed", "pending"} <= got


def test_no_lead_adapter_hardcodes_a_status_list_for_smb():
    """정본 참조가 다시 복사본으로 되돌아가는 것을 막는다."""
    import inspect

    from domains.smb.plugin import lead_adapter as m

    src = inspect.getsource(m)
    assert "from service.services.shares import SHARE_STATUSES" in src, (
        "smb 리드 enum 이 정본 참조를 잃었다 — 복사본은 조용히 드리프트한다")


# ── 어댑터 규격 통일 (v3.98) ──────────────────────────────────────────

_ALL_ADAPTERS = [
    ("smb", smb_lead_adapter), ("dev_web", dev_web_lead_adapter),
    ("github", github_lead_adapter), ("confluence", confluence_lead_adapter),
    ("confluence_search", confluence_search_lead_adapter),
]


@pytest.mark.parametrize("name,factory", _ALL_ADAPTERS)
def test_every_adapter_supplies_scan_summary(name, factory):
    """★ 눈 없는 큐가 조용히 생기면 안 된다 (사용자 원칙 ②).

    `LeadAdapter.scan_summary` 는 기본값 없는 required 필드라 생성자에서 이미 걸린다.
    여기서는 **호출 가능하고 닫힌 봉투를 준다**는 것까지 고정한다 — 볼 게 없는 큐는
    빈 구현이 아니라 `source="none"` + 이유를 명시적으로 돌려줘야 한다.
    """
    fn = factory().scan_summary
    assert callable(fn)
    import inspect

    sig = inspect.signature(fn)
    for kw in ("category", "kind", "verdict", "limit"):
        assert kw in sig.parameters, f"{name}.scan_summary 에 {kw} 파라미터가 없다"


def test_search_queue_says_it_cannot_link_rather_than_guessing():
    """★ 키워드검색 큐는 근사하지 않는다 — 근사하면 **다른 타깃의 결과**를 보여준다."""
    got = confluence_search_lead_adapter().scan_summary(1)
    assert got["source"] == "none"
    assert got["total"] == 0 and not got["rollup"] and not got["shapes"]
    assert got["note"], "왜 없는지 말하지 않으면 리드가 '깨끗함' 으로 읽는다"


def _code_without_prose(obj) -> str:
    """주석·docstring 을 뺀 **실행되는 코드**만. 경고문이 가드를 발동시키면 안 된다."""
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(obj))
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if not isinstance(body, list) or not body:
            continue
        first = body[0]
        if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)):
            body.pop(0)
    return ast.unparse(tree)


@pytest.mark.parametrize("name,factory", _ALL_ADAPTERS)
def test_scan_summary_never_reads_a_body_column(name, factory):
    """어댑터 코드가 `line_preview` 를 만지지 않는다 — 안 읽는 것이 그 약속의 이행이다.

    ⚠️ 문자열 검색이라 docstring 의 **경고문**도 걸린다(실제로 걸렸다). 그래서 주석·
    docstring 을 뺀 코드만 본다 — 안 그러면 "위험을 문서화하면 테스트가 깨지는" 꼴이 된다.
    """
    import inspect

    code = _code_without_prose(inspect.getmodule(factory))
    for banned in ("line_preview", "preview"):
        assert banned not in code, f"{name} 어댑터 코드가 {banned} 를 만진다"


def test_hit_sql_never_selects_a_body_column():
    """★ 진짜 경계는 SQL 이다 — 두 빌더가 본문 컬럼을 SELECT 하지 않는다."""
    from service import state_domain as sd

    for fn in (sd.share_hit_rollup, sd.share_hit_shapes):
        code = _code_without_prose(fn)
        assert "line_preview" not in code, f"{fn.__name__} 이 본문 줄을 읽는다"
