"""Audit log — append-only jsonl + SHA256 chain (위조 방지)."""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any


class AuditLog:
    """모든 LLM/tool 호출을 SHA256 chain으로 묶어 append-only 기록.

    각 entry는 prev_hash + payload를 SHA256해서 hash 필드에 박음.
    중간 entry 위조하려면 그 이후 모든 entry의 hash를 다시 계산해야 함.
    """

    def __init__(self, path: Path):
        self.path = path
        self._prev_hash = "0" * 64
        if path.exists():
            self._prev_hash = self._restore_prev_hash()
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()

    def _restore_prev_hash(self) -> str:
        """기존 audit.log의 마지막 entry의 hash로 chain 이어가기."""
        with self.path.open("rb") as f:
            try:
                f.seek(-2, 2)
                while f.read(1) != b"\n":
                    f.seek(-2, 1)
            except OSError:
                f.seek(0)
            last_line = f.readline().decode("utf-8")
        if not last_line.strip():
            return "0" * 64
        return json.loads(last_line)["hash"]

    def append(self, event_type: str, payload: dict[str, Any]) -> None:
        # F3: audit.log 는 영속 산출물 — raw tool input/output preview 가 평문 PII/secret
        # 을 남기지 않게 payload 를 **hash 계산 前** 재귀 마스킹한다(체인은 마스킹된
        # payload 기준 → 무결성/tamper-evidence 유지, 원문만 사라짐). 마스킹 실패는
        # fail-closed placeholder(원문 통과 금지). audit 기록 실패가 헌트를 막지 않도록,
        # 마스킹 자체 예외는 원문 대신 최소 안전 payload 로 대체.
        try:
            from secu_agent.detectors.text_scan import mask_deep
            payload = mask_deep(payload)
        except Exception:  # noqa: BLE001
            payload = {"_audit_mask_error": True}
        entry = {
            "ts": time.time(),
            "prev_hash": self._prev_hash,
            "type": event_type,
            "payload": payload,
        }
        # hash = SHA256(prev_hash || canonical_json(payload))
        canonical = json.dumps(
            {"prev_hash": entry["prev_hash"], "type": event_type, "payload": payload},
            sort_keys=True,
            ensure_ascii=False,
        )
        entry_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        entry["hash"] = entry_hash
        self._prev_hash = entry_hash

        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
