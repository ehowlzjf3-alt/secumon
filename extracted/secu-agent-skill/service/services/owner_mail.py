"""Owner notification mail service — SMB draft builder (도메인 서비스 소유).

v3.82 U3a: Knox Mail MCP 전송부는 엔진 `secu_agent.knox.owner_mail` 로 이동
(코어 소유, 도메인 무관) — 여기서 import 해 그대로 사용한다. 이 파일은 SMB
asset 파싱 + asset_owner 조회(service.state_domain) + DSSOC SMB 한국어 draft
builder 만 소유한다 (U3d: 도메인 서비스 routes/findings_domain.py 가 소비).
"""
from __future__ import annotations

from html import escape
from typing import Any
from urllib.parse import unquote, urlparse

from secu_agent.knox.owner_mail import (  # noqa: F401 — 전송부는 엔진 코어 소유
    OwnerMailError,
    _sender,
    call_knox_mail_tool,
    send_owner_mail,
)

from service.state_domain import asset_owner_get


def _smb_asset_host(asset: str) -> str:
    raw = str(asset or "").strip()
    if not raw:
        raise OwnerMailError("asset is required")
    if raw.lower().startswith("file:smb://"):
        raw = raw[5:]
    if raw.lower().startswith("smb://"):
        parsed = urlparse(raw)
        host = parsed.hostname or parsed.netloc.split("@")[-1].split(":", 1)[0]
        if host:
            return host
    if raw.startswith("\\\\") or raw.startswith("//"):
        norm = raw.replace("\\", "/").lstrip("/")
        parts = [unquote(p) for p in norm.split("/") if p]
        if parts:
            return parts[0]
    raise OwnerMailError(f"SMB asset host를 파싱할 수 없음: {asset!r}")


def _owner_for_asset(asset: str) -> dict[str, Any]:
    host = _smb_asset_host(asset)
    owner = asset_owner_get(host)
    if owner is None:
        raise OwnerMailError(f"{host} 담당자 정보가 없습니다. smb_owner_lookup 실행이 필요합니다.")
    if not str(owner.get("email") or "").strip():
        raise OwnerMailError(f"{host} 담당자 메일 주소가 없습니다.")
    return owner


def build_smb_owner_mail_draft(
    *,
    asset: str,
    summary: str = "",
    severity: str | None = None,
    status: str | None = None,
    finding_id: str | None = None,
) -> dict[str, Any]:
    owner = _owner_for_asset(asset)
    severity_text = str(severity or "").upper()
    subject = f"[DS보안관제][SMB] 공유 폴더 점검 결과 확인 요청"
    if severity_text:
        subject = f"[DS보안관제][SMB][{severity_text}] 공유 폴더 점검 결과 확인 요청"
    owner_name = owner.get("user_name") or owner.get("user_id") or "담당자"
    safe_asset = escape(asset)
    safe_owner_name = escape(str(owner_name))
    safe_dept = escape(str(owner.get("user_dept") or "-"))
    safe_status = escape(str(status or "-"))
    safe_severity = escape(str(severity or "-"))
    safe_summary = escape(str(summary or "-"))
    lines = [
        f"{safe_owner_name}님,",
        "",
        "DS보안관제 SMB 공유 폴더 점검 중 아래 항목에 대한 확인이 필요하여 메일드립니다.",
        "",
        "<ul>",
        f"<li><b>대상</b>: {safe_asset}</li>",
        f"<li><b>담당자</b>: {safe_owner_name}</li>",
        f"<li><b>부서</b>: {safe_dept}</li>",
        f"<li><b>상태</b>: {safe_status}</li>",
        f"<li><b>심각도</b>: {safe_severity}</li>",
        f"<li><b>요약</b>: {safe_summary}</li>",
    ]
    if finding_id:
        lines.append(f"<li><b>Finding ID</b>: {escape(str(finding_id))}</li>")
    lines.extend([
        "</ul>",
        "",
        "<p><b>요청 사항</b></p>",
        "<ol>",
        "<li>해당 공유 폴더와 파일의 업무 필요 여부를 확인해 주세요.</li>",
        "<li>필요 인원/그룹 외 접근 권한은 제거해 주세요.</li>",
        "<li>민감 문서 또는 계정정보가 포함된 파일은 삭제, 격리, 또는 권한 재설정을 진행해 주세요.</li>",
        "</ol>",
        "",
        "<p>감사합니다.<br>DS보안관제</p>",
    ])
    return {
        "asset": asset,
        "sender": _sender(),
        "recipients": [owner["email"]],
        "cc": [],
        "bcc": [],
        "subject": subject,
        "content": "\n".join(lines),
        "content_type": "HTML",
        "doc_secu_type": "OFFICIAL",
        "asset_owner": owner,
    }
