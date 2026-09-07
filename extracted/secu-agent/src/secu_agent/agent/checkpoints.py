"""File checkpoint and rollback support for risky host edits."""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class CheckpointRecord:
    id: str
    label: str
    created_at: float
    paths: list[str]


@dataclass(frozen=True, slots=True)
class RollbackResult:
    checkpoint_id: str
    restored: int = 0
    deleted: int = 0
    skipped: int = 0


class CheckpointManager:
    """Stores file snapshots under `<evidence_dir>/.checkpoints`.

    A checkpoint records the previous state of each file. Existing files are
    restored from bytes. Files that did not exist at checkpoint time are deleted
    on rollback if a file was later created.
    """

    def __init__(self, evidence_dir: Path) -> None:
        self.root = evidence_dir / ".checkpoints"

    def create(self, paths: list[Path], *, label: str = "") -> CheckpointRecord:
        checkpoint_id = f"cp-{time.time_ns()}-{uuid.uuid4().hex[:8]}"
        checkpoint_dir = self.root / checkpoint_id
        files_dir = checkpoint_dir / "files"
        files_dir.mkdir(parents=True, exist_ok=False)

        entries: list[dict[str, Any]] = []
        for idx, raw_path in enumerate(paths):
            path = raw_path.expanduser().resolve()
            existed = path.exists()
            entry: dict[str, Any] = {
                "path": str(path),
                "existed": existed,
                "snapshot": None,
            }
            if existed:
                if not path.is_file():
                    raise ValueError(f"checkpoint only supports files: {path}")
                snapshot = files_dir / f"{idx}.bin"
                snapshot.write_bytes(path.read_bytes())
                entry["snapshot"] = str(snapshot.relative_to(checkpoint_dir))
            entries.append(entry)

        created_at = time.time()
        manifest = {
            "id": checkpoint_id,
            "label": label,
            "created_at": created_at,
            "files": entries,
        }
        (checkpoint_dir / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=True, indent=2),
            encoding="utf-8",
        )
        return CheckpointRecord(
            id=checkpoint_id,
            label=label,
            created_at=created_at,
            paths=[entry["path"] for entry in entries],
        )

    def list(self) -> list[CheckpointRecord]:
        if not self.root.exists():
            return []
        records: list[CheckpointRecord] = []
        for manifest_path in sorted(self.root.glob("cp-*/manifest.json")):
            manifest = self._load_manifest(manifest_path.parent.name)
            records.append(self._record_from_manifest(manifest))
        return records

    def rollback(self, checkpoint_id: str) -> RollbackResult:
        manifest = self._load_manifest(checkpoint_id)
        restored = 0
        deleted = 0
        skipped = 0
        checkpoint_dir = self.root / checkpoint_id

        for entry in manifest.get("files", []):
            path = Path(str(entry["path"]))
            existed = bool(entry["existed"])
            if existed:
                snapshot = entry.get("snapshot")
                if not snapshot:
                    skipped += 1
                    continue
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((checkpoint_dir / snapshot).read_bytes())
                restored += 1
            elif path.exists():
                if path.is_file() or path.is_symlink():
                    path.unlink()
                    deleted += 1
                else:
                    skipped += 1

        return RollbackResult(
            checkpoint_id=checkpoint_id,
            restored=restored,
            deleted=deleted,
            skipped=skipped,
        )

    def _load_manifest(self, checkpoint_id: str) -> dict[str, Any]:
        manifest_path = self.root / checkpoint_id / "manifest.json"
        return json.loads(manifest_path.read_text(encoding="utf-8"))

    @staticmethod
    def _record_from_manifest(manifest: dict[str, Any]) -> CheckpointRecord:
        files = manifest.get("files", [])
        return CheckpointRecord(
            id=str(manifest["id"]),
            label=str(manifest.get("label") or ""),
            created_at=float(manifest["created_at"]),
            paths=[str(entry["path"]) for entry in files],
        )
