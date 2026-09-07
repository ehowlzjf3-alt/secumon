"""리드 경계 — 레포트 본문은 열되 공정 레시피 원문만 막는다 (사용자 결정 2026-08-26).

## 결정

    "codex 는 엔터프라이즈라 이 정도 정보까지는 괜찮다"
    "실제 사내 공정 레시피 파일 읽는 것만 안 나가면 된다"

리드는 `SA_LEAD_PROFILE=codex` 로 돌고 codex 는 `https://chatgpt.com/backend-api/codex`
다 — 즉 리드가 곧 사외 계층이고, 마스킹 경계가 그래서 있다. 사용자가 그 경계를
**레시피 원문 하나로** 좁혔다.

## 왜 기존 분류기를 그대로 안 쓰나

`document_sensitivity._PROCESS_PATH_TERMS` 에는 `mask`·`fab`·`photo`·`euv` 같은 넓은
낱말이 있다. 그대로 걸면 `github:org/mask-service/...` 처럼 무관한 경로가 잡히고,
실측된 레포트 본문(github 400/400 이미 마스킹 완료)이 통째로 가려져 리드가 판단할
재료를 잃는다. **막는 것이 넓어지면 리드가 검토원에게 다 떠넘기게 된다** — 리드 층을
만든 이유의 반대다.

## 무엇이 지나가고 무엇이 막히나

    지나간다   경로·종류·라인번호·건수·검토원 narrative   ← 좌표와 판단
    막힌다     그 파일의 원문 줄                         ← context/preview/line_preview

"무엇이 어디 있나" 는 가고 "그 파일에 뭐라고 적혀 있나" 만 안 간다.
"""
from __future__ import annotations

import json

import pytest

from _shared.lead_masking import RECIPE_WITHHELD, mask_tool_content


def _blocked(payload: dict) -> bool:
    return RECIPE_WITHHELD in mask_tool_content(json.dumps(payload, ensure_ascii=False))


# ── 막혀야 하는 것 ───────────────────────────────────────────────────────

@pytest.mark.parametrize("payload", [
    # ★ 2026-08-26 smb 리드 실기동에서 검토원이 **실제로 연** 파일들이다.
    {"path": "NGS/Bin/DSARecipe.xml", "kind": "process",
     "context": ['<Step id="3" Time="12" Temp="450"/>']},
    {"path": "NGS/Bin/RecipeDomainConfig.xml", "kind": "cfg",
     "context": ["OverlayType=3"]},
    # 경로가 한국어로 말해 주는 경우
    {"asset": "smb://10.0.0.1/D/공정조건_2026.xlsx",
     "preview": "etch rate 1.2 / CD uniformity"},
    # 경로가 안 말해 주면 본문 구조로 본다 (confluence 붙여넣기 등)
    {"path": "notes.txt",
     "context": ["Recipe ID: R-4471", "Step 2:\tTime 30s Temp 420C Flow 12"]},
])
def test_recipe_bodies_do_not_reach_the_lead(payload):
    assert _blocked(payload)


def test_one_recipe_line_blocks_the_whole_context_block():
    """★ 줄 단위로 남기면 앞뒤가 붙어 결국 같은 내용이 재구성된다."""
    out = json.loads(mask_tool_content(json.dumps({
        "path": "proc/DSARecipe.xml",
        "context": ["무해한 헤더", "Recipe ID: R-4471", "그 다음 줄"],
    }, ensure_ascii=False)))
    assert out["context"] == [RECIPE_WITHHELD]


# ── 지나가야 하는 것 ─────────────────────────────────────────────────────

@pytest.mark.parametrize("payload", [
    # 사용자가 명시적으로 허용한 수준 — 회의록·현황
    {"path": "docs/회의록.md",
     "preview": "PMO - 2.5D 현황 / 수율/MTS - 2700 CP 칩두께 변경시 사업부, 고객사"},
    {"path": "minutes.md",
     "preview": "EUV MASK 수요 관련 최신 자료로 update 필요 (@MASK개발팀)"},
    # ★ 넓은 낱말 오탐 — 'mask' 가 경로에 있다고 막으면 안 된다
    {"asset": "github:org/mask-service/src/app.py", "line_preview": "v7dZ****LdQ="},
    {"path": "web.config",
     "preview": '.ConnectionString = "Provider=SQLOLEDB.1;User ID=sa;dhdk****'},
])
def test_allowed_report_bodies_still_reach_the_lead(payload):
    assert not _blocked(payload)


def test_coordinates_survive_even_when_the_body_is_withheld():
    """★ 막는 것은 원문뿐이다. 좌표가 같이 사라지면 리드가 판단을 못 한다."""
    out = json.loads(mask_tool_content(json.dumps({
        "path": "NGS/Bin/DSARecipe.xml", "kind": "process_recipe",
        "line_no": 42, "count": 7,
        "context": ["Recipe ID: R-4471"],
    }, ensure_ascii=False)))
    assert out["path"] == "NGS/Bin/DSARecipe.xml"
    assert out["kind"] == "process_recipe" and out["line_no"] == 42 and out["count"] == 7
    assert out["context"] == [RECIPE_WITHHELD]


def test_inspector_judgment_is_never_withheld():
    """★ `narrative`/`why` 는 검토원이 쓴 **판단**이지 파일 내용이 아니다.

    여기까지 막으면 리드가 받는 가장 중요한 재료가 사라진다. 계약이 이미 검토원에게
    "원문 인용·평문 시크릿은 쓰지 마라" 를 요구한다 — 그게 이 필드의 방어다.
    """
    out = json.loads(mask_tool_content(json.dumps({
        "path": "NGS/Bin/DSARecipe.xml",
        "narrative": "이 파일은 장비 레시피이고 Recipe ID 체계가 노출돼 있다",
        "why": "recipe step 파라미터가 평문이다",
        "context": ["Recipe ID: R-4471"],
    }, ensure_ascii=False)))
    assert "레시피" in out["narrative"] and "recipe" in out["why"]
    assert out["context"] == [RECIPE_WITHHELD]


def test_plain_report_corpus_is_not_over_blocked():
    """실 DB 레포트 본문에서 오탐이 나면 리드가 눈을 잃는다 (실측 400건 0%)."""
    corpus = [
        {"asset": "github:o/r/a.py", "hits": [
            {"category": "secret", "kind": "high_entropy_string",
             "line_preview": "v7dZ****LdQ=", "masked": "v7dZ****LdQ="}]},
        {"asset": "https://confluence…/spaces/DSCERT/pages/1", "hits": [
            {"category": "secret", "kind": "mongodb_admin_password",
             "preview": 'db.createUser({ user: "apcAdmin", pass****pt() })'}]},
    ]
    for item in corpus:
        assert not _blocked(item)


def test_rcp_extension_is_word_bounded():
    """★ `\\b` 가 살아 있는지 고정한다.

    처음 작성 때 히어독이 `\\b` 를 **실제 백스페이스(0x08)** 로 바꿔 이 분기가 죽어
    있었다 — 그런데 `DSARecipe.xml` 은 `recipe` 쪽에서 먼저 매치돼 테스트가 통과했다.
    죽은 분기를 통과로 읽은 것이다. 두 방향을 같이 고정해야 그게 안 반복된다.
    """
    assert _blocked({"path": "eqp/PROC_A7.rcp", "preview": "Step1 Temp 420"})
    assert not _blocked({"path": "report.rcpanel.js", "preview": "const x = 1"})


def test_step_parameter_table_is_detected_by_structure():
    """경로가 안 말해 주면 본문 구조로 본다 — 탭 구분 step/파라미터 표."""
    assert _blocked({"path": "n.txt", "context": ["Step 3:\tTime 30s Temp 420C"]})


def test_rendered_mail_bodies_are_never_touched():
    """★ 메일 본문은 경로·유형·건수·설명뿐이다(실측: 3도메인 렌더 확인).

    본문 자체가 이렇게 못박고 있다 — "보안상 파일 경로와 값은 메일에 포함하지 않습니다".
    실 DB 레포트 400건에 이 관문이 걸린 건 0건이다. 여기가 막히기 시작하면 관문이
    엉뚱한 채널로 번진 것이다.
    """
    mail_like = {
        "repo": "jg279-lee/SdkAutoTest",
        "findings": [{"asset": "source/firmware/winscp_get.txt",
                      "severity": "medium", "kind": "credential"}],
        "summary": {"크리덴셜·비밀번호": 8},
    }
    assert not _blocked(mail_like)
