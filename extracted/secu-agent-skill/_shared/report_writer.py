"""v3.63 H4: entity 단위 HTML 리포트 생성기 (담당자 메일용).

데이터(state.entity_timeline) → report-writer LLM(focused call, in-process) 가
Executive Summary·권고 서술 작성 → 결정론 HTML 스켈레톤에 주입 → 파일 저장.

- 데이터는 코드가 결정론적으로 수집(타임라인·finding) — LLM 은 서술만.
- client=None 이면 결정론 fallback 서술 (테스트/오프라인). LLM 실패도 fallback.
- HTML 은 self-contained(inline CSS) — 사내 메일에 그대로 첨부/본문 가능.
"""
from __future__ import annotations

import html as _html
import re
import time
from pathlib import Path
from typing import Any

_SUMMARY_MARK = "## SUMMARY"
_RECO_MARK = "## RECOMMENDATION"

_SEV_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3,
              "informational": 4, "clean": 5}
_SEV_COLOR = {
    "critical": "#b00020", "high": "#d84315", "medium": "#f9a825",
    "low": "#558b2f", "informational": "#607d8b", "clean": "#9e9e9e",
}


def summarize_entity(entity_type: str, entity_id: str) -> dict[str, Any]:
    """entity_timeline → 리포트용 구조화 데이터 (counts/findings/timeline).

    de-domain(v3.88): 코어 `state.entity_timeline` 는 finding 전용(등록된 timeline source 0) 이라
    share/walk/hit 활동이 전부 빠진다. 스킬 도메인 집계 `service.state_domain.domain_entity_timeline`
    (도메인 테이블 cross-join)로 라우팅해 de-domain 이전 크로스테이블 타임라인을 복원한다.
    """
    from service.state_domain import domain_entity_timeline  # noqa: PLC0415 — 지연 import
    timeline = domain_entity_timeline(entity_type, entity_id)
    findings = [e for e in timeline if e["action"].startswith("finding")]
    sev_counts: dict[str, int] = {}
    for f in findings:
        sev = (f.get("severity") or "informational")
        sev_counts[sev] = sev_counts.get(sev, 0) + 1
    sources = sorted({e["source"] for e in timeline})
    return {
        "entity_type": entity_type,
        "entity_id": entity_id,
        "event_count": len(timeline),
        "finding_count": len(findings),
        "severity_counts": sev_counts,
        "sources": sources,
        "findings": findings,
        "timeline": timeline,
    }


def _fallback_narrative(data: dict[str, Any]) -> dict[str, str]:
    fc = data["finding_count"]
    sev = data["severity_counts"]
    sev_txt = ", ".join(f"{k} {v}건" for k, v in sorted(
        sev.items(), key=lambda kv: _SEV_ORDER.get(kv[0], 9))) or "없음"
    summary = (
        f"{data['entity_type']} `{data['entity_id']}` 에 대해 총 "
        f"{data['event_count']}건의 점검 활동이 기록되었고, 확정 finding 은 "
        f"{fc}건입니다 (심각도: {sev_txt}). 출처: {', '.join(data['sources']) or '없음'}."
    )
    if fc:
        reco = (
            "확정된 finding 에 대해 자산 소유 부서와 함께 즉시 조치(자격증명 회수/"
            "권한 축소/노출 경로 차단)를 진행하고, 조치 완료 후 재점검으로 검증할 것을 "
            "권고합니다."
        )
    else:
        reco = (
            "현재 확정 finding 은 없습니다. 정기 재점검으로 변화를 모니터링할 것을 "
            "권고합니다."
        )
    return {"summary": summary, "recommendation": reco}


def _parse_narrative(text: str) -> dict[str, str] | None:
    """LLM 응답에서 ## SUMMARY / ## RECOMMENDATION 섹션 추출."""
    if not text or _SUMMARY_MARK not in text:
        return None
    body = text
    summary, reco = "", ""
    if _RECO_MARK in body:
        s_part, r_part = body.split(_RECO_MARK, 1)
        summary = s_part.split(_SUMMARY_MARK, 1)[-1].strip()
        reco = r_part.strip()
    else:
        summary = body.split(_SUMMARY_MARK, 1)[-1].strip()
    if not summary:
        return None
    return {"summary": summary, "recommendation": reco or "(권고 미작성)"}


async def render_narrative(client: Any, data: dict[str, Any]) -> dict[str, str]:
    """report-writer LLM 호출 → {summary, recommendation}. 실패/None 이면 fallback."""
    if client is None:
        return _fallback_narrative(data)
    from secu_agent.agent.llm.messages import TextBlock, UserMessage
    from secu_agent.agent.llm.types import (
        LLMRequest, StreamMessageStop, StreamTextDelta,
    )
    import json as _json

    prompt = (
        "당신은 Samsung DS SecOps 의 보안 점검 리포트 작성자입니다. 아래 엔티티의 "
        "점검 활동/finding 데이터(JSON)를 보고, 담당 부서가 읽을 한국어 리포트의 "
        "두 섹션만 작성하세요. 데이터에 없는 사실을 지어내지 마세요.\n\n"
        "출력 형식(반드시 이 마커 사용):\n"
        f"{_SUMMARY_MARK}\n<3~5문장 경영진/담당자용 요약>\n"
        f"{_RECO_MARK}\n<구체적 조치 권고 3~5개, 각 줄 '- ' 로 시작>\n\n"
        f"데이터:\n{_json.dumps(data, ensure_ascii=False, default=str)[:8000]}"
    )
    req = LLMRequest(
        messages=[UserMessage(content=[TextBlock(text=prompt)])],
        system=None, tools=None, max_tokens=1500, temperature=0.2,
    )
    try:
        chunks: list[str] = []
        async for ev in client.stream(req):
            if isinstance(ev, StreamTextDelta):
                chunks.append(ev.text)
            elif isinstance(ev, StreamMessageStop):
                break
        parsed = _parse_narrative("".join(chunks))
        return parsed or _fallback_narrative(data)
    except Exception:  # noqa: BLE001 — 서술 실패가 리포트 자체를 막으면 안 됨
        return _fallback_narrative(data)


def _esc(s: Any) -> str:
    return _html.escape(str(s if s is not None else ""))


def _reco_html(reco: str) -> str:
    lines = [ln.strip()[1:].strip() for ln in reco.splitlines()
             if ln.strip().startswith("-")]
    if lines:
        return "<ul>" + "".join(f"<li>{_esc(x)}</li>" for x in lines) + "</ul>"
    return f"<p>{_esc(reco)}</p>"


def _ts_str(ts: float | None) -> str:
    if not ts:
        return "-"
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))


def build_report_html(
    data: dict[str, Any], narrative: dict[str, str], *, generated_at: float,
    charter_ref: str = "",
) -> str:
    """결정론 HTML 스켈레톤 + LLM 서술 주입. self-contained(inline CSS)."""
    sev_badges = "".join(
        f'<span style="background:{_SEV_COLOR.get(s, "#777")};color:#fff;'
        f'padding:2px 8px;border-radius:10px;margin-right:6px;font-size:12px">'
        f'{_esc(s)} {n}</span>'
        for s, n in sorted(data["severity_counts"].items(),
                           key=lambda kv: _SEV_ORDER.get(kv[0], 9))
    ) or '<span style="color:#888">finding 없음</span>'

    finding_rows = "".join(
        f'<tr><td>{_ts_str(f["ts"])}</td>'
        f'<td><span style="color:{_SEV_COLOR.get(f.get("severity") or "informational", "#777")};'
        f'font-weight:bold">{_esc(f.get("severity") or "-")}</span></td>'
        f'<td>{_esc(f["detail"])}</td><td>{_esc(f["source"])}</td></tr>'
        for f in data["findings"]
    ) or '<tr><td colspan="4" style="color:#888">확정 finding 없음</td></tr>'

    timeline_rows = "".join(
        f'<tr><td>{_ts_str(e["ts"])}</td><td>{_esc(e["source"])}</td>'
        f'<td>{_esc(e["action"])}</td><td>{_esc(e["detail"])}</td></tr>'
        for e in data["timeline"]
    ) or '<tr><td colspan="4" style="color:#888">활동 기록 없음</td></tr>'

    return f"""<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<title>보안 점검 리포트 — {_esc(data['entity_id'])}</title></head>
<body style="font-family:'Malgun Gothic',sans-serif;max-width:880px;margin:0 auto;
padding:24px;color:#222;line-height:1.6">
<h1 style="border-bottom:3px solid #1a237e;padding-bottom:8px;color:#1a237e">
보안 점검 리포트</h1>
<table style="font-size:14px;color:#555;border:none">
<tr><td style="padding:2px 12px 2px 0"><b>대상</b></td>
<td>{_esc(data['entity_type'])} · <code>{_esc(data['entity_id'])}</code></td></tr>
<tr><td><b>생성</b></td><td>{_ts_str(generated_at)}</td></tr>
<tr><td><b>charter</b></td><td>{_esc(charter_ref) or '-'}</td></tr>
<tr><td><b>활동/finding</b></td><td>{data['event_count']}건 / {data['finding_count']}건</td></tr>
</table>
<p style="margin-top:12px">{sev_badges}</p>

<h2 style="color:#1a237e;margin-top:28px">Executive Summary</h2>
<p>{_esc(narrative.get('summary', ''))}</p>

<h2 style="color:#1a237e;margin-top:28px">확정 Findings</h2>
<table style="width:100%;border-collapse:collapse;font-size:13px">
<thead><tr style="background:#e8eaf6;text-align:left">
<th style="padding:6px">시각</th><th>심각도</th><th>내용</th><th>출처</th></tr></thead>
<tbody>{finding_rows}</tbody></table>

<h2 style="color:#1a237e;margin-top:28px">활동 타임라인</h2>
<table style="width:100%;border-collapse:collapse;font-size:13px">
<thead><tr style="background:#e8eaf6;text-align:left">
<th style="padding:6px">시각</th><th>출처</th><th>이벤트</th><th>상세</th></tr></thead>
<tbody>{timeline_rows}</tbody></table>

<h2 style="color:#1a237e;margin-top:28px">권고</h2>
{_reco_html(narrative.get('recommendation', ''))}

<hr style="margin-top:32px;border:none;border-top:1px solid #ddd">
<p style="font-size:12px;color:#999">secu-agent 자동 생성 · 인가받은 내부 점검 ·
데이터는 점검 DB 기록 기반</p>
</body></html>"""


async def generate_entity_report(
    *, client: Any, entity_type: str, entity_id: str, out_dir: Path,
    charter_ref: str = "", generated_at: float | None = None,
) -> dict[str, Any]:
    """엔티티 리포트 end-to-end: 데이터수집 → 서술 → HTML → 파일 저장.

    반환: {path, html, event_count, finding_count, severity_counts}.
    """
    data = summarize_entity(entity_type, entity_id)
    narrative = await render_narrative(client, data)
    gen_ts = generated_at if generated_at is not None else time.time()
    htmldoc = build_report_html(
        data, narrative, generated_at=gen_ts, charter_ref=charter_ref,
    )
    reports_dir = Path(out_dir) / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", entity_id)[:50] or "entity"
    stamp = time.strftime("%Y%m%dT%H%M%S", time.localtime(gen_ts))
    path = reports_dir / f"{entity_type}_{safe}_{stamp}.html"
    path.write_text(htmldoc, encoding="utf-8")
    return {
        "path": str(path),
        "html": htmldoc,
        "event_count": data["event_count"],
        "finding_count": data["finding_count"],
        "severity_counts": data["severity_counts"],
    }
