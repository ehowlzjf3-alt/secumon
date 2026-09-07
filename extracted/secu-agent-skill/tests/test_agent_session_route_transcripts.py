"""Route adapter checks for transcript-backed SMB agent sessions."""
from __future__ import annotations

from typing import Any

from domains.smb.webapp.routes import agents


def test_apply_transcript_replaces_synthetic_messages(monkeypatch) -> None:
    def fake_transcript(component: str, session_ref: str) -> dict[str, Any]:
        assert component == "task"
        assert session_ref == "share-7"
        return {
            "source": "worker-transcript",
            "transcript": {"run_id": "run-share-7", "entry_count": 1},
            "messages": [{"role": "assistant", "content": {"text": "real worker log"}}],
        }

    monkeypatch.setattr(agents.agent_transcripts, "transcript_session", fake_transcript)
    session = {
        "id": "share-7",
        "title": "10.0.0.5/Finance",
        "source": "share-worker",
        "messages": [{"role": "assistant", "content": {"text": "synthetic"}}],
    }

    out = agents._apply_transcript(session, "task", "share-7")

    assert out["id"] == "share-7"
    assert out["title"] == "10.0.0.5/Finance"
    assert out["source"] == "worker-transcript"
    assert out["transcript"]["run_id"] == "run-share-7"
    assert out["messages"][0]["content"]["text"] == "real worker log"


def test_apply_transcript_keeps_synthetic_session_on_lookup_error(monkeypatch) -> None:
    def broken_transcript(component: str, session_ref: str) -> None:
        raise RuntimeError("evidence root temporarily unavailable")

    monkeypatch.setattr(agents.agent_transcripts, "transcript_session", broken_transcript)
    session = {
        "id": "thread-12",
        "source": "pipeline-adapter",
        "messages": [{"role": "assistant", "content": {"text": "fallback"}}],
    }

    out = agents._apply_transcript(session, "mail", "thread-12")

    assert out is session
    assert out["source"] == "pipeline-adapter"
    assert out["messages"][0]["content"]["text"] == "fallback"
