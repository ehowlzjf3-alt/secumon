"""Tests for SMB worker transcript discovery."""
from __future__ import annotations

import json
from pathlib import Path

from service.services import agent_transcripts


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
        encoding="utf-8",
    )


def test_transcript_session_uses_ledger_for_share_worker(tmp_path: Path) -> None:
    evidence_dir = tmp_path / "smb-task-10.0.0.5-7"
    evidence_dir.mkdir()
    _write_json(evidence_dir / "task_spec.json", {
        "task_id": "task-7",
        "task_type": "smb_share_review",
        "target": {
            "host": "10.0.0.5",
            "share_id": 7,
            "share": "Finance",
        },
    })
    _write_jsonl(evidence_dir / "worker_transcript.jsonl", [
        {"role": "user", "text": "review share 7", "timestamp": "2026-06-15T01:00:00Z"},
        {"role": "assistant", "text": "finding summary", "timestamp": "2026-06-15T01:00:05Z"},
    ])
    _write_jsonl(tmp_path / "subagent_runs.jsonl", [
        {
            "event": "worker_started",
            "run_id": "run-share-7",
            "label": "smb-task-10.0.0.5-7",
            "evidence_dir": evidence_dir.name,
            "started_at": "2026-06-15T01:00:00Z",
        },
        {
            "event": "worker_completed",
            "run_id": "run-share-7",
            "status": "completed",
            "completed_at": "2026-06-15T01:01:00Z",
            "transcript_path": f"{evidence_dir.name}/worker_transcript.jsonl",
        },
    ])

    session = agent_transcripts.transcript_session("task", "share-7", root=tmp_path)

    assert session is not None
    assert session["source"] == "worker-transcript"
    assert session["transcript"]["run_id"] == "run-share-7"
    assert session["transcript"]["status"] == "completed"
    assert session["transcript"]["entry_count"] == 2
    assert session["transcript"]["evidence_dir"] == evidence_dir.name
    assert session["messages"][1]["content"]["text"] == "finding summary"


def test_transcript_session_falls_back_to_spec_only_thread(tmp_path: Path) -> None:
    evidence_dir = tmp_path / "smb_report_mail-12-10.0.0.5"
    evidence_dir.mkdir()
    _write_json(evidence_dir / "task_spec.json", {
        "task_id": "mail-12",
        "task_type": "smb_report_mail",
        "target": {
            "thread_id": 12,
            "host": "10.0.0.5",
        },
    })
    _write_jsonl(evidence_dir / "worker_transcript.jsonl", [
        {"event": "tool_result", "name": "draft_mail", "payload": {"ok": True}},
    ])
    _write_json(evidence_dir / "worker_result.json", {"status": "done"})

    session = agent_transcripts.transcript_session("mail", "thread-12", root=tmp_path)

    assert session is not None
    assert session["transcript"]["label"] == "mail-12"
    assert session["transcript"]["status"] == "done"
    assert session["messages"][0]["role"] == "system"
    assert "draft_mail" in session["messages"][0]["content"]["text"]


def test_transcript_session_rejects_paths_outside_evidence_root(tmp_path: Path) -> None:
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    try:
        _write_json(outside / "task_spec.json", {
            "task_type": "smb_share_review",
            "target": {"share_id": 7},
        })
        _write_jsonl(outside / "worker_transcript.jsonl", [
            {"role": "assistant", "text": "outside root"},
        ])
        _write_jsonl(tmp_path / "subagent_runs.jsonl", [
            {
                "run_id": "run-escape",
                "label": "smb-task-escape-7",
                "evidence_dir": str(outside),
                "transcript_path": str(outside / "worker_transcript.jsonl"),
            },
        ])

        session = agent_transcripts.transcript_session("task", "share-7", root=tmp_path)

        assert session is None
    finally:
        for child in outside.iterdir():
            child.unlink()
        outside.rmdir()
