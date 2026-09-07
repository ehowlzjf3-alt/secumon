"""smb_task 도구셋 — #1 점검 에이전트 전용 (de-domain 엔진 런타임 바인딩).

기존 `smb_python_tool`/`smb_tools` 는 `domains.smb.plugin.agent_types.smb`/`secu_agent.state`
(모놀리스 경로)에 바인딩돼 de-domain 엔진에선 import 안 된다. E2E 파이프라인은
de-domain 엔진을 런타임 대상으로 하므로(bootstrap 이 de-domain 전용 register_* 사용),
점검 도구를 skill repo 모듈(`domains.smb.plugin.agent_types.smb` + `service.state_domain`)
에 바인딩한 self-contained 버전으로 제공한다. 엔진 무수정.

도구:
- `smb_task_python` — read 용도 자유 Python (smb/state/detectors 바인딩, lockout 가드).
- `smb_fetch_scan` — share 파일 fetch + scan_text(공정/경영 신호 포함) 한 번에 (read-only).

KEEP: read-only, lockout reactive(reset 호출 안 함), context 폭주 금지(본문 print 금지).
"""
from __future__ import annotations

import ast
import io
import json
import signal
import socket as _socket
import traceback
from contextlib import redirect_stderr, redirect_stdout
from typing import Any, ClassVar

from pydantic import BaseModel, Field

from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)

_OUTPUT_CAP_BYTES = 32 * 1024
_SOCKET_TIMEOUT_CAP_SECONDS = 8.0
# 가드 차단을 ToolError(forbidden) 로 승격시키기 위한 내부 표식.
_GUARD_MARK = "__EXEC_GUARD_BLOCKED__:"
from service.probes.exec_guard import ExecGuardBlocked as _ExecGuardBlocked  # noqa: E402


def _build_bound_api_reference() -> str:
    """sandbox 에 실제로 바인딩되는 모듈에서 시그니처를 뽑아 준다.

    배경(2026-08-17 실측): W34 재수집 후 smb 런 56건 중 **54건(96%)** 이
    `smb_task_python` 안에서 API 오류를 냈다. 상위 원인 전부가 "모양을 몰라서" 다:

        38  No module named 'state'                     ← `from state import …`
        21  files_for_share() got an unexpected keyword argument 'suspicious_only'
        10  'dict' object has no attribute 'path'       ← state.* 는 dict 를 준다
        10  directories_for_share() takes 1 positional argument but 2 were given
         5  cannot unpack non-iterable SmbFile object   ← smb.walk_share 는 객체를 준다
         5  fetch_file() missing 1 required keyword-only argument: 'max_bytes'

    이 도구의 description 은 함수 **이름만 산문으로 나열**하고 시그니처도 반환타입도
    주지 않았다. 워커는 추측할 수밖에 없었고 턴을 시행착오에 태웠다.

    ⚠️ 형제 도구 `smb_python` 에도 같은 스니펫이 있지만 거기서는 `secu_agent.state`
    (엔진 모듈)를 introspect 해서 **state 블록이 통째로 비어 나온다** — 실제 바인딩은
    다른 모듈이다. 그래서 여기서는 `execute` 가 바인딩하는 것과 **같은 모듈**을 쓴다.
    한쪽만 고치면 또 어긋나므로 아래 테스트가 둘의 일치를 검사한다.
    """
    import inspect

    lines = [
        "",
        "**바인딩된 API — 추측하지 말고 이대로 써라**",
        "",
        "⚠️ `state`/`smb`/`detectors` 는 **이미 바인딩된 객체**다. "
        "`import state` / `from state import …` 는 `No module named 'state'` 로 실패한다.",
        "⚠️ **반환형이 다르다**: `state.*` → `list[dict]` (`f['path']`, `f['id']`) · "
        "`smb.walk_share` → `SmbFile` **객체** (`f.path`, `f.size`, `f.is_text_candidate`).",
        "⚠️ `*` 뒤 인자는 **키워드 전용**이다 — 위치인자로 주면 TypeError.",
        "",
    ]
    try:
        from service import state_domain as _state
        from secu_agent import detectors as _detectors

        from domains.smb.plugin.agent_types import smb as _smb
    except Exception:  # noqa: BLE001 — 참조표가 없다고 도구가 죽으면 안 된다
        return ""

    def _sig(mod: Any, name: str) -> str | None:
        fn = getattr(mod, name, None)
        if fn is None or not callable(fn):
            return None
        try:
            return f"{name}{inspect.signature(fn)}"
        except (ValueError, TypeError):
            return None

    groups = [
        ("state", _state, [
            "files_for_share", "directories_for_share", "hits_for_file",
            "share_files_filtered", "file_get_metadata", "smb_shares_of_host",
            "shares_pending_listing_review", "files_pending_scan",
            "file_set_review", "file_set_note", "add_file_hits",
        ]),
        ("smb", _smb, [
            "walk_share", "fetch_file", "fetch_file_bytes",
            "list_shares_modes", "tcp_alive", "is_image_candidate",
        ]),
        ("detectors", _detectors, ["scan_text"]),
    ]
    for label, mod, names in groups:
        sigs = [f"{label}.{s}" for s in (_sig(mod, n) for n in names) if s]
        if not sigs:
            continue
        lines.extend([f"`{label}.*`:", "```python", *sigs, "```", ""])

    # 2차 실측(21:19 참조표 배포 후 56런): 시그니처만으로는 부족했다. 남은 오류는
    # 전부 **반환값의 모양**을 몰라서다 — 필드/키는 시그니처에 안 나온다.
    #    56  Error: 'files'                                   ← 키는 items 다
    #     7  'ScanResult' object has no attribute 'total'     ← total 은 저 dict 것
    #    10  'tuple' object has no attribute 'success'        ← fetch_file 은 튜플
    def _flds(obj: Any) -> str:
        try:
            import dataclasses
            if dataclasses.is_dataclass(obj):
                return ", ".join(f.name for f in dataclasses.fields(obj))
        except Exception:  # noqa: BLE001
            pass
        return ""

    shapes = ["**반환 모양 — 필드/키를 지어내지 마라**", "```python"]
    smb_file = getattr(_smb, "SmbFile", None)
    hit = getattr(_detectors, "Hit", None)
    if smb_file is not None and _flds(smb_file):
        shapes.append(f"smb.walk_share(...)      -> SmbFile 객체 yield: {_flds(smb_file)}")
    shapes.append(
        "smb.fetch_file(...)      -> **평문 튜플** (status, body): "
        "`status, body = smb.fetch_file(...)` · status=='text' 일 때만 body 가 본문"
    )
    fbytes = getattr(_smb, "SmbFileBytes", None)
    if fbytes is not None and _flds(fbytes):
        shapes.append(
            f"smb.fetch_file_bytes(...) -> SmbFileBytes({_flds(fbytes)})  "
            "← 본문은 .data 다ㅡ'.body' 없음"
        )
    shapes.append(
        "state.share_files_filtered(...) -> {'total': int, 'items': [ {...파일 dict...} ]}  "
        "← 키는 'items' 다ㅡ'files' 아님"
    )
    shapes.append(
        "detectors.scan_text(...) -> ScanResult(hits, has_findings, bytes_scanned)  "
        "← 개수는 len(r.hits), 'total' 없음"
    )
    if hit is not None and _flds(hit):
        shapes.append(f"  그 안의 hits[i] -> Hit({_flds(hit)})")
    shapes.extend(["```", ""])
    lines.extend(shapes)
    return "\n".join(lines)


_BOUND_API_REFERENCE = _build_bound_api_reference()


def _smb_mod():
    from domains.smb.plugin.agent_types import smb
    return smb


def _detectors_mod():
    # scan_text 는 엔진 코어 잔류 (de-domain 에도 있음).
    from secu_agent import detectors
    return detectors


# KEEP 불변식: lockout reset 은 러너가 pass 시작에 1회만. agent 코드가 exec namespace
# 의 `smb` 로 reset_auth_lockout_flag()/_AUTH_DISABLED_REASON 변경을 호출하지 못하도록
# 차단하는 read 전용 프록시. 실제 모듈은 도구 자신의 pre/post 체크에만 쓴다.
_BLOCKED_SMB_ATTRS = frozenset({
    "reset_auth_lockout_flag",        # lockout 해제 — 금지
    "_disable_auth_after_login_failure",
})


class _GuardedSmb:
    """exec namespace 노출용 smb 프록시 — lockout 변경 함수 차단(read-only)."""

    __slots__ = ("_mod",)

    def __init__(self, mod: Any) -> None:
        object.__setattr__(self, "_mod", mod)

    def __getattr__(self, name: str) -> Any:
        if name in _BLOCKED_SMB_ATTRS:
            def _blocked(*_a: Any, **_k: Any) -> None:
                raise PermissionError(
                    f"smb.{name}() 는 점검 에이전트에서 호출 금지(KEEP lockout 불변식). "
                    "lockout reset 은 수집 러너가 pass 시작에 1회만 수행한다."
                )
            return _blocked
        return getattr(object.__getattribute__(self, "_mod"), name)

    def __setattr__(self, name: str, value: Any) -> None:
        # _AUTH_DISABLED_REASON 등 모듈 전역 변경 차단.
        raise PermissionError(
            f"smb 모듈 속성 변경 금지(KEEP): {name} (lockout 상태는 모듈이 관리)."
        )


class _Timeout(BaseException):
    """SIGALRM timeout — **BaseException 파생**.

    Exception 파생이면 스니펫의 `except Exception: pass` 무한루프가 alarm 을 삼켜
    워커가 영구 hang 된다(SIGALRM 은 one-shot). BaseException 이면 삼켜지지 않는다.
    """


def _alarm_handler(signum, frame):  # pragma: no cover
    raise _Timeout("smb_task_python timeout")


def _exec_with_timeout(code: str, g: dict[str, Any], timeout_s: int) -> tuple[str, str | None]:
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    old_handler = signal.signal(signal.SIGALRM, _alarm_handler)
    signal.alarm(max(1, int(timeout_s)))
    old_socket_timeout = _socket.getdefaulttimeout()
    _socket.setdefaulttimeout(_SOCKET_TIMEOUT_CAP_SECONDS)
    try:
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            exec(code, g, g)  # noqa: S102 — 사내 인가 운영, Claude Code 모델
        return stdout_buf.getvalue(), None
    except _Timeout:
        return stdout_buf.getvalue(), f"timeout ({timeout_s}s)"
    except _ExecGuardBlocked as e:
        # 가드 차단은 성공이 아니다 — 호출측이 ToolError(forbidden) 로 변환하도록 표식.
        return stdout_buf.getvalue(), f"{_GUARD_MARK}{e}"
    except SystemExit as e:
        # 모델이 스니펫에서 exit()/sys.exit()/quit() 호출 — 조기종료 의도일 뿐인데
        # SystemExit 는 BaseException 이라 아래 `except Exception` 이 못 잡아 워커 전체가
        # 죽었다(관측: gpt-oss 가 smb_task_python 에서 exit(0) 코드를 자주 씀). stdout 을
        # 그대로 돌려주고 agent 루프를 계속한다(0/None 은 무해, 그 외는 note).
        out = stdout_buf.getvalue()
        return out, (None if e.code in (0, None)
                     else f"code called exit({e.code!r}) — 스니펫 조기종료(무시하고 계속)")
    except Exception:
        return stdout_buf.getvalue(), traceback.format_exc(limit=4)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)
        _socket.setdefaulttimeout(old_socket_timeout)


def _cap(text: str) -> str:
    if len(text) <= _OUTPUT_CAP_BYTES:
        return text
    keep = _OUTPUT_CAP_BYTES - 200
    return text[:keep] + (
        f"\n\n... [truncated — {len(text)} bytes. python-side 에서 요약/filter 해서 출력하라.]"
    )


class SmbTaskPythonInput(BaseModel):
    code: str = Field(..., max_length=30_000)
    timeout_seconds: int = Field(30, ge=1, le=60)


class SmbTaskPythonTool(Tool[SmbTaskPythonInput]):
    name: ClassVar[str] = "smb_task_python"
    domain: ClassVar[str] = "smb"
    is_read_only: ClassVar[bool] = True  # read 용도 (smb 모듈 write 미노출이 근거)
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "smb task python read walk fetch scan analyze db query"
    description: ClassVar[str] = (
        "SMB 점검용 read-only Python 실행 (큐 소비형). 자동 바인딩 namespace:\n"
        "  - `state` (service.state_domain): DB 큐/메타/hit 조회·영속 — files_for_share, "
        "hits_for_file, share_files_filtered, file_set_review, add_file_hits, "
        "smb_shares_of_host, directories_for_share 등.\n"
        "  - `smb` (domains.smb.plugin.agent_types.smb): fetch_file/walk_share/list_shares_modes "
        "(read-only 도달; 인증·lockout 가드 경유). **write/state-changing 금지.**\n"
        "  - `detectors`: scan_text(text, label=, include_document_signals=True) — "
        "secret/PII + 공정/경영 문서 신호.\n"
        "  - stdlib 은 자유. print 결과 받음(32KB cap).\n\n"
        "⚠️ **pandas·numpy·requests 는 설치돼 있지 않다**(2026-08-22 실측). import 하면 "
        "ModuleNotFoundError 로 턴 하나를 버린다. 표 계산이 필요하면 stdlib 으로 하라.\n"
        "⚠️ **로컬 DB 파일은 없다.** `sqlite3.connect('db')` 는 빈 파일을 새로 만들 뿐이고 "
        "곧바로 `no such table` 이 난다. DB 는 위 `state.*` 함수로만 접근한다 — "
        "raw SQL 커넥션은 노출되지 않는다(안전봉투).\n"
        "⚠️ 타임아웃(호스트 445 무응답)이 나면 **같은 경로를 그대로 재시도하지 마라.** "
        "느린 건 이 호출이 아니라 그 공유다 — 범위를 좁히거나(하위 디렉터리 하나) "
        "메타데이터(state)만으로 판단하고, 안 되면 그 사실을 근거에 적어라.\n\n"
        "Lockout reactive: smb._AUTH_DISABLED_REASON set 이면 거부. reset 호출 금지. "
        "본문 직접 print 금지(context 폭주) — python-side 요약만."
        + _BOUND_API_REFERENCE
    )
    input_model: ClassVar[type[BaseModel]] = SmbTaskPythonInput

    async def execute(self, vi: SmbTaskPythonInput, ctx: ToolContext) -> ToolResult:
        smb = _smb_mod()
        if smb._AUTH_DISABLED_REASON:
            return ToolError(
                kind="forbidden",
                message=f"SMB auth locked out — 실행 차단. reason: {smb._AUTH_DISABLED_REASON}",
            )
        try:
            ast.parse(vi.code, mode="exec")
        except SyntaxError as e:
            return ToolError(kind="validation", message=f"SyntaxError: {e.msg} (line {e.lineno})")

        # 안전봉투 강제: DB 드라이버 import/모듈 탈취 사전 차단(정적) — 직접 로그인으로
        # credential_login_probe 의 단발원장·scope·회로차단기를 우회하지 못하게.
        from service.probes import exec_guard
        violations = exec_guard.static_violations(vi.code)
        if violations:
            return ToolError(kind="forbidden",
                             message=exec_guard.guard_error_message(violations))

        from service import state_domain as state
        # exec namespace 에는 lockout 변경 차단 프록시를 노출 (실제 모듈은 pre/post 체크용).
        # 추가로 GuardedNamespace 로 감싸 `state.psycopg` 류 namespace 경유 드라이버 도달 차단.
        g = {
            "state": exec_guard.GuardedNamespace(state, "state"),
            "smb": exec_guard.GuardedNamespace(_GuardedSmb(smb), "smb"),
            "detectors": exec_guard.GuardedNamespace(_detectors_mod(), "detectors"),
        }
        before = smb._AUTH_DISABLED_REASON
        with exec_guard.guarded_exec():  # 런타임: DB 포트 소켓·프로세스 실행 차단
            stdout, err = _exec_with_timeout(vi.code, g, vi.timeout_seconds)
        after = smb._AUTH_DISABLED_REASON

        if err is not None and err.startswith("timeout"):
            return ToolError(kind="timeout", message=err)
        if err is not None and err.startswith(_GUARD_MARK):
            # 런타임 가드 차단 → 성공이 아니라 forbidden (계약 준수).
            return ToolError(kind="forbidden",
                             message=err[len(_GUARD_MARK):].strip() or "exec guard blocked")
        parts: list[str] = []
        if stdout:
            parts.append("[stdout]\n" + stdout.rstrip())
        if err:
            parts.append("[error]\n" + err.rstrip())
        if not parts:
            parts.append("(no output)")
        if after and not before:
            parts.append(f"[⚠ AUTH LOCKED OUT during execution]\nreason: {after}\n후속 SMB 호출 차단. 즉시 보고.")
        from secu_agent.agent.secret_redact import redact_secrets
        return ToolSuccess(content=_cap(redact_secrets("\n\n".join(parts))))


class SmbFetchScanInput(BaseModel):
    host: str
    share: str
    path: str = Field(..., description="share-root 기준 파일 경로 (예: 'finance/매출.xlsx')")
    file_id: int | None = Field(None, description="선택: smb_file.id — hit/scan 결과를 그 파일에 영속")
    max_bytes: int = Field(512 * 1024, ge=1, le=4 * 1024 * 1024)


class SmbFetchScanTool(Tool[SmbFetchScanInput]):
    name: ClassVar[str] = "smb_fetch_scan"
    domain: ClassVar[str] = "smb"
    is_read_only: ClassVar[bool] = True
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "smb fetch file read scan_text secret pii document deepdive"
    description: ClassVar[str] = (
        "SMB 파일 1개를 read-only fetch 후 scan_text(secret/PII + 공정/경영 문서신호)로 "
        "스캔한다. office/PDF 는 텍스트 추출 후 스캔. 본문 전체를 반환하지 않고 hit 요약만 "
        "(context 보호). file_id 주면 hit + scan_status 를 DB 에 영속. deepdive 용 — "
        "scan_hit/필드명/value_present 는 단서일 뿐, 실제 값 라인을 확인하라."
    )
    input_model: ClassVar[type[BaseModel]] = SmbFetchScanInput

    async def execute(self, vi: SmbFetchScanInput, ctx: ToolContext) -> ToolResult:
        import asyncio
        smb = _smb_mod()
        if smb._AUTH_DISABLED_REASON:
            return ToolError(kind="forbidden", message=f"locked out: {smb._AUTH_DISABLED_REASON}")
        try:
            status, body = await asyncio.to_thread(
                smb.fetch_file, vi.host, vi.share, vi.path, max_bytes=vi.max_bytes,
            )
        except Exception as e:  # noqa: BLE001
            return ToolError(kind="execution", message=f"fetch 실패: {e!r}")
        if status != "text":
            return ToolSuccess(content=json.dumps({
                "kind": "smb_fetch_scan", "status": status,
                "note": f"본문 텍스트 아님({status}). 이미지/PDF 는 inspect 도구로 확인.",
            }, ensure_ascii=False))

        # 본문을 실제로 열었다 — 검토원 열람 장부(코드 계측)에 센다.
        # 자기신고(files_seen)는 145회 중 0회 전달됐다(2026-08-28 실측).
        try:
            from _shared.inspector_report import record_read

            record_read(ctx, files=1,
                        read_bytes=len(body) if isinstance(body, (bytes, str)) else 0)
        except Exception:  # noqa: BLE001 — 계측 실패가 열람을 죽이지 않는다
            pass

        detectors = _detectors_mod()
        sr = detectors.scan_text(body, label=vi.path, include_document_signals=True)
        # connstring 계열 hit 의 host 가 greedy 마스킹으로 가려지는 것 legible 재구성
        # (비번만 마스킹, host/user/port 노출). 네트워크 없음 — 원문 재파싱만.
        from service.probes.hit_legibility import relegible_hits
        hits = relegible_hits(body, list(sr.hits))
        persisted = 0
        if vi.file_id is not None:
            try:
                from service import state_domain as state
                state.add_file_hits(vi.file_id, hits)
                state.file_record_scan(vi.file_id, hits_count=len(hits))
                persisted = len(hits)
            except Exception:  # noqa: BLE001
                persisted = 0
        summary = [
            {"category": h["category"], "kind": h["kind"], "masked": h["masked"],
             "line_no": h["line_no"], "line_preview": h["line_preview"]}
            for h in hits[:50]
        ]
        from secu_agent.agent.secret_redact import redact_secrets
        out = json.dumps({
            "kind": "smb_fetch_scan", "status": "text",
            "path": vi.path, "bytes": len(body),
            "hits_count": len(hits), "persisted": persisted,
            "hits": summary,
        }, ensure_ascii=False)
        return ToolSuccess(content=_cap(redact_secrets(out)))
