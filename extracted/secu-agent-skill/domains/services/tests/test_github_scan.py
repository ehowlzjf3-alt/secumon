"""v3.70 S3: github_scan — clone 후 worktree+히스토리 시크릿 스캔 TDD.

스캔 로직은 로컬 git fixture(네트워크/토큰 불필요)로 e2e. 토큰 env-주입은 단위검증."""
from __future__ import annotations

import subprocess

import pytest

from domains.services.github.plugin.agent_types import github_scan as gs


# ---------------------------------------------------------------------------
# 토큰 git clone env 주입 (우리 토큰 보호 — ps/args 미노출)
# ---------------------------------------------------------------------------

def test_git_clone_env_hides_token_in_header_not_args():
    import base64
    env = gs._git_clone_env("ghp_SECRETTOKEN123")
    vals = [v for k, v in env.items() if "VALUE" in k]
    # 토큰 평문은 어디에도 없음 (Basic 으로 인코딩됨 — 더 안전)
    assert not any("ghp_SECRETTOKEN123" in x for x in (*env.keys(), *env.values()))
    # Authorization: Basic <b64> 헤더에 토큰이 인코딩돼 실림
    auth = [v for v in vals if v.lower().startswith("authorization: basic ")]
    assert auth, "Basic Authorization 헤더 필요"
    decoded = base64.b64decode(auth[0].split()[-1]).decode()
    assert "ghp_SECRETTOKEN123" in decoded
    # git config 이름 http.extraHeader 는 VALUE 로
    assert any("extraheader" in v.lower() for v in env.values())
    assert int(env["GIT_CONFIG_COUNT"]) >= 1


def test_git_clone_env_blocks_askpass_hang():
    env = gs._git_clone_env("tok")
    assert env.get("GIT_TERMINAL_PROMPT") == "0"
    assert env.get("GIT_ASKPASS")  # 인증 실패시 hang 방지 no-op


def test_git_clone_env_bypasses_proxy_and_ssl():
    env = gs._git_clone_env("tok")
    blob = " ".join(list(env.keys()) + list(env.values())).lower()
    assert "http.proxy" in blob          # proxy 우회 (빈값)
    assert "sslverify" in blob            # self-signed 허용


# ---------------------------------------------------------------------------
# severity + hot-path 가중
# ---------------------------------------------------------------------------

def test_severity_private_key_critical():
    assert gs._severity("private_key_block", "src/key.txt") == "critical"


def test_severity_hotfile_bumps():
    # generic(high) 가 .env(hot) 에서 critical 로 가중
    assert gs._severity("generic_password_assignment", "config/.env") == "critical"
    # 일반 경로면 high 유지
    assert gs._severity("generic_password_assignment", "src/app.py") == "high"


# ---------------------------------------------------------------------------
# scan_repo — 로컬 git fixture (worktree HEAD + 삭제된 히스토리)
# ---------------------------------------------------------------------------

def _git(cwd, *args):
    env = {
        "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
        "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null",
        "HOME": str(cwd), "PATH": "/usr/bin:/bin",
    }
    subprocess.run(["git", *args], cwd=cwd, env=env, check=True,
                   capture_output=True)


@pytest.fixture
def fixture_repo(tmp_path):
    repo = tmp_path / "r"
    repo.mkdir()
    _git(repo, "init", "-q")
    # 커밋1: HEAD 에 살아있는 AWS 키
    (repo / "config.py").write_text('AWS_KEY = "AKIA1234567890ABCDEF"\n')
    _git(repo, "add", "-A"); _git(repo, "commit", "-q", "-m", "c1")
    # 커밋2: .env 에 시크릿 추가
    (repo / ".env").write_text('DB_PASSWORD="Sup3rS3cretValue99"\n')
    _git(repo, "add", "-A"); _git(repo, "commit", "-q", "-m", "c2")
    # 커밋3: .env 삭제 (히스토리엔 남음)
    (repo / ".env").unlink()
    _git(repo, "add", "-A"); _git(repo, "commit", "-q", "-m", "c3")
    return repo


def test_scan_repo_finds_head_secret(fixture_repo):
    findings = gs.scan_repo(str(fixture_repo), "owner/r")
    head = [f for f in findings if f.path == "config.py"]
    assert head and head[0].kind == "aws_access_key_id"
    assert head[0].source == "worktree"
    # 평문 미노출
    assert "AKIA1234567890ABCDEF" not in head[0].masked


def test_scan_repo_finds_deleted_secret_in_history(fixture_repo):
    findings = gs.scan_repo(str(fixture_repo), "owner/r")
    hist = [f for f in findings if f.path == ".env"]
    # .env 는 HEAD 에 없지만 히스토리에 남음 → 잡혀야 함
    assert hist, "삭제된 .env 시크릿이 히스토리 스캔에서 잡혀야 함"
    assert any(f.source == "history" for f in hist)
    assert all("Sup3rS3cretValue99" not in f.masked for f in hist)


def test_scan_repo_history_secret_has_commit(fixture_repo):
    findings = gs.scan_repo(str(fixture_repo), "owner/r")
    hist = [f for f in findings if f.source == "history"]
    assert hist and all(f.commit for f in hist)  # 커밋 sha 부착


def test_scan_repo_never_returns_plaintext(fixture_repo):
    findings = gs.scan_repo(str(fixture_repo), "owner/r")
    blob = " ".join(f.masked for f in findings)
    assert "AKIA1234567890ABCDEF" not in blob
    assert "Sup3rS3cretValue99" not in blob
    assert findings  # 뭔가는 잡혀야


def test_scan_worktree_skips_binary_and_large(tmp_path):
    d = tmp_path / "w"; d.mkdir()
    (d / "a.png").write_bytes(b"\x89PNG\x00\x00secretAKIA1234567890ABCDEF")
    (d / "ok.txt").write_text('k="AKIA1234567890ABCDEF"\n')
    findings = gs._scan_worktree(str(d), "o/r")
    paths = {f.path for f in findings}
    assert "ok.txt" in paths
    assert "a.png" not in paths  # 바이너리 확장자 스킵
