"""Worker transcript discovery for the SMB agent dashboard."""
from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal


WORKER_TRANSCRIPT_NAME = "worker_transcript.jsonl"
SUBAGENT_LEDGER_NAME = "subagent_runs.jsonl"

SessionComponent = Literal["task", "mail", "reverify"]

_MAX_RUNS = 500
_MAX_TRANSCRIPT_ENTRIES = 240
_MAX_MESSAGE_TEXT = 4000


@dataclass(frozen=True, slots=True)
class TranscriptCandidate:
    run: dict[str, Any]
    evidence_dir: Path
    transcript_path: Path
    spec: dict[str, Any]


def evidence_root() -> Path:
    root = Path(os.environ.get("SA_SMB_EVIDENCE_DIR", "")
                or (Path(tempfile.gettempdir()) / "smb_e2e_evidence"))
    return root.resolve()


def transcript_session(
    component: SessionComponent,
    session_ref: str,
    *,
    root: Path | None = None,
) -> dict[str, Any] | None:
    base = (root or evidence_root()).resolve()
    candidate = find_transcript_candidate(component, session_ref, root=base)
    if candidate is None:
        return None
    entries = _load_transcript(candidate.transcript_path)
    if not entries:
        return None
    messages = [_entry_to_message(entry) for entry in entries]
    return {
        "source": "worker-transcript",
        "transcript": {
            "run_id": candidate.run.get("run_id"),
            "label": candidate.run.get("label") or candidate.spec.get("task_id"),
            "status": candidate.run.get("status"),
            "subagent_type": candidate.run.get("subagent_type") or candidate.spec.get("task_type"),
            "target_label": candidate.run.get("target_label"),
            "evidence_dir": _path_ref(base, candidate.evidence_dir),
            "transcript_path": _path_ref(base, candidate.transcript_path),
            "entry_count": len(entries),
        },
        "messages": messages,
    }


def find_transcript_candidate(
    component: SessionComponent,
    session_ref: str,
    *,
    root: Path | None = None,
) -> TranscriptCandidate | None:
    base = (root or evidence_root()).resolve()
    candidates = list(_ledger_candidates(base))
    candidates.extend(_spec_only_candidates(base))
    matching = [
        candidate for candidate in candidates
        if _matches_session(component, session_ref, candidate)
    ]
    matching.sort(key=_candidate_sort_key, reverse=True)
    return matching[0] if matching else None


def _ledger_candidates(root: Path) -> list[TranscriptCandidate]:
    records = _coalesced_ledger(root / SUBAGENT_LEDGER_NAME)
    out: list[TranscriptCandidate] = []
    for record in records[:_MAX_RUNS]:
        evidence_dir = _resolve_in_root(root, record.get("evidence_dir"))
        if evidence_dir is None:
            continue
        transcript = _resolve_in_root(
            root,
            record.get("transcript_path") or str(evidence_dir / WORKER_TRANSCRIPT_NAME),
        )
        if transcript is None or not transcript.is_file():
            continue
        spec = _load_json(evidence_dir / "task_spec.json")
        out.append(TranscriptCandidate(
            run=record,
            evidence_dir=evidence_dir,
            transcript_path=transcript,
            spec=spec,
        ))
    return out


def _spec_only_candidates(root: Path) -> list[TranscriptCandidate]:
    out: list[TranscriptCandidate] = []
    if not root.is_dir():
        return out
    for transcript in root.glob(f"*/{WORKER_TRANSCRIPT_NAME}"):
        evidence_dir = transcript.parent.resolve()
        if _safe_relative(root, evidence_dir) is None:
            continue
        spec = _load_json(evidence_dir / "task_spec.json")
        run = {
            "label": spec.get("task_id") or evidence_dir.name,
            "subagent_type": spec.get("task_type") or spec.get("skill"),
            "status": _worker_result_status(evidence_dir),
        }
        out.append(TranscriptCandidate(
            run=run,
            evidence_dir=evidence_dir,
            transcript_path=transcript.resolve(),
            spec=spec,
        ))
    return out


def _coalesced_ledger(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (FileNotFoundError, OSError):
        return []
    records: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            continue
        if not isinstance(payload, dict):
            continue
        run_id = str(payload.get("run_id") or "")
        if not run_id:
            continue
        if run_id not in records:
            order.append(run_id)
            records[run_id] = {}
        records[run_id].update(payload)
    out = [records[run_id] for run_id in order if run_id in records]
    out.sort(key=lambda r: str(r.get("started_at") or ""), reverse=True)
    return out


def _matches_session(
    component: SessionComponent,
    session_ref: str,
    candidate: TranscriptCandidate,
) -> bool:
    target = candidate.spec.get("target")
    target = target if isinstance(target, dict) else {}
    run_text = _candidate_text(candidate).lower()
    if component == "task" and session_ref.startswith("share-"):
        share_id = session_ref.removeprefix("share-")
        share_ids = _string_set(target.get("share_ids"))
        share_ids.add(str(target.get("share_id") or ""))
        if share_id in share_ids:
            return True
        return f"-{share_id}" in run_text or f"share-{share_id}" in run_text
    if component == "task" and session_ref.startswith("host-"):
        host = session_ref.removeprefix("host-").lower()
        return bool(host and (
            host == str(target.get("host") or "").lower()
            or host in run_text
        ))
    if component in {"mail", "reverify"} and session_ref.startswith("thread-"):
        thread_id = session_ref.removeprefix("thread-")
        if str(target.get("thread_id") or "") == thread_id:
            return True
        return f"-{thread_id}-" in run_text or f"thread-{thread_id}" in run_text
    return False


def _candidate_text(candidate: TranscriptCandidate) -> str:
    parts = [
        candidate.run.get("run_id"),
        candidate.run.get("label"),
        candidate.run.get("target_id"),
        candidate.run.get("target_label"),
        candidate.run.get("evidence_dir"),
        candidate.spec.get("task_id"),
        candidate.spec.get("task_type"),
        str(candidate.spec.get("target") or ""),
        candidate.evidence_dir.name,
    ]
    return " ".join(str(part) for part in parts if part)


def _candidate_sort_key(candidate: TranscriptCandidate) -> tuple[str, float]:
    run_time = str(candidate.run.get("completed_at") or candidate.run.get("started_at") or "")
    try:
        mtime = candidate.transcript_path.stat().st_mtime
    except OSError:
        mtime = 0.0
    return run_time, mtime


def _load_transcript(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (FileNotFoundError, OSError):
        return []
    out: list[dict[str, Any]] = []
    for line in lines[-_MAX_TRANSCRIPT_ENTRIES:]:
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            continue
        if isinstance(payload, dict):
            out.append(payload)
    return out


def _entry_to_message(entry: dict[str, Any]) -> dict[str, Any]:
    role = str(entry.get("role") or "system")
    if role not in {"system", "user", "assistant", "tool"}:
        role = "system"
    text = _entry_text(entry)
    created_at = entry.get("timestamp")
    return {
        "role": role,
        "content": {"text": text[:_MAX_MESSAGE_TEXT]},
        "created_at": created_at,
        "event": entry.get("event"),
    }


def _entry_text(entry: dict[str, Any]) -> str:
    text = entry.get("text")
    if isinstance(text, str) and text.strip():
        return text
    parts = [str(entry.get("event") or "event")]
    name = entry.get("name")
    if name:
        parts.append(str(name))
    outcome = entry.get("outcome")
    if outcome:
        parts.append(str(outcome))
    payload = entry.get("payload")
    if payload not in (None, ""):
        try:
            parts.append(json.dumps(payload, ensure_ascii=False, sort_keys=True))
        except (TypeError, ValueError):
            parts.append(str(payload))
    return " · ".join(parts)


def _load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _worker_result_status(evidence_dir: Path) -> str | None:
    payload = _load_json(evidence_dir / "worker_result.json")
    status = payload.get("status")
    return str(status) if status else None


def _resolve_in_root(root: Path, value: object) -> Path | None:
    if not value:
        return None
    raw = Path(str(value))
    candidate = raw if raw.is_absolute() else root / raw
    try:
        resolved = candidate.resolve()
    except OSError:
        return None
    return resolved if _safe_relative(root, resolved) is not None else None


def _safe_relative(root: Path, path: Path) -> Path | None:
    try:
        return path.resolve().relative_to(root.resolve())
    except (OSError, ValueError):
        return None


def _path_ref(root: Path, path: Path) -> str:
    rel = _safe_relative(root, path)
    return str(rel if rel is not None else path)


def _string_set(value: object) -> set[str]:
    if isinstance(value, list | tuple | set):
        return {str(v) for v in value if str(v)}
    if value is None:
        return set()
    return {str(value)}
