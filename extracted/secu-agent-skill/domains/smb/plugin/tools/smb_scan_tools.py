"""공유 일괄 스캔 + 아카이브 목차 — 코드가 훑고, LLM 은 판정한다 (2026-08-27).

## 왜 만들었나 — 실측

    smb_file                          722,958 건 (18TB)
    scan_status = 'scanned'                 5 건      ← 전부다
    is_text_candidate=1 · ≤512K       164,161 건      ← 열기만 하면 되는 것
    smb_file_hit                            1 건

수집기(`service/collector/`)에는 `fetch_file` 도 `scan_text` 도 없다 — **걷기만 하고
열지 않는다.** 파일을 여는 유일한 주체가 LLM 워커였고, 워커 계약은 이렇게 시켰다:

    Deep-dive **only selected** suspicious files with `smb_fetch_scan`.

한 턴에 한 파일이다. 72만 개에 40턴을 쓰면 결과는 0에 수렴한다.

github 은 이미 같은 문제를 고쳤다(스캐너가 훑고 → 후보 → LLM 판정). smb 만 안 고쳤다.
`state.files_pending_scan` 은 **v3.72 에 이미 만들어져 있었고 생산 호출부가 0개였다** —
큐만 있고 비우는 쪽이 없었다.

## 계약

`smb_scan_share` 는 **본문을 돌려주지 않는다.** 후보 요약(경로·category·kind·마스킹값·
라인번호)만 낸다. 판정은 워커가 한다 — 그게 LLM 이 여기 있는 이유다.

⚠️ **finding 을 만들지 않는다.** hit 는 단서지 유출이 아니다. 제출은 워커가
`smb_submit_finding` 으로 한다. (github 이 같은 경계를 `register=False` 로 세웠다.)
"""
from __future__ import annotations

import json
import time
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)

#: 도구 출력 상한. 후보가 많아도 워커 컨텍스트를 태우지 않는다.
_OUTPUT_CAP_BYTES = 24 * 1024
#: 응답에 실어 보내는 후보 파일 수. 나머지는 개수로만 말한다.
#: (실측: preview 는 detector 가 ~94자로 자른다 → 30×4 ≈ 12KB, 출력 상한 안쪽.)
_CANDIDATE_CAP = 30
#: 파일당 hit 표본. 같은 파일에서 같은 종류가 수백 번 나오는 일이 흔하다.
_HITS_PER_FILE = 4
#: 못 읽은 파일 단서 표본 수. 전체 개수는 `unread_total` 로 따로 말한다.
_LEAD_CAP = 12
_UNREAD_NOTE = (
    " ⚠️ 다만 **본문을 못 본 파일**이 남아 있다 — `unread_leads` 를 보고 이름·경로·"
    "크기만으로 위험도를 판단해라. 못 읽었다는 이유로 없는 것처럼 닫지 마라. "
    "본문 증거가 없으니 hit 로 제출하지는 말고, 판정 사유에 **무엇을 왜 못 봤는지** 남겨라."
)
#: 앞부분만 읽어서는 아무것도 못 얻는 포맷 — zip 컨테이너(office)와 PDF.
#: 잘린 zip 은 추출이 실패하고, 실패는 `binary` 로 떨어져 **종결 표식**이 찍힌다.
#: 크기 때문에 못 본 것을 "바이너리라 못 읽음" 으로 닫으면 거짓말이 된다.
_WHOLE_FILE_EXTENSIONS = frozenset({
    "docx", "xlsx", "pptx", "hwpx", "pdf", "zip", "tar", "gz", "7z", "rar",
})


def _needs_whole_file(path: str) -> bool:
    base = str(path or "").lower().replace("\\", "/").rsplit("/", 1)[-1]
    if "." not in base:
        return False
    return base.rsplit(".", 1)[-1] in _WHOLE_FILE_EXTENSIONS


def _unread_leads(state: Any, share_id: int, *, cap: int) -> dict[str, Any] | None:
    """못 읽은 파일 단서. 조회가 실패해도 스캔 결과를 죽이지 않는다."""
    try:
        got = state.files_unread_leads(share_id=share_id, limit=cap)
    except Exception:  # noqa: BLE001 — 단서는 부가정보다
        return None
    return got if got and int(got.get("total") or 0) else None


def _record_read(ctx: Any, *, files: int = 0, read_bytes: int = 0) -> None:
    """본문을 읽은 만큼 검토원 열람 장부에 센다(코드 계측). 실패해도 스캔은 산다."""
    try:
        from _shared.inspector_report import record_read

        record_read(ctx, files=files, read_bytes=read_bytes)
    except Exception:  # noqa: BLE001
        pass


def _smb_mod() -> Any:
    from domains.smb.plugin.agent_types import smb
    return smb


def _detectors_mod() -> Any:
    from secu_agent import detectors
    return detectors


def _cap(text: str) -> str:
    if len(text) <= _OUTPUT_CAP_BYTES:
        return text
    return text[: _OUTPUT_CAP_BYTES - 160] + (
        "\n\n... [잘림 — 남은 후보는 smb_task_python 으로 state.hits_for_file 조회]"
    )


# ── 후보 정리: 이미 게이트가 거부할 것을 표식한다 ──────────────────────────────
#
# 실측 2026-08-27, 이 도구의 첫 라이브 배치(share 1900, 15파일): hit 104건이 나왔는데
# 전부 `credit_card` 오탐이었다 — 부동소수의 소수부다:
#
#     masked="383617*******6823"
#     preview="…,0.99242333604433,1.0079619307622065,0.383617*******6823,…"
#
# 이건 이미 알려진 오탐이고 `plugin/pii_evidence_judge` 가 **제출 시점에** 거부한다.
# 문제는 순서다: 예전엔 워커가 파일 5개를 열었으니 안 보였고, 지금은 코드가 수백 개를
# 열어서 후보 요약이 통째로 노이즈가 된다. 워커가 판정을 노이즈에 태운다.
#
# ★ 그렇다고 **DB 에서 빼지 않는다.** hit 는 증거이고, 스캔 단계의 화이트리스트는
#   진짜 유출을 죽인다(2026-08-19 에 그 사고가 있었다 — 스캔과 submit 은 규칙이 달라야 한다).
#   여기서는 **표식하고 뒤로 보낼 뿐**이다. 원문은 `state.hits_for_file` 에 그대로 있다.


class _HitShim:
    """등록된 category judge 가 기대하는 속성만 맞춘다(`preview`, dict 아님)."""

    __slots__ = ("category", "kind", "masked", "preview")

    def __init__(self, h: dict[str, Any]) -> None:
        self.category = str(h.get("category") or "")
        self.kind = str(h.get("kind") or "")
        self.masked = str(h.get("masked") or "")
        self.preview = str(h.get("line_preview") or "")


def _gate_would_reject(h: dict[str, Any]) -> str | None:
    """제출 게이트가 이 hit 를 거부하는가. 거부하면 사유, 아니면 None.

    ⚠️ **등록된 판정기를 그대로 쓴다** — 여기서 규칙을 다시 쓰면 두 벌이 되고,
       게이트가 바뀌어도 이쪽은 옛 규칙으로 계속 표식한다.
    """
    try:
        from secu_agent.agent import evidence_judgment as ej
        judge = ej._CATEGORY_JUDGES.get(str(h.get("category") or ""))
        if judge is None:
            return None
        verdict = judge(None, _HitShim(h))
    except Exception:  # noqa: BLE001 — 표식은 부가정보다. 실패해도 스캔은 산다.
        return None
    if verdict is None or getattr(verdict, "verdict", "") != "rejected":
        return None
    return str(getattr(verdict, "reason", "") or "게이트 거부 대상")[:180]


# ═══════════════════════════════════════════════════════════════════════════
# smb_scan_share — 공유 하나를 세션 하나로 훑는다
# ═══════════════════════════════════════════════════════════════════════════

#: `max_bytes_per_file` 의 천장. note 가 이 값을 **말해줘야** 한다 —
#: 안 그러면 워커가 "올려라" 만 읽고 10MB 를 넣어 검증에서 거부당한다(실측 9회).
_MAX_BYTES_CEILING = 4 * 1024 * 1024


class SmbScanShareInput(BaseModel):
    # ★ share_id 는 이제 선택이다. 워커는 `{"host": ..., "share": ...}` 를 쥐고 있는데
    #   도구가 DB 의 int id 만 받아서, 스캔 호출 241건 중 **71건이 share_id 누락으로
    #   거부**됐다(2026-08-27 실측). 실행조차 안 된 것이다. 같은 공유를 이름으로도
    #   가리킬 수 있게 한다 — 훑는 대상은 그대로다.
    share_id: int | None = Field(
        None, description="claim 한 smb_share.id. 모르면 host+share 로 줘도 된다.")
    host: str | None = Field(None, description="share_id 대신 쓸 때의 host")
    share: str | None = Field(
        None, description="share_id 대신 쓸 때의 공유 이름. host 와 **함께** 줘야 한다.")
    max_files: int = Field(300, ge=1, le=2000, description="이번 호출에서 열 파일 수")
    max_seconds: int = Field(120, ge=5, le=600, description="벽시계 예산. 넘으면 남기고 반환")
    max_bytes_per_file: int = Field(
        512 * 1024, ge=1024, le=_MAX_BYTES_CEILING,
        description=(f"파일당 **읽기** 상한. 이보다 큰 파일은 건너뛰지 않고 "
                     f"**앞부분만** 읽는다(범위 읽기). 결과에 partial_reads 로 표시된다. "
                     f"최대 {_MAX_BYTES_CEILING}"))


class SmbScanShareTool(Tool[SmbScanShareInput]):
    name: ClassVar[str] = "smb_scan_share"
    domain: ClassVar[str] = "smb"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "smb scan share bulk sweep secret pii candidate batch"
    description: ClassVar[str] = (
        "공유 하나의 **미스캔 text 후보를 일괄로** fetch + scan_text 한다. SMB 세션을 "
        "하나만 열어 재사용하므로 파일 수백 개를 한 번의 도구 호출로 훑는다.\n\n"
        "대상은 `share_id` 로 주거나, 모르면 `host` 와 `share` 를 **함께** 줘라 "
        "(공유 이름만으로는 못 고른다 — 같은 이름이 host 마다 있다).\n\n"
        "★ **먼저 이걸 부르고, 그 결과를 판정하라.** 파일을 하나씩 고르는 것은 네 일이 "
        "아니다 — 찾기는 코드가 하고, 판정은 네가 한다. (실측 2026-08-27: 722,958개 중 "
        "스캔된 것이 5개였다. 워커가 한 턴에 한 파일씩 골랐기 때문이다.)\n\n"
        "hit 는 `smb_file_hit` 에 영속되고 `smb_file.scan_status` 가 표식된다 — "
        "다음 호출은 **안 한 것부터** 이어서 한다(재개 가능). 예산(max_files/max_seconds)을 "
        "다 쓰면 `remaining` 에 남은 수를 담아 돌아온다. 남았으면 다시 불러라.\n\n"
        "⚠️ 본문은 돌려주지 않는다(컨텍스트 보호). 후보 요약만 준다 — 특정 파일을 더 봐야 "
        "하면 `smb_fetch_scan` 이나 `state.hits_for_file(file_id)` 로 좁혀서 봐라.\n"
        "⚠️ **finding 을 만들지 않는다.** hit 는 단서다. 제출은 `smb_submit_finding` 이다.\n"
        "⚠️ `max_bytes_per_file` 보다 큰 text 후보는 이번 패스에서 **건너뛰고 큐에 남는다** "
        "— 표식하지 않으므로 상한을 올려 다시 부르면 잡힌다."
    )
    input_model: ClassVar[type[BaseModel]] = SmbScanShareInput

    async def execute(self, vi: SmbScanShareInput, ctx: ToolContext) -> ToolResult:
        import asyncio

        smb = _smb_mod()
        if smb._AUTH_DISABLED_REASON:
            return ToolError(
                kind="forbidden",
                message=f"SMB auth locked out — 스캔 차단. reason: {smb._AUTH_DISABLED_REASON}",
            )
        try:
            payload = await asyncio.to_thread(_scan_share_blocking, vi, ctx)
        except Exception as e:  # noqa: BLE001
            return ToolError(kind="execution", message=f"스캔 실패: {e!r}")
        if isinstance(payload, ToolError):
            return payload

        from secu_agent.agent.secret_redact import redact_secrets
        return ToolSuccess(content=_cap(redact_secrets(
            json.dumps(payload, ensure_ascii=False))))


def _summarize(hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """파일당 hit 표본. **게이트가 거부하지 않을 것부터** 보여준다."""
    ordered = sorted(hits, key=lambda h: _gate_would_reject(h) is not None)
    out = []
    for h in ordered[:_HITS_PER_FILE]:
        why = _gate_would_reject(h)
        item = {"category": h["category"], "kind": h["kind"], "masked": h["masked"],
                "line_no": h["line_no"], "line_preview": h["line_preview"]}
        if why:
            item["gate_rejects"] = why
        out.append(item)
    return out


def _scan_share_blocking(vi: SmbScanShareInput, ctx: ToolContext) -> Any:
    from service import state_domain as state

    smb = _smb_mod()
    detectors = _detectors_mod()
    from service.probes.hit_legibility import relegible_hits

    # share_id 를 먼저 확정한다. 워커가 이름으로 줬으면 여기서 푼다 — 못 풀면
    # **조용히 아무거나 훑지 않고** 사유를 말한다(다른 host 를 훑는 게 더 나쁘다).
    share_id = vi.share_id
    if share_id is None:
        row = state.smb_share_resolve(vi.host, vi.share)
        if row is None:
            return ToolError(
                kind="validation",
                message=(
                    "share_id 를 못 정했다 — share_id 를 주거나 host 와 share 를 **함께** "
                    f"줘라(받은 값: host={vi.host!r}, share={vi.share!r}). "
                    "같은 이름의 공유가 host 마다 있어서 share 이름만으로는 못 고른다."
                ),
            )
        share_id = int(row["id"])

    # ★ 2026-08-29: `max_size=` 를 **뺐다**. 이 한 인자가 큐에서 큰 파일을 통째로
    #   제외해 부분읽기를 무력화하고 있었다 — `fetch_file_on` 은 앞부분만 읽을 수
    #   있는데(범위 읽기) 큐가 그 파일을 아예 안 보여줬다. 실측 512K 초과 미스캔
    #   text 후보 33,553건(6.4TB)이 한 번도 안 열렸다.
    pending = state.files_pending_scan(share_id=share_id, limit=vi.max_files)
    # ⚠️ 남은 수는 이번 배치가 아니라 **큐 전체**를 세야 한다. 목록 길이로 세면
    #    limit 때문에 항상 "남은 것 없음" 으로 보이고, 워커가 한 번만 부르고 끝낸다.
    total_pending = state.count_files_pending_scan(share_id=share_id)

    if not pending:
        # 0 을 성공으로 적되, **왜 0 인지** 구분해서 말한다.
        # ⚠️ 크기 분기는 없앴다 — 큐가 더는 크기로 거르지 않으므로 "더 큰 게 남았다" 는
        #    상태가 존재하지 않는다. 대신 **못 읽어서 닫힌 것**을 반드시 말한다.
        unread = _unread_leads(state, share_id, cap=_LEAD_CAP)
        note = "미스캔 text 후보가 없다 — 이 공유의 text 후보는 다 훑었다."
        out: dict[str, Any] = {
            "kind": "smb_scan_share", "share_id": share_id,
            "scanned": 0, "files_with_hits": 0, "hits_total": 0, "remaining": 0,
            "note": note,
            "candidates": [],
        }
        if unread:
            out["unread_leads"] = unread["items"]
            out["unread_total"] = unread["total"]
            out["note"] = note + _UNREAD_NOTE
        return out

    host = str(pending[0].get("host") or "")
    share = str(pending[0].get("share") or "")
    if not host or not share:
        return ToolError(kind="validation",
                         message=f"share_id={share_id} 의 host/share 를 못 읽었다")

    deadline = time.monotonic() + vi.max_seconds
    scanned = skipped = hits_total = partial = 0
    noise_files = noise_hits = files_with_hits = 0
    by_status: dict[str, int] = {}
    #: 실제로 받아온 바이트 — 검토원 열람 장부(코드 계측)에 쓴다.
    read_bytes_total = 0
    candidates: list[dict[str, Any]] = []
    stopped = ""

    try:
        with smb.open_session(host) as conn:
            for row in pending:
                if time.monotonic() >= deadline:
                    stopped = "max_seconds"
                    break
                if smb._AUTH_DISABLED_REASON:
                    # 실행 중 잠금 — 남은 파일을 표식하지 않고 멈춘다(재시도 가능).
                    stopped = "auth_locked_out"
                    break
                fid = int(row["id"])
                path = str(row.get("path") or "")
                fsize = int(row.get("size") or 0)
                oversize = fsize > vi.max_bytes_per_file
                if oversize and _needs_whole_file(path):
                    # ★ 앞부분만 읽어봐야 zip/pdf 는 추출이 실패하고, 그 실패는
                    #   'binary' 로 **종결** 표식이 찍힌다. 크기 때문에 못 본 것을
                    #   "바이너리" 로 닫는 건 거짓이다 — 표식하지 않고 남긴다.
                    #   (`smb_archive_index`/`smb_inspect_pdf` 가 갈 길이다.)
                    #   ⚠️ 표식은 **해야 한다**. 안 하면 큐에서 안 빠지고 `remaining`
                    #      이 안 줄어 워커가 같은 배치를 무한히 다시 부른다.
                    #      'skipped:too_large' 는 `files_unread_leads` 가 집어가므로
                    #      사라지지 않고 단서로 다시 나타난다.
                    state.file_record_scan_skipped(fid, reason="too_large")
                    by_status["too_large"] = by_status.get("too_large", 0) + 1
                    skipped += 1
                    continue
                status, body = smb.fetch_file_on(
                    conn, share, path, max_bytes=vi.max_bytes_per_file,
                    size=fsize or None)
                # DRM 판정용 원시 앞부분. binary 로 떨어졌을 때만 쓴다(64바이트면 충분).
                _raw_head = b""
                if status == "binary":
                    _st2, _p2 = smb.read_range_on(conn, share, path, offset=0, length=64)
                    if _st2 == "bytes" and isinstance(_p2, bytes):
                        _raw_head = _p2
                by_status[status] = by_status.get(status, 0) + 1
                read_bytes_total += len(body) if isinstance(body, (bytes, str)) else 0

                if status != "text":
                    # ★ 'scanned' 로 적지 않는다 — 안 읽힌 것을 읽었다고 하면 거짓이다.
                    #   error 는 일시적일 수 있어 표식하지 않고 큐에 남긴다.
                    if status in ("denied", "not_found", "binary", "empty"):
                        # ★ "왜 못 읽었나" 를 구분해 남긴다. `binary` 한 칸에 뭉치면
                        #   DRM 문서와 진짜 바이너리가 같은 것이 된다.
                        #   ⚠️ DRM 은 **안전하다는 뜻이 아니다** — 사내 AD 접속만으로
                        #      NASCA 권한이 열려 대부분 읽을 수 있다(사용자, 2026-08-30).
                        #      위험도를 낮추는 근거로 쓰지 마라. 판정은 이름·경로로 한다.
                        reason = status
                        if status == "binary" and smb.is_drm_wrapped(_raw_head):
                            reason = "drm"
                            by_status["drm"] = by_status.get("drm", 0) + 1
                        state.file_record_scan_skipped(fid, reason=reason)
                        skipped += 1
                    # ⚠️ file_read 는 "실제로 바이트를 받았는가" 다. not_found/error 를
                    #    읽은 것으로 적으면 접근성 통계가 부풀려진다.
                    state.file_record_fetch(
                        fid, fetch_status=status,
                        file_read=status in ("text", "binary", "empty"))
                    continue

                sr = detectors.scan_text(
                    body, label=path, include_document_signals=True)
                hits = relegible_hits(body, list(sr.hits))
                state.add_file_hits(fid, hits)
                state.file_record_scan(fid, hits_count=len(hits))
                # ★ 앞부분만 읽었으면 그렇게 적는다. 'text' 로 적으면 6GB 파일의
                #   512K 만 보고 "다 봤다" 가 된다.
                state.file_record_fetch(
                    fid, fetch_status="text:head" if oversize else "text",
                    file_read=True)
                if oversize:
                    partial += 1
                scanned += 1
                hits_total += len(hits)
                if hits:
                    files_with_hits += 1
                    rejected = sum(1 for h in hits if _gate_would_reject(h))
                    if rejected:
                        noise_files += 1
                        noise_hits += rejected
                    candidates.append({
                        "file_id": fid, "path": path,
                        "size": int(row.get("size") or 0),
                        "suspicious_name": bool(row.get("suspicious_name")),
                        "hits_count": len(hits),
                        # ★ 전부 게이트가 거부할 것이면 그렇게 말한다. 지우지는 않는다.
                        "all_hits_gate_rejected": rejected == len(hits),
                        "hits": _summarize(hits),
                    })
    except Exception as e:  # noqa: BLE001 — 세션이 끊겨도 여기까지 한 것은 살린다
        stopped = f"session: {type(e).__name__}: {str(e)[:100]}"

    # ★ 게이트가 거부할 것을 **뒤로** 보낸다. 워커의 첫 40줄이 노이즈면 판정이 노이즈에 탄다.
    candidates.sort(key=lambda c: (c["all_hits_gate_rejected"], not c["suspicious_name"],
                                   -c["hits_count"]))
    dropped = max(0, len(candidates) - _CANDIDATE_CAP)
    candidates = candidates[:_CANDIDATE_CAP]
    # ⚠️ `files_with_hits` 는 **루프에서** 센 값이다. 잘린 목록으로 세면 30건에서
    #    멈춘 숫자를 집계인 척 내보내게 된다(이 저장소가 반복해서 당한 종류의 거짓말).
    # 큐 전체에서 이번에 처리(스캔+표식)한 만큼을 뺀다.
    remaining = max(0, total_pending - scanned - skipped)
    # 실제로 연 만큼을 코드가 센다 — 검토원 보고의 `looked_at` 이 이 값을 쓴다.
    # 자기신고(files_seen)는 145회 중 0회 전달됐다(2026-08-28 실측).
    _record_read(ctx, files=scanned, read_bytes=read_bytes_total)
    out: dict[str, Any] = {
        "kind": "smb_scan_share",
        "share_id": share_id, "host": host, "share": share,
        "scanned": scanned, "skipped": skipped,
        "files_with_hits": files_with_hits, "hits_total": hits_total,
        "fetch_status": by_status,
        "remaining": remaining,
        "candidates": candidates,
    }
    if partial:
        out["partial_reads"] = {
            "files": partial,
            "note": (f"{partial}건은 크기가 max_bytes_per_file({vi.max_bytes_per_file})"
                     "을 넘어 **앞부분만** 읽었다. hit 가 0이어도 '깨끗하다' 가 아니라 "
                     "'앞부분에는 없었다' 다 — 판정에 그렇게 남겨라."),
        }
    unread = _unread_leads(state, share_id, cap=_LEAD_CAP)
    if unread:
        out["unread_leads"] = unread["items"]
        out["unread_total"] = unread["total"]
        out["unread_note"] = _UNREAD_NOTE.strip()
    if dropped:
        out["candidates_omitted"] = dropped
    if noise_hits:
        # 조용히 줄이지 않는다 — 몇 건을 왜 뒤로 보냈는지 밝힌다.
        out["gate_rejected"] = {
            "files": noise_files, "hits": noise_hits,
            "note": ("제출 게이트(pii/secret 판정기)가 이미 거부할 hit 다 — "
                     "DB 에는 그대로 있고 목록에서 뒤로 보냈다. "
                     "state.hits_for_file(file_id) 로 원문 확인 가능."),
        }
    if stopped:
        out["stopped"] = stopped
    if remaining:
        out["next"] = f"남은 {remaining}건 — smb_scan_share 를 다시 불러라."
    return out


# ═══════════════════════════════════════════════════════════════════════════
# smb_archive_index — 130MB 를 안 받고 목차만 본다
# ═══════════════════════════════════════════════════════════════════════════

class SmbArchiveIndexInput(BaseModel):
    host: str
    share: str
    path: str = Field(..., description="share-root 기준 경로 (예: 'pkg/AB12.tar')")
    size: int | None = Field(None, ge=0, description="알면 준다. 없으면 원격 stat")
    max_entries: int = Field(200, ge=1, le=2000)


class SmbArchiveIndexTool(Tool[SmbArchiveIndexInput]):
    name: ClassVar[str] = "smb_archive_index"
    domain: ClassVar[str] = "smb"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "smb archive tar zip index listing contents large file"
    description: ClassVar[str] = (
        "아카이브(.tar/.zip)의 **목차**를 통째로 안 받고 읽는다. tar 는 512바이트 헤더 "
        "체인을, zip 은 꼬리의 중앙 디렉터리만 부분 읽기로 가져온다 — 130MB 파일도 "
        "수십 KB 만 전송한다.\n\n"
        "★ 큰 아카이브를 '못 봤다'고 넘기지 마라. 목차는 볼 수 있다. 실측 2026-08-27: "
        "tar 34,069개(761GB)·zip 967개(626GB)가 한 바이트도 열린 적이 없었다.\n\n"
        "⚠️ 목차는 **이름과 크기**다. 내용이 아니다 — '무슨 파일인지'는 답하지만 "
        "'그 안에 시크릿이 있는지'는 답하지 않는다. 근거에 그 한계를 적어라.\n"
        "⚠️ `.tar.gz`/`.tgz`/`.7z`/`.rar`/`.cab`/`.iso` 는 **안 된다**. gzip 은 앞에서부터 "
        "풀지 않으면 목차가 없어 원리적으로 불가하고, 나머지는 파서 미구현이다. "
        "사유를 그대로 돌려주니 그걸 인용하라 — '확인 못 함'을 '문제 없음'으로 접지 마라."
    )
    input_model: ClassVar[type[BaseModel]] = SmbArchiveIndexInput

    async def execute(self, vi: SmbArchiveIndexInput, ctx: ToolContext) -> ToolResult:
        import asyncio

        smb = _smb_mod()
        if smb._AUTH_DISABLED_REASON:
            return ToolError(kind="forbidden",
                             message=f"locked out: {smb._AUTH_DISABLED_REASON}")

        from domains.smb.plugin import archive_index as ai

        # 못 하는 형식은 세션을 열지도 않는다 — 헛된 로그인이 lockout 예산을 먹는다.
        supported, why = ai.can_index(vi.path)
        if not supported:
            return ToolSuccess(content=json.dumps({
                "kind": "smb_archive_index", "ok": False,
                "format": ai.archive_kind(vi.path),
                "path": vi.path, "detail": why, "entries": [],
            }, ensure_ascii=False))

        try:
            payload = await asyncio.to_thread(_index_blocking, vi)
        except Exception as e:  # noqa: BLE001
            return ToolError(kind="execution", message=f"목차 실패: {e!r}")

        from secu_agent.agent.secret_redact import redact_secrets
        return ToolSuccess(content=_cap(redact_secrets(
            json.dumps(payload, ensure_ascii=False))))


def _index_blocking(vi: SmbArchiveIndexInput) -> dict[str, Any]:
    from domains.smb.plugin import archive_index as ai

    smb = _smb_mod()
    reads = {"n": 0, "bytes": 0}
    #: 읽기 실패 사유별 횟수. reader 가 None 으로 뭉개기 전에 여기 세워 둔다.
    read_status: dict[str, int] = {}

    with smb.open_session(vi.host) as conn:
        size = vi.size
        if not size:
            size = smb._remote_file_size(conn, vi.share, vi.path.replace("/", "\\"))
        if not size:
            return {"kind": "smb_archive_index", "ok": False, "path": vi.path,
                    "entries": [],
                    "detail": "원격 크기를 못 읽었다 — zip 은 크기 없이 꼬리를 못 찾는다"}

        def reader(offset: int, length: int) -> bytes | None:
            status, payload = smb.read_range_on(
                conn, vi.share, vi.path, offset=offset, length=length)
            if status == "bytes" and isinstance(payload, bytes):
                reads["n"] += 1
                reads["bytes"] += len(payload)
                return payload
            if status == "empty":
                return b""
            # ★ 못 읽음 — 빈 아카이브와 구분한다. 그런데 예전엔 여기서 **왜** 못 읽었는지가
            #   같이 사라졌다: denied·not_found·error 가 전부 None 한 가지로 뭉개져서,
            #   증거에는 "offset 0 읽기 실패" 라는 한 문장만 남았다(실측 2026-08-27:
            #   완료 22건 중 21건이 그 문장, 원인 미상). 바로 위 `smb_scan_share` 는
            #   같은 파일에서 `by_status` 로 사유를 세고 있다 — 그 전례를 따른다.
            read_status[str(status)] = read_status.get(str(status), 0) + 1
            return None

        out = ai.index_archive(
            vi.path, reader, size=int(size), max_entries=vi.max_entries)

    entries = out.get("entries") or []
    return {
        "kind": "smb_archive_index",
        "ok": bool(out.get("ok")),
        "format": out.get("format"),
        "path": vi.path, "size": int(size),
        "entry_count": len(entries),
        "truncated": bool(out.get("truncated")),
        "detail": out.get("detail") or "",
        # 전송량을 밝힌다 — "통째로 안 받았다" 는 주장의 근거다.
        "bytes_transferred": reads["bytes"], "reads": reads["n"],
        # 실패 사유를 밝힌다 — 이게 없으면 "왜 목차를 못 읽나" 를 영원히 못 잰다.
        # tar 안을 여는 경로 전체가 이 도구의 성공에 물려 있다(워커 계약이
        # "목차를 인용한 뒤 archive_scan" 을 요구한다).
        "read_status": dict(read_status),
        "entries": entries,
    }


# ═══════════════════════════════════════════════════════════════════════════
# smb_archive_scan — 목차에서 그치지 않고 **안까지** 본다
#
# `smb_archive_index` 는 "무슨 파일인지" 까지만 답한다. 그 한계를 도구 설명에 적어 뒀는데,
# 그러고 나면 다음 질문이 반드시 온다 — "그래서 그 안에 시크릿이 있나".
#
# 실측 2026-08-27: tar 34,069개 + zip 967개 = 35,036개(1,387GB)가 목차만 보이고 안은
# 못 보는 상태다. tar 는 멤버 본문이 헤더 바로 뒤에 **무압축**으로 있고, zip 은 중앙
# 디렉터리에 로컬 헤더 위치가 있다 — 둘 다 그 멤버 구간만 읽으면 된다.
# ═══════════════════════════════════════════════════════════════════════════

class SmbArchiveScanInput(BaseModel):
    host: str
    share: str
    path: str = Field(..., description="share-root 기준 아카이브 경로")
    size: int | None = Field(None, ge=0, description="알면 준다. 없으면 원격 stat")
    max_members: int = Field(40, ge=1, le=300, description="스캔할 멤버 수")
    max_member_bytes: int = Field(
        512 * 1024, ge=1024, le=4 * 1024 * 1024, description="멤버당 회수 상한")
    max_seconds: int = Field(120, ge=5, le=600)


class SmbArchiveScanTool(Tool[SmbArchiveScanInput]):
    name: ClassVar[str] = "smb_archive_scan"
    domain: ClassVar[str] = "smb"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "smb archive tar zip scan inside member secret pii"
    description: ClassVar[str] = (
        ".tar/.zip **안의 텍스트 파일들을** 꺼내서 scan_text 한다. 아카이브를 통째로 "
        "받지 않는다 — 목차를 읽고, 텍스트 후보 멤버만 그 구간씩 꺼낸다.\n\n"
        "★ `smb_archive_index` 가 '무슨 파일인지' 라면 이건 '그 안에 뭐가 있나' 다. "
        "큰 아카이브를 '확인 못 함' 으로 넘기기 전에 이걸 불러라.\n\n"
        "⚠️ 텍스트로 보이는 멤버만 본다(설정·스크립트·키·문서 확장자). 바이너리 멤버는 "
        "건너뛰고 `skipped` 에 수로 남는다 — 안 봤다는 뜻이지 깨끗하다는 뜻이 아니다.\n"
        "⚠️ hit 를 DB 에 영속하지 않는다. 아카이브 멤버는 `smb_file` 행이 없다 — "
        "제출할 근거는 `smb_submit_finding` 에 경로를 "
        "`<아카이브경로>::<멤버경로>` 로 적어라.\n"
        "⚠️ .tar.gz/.7z/.rar/.cab/.iso 는 안 된다(사유를 돌려준다)."
    )
    input_model: ClassVar[type[BaseModel]] = SmbArchiveScanInput

    async def execute(self, vi: SmbArchiveScanInput, ctx: ToolContext) -> ToolResult:
        import asyncio

        smb = _smb_mod()
        if smb._AUTH_DISABLED_REASON:
            return ToolError(kind="forbidden",
                             message=f"locked out: {smb._AUTH_DISABLED_REASON}")

        from domains.smb.plugin import archive_index as ai

        ok, why = ai.can_index(vi.path)
        if not ok:
            return ToolSuccess(content=json.dumps({
                "kind": "smb_archive_scan", "ok": False, "path": vi.path,
                "detail": why, "candidates": [],
            }, ensure_ascii=False))
        try:
            payload = await asyncio.to_thread(_archive_scan_blocking, vi)
        except Exception as e:  # noqa: BLE001
            return ToolError(kind="execution", message=f"아카이브 스캔 실패: {e!r}")

        from secu_agent.agent.secret_redact import redact_secrets
        return ToolSuccess(content=_cap(redact_secrets(
            json.dumps(payload, ensure_ascii=False))))


def _archive_scan_blocking(vi: SmbArchiveScanInput) -> dict[str, Any]:
    from domains.smb.plugin import archive_index as ai

    smb = _smb_mod()
    detectors = _detectors_mod()
    from service.probes.hit_legibility import relegible_hits

    pulled = {"bytes": 0}
    #: 읽기 실패 사유별 횟수 — reader 가 None 으로 뭉개기 전에 세워 둔다.
    read_status: dict[str, int] = {}
    deadline = time.monotonic() + vi.max_seconds
    scanned = hits_total = binary = not_text_named = 0
    noise_hits = 0
    candidates: list[dict[str, Any]] = []
    stopped = ""

    with smb.open_session(vi.host) as conn:
        size = vi.size or smb._remote_file_size(
            conn, vi.share, vi.path.replace("/", "\\"))
        if not size:
            return {"kind": "smb_archive_scan", "ok": False, "path": vi.path,
                    "detail": "원격 크기를 못 읽었다", "candidates": []}

        def reader(offset: int, length: int) -> bytes | None:
            status, payload = smb.read_range_on(
                conn, vi.share, vi.path, offset=offset, length=length)
            if status == "bytes" and isinstance(payload, bytes):
                pulled["bytes"] += len(payload)
                return payload
            if status == "empty":
                return b""
            # ★ 사유까지 남긴다 — archive_index 와 같은 결함을 공유하던 자리다.
            read_status[str(status)] = read_status.get(str(status), 0) + 1
            return None

        # 목차는 **넉넉히** 읽는다 — 스캔할 후보를 고르려면 전체를 봐야 한다.
        idx = ai.index_archive(vi.path, reader, size=int(size),
                               max_entries=max(vi.max_members * 10, 400))
        if not idx.get("ok"):
            # ⚠️ 목차 실패가 tar 경로 전체를 막는다(워커 계약이 "목차를 인용한 뒤
            #    archive_scan" 을 요구한다). 그러니 **왜** 실패했는지를 반드시 실어 보낸다.
            return {"kind": "smb_archive_scan", "ok": False, "path": vi.path,
                    "detail": idx.get("detail") or "목차 실패",
                    "read_status": dict(read_status), "candidates": []}

        entries = [e for e in (idx.get("entries") or []) if e.get("kind") == "file"]
        # 텍스트로 보이는 멤버만. **작은 것부터** — 같은 예산에 더 많이 본다.
        targets = [e for e in entries if smb._is_text_candidate(e["name"].rsplit("/", 1)[-1])]
        # ⚠️ 두 가지를 **따로** 센다. "이름이 텍스트가 아니라 안 열었다" 와 "열었는데
        #    바이너리였다" 는 다른 사실이다 — 하나로 뭉치면 커버리지를 못 읽는다.
        not_text_named = len(entries) - len(targets)
        targets.sort(key=lambda e: int(e.get("size") or 0))

        for entry in targets[: vi.max_members]:
            if time.monotonic() >= deadline:
                stopped = "max_seconds"
                break
            data, note = ai.read_member(reader, entry, max_bytes=vi.max_member_bytes)
            if data is None:
                binary += 1
                continue
            label = f"{vi.path}::{entry['name']}"
            status, body = smb._classify_fetched(entry["name"], data)
            if status != "text":
                binary += 1
                continue
            scanned += 1
            sr = detectors.scan_text(body, label=label, include_document_signals=True)
            hits = relegible_hits(body, list(sr.hits))
            if not hits:
                continue
            hits_total += len(hits)
            rejected = sum(1 for h in hits if _gate_would_reject(h))
            noise_hits += rejected
            candidates.append({
                "member": entry["name"], "asset": label,
                "size": int(entry.get("size") or 0),
                "hits_count": len(hits),
                "all_hits_gate_rejected": rejected == len(hits),
                "truncated": bool(note),
                "hits": _summarize(hits),
            })

    candidates.sort(key=lambda c: (c["all_hits_gate_rejected"], -c["hits_count"]))
    dropped = max(0, len(candidates) - _CANDIDATE_CAP)
    out: dict[str, Any] = {
        "kind": "smb_archive_scan", "ok": True,
        "path": vi.path, "format": idx.get("format"), "size": int(size),
        "members_total": len(entries), "members_text": len(targets),
        "scanned": scanned,
        # 이름부터 텍스트가 아니라 안 연 것 / 열었더니 바이너리였던 것.
        "skipped_not_text_name": not_text_named,
        "skipped_binary_content": binary,
        "hits_total": hits_total,
        # 전송량을 밝힌다 — "통째로 안 받았다" 는 주장의 근거다.
        "bytes_transferred": pulled["bytes"],
        # 실패 사유를 밝힌다 — denied 와 not_found 와 error 는 다른 일이다.
        "read_status": dict(read_status),
        "candidates": candidates[:_CANDIDATE_CAP],
    }
    _record_read(ctx, files=scanned, read_bytes=pulled["bytes"])
    if idx.get("truncated"):
        out["index_truncated"] = True
    if dropped:
        out["candidates_omitted"] = dropped
    if noise_hits:
        out["gate_rejected_hits"] = noise_hits
    if stopped:
        out["stopped"] = stopped
    if len(targets) > vi.max_members:
        out["members_not_scanned"] = len(targets) - vi.max_members
    return out
