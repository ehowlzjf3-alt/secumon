# [REORG 3축=G] guide化 후보 — file 본문 read/metadata 절차는 코어 generic
#   host_read/python_exec + skill md 안내로 재현 가능. SMB fetch 의존만 (P, plugin/agent_types/smb.py).
#   TODO: 절차를 domains/smb/SKILL.md·snippets.md 로 흡수, 잔여 .py 최소화.
"""smb_file_inspect sub-agent 도구셋.

master 가 큰/복잡 file 만나면 delegate_file_review 로 위임 → 격리 sub-agent 가
본문 풀 액세스 + 답변 작성 → master 한테 짧은 요약만 return.

격리 이유: master 의 context 를 본문 dump 로부터 보호. 큰 .log / dump 처리 시 master 가
컨텍스트 폭발 안 함.
"""
from __future__ import annotations

import asyncio
import json as _json
from typing import ClassVar, Literal

from pydantic import BaseModel, Field

from service import state_domain as state
from secu_agent.agent.tools._untrusted import wrap_untrusted
from secu_agent.agent.tools.base import Tool, ToolContext, ToolError, ToolResult, ToolSuccess
from domains.smb.plugin.agent_types import smb
from domains.smb.plugin import archive_index


_INSPECT_LINES_MAX = 500

#: 이 크기를 넘으면 **받지 않는다**. `fetch_file` 은 전송을 안 줄이므로, 상한을 여기서
#: 강제하지 않으면 검토원 한 번 호출이 수십~수백 MB 를 끌어온다(그러고도 본문은 없다).
_INSPECT_FETCH_CAP = 8 * 1024 * 1024
#: 큰 파일에서 앞쪽만 볼 때 전송하는 양. 기존 `fetch_file` 캡과 같은 1MB 다.
_INSPECT_HEAD_BYTES = 1024 * 1024
#: 목차에 실을 엔트리 수. 큰 아카이브는 잘렸다고 말한다.
_INSPECT_INDEX_ENTRIES = 120


def _inspect_file_size(meta: dict) -> int | None:
    """DB 에 이미 있는 크기를 쓴다 — 원격 stat 왕복을 더 만들지 않는다."""
    file_id = meta.get("inspect_file_id")
    if file_id is None:
        return None
    try:
        row = state.file_get_metadata(int(file_id))
    except Exception:  # noqa: BLE001
        return None
    if not row:
        return None
    try:
        return int(row.get("size") or 0) or None
    except (TypeError, ValueError):
        return None


def _fetch_head(host: str, share: str, path: str, length: int):
    """앞 `length` 바이트만 전송해서 가져온다(ranged read) → `fetch_file` 과 같은 반환형."""
    out = smb.fetch_file_range(host, share, path, offset=0, length=length)
    if out.status == "bytes":
        return smb._classify_fetched(path, out.data)
    if out.status == "empty":
        return "empty", ""
    return out.status, out.message


def _big_file_note(path: str, size: int | None) -> str:
    """아카이브면 목차 경로를, 아니면 못 하는 사유를 붙인다. 작은 파일이면 아무 말도 안 한다."""
    if size is None or size <= _INSPECT_FETCH_CAP:
        return ""
    ok, why = archive_index.can_index(path)
    if ok:
        return ("\n[아카이브다 — `inspect_archive_index` 로 **목차**(파일명·크기) 전체를 "
                "볼 수 있다(통째로 안 받는다). 목차는 '무슨 파일인지'는 답하지만 "
                "'그 안에 시크릿이 있는지'는 답하지 않는다 — 그 한계를 보고에 적어라.]")
    if archive_index.archive_kind(path) in ("gz", "tgz", "bz2", "xz", "7z", "rar", "cab", "iso"):
        return (f"\n[{why} 확인 못 한 것을 '문제 없음'으로 적지 마라 — 못 봤다고 적어라.]")
    return ""



class ReadFileContentInput(BaseModel):
    offset: int = Field(0, ge=0, description="0-based line offset")
    limit: int = Field(200, ge=1, le=_INSPECT_LINES_MAX,
                       description=f"max {_INSPECT_LINES_MAX} lines (sub-agent 한정)")


class ReadFileContentTool(Tool[ReadFileContentInput]):
    name: ClassVar[str] = "read_file_content"
    domain: ClassVar[str] = "smb"
    description: ClassVar[str] = (
        f"inspect 중인 file 의 본문 페이지 (≤{_INSPECT_LINES_MAX} lines). UNTRUSTED 마커 포함.\n"
        "여러 번 호출 가능 (큰 file 도 페이지 단위로 다 볼 수 있음).\n"
        "text 일 때만 본문, binary/empty 면 상태만."
    )
    input_model: ClassVar[type[BaseModel]] = ReadFileContentInput
    search_hint: ClassVar[str] = "read file content full body lines"
    is_read_only: ClassVar[bool] = True

    async def execute(self, validated_input: ReadFileContentInput, context: ToolContext) -> ToolResult:
        meta = context.metadata
        host = meta.get("inspect_host")
        share = meta.get("inspect_share")
        path = meta.get("inspect_path")
        if not (host and share and path):
            return ToolError(kind="execution",
                             message="inspect context (host/share/path) not set")
        label = f"smb://{host}/{share}/{path}"

        # ★ 통짜로 당기지 않는다. `fetch_file` 의 max_bytes 는 **버퍼 상한**이지 전송량이
        #   아니다 — 130MB tar 를 1MB 캡으로 부르면 130MB 를 받아 놓고 "binary" 한 줄을
        #   돌려준다. 검토원이 큰 파일을 "안 보고 버린" 것처럼 보였던 이유가 이거다.
        #
        #   ⚠️ 그렇다고 **거부하지 않는다.** 거부하면 20MB 로그의 앞부분조차 못 본다 —
        #      기능이 줄어든다. 대신 **앞 1MB 만 ranged read** 한다(전송도 1MB 다).
        size = _inspect_file_size(meta)
        head_only = size is not None and size > _INSPECT_FETCH_CAP
        if head_only:
            status, body = await asyncio.to_thread(
                _fetch_head, host, share, path, _INSPECT_HEAD_BYTES)
        else:
            status, body = await asyncio.to_thread(
                smb.fetch_file, host, share, path, max_bytes=_INSPECT_HEAD_BYTES,
            )
        if status != "text":
            return ToolSuccess(content=wrap_untrusted(
                label, f"[no body — fetch_status={status}]" + _big_file_note(path, size),
            ))
        lines = body.splitlines()
        start = validated_input.offset
        end = min(len(lines), start + validated_input.limit)
        if start >= len(lines):
            return ToolSuccess(content=wrap_untrusted(
                label, f"[offset {start} past end (total {len(lines)} lines)]",
            ))
        snippet = "\n".join(f"{i+1:5d}| {lines[i]}" for i in range(start, end))
        footer = f"\n[shown {start}..{end} of {len(lines)} lines]"
        if head_only:
            # ★ 절단을 밝힌다. 앞 1MB 만 보고 "파일 전체를 봤다" 로 적으면 거짓 근거가 된다.
            footer += (f"\n[⚠️ 이 파일은 {size / (1024 * 1024):,.0f}MB 다 — "
                       f"앞 {_INSPECT_HEAD_BYTES // 1024}KB 만 읽었다. "
                       "뒤쪽은 확인하지 않았다.]")
        return ToolSuccess(content=wrap_untrusted(
            label, snippet + footer + _big_file_note(path, size)))


class InspectArchiveIndexInput(BaseModel):
    max_entries: int = Field(_INSPECT_INDEX_ENTRIES, ge=1, le=1000)


class InspectArchiveIndexTool(Tool[InspectArchiveIndexInput]):
    """검토 중인 파일이 아카이브면 **목차**를 낸다 — 통째로 안 받고.

    ★ 이 도구가 없어서 검토원은 130MB tar 앞에서 "SCCM 배포 패키지로 **추정**됩니다" 밖에
      쓸 수 없었다. 추정을 안 한 게 아니라 확인할 방법이 없었다. tar 는 512B 헤더 체인,
      zip 은 꼬리 중앙 디렉터리 — 둘 다 앞뒤 몇십 KB 면 목록이 나온다
      (실측 2026-08-27: 47GB tar → 384KB·0.3초 / 59.8GB zip → 1.1초).
    """

    name: ClassVar[str] = "inspect_archive_index"
    domain: ClassVar[str] = "smb"
    description: ClassVar[str] = (
        "inspect 중인 file 이 .tar/.zip 이면 **목차**(파일명·크기)를 낸다. 파일을 통째로 "
        "받지 않는다 — 47GB tar 에서 384KB 만 전송한다(실측).\n"
        "⚠️ 목차는 이름과 크기다. **내용이 아니다** — '무슨 파일인지'는 답하지만 "
        "'그 안에 시크릿이 있는지'는 답하지 않는다. 보고에 그 한계를 적어라.\n"
        "⚠️ .tar.gz/.7z/.rar/.cab/.iso 는 안 된다. 사유를 그대로 돌려주니 인용하라 — "
        "'확인 못 함'을 '문제 없음'으로 접지 마라."
    )
    input_model: ClassVar[type[BaseModel]] = InspectArchiveIndexInput
    search_hint: ClassVar[str] = "archive tar zip index listing contents large file inspect"
    is_read_only: ClassVar[bool] = True

    async def execute(
        self, validated_input: InspectArchiveIndexInput, context: ToolContext,
    ) -> ToolResult:
        meta = context.metadata
        host = meta.get("inspect_host")
        share = meta.get("inspect_share")
        path = meta.get("inspect_path")
        if not (host and share and path):
            return ToolError(kind="execution",
                             message="inspect context (host/share/path) not set")
        label = f"smb://{host}/{share}/{path}"

        # 못 하는 형식이면 세션을 열지 않는다 — 헛된 로그인이 lockout 예산을 먹는다.
        ok, why = archive_index.can_index(path)
        if not ok:
            return ToolSuccess(content=wrap_untrusted(label, f"[목차 불가 — {why}]"))

        size = _inspect_file_size(meta)
        out = await asyncio.to_thread(
            _index_archive_blocking, host, share, path, size,
            validated_input.max_entries)
        if not out.get("ok"):
            return ToolSuccess(content=wrap_untrusted(
                label, f"[목차 실패 — {out.get('detail') or '사유 미상'}]"))

        entries = out.get("entries") or []
        lines = [f"{e['size']:>14,}  {e['name']}" for e in entries]
        head = (f"[{out['format']} · 엔트리 {len(entries)}건"
                + (" (잘림 — 더 있다)" if out.get("truncated") else "")
                + f" · 전송 {out.get('bytes_transferred', 0) / 1024:,.0f}KB]")
        tail = "\n[목차는 이름과 크기다. 내용은 확인하지 않았다.]"
        return ToolSuccess(content=wrap_untrusted(
            label, head + "\n" + "\n".join(lines) + tail))


def _index_archive_blocking(
    host: str, share: str, path: str, size: int | None, max_entries: int,
) -> dict:
    pulled = {"bytes": 0}
    #: 읽기 실패 사유별 횟수 — reader 가 None 으로 뭉개기 전에 세워 둔다.
    read_status: dict[str, int] = {}
    with smb.open_session(host) as conn:
        real = size or smb._remote_file_size(conn, share, path.replace("/", "\\"))
        if not real:
            return {"ok": False,
                    "detail": "원격 크기를 못 읽었다 — zip 은 크기 없이 꼬리를 못 찾는다"}

        def reader(offset: int, length: int) -> bytes | None:
            status, payload = smb.read_range_on(
                conn, share, path, offset=offset, length=length)
            if status == "bytes" and isinstance(payload, bytes):
                pulled["bytes"] += len(payload)
                return payload
            if status == "empty":
                return b""
            # ★ 못 읽음 — 빈 아카이브와 구분한다. 사유까지 남긴다(같은 결함 3곳 공유).
            read_status[str(status)] = read_status.get(str(status), 0) + 1
            return None

        out = archive_index.index_archive(
            path, reader, size=int(real), max_entries=max_entries)
    out["bytes_transferred"] = pulled["bytes"]
    out["read_status"] = dict(read_status)
    return out


_INSPECT_SEVERITY = Literal[
    "critical", "high", "medium", "low", "clean", "informational",
]


class ReportInspectionInput(BaseModel):
    answer: str = Field(..., min_length=1, max_length=800,
                        description="master 가 던진 question 에 대한 답변 (≤500자 권장).")
    severity: _INSPECT_SEVERITY
    key_evidence: list[str] = Field(
        default_factory=list, max_length=10,
        description="본문에서 본 핵심 라인 / 패턴 (마스킹된 형태) — master 의 의사결정에 도움.",
    )
    tags: list[str] | None = Field(None, max_length=10)
    note: str | None = Field(None, max_length=400)


class ReportInspectionTool(Tool[ReportInspectionInput]):
    name: ClassVar[str] = "report_inspection"
    domain: ClassVar[str] = "smb"
    description: ClassVar[str] = (
        "TERMINAL — sub-agent 의 inspection 결과를 master 한테 보고하고 종료.\n"
        "1) state.file_set_review 로 file finding 영속화\n"
        "2) evidence_dir/inspection_result.json 작성 (delegate tool 이 read)\n"
        "한 번 호출하면 즉시 종료. answer 는 master 가 받을 짧은 요약."
    )
    input_model: ClassVar[type[BaseModel]] = ReportInspectionInput
    search_hint: ClassVar[str] = "report inspection terminate done finalize answer"
    is_read_only: ClassVar[bool] = False

    async def execute(self, validated_input: ReportInspectionInput, context: ToolContext) -> ToolResult:
        meta = context.metadata
        file_id = meta.get("inspect_file_id")
        if file_id is None:
            return ToolError(kind="execution",
                             message="inspect_file_id not set in context")
        question = meta.get("inspect_question", "")

        # DB 영속화
        summary_for_db = validated_input.answer[:380]
        try:
            await asyncio.to_thread(
                state.file_set_review, int(file_id),  # type: ignore[arg-type]
                severity=validated_input.severity,
                summary=summary_for_db,
                tags=validated_input.tags,
                note=validated_input.note,
                overwrite=True,
            )
        except Exception as e:
            return ToolError(kind="execution", message=f"db write failed: {e!r}")

        # delegate tool 이 읽을 result file
        result_payload = {
            "file_id": int(file_id),  # type: ignore[arg-type]
            "question": question,
            "answer": validated_input.answer,
            "severity": validated_input.severity,
            "key_evidence": validated_input.key_evidence,
            "tags": validated_input.tags or [],
            "note": validated_input.note,
        }
        try:
            result_path = context.evidence_dir / "inspection_result.json"
            result_path.write_text(
                _json.dumps(result_payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            return ToolError(kind="execution", message=f"result file write failed: {e!r}")

        return ToolSuccess(
            content=f"inspection reported (severity={validated_input.severity}, "
                    f"evidence_lines={len(validated_input.key_evidence)})",
        )
