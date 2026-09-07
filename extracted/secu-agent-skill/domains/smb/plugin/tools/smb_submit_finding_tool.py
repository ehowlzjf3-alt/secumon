"""smb_submit_finding — SMB E2E 파이프라인이 상속/소유하는 finding 제출 도구.

사용자 결정: SMB 는 generic `submit_finding` 을 그대로 쓰지 않고, 엔진
`SubmitFindingTool`(domain="core", judge_task_finding→canonical_task_type→
finding_upsert)을 **서브클래스/래핑**해 상속한다. 한 호출에서:

  (1) 부모 generic 경로 위임 — 증거 게이트 + finding_lifecycle upsert(cross-domain
      dedup/identity) + finding.json 작성 + pivot/signal. (엔진 무수정.)
  (2) SMB 도메인 영속 — 대표 host/share row 에 severity/hit 힌트 기록.
  (3) E2E 상태머신 전이 — finding 제출 = `mail_thread`(draft) row 적재.
      host worker 가 전체 share 판정을 완료하면 draft 를 reported 로 승격해 #2 큐에 진입.
  (4) 스크린샷 artifact 연결 — 점검 중 evidence_dir 에 남긴 PNG 를 screenshot row 로.

엔진 무수정: 상속/래핑은 skill repo 측이고, smb_task skill 이 unlock 하는 도구는
generic submit_finding 이 아니라 이 smb_submit_finding 이다.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import time
from pathlib import Path
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.schema.finding import TaskFinding
from secu_agent.agent.tools.base import ToolContext, ToolError, ToolResult, ToolSuccess
from secu_agent.agent.tools.submit_finding import SubmitFindingTool, _asset_kind_from_location
from secu_agent.finding_taxonomy import canonical_task_type

from service import state_domain as state

log = logging.getLogger("domains.smb.submit_finding")


def normalize_subject_tag(ip: str) -> str:
    """조치요청 메일 제목 correlation 키 — `[보안취약점 조치요청](IP)`.

    POP3 답장(RE:/FW:)에서 이 정규화 키로 스레드를 매칭한다(요구 7·8).
    """
    return f"[보안취약점 조치요청]({str(ip or '').strip()})"


_IPV4_RE = re.compile(r"(?:\d{1,3}\.){3}\d{1,3}")


def _path_from_asset(asset: str) -> str:
    """SMB asset → share-root 기준 path (host/share 이후)."""
    raw = str(asset or "").strip()
    if raw.lower().startswith("file:smb://"):
        raw = raw[5:]
    if raw.lower().startswith("smb://"):
        raw = raw[len("smb://"):]
    raw = raw.replace("\\", "/").lstrip("/")
    # host/share/path... — 앞 2개 제거. 뒤에 ':<line>' 이 붙는 표기 지원.
    parts = raw.split("/", 2)
    if len(parts) < 3:
        return ""
    tail = parts[2]
    return re.sub(r":\d+$", "", tail)


_LINE_SUFFIX_RE = re.compile(r":(\d+)$")
# 결정론적 문구 — 리포트/메일 renderer 가 validation 을 렌더하지 않으므로(codex#8),
# 사람이 보는 summary 에 확인 사실을 남긴다.
_CONFIRM_MARK = "[검증] 노출된 계정으로 로그인 성공(단발 시도) — 악용 가능 확인."


def _line_from_asset(asset: str) -> int | None:
    m = _LINE_SUFFIX_RE.search(str(asset or "").strip())
    return int(m.group(1)) if m else None


def _resolve_file_id(host: str, share: str, path: str) -> int | None:
    """(host, share, path) → smb_file.id. share 를 모르면 (host, path) 로 **유일할 때만** 해석.

    라이브에서 드러난 문제: 워커 LLM 은 `hit.location` 에 `//host/share/path` 가 아니라
    share-상대 경로(`MDbS/dbLink.bas`)를 쓰는 일이 잦다. 그러면 host/share 가 비어 검증
    귀속이 통째로 skip 되고, DB 에 authenticated 증거가 있는데도 화면에 아무것도 안 뜬다.
    워커 컨텍스트의 host 를 받아 (host, path) 로 되짚되, **후보가 2건 이상이면 보류**한다
    (모호할 때 귀속하지 않는다는 기존 원칙 유지 — 오귀속이 미표시보다 나쁘다)."""
    if not (host and path):
        return None
    from domains.smb.plugin.tools.smb_tools import _find_file_id
    if share:
        return _find_file_id(host, share, path)
    with state.connect() as c:
        rows = c.execute(
            "SELECT f.id FROM smb_file f JOIN smb_share s ON s.id=f.share_id "
            "WHERE s.host=? AND f.path=? ORDER BY f.id DESC LIMIT 2",
            (host, path),
        ).fetchall()
    return int(rows[0]["id"]) if len(rows) == 1 else None


def _login_validation_for(host: str, share: str, path: str,
                          line_no: int | None, hit_kind: str,
                          hit_category: str, hit_masked: str = "") -> dict[str, Any] | None:
    """이 hit 에 **정확히 귀속되는** 로그인 검증(authenticated)만 반환.

    파일 단위로 아무 검증이나 끌어오면 같은 파일의 다른 크리덴셜/다른 hit 이 잘못
    critical 로 올라간다(codex#3). 라인·kind·category 를 모두 대조한다.
    승격 조건도 `result == "authenticated"` 로 닫는다 — credential_expired/
    session_denied 는 proves_validity 이지만 "악용 가능"으로 말하면 과장(codex severity).
    """
    if not (host and path):
        return None
    try:
        fid = _resolve_file_id(host, share, path)
        if fid is None:
            return None
        cands = [
            v for v in state.file_hit_validations(fid)
            if v.get("result") == "authenticated" and v.get("proves_validity") is True
        ]
        if not cands:
            return None
        if line_no is not None:
            cands = [v for v in cands if int(v.get("_line_no") or -1) == int(line_no)]
            return cands[0] if cands else None
        # 라인 미상(라이브 관측: hit location 의 95%가 `:NN` 없음)일 때의 귀속.
        # ① **내용 결속 우선**: detector 가 만든 masked 값이 정확히 같으면 같은 증거다. kind/category
        #    는 LLM 이 지어낸 문자열이라(라이브에서 36%가 detector 어휘 밖) 대조 기준으로 약하다.
        by_masked = [v for v in cands if hit_masked and str(v.get("_hit_masked") or "") == str(hit_masked)]
        if len(by_masked) == 1:
            return by_masked[0]
        if len(by_masked) > 1:
            return None  # 같은 파일에 동일 masked 가 여러 줄 → 어느 줄인지 모호 → 보류
        # 양쪽 다 masked 를 갖고 있는데 **일치하는 게 없으면 다른 크리덴셜**이다. 폴백하면 같은
        # 파일의 다른 크리덴셜 hit 에 로그인 성공을 붙이는 오귀속이 된다.
        if hit_masked and any(v.get("_hit_masked") for v in cands):
            return None
        # ② 폴백(hit 이 masked 를 안 줬을 때만): 같은 kind/category 의 검증이 **유일할 때만** 귀속.
        cands = [v for v in cands
                 if str(v.get("_hit_kind") or "") == str(hit_kind or "")
                 and str(v.get("_hit_category") or "") == str(hit_category or "")]
        return cands[0] if len(cands) == 1 else None
    except Exception:  # noqa: BLE001 — 조회 실패는 finding 제출을 막지 않는다.
        return None


def _path_fallback(loc: str) -> str:
    """location 이 //host/share/path 형태가 아닐 때의 share-상대 경로 해석(`:line` 접미 제거)."""
    raw = str(loc or "").strip().replace("\\", "/").lstrip("/")
    if raw.lower().startswith("file:smb://"):
        raw = raw[5:]
    if raw.lower().startswith("smb://"):
        raw = raw[len("smb://"):]
    return re.sub(r":\d+$", "", raw.lstrip("/"))


def _smb_location_parts(loc: str, ctx_host: str) -> tuple[str, str, str, int | None]:
    """hit.location → (host, share, path, line).

    SMB asset 은 `smb://<IP>/<share>/<path>` 형태다. 첫 세그먼트가 **리터럴 IP 일 때만**
    host/share 로 해석한다 — 그렇지 않으면 `MDbS/dbLink.bas` 같은 share-상대 경로에서
    `_host_from_asset` 이 `MDbS` 를 host 로, `_share_from_asset` 이 `dbLink.bas` 를 share 로
    읽어 조회가 조용히 실패한다(라이브에서 실제로 그렇게 실패했다). 그 경우엔 워커 컨텍스트의
    host 와 상대경로로 되짚는다."""
    line = _line_from_asset(loc)
    first = _host_from_asset(loc)
    if _IPV4_RE.fullmatch(first or ""):
        return first, _share_from_asset(loc), _path_from_asset(loc), line
    return str(ctx_host or ""), "", _path_fallback(loc), line


def _strip_caller_login_claims(validation: Any, _depth: int = 0) -> Any:
    """호출자(워커 LLM)가 스스로 써넣은 **로그인 성공 주장**을 제거한다.

    `hit.validation` 은 자유 dict 라서, 프로브를 한 번도 돌리지 않은 워커가
    `login_probe:{result:"authenticated", endpoint_host:"payroll-db..."}` 를 그냥 써넣을 수 있고
    그대로 DB→화면까지 흘러 "악용 가능 확인" 배지로 렌더된다(codex 적대검증에서 실증).
    로그인 성공은 **중앙 원장에 기록된 실제 프로브 결과**만 근거가 될 수 있으므로, 제출 경계에서
    호출자 주장을 먼저 지우고 그 다음 DB 에서 읽은 증거만 다시 주입한다.
    (reachability 같은 나머지 자유 서술은 보존 — 로그인 주장만 제거한다.)"""
    if _depth > 4 or not isinstance(validation, dict):
        return validation
    if validation.get("kind") == "credential_login_probe":
        return None  # dict 자체가 평면 로그인 주장 → 통째 제거
    out = {k: v for k, v in validation.items() if k != "login_probe"}
    if out.get("kind") == "multi" and isinstance(out.get("probes"), list):
        out["probes"] = [
            p for p in (_strip_caller_login_claims(x, _depth + 1) for x in out["probes"][:32])
            if p is not None and not (isinstance(p, dict) and "login_probe" in p)
        ]
    return out or None


def _augment_with_login_validation(f: TaskFinding, ctx_host: str = "") -> TaskFinding:
    """hit 에 로그인검증(authenticated) 근거를 붙이고 severity 를 결정론적으로 승격.

    LLM 이 `hit.validation` 에 인용하지 않아도 DB 에 영속된 사실이 반영되게 한다(#2).
    **judge 계약 보존**: evidence judge 는 top-level `kind=="credential_reachability"`
    만 인정하므로(codex#1) 그 계약을 유지한 채 `login_probe` 로 중첩한다.
    검증이 없으면 원본 그대로 — 부작용 없음.
    """
    try:
        hits = list(getattr(f, "hits", None) or [])
        if not hits:
            return f
        # 1단계: 호출자가 써넣은 로그인 성공 주장을 **전부** 제거(위조 차단).
        for h in hits:
            existing = getattr(h, "validation", None)
            if isinstance(existing, dict):
                h.validation = _strip_caller_login_claims(existing)
        # 2단계: DB(중앙 프로브 결과)에서 읽은 증거만 다시 주입.
        confirmed = False
        for h in hits:
            loc = str(getattr(h, "location", "") or "")
            host, share, path, line = _smb_location_parts(loc, ctx_host)
            if line is None:
                line = getattr(h, "line_no", None)   # location 에 `:NN` 이 없으면 hit 필드 사용
            v = _login_validation_for(
                host, share, path,
                int(line) if isinstance(line, int) and not isinstance(line, bool) else None,
                getattr(h, "kind", "") or "", getattr(h, "category", "") or "",
                str(getattr(h, "masked", "") or ""),
            )
            if not v:
                continue
            confirmed = True
            proof = {k: val for k, val in v.items() if not k.startswith("_")}
            existing = getattr(h, "validation", None)
            merged = dict(existing) if isinstance(existing, dict) else {}
            # **judge 계약 강제**: evidence judge 는 top-level kind=="credential_reachability"
            # 만 probe 검증으로 인정한다. LLM 이 제 나름의 validation dict(kind 없음)를 써두면
            # 병합만 해서는 계약이 깨져 finding 이 거절된다 — 라이브에서 실제로 그렇게 거절됐다.
            merged["kind"] = "credential_reachability"
            merged.setdefault("attempted", True)
            merged.setdefault("probe", "credential_login_probe")
            merged["login_probe"] = proof
            h.validation = merged
        if not confirmed:
            return f
        if str(getattr(f, "severity", "")) != "critical":
            f.severity = "critical"
        summary = str(getattr(f, "summary", "") or "")
        if _CONFIRM_MARK not in summary:
            f.summary = (summary.rstrip() + " " + _CONFIRM_MARK).strip()
        return f
    except Exception:  # noqa: BLE001 — 승격 실패가 제출을 막지 않는다.
        return f


def _host_from_asset(asset: str) -> str:
    """SMB asset(smb://host/share/path | //host/... | host/...) → host."""
    raw = str(asset or "").strip()
    if not raw:
        return ""
    if raw.lower().startswith("file:smb://"):
        raw = raw[5:]
    if raw.lower().startswith("smb://"):
        raw = raw[len("smb://"):]
    raw = raw.replace("\\", "/").lstrip("/")
    first = raw.split("/", 1)[0]
    return first


def _share_from_asset(asset: str) -> str:
    raw = str(asset or "").strip()
    if not raw:
        return ""
    if raw.lower().startswith("file:smb://"):
        raw = raw[5:]
    if raw.lower().startswith("smb://"):
        raw = raw[len("smb://"):]
    raw = raw.replace("\\", "/").lstrip("/")
    parts = raw.split("/", 2)
    return parts[1] if len(parts) >= 2 else ""


class SmbSubmitFindingInput(BaseModel):
    finding: TaskFinding
    screenshots: list[str] = Field(
        default_factory=list,
        description=(
            "선택: evidence_dir 상대 경로의 증거 스크린샷/이미지(.png/.jpg). 점검 중 "
            "남긴 화면/문서 캡처를 finding 에 연결한다(요구 4, 2~3장)."
        ),
    )


def _ensure_smb_task_type(f: TaskFinding) -> "TaskFinding | ToolError":
    """smb 게이트가 실제로 돌게 만든다 — 안 그러면 **조용히 우회된다.**

    근거·설계는 `_shared.submit_task_type` docstring 에 있다(4도메인 공용).
    요약: `TaskFinding.task_type` 기본값이 `"generic"` 이고 코어 디스패치가 raw
    문자열 조회라, 워커가 필드를 빠뜨리면 등록된 smb judge 가 아예 안 돈다.
    실측 2026-08-17 — 제출 67건 중 16건(24%)이 빠뜨렸고 4건이 generic 으로 남았다.
    """
    from _shared.submit_task_type import ensure_task_type

    return ensure_task_type(f, "smb", tool_name="smb_submit_finding")


def _link_screenshots(
    finding_id: int, share_id: int | None, evidence_dir: Path, rels: list[str],
) -> int:
    """evidence_dir path-jail 안의 이미지만 screenshot row 로 연결. 반환 연결 수."""
    base = evidence_dir.resolve()
    linked = 0
    ordinal = 1
    for rel in rels[:3]:  # 2~3장 상한
        rel = str(rel or "").strip().lstrip("/")
        if not rel or not rel.lower().endswith((".png", ".jpg", ".jpeg")):
            continue
        try:
            target = (base / rel).resolve()
            target.relative_to(base)  # path-jail (../ 차단)
        except (ValueError, OSError):
            continue
        if not target.is_file():
            continue
        try:
            sha = hashlib.sha256(target.read_bytes()).hexdigest()
        except OSError:
            sha = None
        state.screenshot_add(
            finding_id=finding_id, share_id=share_id, rel_path=rel,
            kind="evidence", sha256=sha, ordinal=ordinal,
        )
        linked += 1
        ordinal += 1
    return linked


class SmbSubmitFindingTool(SubmitFindingTool):
    """엔진 SubmitFindingTool 상속 — 부모 generic 경로 + SMB 도메인/E2E 전이."""

    name: ClassVar[str] = "smb_submit_finding"
    domain: ClassVar[str] = "smb"
    input_model: ClassVar[type[BaseModel]] = SmbSubmitFindingInput
    search_hint: ClassVar[str] = "smb submit finding e2e remediation mail_thread terminate"
    description: ClassVar[str] = (
        SubmitFindingTool.description
        + "\n\n[SMB E2E] 이 도구는 finding 을 기록하고 IP 단위 리포트 draft 에 집계한다: "
        "finding_lifecycle 적재(부모 경로) → SMB 대표 share severity/hit 힌트 기록 → "
        "mail_thread(draft, 제목 `[보안취약점 조치요청](IP)`) 적재. "
        "host 전체 판정 완료 후 draft 가 reported 로 승격되어 #2 조치요청 큐에 진입한다. "
        "screenshots 인자로 evidence_dir 의 증거 이미지를 연결할 수 있다. "
        "task_type 은 'smb' 로 제출하라."
    )

    async def execute(self, validated_input: SmbSubmitFindingInput, context: ToolContext) -> ToolResult:
        f: TaskFinding = validated_input.finding
        f = _ensure_smb_task_type(f)
        if isinstance(f, ToolError):
            return f
        # (0) 결정론적 검증 인용 — 크리덴셜 로그인 프로브가 authenticated 를 남긴 hit 이면
        # LLM 이 인용했든 안 했든 hit.validation 에 붙이고 severity 를 critical 로 승격.
        # 근거: "평문 노출"과 "로그인 성공으로 악용 가능 확인"은 심각도가 다르다.
        f = _augment_with_login_validation(
            f, str((getattr(context, "metadata", {}) or {}).get("smb_host") or ""))
        # (1) 부모 generic 경로 위임 — 증거 게이트 + finding_lifecycle upsert + finding.json.
        parent_input = SubmitFindingTool.input_model(finding=f)
        result = await super().execute(parent_input, context)
        if isinstance(result, ToolError):
            return result
        # 게이트가 should_persist=False 면 lifecycle finding 미생성 → E2E 전이 없음.
        if "lifecycle" not in result.content:
            return result

        # (2) finding_id 재도출 — 부모와 동일 fingerprint 로 finding_lifecycle 조회.
        asset = f.hits[0].location if f.hits else f.task_id
        asset_kind = _asset_kind_from_location(asset) if f.hits else "task"
        canon = canonical_task_type(f.task_type, asset)
        discriminator = "|".join(sorted({h.category for h in f.hits}))
        from secu_agent import state as core_state
        fp = core_state.finding_fingerprint(
            task_type=canon, asset=asset, asset_kind=asset_kind, discriminator=discriminator,
        )
        finding_id = _finding_id_by_fingerprint(fp)
        if finding_id is None:
            # lifecycle 은 생겼는데 조회 실패 — 부모 성공은 유지, E2E 전이만 skip.
            return ToolSuccess(content=result.content + " (smb_e2e: finding_id 조회 실패, 전이 skip)")

        # host 도출: target(점검 대상) 우선, 없으면 asset.
        host = _host_from_asset(getattr(f, "target", "") or "") or _host_from_asset(asset)
        ip = host if _IPV4_RE.fullmatch(host or "") else host

        # (3) SMB 도메인 영속 — 대표 share 에 severity/hit 힌트만 기록.
        # host terminal 처리는 worker 완료 시점에 수행한다.
        # ★ 4도메인 공용 계약 — 제출이 성공했으면 표식을 단다.
        #   smb 는 지금 보고 게이트를 안 타지만(제출 시점에 스레드를 만든다) 표식은
        #   같아야 한다. 게이트를 네 도메인에 맞출 때 smb 만 빠지면 그때 또 갈린다.
        try:
            from service.services.finding_verification import stamp_agent_verification

            stamp_agent_verification(
                fp,
                method="smb_share_deep_dive",
                source="smb_submit_finding",
                checks=(
                    "smb_scan_share_completed",
                    "finding_submitted_by_agent",
                    "evidence_judgment_passed",
                ),
                details={"hit_count": len(f.hits or [])},
            )
        except Exception:  # noqa: BLE001 — 표식 실패가 제출을 되돌리지 않는다
            log.warning("[smb] agent_verification 표식 실패 finding=%s", finding_id)

        share_id = _smb_domain_persist(host, asset, finding_id, f.severity)

        # (4) 스크린샷 연결 (path-jail).
        linked = _link_screenshots(
            finding_id, share_id, context.evidence_dir, validated_input.screenshots,
        )

        # (5) E2E 상태머신 전이 — host(IP) 단위 draft mail_thread 에 finding 집계.
        # 같은 IP 의 finding 은 한 스레드로 뭉쳐 1건 리포팅. worker 완료 전에는 #2 큐에 안 올린다.
        # 아직 모른다 — 실제 발송 후 `report_mail_agent` 가 진짜 수신자를 적는다.
        recipient = None
        action, thread_id = state.mail_thread_upsert(
            finding_id=finding_id, host=host or asset,
            subject_tag=normalize_subject_tag(ip or host or asset),
            share_id=share_id, severity=f.severity, recipient=recipient,
            status="draft",
        )
        # ★ 초안 본문을 **여기서** 만들어 스레드에 붙인다 — github/confluence/dev_web 이
        #   보고서 생성 시점에 하는 것과 같은 자리다. smb 만 본문이 발송 시점에야 생겨서
        #   발송 전 단계에서 콘솔의 smb 티켓이 전부 빈 칸이었다(실측 24/24).
        #   `build_remediation_report` 는 "live I/O 없음(DB+evidence 만)" 이라 여기서 안전하다.
        #   ⚠️ 발송은 하지 않는다. 초안을 미리 두는 것뿐이다.
        #   ⚠️ 실패해도 제출을 죽이지 않는다 — 본문은 부가물이고, 여기서 예외를 내면
        #      finding 제출 자체가 halt 로 간다(이 저장소가 반복해서 당한 형태).
        # ★ 초안 쓰기는 `service/services/smb_draft_report` 한 벌이다 — 스레드를 만드는
        #   경로가 둘이라(제출 도구 / 노출 백스톱) 여기만 쓰면 한쪽이 본문 없이 남는다.
        from service.services.smb_draft_report import ensure_thread_draft

        ensure_thread_draft(thread_id, finding_id=finding_id, host=host or asset)

        note = {"new": "→ IP report draft 생성",
                "merged": "→ 같은 IP report draft 에 finding 집계",
                "recurred": "→ 미조치 재발 draft 집계 — host 완료 후 재발송 예약",
                "dup": "→ 이미 집계된 finding"}.get(action, "")
        return ToolSuccess(
            content=(
                result.content
                + f"; smb_e2e: finding_id={finding_id} host={host} "
                + f"mail_thread={action}(id={thread_id}) screenshots_linked={linked} {note}"
            ),
        )


def _finding_id_by_fingerprint(fingerprint: str) -> int | None:
    with state.connect() as c:
        row = c.execute(
            "SELECT id FROM finding_lifecycle WHERE fingerprint=?", (fingerprint,),
        ).fetchone()
    return int(row["id"]) if row else None


def _smb_domain_persist(host: str, asset: str, finding_id: int, severity: str) -> int | None:
    """대표 share_id 반환 + share row 에 finding 힌트 기록. host 완료 처리는 worker 종료 시점."""
    if not host:
        return None
    shares = state.smb_shares_of_host(host)
    rep_share_id: int | None = None
    share_name = _share_from_asset(asset)
    for s in shares:
        if share_name and str(s.get("share") or "") == share_name:
            rep_share_id = int(s["id"])
            break
    for s in shares:
        if s.get("status") in ("in_progress", "walked", "listing_reviewed", "pending"):
            if rep_share_id is None:
                rep_share_id = int(s["id"])
    if not shares:
        return None
    if rep_share_id is None:
        rep_share_id = int(shares[0]["id"])
    try:
        with state.connect() as c:
            c.execute(
                "UPDATE smb_share SET severity=?, hits_count=COALESCE(hits_count,0)+1 "
                "WHERE id=?",
                (severity, rep_share_id),
            )
    except Exception:  # noqa: BLE001 — 도메인 전이 실패가 finding 자체를 무효화하지 않음
        pass
    return rep_share_id


# ⚠️ 여기 있던 `_build_phase_recipient()` 를 걷어냈다. docstring 이 스스로
# "Development default: queue report-mail threads to DSSOC, not owners" 라고 적혀 있었다 —
# **개발 기본값이 운영까지 살아남았다.**
#
# 실측(2026-08-24): `mail_thread` 510행 전부 `dssoc@samsung.com`, 서로 다른 값 1종.
# 그중 실제로 발송된 것은 `awaiting_reply` 241행뿐이고, 나머지 269행(reported 256·draft 7 등)은
# **한 번도 안 보냈는데** 수신처가 적혀 있었다. 발송된 241행의 DSSOC 는 참이다
# (그때는 `dssoc_only` 모드였다) — 소급해서 지우지 말 것.
#
# SMB 담당자는 이 컬럼이 아니라 Splunk `asset_owner` 에서 온다
# (`smb_report_mail_tools` 가 `report["owner"]["email"]` 을 쓴다). 이 컬럼은 **기록**이다.
