"""v3.24-C: Host-wide Read / Write / Edit 도구.

evidence_dir 한정 (`evidence_tools.py`) 과 별도 — operator 가 host 파일시스템 전반에서
Claude Code 처럼 코드 편집 / 설정 변경. **반드시 사전 합의된 boundary 가드 통과**해야.

차단 (PathEscapeError):
- 시스템 핵심 디렉토리: /etc, /boot, /sys, /proc, /dev, /lib, /lib64, /sbin, /bin,
  /usr/bin, /usr/sbin (read 는 허용, write/edit 만 차단)
- credential 디렉토리: ~/.ssh, ~/.aws, ~/.gnupg, ~/.config/gh, ~/.docker, ~/.kube
- sudo 설정: /etc/sudoers, /etc/sudoers.d (read 도 차단)
- 절대 path 가 아닌 입력은 거부 (relative 는 evidence_tools 사용)

Read 는 system path 허용 (디버깅용), Write/Edit 만 엄격.

Read-before-Edit 강제: Edit 호출 전 같은 ctx 안에서 Read 가 한 번 이상 있어야.
ToolContext.metadata['host_read_paths']: set[str] 으로 추적.

Bash 같은 destructive shell 은 여기 X — BashEvidenceTool 그대로 사용.
"""
from __future__ import annotations

import asyncio
import fnmatch
import hashlib
import os
import re
import shutil
from pathlib import Path
from typing import ClassVar, Literal

from pydantic import BaseModel, Field, model_validator

from secu_agent.agent.read_context import (
    check_unchanged_read,
    forget_read_path,
    record_read,
    unchanged_read_stub,
)
from secu_agent.agent.checkpoints import CheckpointManager
from secu_agent.agent.tools.base import (
    Tool, ToolContext, ToolError, ToolResult, ToolSuccess,
)


_MAX_READ_BYTES = 2 * 1024 * 1024  # 2MB
_MAX_WRITE_BYTES = 1 * 1024 * 1024  # 1MB
_MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
_MAX_COPY_BYTES = 512 * 1024 * 1024
# Keep host read/search below stash threshold to avoid recursive stash/read loops.
_MAX_OUTPUT_CHARS = 30_000

_OUTLINE_SOURCE_EXTENSIONS = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".kt", ".kts",
    ".go", ".rs", ".rb", ".php", ".cs", ".c", ".cc", ".cpp", ".h",
    ".hpp", ".swift", ".scala", ".sh", ".md", ".yaml", ".yml", ".toml",
    ".json",
}
_OUTLINE_SOURCE_NAMES = {"Dockerfile", "Makefile", "Rakefile", "Gemfile"}
_OUTLINE_SKIP_DIRS = {
    ".git", "__pycache__", "node_modules", "dist", "build", ".venv", "venv",
    ".mypy_cache", ".pytest_cache", ".next", "target", ".idea", ".vscode",
}
_IMPORT_PATTERNS = (
    re.compile(r"^\s*(?:from\s+\S+\s+import\s+.+|import\s+.+)$"),
    re.compile(r"^\s*(?:export\s+)?import\s+.+$"),
    re.compile(r"^\s*(?:const|let|var)\s+.+\s*=\s*require\(.+\)"),
    re.compile(r"^\s*#include\s+[<\"].+[>\"]"),
    re.compile(r"^\s*use\s+[\w:]+"),
    re.compile(r"^\s*package\s+[\w.]+"),
)
_SYMBOL_PATTERNS = (
    re.compile(r"^\s*(?:async\s+def|def|class)\s+[A-Za-z_][\w]*"),
    re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*"),
    re.compile(r"^\s*(?:export\s+)?class\s+[A-Za-z_$][\w$]*"),
    re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>"),
    re.compile(r"^\s*(?:func|type)\s+[A-Za-z_][\w]*"),
    re.compile(r"^\s*(?:pub\s+)?(?:async\s+)?fn\s+[A-Za-z_][\w]*"),
    re.compile(r"^\s*(?:public|private|protected|internal|static|final|abstract|override|open|data|sealed|case|\s)*\s*(?:class|interface|enum|object|struct|record)\s+[A-Za-z_][\w]*"),
    re.compile(r"^\s*#{1,6}\s+\S"),
)

# 시스템 핵심 디렉토리 — write/edit 절대 X.
_SYSTEM_DIRS = (
    "/etc",
    "/private/etc",
    "/boot",
    "/sys",
    "/proc",
    "/dev",
    "/lib",
    "/lib64",
    "/sbin",
    "/bin",
    "/usr/bin",
    "/usr/sbin",
    "/usr/lib",
    "/usr/lib64",
)

# credential / 민감 디렉토리 — read 도 X.
_CREDENTIAL_DIRS_RELATIVE = (
    ".ssh",
    ".aws",
    ".gnupg",
    ".docker",
    ".kube",
    ".config/gh",
    ".config/gcloud",
    ".azure",
    ".pgpass",
    ".netrc",
)

# sudo 설정 — read 도 X (운영자 외 LLM 이 볼 이유 없음).
_SUDO_PATHS = (
    "/etc/sudoers",
    "/etc/sudoers.d",
    "/private/etc/sudoers",
    "/private/etc/sudoers.d",
)


def _resolve_abs(path: str) -> Path:
    """absolute path 만 허용. `~` 확장 + symlink resolve."""
    if not path:
        raise PathBlockError("empty path")
    if not path.startswith(("/", "~")):
        raise PathBlockError(
            f"host 도구는 absolute path 만 — 상대 경로 '{path}' 거부. "
            "evidence_dir 안 작업은 evidence_tools 사용."
        )
    p = Path(path).expanduser().resolve()
    return p


class PathBlockError(Exception):
    """가드 위반 — agent 가 catch 못 함, ToolError 로 변환."""


def _is_under(path: Path, parents: tuple[str, ...]) -> str | None:
    """path 가 parents 중 하나의 prefix 하에 있으면 그 parent string 반환."""
    s = str(path)
    for p in parents:
        if s == p or s.startswith(p + "/"):
            return p
    return None


def _credential_dir_match(path: Path) -> str | None:
    """home 안 credential dir 매치. 반환: 매치된 상대 path."""
    home = Path.home()
    try:
        rel = path.relative_to(home)
    except ValueError:
        return None
    rel_str = str(rel)
    for cred in _CREDENTIAL_DIRS_RELATIVE:
        if rel_str == cred or rel_str.startswith(cred + "/"):
            return cred
    return None


def _validate_for_read(path: Path) -> None:
    """Read 가드 — credential / sudo 만 차단. 시스템 디렉토리 read 는 허용 (디버깅)."""
    sudo = _is_under(path, _SUDO_PATHS)
    if sudo:
        raise PathBlockError(f"sudo 설정 read 금지: {sudo}")
    cred = _credential_dir_match(path)
    if cred:
        raise PathBlockError(f"credential 디렉토리 read 금지: ~/{cred}")


def _validate_for_write(path: Path) -> None:
    """Write/Edit 가드 — read 가드 + 시스템 디렉토리 추가 차단."""
    _validate_for_read(path)
    sysdir = _is_under(path, _SYSTEM_DIRS)
    if sysdir:
        raise PathBlockError(f"시스템 디렉토리 write 금지: {sysdir}")


def _track_read(ctx: ToolContext, path: Path) -> None:
    reads = ctx.metadata.setdefault("host_read_paths", set())
    reads.add(str(path))


def _was_read(ctx: ToolContext, path: Path) -> bool:
    reads = ctx.metadata.get("host_read_paths") or set()
    return str(path) in reads


def _checkpoint_before_change(ctx: ToolContext, path: Path, label: str) -> str:
    return _checkpoint_before_changes(ctx, [path], label)


def _checkpoint_before_changes(ctx: ToolContext, paths: list[Path], label: str) -> str:
    record = CheckpointManager(ctx.evidence_dir).create(paths, label=label)
    checkpoints = ctx.metadata.setdefault("host_checkpoints", [])
    if not isinstance(checkpoints, list):
        checkpoints = []
        ctx.metadata["host_checkpoints"] = checkpoints
    checkpoints.append(record.id)
    return record.id


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _looks_binary(path: Path) -> bool:
    try:
        with path.open("rb") as f:
            return b"\0" in f.read(4096)
    except OSError:
        return True


def _cap_tool_output(result: str, hint: str) -> str:
    if len(result) <= _MAX_OUTPUT_CHARS:
        return result
    return (
        result[:_MAX_OUTPUT_CHARS]
        + f"\n\n... (truncated at {_MAX_OUTPUT_CHARS:,} chars. {hint})"
    )


def _short_line(line: str, *, limit: int = 220) -> str:
    compact = " ".join(line.strip().split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3] + "..."


def _is_source_candidate(path: Path) -> bool:
    return path.suffix.lower() in _OUTLINE_SOURCE_EXTENSIONS or path.name in _OUTLINE_SOURCE_NAMES


# ─── HostReadFileTool ──────────────────────────────────────


class HostReadInput(BaseModel):
    path: str = Field(
        description="절대 path. ~ 확장 OK. credential/sudo 외 모두 허용.",
    )
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=2000, ge=1, le=10_000)


class HostReadFileTool(Tool[HostReadInput]):
    name: ClassVar[str] = "host_read"
    description: ClassVar[str] = (
        "Host-wide 파일 read (absolute path). evidence_dir 밖도 접근 가능. "
        "차단: ~/.ssh, ~/.aws, ~/.gnupg 같은 credential 디렉토리 + /etc/sudoers. "
        "2MB cap, offset/limit (line 기준)."
    )
    input_model: ClassVar[type[BaseModel]] = HostReadInput
    is_read_only: ClassVar[bool] = True
    is_destructive: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    deferred: ClassVar[bool] = False
    search_hint: ClassVar[str] = "host file read code source absolute path"
    prompt_section: ClassVar[str] = (
        "### host_read(path, offset=0, limit=2000)\n"
        "Host-wide 파일 read. evidence_dir 밖에 있는 코드 / 설정 파일 등. absolute path 만. "
        "차단: ~/.ssh, ~/.aws, credential dir + /etc/sudoers."
    )

    async def execute(self, vi: HostReadInput, ctx: ToolContext) -> ToolResult:
        try:
            p = _resolve_abs(vi.path)
            _validate_for_read(p)
        except PathBlockError as e:
            return ToolError(kind="forbidden", message=str(e))

        if not p.exists():
            return ToolError(kind="not_found", message=f"{vi.path} 미존재")
        if not p.is_file():
            return ToolError(kind="not_file", message=f"{vi.path} not a file")
        size = p.stat().st_size
        if size > _MAX_READ_BYTES:
            return ToolError(
                kind="too_large",
                message=f"{vi.path}: {size} bytes > 2MB cap",
            )
        hit = check_unchanged_read(
            ctx.metadata,
            p,
            offset=vi.offset,
            limit=vi.limit,
        )
        if hit is not None:
            _track_read(ctx, p)
            return ToolSuccess(content=unchanged_read_stub(hit))
        try:
            # A3(perf): 블로킹 파일 read 를 스레드로 오프로드 → 엔진의 병렬 read-only
            # 배치가 실제로 겹친다(경로 gate·size cap 은 위에서 on-loop 로 이미 통과,
            # metadata 갱신은 아래에서 on-loop — 단일스레드 직렬화라 경합 없음).
            text = await asyncio.to_thread(
                p.read_text, encoding="utf-8", errors="replace",
            )
        except OSError as e:
            return ToolError(kind="io_error", message=str(e))

        _track_read(ctx, p)
        lines = text.splitlines()
        start = vi.offset
        end = start + vi.limit
        window = lines[start:end]
        body = "\n".join(window)
        header = f"# {p} (lines {start+1}-{start+len(window)} / {len(lines)})\n"
        result = _cap_tool_output(
            header + body,
            (
                f"line {start+1}+ result. Re-call with a smaller limit or "
                f"offset={start+len(window)} to continue. total_lines={len(lines)}"
            ),
        )
        record_read(
            ctx.metadata,
            p,
            offset=vi.offset,
            limit=vi.limit,
            total_lines=len(lines),
            returned_chars=len(result),
        )
        return ToolSuccess(content=result)


# ─── HostSearchTool ────────────────────────────────────────


class HostSearchInput(BaseModel):
    root: str = Field(description="검색 root absolute path. 파일 또는 디렉토리.")
    query: str = Field(
        min_length=1,
        max_length=500,
        description="mode=glob: 파일명/상대경로 glob. mode=grep: regex/text pattern.",
    )
    mode: Literal["glob", "grep"] = Field(default="glob")
    ignore_case: bool = False
    max_matches: int = Field(default=200, ge=1, le=2000)
    max_files: int = Field(default=5000, ge=1, le=20000)


class HostSearchTool(Tool[HostSearchInput]):
    name: ClassVar[str] = "host_search"
    description: ClassVar[str] = (
        "Host-wide 파일 검색. mode='glob' 은 파일명/상대경로 glob, mode='grep' 은 "
        "텍스트 regex 검색. absolute root. credential/sudo 경로 차단. 파일 수/결과 cap."
    )
    input_model: ClassVar[type[BaseModel]] = HostSearchInput
    is_read_only: ClassVar[bool] = True
    is_destructive: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    deferred: ClassVar[bool] = False
    search_hint: ClassVar[str] = "host file search glob grep find rg content"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "find file", "search file", "grep", "glob", "파일 찾아", "검색",
    )
    prompt_section: ClassVar[str] = (
        "### host_search(root, query, mode='glob'|'grep')\n"
        "Host-wide 파일/내용 검색. Claude Glob/Grep, Hermes search_files 역할. "
        "파일 위치를 모르면 terminal 보다 먼저 `host_search(mode='glob')`, 내용 검색은 "
        "`mode='grep'`. credential/sudo 경로 차단."
    )

    async def execute(self, vi: HostSearchInput, ctx: ToolContext) -> ToolResult:
        del ctx
        try:
            root = _resolve_abs(vi.root)
            _validate_for_read(root)
        except PathBlockError as e:
            return ToolError(kind="forbidden", message=str(e))

        if not root.exists():
            return ToolError(kind="not_found", message=f"{root} 미존재")
        # A4(perf): 블로킹 os.walk + 파일 read 스캔을 스레드로 오프로드 → 병렬 배치 실오버랩.
        # _glob/_grep 은 ctx-free(위 del ctx)라 스레드 안전. per-file credential/sudo 게이트
        # (_validate_for_read)는 스캔 안에서 그대로 실행 → 차단 정책 불변.
        if vi.mode == "glob":
            return await asyncio.to_thread(self._glob, root, vi)
        return await asyncio.to_thread(self._grep, root, vi)

    def _iter_files(self, root: Path, max_files: int) -> tuple[list[Path], bool]:
        if root.is_file():
            return [root], False
        if not root.is_dir():
            return [], False
        out: list[Path] = []
        truncated = False
        for dirpath, dirnames, filenames in os.walk(root, onerror=lambda _e: None):
            dirnames[:] = [d for d in dirnames if d not in {".git", "__pycache__"}]
            for name in filenames:
                out.append(Path(dirpath) / name)
                if len(out) >= max_files:
                    truncated = True
                    return out, truncated
        return out, truncated

    def _glob(self, root: Path, vi: HostSearchInput) -> ToolResult:
        query = vi.query.replace("\\", "/")
        if "\x00" in query or query.startswith("/") or any(p == ".." for p in query.split("/")):
            return ToolError(kind="validation", message="glob query 는 relative pattern 이어야 함")
        files, scan_truncated = self._iter_files(root, vi.max_files)
        hits: list[str] = []
        q = query.lower() if vi.ignore_case else query
        for fp in files:
            try:
                _validate_for_read(fp.resolve())
                rel = str(fp.relative_to(root)).replace("\\", "/") if root.is_dir() else fp.name
            except (OSError, ValueError, PathBlockError):
                continue
            hay_rel = rel.lower() if vi.ignore_case else rel
            hay_name = fp.name.lower() if vi.ignore_case else fp.name
            if fnmatch.fnmatchcase(hay_rel, q) or fnmatch.fnmatchcase(hay_name, q):
                hits.append(str(fp))
                if len(hits) >= vi.max_matches:
                    break
        if not hits:
            suffix = " (file scan cap reached)" if scan_truncated else ""
            return ToolSuccess(content=f"0 match (scanned {len(files)} file{suffix})")
        suffix = "\n... (match cap)" if len(hits) >= vi.max_matches else ""
        scan_suffix = " scanned_file_cap=true" if scan_truncated else ""
        result = (
            f"{len(hits)} match / scanned {len(files)} file{scan_suffix}:\n"
            + "\n".join(hits)
            + suffix
        )
        return ToolSuccess(
            content=_cap_tool_output(
                result,
                "Narrow query, reduce max_matches, or search a smaller root.",
            ),
        )

    def _grep(self, root: Path, vi: HostSearchInput) -> ToolResult:
        flags = re.IGNORECASE if vi.ignore_case else 0
        try:
            pat = re.compile(vi.query, flags)
        except re.error as e:
            return ToolError(kind="validation", message=f"bad regex: {e}")
        files, scan_truncated = self._iter_files(root, vi.max_files)
        hits: list[str] = []
        scanned = 0
        skipped = 0
        for fp in files:
            try:
                p = fp.resolve()
                _validate_for_read(p)
                if p.stat().st_size > _MAX_SEARCH_FILE_BYTES or _looks_binary(p):
                    skipped += 1
                    continue
                text = p.read_text(encoding="utf-8", errors="replace")
            except (OSError, UnicodeError, PathBlockError):
                skipped += 1
                continue
            scanned += 1
            for i, line in enumerate(text.splitlines(), 1):
                if pat.search(line):
                    hits.append(f"{p}:{i}: {line.rstrip()}")
                    if len(hits) >= vi.max_matches:
                        break
            if len(hits) >= vi.max_matches:
                break
        if not hits:
            suffix = " scanned_file_cap=true" if scan_truncated else ""
            return ToolSuccess(
                content=f"0 match (searched {scanned} text file, skipped {skipped}{suffix})",
            )
        suffix = "\n... (match cap)" if len(hits) >= vi.max_matches else ""
        scan_suffix = " scanned_file_cap=true" if scan_truncated else ""
        result = (
            f"{len(hits)} match / searched {scanned} text file, skipped {skipped}{scan_suffix}:\n"
            + "\n".join(hits)
            + suffix
        )
        return ToolSuccess(
            content=_cap_tool_output(
                result,
                "Narrow pattern, reduce max_matches, or search a smaller root.",
            ),
        )


# ─── HostCodeOutlineTool ───────────────────────────────────


class HostCodeOutlineInput(BaseModel):
    path: str = Field(description="절대 path. 파일 또는 디렉토리.")
    max_files: int = Field(default=80, ge=1, le=500)
    max_symbols: int = Field(default=500, ge=1, le=5000)
    include_imports: bool = True


class HostCodeOutlineTool(Tool[HostCodeOutlineInput]):
    name: ClassVar[str] = "host_code_outline"
    description: ClassVar[str] = (
        "Host-wide source outline. 파일/디렉토리의 imports, symbols, headings, line anchors만 "
        "반환하고 본문은 반환하지 않음. 큰 source tree를 읽기 전에 구조 파악용."
    )
    input_model: ClassVar[type[BaseModel]] = HostCodeOutlineInput
    is_read_only: ClassVar[bool] = True
    is_destructive: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    deferred: ClassVar[bool] = False
    search_hint: ClassVar[str] = "source code outline symbols imports functions classes line anchors"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "outline", "symbols", "imports", "source tree", "구조", "심볼",
    )
    prompt_section: ClassVar[str] = (
        "### host_code_outline(path, max_files=80, max_symbols=500)\n"
        "Host-wide source projection. 큰 코드베이스는 먼저 outline 으로 파일/심볼/라인을 "
        "좁힌 뒤 필요한 line range 만 host_read 로 읽는다. 도메인 점검 판단은 skill/tool "
        "쪽에서 수행하고, 이 도구는 구조만 반환한다."
    )

    async def execute(self, vi: HostCodeOutlineInput, ctx: ToolContext) -> ToolResult:
        del ctx
        try:
            root = _resolve_abs(vi.path)
            _validate_for_read(root)
        except PathBlockError as e:
            return ToolError(kind="forbidden", message=str(e))
        if not root.exists():
            return ToolError(kind="not_found", message=f"{root} 미존재")
        if not root.is_file() and not root.is_dir():
            return ToolError(kind="not_file", message=f"{root} is not a file or directory")

        files, file_truncated = self._iter_source_files(root, vi.max_files)
        out: list[str] = [
            f"# source outline: {root}",
            (
                f"scanned_files={len(files)} file_cap_reached={str(file_truncated).lower()} "
                f"max_symbols={vi.max_symbols}"
            ),
            "Content is omitted. Use host_read(path, offset=line-1, limit=N) for exact code.",
            "",
        ]
        emitted_files = 0
        emitted_symbols = 0
        skipped = 0
        symbol_truncated = False
        for fp in files:
            if emitted_symbols >= vi.max_symbols:
                symbol_truncated = True
                break
            outline = self._outline_file(
                fp,
                root=root,
                include_imports=vi.include_imports,
                remaining_symbols=vi.max_symbols - emitted_symbols,
            )
            if outline is None:
                skipped += 1
                continue
            block, symbol_count = outline
            if not block:
                skipped += 1
                continue
            emitted_files += 1
            emitted_symbols += symbol_count
            out.extend(block)
            out.append("")
            if emitted_symbols >= vi.max_symbols:
                symbol_truncated = True

        out[1] = (
            f"scanned_files={len(files)} emitted_files={emitted_files} skipped={skipped} "
            f"file_cap_reached={str(file_truncated).lower()} "
            f"symbol_cap_reached={str(symbol_truncated).lower()} symbols={emitted_symbols}"
        )
        if emitted_files == 0:
            out.append("0 outline entries. Try host_search or a narrower source path.")
        result = "\n".join(out).rstrip()
        return ToolSuccess(
            content=_cap_tool_output(
                result,
                "Narrow path, reduce max_files, or use host_read on specific line ranges.",
            ),
        )

    def _iter_source_files(self, root: Path, max_files: int) -> tuple[list[Path], bool]:
        if root.is_file():
            return ([root] if _is_source_candidate(root) else []), False
        out: list[Path] = []
        truncated = False
        for dirpath, dirnames, filenames in os.walk(root, onerror=lambda _e: None):
            dirnames[:] = sorted(
                d for d in dirnames
                if d not in _OUTLINE_SKIP_DIRS and not d.startswith(".tox")
            )
            for name in sorted(filenames):
                fp = Path(dirpath) / name
                if not _is_source_candidate(fp):
                    continue
                try:
                    _validate_for_read(fp.resolve())
                except (OSError, PathBlockError):
                    continue
                out.append(fp)
                if len(out) >= max_files:
                    truncated = True
                    return out, truncated
        return out, truncated

    def _outline_file(
        self,
        path: Path,
        *,
        root: Path,
        include_imports: bool,
        remaining_symbols: int,
    ) -> tuple[list[str], int] | None:
        try:
            p = path.resolve()
            _validate_for_read(p)
            size = p.stat().st_size
            if size > _MAX_SEARCH_FILE_BYTES or _looks_binary(p):
                return None
            text = p.read_text(encoding="utf-8", errors="replace")
        except (OSError, UnicodeError, PathBlockError):
            return None

        lines = text.splitlines()
        imports: list[str] = []
        symbols: list[str] = []
        for i, line in enumerate(lines, 1):
            if include_imports and len(imports) < 40 and self._is_import_line(line):
                imports.append(f"  {i}: {_short_line(line)}")
            if self._is_symbol_line(line):
                symbols.append(f"  {i}: {_short_line(line)}")
                if len(symbols) >= remaining_symbols:
                    break
        if not imports and not symbols:
            return [], 0

        try:
            rel = str(p.relative_to(root)) if root.is_dir() else p.name
        except ValueError:
            rel = str(p)
        block = [f"## {rel} ({len(lines)} lines, {size} bytes)"]
        if imports:
            block.append("imports:")
            block.extend(imports)
        if symbols:
            block.append("symbols:")
            block.extend(symbols)
        return block, len(symbols)

    @staticmethod
    def _is_import_line(line: str) -> bool:
        return any(pat.search(line) for pat in _IMPORT_PATTERNS)

    @staticmethod
    def _is_symbol_line(line: str) -> bool:
        return any(pat.search(line) for pat in _SYMBOL_PATTERNS)


# ─── HostWriteFileTool ─────────────────────────────────────


class HostWriteInput(BaseModel):
    path: str = Field(description="absolute path. 기존 파일이면 덮어쓰기.")
    content: str = Field(description="새 본문.")


class HostWriteFileTool(Tool[HostWriteInput]):
    name: ClassVar[str] = "host_write"
    description: ClassVar[str] = (
        "Host-wide 파일 write — 기존이면 overwrite, 없으면 새로 생성. absolute path. "
        "1MB cap. 차단: 시스템 디렉토리 (/etc, /bin, /usr/bin, ...) + credential. "
        "기존 파일을 덮어쓰려면 같은 ctx 안에서 한 번이라도 host_read 했어야 한다."
    )
    input_model: ClassVar[type[BaseModel]] = HostWriteInput
    is_read_only: ClassVar[bool] = False
    is_destructive: ClassVar[bool] = True
    domain: ClassVar[str] = "core"
    deferred: ClassVar[bool] = False
    search_hint: ClassVar[str] = "host file write create overwrite code source"
    prompt_section: ClassVar[str] = (
        "### host_write(path, content)\n"
        "Host-wide 파일 write. 절대 path. 1MB cap. 기존 파일 덮어쓰면 read-first 필요. "
        "차단: 시스템 디렉토리 + credential dir + sudoers."
    )

    async def execute(self, vi: HostWriteInput, ctx: ToolContext) -> ToolResult:
        try:
            p = _resolve_abs(vi.path)
            _validate_for_write(p)
        except PathBlockError as e:
            return ToolError(kind="forbidden", message=str(e))

        if len(vi.content.encode("utf-8")) > _MAX_WRITE_BYTES:
            return ToolError(
                kind="too_large",
                message=f"content {len(vi.content.encode('utf-8'))} bytes > 1MB cap",
            )

        existed = p.exists()
        if existed and not _was_read(ctx, p):
            return ToolError(
                kind="read_first",
                message=(
                    f"{p} 가 이미 존재 — 덮어쓰기 전에 같은 ctx 안에서 host_read 호출 필요."
                ),
            )

        # 부모 디렉토리는 반드시 존재해야 (의도 명시). 자동 mkdir X.
        if not p.parent.exists():
            return ToolError(
                kind="parent_missing",
                message=f"부모 디렉토리 {p.parent} 미존재 — mkdir 먼저.",
            )

        try:
            checkpoint_id = _checkpoint_before_change(ctx, p, f"host_write {p}")
        except Exception as e:
            return ToolError(kind="checkpoint", message=f"checkpoint failed: {e}")

        try:
            p.write_text(vi.content, encoding="utf-8")
        except OSError as e:
            return ToolError(kind="io_error", message=str(e))

        action = "overwrote" if existed else "created"
        forget_read_path(ctx.metadata, p)
        _track_read(ctx, p)  # write 이후 stale read 방지 차원
        return ToolSuccess(
            content=f"{action} {p} ({len(vi.content)} chars, checkpoint={checkpoint_id})",
        )


# ─── HostEditFileTool ──────────────────────────────────────


class HostEditInput(BaseModel):
    path: str = Field(description="absolute path. 기존 파일 필요.")
    old_string: str = Field(min_length=1, description="치환 대상 (정확 매치).")
    new_string: str = Field(description="치환 결과 (빈 string 도 OK).")
    replace_all: bool = Field(
        default=False,
        description="True 면 모든 매치 치환, False 면 정확히 1개여야.",
    )


class HostEditFileTool(Tool[HostEditInput]):
    name: ClassVar[str] = "host_edit"
    description: ClassVar[str] = (
        "Host-wide 파일에서 exact string 치환. absolute path + 사전 host_read 필수. "
        "old_string 이 파일에 정확히 1개 있어야 (또는 replace_all=True). "
        "old_string == new_string 거부. 차단: 시스템 디렉토리 + credential."
    )
    input_model: ClassVar[type[BaseModel]] = HostEditInput
    is_read_only: ClassVar[bool] = False
    is_destructive: ClassVar[bool] = True
    domain: ClassVar[str] = "core"
    deferred: ClassVar[bool] = False
    search_hint: ClassVar[str] = "host file edit replace patch modify code"
    prompt_section: ClassVar[str] = (
        "### host_edit(path, old_string, new_string, replace_all=False)\n"
        "Host-wide 파일 exact string 치환. read-first 필수. old_string 이 1개 (또는 "
        "replace_all=True). 시스템 디렉토리 / credential 차단."
    )

    async def execute(self, vi: HostEditInput, ctx: ToolContext) -> ToolResult:
        try:
            p = _resolve_abs(vi.path)
            _validate_for_write(p)
        except PathBlockError as e:
            return ToolError(kind="forbidden", message=str(e))

        if vi.old_string == vi.new_string:
            return ToolError(
                kind="validation",
                message="old_string 과 new_string 이 같음.",
            )
        if not p.exists():
            return ToolError(kind="not_found", message=f"{p} 미존재")
        if not p.is_file():
            return ToolError(kind="not_file", message=f"{p} not a file")
        if not _was_read(ctx, p):
            return ToolError(
                kind="read_first",
                message=f"{p} 를 edit 하려면 같은 ctx 안에서 host_read 먼저.",
            )

        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            return ToolError(kind="io_error", message=str(e))

        count = text.count(vi.old_string)
        if count == 0:
            return ToolError(
                kind="not_found_in_file",
                message=f"old_string 이 {p} 에서 매치 안 됨.",
            )
        if not vi.replace_all and count != 1:
            return ToolError(
                kind="ambiguous",
                message=(
                    f"old_string 이 {count}회 매치 — replace_all=True 또는 더 긴 context 로."
                ),
            )

        new_text = (
            text.replace(vi.old_string, vi.new_string)
            if vi.replace_all
            else text.replace(vi.old_string, vi.new_string, 1)
        )
        if len(new_text.encode("utf-8")) > _MAX_WRITE_BYTES:
            return ToolError(
                kind="too_large",
                message=f"수정 후 {len(new_text.encode('utf-8'))} bytes > 1MB cap",
            )

        try:
            checkpoint_id = _checkpoint_before_change(ctx, p, f"host_edit {p}")
        except Exception as e:
            return ToolError(kind="checkpoint", message=f"checkpoint failed: {e}")

        try:
            p.write_text(new_text, encoding="utf-8")
        except OSError as e:
            return ToolError(kind="io_error", message=str(e))

        applied = count if vi.replace_all else 1
        forget_read_path(ctx.metadata, p)
        return ToolSuccess(
            content=f"edited {p} — {applied} replacement(s), checkpoint={checkpoint_id}",
        )


# ─── HostCopy / HostMove ───────────────────────────────────


class HostCopyMoveInput(BaseModel):
    source_path: str = Field(description="복사/이동할 source absolute path. 파일만 지원.")
    dest_path: str | None = Field(
        default=None,
        description="목적지 파일 absolute path. dest_dir 와 둘 중 하나만.",
    )
    dest_dir: str | None = Field(
        default=None,
        description="목적지 디렉토리 absolute path. 파일명은 source basename 사용.",
    )
    overwrite: bool = Field(default=False, description="기존 dest 파일 덮어쓰기 허용.")
    create_parents: bool = Field(default=False, description="dest parent directory 자동 생성.")

    @model_validator(mode="after")
    def _exactly_one_dest(self):
        if bool(self.dest_path) == bool(self.dest_dir):
            raise ValueError("dest_path 또는 dest_dir 중 정확히 하나 필요")
        return self


def _resolve_copy_move_paths(vi: HostCopyMoveInput) -> tuple[Path, Path] | ToolError:
    try:
        src = _resolve_abs(vi.source_path)
        _validate_for_read(src)
    except PathBlockError as e:
        return ToolError(kind="forbidden", message=str(e))
    if not src.exists():
        return ToolError(kind="not_found", message=f"source 미존재: {src}")
    if not src.is_file():
        return ToolError(kind="not_file", message=f"source 는 파일이어야 함: {src}")
    try:
        size = src.stat().st_size
    except OSError as e:
        return ToolError(kind="io_error", message=f"source stat failed: {e}")
    if size > _MAX_COPY_BYTES:
        return ToolError(kind="too_large", message=f"{size} bytes > {_MAX_COPY_BYTES} cap")

    try:
        if vi.dest_path:
            dest = _resolve_abs(vi.dest_path)
        else:
            dest_dir = _resolve_abs(vi.dest_dir or "")
            dest = dest_dir / src.name
        _validate_for_write(dest)
    except PathBlockError as e:
        return ToolError(kind="forbidden", message=str(e))
    if src == dest:
        return ToolError(kind="validation", message="source_path 와 destination 이 같음")
    return src, dest


def _prepare_destination(dest: Path, *, overwrite: bool, create_parents: bool) -> ToolError | None:
    if not dest.parent.exists():
        if not create_parents:
            return ToolError(kind="parent_missing", message=f"부모 디렉토리 {dest.parent} 미존재")
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            return ToolError(kind="io_error", message=f"parent mkdir failed: {e}")
    if not dest.parent.is_dir():
        return ToolError(kind="not_file", message=f"parent is not a directory: {dest.parent}")
    if dest.exists():
        if dest.is_dir():
            return ToolError(kind="not_file", message=f"dest is a directory: {dest}")
        if not overwrite:
            return ToolError(kind="exists", message=f"dest already exists: {dest}")
    return None


class HostCopyFileTool(Tool[HostCopyMoveInput]):
    name: ClassVar[str] = "host_copy"
    description: ClassVar[str] = (
        "Host-wide binary-safe file copy. source_path + dest_path 또는 dest_dir. "
        "credential/system write guards, overwrite flag, sha256 verification."
    )
    input_model: ClassVar[type[BaseModel]] = HostCopyMoveInput
    is_read_only: ClassVar[bool] = False
    is_destructive: ClassVar[bool] = True
    deferred: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    search_hint: ClassVar[str] = "host file copy binary artifact export screenshot png pdf"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "copy", "export", "복사", "옮겨", "screenshot", "artifact",
    )
    prompt_section: ClassVar[str] = (
        "### host_copy(source_path, dest_path=None, dest_dir=None, overwrite=False)\n"
        "바이너리 안전 파일 복사. 스크린샷/리포트/PDF/압축 파일을 `~/Documents` 등으로 "
        "내보낼 때 사용. 결과의 실제 dest path + sha256 만 저장 완료로 보고."
    )

    async def execute(self, vi: HostCopyMoveInput, ctx: ToolContext) -> ToolResult:
        resolved = _resolve_copy_move_paths(vi)
        if isinstance(resolved, ToolError):
            return resolved
        src, dest = resolved
        prep = _prepare_destination(dest, overwrite=vi.overwrite, create_parents=vi.create_parents)
        if prep is not None:
            return prep

        try:
            checkpoint_id = _checkpoint_before_changes(ctx, [dest], f"host_copy {src} -> {dest}")
            src_hash = _sha256_file(src)
            shutil.copy2(src, dest)
            dest_hash = _sha256_file(dest)
            size = dest.stat().st_size
        except OSError as e:
            return ToolError(kind="io_error", message=str(e))
        except Exception as e:
            return ToolError(kind="execution", message=f"{type(e).__name__}: {e}")

        if src_hash != dest_hash:
            return ToolError(kind="execution", message="copy verification failed: sha256 mismatch")
        return ToolSuccess(
            content=(
                f"copied {src} -> {dest} bytes={size} sha256={dest_hash} "
                f"verified checkpoint={checkpoint_id}"
            ),
        )


class HostMoveFileTool(Tool[HostCopyMoveInput]):
    name: ClassVar[str] = "host_move"
    description: ClassVar[str] = (
        "Host-wide binary-safe file move. source_path + dest_path 또는 dest_dir. "
        "credential/system write guards, overwrite flag, sha256 verification."
    )
    input_model: ClassVar[type[BaseModel]] = HostCopyMoveInput
    is_read_only: ClassVar[bool] = False
    is_destructive: ClassVar[bool] = True
    deferred: ClassVar[bool] = False
    domain: ClassVar[str] = "core"
    search_hint: ClassVar[str] = "host file move rename binary artifact export screenshot"
    dispatch_keywords: ClassVar[tuple[str, ...]] = (
        "move", "rename", "이동", "옮겨", "artifact",
    )
    prompt_section: ClassVar[str] = (
        "### host_move(source_path, dest_path=None, dest_dir=None, overwrite=False)\n"
        "바이너리 안전 파일 이동/rename. source 가 사라지는 destructive 작업. 단순 export 는 "
        "host_copy 선호. 결과의 실제 dest path + sha256 만 저장 완료로 보고."
    )

    async def execute(self, vi: HostCopyMoveInput, ctx: ToolContext) -> ToolResult:
        resolved = _resolve_copy_move_paths(vi)
        if isinstance(resolved, ToolError):
            return resolved
        src, dest = resolved
        prep = _prepare_destination(dest, overwrite=vi.overwrite, create_parents=vi.create_parents)
        if prep is not None:
            return prep

        try:
            checkpoint_id = _checkpoint_before_changes(ctx, [src, dest], f"host_move {src} -> {dest}")
            src_hash = _sha256_file(src)
            if dest.exists() and vi.overwrite:
                dest.unlink()
            shutil.move(str(src), str(dest))
            dest_hash = _sha256_file(dest)
            size = dest.stat().st_size
        except OSError as e:
            return ToolError(kind="io_error", message=str(e))
        except Exception as e:
            return ToolError(kind="execution", message=f"{type(e).__name__}: {e}")

        if src.exists():
            return ToolError(kind="execution", message="move verification failed: source still exists")
        if src_hash != dest_hash:
            return ToolError(kind="execution", message="move verification failed: sha256 mismatch")
        return ToolSuccess(
            content=(
                f"moved {src} -> {dest} bytes={size} sha256={dest_hash} "
                f"verified checkpoint={checkpoint_id}"
            ),
        )


__all__ = [
    "HostCodeOutlineTool",
    "HostCopyFileTool",
    "HostReadFileTool",
    "HostMoveFileTool",
    "HostSearchTool",
    "HostWriteFileTool",
    "HostEditFileTool",
    "PathBlockError",
]
