from __future__ import annotations

from domains.smb.plugin.agent_types import smb


def test_smb_error_classification_keeps_agent_idle_timeout_out_of_communication_retry() -> None:
    assert smb.is_communication_unavailable("NT_STATUS_IO_TIMEOUT")
    assert smb.is_communication_unavailable("Connection timed out")
    assert not smb.is_communication_unavailable("aborted harness idle timeout")
    assert not smb.is_communication_unavailable("STATUS_ACCESS_DENIED")


def test_smb_error_classification_splits_auth_from_acl_denial() -> None:
    assert smb.classify_smb_error("STATUS_ACCESS_DENIED") == "permission_denied"
    assert smb.classify_smb_error("STATUS_LOGON_FAILURE") == "auth_login_failed"
    assert smb.classify_smb_error("STATUS_WRONG_PASSWORD") == "auth_login_failed"
    assert smb.classify_smb_error("STATUS_ACCOUNT_LOCKED_OUT") == "account_locked_out"
