from __future__ import annotations


def test_agent_verification_marker_requires_verified_status() -> None:
    from service.services.finding_verification import (
        is_agent_verified_extra,
        make_agent_verification,
    )

    marker = make_agent_verification(
        method="github_e2e_api_detail_scan",
        source="github_e2e_scan",
        checks=("candidate_detail_collected",),
    )

    assert is_agent_verified_extra({"agent_verification": marker}) is True
    assert is_agent_verified_extra({"verification": {"status": "live_in_HEAD"}}) is False
    assert is_agent_verified_extra({"agent_verification": {"status": "pending"}}) is False
