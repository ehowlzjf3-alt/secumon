from __future__ import annotations

from pathlib import Path


def test_enterprise_security_principles_doc_exists_and_sets_boundaries():
    body = Path("docs/enterprise_security_agent_principles.md").read_text(
        encoding="utf-8",
    )

    assert "enterprise security autonomous agent" in body
    assert "Domain knowledge belongs outside the core" in body
    assert "Claude Code" in body
    assert "Hermes Agent" in body
    assert "Never use hidden watermarks" in body
    assert "schedule intent contracts" in body
