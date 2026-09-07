from __future__ import annotations

import asyncio
import time
from pathlib import Path


class _Store:
    def __init__(self) -> None:
        self.thread = {
            "id": 77,
            "host": "10.0.0.5",
            "finding_id": 100,
            "status": "reported",
        }
        self.status_updates: list[tuple[int, str, dict]] = []

    def claim_mail_thread(self, *, session_id: int, status: str):
        if self.thread is None:
            return None
        thread = dict(self.thread)
        self.thread = None
        return thread

    def set_mail_thread_status(self, thread_id: int, status: str, **fields) -> None:
        self.status_updates.append((thread_id, status, fields))


class _Runtime:
    def __init__(self, root: Path) -> None:
        self.root = root

    def make_evidence_dir(self, label: str) -> Path:
        out = self.root / label
        out.mkdir(parents=True, exist_ok=True)
        return out

    def worker_env(self) -> dict[str, str]:
        return {"PYTHONPATH": "test"}


def test_report_mail_adapter_sets_worker_timeout(tmp_path, monkeypatch) -> None:
    from domains.smb.application import fanout

    monkeypatch.setenv("SMB_REPORT_MAIL_WORKER_TIMEOUT_SEC", "123")
    services = fanout.FanoutServices(store=_Store(), runtime=_Runtime(tmp_path))
    adapter = fanout._make_report_mail_adapter(services)

    async def _go():
        target = await adapter.claim_next()
        spec = await adapter.build_spec(target)
        return spec

    spec = asyncio.run(_go())

    assert spec.timeout_sec == 123
    assert spec.argv[1:3] == ("-m", "service.agents.report_mail_worker")


def test_report_mail_adapter_failure_backoff_prevents_same_pass_reclaim(
    tmp_path,
    monkeypatch,
) -> None:
    from domains.smb.application import fanout
    from secu_agent.agent.fanout import FanoutTarget

    store = _Store()
    monkeypatch.setenv("SMB_REPORT_MAIL_FAILURE_RETRY_SECONDS", "42")
    services = fanout.FanoutServices(store=store, runtime=_Runtime(tmp_path))
    adapter = fanout._make_report_mail_adapter(services)
    before = time.time()

    asyncio.run(
        adapter.release(
            FanoutTarget(label="smb_report_mail-77-10.0.0.5", payload={"id": 77}),
            None,
            success=False,
        ),
    )

    assert store.status_updates
    thread_id, status, fields = store.status_updates[-1]
    assert thread_id == 77
    assert status == "reported"
    assert fields["last_error_kind"] == "worker_failed"
    assert fields["retry_after"] >= before + 41
