"""hit 판정 도구 — 스코프와 왕복 (2026-08-28 복원).

`e04250f` 가 `set_hit_verdict` 를 지운 뒤 재배선이 없어서 hit 16,204건이 6주간
`pending` 이었고, share 28개가 판정 없이 `triaged_completed` 로 닫혔다.
`private_key_block` 17건 중 finding 이 된 건 1건뿐이었다.

이 파일이 지키는 것:
  ① 판정이 실제로 DB 에 남는다 (왕복)
  ② **남의 공유 hit 은 못 건드린다** — hit_id 는 LLM 입력이다
  ③ 스코프는 spec 에서 온다 (metadata 배선)
"""
from __future__ import annotations

import asyncio

import pytest
from secu_agent.agent.tools.base import ToolContext, ToolError, ToolSuccess

import service.state_domain as sd
from domains.smb.plugin.tools.hit_triage_tools import (
    SmbListPendingHitsTool, SmbSetHitVerdictTool,
)


def _seed(seed, host: str, share: str, path: str, *,
          category="secret", kind="private_key_block"):
    sid = seed.share(host=host, share=share)
    fid = seed.file(sid, path=path)
    hid = seed.hit(fid, category=category, kind=kind)
    return int(sid), int(hid)


def _ctx(share_ids, tmp_path):
    return ToolContext(evidence_dir=tmp_path, metadata={"smb_share_ids": list(share_ids)})


def test_verdict_round_trips_to_the_db(seed, tmp_path):
    sid, hid = _seed(seed, "10.0.0.1", "share", "keys/id_rsa")
    assert sd.share_hits_pending_count(sid, categories=("secret",)) == 1

    r = asyncio.run(SmbSetHitVerdictTool().execute(
        SmbSetHitVerdictTool.input_model(hit_id=hid, verdict="confirmed", note="평문 개인키 확인"),
        _ctx([sid], tmp_path)))
    assert isinstance(r, ToolSuccess), r
    assert sd.share_hits_pending_count(sid, categories=("secret",)) == 0, "판정이 DB 에 안 남았다"


def test_cannot_touch_a_hit_from_another_share(seed, tmp_path):
    """★ hit_id 는 LLM 입력이다 — 스코프 검사를 DB 로 해야 하는 이유."""
    _sid_a, hid_a = _seed(seed, "10.0.0.1", "shareA", "a/id_rsa")
    sid_b, _hid_b = _seed(seed, "10.0.0.2", "shareB", "b/id_rsa")

    r = asyncio.run(SmbSetHitVerdictTool().execute(
        SmbSetHitVerdictTool.input_model(hit_id=hid_a, verdict="false_positive"),
        _ctx([sid_b], tmp_path)))          # B 를 점검 중인데 A 의 hit 을 노린다
    assert isinstance(r, ToolError) and r.kind == "forbidden", r
    assert sd.share_hits_pending_count(_sid_a, categories=("secret",)) == 1, "남의 hit 이 바뀌었다"


def test_refuses_when_scope_is_missing(seed, tmp_path):
    """spec 이 share 를 안 주면 아무것도 못 한다 — fail-closed."""
    _sid, hid = _seed(seed, "10.0.0.1", "share", "k/id_rsa")
    for tool, kwargs in ((SmbSetHitVerdictTool(), {"hit_id": hid, "verdict": "confirmed"}),
                         (SmbListPendingHitsTool(), {})):
        r = asyncio.run(tool.execute(tool.input_model(**kwargs), _ctx([], tmp_path)))
        assert isinstance(r, ToolError), f"{tool.name}: 스코프 없이 통과했다"


def test_list_shows_hit_ids_and_defaults_to_secret(seed, tmp_path):
    sid, hid = _seed(seed, "10.0.0.1", "share", "k/id_rsa")
    fid2 = seed.file(sid, path="x/card.csv")
    seed.hit(fid2, category="pii", kind="credit_card")

    r = asyncio.run(SmbListPendingHitsTool().execute(
        SmbListPendingHitsTool.input_model(), _ctx([sid], tmp_path)))
    assert isinstance(r, ToolSuccess), r
    assert f"hit_id={hid}" in r.content, "hit_id 가 목록에 없다 — 판정할 방법이 없어진다"
    assert "credit_card" not in r.content, "기본이 secret 인데 pii 가 섞였다"


def test_inspector_contract_supplies_the_share_scope():
    """★ 배선이 빠지면 도구가 fail-closed 로 아무것도 못 한다 — 조용히."""
    from domains.smb.plugin.inspect_contract import _metadata

    md = _metadata({"target": {"host": "10.0.0.1", "share_ids": [7, 9]}})
    assert md["smb_share_ids"] == [7, 9]


# ── Q6: print 규칙 폭발반경 측정 (2026-08-28) ─────────────────────────────

def test_path_print_rule_over_matches_and_we_can_prove_it():
    """★ 경로 규칙 `r"print"` 는 앵커가 없어 실제 폴더를 잡는다.

    share 이름 규칙(`is_print_share`)은 완전일치라 정확했다 — 2,463건 전부 `print$` 였다.
    하지만 **경로** 규칙은 다르다. 실공유 16개에서 `Drivers/PICM`(전자현미경 드라이버),
    `Dll/Spool` 같은 디렉토리가 이미 제외됐다.

    아직 앵커를 고치지 않는다(사용자 결정 B→A: 규모부터 측정). 이 테스트는
    **과매칭이 실재한다는 사실**을 고정해서, 나중에 고칠 때 무엇이 바뀌는지 보이게 한다.
    """
    from service.collector import print_filter

    # 진짜 프린터 경로 — 잡아야 한다
    for p in ("print$/x", "spool/drivers/y", "PRINTERS/z"):
        assert print_filter.is_print_path(p), p
    # ⚠️ 오탐 — 지금은 이것도 잡힌다
    for p in ("Blueprint/design.dwg", "sprint2024/plan.xlsx", "footprint/data.csv"):
        assert print_filter.is_print_path(p), f"{p}: 과매칭이 사라졌다면 앵커를 고친 것 — 이 테스트를 갱신하라"


def test_file_exclusion_leaves_a_measurable_trace():
    """제외된 파일은 DB 행이 안 남는다 — 그래서 표본을 반환값에 싣는다.

    이게 없으면 "몇 개를 버렸나" 를 사후에 잴 방법이 아예 없다(디렉토리는
    `excluded:print` 마커가 있는데 파일은 없었다).
    """
    import inspect

    from service.collector import walk_core

    src = inspect.getsource(walk_core)
    assert "excluded_sample" in src, "제외 표본을 남기지 않는다 — 규모 측정 불가"
    assert '"excluded_sample": excluded_sample' in src, "표본이 반환값에 실리지 않는다"


# ── D: 판정 범위와 프레이밍 (2026-08-29) ──────────────────────────────────

def test_default_scope_includes_semiconductor_process():
    """★ 범위는 **위험도**로 정한다 — 건수로 정하지 않는다.

    첫 판은 "pii/공정은 건수가 커서" 라는 이유로 둘 다 뺐고, 그 결과 기본 범위가
    전체 hit 의 **5.2%**(2,105/40,451)였다. 여긴 반도체 회사이고 공정 자료
    4,251건이 통째로 빠져 있었다. `.claude/skills/measure-first` 가 명시적으로 금하는 것이다.
    """
    from domains.smb.plugin.tools.hit_triage_tools import DEFAULT_TRIAGE_CATEGORIES as D

    assert "semiconductor_process" in D, "공정 자료가 기본 범위에서 빠졌다"
    assert "secret" in D and "business_confidential" in D
    # pii 는 **분포** 때문에 뺀다(건수가 아니라) — 상위 3파일이 50%.
    assert "pii" not in D


def test_truncation_is_disclosed_not_silent(seed, tmp_path):
    """★ 잘림을 숨기면 워커가 "이게 전부" 로 읽는다.

    `share_hits_pending` 의 ORDER BY 가 `h.category, ...` 알파벳순이라 캡에 걸리면
    `semiconductor_process` 가 (b < p < s < se) **제일 먼저 잘린다**. 조용히 자르면
    공정 자료를 통째로 못 본다.

    ⚠️ 정렬을 위험도순으로 바꾸는 건 여기서 안 한다 — 정렬 정본은
       `_shared/hit_view.CATEGORY_PRIORITY` 하나이고, `state_domain` 에 목록을 복사하는 건
       `share_hit_shapes` 도크스트링이 명문으로 금한다. 게다가 그 정본은 공정을 pii
       **아래**에 두고 테스트가 고정한다 — 어휘는 결정 사항이다. 그래서 **알린다**.
    """
    import asyncio

    from domains.smb.plugin.tools.hit_triage_tools import SmbListPendingHitsTool

    sid = seed.share(host="10.5.0.1", share="s")
    for i in range(3):
        fid = seed.file(sid, path=f"sec/{i}.env")
        seed.hit(fid, category="secret", kind="generic_password_assignment")
    for i in range(3):
        fid = seed.file(sid, path=f"proc/{i}.xlsx")
        seed.hit(fid, category="semiconductor_process", kind="document_body_keyword")

    tool = SmbListPendingHitsTool()
    r = asyncio.run(tool.execute(tool.input_model(limit=2), _ctx([sid], tmp_path)))
    body = str(r.content)
    assert "⚠️" in body and "카테고리별 전체" in body, f"잘림을 안 알린다:\n{body}"
    assert "semiconductor_process" in body, "잘린 카테고리가 안 보인다"


def test_description_says_it_is_a_starting_point():
    """★ 깔끔한 목록은 '할 일 목록' 으로 읽힌다 — 그게 시야를 좁힌다.

    사용자 우려 그대로다: "코드로 로지컬하게 뽑은 secret 정탐판정만 하고 끝낼까 걱정".
    설명이 명시적으로 "이건 전부가 아니다" 라고 말해야 한다.
    """
    from domains.smb.plugin.tools.hit_triage_tools import SmbListPendingHitsTool

    d = SmbListPendingHitsTool.description
    assert "시작점" in d and "전부가 아니다" in d
    assert "깨끗하다" in d, "목록을 비운 게 clean 이 아니라는 말이 없다"
    assert "건수가 커서" not in d, "범위 근거를 건수로 다시 적었다"
