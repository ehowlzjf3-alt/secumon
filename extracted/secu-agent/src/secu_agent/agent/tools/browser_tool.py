"""v3.24-D: Playwright browser tools.

operator 가 web/외부 사이트 (사내 웹 콘솔/대시보드 등) 를 사람처럼 탐색.
hermes-agent 의 거대한 browser_supervisor (6500줄) 까지는 안 가고, 핵심 3개 도구로 압축:

- `BrowserSessionTool` — start / stop / status. 세션 생명주기.
- `BrowserActionTool` — navigate / click / fill / press / scroll. 상태 변경.
- `BrowserQueryTool` — snapshot / html / screenshot / eval. 상태 조회.

설계:
- module-level singleton state (한 process 안에 1 browser context). asyncio.Lock 으로 직렬화.
- Playwright headless chromium 디폴트. `SA_BROWSER_HEADLESS=false` 면 headed (디버깅).
- 모든 URL 은 `url_safety.validate_url_safe` 통과 (loopback / link-local / file:// 차단).
- 결과 직렬화는 chars 기준 cap — context 폭주 방지.
- credential 은 환경변수로만 (`SA_BROWSER_BASIC_AUTH_USER`, `SA_BROWSER_BASIC_AUTH_PASS`).
  agent input 으로 password 받지 않음.
- 스크린샷은 `ctx.evidence_dir / browser_screenshots/` 로만 저장 (host_write 와 별도).

가드:
- browser 는 enterprise tasking 핵심 toolset 이라 operator registry 에 상시 노출.
- destructive 마킹 (navigate 빼곤 다 fill/click 등 사이드이펙트).
- timeout cap 30s.
"""
from __future__ import annotations

import asyncio
from collections import deque
import contextlib
import base64
import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path
from collections.abc import Callable
from typing import Any, ClassVar, Literal
from urllib.parse import urlparse
from uuid import uuid4

from pydantic import BaseModel, Field

from secu_agent.agent.semantic_validation import (
    scan_sensitive_signals,
)
from secu_agent.agent.tools.base import (
    PermissionDecision, Tool, ToolContext, ToolError, ToolImage, ToolResult, ToolSuccess,
)
from secu_agent.agent.tools.host_tools import (
    PathBlockError, _resolve_abs, _validate_for_write,
)
from secu_agent.agent.tools.url_safety import (
    URLSafetyError, validate_url_safe, validate_url_safe_hardblock,
    validate_url_safe_hardblock_resolved, validate_url_safe_resolved,
)
from secu_agent.detectors.text_scan import (
    mask_credential_urls,
    mask_scanned_text,
    scan_file as _scan_file,
)
from secu_agent.agent import process_registry as _procreg

logger = logging.getLogger(__name__)


# ============================================================
# Module-level browser state
# ============================================================

_BROWSER_LOCK = asyncio.Lock()
_SESSION_STATE: dict[str, Any] = {
    "playwright": None,  # Playwright instance
    "browser": None,     # Browser instance
    "context": None,     # BrowserContext
    "page": None,        # Active Page
    "started_at": None,  # ISO timestamp
    "last_used": None,   # v3.69: time.monotonic() of last real op — idle reaper 용
    "navigations": 0,
    "last_screenshot": None,
    "ref_map": {},       # @e1 -> {"selector": "...", "label": "..."}
    "ref_url": "",
    "evidence_dir": None,
    "login_fail_streak": 0,   # 연속 로그인 실패 — 회로차단기
    "login_halted": False,    # streak 임계 도달 시 모든 로그인 차단
    "injected_session": None, # v3.67: 사전 인증 세션 주입됨 {mode,count,source} (값 X)
    "browser_pid": None,      # F5-B: CDP 로 얻은 실제 chromium browser OS PID
    "owner_token": None,      # F5-B: 이 프로세스가 띄운 것임을 확증하는 랜덤 토큰
}
# 연속 실패 임계 — 도달 시 lockout 방지 위해 모든 로그인 시도 중단.
_LOGIN_FAIL_LIMIT = 5

# F5-B: 프로세스당 1회 고아 chromium reap latch — 모든 동시 호출자가 **동일 in-flight
# task 를 await** 한다(codex 리뷰: bool 플래그는 reap 완료 전 True 라 경합). launch 는
# 이 task 완료를 기다린 뒤 진행하므로 곧 띄울 browser 를 죽일 수 없다.
_browser_orphan_reap_task: "asyncio.Task[None] | None" = None


def _browser_registry_dir() -> Path:
    """소유 chromium registry 디렉토리 (프로세스별 파일). 기동 시 여기서 고아 회수."""
    raw = os.environ.get("SA_BROWSER_PROC_REGISTRY_DIR")
    base = Path(raw).expanduser() if raw else (
        Path(os.environ.get("XDG_CACHE_HOME", "~/.cache")).expanduser()
        / "secu-agent" / "browser_procs"
    )
    return base


def _browser_registry_path() -> Path:
    """이 프로세스 전용 registry 파일 (owner pid 로 네이밍 — 동시쓰기 없음)."""
    return _browser_registry_dir() / f"browser-{os.getpid()}.json"


async def reap_orphan_browsers_once() -> None:
    """프로세스당 1회 — 직전 crash 가 남긴 고아 chromium 을 launch 前에 회수.
    모든 entrypoint(web/worker/chat)가 첫 browser start 시 자동 통과. 동기 grace-
    sleep 이 이벤트루프를 막지 않도록 thread offload. 동시 호출은 동일 task 를 await."""
    global _browser_orphan_reap_task
    if _browser_orphan_reap_task is None:
        async def _do() -> None:
            try:
                await asyncio.to_thread(
                    _procreg.reap_orphaned_in_dir, _browser_registry_dir(),
                    glob="browser-*.json", require_kind="browser",
                )
            except Exception as e:  # noqa: BLE001 — 백스톱, 실패가 헌트 막지 않음
                logger.warning("고아 chromium reap 실패 (무시): %r", e)
        _browser_orphan_reap_task = asyncio.ensure_future(_do())
    # shield: 한 호출자의 취소가 공통 reap task(및 이후 모든 호출)를 영구 취소시키지
    # 않도록(codex 리뷰). 이 await 만 취소되고 공통 task 는 계속 완료된다.
    await asyncio.shield(_browser_orphan_reap_task)


def _browser_pid_user_data_dir(pid: int) -> str | None:
    """chromium PID 의 cmdline 에서 --user-data-dir 을 정확히 하나 캡처(profile 검증용).
    0개/여러 개면 None(모호 — 등록 시 profile 검증 비활성)."""
    dirs = [
        a.split("=", 1)[1] for a in _procreg.proc_cmdline(pid)
        if a.startswith("--user-data-dir=")
    ]
    return dirs[0] if len(dirs) == 1 else None


async def _register_browser_process(browser: Any, token: str) -> int | None:
    """CDP `SystemInfo.getProcessInfo` 로 실제 chromium browser PID 를 얻어 registry 에
    등록. 모호(browser proc ≠ 1)·token 불일치·기록 실패 → None(등록 생략 = 미관리).
    반환: 등록·기록 성공 시 browser PID, 아니면 None."""
    try:
        cdp = await browser.new_browser_cdp_session()
        info = await cdp.send("SystemInfo.getProcessInfo")
    except Exception as e:  # noqa: BLE001
        logger.warning("browser PID 획득 실패(CDP): %r", e)
        return None
    procs = info.get("processInfo", []) if isinstance(info, dict) else []
    browser_pids = [
        p["id"] for p in procs
        if isinstance(p, dict) and p.get("type") == "browser"
        and isinstance(p.get("id"), int)
    ]
    if len(browser_pids) != 1:
        logger.warning("browser PID 모호(%d개) — 등록 생략", len(browser_pids))
        return None
    pid = browser_pids[0]
    # 확증: /proc/<pid>/environ 의 owner token 이 우리 것과 일치해야 우리가 띄운 것.
    if _procreg.proc_environ_var(pid, _procreg.OWNER_TOKEN_ENV) != token:
        logger.warning("browser PID %s owner token 불일치 — 등록 생략", pid)
        return None
    try:
        ok = _procreg.ProcessRegistry(_browser_registry_path()).register(
            pid, token=token, kind="browser",
            profile_dir=_browser_pid_user_data_dir(pid),
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("browser registry 등록 실패: %r", e)
        return None
    if not ok:  # 파일 기록 실패 → 미등록 취급(성공 PID 로 보고 안 함)
        logger.warning("browser registry 기록 실패 — 미관리 browser")
        return None
    return pid


def _unregister_browser_process() -> None:
    """browser 가 **실제로 종료됐을 때만** registry 에서 제거. close 실패/취소로 아직
    살아있으면 유지 → 다음 기동 reaper 가 회수(codex 리뷰: 살아있는 PID 오삭제 금지)."""
    pid = _SESSION_STATE.get("browser_pid")
    if not isinstance(pid, int):
        return
    # **확실히 종료(gone)됐을 때만** 제거. exists/unknown(권한·parse 실패 포함)은
    # 살아있을 수 있으므로 registry 유지 → 다음 기동 reaper 가 회수(codex 리뷰).
    if _procreg._proc_exists_status(pid) != "gone":
        return
    with contextlib.suppress(Exception):
        _procreg.ProcessRegistry(_browser_registry_path()).unregister(pid)
_BROWSER_EVENTS: deque[dict[str, Any]] = deque(maxlen=100)
_BROWSER_NETWORK_EVENTS: deque[dict[str, Any]] = deque(maxlen=500)
_BROWSER_DYNAMIC_RESPONSE_EVENTS: deque[dict[str, Any]] = deque(maxlen=200)
_BROWSER_CONSOLE_EVENTS: deque[dict[str, Any]] = deque(maxlen=200)
_BROWSER_FRAME_EVENTS: deque[dict[str, Any]] = deque(maxlen=200)
_BROWSER_DIALOG_EVENTS: deque[dict[str, Any]] = deque(maxlen=100)
_BROWSER_DOWNLOAD_EVENTS: deque[dict[str, Any]] = deque(maxlen=100)

_DEFAULT_PORTS = {"http": 80, "https": 443}
_DYNAMIC_RESPONSE_RESOURCE_TYPES = {"xhr", "fetch"}
_DYNAMIC_RESPONSE_BODY_CEILING_DEFAULT_BYTES = 25 * 1024 * 1024
_DYNAMIC_RESPONSE_SAMPLE_CHARS = 800
_DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT_LIMIT = 8
_DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT = 0
_DYNAMIC_RESPONSE_CAPTURE_TASKS: set[asyncio.Task[Any]] = set()
_BROWSER_DYNAMIC_RESPONSE_SEQ = 0
_API_PATH_RE = re.compile(r"(^|/)(api|graphql|v[0-9]+)(/|$)", re.IGNORECASE)
_API_JSON_PATH_RE = re.compile(r"\.json($|[?#])", re.IGNORECASE)


def _now_iso() -> str:
    from datetime import UTC, datetime
    return datetime.now(UTC).isoformat()


def _is_running() -> bool:
    return _SESSION_STATE["browser"] is not None


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _remember_evidence_dir(ctx: Any) -> None:
    evidence_dir = getattr(ctx, "evidence_dir", None)
    if evidence_dir is not None:
        _SESSION_STATE["evidence_dir"] = Path(evidence_dir)


def _is_loopback_test_url(url: str) -> bool:
    parsed = urlparse(url.strip())
    if parsed.scheme.lower() not in _ALLOWED_BROWSER_TEST_SCHEMES:
        return False
    host = (parsed.hostname or "").lower()
    if host in {"localhost", "::1"}:
        return True
    try:
        import ipaddress
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


_ALLOWED_BROWSER_TEST_SCHEMES = {"http", "https"}


def _validate_browser_url_safe(url: str) -> None:
    """Browser navigation URL guard.

    Production follows the shared web URL guard exactly. Tests may opt into
    loopback HTTP(S) navigation with SA_BROWSER_ALLOW_LOOPBACK_FOR_TESTS=true
    so Playwright snapshot/screenshot behavior can be integration-tested
    without weakening the normal web tools.
    """
    try:
        validate_url_safe_resolved(url)  # audit #7: +DNS 재바인딩 검사
    except URLSafetyError:
        if _truthy_env("SA_BROWSER_ALLOW_LOOPBACK_FOR_TESTS") and _is_loopback_test_url(url):
            return
        raise


def _record_browser_event(
    *,
    kind: str,
    action: str,
    ok: bool,
    message: str = "",
    url: str | None = None,
    artifact: str | None = None,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "ts": _now_iso(),
        "kind": kind,
        "action": action,
        "ok": ok,
        "message": message,
    }
    if url:
        event["url"] = url[:2048]
    if artifact:
        event["artifact"] = artifact
    _BROWSER_EVENTS.append(event)
    return event


def _sanitize_browser_url(url: str | None) -> str:
    if not url:
        return ""
    return mask_credential_urls(str(url).strip())[:2048]


def _record_browser_network_event(
    *,
    phase: str,
    url: str | None,
    method: str | None = None,
    status: int | None = None,
    resource_type: str | None = None,
    failure: str | None = None,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "ts": _now_iso(),
        "phase": phase,
        "url": _sanitize_browser_url(url),
    }
    if method:
        event["method"] = str(method)[:16]
    if status is not None:
        event["status"] = int(status)
    if resource_type:
        event["resource_type"] = str(resource_type)[:64]
    if failure:
        event["failure"] = str(failure)[:500]
    _BROWSER_NETWORK_EVENTS.append(event)
    return event


def _dynamic_response_body_ceiling_bytes() -> int:
    raw = os.environ.get("SA_BROWSER_DYNAMIC_RESPONSE_BODY_CEILING_BYTES", "").strip()
    try:
        value = int(raw) if raw else _DYNAMIC_RESPONSE_BODY_CEILING_DEFAULT_BYTES
    except ValueError:
        value = _DYNAMIC_RESPONSE_BODY_CEILING_DEFAULT_BYTES
    return max(1024, value)


def _origin_tuple(value: str) -> tuple[str, str, int] | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = urlparse(raw if "://" in raw else f"https://{raw}")
    except Exception:
        return None
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").lower()
    if not scheme or not host:
        return None
    port = parsed.port if parsed.port is not None else _DEFAULT_PORTS.get(scheme)
    if port is None:
        return None
    return scheme, host, int(port)


def _same_origin_browser_url(left: str, right: str) -> bool:
    left_origin = _origin_tuple(left)
    right_origin = _origin_tuple(right)
    return bool(left_origin and right_origin and left_origin == right_origin)


def _header_value(headers: dict[str, Any], name: str) -> str:
    target = name.lower()
    for key, value in headers.items():
        if str(key).lower() == target:
            return str(value or "")
    return ""


def _content_length(headers: dict[str, Any]) -> int | None:
    raw = _header_value(headers, "content-length").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _dynamic_response_content_type_allowed(content_type: str) -> bool:
    lower = str(content_type or "").lower()
    if not lower:
        return True
    media_type = lower.split(";", 1)[0].strip()
    if media_type.startswith("text/"):
        return True
    return any(token in media_type for token in (
        "json", "+json", "xml", "javascript", "x-www-form-urlencoded",
    ))


def _dynamic_hits_to_dicts(hits: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "category": h.category,
            "kind": h.kind,
            "masked": mask_scanned_text(str(h.masked or ""), max_chars=300),
            "line_no": h.line_no,
            "line_preview": mask_scanned_text(str(h.line_preview or ""), max_chars=300),
        }
        for h in hits
    ]


def _mask_dynamic_text(text: str) -> str:
    return mask_scanned_text(str(text or ""), max_chars=_DYNAMIC_RESPONSE_SAMPLE_CHARS)


def _sanitize_dynamic_sensitive_signals(
    signals: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    sanitized: list[dict[str, Any]] = []
    for signal in signals:
        clean = dict(signal)
        if "masked" in clean:
            clean["masked"] = mask_scanned_text(str(clean.get("masked") or ""), max_chars=300)
        if "context" in clean:
            clean["context"] = _mask_dynamic_text(str(clean.get("context") or ""))[:300]
        if "location" in clean:
            clean["location"] = mask_scanned_text(str(clean.get("location") or ""), max_chars=2048)
        sanitized.append(clean)
    return sanitized


def _record_browser_dynamic_response_event(
    *,
    url: str,
    method: str | None,
    status: int | None,
    resource_type: str | None,
    content_type: str,
    body_length: int,
    bytes_scanned: int,
    body_truncated: bool,
    body_sha256: str,
    body_sample_masked: str,
    scan_hits: list[dict[str, Any]],
    body_path: str | None = None,
    sensitive_signals: list[dict[str, Any]] | None = None,
    capture_error: str | None = None,
) -> dict[str, Any]:
    global _BROWSER_DYNAMIC_RESPONSE_SEQ
    _BROWSER_DYNAMIC_RESPONSE_SEQ += 1
    event: dict[str, Any] = {
        "seq": _BROWSER_DYNAMIC_RESPONSE_SEQ,
        "ts": _now_iso(),
        "url": _sanitize_browser_url(url),
        "method": str(method or "GET")[:16].upper(),
        "status": int(status) if status is not None else None,
        "resource_type": str(resource_type or "")[:64],
        "content_type": str(content_type or "")[:120],
        "body_length": int(body_length),
        "bytes_scanned": int(bytes_scanned),
        "body_truncated": bool(body_truncated),
        "body_sha256": body_sha256,
        "body_sample_masked": mask_scanned_text(
            body_sample_masked, max_chars=_DYNAMIC_RESPONSE_SAMPLE_CHARS,
        ),
        "scan_hits": scan_hits,
        "sensitive_signals": sensitive_signals or [],
    }
    if body_path:
        event["body_path"] = str(body_path)[:2048]
    if capture_error:
        event["capture_error"] = str(capture_error)[:200]
    _BROWSER_DYNAMIC_RESPONSE_EVENTS.append(event)
    return event


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value


def _response_headers(resp: Any) -> dict[str, Any]:
    headers = _maybe_value(resp, "headers", {})
    if isinstance(headers, dict):
        return headers
    return {}


def _bytes_from_dynamic_chunk(chunk: Any) -> bytes:
    if isinstance(chunk, bytes):
        return chunk
    if isinstance(chunk, bytearray):
        return bytes(chunk)
    if isinstance(chunk, memoryview):
        return chunk.tobytes()
    if isinstance(chunk, str):
        return chunk.encode("utf-8", errors="replace")
    return bytes(chunk or b"")


def _dynamic_response_evidence_dir(evidence_dir: Path | None) -> Path | None:
    root = evidence_dir or _SESSION_STATE.get("evidence_dir")
    if root is None:
        return None
    out_dir = Path(root) / "browser_dynamic_responses"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def _dynamic_response_body_path(evidence_dir: Path, url: str) -> Path:
    parsed = urlparse(str(url or ""))
    suffix = ".body"
    path = (parsed.path or "").lower()
    content_suffix = Path(path).suffix
    if content_suffix in {".json", ".txt", ".xml", ".js", ".html", ".htm"}:
        suffix = content_suffix
    return evidence_dir / f"response_{uuid4().hex[:12]}{suffix}"


async def _write_stream_to_file(stream: Any, path: Path, ceiling: int) -> dict[str, Any] | None:
    read = getattr(stream, "read", None)
    if callable(read):
        total = 0
        truncated = False
        sha = hashlib.sha256()
        with path.open("wb") as fh:
            while total < ceiling:
                chunk = await _maybe_await(read(min(1024 * 1024, ceiling - total)))
                if not chunk:
                    break
                data = _bytes_from_dynamic_chunk(chunk)
                remaining = ceiling - total
                piece = data[:remaining]
                fh.write(piece)
                sha.update(piece)
                total += len(piece)
                if len(data) > remaining:
                    truncated = True
                    break
            else:
                truncated = True
        return {
            "body_path": path,
            "body_length": total,
            "bytes_written": total,
            "body_truncated": truncated,
            "body_sha256": sha.hexdigest() if total else "",
            "capture_error": None,
            "skipped": False,
        }

    iter_chunked = getattr(stream, "iter_chunked", None)
    if callable(iter_chunked):
        total = 0
        truncated = False
        sha = hashlib.sha256()
        with path.open("wb") as fh:
            async for chunk in iter_chunked(1024 * 1024):
                data = _bytes_from_dynamic_chunk(chunk)
                remaining = ceiling - total
                piece = data[:remaining]
                fh.write(piece)
                sha.update(piece)
                total += len(piece)
                if len(data) > remaining or total >= ceiling:
                    truncated = True
                    break
        return {
            "body_path": path,
            "body_length": total,
            "bytes_written": total,
            "body_truncated": truncated,
            "body_sha256": sha.hexdigest() if total else "",
            "capture_error": None,
            "skipped": False,
        }

    return None


async def _write_materialized_body_to_file(body_func: Any, path: Path) -> dict[str, Any]:
    raw = await _maybe_await(body_func())
    body = _bytes_from_dynamic_chunk(raw)
    path.write_bytes(body)
    return {
        "body_path": path,
        "body_length": len(body),
        "bytes_written": len(body),
        "body_truncated": False,
        "body_sha256": hashlib.sha256(body).hexdigest() if body else "",
        "capture_error": None,
        "skipped": False,
    }


async def _write_dynamic_response_body_to_file(
    resp: Any,
    *,
    evidence_dir: Path,
    url: str,
    ceiling: int,
    content_length: int | None,
) -> dict[str, Any]:
    body_path = _dynamic_response_body_path(evidence_dir, url)

    for attr in ("content", "stream"):
        stream = getattr(resp, attr, None)
        if stream is None or callable(stream):
            continue
        streamed = await _write_stream_to_file(stream, body_path, ceiling)
        if streamed is not None:
            if content_length is not None:
                streamed["body_length"] = max(int(content_length), int(streamed["body_length"]))
                streamed["body_truncated"] = int(content_length) > int(streamed["bytes_written"])
            return streamed

    if content_length is not None and content_length > ceiling:
        return {
            "body_path": None,
            "body_length": int(content_length),
            "bytes_written": 0,
            "body_truncated": True,
            "body_sha256": "",
            "capture_error": "response content-length exceeds capture ceiling",
            "skipped": True,
        }

    body_func = getattr(resp, "body", None)
    if not callable(body_func):
        return {
            "body_path": None,
            "body_length": int(content_length or 0),
            "bytes_written": 0,
            "body_truncated": False,
            "body_sha256": "",
            "capture_error": "response body unavailable",
            "skipped": True,
        }

    written = await _write_materialized_body_to_file(body_func, body_path)
    actual_length = int(written["bytes_written"])
    written["body_length"] = max(int(content_length or 0), actual_length)
    written["body_truncated"] = bool(content_length is not None and content_length > actual_length)
    return written


def _sample_dynamic_response_file(path: Path) -> tuple[bytes, str]:
    with path.open("rb") as fh:
        sample = fh.read(8192)
    text = sample.decode("utf-8", errors="replace")
    return sample, mask_scanned_text(
        text,
        max_chars=_DYNAMIC_RESPONSE_SAMPLE_CHARS,
    )


async def _capture_dynamic_response_body(
    page: Any,
    resp: Any,
    *,
    page_url: str | None = None,
    evidence_dir: Path | None = None,
) -> None:
    """Capture same-origin XHR/fetch JSON/text bodies as file-scan evidence."""
    try:
        req = _maybe_value(resp, "request", None)
        resource_type = str(
            _maybe_value(req, "resource_type", "") if req is not None else ""
        ).lower()
        if resource_type not in _DYNAMIC_RESPONSE_RESOURCE_TYPES:
            return

        url = str(_maybe_value(resp, "url", "") or _maybe_value(req, "url", "") or "")
        origin_url = page_url if page_url is not None else _safe_page_url(page)
        if not _same_origin_browser_url(origin_url, url):
            return

        headers = _response_headers(resp)
        content_type = _header_value(headers, "content-type")
        ceiling = _dynamic_response_body_ceiling_bytes()
        content_length = _content_length(headers)
        textual_type = _dynamic_response_content_type_allowed(content_type)
        out_dir = _dynamic_response_evidence_dir(evidence_dir)
        if out_dir is None:
            _record_browser_dynamic_response_event(
                url=url,
                method=_maybe_value(req, "method", None) if req is not None else None,
                status=_maybe_value(resp, "status", None),
                resource_type=resource_type,
                content_type=content_type,
                body_length=int(content_length or 0),
                bytes_scanned=0,
                body_truncated=False,
                body_sha256="",
                body_sample_masked="",
                scan_hits=[],
                capture_error="response body evidence directory unavailable",
            )
            return

        capture = await _write_dynamic_response_body_to_file(
            resp,
            evidence_dir=out_dir,
            url=url,
            ceiling=ceiling,
            content_length=content_length,
        )
        body_path = capture.get("body_path")
        if capture.get("skipped") or body_path is None:
            _record_browser_dynamic_response_event(
                url=url,
                method=_maybe_value(req, "method", None) if req is not None else None,
                status=_maybe_value(resp, "status", None),
                resource_type=resource_type,
                content_type=content_type,
                body_length=int(capture.get("body_length") or 0),
                bytes_scanned=0,
                body_truncated=bool(capture.get("body_truncated")),
                body_sha256="",
                body_sample_masked="",
                scan_hits=[],
                capture_error=str(capture.get("capture_error") or "body not read"),
            )
            return

        body_file = Path(body_path)
        body_length = int(capture.get("body_length") or body_file.stat().st_size)
        body_sha256 = str(capture.get("body_sha256") or "")
        body_truncated = bool(capture.get("body_truncated"))
        sample_bytes, sample_masked = _sample_dynamic_response_file(body_file)
        sample_text = sample_bytes.decode("utf-8", errors="replace")
        binary = sample_bytes.count(b"\x00") > 4
        if binary or not textual_type:
            _record_browser_dynamic_response_event(
                url=url,
                method=_maybe_value(req, "method", None) if req is not None else None,
                status=_maybe_value(resp, "status", None),
                resource_type=resource_type,
                content_type=content_type,
                body_length=body_length,
                bytes_scanned=0,
                body_truncated=body_truncated,
                body_sha256=body_sha256,
                body_sample_masked="",
                scan_hits=[],
                body_path=str(body_file),
                capture_error="binary response omitted",
            )
            return

        scan = _scan_file(body_file, label=_sanitize_browser_url(url))
        hits = list(scan.hits)
        _record_browser_dynamic_response_event(
            url=url,
            method=_maybe_value(req, "method", None) if req is not None else None,
            status=_maybe_value(resp, "status", None),
            resource_type=resource_type,
            content_type=content_type,
            body_length=body_length,
            bytes_scanned=scan.bytes_scanned,
            body_truncated=body_truncated,
            body_sha256=body_sha256,
            body_sample_masked=sample_masked,
            scan_hits=_dynamic_hits_to_dicts(hits),
            body_path=str(body_file),
            sensitive_signals=_sanitize_dynamic_sensitive_signals(
                scan_sensitive_signals(sample_text, location=_sanitize_browser_url(url)),
            ),
        )
    except Exception:
        logger.debug("dynamic response body capture failed", exc_info=True)


def _schedule_dynamic_response_capture(
    page: Any,
    resp: Any,
    *,
    page_url: str,
    evidence_dir: Path | None = None,
) -> None:
    global _DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT
    if _DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT >= _DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT_LIMIT:
        logger.debug("dynamic response capture skipped: in-flight limit reached")
        return

    async def _runner() -> None:
        global _DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT
        try:
            await _capture_dynamic_response_body(
                page,
                resp,
                page_url=page_url,
                evidence_dir=evidence_dir,
            )
        finally:
            _DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT = max(
                0, _DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT - 1,
            )

    # 카운터 누수 방지(증가/감소 엄격 페어링): create_task 가 실패(no running
    # loop 등)하면 in-flight 를 절대 올리지 않는다. 감소는 오직 _runner 의
    # finally 가 담당하므로, 증가는 태스크가 성공적으로 시작된 뒤에만 한다.
    # (예전처럼 create_task 를 증가 뒤에 두면 예외 시 감소가 영영 안 일어나
    #  카운터가 한도에 눌러붙어 이후 모든 캡처가 skip → 브라우저가 상시 busy
    #  로 보이게 된다.)
    # 단일 스레드 asyncio 라 _runner 코루틴은 이 동기 함수가 반환하고 루프가
    # 양보한 뒤에야 실행되므로, create_task 직후의 증가는 감소보다 항상 앞선다.
    task = asyncio.create_task(_runner())
    _DYNAMIC_RESPONSE_CAPTURE_IN_FLIGHT += 1
    _DYNAMIC_RESPONSE_CAPTURE_TASKS.add(task)
    task.add_done_callback(_DYNAMIC_RESPONSE_CAPTURE_TASKS.discard)


def _dynamic_response_events_for_origin(
    origin_url: str, *, start_seq: int = 0, limit: int | None = None,
) -> list[dict[str, Any]]:
    events = list(_BROWSER_DYNAMIC_RESPONSE_EVENTS)
    matches = [
        dict(event) for event in events
        if int(event.get("seq") or 0) > int(start_seq)
        if _same_origin_browser_url(origin_url, str(event.get("url") or ""))
    ]
    if limit is None:
        return matches
    return matches[:max(0, int(limit))]


def _dynamic_response_current_seq() -> int:
    return int(_BROWSER_DYNAMIC_RESPONSE_SEQ)


def _record_browser_console_event(
    *,
    level: str,
    text: str,
    url: str | None = None,
    location: dict[str, Any] | None = None,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "ts": _now_iso(),
        "level": str(level or "log")[:32],
        "text": str(text or "")[:2000],
    }
    if url:
        event["url"] = _sanitize_browser_url(url)
    if location:
        event["location"] = {
            "url": _sanitize_browser_url(str(location.get("url") or "")),
            "line_number": location.get("lineNumber") or location.get("line_number"),
            "column_number": location.get("columnNumber") or location.get("column_number"),
        }
    _BROWSER_CONSOLE_EVENTS.append(event)
    return event


def _record_browser_frame_event(
    *,
    phase: str,
    url: str | None,
    name: str | None = None,
    parent_url: str | None = None,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "ts": _now_iso(),
        "phase": str(phase or "")[:64],
        "url": _sanitize_browser_url(url),
    }
    if name:
        event["name"] = str(name)[:200]
    if parent_url:
        event["parent_url"] = _sanitize_browser_url(parent_url)
    _BROWSER_FRAME_EVENTS.append(event)
    return event


def _record_browser_dialog_event(
    *,
    phase: str,
    dialog_type: str,
    message: str,
    default_value: str | None = None,
    url: str | None = None,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "ts": _now_iso(),
        "phase": str(phase or "")[:64],
        "type": str(dialog_type or "")[:64],
        "message": str(message or "")[:2000],
    }
    if default_value:
        event["default_value"] = str(default_value)[:500]
    if url:
        event["url"] = _sanitize_browser_url(url)
    _BROWSER_DIALOG_EVENTS.append(event)
    return event


def _record_browser_download_event(
    *,
    phase: str,
    url: str | None,
    suggested_filename: str | None = None,
    failure: str | None = None,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "ts": _now_iso(),
        "phase": str(phase or "")[:64],
        "url": _sanitize_browser_url(url),
    }
    if suggested_filename:
        event["suggested_filename"] = Path(str(suggested_filename)).name[:255]
    if failure:
        event["failure"] = str(failure)[:500]
    _BROWSER_DOWNLOAD_EVENTS.append(event)
    return event


def _maybe_value(obj: Any, name: str, default: Any = None) -> Any:
    try:
        value = getattr(obj, name, default)
        if callable(value):
            return value()
        return value
    except Exception:
        return default


def _attach_page_observers(page: Any) -> None:
    on = getattr(page, "on", None)
    if not callable(on):
        return

    def _on_request(req: Any) -> None:
        _record_browser_network_event(
            phase="request",
            url=_maybe_value(req, "url", ""),
            method=_maybe_value(req, "method", None),
            resource_type=_maybe_value(req, "resource_type", None),
        )

    def _on_response(resp: Any) -> None:
        req = _maybe_value(resp, "request", None)
        page_url = _safe_page_url(page)
        _record_browser_network_event(
            phase="response",
            url=_maybe_value(resp, "url", ""),
            method=_maybe_value(req, "method", None) if req is not None else None,
            status=_maybe_value(resp, "status", None),
            resource_type=_maybe_value(req, "resource_type", None) if req is not None else None,
        )
        try:
            _schedule_dynamic_response_capture(
                page,
                resp,
                page_url=page_url,
                evidence_dir=_SESSION_STATE.get("evidence_dir"),
            )
        except RuntimeError:
            logger.debug("dynamic response capture skipped: no running loop")

    def _on_request_failed(req: Any) -> None:
        _record_browser_network_event(
            phase="requestfailed",
            url=_maybe_value(req, "url", ""),
            method=_maybe_value(req, "method", None),
            resource_type=_maybe_value(req, "resource_type", None),
            failure=str(_maybe_value(req, "failure", "") or ""),
        )

    def _on_console(msg: Any) -> None:
        _record_browser_console_event(
            level=str(_maybe_value(msg, "type", "log") or "log"),
            text=str(_maybe_value(msg, "text", "") or ""),
            url=_safe_page_url(page),
            location=_maybe_value(msg, "location", None),
        )

    def _on_page_error(exc: Any) -> None:
        _record_browser_console_event(
            level="pageerror",
            text=str(exc),
            url=_safe_page_url(page),
        )

    def _on_frame_navigated(frame: Any) -> None:
        parent = _maybe_value(frame, "parent_frame", None)
        _record_browser_frame_event(
            phase="navigated",
            url=_maybe_value(frame, "url", ""),
            name=str(_maybe_value(frame, "name", "") or ""),
            parent_url=_maybe_value(parent, "url", "") if parent is not None else None,
        )

    def _on_dialog(dialog: Any) -> None:
        _record_browser_dialog_event(
            phase="opened",
            dialog_type=str(_maybe_value(dialog, "type", "") or ""),
            message=str(_maybe_value(dialog, "message", "") or ""),
            default_value=str(_maybe_value(dialog, "default_value", "") or ""),
            url=_safe_page_url(page),
        )

        async def _dismiss_dialog() -> None:
            dismiss = getattr(dialog, "dismiss", None)
            if not callable(dismiss):
                return
            try:
                value = dismiss()
                if hasattr(value, "__await__"):
                    await value
                _record_browser_dialog_event(
                    phase="auto_dismissed",
                    dialog_type=str(_maybe_value(dialog, "type", "") or ""),
                    message=str(_maybe_value(dialog, "message", "") or ""),
                    default_value=str(_maybe_value(dialog, "default_value", "") or ""),
                    url=_safe_page_url(page),
                )
            except Exception as exc:
                _record_browser_dialog_event(
                    phase="dismiss_failed",
                    dialog_type=str(_maybe_value(dialog, "type", "") or ""),
                    message=str(exc),
                    url=_safe_page_url(page),
                )

        try:
            asyncio.create_task(_dismiss_dialog())
        except RuntimeError:
            logger.debug("browser dialog auto-dismiss skipped: no running loop")

    def _on_download(download: Any) -> None:
        _record_browser_download_event(
            phase="created",
            url=_maybe_value(download, "url", ""),
            suggested_filename=str(_maybe_value(download, "suggested_filename", "") or ""),
        )

    for name, handler in (
        ("request", _on_request),
        ("response", _on_response),
        ("requestfailed", _on_request_failed),
        ("console", _on_console),
        ("pageerror", _on_page_error),
        ("framenavigated", _on_frame_navigated),
        ("dialog", _on_dialog),
        ("download", _on_download),
    ):
        try:
            on(name, handler)
        except Exception:
            logger.debug("browser observer attach failed for %s", name, exc_info=True)


def _page_is_closed(page: Any) -> bool:
    is_closed = getattr(page, "is_closed", None)
    if not callable(is_closed):
        return False
    try:
        return bool(is_closed())
    except Exception:
        return True


# ── Slice3 Part A: navigate redirect 사전차단 (CDP Fetch 게이트) ──────────────────
# `page.goto` 는 서버 3xx 를 자동 추적하는데 execute 는 초기 URL 만 url_safety 검사한다 →
# in-scope 페이지가 302 로 metadata(169.254.169.254)/loopback/off-scope 로 튕기면 요청이 이미
# 발생해 url_safety 하드블록(SAFETY-KEEP)을 우회(codex "높음"). 실측 결과 **Playwright `page.route`
# 는 redirect hop 에 핸들러를 재발화하지 않아** redirect 를 못 막는다. 그래서 CDP `Fetch.enable`
# (`Fetch.requestPaused` 는 매 redirect hop 마다 발화)로 **요청 前** 차단한다.
#  · Document(main+sub-frame navigation, 초기+redirect hop): full url_safety(하드블록+scope+DNS 재바인딩).
#    ※ sub-frame(iframe) navigation 도 resourceType=="Document" 라 **동일 full 검사**를 받는다(안전
#      방향 — 단 off-scope 외부 위젯 iframe 은 scope 설정 시 차단될 수 있음).
#  · 그 외(subresource): **하드블록만**(기본 — 사내 perf, 매 subresource DNS resolve 지연 회피).
#    off-scope 정상 외부자원 오차단 없이 SSRF-to-metadata(IP)만 차단. DNS-이름 SSRF 강화는
#    SA_WEB_SUBRESOURCE_DNS_CHECK=true(외부 미신뢰 대상용).
# always-on 강화. 메인 page 설치 실패는 _start_session 이 fail-closed(세션 시작 실패).
# ★ 한계(codex 라운드2, 문서화): 이 게이트는 **page CDP target 에 결박**된다 — worker/OOPIF 별도
#   target·팝업 최초 요청(auto-attach 前)·연결시점 DNS rebinding(TOCTOU) 은 완전 차단 못 한다.
#   완전한 egress 경계는 browser-level Target auto-attach(pause-on-start) 또는 네트워크 egress
#   proxy 이며, 자율 navigate/login 을 실제 활성화하기 前 그 경계가 선행돼야 한다(capability.py 참조).
_NAV_RESOURCE_TYPES: frozenset[str] = frozenset({"Document"})


async def _fetch_gate_decide(url: str, resource_type: str) -> tuple[bool, str]:
    """(차단?, 사유). Document=full(하드블록+scope+DNS). subresource=하드블록만(사내 perf — 매
    subresource DNS resolve 지연 회피). SA_WEB_SUBRESOURCE_DNS_CHECK=true 면 subresource 도 DNS
    재바인딩 검사(DNS-이름 SSRF 방어 강화, 외부 미신뢰 대상 자율 브라우징용)."""
    try:
        if resource_type in _NAV_RESOURCE_TYPES:
            await asyncio.to_thread(_validate_browser_url_safe, url)          # 하드블록+scope+DNS
        elif _truthy_env("SA_WEB_SUBRESOURCE_DNS_CHECK"):
            await asyncio.to_thread(validate_url_safe_hardblock_resolved, url)  # 하드블록+DNS(scope無)
        else:
            await asyncio.to_thread(validate_url_safe_hardblock, url)         # 하드블록만(기본, 빠름)
        return False, ""
    except URLSafetyError as e:
        return True, str(e)


async def _install_fetch_gate(page: Any) -> None:
    """page 에 CDP Fetch 게이트 설치. 모든 request(redirect hop 포함)를 요청 前 검사.
    설치(Fetch.enable) 실패는 만든 CDP 세션을 detach 하고 예외를 전파 — 호출자가 fail-closed 처리."""
    ctx = page.context
    cdp = await ctx.new_cdp_session(page)

    async def _on_paused(event: Any) -> None:
        ev = event if isinstance(event, dict) else {}
        rid = ev.get("requestId")
        req = ev.get("request", {})
        url = str(req.get("url", "") or "") if isinstance(req, dict) else ""
        rtype = str(ev.get("resourceType", "") or "")
        if rid is None:
            return
        try:
            block, reason = await _fetch_gate_decide(url, rtype)
            if block:
                try:                                # 감사 실패가 enforcement 를 뒤집지 못하게 격리
                    _record_browser_event(
                        kind="action", action="request_blocked", ok=False,
                        message=f"unsafe {rtype or 'request'} blocked: {reason}",
                        url=_sanitize_browser_url(url),   # secret 마스킹(codex)
                    )
                except Exception:
                    logger.debug("fetch gate audit record failed", exc_info=True)
                await cdp.send("Fetch.failRequest",
                               {"requestId": rid, "errorReason": "BlockedByClient"})
                return
            await cdp.send("Fetch.continueRequest", {"requestId": rid})
        except Exception:
            # 결정/전송 오류 → fail-closed(요청 차단) + 감사. teardown race 로 send 실패하면 무시.
            try:
                _record_browser_event(
                    kind="action", action="request_blocked", ok=False,
                    message="fetch gate internal error (fail-closed)",
                    url=_sanitize_browser_url(url),
                )
            except Exception:
                pass
            try:
                await cdp.send("Fetch.failRequest",
                               {"requestId": rid, "errorReason": "BlockedByClient"})
            except Exception:
                logger.debug("fetch gate fail-closed send error", exc_info=True)

    try:
        cdp.on("Fetch.requestPaused", lambda e: asyncio.create_task(_on_paused(e)))
        await cdp.send("Fetch.enable", {"patterns": [{"urlPattern": "*"}]})
    except Exception:
        try:
            await cdp.detach()               # 설치 중간실패 → 만든 세션 정리(누수 방지, codex)
        except Exception:
            pass
        raise
    _SESSION_STATE.setdefault("cdp_gates", []).append(cdp)
    # codex 라운드3 #6: page 종료 시 cdp_gates 에서 제거(반복 팝업 누적 방지). CDP 세션은 page 가
    # 닫히면 함께 죽으므로 detach 는 안 한다(닫힌 target detach = TargetClosedError·미회수 task).
    try:
        on = getattr(page, "on", None)
        if callable(on):
            def _drop_gate(_p: Any = None, _cdp: Any = cdp) -> None:
                gates = _SESSION_STATE.get("cdp_gates") or []
                try:
                    gates.remove(_cdp)
                except ValueError:
                    pass
            on("close", _drop_gate)
    except Exception:
        logger.debug("popup close hook 설치 실패", exc_info=True)


async def _install_fetch_gate_safe(page: Any) -> None:
    """새 page(팝업 등)용 설치 — 실패하면 **해당 page 를 닫는다**(미게이트 page fail-open 방지, codex).
    이미 닫힌 page(설치 중 정상 종료)면 아무 것도 안 한다(정상 팝업 오종료 방지). page 가 여전히
    열려 있는데 close 도 실패하면 미게이트 page 가 살아있는 것이므로 **context 전체를 종료**한다.
    팝업 최초 요청은 Fetch.enable 이전에 나갈 수 있는 잔여 레이스가 있다(문서화된 한계 —
    완전 차단은 browser-level target auto-attach 필요). 메인 page 는 _start_session 이 fail-closed 설치."""
    def _definitely_closed(pg: Any) -> bool:
        """확실히 닫힌 경우만 True. 판정 불가(예외/미지원)는 **열림 취급**(fail-closed — 닫아야 함)."""
        is_closed = getattr(pg, "is_closed", None)
        if not callable(is_closed):
            return False
        try:
            return bool(is_closed())
        except Exception:
            return False                     # 판정 불가 → 열림 취급(닫기 시도)

    try:
        await _install_fetch_gate(page)
        return
    except Exception:
        logger.warning("popup/new-page fetch gate 설치 실패", exc_info=True)
    if _definitely_closed(page):             # 설치 중 정상 종료된 팝업 → 오종료 안 함
        return
    try:
        await page.close()
        return
    except Exception:
        logger.warning("미게이트 popup page.close 실패 — context 종료(fail-closed)", exc_info=True)
    if _definitely_closed(page):
        return
    ctx = getattr(page, "context", None)
    try:                                     # 미게이트 page 가 여전히 살아있음 → context 종료
        if ctx is not None:
            await ctx.close()
            return
    except Exception:
        logger.warning("미게이트 popup context.close 실패 — browser 종료 에스컬레이션", exc_info=True)
    # context 종료 실패/불가 → browser 종료 + 세션 무효화(살아있는 미게이트 page fail-open 방지).
    try:
        await _stop_session()
    except Exception:
        logger.error("미게이트 popup — browser 종료도 실패, 세션 poison 상태", exc_info=True)


def _safe_page_url(page: Any) -> str:
    try:
        return str(getattr(page, "url", "") or "")
    except Exception:
        return ""


def _host_of(value: str) -> str:
    from urllib.parse import urlparse
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlparse(raw if "://" in raw else f"//{raw}")
        return (parsed.hostname or "").lower()
    except Exception:
        return ""


def _default_creds_enabled() -> bool:
    return _truthy_env("SA_WEB_DEFAULT_CREDS_ENABLED")


def _default_cred_combos() -> list[tuple[str, str]]:
    """기본 자격증명 조합. SA_WEB_DEFAULT_CREDS_ENABLED=true 일 때만 사용."""
    raw = os.environ.get("SA_WEB_DEFAULT_CREDS", "").strip()
    if raw:
        out: list[tuple[str, str]] = []
        for pair in raw.split(","):
            if ":" in pair:
                u, p = pair.split(":", 1)
                out.append((u.strip(), p.strip()))
        return out
    return [
        ("admin", "admin"), ("admin", "password"), ("admin", "admin123"),
        ("administrator", "administrator"), ("user", "user"),
        ("root", "root"), ("test", "test"), ("guest", "guest"),
    ]


async def _find_login_fields(page: Any) -> tuple[Any, Any, Any] | None:
    """현재 페이지에서 (user_input, pass_input, submit_btn) 찾기. 없으면 None.
    ADFS 표준 셀렉터 우선, 없으면 generic (password input + 직전 text/email)."""
    pw = None
    for sel in ("#passwordInput", "input[type='password']", "input[name*='ass']"):
        pw = await page.query_selector(sel)
        if pw:
            break
    if not pw:
        return None
    user = None
    for sel in ("#userNameInput", "input[type='email']",
                "input[name*='ser']", "input[name*='mail']", "input[type='text']"):
        user = await page.query_selector(sel)
        if user:
            break
    submit = None
    for sel in ("#submitButton", "button[type='submit']",
                "input[type='submit']", "button"):
        submit = await page.query_selector(sel)
        if submit:
            break
    return (user, pw, submit)


_SSO_BUTTON_TEXTS = (
    "sso login", "sso 로그인", "sign in with sso", "login with sso",
    "single sign", "통합인증", "통합 인증", "통합계정", "knox", "ssologin",
)


async def _try_sso_button(page: Any) -> bool:
    """현재 페이지에 'SSO Login' 류 버튼/링크가 있으면 클릭해서 IdP(ADFS)로 보낸다.
    일부 사내 사이트의 자체 로그인 페이지 + 'SSO Login' 버튼 2단계 케이스용. 클릭 성공 시 True."""
    try:
        els = await page.query_selector_all(
            "button, a, input[type=button], input[type=submit], [role=button], span, div"
        )
    except Exception:
        return False
    for el in els[:200]:
        try:
            txt = (await el.inner_text() or "").strip().lower()
        except Exception:
            txt = ""
        if not txt:
            try:
                txt = ((await el.get_attribute("value")) or "").lower()
            except Exception:
                txt = ""
        if txt and len(txt) <= 40 and any(k in txt for k in _SSO_BUTTON_TEXTS):
            clicked = False
            try:
                await el.click(timeout=3000)
                clicked = True
            except Exception:
                # Mendix/SPA 버튼은 Playwright actionability 체크가 timeout 되는 경우
                # 많음 → JS dispatch click 으로 우회.
                try:
                    await el.evaluate("e => e.click()")
                    clicked = True
                except Exception:
                    clicked = False
            if not clicked:
                continue
            try:
                await page.wait_for_load_state("networkidle", timeout=3500)
            except Exception:
                pass
            await page.wait_for_timeout(2500)
            return True
    return False


async def _attempt_login(
    page: Any, creds: list[tuple[str, str]], *, count_breaker: bool = True,
    origin_guard: "Callable[[str], tuple[bool, str]] | None" = None,
) -> tuple[bool, str]:
    """주어진 cred 조합들을 현재 로그인 페이지에 순차 시도. 성공 시 True.

    origin_guard(Slice3): 주어지면 fill/submit **직전마다** 현재 landing origin 이 허용 IdP origin
    인지 재검증(fill 후 phishing origin 으로 nav/refresh 되는 TOCTOU 방지). 불허 시 자격 미제출.
    (자격 제출 목적지 자체의 결박은 위협모델상 신뢰 IdP origin 전제 — 상세는 _guard_ok 주석.)
    회로차단기(`count_breaker=True`, SSO 실계정용): 연속 실패가 _LOGIN_FAIL_LIMIT
    도달하면 이후 모든 로그인 영구 중단 (shaneee.baek lockout 방지).
    기본자격 추측(`count_breaker=False`)은 실패해도 차단기를 건드리지 않는다 —
    admin/admin 추측은 우리 계정 lockout 위험이 아니고, per-site 1회로 끝이라
    SSO 로그인 세션을 죽이면 안 된다.
    비밀번호는 결과/이벤트에 절대 노출하지 않는다."""
    if count_breaker and _SESSION_STATE.get("login_halted"):
        return False, (
            f"로그인 중단됨 — 연속 {_LOGIN_FAIL_LIMIT}회 SSO 실패 회로차단기 작동. "
            "lockout 방지를 위해 이 세션에서 더 이상 SSO 로그인 시도 안 함."
        )
    start_url = _safe_page_url(page)
    for username, password in creds:
        if count_breaker and _SESSION_STATE.get("login_halted"):
            break
        fields = await _find_login_fields(page)
        if not fields:
            return False, "로그인 폼(비밀번호 입력)을 찾지 못함 — 로그인 페이지 아님."
        user_el, pass_el, submit_el = fields

        async def _guard_ok(phase: str) -> tuple[bool, str]:
            """Slice3: 자격 fill/submit 직전 landing origin 이 여전히 허용 IdP origin 인지 재검증
            (fill 후 phishing origin 으로 nav/refresh 되는 것 방지). 위협모델: **operator 가 allowlist 한
            IdP origin 은 신뢰**한다 — 그 origin 페이지가 자격을 다른 곳으로 유출하는 것(=IdP 침해)은
            in-browser 로 못 막고 범위 밖(더 강한 보장은 네트워크 egress proxy). 이 guard 는 '자격을
            신뢰 IdP origin 에서만 입력'을 강제한다(피싱-리다이렉트 방어)."""
            if origin_guard is None:
                return True, ""
            ok_o, why_o = origin_guard(_safe_page_url(page))
            if not ok_o:
                return False, f"자격 미제출 ({phase} landing origin 재검증 실패) — {why_o}"
            return True, ""

        # Slice3: fill 직전 landing origin 이 허용 IdP origin 인지 재검증.
        ok_g, why_g = await _guard_ok("fill 전")
        if not ok_g:
            return False, why_g
        try:
            if user_el:
                await user_el.fill(username, timeout=5000)
            await pass_el.fill(password, timeout=5000)
            # Slice3: submit 직전 재검증(fill 후 nav/action 변조되면 자격 미제출).
            ok_s, why_s = await _guard_ok("submit 전")
            if not ok_s:
                return False, why_s
            # submit 클릭은 짧게 — 안 먹으면(버튼 비활성/JS) 바로 Enter fallback.
            # 기본 30s hang 방지 (사이트마다 30초 낭비하던 문제).
            clicked = False
            if submit_el:
                try:
                    await submit_el.click(timeout=5000)
                    clicked = True
                except Exception:
                    clicked = False
            if not clicked:
                try:
                    await pass_el.press("Enter", timeout=5000)
                except Exception:
                    pass
            # ADFS 는 submit 후 IdP→앱 redirect 에 수 초 걸림. 충분히 대기.
            try:
                await page.wait_for_load_state("networkidle", timeout=3500)
            except Exception:
                pass
            await page.wait_for_timeout(2000)
        except Exception as e:
            return False, f"로그인 입력 중 오류: {str(e)[:100]}"
        # 성공 판정: URL 이 로그인/SSO 페이지를 벗어났고 비밀번호 폼이 사라짐
        now_url = _safe_page_url(page)
        still_login = await _find_login_fields(page) is not None
        moved = now_url != start_url and "secsso" not in now_url and "adfs" not in now_url.lower()
        if moved and not still_login:
            if count_breaker:
                _SESSION_STATE["login_fail_streak"] = 0
            return True, f"로그인 성공 (user={username}) → {now_url}"
        # 실패 — SSO(실계정)만 차단기 카운트. 기본자격 추측은 차단기 안 건드림.
        if count_breaker:
            _SESSION_STATE["login_fail_streak"] = _SESSION_STATE.get("login_fail_streak", 0) + 1
            if _SESSION_STATE["login_fail_streak"] >= _LOGIN_FAIL_LIMIT:
                _SESSION_STATE["login_halted"] = True
                return False, (
                    f"연속 {_LOGIN_FAIL_LIMIT}회 SSO 로그인 실패 — 회로차단기 작동, SSO "
                    "로그인 영구 중단 (계정 lockout 방지). 남은 SSO 사이트는 skipped."
                )
    return False, (
        f"로그인 실패 (시도 {len(creds)}조합). 이 사이트는 skipped 처리하고 다음으로."
        + (f" SSO 연속실패 {_SESSION_STATE.get('login_fail_streak', 0)}/{_LOGIN_FAIL_LIMIT}."
           if count_breaker else "")
    )


def _is_adfs(u: str) -> bool:
    u = (u or "").lower()
    return "secsso" in u or "adfs" in u or "/oauth2/authorize" in u


# ── Slice3 Part B: login origin 재검증(credential-fill 前, 피싱-리다이렉트 방어) ──────
# `_try_sso_button` 클릭이 IdP 로 redirect 한 뒤 착지 origin 검증 없이 실계정 SSO 자격을 fill 하던
# 구멍(codex "높음")을 막는다. `_is_adfs` 는 부분문자열 검사라 `https://evil.com/adfs/` 도 통과 →
# operator 소유 `SA_WEB_SSO_IDP_ORIGINS`(exact origin allowlist)로 격상.
# ★ 보장 범위(codex 라운드5): "자격은 allowlist 된 IdP origin 에서만 입력"은 **allowlist 설정 시에만**
#   강제된다. 자율(무인) 경로는 capability.py Part C 가 allowlist 를 필수화하므로 항상 적용. allowlist
#   미설정 시 공유 `_perform_login`(수동 browser_action·web_site_sweep)은 **pre-Slice3 `_is_adfs` 휴리스틱
#   (약함)** 으로 폴백(후방호환 — prod SSO 미파손). 실계정 SSO 를 켤 땐 어느 경로든 SA_WEB_SSO_IDP_ORIGINS
#   설정 권장(그래야 exact origin 강제).
def _origin_of(url: str) -> str:
    """scheme://host[:port] 정규화(소문자 host, IPv6 는 bracket 복원). 파싱 실패/host 없음/
    비정규 host → ''(exact 매칭 불가). backslash 등 WHATWG↔urllib 파서 차이 회피 위해 거부."""
    from urllib.parse import urlparse
    raw = str(url or "").strip()
    if not raw or "\\" in raw:               # backslash: 브라우저/urllib 파싱 상이 → 거부
        return ""
    try:
        p = urlparse(raw if "://" in raw else f"https://{raw}")
        scheme = (p.scheme or "").lower()
        host = (p.hostname or "").lower()    # userinfo(user@) 제외·소문자 = 스푸핑 방지
        if not scheme or not host or any(c.isspace() for c in host):
            return ""                        # 공백 포함 host = malformed → 거부
        if ":" in host:                      # IPv6 리터럴 → bracket 복원(origin 충돌 방지, codex)
            host = f"[{host}]"
        # 기본 포트 정규화(codex 라운드4): https://idp:443 == https://idp, http://x:80 == http://x
        port = p.port
        if (scheme == "https" and port == 443) or (scheme == "http" and port == 80):
            port = None
        return f"{scheme}://{host}:{port}" if port is not None else f"{scheme}://{host}"
    except Exception:
        return ""


def _sso_idp_origins() -> frozenset[str]:
    """operator IdP origin allowlist. SA_WEB_SSO_IDP_ORIGINS(콤마, exact origin). 스킴 없으면 https.
    **HTTPS floor**: https origin 만 채택(http 항목은 무시 — 실 SSO 자격 평문 제출 방지, codex)."""
    out: set[str] = set()
    for tok in os.environ.get("SA_WEB_SSO_IDP_ORIGINS", "").split(","):
        o = _origin_of(tok.strip())
        if o.startswith("https://"):
            out.add(o)
    return frozenset(out)


def _sso_origin_permitted(url: str) -> tuple[bool, str]:
    """SSO 실계정 fill 前 landing origin 재검증. (허용?, 사유).

    3-state: (a) SA_WEB_SSO_IDP_ORIGINS raw 미설정 → 후방호환(현행 보존; 자율은 Part C 가 강제).
    (b) raw 설정됐으나 유효 https origin 0개 → **오설정 fail-closed**(후방호환 경로로 못 흐름, codex).
    (c) 유효 origin 있음 → exact 매칭 + HTTPS floor."""
    origin = _origin_of(url)
    if not origin:
        return False, "landing origin 파싱 실패"
    try:
        _validate_browser_url_safe(url)     # 하드블록/scope 는 IdP origin 에도 성립해야
    except URLSafetyError as e:
        return False, f"IdP origin url_safety 위반: {e}"
    raw = os.environ.get("SA_WEB_SSO_IDP_ORIGINS", "").strip()
    if not raw:
        # (a) 진짜 미설정 → 현행 동작 완전 보존(강화는 opt-in).
        return True, "SA_WEB_SSO_IDP_ORIGINS 미설정 — 후방호환(strict origin 검증 없음)"
    allow = _sso_idp_origins()
    if not allow:
        # (b) 설정했으나 유효 https origin 0개 = 오설정 → 후방호환 금지, 자격 미제출.
        return False, (
            "SA_WEB_SSO_IDP_ORIGINS 설정됐으나 유효 https origin 0개 — 오설정, 자격 미제출"
        )
    if not origin.startswith("https://"):   # (c) HTTPS floor — 실계정은 https 에만 제출.
        return False, f"SSO 자격은 https origin 에만 제출(HTTPS floor) — {origin} 거부"
    if origin in allow:
        return True, f"허용 IdP origin({origin})"
    return False, (
        f"origin {origin} 이 허용 IdP origin(SA_WEB_SSO_IDP_ORIGINS) 아님 "
        "— 피싱 리다이렉트 의심, 자격 미제출"
    )


async def _perform_login(page: Any, login_mode: str = "auto") -> tuple[bool, str, bool]:
    """현재 페이지에 로그인 시도. BrowserActionTool 와 web_site_sweep 공용.

    login_mode: auto(=SSO 페이지면 sso 아니면 defaults; defaults 는 opt-in) / sso / defaults.
    반환 (ok, msg, fatal): fatal=True 는 설정오류(SSO 자격 미설정) — 호출자가 ToolError.
    ctx metadata / event 기록은 호출자 책임(여기선 page 만 다룬다)."""
    # v3.67: 사전 인증 세션이 주입돼 있으면 이미 인증된 상태 — 폼/SSO 로그인 시도 안 함
    # (Knox 로컬트레이류는 봇이 어차피 로그인 못하고, 괜한 시도로 회로차단기만 닳는다).
    inj = _SESSION_STATE.get("injected_session")
    if inj:
        return (True,
                f"주입된 세션({inj.get('mode')}, {inj.get('count')} cookies) 활성 — "
                "로그인 스킵 (이미 인증됨).",
                False)

    cur = _safe_page_url(page)
    is_sso = _is_adfs(cur)
    # 2단계 SSO: 자체 로그인 페이지의 'SSO Login' 버튼을 먼저 눌러 ADFS 로.
    if not is_sso and login_mode in ("auto", "sso"):
        if await _try_sso_button(page):
            cur = _safe_page_url(page)
            is_sso = _is_adfs(cur)
    mode = login_mode
    if mode == "auto":
        mode = "sso" if is_sso else "defaults"
    if mode == "sso":
        user = os.environ.get("SA_WEB_SSO_USER", "")
        pw = os.environ.get("SA_WEB_SSO_PASS", "")
        if not user or not pw:
            return (False,
                    "SSO 자격증명 미설정 — .env 에 SA_WEB_SSO_USER / SA_WEB_SSO_PASS 필요.",
                    True)
        # Slice3: SSO 클릭(redirect) 후·자격 fill 前 landing origin 재검증(피싱-리다이렉트 방어).
        ok_origin, why = _sso_origin_permitted(_safe_page_url(page))
        if not ok_origin:
            return (False, f"SSO 자격 미제출 (fill 차단) — {why}", False)
        creds = [(user, pw)]  # 사이트당 1회
        # strict(allowlist 설정) 시에만 fill/submit 직전 landing origin 재검증 주입 — 미설정(후방호환)은
        # None(신규 강화가 기존 동작을 깨지 않게; 자율은 Part C 가 allowlist 강제).
        sso_guard = _sso_origin_permitted if _sso_idp_origins() else None
    else:
        if not _default_creds_enabled():
            return (False,
                    "default credential checks skipped — SA_WEB_DEFAULT_CREDS_ENABLED=true "
                    "명시 opt-in 필요. 자격증명은 제출하지 않았고 login wall confirmed/skipped.",
                    False)
        creds = _default_cred_combos()
        sso_guard = None                    # 기본자격 추측은 origin guard 무관
    # SSO(실계정)만 회로차단기 카운트. 기본자격 추측은 미반영(세션 죽이면 안 됨).
    ok, msg = await _attempt_login(
        page, creds, count_breaker=(mode == "sso"), origin_guard=sso_guard,
    )
    return (ok, msg, False)


def _browser_proxy_config() -> dict[str, Any] | None:
    """Playwright launch proxy 설정. 사내 MWG proxy 우회용.

    - SA_BROWSER_PROXY=direct → 프록시 완전 미사용 (모두 직결).
    - SA_BROWSER_PROXY=<url> → 그 프록시 사용 (bypass 에 사내 도메인).
    - 미지정: 환경 http(s)_proxy 가 있으면 그걸 쓰되 사내 도메인은 bypass(직결).
      환경 프록시도 없으면 None (Playwright 기본 = 직결).
    """
    override = os.environ.get("SA_BROWSER_PROXY", "").strip()
    if override.lower() == "direct":
        return {"server": "direct://"}
    env_proxy = (
        override
        or os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
        or os.environ.get("http_proxy") or os.environ.get("HTTP_PROXY")
    )
    if not env_proxy:
        return None
    # 사내 도메인 bypass (url_safety 의 SA_WEB_INTERNAL_DOMAINS 와 동일 기본값) +
    # 사내 IP 대역 + 기존 no_proxy. chromium bypass 형식: 콤마 구분 패턴.
    raw_domains = os.environ.get(
        "SA_WEB_INTERNAL_DOMAINS", "samsungds.net,samsungsemi.com",
    )
    patterns: list[str] = []
    for d in raw_domains.split(","):
        d = d.strip().lstrip(".")
        if d:
            patterns.append(d)
            patterns.append(f"*.{d}")
    patterns += ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
                 "12.0.0.0/8", "106.0.0.0/8", "localhost", "127.0.0.1"]
    for extra in os.environ.get("no_proxy", "").split(","):
        extra = extra.strip()
        if extra:
            patterns.append(extra)
    return {"server": env_proxy, "bypass": ",".join(patterns)}


def _mark_web_host_visited(ctx: Any, page: Any) -> None:
    """browser 로 실제 로드한 host 를 세션 metadata 에 기록.
    submit_finding(web) 이 "이 호스트를 browser 로 봤나" 게이트에 사용 (정책 A 강제)."""
    try:
        host = _host_of(_safe_page_url(page))
        if not host or not hasattr(ctx, "metadata"):
            return
        hosts = ctx.metadata.setdefault("_web_browser_hosts", [])
        if host not in hosts:
            hosts.append(host)
    except Exception:
        pass


def _clear_browser_refs() -> None:
    _SESSION_STATE["ref_map"] = {}
    _SESSION_STATE["ref_url"] = ""


def _store_browser_refs(page: Any, elements: list[Any]) -> None:
    ref_map: dict[str, dict[str, Any]] = {}
    for item in elements:
        if not isinstance(item, dict):
            continue
        ref = str(item.get("ref") or "").strip()
        selector = str(item.get("selector") or "").strip()
        if not ref.startswith("@e") or not selector:
            continue
        ref_map[ref] = {
            "selector": selector,
            "tag": str(item.get("tag") or ""),
            "role": str(item.get("role") or ""),
            "label": str(item.get("label") or ""),
            "href": str(item.get("href") or ""),
            "input_type": str(item.get("input_type") or ""),
        }
    _SESSION_STATE["ref_map"] = ref_map
    _SESSION_STATE["ref_url"] = _safe_page_url(page)


def _resolve_browser_target(
    *,
    selector: str | None,
    ref: str | None,
) -> tuple[str | None, ToolError | None]:
    if selector:
        return selector, None
    if not ref:
        return None, ToolError(
            kind="validation",
            message="action needs selector or ref from browser_query(action='snapshot')",
        )
    ref_map = _SESSION_STATE.get("ref_map") or {}
    entry = ref_map.get(ref)
    if not isinstance(entry, dict) or not entry.get("selector"):
        return None, ToolError(
            kind="not_found",
            message=f"browser ref {ref!r} 없음 — browser_query(action='snapshot')으로 갱신 필요.",
        )
    return str(entry["selector"]), None


def _browser_health() -> dict[str, Any]:
    page = _SESSION_STATE.get("page")
    page_closed = _page_is_closed(page) if page is not None else False
    return {
        "running": _is_running(),
        "page_alive": page is not None and not page_closed,
        "page_closed": page_closed,
        "started_at": _SESSION_STATE.get("started_at"),
        "url": _safe_page_url(page) if page is not None else "",
        "injected_session": _SESSION_STATE.get("injected_session"),  # v3.67: 값X, 개수/경로만
        "navigations": _SESSION_STATE.get("navigations"),
        "ref_count": len(_SESSION_STATE.get("ref_map") or {}),
        "ref_url": _SESSION_STATE.get("ref_url") or "",
        "event_count": len(_BROWSER_EVENTS),
        "network_event_count": len(_BROWSER_NETWORK_EVENTS),
        "dynamic_response_event_count": len(_BROWSER_DYNAMIC_RESPONSE_EVENTS),
        "console_event_count": len(_BROWSER_CONSOLE_EVENTS),
        "frame_event_count": len(_BROWSER_FRAME_EVENTS),
        "dialog_event_count": len(_BROWSER_DIALOG_EVENTS),
        "download_event_count": len(_BROWSER_DOWNLOAD_EVENTS),
        "failed_request_count": sum(
            1 for e in _BROWSER_NETWORK_EVENTS
            if e.get("phase") == "requestfailed" or int(e.get("status") or 0) >= 400
        ),
        "console_error_count": sum(
            1 for e in _BROWSER_CONSOLE_EVENTS
            if str(e.get("level") or "").lower() in {"error", "pageerror"}
        ),
        "dynamic_response_hit_count": sum(
            len(e.get("scan_hits") or []) for e in _BROWSER_DYNAMIC_RESPONSE_EVENTS
        ),
    }


def _api_candidate_reasons(event: dict[str, Any]) -> tuple[str, ...]:
    url = str(event.get("url") or "")
    if not url:
        return ()
    try:
        parsed = urlparse(url)
    except Exception:
        parsed = urlparse("")
    path = parsed.path or url
    query = parsed.query or ""
    reasons: list[str] = []
    segments = {segment.lower() for segment in path.split("/") if segment}
    if "api" in segments:
        reasons.append("path_api")
    if "graphql" in segments or path.lower().endswith("/graphql"):
        reasons.append("path_graphql")
    if any(re.fullmatch(r"v[0-9]+", segment) for segment in segments):
        reasons.append("path_versioned_api")
    if _API_JSON_PATH_RE.search(path):
        reasons.append("path_json")
    if "graphql" in query.lower():
        reasons.append("query_graphql")
    resource_type = str(event.get("resource_type") or "").lower()
    content_type = str(event.get("content_type") or "").lower()
    if resource_type in _DYNAMIC_RESPONSE_RESOURCE_TYPES and "json" in content_type:
        reasons.append("fetch_json")
    if not reasons and _API_PATH_RE.search(path):
        reasons.append("path_api_like")
    return tuple(dict.fromkeys(reasons))


def _looks_like_api_candidate(event: dict[str, Any]) -> bool:
    return bool(_api_candidate_reasons(event))


def _browser_api_candidates(*, limit: int = 50) -> dict[str, Any]:
    limit = max(1, min(int(limit), 200))
    ordered: dict[tuple[str, str], dict[str, Any]] = {}

    def add(event: dict[str, Any], *, source: str) -> None:
        reasons = _api_candidate_reasons(event)
        if not reasons:
            return
        url = str(event.get("url") or "")
        method = str(event.get("method") or "GET").upper()[:16]
        key = (method, url)
        item = ordered.get(key)
        if item is None:
            item = {
                "url": url,
                "method": method,
                "status": event.get("status"),
                "resource_type": event.get("resource_type") or "",
                "candidate_reasons": [],
                "sources": [],
                "seen_count": 0,
            }
            ordered[key] = item
        elif item.get("status") is None and event.get("status") is not None:
            item["status"] = event.get("status")
        if not item.get("resource_type") and event.get("resource_type"):
            item["resource_type"] = event.get("resource_type")
        item["seen_count"] = int(item.get("seen_count") or 0) + 1
        sources = list(item.get("sources") or [])
        sources.append(source)
        item["sources"] = list(dict.fromkeys(sources))
        candidate_reasons = list(item.get("candidate_reasons") or [])
        candidate_reasons.extend(reasons)
        item["candidate_reasons"] = list(dict.fromkeys(candidate_reasons))

        if event.get("content_type"):
            item["content_type"] = event.get("content_type")
        if event.get("body_path"):
            item["body_path"] = event.get("body_path")
        if event.get("scan_hits") is not None:
            item["scan_hit_count"] = len(event.get("scan_hits") or [])
        if event.get("sensitive_signals") is not None:
            item["sensitive_signal_count"] = len(event.get("sensitive_signals") or [])

    for event in _BROWSER_NETWORK_EVENTS:
        add(event, source=f"network:{event.get('phase') or 'unknown'}")
    for event in _BROWSER_DYNAMIC_RESPONSE_EVENTS:
        add(event, source="dynamic_response")

    candidates = list(ordered.values())
    by_reason: dict[str, int] = {}
    for item in candidates:
        for reason in item.get("candidate_reasons") or []:
            reason_key = str(reason)
            by_reason[reason_key] = by_reason.get(reason_key, 0) + 1
    return {
        "summary": {
            "total": len(candidates),
            "returned": min(len(candidates), limit),
            "truncated": len(candidates) > limit,
            "network_event_count": len(_BROWSER_NETWORK_EVENTS),
            "dynamic_response_event_count": len(_BROWSER_DYNAMIC_RESPONSE_EVENTS),
            "dynamic_response_scan_hit_count": sum(
                len(e.get("scan_hits") or []) for e in _BROWSER_DYNAMIC_RESPONSE_EVENTS
            ),
            "by_reason": by_reason,
        },
        "candidates": candidates[:limit],
    }


async def _ensure_playwright_installed() -> tuple[bool, str | None]:
    """playwright import 시도. 실패 시 (False, reason) 반환."""
    try:
        from playwright.async_api import async_playwright  # noqa
        return True, None
    except ImportError as e:
        return False, f"playwright 미설치: {e}. `uv add playwright && playwright install chromium`."


# v3.67: 사전 인증 세션 주입 — Knox 로컬트레이/통합인증 등 봇이 폼 로그인할 수 없는
# SSO 사이트용. 운영자가 본인 워크스테이션(SSO 에이전트 있음)에서 로그인 후 세션을
# export 해 SA_WEB_SESSION_STATE 경로로 넘기면, 점검 브라우저가 그 세션으로 시작한다.
# 비밀번호는 봇/채팅/로그 어디에도 들어가지 않는다 (세션 토큰만, 그것도 값은 미로깅).
_SAMESITE_MAP = {
    "strict": "Strict", "lax": "Lax", "none": "None",
    "no_restriction": "None", "unspecified": "Lax",  # 브라우저 확장 export 표기
}


def _normalize_cookies(raw: Any) -> list[dict[str, Any]]:
    """쿠키 export(브라우저 확장 Cookie-Editor/EditThisCookie 또는 Playwright)를
    Playwright `add_cookies` 포맷으로 정규화. 유효치 않은 항목은 버린다.
    쿠키 '값'은 로깅하지 않는다(여기선 변환만)."""
    out: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return out
    for c in raw:
        if not isinstance(c, dict):
            continue
        name = c.get("name")
        value = c.get("value")
        if not name or not value:  # 빈 문자열/None 값 쿠키는 Playwright 가 거부 → 미리 버림
            continue
        domain = c.get("domain")
        url = c.get("url")
        if not domain and not url:
            continue  # Playwright 는 (domain+path) 또는 url 필요
        ck: dict[str, Any] = {"name": str(name), "value": str(value)}
        if domain:
            ck["domain"] = str(domain)
            ck["path"] = str(c.get("path") or "/")
        else:
            ck["url"] = str(url)
        exp = c.get("expires", c.get("expirationDate"))  # 확장은 expirationDate
        if isinstance(exp, (int, float)) and exp > 0:
            ck["expires"] = float(exp)
        for b in ("httpOnly", "secure"):
            if b in c:
                ck[b] = bool(c[b])
        ss = c.get("sameSite")
        if isinstance(ss, str):
            mapped = _SAMESITE_MAP.get(ss.strip().lower())
            if mapped:
                ck["sameSite"] = mapped
                if mapped == "None":
                    # SameSite=None 쿠키는 Secure 필수 — 아니면 Playwright 가 배치 전체를
                    # 거부해 세션 주입이 통째로 실패한다. cross-site 세션쿠키이므로 Secure 적절.
                    ck["secure"] = True
        out.append(ck)
    return out


def _resolve_session_state(env: dict[str, str] | None = None) -> dict[str, Any]:
    """SA_WEB_SESSION_STATE(파일 경로)를 읽어 주입할 세션을 분류.
    - none      : env 미설정 (주입 안 함)
    - storage_state : Playwright dump({"cookies":[...],"origins":[...]}) → path 그대로 new_context 전달
    - cookies   : 쿠키 list(확장 export) → add_cookies 용 정규화 목록
    - error     : env 는 설정됐는데 파일 없음/파싱실패/형식불명/유효쿠키 0
    반환에 쿠키 값은 절대 넣지 않는다 (개수/경로/모드만)."""
    env = env if env is not None else os.environ
    path = (env.get("SA_WEB_SESSION_STATE") or "").strip()
    if not path:
        return {"mode": "none"}
    p = Path(path).expanduser()
    if not p.is_file():
        return {"mode": "error", "source": path,
                "error": f"SA_WEB_SESSION_STATE 파일 없음: {path}"}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        return {"mode": "error", "source": path,
                "error": f"세션 파일 파싱 실패 ({path}): {type(e).__name__}"}
    # Playwright storage_state: {"cookies":[...], "origins":[...]}
    if isinstance(data, dict) and "cookies" in data:
        n = len(data.get("cookies") or [])
        if n == 0:
            return {"mode": "error", "source": path,
                    "error": f"storage_state 에 쿠키 0개 ({path})"}
        return {"mode": "storage_state", "path": str(p), "count": n, "source": path}
    # 쿠키 list (확장 export / bare list)
    if isinstance(data, list):
        cookies = _normalize_cookies(data)
        if not cookies:
            return {"mode": "error", "source": path,
                    "error": f"세션 파일에 유효 쿠키 0개 ({path})"}
        return {"mode": "cookies", "cookies": cookies,
                "count": len(cookies), "source": path}
    return {"mode": "error", "source": path,
            "error": f"세션 파일 형식 불명 ({path}) — storage_state dict 또는 cookies list 필요"}


async def _close_quietly(browser: Any = None, pw: Any = None, ctx: Any = None) -> None:
    """start 실패 시 부분 정리 — 아직 _SESSION_STATE 에 저장 전이라 _stop_session 으론
    안 닫히는 local ctx/browser/pw 를 조용히 닫는다 (chromium 프로세스 누수 방지)."""
    for obj, meth in ((ctx, "close"), (browser, "close"), (pw, "stop")):
        if obj is None:
            continue
        try:
            await getattr(obj, meth)()
        except Exception:
            pass


async def _start_session(*, headless: bool, viewport_width: int,
                         viewport_height: int) -> tuple[bool, str | None]:
    if _is_running():
        return True, "already running"
    ok, reason = await _ensure_playwright_installed()
    if not ok:
        return False, reason

    from playwright.async_api import async_playwright
    try:
        pw = await async_playwright().start()
        _SESSION_STATE["playwright"] = pw  # F5-B(codex): launch 실패 시도 _stop_session 이 pw.stop()
        # chromium headless-shell 디폴트.
        # v3.53: 사내 MWG proxy 우회 — 안 하면 cdep 사이트가 "전사 차단" 페이지로
        # redirect 돼서 실제 콘텐츠를 못 본다 (web_fetch 의 trust_env=False 와 동일 정책:
        # 사내 도메인은 직결, 외부만 proxy). 환경에 http(s)_proxy 가 있으면 bypass 목록에
        # 사내 도메인을 넣어 launch.
        # F5-B: launch 前 직전 crash 가 남긴 고아 chromium 회수 (프로세스당 1회).
        await reap_orphan_browsers_once()
        owner_token = _procreg.new_owner_token()
        launch_kwargs: dict[str, Any] = {
            "headless": headless,
            # F5-B: chromium 프로세스 env 에 owner token 주입 — 나중에 startup reaper
            # 가 /proc/<pid>/environ 로 "우리가 띄운 것"을 확증(사용자 Chrome 오살 방지).
            "env": {**os.environ, _procreg.OWNER_TOKEN_ENV: owner_token},
        }
        proxy_cfg = _browser_proxy_config()
        if proxy_cfg is not None:
            launch_kwargs["proxy"] = proxy_cfg
        browser = await pw.chromium.launch(**launch_kwargs)
        # F5-B(codex): browser 를 생성 **즉시** 세션상태에 넣는다 — 아래 ctx/page 설정이
        # 실패하거나 coroutine 이 취소돼도 except→_stop_session 이 이 browser 를 반드시
        # 닫게 하기 위함(부분기동 chromium 누수 방지). _BROWSER_LOCK 보유 중이라 안전.
        _SESSION_STATE["browser"] = browser
        # launch **직후** 등록 — ctx/page 準備 前 crash/cancel 나도 registry 에 있어야
        # 다음 기동 reaper 가 회수. 실패 경로는 아래 except→_stop_session 이 close+unregister.
        _SESSION_STATE["owner_token"] = owner_token
        _SESSION_STATE["browser_pid"] = await _register_browser_process(
            browser, owner_token,
        )
        # basic auth env — 사내 인증 사이트용
        basic_user = os.environ.get("SA_BROWSER_BASIC_AUTH_USER")
        basic_pass = os.environ.get("SA_BROWSER_BASIC_AUTH_PASS")
        context_kwargs: dict[str, Any] = {
            "viewport": {"width": viewport_width, "height": viewport_height},
            # F4-B: 비전 루프 좌표 일관성 — DPR=1 로 고정해 screenshot PNG 픽셀 == click_xy
            # CSS 픽셀. (기본도 1이나 명시해 향후 변경이 좌표 가정을 조용히 깨지 않게.)
            "device_scale_factor": 1,
            "user_agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/147.0 SecuAgent/1.0"
            ),
            # 사내 cdep 사이트는 사내 CA 인증서 사용 → chromium 이 ERR_CERT_AUTHORITY_INVALID
            # 로 navigate 실패. 인가받은 내부 점검이고 web_fetch 도 동일하게 사내망을 보므로
            # cert 검증 무시 (SA_BROWSER_VERIFY_TLS=true 면 다시 켤 수 있음).
            # ※ Slice3 TLS floor 는 사내 CA 사이트를 깨서 제거 — 자율 SSO 를 MITM-safe 로 켜려면
            #   운영자가 SA_BROWSER_VERIFY_TLS=true + 사내 CA 신뢰를 **명시** 설정(사내망 기본은 무시).
            "ignore_https_errors": (
                os.environ.get("SA_BROWSER_VERIFY_TLS", "").lower() not in ("1", "true", "yes")
            ),
            # Slice3: Service Worker fetch 는 page CDP Fetch 게이트를 우회할 수 있으나, 사내 SW 앱을
            # 깨므로 기본 허용. 외부 미신뢰 대상 자율 브라우징 시 SA_BROWSER_BLOCK_SERVICE_WORKERS=true.
            "service_workers": (
                "block" if _truthy_env("SA_BROWSER_BLOCK_SERVICE_WORKERS") else "allow"
            ),
        }
        if basic_user and basic_pass:
            context_kwargs["http_credentials"] = {
                "username": basic_user, "password": basic_pass,
            }
        # v3.67: 사전 인증 세션 주입. env 설정됐는데 파일이 잘못되면 "조용히 비인증
        # 점검"으로 0건 나오는 혼란을 막기 위해 fail-loud (start 실패).
        sess = _resolve_session_state()
        if sess["mode"] == "error":
            await _close_quietly(browser, pw)
            return False, f"세션 주입 실패 — {sess['error']}"
        if sess["mode"] == "storage_state":
            context_kwargs["storage_state"] = sess["path"]
        try:
            ctx = await browser.new_context(**context_kwargs)
        except Exception as e:
            await _close_quietly(browser, pw)
            if sess["mode"] == "storage_state":
                # storage_state 파일이 깨졌을 때. Playwright 예외엔 쿠키값이 섞일 수
                # 있어 type 만 노출(원문/값 미노출 — chat/DB 유출 방지).
                return False, (f"세션(storage_state) 로드 실패: {type(e).__name__} — "
                               "파일/쿠키 구조 확인")
            return False, f"browser context 생성 실패: {type(e).__name__}"
        if sess["mode"] == "cookies":
            try:
                await ctx.add_cookies(sess["cookies"])
            except Exception as e:
                await _close_quietly(browser, pw, ctx)
                # 예외 메시지에 쿠키값이 섞일 수 있어 type 만 노출.
                return False, f"세션 쿠키 주입 실패: {type(e).__name__}"
        _SESSION_STATE["injected_session"] = (
            {"mode": sess["mode"], "count": sess["count"], "source": sess["source"]}
            if sess["mode"] in ("storage_state", "cookies") else None
        )
        page = await ctx.new_page()
        page.set_default_timeout(30_000)
        _attach_page_observers(page)
        # Slice3: 팝업/새 page 도 게이트. hook 등록 실패면 이후 팝업이 전(全)수명 미게이트가
        # 되므로 **세션 시작 실패**(fail-closed, codex 라운드3 #3).
        try:
            ctx.on("page", lambda p: asyncio.create_task(_install_fetch_gate_safe(p)))
        except Exception as e:
            await _close_quietly(browser, pw, ctx)
            return False, f"new-page 게이트 hook 설치 실패(fail-closed): {type(e).__name__}"
        try:
            await _install_fetch_gate(page)     # redirect hop url_safety 사전차단(CDP Fetch)
        except Exception as e:                  # 안전 전제조건 → 설치 실패면 세션 시작 실패(fail-closed)
            await _close_quietly(browser, pw, ctx)
            return False, f"navigation 안전 게이트 설치 실패(fail-closed): {type(e).__name__}"
        _SESSION_STATE["playwright"] = pw
        _SESSION_STATE["browser"] = browser
        _SESSION_STATE["context"] = ctx
        _SESSION_STATE["page"] = page
        _SESSION_STATE["started_at"] = _now_iso()
        _SESSION_STATE["last_used"] = time.monotonic()  # v3.69: idle reaper 기준
        _SESSION_STATE["navigations"] = 0
        # (owner_token/browser_pid 는 launch 직후 이미 등록됨 — F5-B)
        return True, None
    except Exception as e:
        # 부분 클린업
        await _stop_session()
        return False, f"browser start failed: {e}"


async def _stop_session() -> None:
    page = _SESSION_STATE.get("page")
    ctx = _SESSION_STATE.get("context")
    browser = _SESSION_STATE.get("browser")
    pw = _SESSION_STATE.get("playwright")
    try:
        # Slice3(codex): enforcement 를 page/context 보다 **먼저 제거하면** detach~close 사이에
        # page JS 가 미게이트로 egress 하는 창이 생긴다. 게이트를 붙인 채 page/context/browser 를
        # 먼저 닫아 in-flight 요청을 취소한 뒤, 죽은 CDP 세션을 정리한다.
        if page:
            try:
                await page.close()
            except Exception:
                pass
        if ctx:
            try:
                await ctx.close()
            except Exception:
                pass
        browser_closed = browser is None
        if browser:
            try:
                await browser.close()
                browser_closed = True
            except Exception:
                pass
        # Slice3(codex 라운드5): browser 종료가 확인된 경우에만 CDP detach. 종료 실패(살아있는
        # target)면 detach 안 함 — Fetch 게이트를 붙인 채 둬 enforcement 를 유지(미게이트 target 방지).
        if browser_closed:
            for cdp in _SESSION_STATE.get("cdp_gates", []) or []:
                try:
                    await cdp.detach()
                except Exception:
                    pass
        if pw:
            try:
                await pw.stop()
            except Exception:
                pass
    finally:
        _unregister_browser_process()  # F5-B: 정상 close → registry 에서 제거
        _SESSION_STATE["browser_pid"] = None
        _SESSION_STATE["owner_token"] = None
        _SESSION_STATE["playwright"] = None
        _SESSION_STATE["browser"] = None
        _SESSION_STATE["context"] = None
        _SESSION_STATE["page"] = None
        _SESSION_STATE["cdp_gates"] = []  # Slice3
        _SESSION_STATE["started_at"] = None
        _SESSION_STATE["last_used"] = None
        _SESSION_STATE["injected_session"] = None  # v3.67: 다음 start 가 env 재해석
        _SESSION_STATE["evidence_dir"] = None
        _SESSION_STATE["navigations"] = 0
        _SESSION_STATE["last_screenshot"] = None
        _clear_browser_refs()


# ============================================================
# v3.69: 세션 라이프사이클 — idle reaper + 종료훅
#   ① 종료훅 없음: 서버 graceful stop 시 chromium 회수 안 돼 orphan 누수.
#   ② idle reaper 없음: stop 안 불린 세션이 재기동까지 상주(>600MB/세션).
# 둘 다 여기서 막는다. SIGKILL 엔 ① 가 안 도니 재기동은 TERM 을 쓸 것.
# ============================================================


def _idle_timeout_seconds() -> float:
    """idle 세션 자동 종료 임계(초). 0 이하면 reaper 비활성."""
    try:
        return float(os.environ.get("SA_BROWSER_IDLE_TIMEOUT", "600"))
    except ValueError:
        return 600.0


def _touch_session() -> None:
    """실제 브라우저 op 시 호출 — idle 타이머 리셋."""
    _SESSION_STATE["last_used"] = time.monotonic()


def _session_idle_for(now: float) -> bool:
    timeout = _idle_timeout_seconds()
    if timeout <= 0:
        return False
    last = _SESSION_STATE.get("last_used")
    return last is not None and (now - last) >= timeout


async def reap_idle_session(now: float | None = None) -> bool:
    """idle 임계 초과한 브라우저 세션을 자동 정리. 정리했으면 True.

    락 밖에서 1차 판정 후, 락 안에서 재확인(그 사이 활동했으면 살림) → race 안전.
    """
    if not _is_running():
        return False
    cur = time.monotonic() if now is None else now
    if not _session_idle_for(cur):
        return False
    async with _BROWSER_LOCK:
        cur2 = time.monotonic() if now is None else now
        if not _is_running() or not _session_idle_for(cur2):
            return False
        await _stop_session()
    _record_browser_event(
        kind="session", action="reap", ok=True,
        message=f"idle>{_idle_timeout_seconds():.0f}s 자동 종료 (chromium 회수)",
    )
    logger.info("browser idle session reaped (idle>%.0fs)", _idle_timeout_seconds())
    return True


async def shutdown_browser() -> None:
    """앱 종료(lifespan finally) 시 chromium graceful 회수 — orphan 누수 방지."""
    async with _BROWSER_LOCK:
        if _is_running():
            await _stop_session()
            logger.info("browser session closed on shutdown")


async def browser_reaper_loop(stop_event: "asyncio.Event",
                              interval_seconds: float = 60.0) -> None:
    """백그라운드 reaper — interval 마다 idle 세션 점검. stop_event 로 종료."""
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
        except asyncio.TimeoutError:
            pass
        if stop_event.is_set():
            break
        try:
            await reap_idle_session()
        except Exception as e:  # reaper 는 절대 죽으면 안 됨
            logger.debug("browser reaper tick failed: %s", e)


def _require_page() -> tuple[Any, ToolError | None]:
    page = _SESSION_STATE.get("page")
    if page is None:
        return None, ToolError(
            kind="not_started",
            message="browser session 미시작 — browser_session(action='start') 먼저.",
        )
    if _page_is_closed(page):
        return None, ToolError(
            kind="stale_session",
            message="browser page 가 이미 닫힘 — browser_session(action='stop') 후 start 로 재시작.",
        )
    return page, None


# ============================================================
# BrowserSessionTool
# ============================================================


class BrowserSessionInput(BaseModel):
    action: Literal["start", "stop", "status"]
    headless: bool = Field(default=True, description="False = headed (디버깅).")
    viewport_width: int = Field(default=1280, ge=320, le=3840)
    viewport_height: int = Field(default=800, ge=240, le=2160)


class BrowserSessionTool(Tool[BrowserSessionInput]):
    name: ClassVar[str] = "browser_session"
    description: ClassVar[str] = (
        "Playwright 브라우저 세션 생명주기 (start / stop / status). "
        "한 process 안에 1 session — 새 start 호출은 기존이 있으면 no-op. "
        "에이전트 작업 끝나면 stop 으로 명시 종료."
    )
    input_model: ClassVar[type[BaseModel]] = BrowserSessionInput
    is_read_only: ClassVar[bool] = False
    is_destructive: ClassVar[bool] = True
    domain: ClassVar[str] = "web"
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "browser playwright headless chromium session start stop"
    prompt_section: ClassVar[str] = (
        "### browser_session(action, headless=True)\n"
        "Playwright 세션 생명주기. action=start/stop/status. 한 번에 1 session."
    )

    async def execute(self, vi: BrowserSessionInput, ctx: ToolContext) -> ToolResult:
        async with _BROWSER_LOCK:
            _remember_evidence_dir(ctx)
            if vi.action == "status":
                health = _browser_health()
                return ToolSuccess(content=(
                    f"running={health['running']} started_at={health['started_at']} "
                    f"url={health['url']!r} navigations={health['navigations']} "
                    f"page_alive={health['page_alive']} events={health['event_count']}"
                ))
            if vi.action == "start":
                ok, reason = await _start_session(
                    headless=vi.headless,
                    viewport_width=vi.viewport_width,
                    viewport_height=vi.viewport_height,
                )
                if not ok:
                    _record_browser_event(
                        kind="session", action="start", ok=False,
                        message=reason or "start failed",
                    )
                    return ToolError(kind="forbidden", message=reason or "start failed")
                _record_browser_event(
                    kind="session", action="start", ok=True,
                    message=f"headless={vi.headless} viewport={vi.viewport_width}x{vi.viewport_height}",
                )
                return ToolSuccess(content=(
                    f"started headless={vi.headless} "
                    f"viewport={vi.viewport_width}x{vi.viewport_height}"
                ))
            if vi.action == "stop":
                if not _is_running():
                    return ToolSuccess(content="not running")
                await _stop_session()
                _record_browser_event(kind="session", action="stop", ok=True, message="stopped")
                return ToolSuccess(content="stopped")
            return ToolError(kind="validation", message=f"unknown action: {vi.action}")


# ============================================================
# BrowserActionTool — 상태 변경
# ============================================================


_CLICK_XY_MAX = 20000  # click_xy 좌표 상한(px) — 뷰포트 밖 터무니없는 값 거부
_SCREENSHOT_INLINE_MAX_BYTES_DEFAULT = 2 * 1024 * 1024  # 이보다 큰 PNG 는 인라인 생략


def _screenshot_inline_cap_bytes() -> int:
    """F4-C: screenshot 픽셀 되먹임 인라인 상한(원본 PNG 바이트). SA_BROWSER_SCREENSHOT_
    INLINE_MAX_BYTES 로 조정(기본 2MB, 0=인라인 비활성). 엔진의 턴당 총 cap 이 최종 backstop."""
    raw = (os.environ.get("SA_BROWSER_SCREENSHOT_INLINE_MAX_BYTES") or "").strip()
    if not raw:
        return _SCREENSHOT_INLINE_MAX_BYTES_DEFAULT
    try:
        value = int(raw)
    except ValueError:
        return _SCREENSHOT_INLINE_MAX_BYTES_DEFAULT
    return value if value >= 0 else 0


async def _click_point_scope_error(page: Any, x: int, y: int) -> "ToolError | None":
    """F4-A 안전(S2): 좌표 클릭이 off-scope cross-origin iframe 컨트롤을 물리적으로 누르지
    못하게 한다. 셀렉터/ref 클릭은 top-frame DOM 에 갇히지만 좌표 클릭은 그 픽셀 위 어떤
    것이든 누른다 — 그 지점을 덮는 iframe 이 있으면 src 를 url_safety(scope+hard-block)로
    검증해 off-scope 면 차단(read-only/scope 불변식).

    **fail-closed(V2)**: 지점 안전성을 검증 못 하면(eval 실패/불가) 클릭하지 않는다.

    위협 모델/잔여(정직): 대상은 org 자사 자산이라 현실적 위험은 **우발적** off-scope iframe
    embed 다 — 일반 DOM + **열린 shadow root** 내부 iframe 까지 이 가드가 잡는다(shadow 관통
    hit-test). 잔여: **닫힌 shadow root** 내부 iframe(page-JS 로 접근 불가). **완전 적대적
    페이지**는 page-JS(elementFromPoint override·중첩 iframe·stale src·TOCTOU, V1/V3/V4)로 이
    가드를 우회할 수 있다 — 그런 페이지는 다른 벡터로도 위험하며, read-only 불변식 +
    is_destructive 승인 + navigate-scope 가 1차 방벽이다. 완전 방어는 page-JS 아닌 **CDP 레벨
    hit-test**(더 큰 변경)가 필요. 클릭 후 top-frame off-scope 이동(redirect)은 브라우저 도구
    전반의 기존 한계(click_xy 신규 아님)."""
    js = (
        "([x, y]) => {"
        " let el = document.elementFromPoint(x, y);"
        " let guard = 0;"
        " while (el && el.shadowRoot && guard++ < 20) {"  # 열린 shadow root 관통 hit-test
        "   const inner = el.shadowRoot.elementFromPoint(x, y);"
        "   if (!inner || inner === el) break;"
        "   el = inner;"
        " }"
        " if (!el) return {hit: false};"
        " if (el.tagName === 'IFRAME') return {iframe: true, src: el.src || ''};"
        " return {iframe: false};"
        " }"
    )
    try:
        info = await page.evaluate(js, [x, y])
    except Exception as e:  # noqa: BLE001 — 검출 불가 → fail-closed(안전측: 클릭 안 함)
        logger.debug("click_xy 지점 검증 실패 → 차단(fail-closed): %r", e)
        return ToolError(
            kind="forbidden",
            message="click_xy 지점 안전성 검증 실패(elementFromPoint) — 차단(fail-closed)",
        )
    if isinstance(info, dict) and info.get("iframe"):
        src = str(info.get("src") or "").strip()
        # about:blank/srcdoc(빈 src) iframe 은 별도 origin 아님 → 통과.
        if src and not src.startswith("about:"):
            try:
                _validate_browser_url_safe(src)
            except URLSafetyError as e:
                return ToolError(
                    kind="forbidden",
                    message=(
                        f"click_xy 지점이 off-scope iframe({src[:120]}) 위 — 차단 "
                        f"(read-only/scope 불변식): {e}"
                    ),
                )
    return None


class BrowserActionInput(BaseModel):
    action: Literal[
        "navigate", "click", "click_xy", "fill", "press",
        "scroll", "wait", "eval", "login",
    ]
    login_mode: Literal["auto", "sso", "defaults"] = Field(
        default="auto",
        description=(
            "login 시 자격증명 소스. sso=.env SA_WEB_SSO_USER/PASS (사이트당 1회). "
            "defaults=SA_WEB_DEFAULT_CREDS_ENABLED=true 일 때만 기본조합 여러개. "
            "auto=SSO 페이지면 sso, 아니면 defaults(미 opt-in 시 skip)."
        ),
    )
    url: str | None = Field(default=None, description="navigate 시 URL.")
    selector: str | None = Field(default=None, description="click/fill/press 시 CSS selector.")
    ref: str | None = Field(default=None, description="snapshot 이 반환한 @eN element ref.")
    text: str | None = Field(default=None, description="fill 시 입력 텍스트.")
    key: str | None = Field(default=None, description="press 시 키 (예: Enter, Tab).")
    expression: str | None = Field(default=None, description="eval 시 JS expression.")
    max_chars: int = Field(default=8000, ge=200, le=50_000)
    delta_y: int = Field(default=0, description="scroll 시 픽셀. + 아래, - 위.")
    wait_seconds: float = Field(default=2.0, ge=0, le=15.0, description="wait 시 초.")
    # F4-A: 좌표 클릭(비전 브라우징) — 스크린샷에서 읽은 viewport 픽셀 좌표로 클릭.
    x: int | None = Field(default=None, description="click_xy 시 viewport X 좌표(px).")
    y: int | None = Field(default=None, description="click_xy 시 viewport Y 좌표(px).")


class BrowserActionTool(Tool[BrowserActionInput]):
    name: ClassVar[str] = "browser_action"
    description: ClassVar[str] = (
        "Browser 상태 변경: navigate(url) / click(selector|ref) / click_xy(x,y) / "
        "fill(selector|ref,text) / press(selector|ref,key) / scroll(delta_y) / "
        "wait(wait_seconds) / eval(expression). "
        "URL 안전성 검증 (loopback/link-local 차단). password 같은 secret 은 "
        "환경변수로만 — agent input 으로 직접 안 받음 (해당 페이지엔 env 자격 자동 inject)."
    )
    input_model: ClassVar[type[BaseModel]] = BrowserActionInput
    is_read_only: ClassVar[bool] = False
    is_destructive: ClassVar[bool] = True
    domain: ClassVar[str] = "web"
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "browser navigate click fill type press scroll keyboard"
    prompt_section: ClassVar[str] = (
        "### browser_action(action, url|selector|ref|text|key|delta_y|wait_seconds|x,y)\n"
        "navigate(url) / click(selector|ref) / click_xy(x,y) / fill(selector|ref, text) / "
        "press(selector|ref, key) / scroll(delta_y) / wait(wait_seconds). "
        "eval(expression)은 페이지 컨텍스트 JS 실행. ref 는 "
        "browser_query(action='snapshot') 의 @eN 사용. click_xy 는 스크린샷에서 읽은 "
        "viewport 픽셀 좌표 클릭(비전 브라우징). password 는 환경변수만."
    )

    async def execute(self, vi: BrowserActionInput, ctx: ToolContext) -> ToolResult:
        async with _BROWSER_LOCK:
            _remember_evidence_dir(ctx)
            page, err = _require_page()
            if err:
                return err
            _touch_session()  # v3.69: idle reaper 타이머 리셋
            try:
                if vi.action == "navigate":
                    if not vi.url:
                        return ToolError(kind="validation", message="navigate needs url")
                    try:
                        _validate_browser_url_safe(vi.url)
                    except URLSafetyError as e:
                        _record_browser_event(
                            kind="action", action="navigate", ok=False,
                            message=f"unsafe url: {e}", url=vi.url,
                        )
                        return ToolError(kind="forbidden", message=f"unsafe url: {e}")
                    await page.goto(vi.url, wait_until="domcontentloaded")
                    _SESSION_STATE["navigations"] += 1
                    _clear_browser_refs()
                    _mark_web_host_visited(ctx, page)
                    _record_browser_event(
                        kind="action", action="navigate", ok=True,
                        message="navigated", url=_safe_page_url(page),
                    )
                    return ToolSuccess(content=f"navigated to {page.url}")
                if vi.action == "login":
                    ok, msg, fatal = await _perform_login(page, vi.login_mode)
                    if fatal:
                        return ToolError(kind="validation", message=msg)
                    _clear_browser_refs()
                    _mark_web_host_visited(ctx, page)
                    _record_browser_event(
                        kind="action", action="login", ok=ok,
                        message=msg, url=_safe_page_url(page),  # 비번 미포함
                    )
                    # 실패도 ToolSuccess 로 (에이전트가 skipped 처리하도록 메시지 전달).
                    return ToolSuccess(content=msg)
                if vi.action == "click":
                    target, target_err = _resolve_browser_target(
                        selector=vi.selector, ref=vi.ref,
                    )
                    if target_err:
                        return target_err
                    await page.click(target)
                    _record_browser_event(
                        kind="action", action="click", ok=True,
                        message=f"clicked {target!r}", url=_safe_page_url(page),
                    )
                    return ToolSuccess(content=f"clicked {target!r}")
                if vi.action == "click_xy":
                    # F4-A: 좌표 클릭. 스크린샷에서 읽은 viewport 픽셀로 클릭한다(비전 브라우징).
                    if vi.x is None or vi.y is None:
                        return ToolError(kind="validation", message="click_xy needs x and y")
                    if not (0 <= vi.x <= _CLICK_XY_MAX and 0 <= vi.y <= _CLICK_XY_MAX):
                        return ToolError(
                            kind="validation",
                            message=f"click_xy x/y 는 [0, {_CLICK_XY_MAX}] 범위여야 함",
                        )
                    # S2: off-scope cross-origin iframe 컨트롤 클릭 차단(또는 지점 검증 실패).
                    scope_err = await _click_point_scope_error(page, vi.x, vi.y)
                    if scope_err:
                        _record_browser_event(
                            kind="action", action="click_xy", ok=False,
                            # A4: 실제 차단 사유 기록(iframe 차단 vs 검증실패 구분).
                            message=f"click_xy blocked: {scope_err.message[:120]}",
                            url=_safe_page_url(page),
                        )
                        return scope_err
                    await page.mouse.click(vi.x, vi.y)
                    _record_browser_event(
                        kind="action", action="click_xy", ok=True,
                        message=f"clicked ({vi.x},{vi.y})", url=_safe_page_url(page),
                    )
                    return ToolSuccess(content=f"clicked at ({vi.x},{vi.y})")
                if vi.action == "fill":
                    target, target_err = _resolve_browser_target(
                        selector=vi.selector, ref=vi.ref,
                    )
                    if target_err:
                        return target_err
                    if vi.text is None:
                        return ToolError(kind="validation", message="fill needs text")
                    # secret-looking text는 거부 — env 로만
                    if _looks_like_secret(vi.text):
                        _record_browser_event(
                            kind="action", action="fill", ok=False,
                            message="secret-like text rejected", url=_safe_page_url(page),
                        )
                        return ToolError(
                            kind="forbidden",
                            message=(
                                "fill text 가 secret-like — agent 가 직접 password/token "
                                "넣지 마라. SA_BROWSER_BASIC_AUTH_* 같은 env 로."
                            ),
                        )
                    await page.fill(target, vi.text)
                    _record_browser_event(
                        kind="action", action="fill", ok=True,
                        message=f"filled {target!r} ({len(vi.text)} chars)",
                        url=_safe_page_url(page),
                    )
                    return ToolSuccess(
                        content=f"filled {target!r} ({len(vi.text)} chars)",
                    )
                if vi.action == "press":
                    if not vi.key:
                        return ToolError(kind="validation", message="press needs key")
                    if vi.selector or vi.ref:
                        target, target_err = _resolve_browser_target(
                            selector=vi.selector, ref=vi.ref,
                        )
                        if target_err:
                            return target_err
                    else:
                        target = "body"
                    await page.press(target, vi.key)
                    _record_browser_event(
                        kind="action", action="press", ok=True,
                        message=f"pressed {vi.key!r} on {target!r}", url=_safe_page_url(page),
                    )
                    return ToolSuccess(content=f"pressed {vi.key!r} on {target!r}")
                if vi.action == "scroll":
                    await page.mouse.wheel(0, vi.delta_y)
                    _record_browser_event(
                        kind="action", action="scroll", ok=True,
                        message=f"delta_y={vi.delta_y}", url=_safe_page_url(page),
                    )
                    return ToolSuccess(content=f"scrolled delta_y={vi.delta_y}")
                if vi.action == "wait":
                    await asyncio.sleep(vi.wait_seconds)
                    _record_browser_event(
                        kind="action", action="wait", ok=True,
                        message=f"waited {vi.wait_seconds}s", url=_safe_page_url(page),
                    )
                    return ToolSuccess(content=f"waited {vi.wait_seconds}s")
                if vi.action == "eval":
                    if not vi.expression:
                        return ToolError(kind="validation", message="eval needs expression")
                    payload = await _evaluate_browser_expression(
                        page=page,
                        expression=vi.expression,
                        max_chars=vi.max_chars,
                    )
                    _record_browser_event(
                        kind="action", action="eval", ok=True,
                        message=f"evaluated JS expression ({len(vi.expression)} chars)",
                        url=_safe_page_url(page),
                    )
                    _record_browser_console_event(
                        level="eval",
                        text=f"expression={vi.expression[:200]}",
                        url=_safe_page_url(page),
                    )
                    return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))
                return ToolError(kind="validation", message=f"unknown action: {vi.action}")
            except Exception as e:
                _record_browser_event(
                    kind="action", action=vi.action, ok=False,
                    message=f"{vi.action} failed: {e}", url=_safe_page_url(page),
                )
                return ToolError(kind="runtime", message=f"{vi.action} failed: {e}")


# ============================================================
# BrowserQueryTool — 상태 조회
# ============================================================


class BrowserQueryInput(BaseModel):
    action: Literal["snapshot", "html", "screenshot", "title", "url"]
    selector: str | None = Field(
        default=None,
        description="snapshot/html 시 한정 selector (None=전체 body).",
    )
    max_chars: int = Field(default=8000, ge=200, le=50_000)
    output_path: str | None = Field(
        default=None,
        description="screenshot 시 저장할 절대 파일 경로. .png 아니면 .png를 붙임.",
    )
    output_dir: str | None = Field(
        default=None,
        description="screenshot 시 저장할 절대 디렉토리. 파일명은 자동 생성.",
    )
    filename_prefix: str = Field(
        default="screenshot",
        description="output_dir 사용 시 자동 파일명 prefix.",
    )
    # F4-C: screenshot 픽셀을 모델에 되먹임(비전 브라우징). 파일 저장은 그대로 하고,
    # 추가로 base64 이미지를 결과에 실어 모델이 화면을 '본다'. 큰 이미지는 인라인 생략(캡).
    return_image: bool = Field(
        default=False,
        description="screenshot 시 픽셀을 모델에 되먹임(base64 이미지). 좌표 클릭용 화면 인식.",
    )


class BrowserQueryTool(Tool[BrowserQueryInput]):
    name: ClassVar[str] = "browser_query"
    description: ClassVar[str] = (
        "Browser 상태 조회 (read-only): snapshot (visible text + 주요 element) / "
        "html (선택 영역 outerHTML) / screenshot (evidence_dir 또는 승인된 경로에 PNG 저장) / title / url. "
        "본문은 max_chars cap — context 폭주 방지. "
        "screenshot(return_image=true) 는 화면 픽셀을 되먹여 네가 화면을 '보고' 좌표를 읽을 "
        "수 있게 한다 — snapshot 셀렉터로 못 잡는 요소를 browser_action(click_xy)로 클릭할 때 사용."
    )
    input_model: ClassVar[type[BaseModel]] = BrowserQueryInput
    is_read_only: ClassVar[bool] = True
    is_destructive: ClassVar[bool] = False
    domain: ClassVar[str] = "web"
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "browser snapshot screenshot html dom text page state"
    prompt_section: ClassVar[str] = (
        "### browser_query(action, selector?, max_chars=8000, return_image?)\n"
        "Browser read-only: snapshot / html / screenshot / title / url. "
        "snapshot 은 visible text + 주요 인터랙티브 element. cap 8K chars (50K max). "
        "screenshot 은 기본 evidence_dir 저장. 사용자가 `~/Documents` 같은 위치를 "
        "요구하면 output_dir 또는 output_path 를 명시하고, final 에는 tool result 의 "
        "실제 경로만 보고.\n"
        "**비전 브라우징 루프**: snapshot 셀렉터/ref 로 요소를 못 잡을 때 —\n"
        "  1) browser_query(action='screenshot', return_image=true) → 화면 픽셀을 본다.\n"
        "  2) 이미지에서 대상의 viewport 픽셀 좌표(x,y)를 읽는다.\n"
        "  3) browser_action(action='click_xy', x=…, y=…) 로 클릭.\n"
        "  4) 필요하면 다시 screenshot 으로 결과를 확인(루프). 셀렉터/ref 가 있으면 그걸 "
        "우선 — click_xy 는 fallback(off-scope iframe 은 자동 차단)."
    )

    async def check_permission(
        self, validated_input: BrowserQueryInput, context: ToolContext,
    ) -> PermissionDecision:
        del context
        if (
            validated_input.action == "screenshot"
            and (validated_input.output_path or validated_input.output_dir)
        ):
            return PermissionDecision(
                behavior="ask",
                reason="custom screenshot output path writes outside the evidence store",
            )
        return PermissionDecision(behavior="allow")

    async def execute(self, vi: BrowserQueryInput, ctx: ToolContext) -> ToolResult:
        async with _BROWSER_LOCK:
            _remember_evidence_dir(ctx)
            page, err = _require_page()
            if err:
                return err
            _touch_session()  # v3.69: idle reaper 타이머 리셋
            _mark_web_host_visited(ctx, page)
            try:
                if vi.action == "url":
                    return ToolSuccess(content=page.url)
                if vi.action == "title":
                    return ToolSuccess(content=await page.title())
                if vi.action == "html":
                    sel = vi.selector or "body"
                    el = await page.query_selector(sel)
                    if not el:
                        return ToolError(
                            kind="not_found", message=f"selector {sel!r} 매치 없음",
                        )
                    html = await el.inner_html()
                    return ToolSuccess(content=_cap(html, vi.max_chars))
                if vi.action == "snapshot":
                    snap = await _build_snapshot(page, vi.selector)
                    return ToolSuccess(content=_cap(snap, vi.max_chars))
                if vi.action == "screenshot":
                    try:
                        out_path = _resolve_screenshot_output_path(vi, ctx.evidence_dir)
                    except (PathBlockError, ValueError) as e:
                        return ToolError(kind="forbidden", message=str(e))
                    await page.screenshot(path=str(out_path), full_page=False)
                    if not out_path.is_file():
                        return ToolError(
                            kind="io_error",
                            message=f"screenshot write did not create file: {out_path}",
                        )
                    size = out_path.stat().st_size
                    if size <= 0:
                        return ToolError(
                            kind="io_error",
                            message=f"screenshot file is empty: {out_path}",
                        )
                    _record_browser_event(
                        kind="query", action="screenshot", ok=True,
                        message="screenshot saved", url=_safe_page_url(page),
                        artifact=str(out_path),
                    )
                    note = (
                        f"saved {out_path} "
                        f"(current viewport, full_page=False, verified size={size} bytes)"
                    )
                    # F4-C: 픽셀 되먹임(opt-in). 인라인 캡 초과면 파일만(모델은 이미지 못 봄).
                    images: tuple[ToolImage, ...] = ()
                    if vi.return_image:
                        cap = _screenshot_inline_cap_bytes()
                        if cap > 0 and size <= cap:
                            try:
                                data_b64 = base64.b64encode(out_path.read_bytes()).decode("ascii")
                                images = (ToolImage(media_type="image/png", data_b64=data_b64),)
                            except OSError as e:
                                note += f" [inline 실패: {e}]"
                        else:
                            note += (
                                f" [inline 생략: {size}B > cap {cap}B — 축소 후 재촬영하거나 "
                                "SA_BROWSER_SCREENSHOT_INLINE_MAX_BYTES 상향]"
                            )
                    return ToolSuccess(content=note, images=images)
                return ToolError(kind="validation", message=f"unknown action: {vi.action}")
            except Exception as e:
                _record_browser_event(
                    kind="query", action=vi.action, ok=False,
                    message=f"{vi.action} failed: {e}", url=_safe_page_url(page),
                )
                return ToolError(kind="runtime", message=f"{vi.action} failed: {e}")


# ============================================================
# BrowserSupervisorTool — health / event log / evidence capture
# ============================================================


class BrowserSupervisorInput(BaseModel):
    action: Literal["health", "events", "api_candidates", "capture"]
    selector: str | None = Field(
        default=None,
        description="capture 시 snapshot/html 범위. None=body.",
    )
    max_chars: int = Field(default=8000, ge=200, le=50_000)
    include_screenshot: bool = Field(default=True)
    limit: int = Field(default=50, ge=1, le=200)


class BrowserSupervisorTool(Tool[BrowserSupervisorInput]):
    name: ClassVar[str] = "browser_supervisor"
    description: ClassVar[str] = (
        "Browser supervisor: health 진단, 최근 event 조회, API 후보 요약, "
        "snapshot/html/screenshot evidence capture. 장애가 나면 health/events 로 상태를 먼저 확인."
    )
    input_model: ClassVar[type[BaseModel]] = BrowserSupervisorInput
    is_read_only: ClassVar[bool] = True
    is_destructive: ClassVar[bool] = False
    domain: ClassVar[str] = "web"
    deferred: ClassVar[bool] = True
    search_hint: ClassVar[str] = "browser supervisor health events capture diagnostics evidence"
    prompt_section: ClassVar[str] = (
        "### browser_supervisor(action)\n"
        "health / events / api_candidates / capture. api_candidates 는 브라우저 네트워크 "
        "이벤트에서 API 후보를 요약하고, capture 는 snapshot+html(+screenshot)을 evidence_dir 에 저장."
    )

    async def execute(self, vi: BrowserSupervisorInput, ctx: ToolContext) -> ToolResult:
        async with _BROWSER_LOCK:
            _remember_evidence_dir(ctx)
            if vi.action == "health":
                return ToolSuccess(content=json.dumps(_browser_health(), ensure_ascii=False))
            if vi.action == "events":
                payload = {
                    "health": _browser_health(),
                    "events": list(_BROWSER_EVENTS),
                    "network_events": list(_BROWSER_NETWORK_EVENTS),
                    "dynamic_response_events": list(_BROWSER_DYNAMIC_RESPONSE_EVENTS),
                    "console_events": list(_BROWSER_CONSOLE_EVENTS),
                    "frame_events": list(_BROWSER_FRAME_EVENTS),
                    "dialog_events": list(_BROWSER_DIALOG_EVENTS),
                    "download_events": list(_BROWSER_DOWNLOAD_EVENTS),
                }
                return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))
            if vi.action == "api_candidates":
                return ToolSuccess(
                    content=json.dumps(
                        _browser_api_candidates(limit=vi.limit),
                        ensure_ascii=False,
                    ),
                )
            if vi.action == "capture":
                page, err = _require_page()
                if err:
                    return err
                try:
                    payload = await _capture_browser_state(
                        page=page,
                        evidence_dir=ctx.evidence_dir,
                        selector=vi.selector,
                        max_chars=vi.max_chars,
                        include_screenshot=vi.include_screenshot,
                    )
                    _record_browser_event(
                        kind="supervisor", action="capture", ok=True,
                        message="capture saved", url=payload["url"],
                        artifact=payload["metadata_path"],
                    )
                    return ToolSuccess(content=json.dumps(payload, ensure_ascii=False))
                except Exception as e:
                    _record_browser_event(
                        kind="supervisor", action="capture", ok=False,
                        message=f"capture failed: {e}", url=_safe_page_url(page),
                    )
                    return ToolError(kind="runtime", message=f"capture failed: {e}")
            return ToolError(kind="validation", message=f"unknown action: {vi.action}")


# ============================================================
# Helpers
# ============================================================


# secret-like 패턴 — basic detection. agent 가 fill 로 비번/토큰 박는 케이스 차단용.
_SECRET_LIKE = (
    re.compile(r"sk-[A-Za-z0-9_-]{10,}"),
    re.compile(r"ghp_[A-Za-z0-9]{10,}"),
    re.compile(r"^Bearer\s+\S+", re.IGNORECASE),
    re.compile(r"eyJ[A-Za-z0-9_-]{10,}\."),  # JWT-ish
    re.compile(r"AKIA[A-Z0-9]{16}"),
)


def _looks_like_secret(text: str) -> bool:
    if not text:
        return False
    for pat in _SECRET_LIKE:
        if pat.search(text):
            return True
    return False


def _safe_filename_prefix(prefix: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", (prefix or "screenshot").strip())
    safe = safe.strip("._-")
    return safe[:80] or "screenshot"


def _resolve_screenshot_output_path(
    vi: BrowserQueryInput,
    evidence_dir: Path,
) -> Path:
    if vi.output_path and vi.output_dir:
        raise ValueError("output_path and output_dir are mutually exclusive")
    if vi.output_path:
        out_path = _resolve_abs(vi.output_path)
        if out_path.suffix.lower() != ".png":
            out_path = out_path.with_suffix(".png")
    elif vi.output_dir:
        out_dir = _resolve_abs(vi.output_dir)
        prefix = _safe_filename_prefix(vi.filename_prefix)
        out_path = out_dir / f"{prefix}_{uuid4().hex[:12]}.png"
    else:
        out_dir = evidence_dir / "browser_screenshots"
        out_path = out_dir / f"screenshot_{uuid4().hex[:12]}.png"

    _validate_for_write(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    return out_path


def _cap(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + f"\n\n... [truncated — {len(text)} bytes, cap {max_chars}]"


async def _safe_page_title(page: Any) -> str:
    try:
        title = page.title()
        if hasattr(title, "__await__"):
            title = await title
        return str(title or "")
    except Exception:
        return ""


async def _capture_browser_state(
    *,
    page: Any,
    evidence_dir: Path,
    selector: str | None,
    max_chars: int,
    include_screenshot: bool,
) -> dict[str, Any]:
    out_dir = evidence_dir / "browser_captures"
    out_dir.mkdir(parents=True, exist_ok=True)

    cid = uuid4().hex[:12]
    sel = selector or "body"
    snapshot_path = out_dir / f"capture_{cid}.snapshot.txt"
    html_path = out_dir / f"capture_{cid}.html"
    metadata_path = out_dir / f"capture_{cid}.json"
    screenshot_path = out_dir / f"capture_{cid}.png"
    network_path = out_dir / f"capture_{cid}.network.json"
    dynamic_response_path = out_dir / f"capture_{cid}.dynamic_responses.json"
    console_path = out_dir / f"capture_{cid}.console.json"
    frame_path = out_dir / f"capture_{cid}.frames.json"
    dialog_path = out_dir / f"capture_{cid}.dialogs.json"
    download_path = out_dir / f"capture_{cid}.downloads.json"
    screenshot_diff_path = out_dir / f"capture_{cid}.screenshot_diff.json"

    snapshot = _cap(await _build_snapshot(page, selector), max_chars)
    el = await page.query_selector(sel)
    if not el:
        raise ValueError(f"selector {sel!r} 매치 없음")
    html = _cap(await el.inner_html(), max_chars)

    snapshot_path.write_text(snapshot, encoding="utf-8")
    html_path.write_text(html, encoding="utf-8")
    network_summary = _write_network_capture(network_path)
    dynamic_response_summary = _write_dynamic_response_capture(dynamic_response_path)
    console_summary = _write_console_capture(console_path)
    frame_summary = _write_frame_capture(frame_path)
    dialog_summary = _write_dialog_capture(dialog_path)
    download_summary = _write_download_capture(download_path)
    screenshot_value: str | None = None
    screenshot_diff_value: str | None = None
    screenshot_sha256: str | None = None
    if include_screenshot:
        await page.screenshot(path=str(screenshot_path), full_page=False)
        screenshot_value = str(screenshot_path)
        current_shot = _screenshot_fingerprint(screenshot_path)
        screenshot_sha256 = current_shot["sha256"]
        _write_screenshot_diff(screenshot_diff_path, current_shot)
        screenshot_diff_value = str(screenshot_diff_path)

    title = await _safe_page_title(page)
    payload = {
        "capture_id": cid,
        "created_at": _now_iso(),
        "url": _safe_page_url(page),
        "title": title,
        "selector": selector,
        "metadata_path": str(metadata_path),
        "snapshot_path": str(snapshot_path),
        "html_path": str(html_path),
        "screenshot_path": screenshot_value,
        "screenshot_sha256": screenshot_sha256,
        "screenshot_diff_path": screenshot_diff_value,
        "network_path": str(network_path),
        "dynamic_response_path": str(dynamic_response_path),
        "console_path": str(console_path),
        "frame_path": str(frame_path),
        "dialog_path": str(dialog_path),
        "download_path": str(download_path),
        "network_summary": network_summary,
        "dynamic_response_summary": dynamic_response_summary,
        "console_summary": console_summary,
        "frame_summary": frame_summary,
        "dialog_summary": dialog_summary,
        "download_summary": download_summary,
        "event_count": len(_BROWSER_EVENTS),
        "network_event_count": len(_BROWSER_NETWORK_EVENTS),
        "dynamic_response_event_count": len(_BROWSER_DYNAMIC_RESPONSE_EVENTS),
        "console_event_count": len(_BROWSER_CONSOLE_EVENTS),
        "frame_event_count": len(_BROWSER_FRAME_EVENTS),
        "dialog_event_count": len(_BROWSER_DIALOG_EVENTS),
        "download_event_count": len(_BROWSER_DOWNLOAD_EVENTS),
        "artifacts": {
            "metadata_path": str(metadata_path),
            "snapshot_path": str(snapshot_path),
            "html_path": str(html_path),
            "screenshot_path": screenshot_value,
            "screenshot_diff_path": screenshot_diff_value,
            "network_path": str(network_path),
            "dynamic_response_path": str(dynamic_response_path),
            "console_path": str(console_path),
            "frame_path": str(frame_path),
            "dialog_path": str(dialog_path),
            "download_path": str(download_path),
        },
    }
    metadata_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return payload


def _network_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    by_status: dict[str, int] = {}
    failed = 0
    for event in events:
        status = event.get("status")
        if status is not None:
            key = str(status)
            by_status[key] = by_status.get(key, 0) + 1
            if int(status) >= 400:
                failed += 1
        if event.get("phase") == "requestfailed":
            failed += 1
    return {
        "total": len(events),
        "failed": failed,
        "by_status": by_status,
    }


def _dynamic_response_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    by_resource_type: dict[str, int] = {}
    total_hits = 0
    truncated = 0
    for event in events:
        resource_type = str(event.get("resource_type") or "unknown")
        by_resource_type[resource_type] = by_resource_type.get(resource_type, 0) + 1
        total_hits += len(event.get("scan_hits") or [])
        if event.get("body_truncated"):
            truncated += 1
    return {
        "total": len(events),
        "with_scan_hits": sum(1 for e in events if e.get("scan_hits")),
        "scan_hits": total_hits,
        "truncated": truncated,
        "by_resource_type": by_resource_type,
    }


def _console_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    by_level: dict[str, int] = {}
    for event in events:
        level = str(event.get("level") or "log")
        by_level[level] = by_level.get(level, 0) + 1
    return {
        "total": len(events),
        "errors": sum(
            count for level, count in by_level.items()
            if level.lower() in {"error", "pageerror"}
        ),
        "by_level": by_level,
    }


def _phase_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    by_phase: dict[str, int] = {}
    for event in events:
        phase = str(event.get("phase") or "unknown")
        by_phase[phase] = by_phase.get(phase, 0) + 1
    return {"total": len(events), "by_phase": by_phase}


def _dialog_summary(events: list[dict[str, Any]]) -> dict[str, Any]:
    summary = _phase_summary(events)
    by_type: dict[str, int] = {}
    for event in events:
        typ = str(event.get("type") or "unknown")
        by_type[typ] = by_type.get(typ, 0) + 1
    summary["by_type"] = by_type
    return summary


def _write_network_capture(path: Path) -> dict[str, Any]:
    events = list(_BROWSER_NETWORK_EVENTS)
    summary = _network_summary(events)
    path.write_text(
        json.dumps({
            "created_at": _now_iso(),
            "summary": summary,
            "events": events,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary


def _write_dynamic_response_capture(path: Path) -> dict[str, Any]:
    events = list(_BROWSER_DYNAMIC_RESPONSE_EVENTS)
    summary = _dynamic_response_summary(events)
    path.write_text(
        json.dumps({
            "created_at": _now_iso(),
            "summary": summary,
            "events": events,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary


def _write_console_capture(path: Path) -> dict[str, Any]:
    events = list(_BROWSER_CONSOLE_EVENTS)
    summary = _console_summary(events)
    path.write_text(
        json.dumps({
            "created_at": _now_iso(),
            "summary": summary,
            "events": events,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary


def _write_frame_capture(path: Path) -> dict[str, Any]:
    events = list(_BROWSER_FRAME_EVENTS)
    summary = _phase_summary(events)
    path.write_text(
        json.dumps({
            "created_at": _now_iso(),
            "summary": summary,
            "events": events,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary


def _write_dialog_capture(path: Path) -> dict[str, Any]:
    events = list(_BROWSER_DIALOG_EVENTS)
    summary = _dialog_summary(events)
    path.write_text(
        json.dumps({
            "created_at": _now_iso(),
            "summary": summary,
            "events": events,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary


def _write_download_capture(path: Path) -> dict[str, Any]:
    events = list(_BROWSER_DOWNLOAD_EVENTS)
    summary = _phase_summary(events)
    path.write_text(
        json.dumps({
            "created_at": _now_iso(),
            "summary": summary,
            "events": events,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return summary


def _screenshot_fingerprint(path: Path) -> dict[str, Any]:
    body = path.read_bytes()
    return {
        "path": str(path),
        "sha256": hashlib.sha256(body).hexdigest(),
        "size": len(body),
    }


def _write_screenshot_diff(path: Path, current: dict[str, Any]) -> dict[str, Any]:
    previous = _SESSION_STATE.get("last_screenshot")
    changed = None if previous is None else previous.get("sha256") != current.get("sha256")
    payload = {
        "created_at": _now_iso(),
        "has_baseline": previous is not None,
        "previous": previous,
        "current": current,
        "changed": changed,
        "byte_delta": (
            None if previous is None
            else int(current.get("size") or 0) - int(previous.get("size") or 0)
        ),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    _SESSION_STATE["last_screenshot"] = current
    return payload


def _cap_eval_value(value: Any, max_chars: int) -> tuple[Any, bool]:
    if isinstance(value, str):
        if len(value) <= max_chars:
            return value, False
        return value[:max_chars] + f"\n\n... [truncated — {len(value)} chars, cap {max_chars}]", True
    try:
        encoded = json.dumps(value, ensure_ascii=False, default=str)
    except TypeError:
        encoded = str(value)
    if len(encoded) <= max_chars:
        return value, False
    return encoded[:max_chars] + f"\n\n... [truncated — {len(encoded)} chars, cap {max_chars}]", True


async def _evaluate_browser_expression(
    *,
    page: Any,
    expression: str,
    max_chars: int,
) -> dict[str, Any]:
    js = """
(expression) => {
  function safeString(value) {
    try { return String(value); } catch (e) { return '[unstringifiable]'; }
  }
  try {
    const value = globalThis.eval(expression);
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (type === 'undefined') {
      return { ok: true, type, value: null };
    }
    if (type === 'function') {
      return { ok: true, type, value: safeString(value) };
    }
    return { ok: true, type, value };
  } catch (e) {
    return {
      ok: false,
      type: 'error',
      error_name: e && e.name ? String(e.name) : 'Error',
      value: e && e.message ? String(e.message) : safeString(e),
    };
  }
}
"""
    raw = await page.evaluate(js, expression)
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            raw = {"ok": True, "type": "string", "value": raw}
    if not isinstance(raw, dict):
        raw = {"ok": True, "type": type(raw).__name__, "value": raw}
    value, truncated = _cap_eval_value(raw.get("value"), max_chars)
    payload = {
        "ok": bool(raw.get("ok", True)),
        "type": str(raw.get("type") or type(value).__name__),
        "value": value,
        "truncated": truncated,
    }
    if raw.get("error_name"):
        payload["error_name"] = str(raw["error_name"])
    return payload


async def _snapshot_data(page: Any, selector: str | None,
                         max_text: int = 6000) -> dict:
    """page 에서 시각적 본문 + 주요 인터랙티브 element 를 JS 한 번으로 추출해 dict 반환.

    반환: {url, title, text, elements:[{ref,selector,tag,role,label,href,input_type}]}.
    max_text 로 본문 텍스트 cap (기본 6000; web_site_sweep 은 더 크게 — 긴 페이지 누락 방지).
    element refs 를 page 에 저장(이후 click/fill 타게팅용)."""
    js = """
(args) => {
  const rootSelector = args && args.rootSelector;
  const maxText = (args && args.maxText) || 6000;
  const root = rootSelector ? document.querySelector(rootSelector) : document.body;
  if (!root) return JSON.stringify({error: 'selector not found'});
  const cssEscape = window.CSS && CSS.escape
    ? CSS.escape.bind(CSS)
    : (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  function visibleText(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.toString().replace(/\\s+/g, ' ').trim();
  }
  function isVisible(el) {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style && style.visibility !== 'hidden' && style.display !== 'none'
      && rect.width > 0 && rect.height > 0;
  }
  function cssPath(el) {
    if (el.id) return `${el.tagName.toLowerCase()}#${cssEscape(el.id)}`;
    const name = el.getAttribute('name');
    if (name) {
      const tag = el.tagName.toLowerCase();
      const candidate = `${tag}[name="${cssEscape(name)}"]`;
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && cur !== document.documentElement) {
      const tag = cur.tagName.toLowerCase();
      let nth = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) nth += 1;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${tag}:nth-of-type(${nth})`);
      if (cur.parentElement === document.body || parts.length >= 6) break;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }
  function roleOf(el) {
    return el.getAttribute('role')
      || (el.tagName.toLowerCase() === 'a' ? 'link' : '')
      || (el.tagName.toLowerCase() === 'button' ? 'button' : '')
      || (['input', 'textarea', 'select'].includes(el.tagName.toLowerCase()) ? 'textbox' : '');
  }
  const inputs = [];
  root.querySelectorAll('input, textarea, select, button, a[href], [role="button"], [role="link"], [tabindex]').forEach((el) => {
    if (inputs.length >= 80 || !isVisible(el)) return;
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute('aria-label');
    const placeholder = el.getAttribute('placeholder');
    const title = el.getAttribute('title');
    const txt = (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const label = (aria || placeholder || title || txt || tag).slice(0, 120);
    inputs.push({
      ref: `@e${inputs.length + 1}`,
      selector: cssPath(el),
      tag,
      role: roleOf(el),
      label,
      href: el.getAttribute('href') || '',
      input_type: el.getAttribute('type') || '',
    });
  });
  return JSON.stringify({
    url: location.href,
    title: document.title,
    text: visibleText(root).slice(0, maxText),
    elements: inputs,
  });
}
"""
    raw = await page.evaluate(js, {"rootSelector": selector, "maxText": max_text})
    # raw 는 JSON string
    import json as _json
    data = _json.loads(raw)
    elements = data.get("elements", [])
    if isinstance(elements, list):
        _store_browser_refs(page, elements)
    else:
        _clear_browser_refs()
    return data


async def _build_snapshot(page: Any, selector: str | None) -> str:
    """visible text + 주요 인터랙티브 element ref 목록을 문자열 스냅샷으로 포맷.

    구조화 데이터는 _snapshot_data 가 추출(JS 실행 + ref 저장). 여기선 문자열 포맷만.
    """
    data = await _snapshot_data(page, selector)
    elements = data.get("elements", [])

    element_lines: list[str] = []
    for item in elements if isinstance(elements, list) else []:
        if isinstance(item, str):
            element_lines.append(item)
            continue
        if not isinstance(item, dict):
            continue
        ref = str(item.get("ref") or "")
        tag = str(item.get("tag") or "element")
        role = str(item.get("role") or "")
        label = str(item.get("label") or "")
        href = str(item.get("href") or "")
        input_type = str(item.get("input_type") or "")
        attrs = []
        if role:
            attrs.append(f"role={role}")
        if input_type:
            attrs.append(f"type={input_type}")
        if label:
            attrs.append(f"label={label!r}".replace("'", '"'))
        if href:
            attrs.append(f"href={href!r}".replace("'", '"'))
        prefix = f"{ref} {tag}".strip()
        element_lines.append(" ".join([prefix, *attrs]).strip())

    out = [
        f"URL: {data.get('url')}",
        f"TITLE: {data.get('title')}",
        "TEXT:",
        data.get("text", ""),
        "",
        "ELEMENTS:",
        *element_lines,
    ]
    return "\n".join(out)


__all__ = [
    "BrowserSessionTool",
    "BrowserActionTool",
    "BrowserQueryTool",
    "BrowserSupervisorTool",
]
