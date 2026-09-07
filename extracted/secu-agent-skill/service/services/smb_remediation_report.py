"""SMB 조치요청 HTML 리포트 빌더 (smb_domain_e2e 요구 4·5).

confirmed finding 의 DB 행 + evidence_dir 자료만 사용 — **live SMB I/O 0**(네트워크 0·
lockout 0·점검 토큰 0). `smb_reports.smb_host_report` 를 확장해 조치요청사항(보통
공유폴더 권한 변경)을 포함한 깔끔한 HTML 메일 본문을 만든다. LLM 은 문안 슬롯만 채운다.
"""
from __future__ import annotations

from html import escape

from service.services import sensitive_summary
import json
import re
from typing import Any

from service import state_domain
from service.services import smb_reports


_SEV_KO = {
    "critical": "심각", "high": "높음", "medium": "보통",
    "low": "낮음", "informational": "정보",
}
_MAIL_SUBJECT_SUFFIX = "공유폴더 접근권한 관리"
_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
_CODE_RE = re.compile(r"`([^`]+)`")

_MAIL_STYLES = """
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: #f7fafc;
      color: #2d3748;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', Arial, sans-serif;
      font-size: 14px;
      line-height: 1.7;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.08);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #1a365d 0%, #2c5282 100%);
      color: #ffffff;
      padding: 30px 40px;
    }
    .header h1 { margin: 0 0 8px 0; font-size: 22px; font-weight: 700; }
    .header p { margin: 0; opacity: 0.92; font-size: 14px; }
    .content { padding: 36px 40px 40px 40px; }
    .greeting { margin: 0 0 18px 0; color: #4a5568; }
    .lead { margin: 0 0 20px 0; }
    .info-card {
      background: linear-gradient(135deg, #ebf8ff 0%, #e6fffa 100%);
      border-left: 4px solid #3182ce;
      border-radius: 0 8px 8px 0;
      padding: 18px 22px;
      margin: 22px 0;
    }
    .warning-card {
      background: linear-gradient(135deg, #fff5f5 0%, #fffaf0 100%);
      border-left: 4px solid #c53030;
      border-radius: 0 8px 8px 0;
      color: #742a2a;
      padding: 16px 20px;
      margin: 22px 0;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px 14px;
      margin: 8px 0;
    }
    .metric {
      background: rgba(255,255,255,0.72);
      border: 1px solid #bee3f8;
      border-radius: 8px;
      padding: 10px 12px;
    }
    .metric small {
      display: block;
      color: #4a5568;
      font-size: 12px;
      margin-bottom: 3px;
    }
    .metric strong { color: #1a365d; font-size: 14px; }
    .method-card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 16px 18px;
      margin: 14px 0;
    }
    .method-card h3 {
      margin: 0 0 10px 0;
      color: #1a365d;
      font-size: 15px;
    }
    .section-title {
      margin: 28px 0 14px 0;
      padding-bottom: 8px;
      border-bottom: 2px solid #e2e8f0;
      color: #1a365d;
      font-size: 16px;
      font-weight: 700;
    }
    .section-title span { color: #3182ce; margin-right: 8px; }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 14px 0;
      font-size: 12px;
      table-layout: fixed;
    }
    th {
      background: #4a5568;
      color: #ffffff;
      padding: 8px 7px;
      text-align: left;
      font-weight: 700;
      border: 1px solid #4a5568;
      word-break: keep-all;
    }
    td {
      padding: 8px 7px;
      border: 1px solid #e2e8f0;
      background: #ffffff;
      vertical-align: top;
      word-break: break-word;
    }
    tr:nth-child(even) td { background: #f8fafc; }
    .badge {
      display: inline-block;
      border-radius: 999px;
      padding: 3px 10px;
      font-size: 12px;
      font-weight: 700;
      background: #edf2f7;
      color: #2d3748;
    }
    .badge-critical, .badge-high { background: #fed7d7; color: #9b2c2c; }
    .badge-medium { background: #feebc8; color: #9c4221; }
    .badge-low, .badge-informational { background: #c6f6d5; color: #276749; }
    ol, ul { margin: 12px 0; padding-left: 24px; }
    li { margin: 8px 0; color: #4a5568; }
    code {
      background: #edf2f7;
      border: 1px solid #d9e2ec;
      border-radius: 4px;
      padding: 1px 5px;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 12px;
    }
    figure { margin: 12px 0 18px 0; }
    figure img {
      max-width: 100%;
      border: 1px solid #cbd5e0;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    figcaption { color: #718096; font-size: 12px; margin-top: 6px; }
    .note {
      color: #718096;
      font-size: 13px;
      background: #f7fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 12px 14px;
      margin: 16px 0;
    }
    .footer {
      margin-top: 34px;
      padding-top: 22px;
      border-top: 1px solid #e2e8f0;
      color: #718096;
    }
    .footer strong { color: #2d3748; }
  </style>
"""


def _rich_text(value: Any) -> str:
    text = escape(str(value or ""))
    text = _BOLD_RE.sub(r"<strong>\1</strong>", text)
    return _CODE_RE.sub(
        r'<code style="background:#f4f6f8;border:1px solid #d9e0e5;'
        r'border-radius:4px;padding:1px 4px">\1</code>',
        text,
    )


def remediation_mail_subject(subject_tag: str) -> str:
    """Return the visible mail subject while preserving subject_tag for reply matching."""
    # ★ 대상(IP)은 **맨 뒤**로(사용자 결정 2026-09-01). 조립은 4도메인 공용이다.
    from _shared.mail_subject import compose_subject

    return compose_subject(subject_tag, _MAIL_SUBJECT_SUFFIX)


def _polite_statement(value: Any) -> str:
    text = str(value or "")
    replacements = (
        ("확인됐다.", "확인되었습니다."),
        ("확인되었다.", "확인되었습니다."),
        ("노출됐다.", "노출되었습니다."),
        ("노출되었다.", "노출되었습니다."),
        ("가능하다.", "가능합니다."),
        ("수 있다.", "수 있습니다."),
        ("있다.", "있습니다."),
        ("없다.", "없습니다."),
    )
    for old, new in replacements:
        text = text.replace(old, new)
    return text


def _polite_action(value: Any) -> str:
    text = _polite_statement(value).strip()
    action_endings = {
        "제거한다.": "제거해 주시기 바랍니다.",
        "제한한다.": "제한해 주시기 바랍니다.",
        "변경한다.": "변경해 주시기 바랍니다.",
        "교체한다.": "교체해 주시기 바랍니다.",
        "점검한다.": "점검해 주시기 바랍니다.",
        "적용한다.": "적용해 주시기 바랍니다.",
        "삭제한다.": "삭제해 주시기 바랍니다.",
        "부여한다.": "부여해 주시기 바랍니다.",
        "확인한다.": "확인해 주시기 바랍니다.",
        "재설정한다.": "재설정해 주시기 바랍니다.",
    }
    for old, new in action_endings.items():
        if text.endswith(old):
            return text[: -len(old)] + new
    return text


def _finding_brief(finding: dict[str, Any]) -> dict[str, Any]:
    extra = finding.get("extra") or {}
    rn = extra.get("risk_narrative") or {}
    actions = extra.get("recommended_actions") or finding.get("recommended_actions") or []
    return {
        "id": finding.get("id"),
        "severity": finding.get("severity"),
        "summary": finding.get("summary") or "",
        "asset": finding.get("asset") or "",
        "what_is_data": rn.get("what_is_data", ""),
        "exploitation_path": rn.get("exploitation_path", ""),
        "recommended_actions": list(actions) if isinstance(actions, list) else [],
        # ★ 메일에 실을 **분류 롤업만** 담는다. 원시 hit(kind·경로·masked 값)은 담지 않는다 —
        #   메일은 전달·회신으로 퍼지므로 그 자체가 노출 경로가 된다.
        "sensitive_counts": sensitive_summary.sensitive_counts(extra.get("hits")),
    }


def _default_remediation_actions(host_report: dict[str, Any]) -> list[str]:
    """일반 임직원용 공유 권한 조치 요약."""
    del host_report
    return [
        "공유 폴더 접근 권한이 현재 사용 목적에 맞게 설정되어 있는지 확인해 주세요.",
        "Everyone, Guest, 부서/전사 그룹 권한이 설정되어 있으면 유지가 필요한지 확인해 주세요.",
        "조치가 끝나면 본 메일에 회신해 주세요. DS보안관제에서 다시 확인하겠습니다.",
    ]


def _employee_summary(exposure_line: str) -> str:
    if exposure_line:
        prefix = (
            "점검 결과, 대상 PC 또는 서버의 공유 폴더 접근 범위 확인이 필요합니다. "
            f"현재 확인된 항목은 {exposure_line}입니다."
        )
    else:
        prefix = (
            "점검 결과, 대상 PC 또는 서버의 공유 폴더 권한 확인이 필요합니다."
        )
    return (
        f"{prefix} 공유 폴더에는 문서, 설정 파일, 로그, 임시 파일, 휴지통에 남아 있는 파일이 "
        "함께 포함될 수 있습니다. 권한을 확인하지 않으면 예상한 공유 대상 밖에서도 파일 이름이나 "
        "내용을 볼 수 있으므로, 공유 목적에 맞는 계정 또는 그룹만 남겨 주세요."
    )


def _employee_risk_text() -> str:
    return (
        "공유 폴더는 권한 설정에 따라 여러 사용자가 접근할 수 있습니다. "
        "현재 설정이 의도한 공유 범위와 일치하는지 확인해 주시고, 필요 시 접근 대상을 조정해 주시기 바랍니다."
    )


def _permission_how_to_html() -> str:
    return """
      <div class="method-card">
        <h3>Windows 공유 폴더인 경우</h3>
        <ol>
          <li>공유 중인 폴더를 우클릭한 뒤 <b>속성</b>을 선택해 주세요.</li>
          <li><b>공유</b> 탭에서 <b>고급 공유</b> → <b>권한</b>으로 이동해 주세요.</li>
          <li><b>Everyone</b>, <b>Guest</b>, 부서/전사 그룹 권한이 설정되어 있으면 유지가 필요한지 확인해 주세요.</li>
          <li>공유 목적에 맞는 계정 또는 그룹만 남겨 주세요.</li>
          <li><b>보안</b> 탭의 NTFS 권한도 동일하게 확인해 주세요.</li>
        </ol>
      </div>
      <div class="method-card">
        <h3>Linux/Samba 공유 폴더인 경우</h3>
        <ol>
          <li>공유 설정 파일에서 해당 공유 항목을 확인해 주세요.</li>
          <li><code>guest ok = no</code>로 설정되어 있는지 확인해 주세요.</li>
          <li><code>valid users</code>에 공유 목적에 맞는 계정 또는 그룹만 지정해 주세요.</li>
          <li>폴더 자체 권한(<code>chmod</code>, <code>chown</code>)도 필요한 사용자 기준으로 제한해 주세요.</li>
          <li>설정 변경 후 서비스 재시작이 필요한 환경이면 담당 운영 절차에 따라 반영해 주세요.</li>
        </ol>
      </div>
    """


def _share_access_labels(share: dict[str, Any]) -> list[str]:
    access = share.get("access") or {}
    principals = access.get("principals") or {}
    read = [str(x).upper() for x in principals.get("read") or []]
    labels: list[str] = []
    if "NULL" in read:
        labels.append("NULL 읽기")
    if "GUEST" in read:
        labels.append("Guest 읽기")
    if (access.get("scope") or {}).get("auth_broad_readable"):
        labels.append("AUTH 읽기")
    if (access.get("share") or {}).get("write") or principals.get("write"):
        labels.append("쓰기 가능")
    return labels


def _share_access_table_html(host: str, host_report: dict[str, Any]) -> str:
    rows = []
    for share in host_report.get("shares") or []:
        labels = _share_access_labels(share)
        if not labels:
            continue
        counts = share.get("counts") or {}
        path = f"\\\\{host}\\{share.get('share') or ''}"
        rows.append(
            "<tr>"
            f"<td>{escape(path)}</td>"
            f"<td>{escape(', '.join(labels))}</td>"
            f"<td>{int(counts.get('files_total') or 0):,}개</td>"
            "<td>표시된 접근 권한 제거 또는 공유 목적에 맞는 계정/그룹으로 제한</td>"
            "</tr>"
        )
    if not rows:
        return '<div class="note">현재 리포트 대상 공유 폴더의 권한 세부 목록을 확인하지 못했습니다.</div>'
    if len(rows) > 30:
        extra = len(rows) - 30
        rows = rows[:30]
        rows.append(
            "<tr><td colspan=\"4\">"
            f"추가 {extra:,}개 공유 폴더는 대시보드 Report 상세에서 확인해 주세요."
            "</td></tr>"
        )
    return (
        "<table>"
        "<thead><tr><th>공유 폴더</th><th>확인된 접근 권한</th><th>수집 파일 수</th><th>조치 방향</th></tr></thead>"
        "<tbody>"
        + "".join(rows)
        + "</tbody></table>"
    )


def build_remediation_report(
    *, finding_id: int, host: str | None = None,
    screenshots: list[dict[str, Any]] | None = None,
    intro_note: str = "",
) -> dict[str, Any]:
    """finding_id → 조치요청 HTML 리포트 dict.

    반환: {finding_id, host, ip, severity, subject_tag, html, plain_summary,
           remediation_actions, screenshots}. live I/O 없음(DB+evidence 만).
    """
    from secu_agent import state as core_state
    finding = core_state.finding_get(finding_id)
    if finding is None:
        raise ValueError(f"finding {finding_id} 없음")

    brief = _finding_brief(finding)
    asset = brief["asset"]
    resolved_host = host or _host_from_asset(asset)
    from domains.smb.plugin.tools.smb_submit_finding_tool import normalize_subject_tag
    subject_tag = normalize_subject_tag(resolved_host)

    # IP 집계: 그 host 의 열린 스레드에서 finding 전부 + 미조치 중복(재발) 횟수.
    threads = state_domain.mail_thread_find_by_subject_tag(subject_tag)
    thread = threads[0] if threads else None
    recurrence = 0

    try:
        host_report = smb_reports.smb_host_report(resolved_host, findings_only=True)
    except Exception:  # noqa: BLE001 — 리포트 조회 실패해도 finding 기반 본문은 만든다
        host_report = {"summary": {"totals": {}}, "shares": []}

    def _thread_finding_ids(row: dict[str, Any]) -> list[int]:
        out: list[int] = []
        try:
            values = json.loads(row.get("finding_ids") or "[]")
        except Exception:
            values = []
        if isinstance(values, list):
            for value in values:
                try:
                    out.append(int(value))
                except (TypeError, ValueError):
                    pass
        try:
            representative = int(row.get("finding_id"))
        except (TypeError, ValueError):
            representative = None
        if representative is not None and representative not in out:
            out.append(representative)
        return out

    def _thread_cycle_keys(row: dict[str, Any]) -> list[str]:
        try:
            keys = [str(x) for x in json.loads(row.get("cycle_keys") or "[]") if str(x)]
        except Exception:
            keys = []
        if not keys:
            keys = [str(row.get(k)) for k in ("first_cycle_key", "last_cycle_key") if row.get(k)]
        return keys

    relevant_threads = [t for t in threads if finding_id in _thread_finding_ids(t)]
    if not relevant_threads and thread:
        relevant_threads = [thread]

    cycle_keys: list[str] = []
    for t in relevant_threads:
        try:
            recurrence = max(recurrence, int(t.get("recurrence_count") or 0))
        except Exception:
            pass
        cycle_keys.extend(_thread_cycle_keys(t))

    cycle_count = max(1, len(set(cycle_keys)), recurrence + 1)
    finding_ids = _thread_finding_ids(thread) if thread else []
    if finding_id not in finding_ids:
        merged_ids: list[int] = []
        for t in relevant_threads:
            for fid in _thread_finding_ids(t):
                if fid not in merged_ids:
                    merged_ids.append(fid)
        finding_ids = merged_ids
    if not finding_ids:
        finding_ids = [finding_id]

    # 그 IP 의 모든 finding 을 한 리포트에 뭉쳐 표기(요구: IP 기준 집계).
    all_findings = []
    for fid in finding_ids:
        fr = core_state.finding_get(fid)
        if fr:
            all_findings.append(_finding_brief(fr))

    actions = _default_remediation_actions(host_report)
    shots = screenshots if screenshots is not None else [
        dict(s) for s in state_domain.screenshots_for_finding(finding_id, limit=3)
    ]
    owner = state_domain.asset_owner_get(resolved_host) or {}

    html = _render_html(
        host=resolved_host, brief=brief, actions=actions,
        host_report=host_report, owner=owner, shots=shots, intro_note=intro_note,
        recurrence=recurrence, cycle_count=cycle_count, all_findings=all_findings,
        sent_notice_count=(
            state_domain.thread_sent_notice_count("smb", int(thread["id"])) if thread else 0
        ),
    )
    return {
        "finding_id": finding_id,
        "finding_ids": finding_ids,
        "host": resolved_host,
        "ip": resolved_host,
        "severity": brief["severity"],
        "recurrence_count": recurrence,
        "cycle_count": cycle_count,
        "subject": remediation_mail_subject(subject_tag),
        "subject_tag": subject_tag,
        "html": html,
        "plain_summary": brief["summary"],
        "remediation_actions": actions,
        "screenshots": shots,
        "owner": owner,
    }


def _host_from_asset(asset: str) -> str:
    raw = str(asset or "").strip()
    if raw.lower().startswith("file:smb://"):
        raw = raw[5:]
    if raw.lower().startswith("smb://"):
        raw = raw[len("smb://"):]
    raw = raw.replace("\\", "/").lstrip("/")
    return raw.split("/", 1)[0]


def _shot_url(rel_path: str) -> str:
    import os
    base = os.environ.get("SA_SMB_WEB_PUBLIC_URL", "").rstrip("/")
    from urllib.parse import quote
    if base:
        return f"{base}/api/pipeline/screenshot?path={quote(rel_path)}"
    return ""  # 폴백은 호출부(메일)가 data-uri 처리


def _render_html(
    *, host: str, brief: dict[str, Any], actions: list[str],
    host_report: dict[str, Any], owner: dict[str, Any],
    shots: list[dict[str, Any]], intro_note: str,
    recurrence: int = 0, cycle_count: int = 1,
    #: 이 스레드로 **실제로 나간** 안내 수. 재확인 문구의 유일한 근거다.
    sent_notice_count: int = 0,
    all_findings: list[dict[str, Any]] | None = None,
) -> str:
    del brief
    owner_name = escape(str(owner.get("user_name") or owner.get("user_id") or "담당자"))
    dept = escape(str(owner.get("user_dept") or "-"))
    totals = host_report.get("summary", {}) if host_report else {}

    del shots
    # ★ 예전에는 all_findings 를 계산해 놓고 그대로 버렸다(`del all_findings`). 의도는
    #   "경로·값을 메일에 싣지 않는다" 였는데, 그 결과 담당자는 "공유가 열렸다" 만 알고
    #   **그 안에 개인키가 있다는 사실을 몰랐다.** 분류와 건수만 접어 싣는다 —
    #   우선순위를 정할 만큼만 알려주고 상세는 DS보안관제 문의로 돌린다.
    sensitive_counts = sensitive_summary.merge_counts(
        *[(item.get("sensitive_counts") or {}) for item in (all_findings or [])])
    # ★ finding 자체의 hits 만으로는 늘 0 이다 — 공유 노출 finding 은 "이 공유가 열려
    #   있다" 는 사실만 담고 파일 탐지를 담지 않는다. 실제 탐지는 `smb_file_hit` 에
    #   파일 단위로 있다(2026-08-31 실측: 70개 공유에 존재, 그중 개인키 9건짜리도).
    from service.services import smb_exposure_summary as _exp

    _share_ids = [int(x["id"]) for x in (host_report.get("shares") or [])
                  if isinstance(x, dict) and x.get("id")]
    sensitive_counts = sensitive_summary.merge_counts(
        sensitive_counts, _exp.share_sensitive_counts(_share_ids))
    exposure_metric = sensitive_summary.exposure_metric_html(
        _exp.exposed_item_count(_share_ids), sensitive_counts)
    credential_notice = sensitive_summary.credential_notice_html(sensitive_counts)
    sensitive_html = sensitive_summary.summary_html(sensitive_counts, container_word="공유 폴더")
    sensitive_actions_html = sensitive_summary.actions_html(sensitive_counts)
    action_items = "".join(f"<li>{_rich_text(_polite_action(a))}</li>" for a in actions)

    # ★ 재확인 경고는 **실제로 안내한 뒤에만** 나간다. 예전엔 스캔 주차(`cycle_count`)로
    #   판단해서, 첫 발송인데도 "2주 누적 확인 / 이전에 안내드린…" 이 나갔다
    #   (2026-08-31 실측). 우리가 본 것과 담당자가 들은 것은 다르다.
    #   4도메인이 같은 함수를 쓴다 — `report_cycles.notice_recurrence_label`.
    from domains.services.application.report_cycles import (
        notice_recurrence_label,
        should_show_recurrence,
    )

    recur_html = ""
    if should_show_recurrence(sent_notice_count):
        recur_html = (
            f'<div class="warning-card">'
            f'<strong>{escape(notice_recurrence_label(sent_notice_count))}</strong><br>'
            f'이전에 안내드린 공유 폴더 권한 항목이 이번 주 점검에서도 다시 확인되었습니다. '
            f'권한 설정을 한 번 더 점검해 주시기 바랍니다.</div>'
        )

    exposure_bits = []
    if totals.get("public_exposure_total"):
        exposure_bits.append(f"익명/Guest 열람 공유 {totals['public_exposure_total']}건")
    if totals.get("auth_broad_exposure_total"):
        exposure_bits.append(f"부서/전사 열람 공유 {totals['auth_broad_exposure_total']}건")
    if totals.get("writable_share_total"):
        exposure_bits.append(f"쓰기 가능 공유 {totals['writable_share_total']}건")
    exposure_line = ", ".join(exposure_bits)
    exposure_display = escape(exposure_line) if exposure_line else "공유 폴더 권한 확인 필요"
    intro = f"<p>{escape(intro_note)}</p>" if intro_note else ""
    summary_text = _employee_summary(exposure_line)
    risk_text = _employee_risk_text()
    share_access_table = _share_access_table_html(host, host_report)

    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  {_MAIL_STYLES}
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>SMB 공유 폴더 조치 요청</h1>
      <p>삼성전자 DS 정보보호센터 · DS보안관제</p>
    </div>
    <div class="content">
      <p class="greeting">{owner_name}님,</p>
      <p class="lead">DS보안관제에서 공유 폴더 권한 점검 결과를 안내드립니다. 대상 PC 또는 서버에서 공유 폴더 권한 확인이 필요합니다.</p>
      {intro}
{recur_html}

      <div class="info-card">
        <div class="metric-grid">
          <div class="metric"><small>대상 PC/서버 IP</small><strong>{escape(host)}</strong></div>
          <div class="metric"><small>확인 내용</small><strong>{exposure_display}</strong></div>
          <div class="metric"><small>요청 사항</small><strong>공유 폴더 접근 권한 제한</strong></div>
          <div class="metric"><small>IP 담당자</small><strong>{owner_name} / {dept}</strong></div>
          {exposure_metric}
        </div>
      </div>
      {credential_notice}

      <div class="section-title"><span>■</span>내용</div>
      <div class="note">{escape(summary_text)}</div>

      <div class="section-title"><span>■</span>확인 안내</div>
      <div class="note">{escape(risk_text)}</div>

      <div class="section-title"><span>■</span>확인된 공유 폴더</div>
      <p>아래 공유 폴더에서 표시된 접근 권한을 확인해 주세요.</p>
      {share_access_table}

      {sensitive_html}

      {sensitive_actions_html}

      <div class="section-title"><span>■</span>권한 설정 확인 방법</div>
      <p>아래 방법 중 사용 중인 OS에 맞는 절차로 공유 폴더 권한을 확인해 주세요.</p>
      <ol>{action_items}</ol>
      {_permission_how_to_html()}
      <div class="note">조치 완료 후 본 메일에 회신해 주시면 DS보안관제에서 재확인하겠습니다. 확인이 어렵거나 조치 방법이 필요하시면 본 메일로 문의해 주시기 바랍니다.</div>

      <div class="footer">
        <p>감사합니다.</p>
        <p><strong>DS보안관제 (정보보호)</strong></p>
      </div>
    </div>
  </div>
</body>
</html>"""
