"""v3.78 G2 / v3.78.1: github_verify — API hit HEAD 재확인.

live 판정은 (kind, masked) 값 일치 기준(같은 종류 '다른' 키를 live 로 오판 금지).
finding hit 에 masked 가 없으면 kind-only 폴백. fetch 실패는 'gone' 아닌 'unknown'.
"""
from __future__ import annotations

from secu_agent.detectors.secrets import mask_secret


def _vf(asset_kind, metadata, hits):
    from domains.services.github.plugin import github_verify
    return github_verify.verify_github_finding(asset_kind, metadata, hits)


def test_verify_live_in_head_kind_only(monkeypatch):
    """masked 없는 hit → kind-only 폴백으로 live 판정."""
    from domains.services.github.plugin.agent_types import github as gh
    monkeypatch.setattr(gh, "fetch_file_at_ref",
                        lambda repo, path, ref="HEAD": 'aws = "AKIA1234567890ABCDEF"\n')
    res = _vf("repository_file", {"repo": "o/r", "path": ".env"},
              [{"category": "secret", "kind": "aws_access_key_id"}])
    assert res["status"] == "live_in_HEAD"
    assert res["method"] == "api_head_recheck"


def test_verify_live_in_head_value_match(monkeypatch):
    """masked 일치 → live."""
    from domains.services.github.plugin.agent_types import github as gh
    val = "AKIA1234567890ABCDEF"
    monkeypatch.setattr(gh, "fetch_file_at_ref", lambda repo, path, ref="HEAD": f'aws = "{val}"\n')
    res = _vf("repository_file", {"repo": "o/r", "path": ".env"},
              [{"category": "secret", "kind": "aws_access_key_id", "masked": mask_secret(val)}])
    assert res["status"] == "live_in_HEAD"


def test_verify_same_kind_different_value_not_live(monkeypatch):
    """v3.78.1 #6: HEAD 에 같은 종류 '다른' 키 → live 아님(historical). 값까지 비교."""
    from domains.services.github.plugin.agent_types import github as gh
    orig = "AKIA1234567890ABCDEF"
    other = "AKIAZZZZZZZZZZZZZZZZ"
    monkeypatch.setattr(gh, "fetch_file_at_ref", lambda repo, path, ref="HEAD": f'aws = "{other}"\n')
    res = _vf("repository_file", {"repo": "o/r", "path": ".env"},
              [{"category": "secret", "kind": "aws_access_key_id", "masked": mask_secret(orig)}])
    assert res["status"] == "historical_only"


def test_verify_historical_only_when_secret_gone(monkeypatch):
    from domains.services.github.plugin.agent_types import github as gh
    monkeypatch.setattr(gh, "fetch_file_at_ref",
                        lambda repo, path, ref="HEAD": "clean config, no secret here\n")
    res = _vf("repository_file", {"repo": "o/r", "path": ".env"},
              [{"category": "secret", "kind": "aws_access_key_id"}])
    assert res["status"] == "historical_only"


def test_verify_gone_when_file_404(monkeypatch):
    from domains.services.github.plugin.agent_types import github as gh
    monkeypatch.setattr(gh, "fetch_file_at_ref", lambda repo, path, ref="HEAD": None)
    res = _vf("repository_file", {"repo": "o/r", "path": ".env"},
              [{"category": "secret", "kind": "aws_access_key_id"}])
    assert res["status"] == "gone"


def test_verify_unknown_on_fetch_error(monkeypatch):
    """v3.78.1 #6: fetch 예외(rate-limit/transient)는 'gone' 아닌 'unknown' (live 를 resolved 로 오표시 금지)."""
    from domains.services.github.plugin.agent_types import github as gh

    def boom(repo, path, ref="HEAD"):
        raise RuntimeError("rate limited")

    monkeypatch.setattr(gh, "fetch_file_at_ref", boom)
    res = _vf("repository_file", {"repo": "o/r", "path": ".env"},
              [{"category": "secret", "kind": "aws_access_key_id"}])
    assert res["status"] == "unknown"


def test_verify_skips_non_secret_hits():
    res = _vf("repository_file", {"repo": "o/r", "path": "AUTHORS"},
              [{"category": "pii", "kind": "email"}])
    assert res is None  # secret 없으면 재확인 불필요


def test_verify_commit_patch_multi_file_live(monkeypatch):
    from domains.services.github.plugin.agent_types import github as gh
    files = {"a.env": 'password = "Tr0ub4dor3xKpzQ"\n', "b.txt": "clean\n"}
    monkeypatch.setattr(gh, "fetch_file_at_ref", lambda repo, path, ref="HEAD": files.get(path))
    res = _vf("commit_patch", {"repo": "o/r", "files": ["a.env", "b.txt"]},
              [{"category": "secret", "kind": "generic_password_assignment"}])
    assert res["status"] == "live_in_HEAD"
    assert len(res["files"]) == 2
