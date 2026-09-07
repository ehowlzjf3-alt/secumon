"""dev_web 조치요청 메일이 노출 데이터를 다시 흘리지 않는다.

## 왜 이 파일이 있나 (2026-08-24 실기동 초안에서 실물 확인)

"인증 없이 열린 항목" 표의 `응답 내용(마스킹)` 열에 공정 데이터가 **평문 그대로** 실렸다:

    {"prc":"KIYO-FXE_CSW_EB_V8","run":19,"down":3,"idle":0,"total":24,"가동률":79.0}
    {"prc":"KIYO-GX-TXR_CHH-MASK_FV8","target":6000,"forecast":6036,"wait":1671}

`scan_hits: []` — 탐지기가 아무것도 못 잡아 마스킹도 안 됐고, 열 이름만 "마스킹" 이었다.
같은 메일 본문이 바로 위에서 이렇게 말하고 있었다:

    "내부 공정 명칭, 가동률, 타겟 수치 등 민감한 비즈니스 데이터가 유출될 위험이 있습니다."

그리고 그 아래에 그 데이터를 실었다. **조치요청 메일 자체가 2차 노출 경로**가 된다.

⚠️ 마스킹을 더 세게 하는 것으로는 못 막는다. 탐지기가 모르는 형태(공정 코드·수량·내부
   약어)는 원리적으로 못 잡는다. 그래서 **본문을 아예 싣지 않는다.**
   SMB 조치요청 메일이 이미 그 원칙이다(`service/services/sensitive_summary.py`).
"""
from __future__ import annotations

import json

# 실기동에서 실제로 메일에 실렸던 값. 줄이거나 예쁘게 다듬지 말 것 —
# 이게 새어 나갔다는 사실이 이 파일의 근거다.
_LEAKED = (
    '"[{\\"prc\\":\\"KIYO-FXE_CSW_EB_V8\\",\\"run\\":19,\\"down\\":3,\\"idle\\":0,'
    '\\"pm_loc\\":2,\\"total\\":24,\\"\\\\uac00\\\\ub3d9\\\\ub960\\":79.0},'
    '{\\"prc\\":\\"KIYO-GX-TXR_CHH-MASK_FV8\\",\\"target\\":6000,\\"forecast\\":6036}]"'
)

_FINDING = {
    "severity": "high",
    "evidence_ref": "/tmp/dev_web_e2e_evidence/20260824T092331-ede8bd-x/finding.json",
    # ⚠️ `_probe_rows` 는 `extra` dict 가 아니라 **`extra_json` 문자열**을 읽는다.
    "extra_json": json.dumps({
        "pivot": {"probes": [{
            "url": "https://x.cdep.samsungds.net/api/v2/status?sdwt=LambDa_P1F_P",
            "status": "200", "content_type": "application/json",
            "evidence_masked": _LEAKED, "exposed": True,
        }]},
    }, ensure_ascii=False),
}


def _render() -> str:
    from domains.dev_web.plugin.tools import dev_web_report_tools as dw

    return dw._html_report(
        {"url": "https://x.cdep.samsungds.net", "domain": "x.cdep.samsungds.net",
         "severity": "high"},
        _FINDING, {}, "",
    )


def test_응답_본문이_메일에_실리지_않는다() -> None:
    """★ 본체. 공정 명칭·수치가 메일에 나타나면 안 된다."""
    html = _render()
    for token in ("KIYO-FXE_CSW_EB_V8", "KIYO-GX-TXR_CHH-MASK_FV8", "6036", "79.0"):
        assert token not in html, f"노출 데이터가 메일에 실렸다: {token!r}"


def test_무엇이_열렸는지는_그대로_보여준다() -> None:
    """본문만 빼는 것이지 표를 없애는 게 아니다 — 담당자는 경로를 알아야 조치한다."""
    html = _render()
    assert "/api/v2/status" in html
    assert "200" in html
    assert "application/json" in html
    assert "인증 없이 열린 항목" in html


def test_응답_규모는_남는다() -> None:
    """규모는 우선순위 판단에 쓰인다. 값이 아니라 크기·형태만."""
    from domains.dev_web.plugin.tools import dev_web_report_tools as dw

    assert dw._response_shape(
        {"evidence_masked": '[{"a":1},{"a":2},{"a":3}]', "content_type": "application/json"},
    ) == "JSON 레코드 약 3건 · 25자"
    assert dw._response_shape({"evidence_masked": "x" * 8200, "content_type": "text/html"}) == "약 8KB"
    assert dw._response_shape({"evidence_masked": "", "content_type": ""}) == "-"


def test_내부_파일경로가_담당자에게_가지_않는다() -> None:
    """`evidence_ref` 는 서버 로컬 경로다 — 담당자는 못 열고 내부 구조만 드러난다."""
    html = _render()
    assert "/tmp/dev_web_e2e_evidence" not in html
    assert "finding.json" not in html
    # 대신 "몇 건이 열렸나" 가 그 자리에 온다.
    assert "확인된 항목" in html


def test_회신_안내가_한_번만_나온다() -> None:
    """예전엔 `점검 방법` 리스트와 푸터에 같은 말이 둘 있었다."""
    html = _render()
    assert html.count("회신") == 1, "회신 안내가 중복됐다"
