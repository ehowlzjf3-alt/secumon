"""dev_web report and delivery tools."""
from __future__ import annotations

import json
import os
import re
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess
from secu_agent.agent.tools.deliver_tool import DeliverInput, DeliverTool

from service import state_domain as state
from service.services import owner_recipients as orx

_MAIL_SUBJECT_SUFFIX = "개발 웹 접근통제 조치"
_MAIL_STYLES = """
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: #f6f8fb;
      color: #263238;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', Arial, sans-serif;
      font-size: 14px;
      line-height: 1.7;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      background: #ffffff;
      border: 1px solid #dde5ee;
      border-radius: 10px;
      overflow: hidden;
    }
    .header {
      background: #17324d;
      color: #ffffff;
      padding: 28px 36px;
    }
    .header h1 { margin: 0 0 8px 0; font-size: 22px; font-weight: 700; }
    .header p { margin: 0; color: #dbe8f3; font-size: 13px; }
    .content { padding: 32px 36px 38px 36px; }
    .lead { margin: 0 0 18px 0; }
    .info-card {
      background: #eef7fb;
      border-left: 4px solid #247ba0;
      border-radius: 0 8px 8px 0;
      padding: 16px 18px;
      margin: 20px 0;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px 12px;
    }
    .metric {
      background: rgba(255,255,255,.78);
      border: 1px solid #cce2eb;
      border-radius: 8px;
      padding: 10px 12px;
    }
    .metric small { display: block; color: #60717d; font-size: 12px; margin-bottom: 3px; }
    .metric strong { display: block; color: #17324d; overflow-wrap: anywhere; }
    .surface-table {
      width: 100%;
      border-collapse: collapse;
      margin: 8px 0 4px;
      font-size: 13px;
    }
    .surface-table th {
      background: #4a5568;
      color: #fff;
      text-align: left;
      padding: 8px 10px;
      font-weight: 600;
      white-space: nowrap;
    }
    .surface-table td {
      border-bottom: 1px solid #e2e8f0;
      padding: 8px 10px;
      vertical-align: top;
      word-break: break-all;
    }
    .surface-table tr:nth-child(even) td { background: #f8fafc; }
    .surface-more { color: #718096; font-size: 12px; margin: 4px 0 0; }
    .section-title {
      margin: 26px 0 12px 0;
      padding-bottom: 8px;
      border-bottom: 2px solid #dde5ee;
      color: #17324d;
      font-size: 16px;
      font-weight: 700;
    }
    .note {
      background: #f8fafc;
      border: 1px solid #dde5ee;
      border-radius: 8px;
      padding: 12px 14px;
      color: #40515e;
      margin: 14px 0;
    }
    .warning {
      background: #fff7ed;
      border: 1px solid #fed7aa;
      border-left: 4px solid #f97316;
      border-radius: 0 8px 8px 0;
      padding: 12px 14px;
      color: #7c2d12;
      margin: 14px 0;
    }
    ol, ul { margin: 12px 0; padding-left: 24px; }
    li { margin: 8px 0; }
    code {
      background: #eef2f6;
      border: 1px solid #d8e0e8;
      border-radius: 4px;
      padding: 1px 5px;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 12px;
    }
    .footer {
      margin-top: 32px;
      padding-top: 20px;
      border-top: 1px solid #dde5ee;
      color: #60717d;
    }
    @media (max-width: 640px) {
      body { padding: 12px; }
      .header, .content { padding-left: 20px; padding-right: 20px; }
      .metric-grid { grid-template-columns: 1fr; }
    }
  </style>
"""


class DevWebBuildReportInput(BaseModel):
    thread_id: int
    intro_note: str = Field(default="", max_length=2000)


class DevWebBuildReportTool(Tool[DevWebBuildReportInput]):
    name: ClassVar[str] = "dev_web_build_report"
    domain: ClassVar[str] = "dev_web"
    input_model: ClassVar[type[BaseModel]] = DevWebBuildReportInput
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "dev_web remediation report html mail"
    description: ClassVar[str] = (
        "dev_web_report_thread와 finding_lifecycle row를 읽어 조치요청용 subject/html/recipient를 만든다. "
        "live web I/O는 하지 않는다."
    )

    async def execute(self, vi: DevWebBuildReportInput, ctx: ToolContext) -> ToolResult:
        thread = state.dev_web_report_thread_get(vi.thread_id)
        if not thread:
            return ToolError(kind="not_found", message=f"thread_id={vi.thread_id} 없음")
        finding = _finding_row(thread.get("finding_id"))
        report_json = _json_dict(thread.get("report_json"))
        subject = remediation_mail_subject(str(thread["subject_tag"]))
        # ★ 회신 매칭 1차 키. 기존 제목 태그는 그대로 둔다(폴백이 그걸 본다).
        subject = state.stamp_subject_for_thread(subject, "dev_web", int(vi.thread_id))
        # ⚠️ 저장된 recipient 가 **우리 팀함이면 담당자가 아니다.** dev_web 은 오랫동안
        #    발송 기록에 DSSOC 를 적어 왔고(`dev_web_report_agent._report_fields`), 그 값이
        #    여기로 되먹임되면 팀함이 담당자로 굳는다. `is_dssoc` 가 그걸 가른다.
        owners = orx.recipient_list([thread.get("recipient")])
        owner_email = owners[0] if owners else ""
        targets = dev_web_report_delivery_targets(owners)
        recipient = targets["recipients"][0] if targets["recipients"] else None
        html = _html_report(thread, finding, report_json, vi.intro_note)
        return ToolSuccess(content=json.dumps({
            "kind": "dev_web_remediation_report",
            "thread_id": vi.thread_id,
            "finding_id": thread.get("finding_id"),
            "domain": thread.get("domain"),
            "url": thread.get("url"),
            "subject": subject,
            "subject_tag": thread.get("subject_tag"),
            "severity": finding.get("severity") or thread.get("severity"),
            "recipient": recipient,
            "cc": targets["cc"],
            "owner_recipient": owner_email or None,
            "delivery_policy": targets["mode"],
            "html": html,
            "remediation_actions": _actions(finding, report_json),
            # ★ 자동 최초 발송이 닫혀 있으면 `deliver_hint` 를 주지 않는다 ("제작까지만").
            #   힌트가 있으면 워커가 그걸 들고 deliver 를 시도하고, 수신처가 비어 있어
            #   sink 가 "TO 수신자가 없습니다" 로 터진다.
            **({"deliver_hint": {
                "action": "send",
                "sink_id": "knox_mail",
                "recipients": targets["recipients"],
                "cc": targets["cc"],
                "subject": subject,
                "thread_id": vi.thread_id,
                "finding_id": thread.get("finding_id"),
            }} if targets["recipients"] else {
                "send_blocked": targets.get("reason") or "자동 최초 발송이 닫혀 있다",
                "next": "초안만 남긴다. 발송하려면 콘솔에서 수동 승인하라.",
            }),
        }, ensure_ascii=False))


def _json_dict(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _finding_row(finding_id: Any) -> dict[str, Any]:
    if finding_id is None:
        return {}
    with state.connect() as c:
        row = c.execute(
            "SELECT * FROM finding_lifecycle WHERE id=?",
            (int(finding_id),),
        ).fetchone()
    return {k: row[k] for k in row.keys()} if row else {}


def _actions(finding: dict[str, Any], report_json: dict[str, Any]) -> list[str]:
    raw = report_json.get("recommended_actions")
    if isinstance(raw, list):
        actions = [str(x).strip() for x in raw if str(x).strip()]
        if actions:
            return actions
    extra = _json_dict(finding.get("extra_json"))
    raw = extra.get("recommended_actions")
    if isinstance(raw, list):
        actions = [str(x).strip() for x in raw if str(x).strip()]
        if actions:
            return actions
    return [
        "인증 없이 접근 가능한 dev/stage/test 화면과 API에 인증 및 인가 검사를 적용해 주세요.",
        "OpenAPI, Swagger, actuator, debug endpoint는 업무망과 담당자 기준으로 접근을 제한해 주세요.",
        "화면과 API 응답에 포함된 민감 필드는 마스킹하거나 권한이 있는 사용자에게만 노출되도록 수정해 주세요.",
    ]


def _html_escape(value: Any) -> str:
    import html

    return html.escape(str(value or ""), quote=True)


def remediation_mail_subject(subject_tag: str) -> str:
    # ★ 대상(호스트)은 **맨 뒤**로 — 4도메인 공용 조립기.
    from _shared.mail_subject import compose_subject

    return compose_subject(subject_tag, _MAIL_SUBJECT_SUFFIX)


def _polite_action(value: Any) -> str:
    text = str(value or "").strip()
    replacements = {
        "제한한다.": "제한해 주시기 바랍니다.",
        "차단한다.": "차단해 주시기 바랍니다.",
        "수정한다.": "수정해 주시기 바랍니다.",
        "제거한다.": "제거해 주시기 바랍니다.",
        "비공개 처리한다.": "비공개 처리해 주시기 바랍니다.",
        "적용한다.": "적용해 주시기 바랍니다.",
        "점검한다.": "점검해 주시기 바랍니다.",
        "마스킹한다.": "마스킹해 주시기 바랍니다.",
    }
    for old, new in replacements.items():
        if text.endswith(old):
            return text[: -len(old)] + new
    return text


def _finding_summary(finding: dict[str, Any], report_json: dict[str, Any]) -> str:
    return str(
        finding.get("summary")
        or report_json.get("summary")
        or "개발/검증 웹 서비스에서 접근통제 확인이 필요한 항목이 발견되었습니다."
    )


#: `risk_narrative` dict 의 **실제** 필드 — 워커가 쓰는 이름이다(라이브 실측).
#
# ⚠️ 여기가 어긋나 있었다: 예전 코드는 `summary`/`impact` 를 찾는데 워커는 아래 넷을 쓴다.
#    라이브 dev_web finding 123건 중 `risk_narrative` 보유 6건, 그중 `summary`/`impact` 로
#    값이 나오는 것 **0건** — 즉 워커가 무엇을 쓰든 "확인 안내" 가 **항상 고정 문구**로 떨어졌다.
#    옛 이름도 계속 받는다(다른 생산자가 쓰고 있을 수 있다 — 조용히 버리지 않는다).
_RISK_NARRATIVE_FIELDS = (
    "what_is_data",        # 무엇이 노출됐나
    "exploitation_path",   # 어떻게 악용될 수 있나
    "how_discovered",      # 어떻게 발견했나
    "verification_method", # 어떻게 확인했나
    "summary", "impact",   # 구 이름 — 하위호환
)


def _narrative_text(value: Any) -> str:
    """`risk_narrative` 를 사람이 읽는 문단으로. dict 면 실제 필드를 순서대로 잇는다."""
    if isinstance(value, dict):
        parts = [str(value[k]).strip() for k in _RISK_NARRATIVE_FIELDS
                 if isinstance(value.get(k), str) and str(value[k]).strip()]
        return " ".join(parts)
    return str(value or "").strip()


def _risk_text(finding: dict[str, Any], report_json: dict[str, Any]) -> str:
    extra = _json_dict(finding.get("extra_json"))
    for key in ("risk", "exploitation_path", "risk_narrative"):
        text = _narrative_text(report_json.get(key) or extra.get(key))
        if text:
            return text
    return (
        "개발 웹 서비스는 임시 endpoint, 테스트 계정, 디버그 응답, API 문서가 함께 남기 쉽습니다. "
        "의도한 사용자와 네트워크 범위 밖에서 접근 가능한 항목은 내부 정보 노출이나 권한 우회로 이어질 수 있습니다."
    )


def _how_to_html() -> str:
    return """
      <ol>
        <li>해당 URL과 동일 origin의 화면/API가 인증 없이 열리는지 확인해 주세요.</li>
        <li>개발·검증용 endpoint는 VPN, 사내망, 담당자 그룹 등 허용 범위 안에서만 접근되도록 제한해 주세요.</li>
        <li>Swagger/OpenAPI/actuator/debug/health endpoint는 공개 범위와 응답 필드를 점검해 주세요.</li>
        <li>테스트 데이터, 계정정보, 내부 시스템명, 개인/업무 정보가 응답에 포함되면 마스킹 또는 제거해 주세요.</li>
      </ol>
    """


#: 메일에 싣는 노출 표면 최대 행수. dev_web 은 finding 당 프로브가 최대 8건(실측)이라 넉넉하다.
#: 넘치면 **몇 건을 접었는지 밝힌다** — 조용한 절단은 "이게 전부" 로 읽힌다.
_SURFACE_ROW_CAP = 20
_EVIDENCE_CHARS = 140


def _probe_rows(finding: dict[str, Any], report_json: dict[str, Any]) -> list[dict[str, Any]]:
    """`extra_json.pivot.probes[]` 중 **실제로 열린 것만**.

    라이브 실측: dev_web finding 123건 중 122건이 프로브를 갖고 있고 총 432건 중 344건이
    인증 없이 응답했다. 그런데 메일은 대표 URL 하나만 보여주고 있었다 — 담당자가 무엇을
    닫아야 하는지 알 수 없다.
    """
    extra = _json_dict(finding.get("extra_json"))
    pivot = report_json.get("pivot") or extra.get("pivot") or {}
    probes = pivot.get("probes") if isinstance(pivot, dict) else None
    if not isinstance(probes, list):
        return []
    return [p for p in probes if isinstance(p, dict) and p.get("exposed")]


def _one_line(value: Any, limit: int) -> str:
    """표 칸에 넣기 전 **공백을 접는다.** 응답 본문(HTML/JSON)에는 개행이 많아서, 그대로
    넣으면 한 칸이 수십 줄로 늘어나 표가 무너진다(실측: openapi.json 응답)."""
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit] + ("…" if len(text) > limit else "")


def _surface_label(url: str, host: str) -> str:
    """같은 호스트면 경로만 — 호스트가 8줄 반복되면 정작 경로가 안 읽힌다."""
    text = str(url or "")
    if host:
        for prefix in (f"https://{host}", f"http://{host}"):
            if text.startswith(prefix):
                return text[len(prefix):] or "/"
    return text


def _surface_count_text(finding: dict[str, Any], report_json: dict[str, Any]) -> str:
    """"증거" 자리를 대신한다.

    ★ 예전엔 여기에 `evidence_ref` 가 그대로 들어갔다:
        /tmp/dev_web_e2e_evidence/20260824T092331-ede8bd-…/finding.json
      담당자가 열 수 없는 **서버 로컬 경로**다. 정보 가치는 0인데 내부 디렉터리 구조만
      알려준다. 담당자에게 쓸모 있는 건 "몇 건이 열려 있나" 다.
    """
    n = len(_probe_rows(finding, report_json))
    return f"{n}건" if n else "-"


def _response_shape(row: dict[str, Any]) -> str:
    """응답을 **본문 없이** 설명한다 — 크기와 형태만.

    ★ 왜 본문을 뺐나 (2026-08-24 실기동에서 실물 확인):
      "응답 내용(마스킹)" 열에 공정 데이터가 **평문 그대로** 실리고 있었다.

          {"prc":"KIYO-FXE_CSW_EB_V8","run":19,"down":3,"total":24,"가동률":79.0}

      `scan_hits: []` — 탐지기가 아무것도 못 잡아 마스킹도 안 됐고 열 이름만 "마스킹"
      이었다. 같은 메일이 바로 위에서 "공정 명칭·가동률·타겟 수치가 유출될 위험"
      이라고 말하면서 그 데이터를 싣고 있었다 — **조치요청 메일이 2차 노출 경로**가 된다.

    ⚠️ 마스킹을 더 세게 하는 것으로는 못 막는다. 탐지기가 모르는 형태(공정 코드,
      수량, 내부 약어)는 원리적으로 못 잡는다. 그래서 **본문을 아예 싣지 않는다** —
      SMB 조치요청 메일이 이미 그 원칙이다(service/services/sensitive_summary.py).

    담당자에게 필요한 건 "무엇이 열렸는가"(경로·응답코드·형식)이지 그 안의 값이 아니다.
    규모는 우선순위 판단에 쓰이므로 남긴다.
    """
    raw = str(row.get("evidence_masked") or "")
    if not raw:
        return "-"
    n = len(raw)
    size = f"{n:,}자" if n < 1024 else f"약 {n // 1024:,}KB"
    ctype = str(row.get("content_type") or "").lower()
    if "json" in ctype:
        # 최상위 배열이면 항목 수가 노출 규모를 가장 잘 말해 준다.
        items = raw.count("},{") + 1 if "},{" in raw else None
        if items:
            return f"JSON 레코드 약 {items:,}건 · {size}"
    return size


def _exposed_surface_html(finding: dict[str, Any], report_json: dict[str, Any],
                          host: str) -> str:
    rows = _probe_rows(finding, report_json)
    if not rows:
        return ""  # 빈 표를 그리지 않는다 — "확인했는데 없음" 과 "확인 안 함" 이 섞인다
    shown = rows[:_SURFACE_ROW_CAP]
    body = "".join(
        "<tr>"
        f"<td><code>{_html_escape(_surface_label(r.get('url'), host))}</code></td>"
        f"<td>{_html_escape(r.get('status'))}</td>"
        f"<td>{_html_escape(_one_line(r.get('content_type'), 40))}</td>"
        f"<td>{_html_escape(_response_shape(r))}</td>"
        "</tr>"
        for r in shown
    )
    more = ""
    if len(rows) > len(shown):
        more = (f'<p class="surface-more">외 {len(rows) - len(shown)}건 더 있습니다 '
                f'(총 {len(rows)}건).</p>')
    return (
        '<div class="section-title">인증 없이 열린 항목</div>'
        '<table class="surface-table">'
        "<tr><th>경로</th><th>응답</th><th>형식</th><th>응답 규모</th></tr>"
        f"{body}</table>{more}"
        '<p class="surface-more">보안상 응답 본문은 메일에 포함하지 않습니다. '
        "실제 노출 내용 확인이 필요하시면 본 메일로 문의해 주세요.</p>"
    )


# ⚠️ 회신 안내는 푸터 한 곳뿐이다. `_how_to_html()` 리스트에 같은 말을 또 넣지 마라 —
#    2026-08-24 실물에서 두 번 나왔다.
# ⚠️ 이 템플릿에 HTML 주석(`<!-- -->`)을 넣지 마라. 메일 본문에 그대로 실려 나간다.
def _dw_sensitive(finding: dict, report_json: dict) -> dict:
    """이 finding 의 탐지를 분류별로 접는다 — 4도메인 같은 어휘."""
    from service.services import sensitive_summary as ss

    extra = finding.get("extra") if isinstance(finding.get("extra"), dict) else {}
    hits = (extra or {}).get("hits") or (report_json or {}).get("hits") or []
    return ss.sensitive_counts(hits)


def _dw_exposure_metric(finding: dict, report_json: dict) -> str:
    from service.services import sensitive_summary as ss

    counts = _dw_sensitive(finding, report_json)
    n = int((report_json or {}).get("finding_count") or 0)
    return ss.exposure_metric_html(n, counts)


def _dw_credential_notice(finding: dict, report_json: dict) -> str:
    from service.services import sensitive_summary as ss

    return ss.credential_notice_html(_dw_sensitive(finding, report_json))


def _html_report(
    thread: dict[str, Any],
    finding: dict[str, Any],
    report_json: dict[str, Any],
    intro_note: str,
) -> str:
    actions = "".join(f"<li>{_html_escape(_polite_action(a))}</li>" for a in _actions(finding, report_json))
    note = f"<p>{_html_escape(intro_note)}</p>" if intro_note else ""
    severity = finding.get("severity") or thread.get("severity") or "-"
    summary = _finding_summary(finding, report_json)
    risk = _risk_text(finding, report_json)
    surface = _exposed_surface_html(finding, report_json, str(thread.get("domain") or ""))
    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  {_MAIL_STYLES}
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Dev Web 접근통제 조치 요청</h1>
      <p>삼성전자 DS 정보보호센터 · DS보안관제</p>
    </div>
    <div class="content">
      <p class="lead">DS보안관제에서 개발/검증 웹 서비스 점검 결과를 안내드립니다. 아래 URL의 접근 범위와 응답 내용을 확인해 주세요.</p>
      {note}
      <div class="info-card">
        <div class="metric-grid">
          <div class="metric"><small>대상 URL</small><strong>{_html_escape(thread.get('url'))}</strong></div>
          <div class="metric"><small>도메인</small><strong>{_html_escape(thread.get('domain'))}</strong></div>
          <div class="metric"><small>위험도</small><strong>{_html_escape(severity)}</strong></div>
          <div class="metric"><small>확인된 항목</small><strong>{_html_escape(_surface_count_text(finding, report_json))}</strong></div>
          {_dw_exposure_metric(finding, report_json)}
        </div>
      </div>
      {_dw_credential_notice(finding, report_json)}

      <div class="section-title">내용</div>
      <div class="note">{_html_escape(summary)}</div>

      <div class="section-title">확인 안내</div>
      <div class="warning">{_html_escape(risk)}</div>

      {surface}

      <div class="section-title">조치 요청 사항</div>
      <ul>{actions}</ul>

      <div class="section-title">점검 방법</div>
      {_how_to_html()}

      <div class="footer">
        <p>조치가 끝나면 본 메일에 회신해 주세요. DS보안관제에서 동일 URL 기준으로 재검증하겠습니다.</p>
        <p><strong>DS보안관제 (정보보호)</strong></p>
      </div>
    </div>
  </div>
</body>
</html>"""


# _csv 는 6곳에 같은 내용으로 복사돼 있었다 — SSOT 위임.
_csv = orx.csv


def _is_dssoc_address(value: Any) -> bool:
    """발송대상(DSSOC 계열)인가 — 담당자와 구분한다.

    목록은 `owner_recipients.NON_OWNER_LOCALPARTS` 가 소유한다. 여기에 사본을 두면
    한쪽만 늙는다 — 실제로 그랬다(62b7cb3 이 사본을 정본으로 옮기며 이 참조만 남아
    `NameError` 로 dev_web 배달이 전부 죽었다).
    """
    local = str(value or "").strip().lower().partition("@")[0]
    return local in orx.NON_OWNER_LOCALPARTS


def _dssoc_recipients() -> list[str]:
    return (
        _csv(os.environ.get("DEV_WEB_REMEDIATION_DSSOC_RECIPIENT"))
        or _csv(os.environ.get("SA_DSSOC_MAIL_RECIPIENT"))
        or ["dssoc@samsung.com"]
    )


def dev_web_report_delivery_targets(
    owner_recipients: list[str] | None = None, *, manual: bool = False,
) -> dict[str, Any]:
    """조치요청 메일 수신처 — **담당자 + DSSOC**. DSSOC 만 보내는 건 드라이런 때뿐이다.

    규칙은 `owner_recipients.delivery_targets` 가 소유한다. 4도메인 중 dev_web 만 이 래퍼가
    없어서 `thread.recipient or DSSOC[0]` 로 손수 갈랐다 — **담당자를 못 찾은 것과 정책상
    DSSOC 인 것이 같은 값으로 뭉개졌고**, Cc 는 아예 빈 채였다(팀함 사본이 안 남았다).
    """
    return orx.delivery_targets(
        owner_recipients,
        mode_env="DEV_WEB_REMEDIATION_MAIL_MODE",
        dssoc_env_names=("DEV_WEB_REMEDIATION_DSSOC_RECIPIENT", "SA_DSSOC_MAIL_RECIPIENT"),
        manual=manual,
    )


def _copy_deliver_input(vi: DeliverInput, **updates: Any) -> DeliverInput:
    data = vi.model_dump() if hasattr(vi, "model_dump") else vi.dict()
    data.update(updates)
    return DeliverInput(**data)


def _delivery_targets(owner_recipients: list[str] | None = None) -> dict[str, Any]:
    """조치요청 메일 수신처 — **담당자 + DSSOC**. DSSOC 만 보내는 건 드라이런 때뿐이다.

    규칙은 `owner_recipients.delivery_targets` 가 소유한다. 예전엔 4도메인이 같은 분기를
    각자 들고 있었고 기본값이 `dssoc_only` 였다 — 실발송이 켜져도 담당자가 빠지는 구멍이
    거기 있었다(자율발송 스위치와 수신처 스위치가 서로를 몰랐다).
    """
    return orx.delivery_targets(
        owner_recipients,
        mode_env="DEV_WEB_REMEDIATION_MAIL_MODE",
        dssoc_env_names=("DEV_WEB_REMEDIATION_DSSOC_RECIPIENT", "SA_DSSOC_MAIL_RECIPIENT"),
    )


class DevWebReportDeliverTool(DeliverTool):
    """dev_web report scoped delivery wrapper with dev-safe recipient policy."""

    async def execute(self, vi: DeliverInput, ctx: ToolContext) -> ToolResult:
        if vi.action != "send" or vi.sink_id != "knox_mail":
            return await super().execute(vi, ctx)
        # 워커가 요청한 수신자 중 **담당자로 볼 수 있는 것**만 후보로 넘긴다.
        # dssoc 계열은 발송대상이지 담당자가 아니다(중복 Cc 방지).
        requested = [r for r in list(vi.recipients) if not _is_dssoc_address(r)]
        targets = _delivery_targets(requested)
        metadata = dict(vi.metadata or {})
        metadata["dev_web_report_delivery_policy"] = targets["mode"]
        metadata["requested_recipients"] = list(vi.recipients)
        metadata["requested_cc"] = list(vi.cc)
        safe_vi = _copy_deliver_input(
            vi,
            recipients=targets["recipients"],
            cc=targets["cc"],
            metadata=metadata,
        )
        return await super().execute(safe_vi, ctx)
