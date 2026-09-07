from __future__ import annotations


def test_make_evidence_dir_routes_github_labels_to_github_root(
    tmp_path,
    monkeypatch,
) -> None:
    from service.agents import runtime

    github_root = tmp_path / "github"
    smb_root = tmp_path / "smb"
    confluence_root = tmp_path / "confluence"
    monkeypatch.setenv("SA_GITHUB_EVIDENCE_DIR", str(github_root))
    monkeypatch.setenv("SA_SMB_EVIDENCE_DIR", str(smb_root))
    monkeypatch.setenv("SA_CONFLUENCE_EVIDENCE_DIR", str(confluence_root))
    monkeypatch.delenv("SA_E2E_EVIDENCE_DIR", raising=False)

    path = runtime.make_evidence_dir("github-scan-org/repo/../../escape")

    assert path.parent == github_root
    assert path.exists()
    assert path.is_dir()
    assert not path.is_relative_to(smb_root)
    assert "/" not in path.name
    assert "github-scan-org_repo" in path.name


def test_make_evidence_dir_keeps_smb_and_confluence_roots_separate(
    tmp_path,
    monkeypatch,
) -> None:
    from service.agents import runtime

    smb_root = tmp_path / "smb"
    confluence_root = tmp_path / "confluence"
    monkeypatch.setenv("SA_SMB_EVIDENCE_DIR", str(smb_root))
    monkeypatch.setenv("SA_CONFLUENCE_EVIDENCE_DIR", str(confluence_root))
    monkeypatch.delenv("SA_GITHUB_EVIDENCE_DIR", raising=False)
    monkeypatch.delenv("SA_E2E_EVIDENCE_DIR", raising=False)

    smb_path = runtime.make_evidence_dir("smb-task-10.0.0.1")
    confluence_path = runtime.make_evidence_dir("confluence-recheck-OPS")

    assert smb_path.parent == smb_root
    assert confluence_path.parent == confluence_root


def test_confluence_worker_runtime_uses_shared_evidence_fallback(
    tmp_path,
    monkeypatch,
) -> None:
    from domains.services.confluence.infrastructure.runtime import (
        ConfluenceWorkerRuntime,
    )

    shared_root = tmp_path / "shared"
    smb_root = tmp_path / "smb"
    monkeypatch.delenv("SA_CONFLUENCE_EVIDENCE_DIR", raising=False)
    monkeypatch.delenv("SA_GITHUB_EVIDENCE_DIR", raising=False)
    monkeypatch.setenv("SA_E2E_EVIDENCE_DIR", str(shared_root))
    monkeypatch.setenv("SA_SMB_EVIDENCE_DIR", str(smb_root))

    path = ConfluenceWorkerRuntime().make_evidence_dir(
        "confluence-space-OPS/../../escape",
    )

    assert path.parent == shared_root
    assert path.exists()
    assert not path.is_relative_to(smb_root)
    assert "/" not in path.name
    assert "confluence-space-OPS" in path.name
