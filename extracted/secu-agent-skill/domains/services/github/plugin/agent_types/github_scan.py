"""v3.70 S3: GitHub repo 시크릿 스캐너 — clone 후 worktree(HEAD) + 커밋 히스토리.

흐름: clone_repo(토큰 env-header, proxy우회) → scan_repo(worktree + git log -p 히스토리)
→ 마스킹 finding. 발견된 시크릿 값은 절대 반환/저장/로그 안 함(마스킹+위치만).

보안 두 방향:
- 우리 토큰: _git_clone_env 로 http.extraHeader(env)만 — URL/ps/args/.git config 노출 X.
- 남의 시크릿: 모든 텍스트파일+히스토리 스캔, .env/키파일 핫파일 가중. 값은 마스킹.
"""
from __future__ import annotations

import base64
import logging
import os
import subprocess
from dataclasses import dataclass

from secu_agent.detectors import scan_text
from secu_agent.detectors.secrets import find_high_entropy, mask_secret

logger = logging.getLogger(__name__)

# 스캔 제외 — 디렉토리/확장자/크기
_SKIP_DIRS = {
    ".git", "node_modules", "vendor", "dist", "build", ".venv", "venv",
    "__pycache__", ".idea", ".gradle", "target", ".terraform",
}
_SKIP_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".pdf", ".zip",
    ".gz", ".tar", ".tgz", ".bz2", ".7z", ".rar", ".jar", ".war", ".class",
    ".o", ".so", ".dll", ".dylib", ".exe", ".bin", ".woff", ".woff2", ".ttf",
    ".eot", ".mp4", ".mp3", ".avi", ".mov", ".wasm", ".lock", ".map",
}
# 핫파일 — severity 가중 (시크릿 노출 1순위)
_HOT_MARKERS = (
    ".env", "credentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
    ".pem", ".pfx", ".p12", ".key", ".npmrc", ".pgpass", ".htpasswd",
    "secrets", ".tfvars", "kubeconfig", ".pypirc", ".netrc",
)
_MAX_FILE_BYTES = 1_000_000      # 파일당 1MB 상한
_MAX_HISTORY_BYTES = 8_000_000   # git log -p 출력 상한
_CLONE_TIMEOUT = 180
_LOG_TIMEOUT = 180

_SEVERITY: dict[str, str] = {
    "private_key_block": "critical",
    "aws_secret_access_key": "critical",
    "aws_access_key_id": "high",
    "github_pat": "critical", "github_oauth": "critical",
    "github_server_token": "critical", "github_app_token": "critical",
    "slack_bot_token": "high", "slack_webhook": "medium",
    "google_api_key": "high", "stripe_secret": "high",
    "jwt_token": "medium", "npm_token": "high", "pypi_token": "high",
    "jenkins_basic_auth_in_url": "high",
    "generic_password_assignment": "high", "generic_password_envline": "high",
    "database_url_with_password": "high",
    "high_entropy_string": "medium",
}
# _ORDER(4단계 랭크맵)는 정의만 있고 쓰는 곳이 없어 제거했다.
# ⚠️ 아래 _BUMP 는 남긴다 — 탐지기 kind 승급 사다리이고 _SEVERITY 가 낼 수 있는
#    값(critical/high/medium)에 대해 닫혀 있다. 도메인 5단계 어휘와 목적이 다르다.
_BUMP = {"low": "medium", "medium": "high", "high": "critical", "critical": "critical"}


@dataclass(slots=True)
class ScanFinding:
    repo: str
    path: str
    line: int
    kind: str
    severity: str
    masked: str
    source: str            # "worktree" | "history"
    commit: str | None = None
    method: str = "clone_worktree_history_scan"
    author_email: str | None = None
    candidate_source: str | None = None
    candidate_query: str | None = None


def _is_hot(path: str) -> bool:
    low = path.lower()
    return any(m in low for m in _HOT_MARKERS)


def _severity(kind: str, path: str) -> str:
    base = _SEVERITY.get(kind, "medium")
    if _is_hot(path):
        return _BUMP[base]
    return base


def _git_clone_env(token: str) -> dict[str, str]:
    """clone/log 용 git config 를 env 로 주입 — 토큰은 http.extraHeader VALUE(Basic)에만.
    URL/ps/args/.git config 에 토큰 미노출. proxy 우회 + self-signed 허용 + askpass 차단.

    GHES git smart-HTTP 는 'Authorization: token X' 가 아니라 **Basic** 를 요구
    (www-authenticate: Basic realm=GitHub). PAT 를 username, x-oauth-basic 을 password 로.
    """
    cred = base64.b64encode(f"{token}:x-oauth-basic".encode()).decode("ascii")
    return {
        "GIT_CONFIG_COUNT": "4",
        "GIT_CONFIG_KEY_0": "http.extraHeader",
        "GIT_CONFIG_VALUE_0": f"Authorization: Basic {cred}",
        "GIT_CONFIG_KEY_1": "http.proxy",
        "GIT_CONFIG_VALUE_1": "",             # 사내 직결 (MWG 우회)
        "GIT_CONFIG_KEY_2": "http.sslVerify",
        "GIT_CONFIG_VALUE_2": "false",        # 사내 self-signed
        "GIT_CONFIG_KEY_3": "credential.helper",
        "GIT_CONFIG_VALUE_3": "",             # 상속된 credential-store 무력화
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "/bin/true",           # 인증 실패시 askpass hang 방지(즉시 빈응답)
    }


def _clone_host() -> str:
    """GITHUB_BASE_URL(…/api/v3) → clone 호스트(https://github.samsungds.net)."""
    base = os.environ.get("GITHUB_BASE_URL", "").rstrip("/")
    if base.endswith("/api/v3"):
        return base[: -len("/api/v3")]
    return base


def clone_repo(full_name: str, dest: str) -> tuple[bool, str]:
    """repo 를 dest 에 clone (전체 히스토리). 토큰 env-header, URL 에 토큰 없음."""
    host = _clone_host()
    token = os.environ.get("GITHUB_TOKEN", "")
    if not host or not token:
        return False, "GITHUB_BASE_URL / GITHUB_TOKEN 미설정"
    url = f"{host}/{full_name}.git"
    env = {**os.environ, **_git_clone_env(token)}
    try:
        subprocess.run(
            ["git", "clone", "--quiet", url, dest],
            env=env, check=True, capture_output=True, timeout=_CLONE_TIMEOUT,
        )
        return True, "ok"
    except subprocess.CalledProcessError as e:
        # stderr 에 토큰 안 들어가지만(헤더는 env), 방어적으로 타입만
        return False, f"clone 실패: git exit {e.returncode}"
    except subprocess.TimeoutExpired:
        return False, f"clone timeout (>{_CLONE_TIMEOUT}s)"


def _findings_from_text(
    text: str, repo: str, path: str, source: str, commit: str | None,
) -> list[ScanFinding]:
    out: list[ScanFinding] = []
    res = scan_text(text)
    for h in res.hits:
        out.append(ScanFinding(
            repo=repo, path=path, line=h.line_no, kind=h.kind,
            severity=_severity(h.kind, path), masked=h.masked,
            source=source, commit=commit,
        ))
    for he in find_high_entropy(text):
        line = text.count("\n", 0, he.span[0]) + 1
        out.append(ScanFinding(
            repo=repo, path=path, line=line, kind="high_entropy_string",
            severity=_severity("high_entropy_string", path),
            masked=mask_secret(he.matched), source=source, commit=commit,
        ))
    return out


def _scan_worktree(repo_dir: str, repo: str) -> list[ScanFinding]:
    out: list[ScanFinding] = []
    for root, dirs, files in os.walk(repo_dir):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for fn in files:
            ext = os.path.splitext(fn)[1].lower()
            if ext in _SKIP_EXT:
                continue
            fp = os.path.join(root, fn)
            try:
                if os.path.getsize(fp) > _MAX_FILE_BYTES:
                    continue
                with open(fp, "rb") as fh:
                    raw = fh.read(_MAX_FILE_BYTES)
                if raw[:8192].count(b"\x00") > 4:  # 바이너리
                    continue
                text = raw.decode("utf-8", errors="replace")
            except OSError:
                continue
            rel = os.path.relpath(fp, repo_dir)
            out.extend(_findings_from_text(text, repo, rel, "worktree", None))
    return out


def _scan_history(repo_dir: str, repo: str) -> list[ScanFinding]:
    """git log -p --all 의 추가(+) 라인을 (commit,file) 단위로 모아 스캔.
    삭제됐다 히스토리에만 남은 시크릿 포착."""
    try:
        proc = subprocess.run(
            ["git", "-C", repo_dir, "log", "-p", "--all", "--no-color",
             "--no-merges", "--format=__COMMIT__%H"],
            capture_output=True, text=True, timeout=_LOG_TIMEOUT,
            errors="replace",
        )
    except (subprocess.TimeoutExpired, OSError):
        return []
    stdout = proc.stdout or ""
    if len(stdout) > _MAX_HISTORY_BYTES:
        stdout = stdout[:_MAX_HISTORY_BYTES]

    buckets: dict[tuple[str, str], list[str]] = {}
    cur_commit = ""
    cur_file = ""
    for ln in stdout.splitlines():
        if ln.startswith("__COMMIT__"):
            cur_commit = ln[len("__COMMIT__"):].strip()
            continue
        if ln.startswith("+++ b/"):
            cur_file = ln[6:].strip()
            continue
        if ln.startswith("+") and not ln.startswith("+++"):
            if cur_file:
                buckets.setdefault((cur_commit, cur_file), []).append(ln[1:])

    out: list[ScanFinding] = []
    for (commit, path), added in buckets.items():
        ext = os.path.splitext(path)[1].lower()
        if ext in _SKIP_EXT:
            continue
        out.extend(_findings_from_text("\n".join(added), repo, path,
                                       "history", commit[:12] or None))
    return out


def scan_repo(repo_dir: str, repo: str) -> list[ScanFinding]:
    """cloned repo_dir 스캔 — worktree(HEAD) + 히스토리. 동일 (path,kind,masked)
    는 worktree 우선, 히스토리 중복 제거."""
    worktree = _scan_worktree(repo_dir, repo)
    seen = {(f.path, f.kind, f.masked) for f in worktree}
    history: list[ScanFinding] = []
    for f in _scan_history(repo_dir, repo):
        key = (f.path, f.kind, f.masked)
        if key in seen:
            continue
        seen.add(key)
        history.append(f)
    return worktree + history
